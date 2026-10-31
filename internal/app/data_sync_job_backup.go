package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	syncbackend "GoNavi-Wails/internal/sync"
	"GoNavi-Wails/internal/syncjob"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// backupPathReserveAttempts 限制同一秒内撞名后的让位次数。调度粒度是分钟，
// 同一秒内连续撞名超过几次说明是人为并发触发，报错比继续让位更清楚。
const backupPathReserveAttempts = 5

// SelectBackupDirectory 打开本机目录选择器，返回用户选定的绝对路径。
//
// 备份目录必须由用户在本机选定：它既不能被远程 Web 会话指定（预检会拒绝
// webRuntime），也不该要求用户手敲路径。取消时按既有选择器约定返回
// Success=false + "已取消"，由调用方区分「取消」与「失败」。
func (a *App) SelectBackupDirectory(currentDir string) connection.QueryResult {
	if a.webRuntime {
		return connection.QueryResult{Success: false, Message: a.appText("data_sync.backup.desktop_only", nil)}
	}
	// 不复用 normalizeDirectoryDialogPath：它会按 filepath.Ext 剥掉扩展名，
	// 那是为「文件路径」设计的，目录名里带点（如 /data/v1.2）会被改错。
	defaultDir := strings.TrimSpace(currentDir)
	if defaultDir == "" {
		if home, err := os.UserHomeDir(); err == nil {
			defaultDir = home
		}
	}
	if defaultDir != "" && !filepath.IsAbs(defaultDir) {
		if abs, err := filepath.Abs(defaultDir); err == nil {
			defaultDir = abs
		}
	}
	selection, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title:                a.appText("data_sync.backup.directory_dialog_title", nil),
		DefaultDirectory:     defaultDir,
		CanCreateDirectories: true,
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	selection = strings.TrimSpace(selection)
	if selection == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}
	resolved, err := filepath.Abs(selection)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: "OK", Data: resolved}
}

