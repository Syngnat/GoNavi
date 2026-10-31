package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/syncjob"
	"GoNavi-Wails/internal/taskrollback"
	"GoNavi-Wails/internal/uievents"
)

const taskRollbackEmptySnapshot = "-- GoNavi task rollback snapshot\n-- no existing objects\n"

var (
	taskRollbackStores sync.Map
	// writeTaskRollbackSnapshotFile is replaced by tests that need a failed dump
	// without standing up a real database.
	writeTaskRollbackSnapshotFile = func(a *App, ctx context.Context, config connection.ConnectionConfig, database string, names []string, dest string) error {
		return a.writeTaskRollbackSnapshotFile(ctx, config, database, names, dest)
	}
)

type taskRollbackCapture struct {
	Kind          taskrollback.Kind
	TaskID        string
	Config        connection.ConnectionConfig
	Database      string
	Schema        string
	Tables        []string
	WholeDatabase bool
	AllowCreate   bool
	Skip          bool
	DB            db.Database
}

func (a *App) taskRollbackStore() (*taskrollback.Store, error) {
	root, err := a.taskRollbackRoot()
	if err != nil {
		return nil, err
	}
	if existing, ok := taskRollbackStores.Load(root); ok {
		if store, ok := existing.(*taskrollback.Store); ok {
			return store, nil
		}
	}
	store, err := taskrollback.Open(root)
	if err != nil {
		return nil, err
	}
	actual, _ := taskRollbackStores.LoadOrStore(root, store)
	opened, ok := actual.(*taskrollback.Store)
	if !ok {
		return nil, errors.New("task rollback store is unavailable")
	}
	return opened, nil
}

func (a *App) taskRollbackRoot() (string, error) {
	if a == nil {
		return "", errors.New("application is unavailable")
	}
	dir := strings.TrimSpace(a.configDir)
	if dir == "" {
		dir = resolveAppConfigDir()
	}
	if strings.TrimSpace(dir) == "" {
		return "", errors.New("config dir is unavailable")
	}
	return filepath.Join(dir, "task-rollback"), nil
}

