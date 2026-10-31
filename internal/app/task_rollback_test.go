package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/syncjob"
	"GoNavi-Wails/internal/taskrollback"
)

type rollbackCatalogDB struct {
	*fakeSQLFileBatchDB
	tables []string
}

func (database *rollbackCatalogDB) GetTables(string) ([]string, error) {
	return append([]string(nil), database.tables...), nil
}

func installTaskRollbackApp(t *testing.T, database db.Database) *App {
	t.Helper()
	originalDatabase := newDatabaseFunc
	originalResolve := resolveTaskRollbackConnectionFn
	originalWrite := writeTaskRollbackSnapshotFile
	t.Cleanup(func() {
		newDatabaseFunc = originalDatabase
		resolveTaskRollbackConnectionFn = originalResolve
		writeTaskRollbackSnapshotFile = originalWrite
	})
	if database != nil {
		newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	}
	app := NewApp()
	app.configDir = t.TempDir()
	return app
}

func TestImportDatabaseSQLSkipsSnapshotForCreateOnly(t *testing.T) {
	database := &fakeSQLFileBatchDB{}
	app := installTaskRollbackApp(t, database)
	filePath := filepath.Join(t.TempDir(), "igap.sql")
	content := "CREATE TABLE `t_annual_adjust`(id INT);\n"
	if err := os.WriteFile(filePath, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	result := app.ImportDatabaseSQL(connection.ConnectionConfig{Type: "mysql"}, "igap_pro", filePath, "rollback-empty", false)
	if !result.Success {
		t.Fatalf("import failed: %#v", result)
	}
	joined := strings.Join(database.execQueries, "\n")
	if !strings.Contains(joined, "CREATE TABLE `t_annual_adjust`(id INT)") {
		t.Fatalf("import did not execute the file: %#v", database.execQueries)
	}
	store, err := app.taskRollbackStore()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReadyByTask("rollback-empty"); !errors.Is(err, taskrollback.ErrNotFound) {
		t.Fatalf("CREATE-only import should not create a rollback snapshot: %v", err)
	}
}

func TestImportDatabaseSQLScopedSnapshotSkipsUnrelatedTables(t *testing.T) {
	database := &rollbackCatalogDB{
		fakeSQLFileBatchDB: &fakeSQLFileBatchDB{},
		tables:             []string{"legacy_a", "legacy_b"},
	}
	app := installTaskRollbackApp(t, database)
	filePath := filepath.Join(t.TempDir(), "alter.sql")
	content := "ALTER TABLE `legacy_a` ADD COLUMN note VARCHAR(20);\n"
	if err := os.WriteFile(filePath, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	result := app.ImportDatabaseSQL(connection.ConnectionConfig{Type: "mysql"}, "igap_pro", filePath, "rollback-scoped", false)
	if !result.Success {
		t.Fatalf("import failed: %#v", result)
	}
	point := mustReadyRollbackPoint(t, app, "rollback-scoped")
	if point.WholeDatabase {
		t.Fatalf("ALTER import still requested a whole database snapshot: %#v", point)
	}
	if len(point.Objects) != 1 || point.Objects[0].Name != "legacy_a" {
		t.Fatalf("rollback objects = %#v", point.Objects)
	}
}

func TestImportDatabaseSQLRefusesToStartWhenSnapshotCannotBeSaved(t *testing.T) {
	database := &fakeSQLFileBatchDB{}
	app := installTaskRollbackApp(t, database)
	writeTaskRollbackSnapshotFile = func(*App, context.Context, connection.ConnectionConfig, string, []string, string) error {
		return errors.New("disk full")
	}
	filePath := filepath.Join(t.TempDir(), "igap.sql")
	if err := os.WriteFile(filePath, []byte("ALTER TABLE `legacy_a` ADD COLUMN note INT;\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	result := app.ImportDatabaseSQL(connection.ConnectionConfig{Type: "mysql"}, "igap_pro", filePath, "rollback-fail", false)
	if result.Success || !strings.Contains(result.Message, "disk full") {
		t.Fatalf("result = %#v", result)
	}
	if len(database.execQueries) != 0 {
		t.Fatalf("SQL ran without a snapshot: %#v", database.execQueries)
	}
	store, err := app.taskRollbackStore()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReadyByTask("rollback-fail"); !errors.Is(err, taskrollback.ErrNotFound) {
		t.Fatalf("failed snapshot left a ready point: %v", err)
	}
}

func TestSecondRollbackCaptureKeepsTheOriginalSnapshot(t *testing.T) {
	database := &fakeSQLFileBatchDB{}
	app := installTaskRollbackApp(t, database)
	writes := 0
	writeTaskRollbackSnapshotFile = func(_ *App, _ context.Context, _ connection.ConnectionConfig, _ string, _ []string, dest string) error {
		writes++
		if writes > 1 {
			return errors.New("replaced the original snapshot")
		}
		return os.WriteFile(dest, []byte(taskRollbackEmptySnapshot), 0o600)
	}
	request := taskRollbackCapture{
		Kind:          taskrollback.KindSQLImport,
		TaskID:        "rollback-once",
		Config:        connection.ConnectionConfig{Type: "mysql", ID: "saved-1"},
		Database:      "igap_pro",
		WholeDatabase: true,
		AllowCreate:   true,
		DB:            database,
	}
	if err := app.captureTaskRollback(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	if err := app.captureTaskRollback(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	if writes != 1 {
		t.Fatalf("snapshot writes = %d, want 1", writes)
	}
	point := mustReadyRollbackPoint(t, app, request.TaskID)
	if point.ConnectionID != "saved-1" {
		t.Fatalf("connection id = %q", point.ConnectionID)
	}
}

func TestRestoreDropsObjectsCreatedAfterAnEmptySnapshot(t *testing.T) {
	database := &rollbackCatalogDB{fakeSQLFileBatchDB: &fakeSQLFileBatchDB{}, tables: []string{"users"}}
	app := installTaskRollbackApp(t, database)
	resolveTaskRollbackConnectionFn = func(*App, taskrollback.Point) (connection.ConnectionConfig, error) {
		return connection.ConnectionConfig{Type: "mysql"}, nil
	}
	store, err := app.taskRollbackStore()
	if err != nil {
		t.Fatal(err)
	}
	point := taskrollback.Point{
		ID:            taskrollback.NewPointID(),
		Kind:          taskrollback.KindSQLImport,
		TaskID:        "rollback-drop",
		ConnectionID:  "saved-1",
		DBType:        "mysql",
		Database:      "igap_pro",
		WholeDatabase: true,
		Objects:       []taskrollback.Object{{Name: "users", Existed: false}},
	}
	snapshotPath, err := store.Begin(point)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(snapshotPath, []byte(taskRollbackEmptySnapshot), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Commit(point.ID, int64(len(taskRollbackEmptySnapshot))); err != nil {
		t.Fatal(err)
	}

	if err := app.restoreTaskRollbackPoint(context.Background(), point); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(database.execQueries, "\n")
	if !strings.Contains(joined, "DROP TABLE IF EXISTS") || !strings.Contains(joined, "users") {
		t.Fatalf("created table was not dropped: %#v", database.execQueries)
	}
	if _, err := store.ReadyByTask(point.TaskID); !errors.Is(err, taskrollback.ErrNotReady) {
		t.Fatalf("restored point status = %v", err)
	}
}

func TestRestoreRefusesProtectedConnectionsBeforeChangingThem(t *testing.T) {
	database := &rollbackCatalogDB{fakeSQLFileBatchDB: &fakeSQLFileBatchDB{}, tables: []string{"users"}}
	app := installTaskRollbackApp(t, database)
	resolveTaskRollbackConnectionFn = func(*App, taskrollback.Point) (connection.ConnectionConfig, error) {
		return connection.ConnectionConfig{
			Type:       "mysql",
			Protection: connection.ConnectionProtectionConfig{RestrictStructureEdit: true},
		}, nil
	}
	store, err := app.taskRollbackStore()
	if err != nil {
		t.Fatal(err)
	}
	point := taskrollback.Point{
		ID:            taskrollback.NewPointID(),
		Kind:          taskrollback.KindSQLImport,
		TaskID:        "rollback-protected",
		DBType:        "mysql",
		Database:      "igap_pro",
		WholeDatabase: true,
		Objects:       []taskrollback.Object{{Name: "users", Existed: false}},
	}
	snapshotPath, err := store.Begin(point)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(snapshotPath, []byte(taskRollbackEmptySnapshot), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Commit(point.ID, int64(len(taskRollbackEmptySnapshot))); err != nil {
		t.Fatal(err)
	}

	err = app.restoreTaskRollbackPoint(context.Background(), point)
	if err == nil {
		t.Fatal("protected connection was rolled back")
	}
	if len(database.execQueries) != 0 {
		t.Fatalf("protected connection was changed: %#v", database.execQueries)
	}
	if _, readyErr := store.ReadyByTask(point.TaskID); readyErr != nil {
		t.Fatalf("failed restore consumed the snapshot: %v", readyErr)
	}
}

func TestTaskRollbackReplayJobIDDoesNotUseTheDatabaseName(t *testing.T) {
	got := taskRollbackReplayJobID("11111111-2222-3333-4444-555555555555")
	if got != "rb11111111222233334444555555555555" || strings.Contains(got, "-") {
		t.Fatalf("replay job id = %q", got)
	}
}

func TestTaskRollbackViewLookupIgnoresUnnamedRows(t *testing.T) {
	database := &fakeMySQLGTIDImportDB{
		fakeSQLFileBatchDB: &fakeSQLFileBatchDB{},
		gtidExecuted:       "server:1-9",
		serverVersion:      "8.0.36",
	}
	lookup, err := listTaskRollbackViewLookup(database, connection.ConnectionConfig{Type: "mysql"}, "igap_pro")
	if err != nil {
		t.Fatal(err)
	}
	if len(lookup) != 0 {
		t.Fatalf("unnamed query rows became views: %#v", lookup)
	}
}

func TestRollbackDropScopeLeavesUnrelatedTables(t *testing.T) {
	config := connection.ConnectionConfig{Type: "mysql"}
	current := []taskrollback.Object{{Name: "users", Existed: true}, {Name: "orders", Existed: true}}
	watched := taskrollback.Point{
		Database: "app",
		Objects:  []taskrollback.Object{{Name: "orders", Existed: false}},
	}
	drops := rollbackObjectsToDrop(config, "app", watched, current)
	if len(drops) != 1 || drops[0].Name != "orders" {
		t.Fatalf("table-scoped drops = %#v", drops)
	}

	whole := taskrollback.Point{
		Database:      "app",
		WholeDatabase: true,
		Objects:       []taskrollback.Object{{Name: "users", Existed: true}},
	}
	drops = rollbackObjectsToDrop(config, "app", whole, current)
	if len(drops) != 1 || drops[0].Name != "orders" {
		t.Fatalf("whole-database drops = %#v", drops)
	}
}

func TestDataSyncRollbackSkipsResumeCompareBackupAndEmptyDatabase(t *testing.T) {
	if dataSyncKindNeedsRollback(syncjob.JobKindCompare) || dataSyncKindNeedsRollback(syncjob.JobKindBackup) {
		t.Fatal("compare and backup must not create rollback points")
	}
	if !dataSyncKindNeedsRollback(syncjob.JobKindMigration) || !dataSyncKindNeedsRollback(syncjob.JobKindReconcile) || !dataSyncKindNeedsRollback(syncjob.JobKindQuerySink) {
		t.Fatal("migration, reconcile, and query sink need rollback points")
	}
	if dataSyncRunShouldSnapshot(syncjob.ExecutionRequest{Run: syncjob.RunRecord{Trigger: syncjob.RunTriggerRetry}}) {
		t.Fatal("retry must keep the original snapshot")
	}
	if dataSyncRunShouldSnapshot(syncjob.ExecutionRequest{Run: syncjob.RunRecord{Trigger: syncjob.RunTriggerResume}}) {
		t.Fatal("resume must keep the original snapshot")
	}
	if dataSyncRunShouldSnapshot(syncjob.ExecutionRequest{Checkpoint: &syncjob.Checkpoint{}, Run: syncjob.RunRecord{Trigger: syncjob.RunTriggerManual}}) {
		t.Fatal("checkpoint resume must keep the original snapshot")
	}

	app := NewApp()
	err := app.captureDataSyncRollback(context.Background(), syncjob.ExecutionRequest{
		Run:        syncjob.RunRecord{ID: "sync-run-1", Trigger: syncjob.RunTriggerManual},
		Definition: syncjob.JobDefinition{Kind: syncjob.JobKindMigration},
	}, resolvedDataSyncJobEndpoint{}, []syncjob.TableMapping{{Enabled: true, TargetTable: "orders"}})
	if err != nil {
		t.Fatalf("empty target database refused the task: %v", err)
	}
}

func mustReadyRollbackPoint(t *testing.T, app *App, taskID string) taskrollback.Point {
	t.Helper()
	store, err := app.taskRollbackStore()
	if err != nil {
		t.Fatal(err)
	}
	point, err := store.ReadyByTask(taskID)
	if err != nil {
		t.Fatal(err)
	}
	return point
}

func readRollbackSnapshot(t *testing.T, app *App, pointID string) []byte {
	t.Helper()
	store, err := app.taskRollbackStore()
	if err != nil {
		t.Fatal(err)
	}
	path, err := store.SnapshotPath(pointID)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return payload
}