func (a *App) preflightBackupJob(ctx context.Context, definition syncjob.JobDefinition, now time.Time) DataSyncJobPreflightResult {
	definition.Approval = nil
	result := DataSyncJobPreflightResult{Definition: definition, CheckedAt: now.UnixMilli(), Issues: []DataSyncJobPreflightIssue{}, NextRunAt: []int64{}}
	fail := func(code, stage string, err error) DataSyncJobPreflightResult {
		result.Issues = append(result.Issues, preflightIssue(code, DataSyncJobPreflightBlocker, stage, err.Error(), ""))
		return finishDataSyncJobPreflight(result)
	}
	if err := ctx.Err(); err != nil {
		return fail("request_cancelled", "preflight", err)
	}
	if err := syncjob.ValidateDefinition(definition); err != nil {
		return fail("definition_invalid", "endpoints", err)
	}
	// Web RPC is scoped to managed downloads. An unattended arbitrary local path
	// must not turn that boundary into a remote filesystem write primitive.
	if a.webRuntime {
		return fail("definition_invalid", "delivery", errors.New(a.appText("data_sync.backup.desktop_only", nil)))
	}
	source, err := a.resolveDataSyncJobEndpoint(definition.Source.ConnectionID, definition.Source.Database, definition.Source.Schema)
	if err != nil {
		return fail("source_connection_failed", "endpoints", err)
	}
	if !backupSQLSupported(source.Config.Type) {
		return fail("definition_invalid", "endpoints", errors.New(a.appText("data_sync.backup.unsupported", nil)))
	}
	definition.Source.ConnectionName = source.View.Name
	definition.Source.ConnectionType = source.Config.Type
	definition.Source.Fingerprint = source.Fingerprint
	result.Definition = definition
	result.SourceFingerprint = source.Fingerprint
	result.Capability = syncbackend.MigrationCapability{SourceType: source.Config.Type, TargetType: "sql", SupportLevel: syncbackend.MigrationSupportLevelFull, CanExecute: true}
	// 所有映射共用同一个元数据会话：逐表新建会话会让每张表都重连一次源库。
	if err := a.withWebMetadataSession(ctx, func(session *App) error {
		for _, mapping := range definition.Mappings {
			if !mapping.Enabled {
				continue
			}
			table := qualifyDataSyncJobObject(mapping.SourceSchema, mapping.SourceTable)
			checked := session.DBGetColumns(source.Config, source.Database, table)
			if !checked.Success {
				return errors.New(checked.Message)
			}
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return fail("source_columns_failed", "mappings", err)
	}
	if err := a.checkBackupDirectory(definition.Backup.Directory); err != nil {
		return fail("definition_invalid", "delivery", err)
	}
	result.DefinitionHash, err = dataSyncJobDefinitionHash(definition)
	if err != nil {
		return fail("definition_hash_failed", "preflight", err)
	}
	result.NextRunAt = previewDataSyncJobSchedule(definition, now, 5)
	return finishDataSyncJobPreflight(result)
}

func backupSQLSupported(kind string) bool {
	switch normalizeSQLClassifierDBType(kind) {
	case "mysql", "mariadb", "oceanbase", "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "sqlite", "duckdb", "sqlserver", "oracle", "dameng", "clickhouse", "iris", "hive":
		return true
	default:
		return false
	}
}

// Preflight checks an existing directory without creating a backup. Each run
// exclusively creates its own subdirectory; completed backups never overwrite.
func (a *App) checkBackupDirectory(directory string) error {
	directory = strings.TrimSpace(directory)
	info, err := os.Stat(directory)
	if err != nil {
		return fmt.Errorf("inspect backup directory: %w", err)
	}
	if !info.IsDir() {
		return errors.New(a.appText("data_sync.backup.directory_invalid", nil))
	}
	probe, err := os.CreateTemp(directory, ".gonavi-backup-probe-*")
	if err != nil {
		return fmt.Errorf("check backup directory access: %w", err)
	}
	closeErr := probe.Close()
	removeErr := os.Remove(probe.Name())
	return errors.Join(closeErr, removeErr)
}

func (a *App) executeBackupJob(ctx context.Context, request syncjob.ExecutionRequest, reporter syncjob.RunReporter) (syncjob.ExecutionOutcome, error) {
	outcome := syncjob.ExecutionOutcome{}
	if a.webRuntime {
		return outcome, errors.New(a.appText("data_sync.backup.desktop_only", nil))
	}
	definition := request.Definition
	if err := syncjob.ValidateDefinition(definition); err != nil {
		return outcome, err
	}
	source, err := a.resolveDataSyncJobEndpoint(definition.Source.ConnectionID, definition.Source.Database, definition.Source.Schema)
	if err != nil {
		return outcome, fmt.Errorf("resolve backup source: %w", err)
	}
	if !backupSQLSupported(source.Config.Type) {
		return outcome, errors.New(a.appText("data_sync.backup.unsupported", nil))
	}
	if definition.Source.Fingerprint == "" || !secureTextEqual(definition.Source.Fingerprint, source.Fingerprint) {
		return outcome, errors.New(a.appText("data_sync.backup.source_changed", nil))
	}
	if err := ctx.Err(); err != nil {
		return outcome, err
	}
	// 同一天的调度落在同一个 YYYY/MM/DD 目录里按时间戳增量累积，
	// 便于按天归档与保留策略；日期用本机时区，与用户查看备份时的认知一致。
	// 时间戳用 `-` 而不是 `:`：该文件名要跨平台存在，NTFS 不接受冒号。
	startedAt := time.Now()
	backupRoot := strings.TrimSpace(definition.Backup.Directory)
	directory := filepath.Join(
		backupRoot,
		startedAt.Format("2006"),
		startedAt.Format("01"),
		startedAt.Format("02"),
	)
	// 占位文件在导出提交时被原子改名覆盖。失败或取消时它必须消失：
	// 备份是用户的恢复依据，留下 0 字节文件会让恢复操作选中一个空备份。
	// 日期目录同理：失败备份不该留下 2026/09/23 这样的空壳，否则用户会在
	// 备份根目录看到本次运行并不存在的归属日期，按日期归档与保留策略也会
	// 被空目录干扰。清理注册在 MkdirAll 之前 —— 建目录成功但占位失败时
	// 同样要收回目录。
	path := ""
	committed := false
	defer func() {
		if committed {
			return
		}
		if path != "" {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				logger.Warnf("清理未完成备份占位文件失败：%v", err)
			}
		}
		pruneEmptyBackupDirectories(backupRoot, directory)
	}()
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return outcome, fmt.Errorf("create backup run directory: %w", err)
	}
	reserved, err := reserveBackupPath(directory, startedAt)
	if err != nil {
		return outcome, err
	}
	path = reserved
	tables := make([]string, 0, len(definition.Mappings))
	for _, mapping := range definition.Mappings {
		if mapping.Enabled {
			tables = append(tables, qualifyDataSyncJobObject(mapping.SourceSchema, mapping.SourceTable))
		}
	}
	if err := reporter.ReportProgress(syncjob.RunProgress{Total: len(tables), Stage: "running"}); err != nil {
		return outcome, err
	}
	content := definition.Backup.Content
	result := a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult {
		return session.exportTablesSQLToFile(ctx, source.Config, backupExportNamespace(source), tables, content != "data", content != "schema", path, nil, ExportFileOptions{Format: "sql"}, nil)
	})
	if !result.Success {
		if err := ctx.Err(); err != nil {
			return outcome, err
		}
		return outcome, fmt.Errorf("export backup: %s", result.Message)
	}
	committed = true
	payload, err := json.Marshal(map[string]any{"filePath": path, "objectCount": len(tables)})
	if err != nil {
		return outcome, fmt.Errorf("encode backup result: %w", err)
	}
	if err := reporter.Emit(syncjob.RunEventLog, a.appText("data_sync.backup.completed", map[string]any{"path": path}), payload); err != nil {
		return outcome, err
	}
	return outcome, reporter.ReportProgress(syncjob.RunProgress{Current: len(tables), Total: len(tables), Stage: "completed", Message: path})
}