func (a *App) captureTaskRollback(ctx context.Context, req taskRollbackCapture) error {
	req.Database = strings.TrimSpace(req.Database)
	req.TaskID = strings.TrimSpace(req.TaskID)
	if !shouldCreateTaskRollback(req.AllowCreate, req.Skip, req.TaskID, req.Database) {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	store, err := a.taskRollbackStore()
	if err != nil {
		return a.taskRollbackSnapshotError(err)
	}
	if req.DB == nil {
		req.DB, err = a.getDatabaseWithContext(ctx, normalizeRunConfig(req.Config, req.Database), false)
		if err != nil {
			return a.taskRollbackSnapshotError(err)
		}
	}
	catalog, err := listTaskRollbackCatalog(req.DB, req.Config, req.Database)
	if err != nil {
		return a.taskRollbackSnapshotError(err)
	}
	objects, exportNames := selectRollbackObjects(req.Config, req.Database, catalog, req.Tables, req.WholeDatabase)
	point := taskrollback.Point{
		ID:            taskrollback.NewPointID(),
		Kind:          req.Kind,
		TaskID:        req.TaskID,
		ConnectionID:  strings.TrimSpace(req.Config.ID),
		DBType:        resolveDDLDBType(req.Config),
		Database:      req.Database,
		Schema:        strings.TrimSpace(req.Schema),
		WholeDatabase: req.WholeDatabase,
		Objects:       objects,
	}
	snapshotPath, err := store.Begin(point)
	if errors.Is(err, taskrollback.ErrExists) {
		return nil
	}
	if err != nil {
		return a.taskRollbackSnapshotError(err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = store.Abort(point.ID)
		}
	}()
	if err := writeTaskRollbackSnapshotFile(a, ctx, req.Config, req.Database, exportNames, snapshotPath); err != nil {
		return a.taskRollbackSnapshotError(err)
	}
	info, err := os.Stat(snapshotPath)
	if err != nil {
		return a.taskRollbackSnapshotError(err)
	}
	if _, err := store.Commit(point.ID, info.Size()); err != nil {
		return a.taskRollbackSnapshotError(err)
	}
	committed = true
	logger.Infof("任务回滚快照已保存：task=%s kind=%s bytes=%d", point.TaskID, point.Kind, info.Size())
	return nil
}

func (a *App) captureSQLFileRollbackPoint(ctx context.Context, job *managedImportJob, config connection.ConnectionConfig, jobID string, policy sqlFileExecutionPolicy, plan sqlImportRollbackPlan) error {
	if policy.SkipRollbackSnapshot || strings.TrimSpace(policy.PinDatabase) == "" {
		return nil
	}
	if plan.AdditiveOnly && !plan.WholeDatabase {
		// 纯 CREATE 脚本只新增对象，不会修改任何已有数据；没有可回滚的数据面，
		// 直接跳过快照查询/导出，把导入延迟压到连接 + DDL 本身。
		logger.Infof("SQL 导入仅新增对象，跳过回滚快照：objects=%d", len(plan.Tables))
		return nil
	}
	a.noteRollbackSnapshotStage(job)
	return a.captureTaskRollback(ctx, taskRollbackCapture{
		Kind:          taskrollback.KindSQLImport,
		TaskID:        jobID,
		Config:        config,
		Database:      policy.PinDatabase,
		Tables:        plan.Tables,
		WholeDatabase: plan.WholeDatabase,
		AllowCreate:   true,
	})
}

func (a *App) captureTableImportRollbackPoint(ctx context.Context, job *managedImportJob, config connection.ConnectionConfig, database, table, jobID string) error {
	if strings.TrimSpace(jobID) == "" {
		return nil
	}
	a.noteRollbackSnapshotStage(job)
	return a.captureTaskRollback(ctx, taskRollbackCapture{
		Kind:        taskrollback.KindTableImport,
		TaskID:      jobID,
		Config:      config,
		Database:    database,
		Tables:      []string{table},
		AllowCreate: true,
	})
}

func (a *App) captureDataSyncRollback(ctx context.Context, request syncjob.ExecutionRequest, target resolvedDataSyncJobEndpoint, mappings []syncjob.TableMapping) error {
	if !dataSyncKindNeedsRollback(request.Definition.Kind) || !dataSyncRunShouldSnapshot(request) {
		return nil
	}
	names := dataSyncRollbackTableNames(target.Config.Type, target.Database, target.Schema, mappings)
	if len(names) == 0 {
		return nil
	}
	// 只有库名才能定位快照。只用 schema 的引擎继续执行，只是这次没有回滚点。
	if strings.TrimSpace(target.Database) == "" {
		return nil
	}
	return a.captureTaskRollback(ctx, taskRollbackCapture{
		Kind:        taskrollback.KindDataSync,
		TaskID:      request.Run.ID,
		Config:      target.Config,
		Database:    target.Database,
		Schema:      target.Schema,
		Tables:      names,
		AllowCreate: true,
	})
}

func (a *App) noteRollbackSnapshotStage(job *managedImportJob) {
	if job == nil || a == nil {
		return
	}
	stage := a.appText("task_rollback.stage.snapshotting", nil)
	_ = job.update(managedImportJobProgress{
		Stage:        stage,
		ForcePersist: true,
	})
	if a.ctx == nil {
		return
	}
	bytesRead := job.job.BytesRead
	totalBytes := job.job.SourceBytesTotal
	uievents.Emit(a.ctx, "sqlfile:progress", map[string]interface{}{
		"jobId":             job.job.ID,
		"status":            "running",
		"stage":             stage,
		"executed":          job.job.Succeeded,
		"failed":            job.job.Failed,
		"total":             job.job.Current,
		"percent":           resolveSQLFileExecutionProgressPercent("running", bytesRead, totalBytes),
		"bytesRead":         bytesRead,
		"totalBytes":        totalBytes,
		"byteProgressKind":  "rawSource",
		"decodedBytes":      nil,
		"decodedTotalBytes": nil,
		"currentSQL":        "",
		"error":             "",
	})
}

func (a *App) taskRollbackSnapshotError(err error) error {
	if err == nil {
		return nil
	}
	logger.Warnf("任务回滚快照失败：%s", err.Error())
	if a == nil {
		return err
	}
	return fmt.Errorf("%s", a.appText("task_rollback.error.snapshot_failed", map[string]any{"detail": err.Error()}))
}

func (a *App) writeTaskRollbackSnapshotFile(ctx context.Context, config connection.ConnectionConfig, database string, names []string, dest string) error {
	if len(names) == 0 {
		return os.WriteFile(dest, []byte(taskRollbackEmptySnapshot), 0o600)
	}
	result := a.exportTablesSQLToFile(ctx, config, database, names, true, true, dest, nil, ExportFileOptions{
		Format:              "sql",
		IncludeDropIfExists: true,
	}, nil)
	if !result.Success {
		if strings.TrimSpace(result.Message) == "" {
			return errors.New("rollback snapshot export failed")
		}
		return errors.New(result.Message)
	}
	return nil
}

func listTaskRollbackCatalog(dbInst db.Database, config connection.ConnectionConfig, database string) ([]taskrollback.Object, error) {
	if dbInst == nil {
		return nil, errors.New("database is unavailable")
	}
	tables, err := dbInst.GetTables(database)
	if err != nil {
		return nil, err
	}
	viewLookup, viewErr := listTaskRollbackViewLookup(dbInst, config, database)
	if viewErr != nil {
		return nil, viewErr
	}
	seen := map[string]struct{}{}
	objects := make([]taskrollback.Object, 0, len(tables)+len(viewLookup))
	for _, name := range tables {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		key := normalizeExportObjectKey(config, database, name)
		if key == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		_, isView := viewLookup[key]
		objects = append(objects, taskrollback.Object{Name: name, Existed: true, IsView: isView})
	}
	for key, name := range viewLookup {
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		objects = append(objects, taskrollback.Object{Name: name, Existed: true, IsView: true})
	}
	sort.Slice(objects, func(i, j int) bool { return objects[i].Name < objects[j].Name })
	return objects, nil
}

func taskRollbackSnapshotNeedsReplay(path string) (bool, error) {
	info, err := os.Stat(path)
	if err != nil {
		return false, err
	}
	if info.Size() == 0 {
		return false, nil
	}
	if info.Size() > int64(len(taskRollbackEmptySnapshot))+64 {
		return true, nil
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(string(payload)) != strings.TrimSpace(taskRollbackEmptySnapshot), nil
}

// listTaskRollbackViewLookup 只接受显式视图名。导出用的推断会把任意查询行当成对象，
// GTID 预检行因此会被记成一张不存在的视图，导致快照失败并取消导入。
func listTaskRollbackViewLookup(dbInst db.Database, config connection.ConnectionConfig, database string) (map[string]string, error) {
	viewLookup := map[string]string{}
	var firstErr error
	querySucceeded := false
	for _, query := range buildListViewQueries(config, database) {
		if strings.TrimSpace(query) == "" {
			continue
		}
		rows, _, err := queryDataForExport(dbInst, config, query)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		querySucceeded = true
		for _, row := range rows {
			viewName, ok := taskRollbackExplicitViewName(row)
			if !ok {
				continue
			}
			schemaName := exportRowValueCI(row, "schema_name", "table_schema", "owner", "schema", "db")
			if registryHidesSchema(config.Type, schemaName) {
				continue
			}
			fullName := strings.TrimSpace(qualifyTable(schemaName, viewName))
			if fullName == "" {
				fullName = viewName
			}
			key := normalizeExportObjectKey(config, database, fullName)
			if key == "" {
				continue
			}
			if _, exists := viewLookup[key]; !exists {
				viewLookup[key] = fullName
			}
		}
	}
	if !querySucceeded && firstErr != nil {
		return nil, firstErr
	}
	return viewLookup, nil
}

func taskRollbackExplicitViewName(row map[string]interface{}) (string, bool) {
	tableType := strings.ToUpper(exportRowValueCI(row, "table_type", "type"))
	if tableType != "" && tableType != "VIEW" {
		return "", false
	}
	if name := strings.TrimSpace(exportRowValueCI(row, "object_name", "view_name", "table_name", "name")); name != "" {
		return name, true
	}
	if tableType != "VIEW" {
		return "", false
	}
	for key, value := range row {
		normalized := strings.ToLower(strings.TrimSpace(key))
		if !strings.HasPrefix(normalized, "tables_in_") || value == nil {
			continue
		}
		text := strings.TrimSpace(fmt.Sprint(value))
		if text == "" || text == "<nil>" {
			continue
		}
		return text, true
	}
	return "", false
}