// pruneEmptyBackupDirectories 收回一次失败备份独立创建的空日期目录。
//
// 只用 os.Remove 逐级上溯：它拒绝删除非空目录，因此同一天其它任务已写入的
// 备份、或用户自己放进目录的文件都不会被误删 —— 删除失败即停止上溯。
// 上溯止于 backupRoot，绝不触碰用户指定的备份根目录本身。
func pruneEmptyBackupDirectories(backupRoot, directory string) {
	if strings.TrimSpace(backupRoot) == "" {
		return
	}
	rootAbs, err := filepath.Abs(backupRoot)
	if err != nil {
		return
	}
	current, err := filepath.Abs(directory)
	if err != nil {
		return
	}
	for {
		if current == rootAbs || !strings.HasPrefix(current, rootAbs+string(filepath.Separator)) {
			return
		}
		if err := os.Remove(current); err != nil {
			return
		}
		current = filepath.Dir(current)
	}
}

// reserveBackupPath 返回一个本进程已独占创建的备份文件路径。
//
// 时间戳只精确到秒，同一秒内的两次触发会撞名；原实现靠 os.MkdirTemp 的随机
// 后缀保证唯一，换成固定文件名后必须自己补上：用 O_EXCL 占位，撞名就让出
// （时间戳加 -2、-3 …）。O_EXCL 同时排除了覆盖既有备份的可能——备份是用户
// 的恢复依据，任何情况下都不能被静默改写。
func reserveBackupPath(directory string, startedAt time.Time) (string, error) {
	base := "backup_" + startedAt.Format("2006-01-02_15-04-05")
	for attempt := 0; attempt < backupPathReserveAttempts; attempt++ {
		name := base + ".sql"
		if attempt > 0 {
			name = fmt.Sprintf("%s-%d.sql", base, attempt+1)
		}
		path := filepath.Join(directory, name)
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			if closeErr := file.Close(); closeErr != nil {
				return "", fmt.Errorf("reserve backup path: %w", closeErr)
			}
			return path, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return "", fmt.Errorf("reserve backup path: %w", err)
		}
	}
	return "", fmt.Errorf("reserve backup path: %d candidate names already exist in %s", backupPathReserveAttempts, directory)
}

func backupExportNamespace(source resolvedDataSyncJobEndpoint) string {
	if normalizeSQLClassifierDBType(source.Config.Type) == "sqlite" {
		if strings.TrimSpace(source.Schema) != "" {
			return source.Schema
		}
		return "main"
	}
	return source.Database
}
