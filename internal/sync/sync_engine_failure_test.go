package sync

import (
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

type failingApplySyncTargetDB struct {
	fakeMigrationDB
	applyErr     error
	appliedTable string
}

func (f *failingApplySyncTargetDB) ApplyChanges(tableName string, _ connection.ChangeSet) error {
	f.appliedTable = tableName
	return f.applyErr
}

type recordingExecSyncTargetDB struct {
	fakeQuerySyncTargetDB
	execLog []string
}

func (f *recordingExecSyncTargetDB) Exec(query string) (int64, error) {
	f.execLog = append(f.execLog, query)
	return 0, nil
}

type failOnApplyCallSyncTargetDB struct {
	fakeMigrationDB
	failCall         int
	applyCalls       int
	committedChanges connection.ChangeSet
}

func (f *failOnApplyCallSyncTargetDB) ApplyChanges(_ string, changes connection.ChangeSet) error {
	f.applyCalls++
	if f.applyCalls == f.failCall {
		return errors.New("injected batch failure")
	}
	f.committedChanges.Inserts = append(f.committedChanges.Inserts, changes.Inserts...)
	f.committedChanges.Updates = append(f.committedChanges.Updates, changes.Updates...)
	f.committedChanges.Deletes = append(f.committedChanges.Deletes, changes.Deletes...)
	return nil
}

func TestRunSyncFullOverwriteWithoutInsertDoesNotClearTargetAndFails(t *testing.T) {
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
	}
	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"source_db.users": columns},
	}
	targetDB := &recordingExecSyncTargetDB{
		fakeQuerySyncTargetDB: fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{
			columns: map[string][]connection.ColumnDefinition{"target_db.users": columns},
		}},
	}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "mysql", Database: "source_db", Host: "source.mysql.local"},
		TargetConfig:   connection.ConnectionConfig{Type: "mysql", Database: "target_db", Host: "target.mysql.local"},
		SourceDatabase: "source_db",
		TargetDatabase: "target_db",
		Tables:         []string{"users"},
		Content:        "data",
		Mode:           "full_overwrite",
		TableOptions: map[string]TableOptions{
			"users": {Insert: false, Update: true},
		},
	})

	if result.Success {
		t.Fatalf("expected full_overwrite without inserts to fail instead of clearing the target: %+v", result)
	}
	if result.TablesSynced != 0 || result.RowsInserted != 0 || result.RowsUpdated != 0 || result.RowsDeleted != 0 {
		t.Fatalf("unexpected successful work counters: %+v", result)
	}
	if !strings.Contains(result.Message, "users") || !strings.Contains(result.Message, "full_overwrite") || !strings.Contains(result.Message, "有效数据操作") {
		t.Fatalf("expected actionable effective-operation failure, got %q", result.Message)
	}
	if len(targetDB.execLog) != 0 {
		t.Fatalf("target must not be cleared when insert is disabled, exec=%v", targetDB.execLog)
	}
	if len(targetDB.appliedChanges.Inserts) != 0 {
		t.Fatalf("target must not receive inserts: %+v", targetDB.appliedChanges)
	}
}

func TestRunSyncInsertOnlyWithoutInsertDoesNotWriteAndFails(t *testing.T) {
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
	}
	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"source_db.users": columns},
	}
	targetDB := &recordingExecSyncTargetDB{
		fakeQuerySyncTargetDB: fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{
			columns: map[string][]connection.ColumnDefinition{"target_db.users": columns},
		}},
	}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "mysql", Database: "source_db", Host: "source.mysql.local"},
		TargetConfig:   connection.ConnectionConfig{Type: "mysql", Database: "target_db", Host: "target.mysql.local"},
		SourceDatabase: "source_db",
		TargetDatabase: "target_db",
		Tables:         []string{"users"},
		Content:        "data",
		Mode:           "insert_only",
		TableOptions: map[string]TableOptions{
			"users": {Insert: false, Update: true},
		},
	})

	if result.Success {
		t.Fatalf("expected insert_only without inserts to fail instead of reporting a no-op: %+v", result)
	}
	if !strings.Contains(result.Message, "insert_only") || !strings.Contains(result.Message, "有效数据操作") {
		t.Fatalf("expected actionable effective-operation failure, got %q", result.Message)
	}
	if len(targetDB.execLog) != 0 || len(targetDB.appliedChanges.Inserts) != 0 {
		t.Fatalf("target must not be changed, exec=%v changes=%+v", targetDB.execLog, targetDB.appliedChanges)
	}
}

func TestRunSyncInsertUpdateWithoutAnyOperationIsSuccessfulNoOp(t *testing.T) {
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
	}
	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"source_db.users": columns},
	}
	targetDB := &recordingExecSyncTargetDB{
		fakeQuerySyncTargetDB: fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{
			columns: map[string][]connection.ColumnDefinition{"target_db.users": columns},
		}},
	}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "mysql", Database: "source_db"},
		TargetConfig:   connection.ConnectionConfig{Type: "mysql", Database: "target_db"},
		SourceDatabase: "source_db",
		TargetDatabase: "target_db",
		Tables:         []string{"users"},
		Content:        "data",
		Mode:           "insert_update",
		TableOptions: map[string]TableOptions{
			"users": {},
		},
	})

	if !result.Success || result.TablesSynced != 1 {
		t.Fatalf("expected insert_update without selected differences to succeed as a no-op: %+v", result)
	}
	if len(targetDB.execLog) != 0 || len(targetDB.appliedChanges.Inserts) != 0 || len(targetDB.appliedChanges.Updates) != 0 || len(targetDB.appliedChanges.Deletes) != 0 {
		t.Fatalf("target must not be changed, exec=%v changes=%+v", targetDB.execLog, targetDB.appliedChanges)
	}
}

func TestRunSyncSchemaOnlyAllowsDisabledDataOperations(t *testing.T) {
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
	}
	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"source_db.users": columns},
	}
	targetDB := &recordingExecSyncTargetDB{
		fakeQuerySyncTargetDB: fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{
			columns: map[string][]connection.ColumnDefinition{"target_db.users": columns},
		}},
	}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "mysql", Database: "source_db"},
		TargetConfig:   connection.ConnectionConfig{Type: "mysql", Database: "target_db"},
		SourceDatabase: "source_db",
		TargetDatabase: "target_db",
		Tables:         []string{"users"},
		Content:        "schema",
		Mode:           "full_overwrite",
		TableOptions: map[string]TableOptions{
			"users": {Insert: false, Update: true},
		},
	})

	if !result.Success || result.TablesSynced != 1 {
		t.Fatalf("expected schema-only sync to ignore disabled data operations: %+v", result)
	}
	if len(targetDB.execLog) != 0 || len(targetDB.appliedChanges.Inserts) != 0 {
		t.Fatalf("schema-only existing-table no-op must not change data, exec=%v changes=%+v", targetDB.execLog, targetDB.appliedChanges)
	}
}

func TestRunSyncReportsFailureWhenInsertUpdateCannotProcessTableWithoutPrimaryKey(t *testing.T) {
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO"},
		{Name: "name", Type: "varchar(255)", Nullable: "YES"},
	}
	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"source_db.users": columns},
	}
	targetDB := &fakeQuerySyncTargetDB{
		fakeMigrationDB: fakeMigrationDB{
			columns: map[string][]connection.ColumnDefinition{"target_db.users": columns},
		},
	}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "mysql", Database: "source_db", Host: "mysql.local"},
		TargetConfig:   connection.ConnectionConfig{Type: "mysql", Database: "target_db", Host: "mysql.local"},
		SourceDatabase: "source_db",
		TargetDatabase: "target_db",
		Tables:         []string{"users"},
		Content:        "data",
		Mode:           "insert_update",
	})

	if result.Success {
		t.Fatalf("expected an unsynchronizable table to fail the task instead of reporting false success: %+v", result)
	}
	if result.TablesSynced != 0 || result.RowsInserted != 0 {
		t.Fatalf("unexpected successful work counters: %+v", result)
	}
	if !strings.Contains(result.Message, "users") || !strings.Contains(result.Message, "主键") {
		t.Fatalf("expected actionable table failure message, got %q", result.Message)
	}
	if len(targetDB.appliedChanges.Inserts) != 0 {
		t.Fatalf("unexpected target writes: %+v", targetDB.appliedChanges.Inserts)
	}
}

func TestRunSyncReportsFailureWhenExistingOnlyTargetTableIsMissing(t *testing.T) {
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
	}
	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"source_db.users": columns},
	}
	targetDB := &fakeQuerySyncTargetDB{}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "mysql", Database: "source_db", Host: "mysql.local"},
		TargetConfig:        connection.ConnectionConfig{Type: "mysql", Database: "target_db", Host: "mysql.local"},
		SourceDatabase:      "source_db",
		TargetDatabase:      "target_db",
		Tables:              []string{"users"},
		Content:             "data",
		Mode:                "insert_only",
		TargetTableStrategy: "existing_only",
	})

	if result.Success {
		t.Fatalf("expected missing existing-only target table to fail the task: %+v", result)
	}
	if result.TablesSynced != 0 || result.RowsInserted != 0 {
		t.Fatalf("unexpected successful work counters: %+v", result)
	}
	if !strings.Contains(result.Message, "users") || !strings.Contains(result.Message, "目标表不存在") {
		t.Fatalf("expected actionable target-table failure message, got %q", result.Message)
	}
}

func TestRunSyncReportsFailureWhenApplyChangesFails(t *testing.T) {
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "varchar(255)", Nullable: "YES"},
	}
	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"source_db.users": columns},
		queryData: map[string][]map[string]interface{}{
			"SELECT `id`, `name` FROM `source_db`.`users` ORDER BY `id` ASC LIMIT 1000 OFFSET 0": {
				{"id": int64(1), "name": "Alice"},
			},
		},
	}
	targetDB := &failingApplySyncTargetDB{
		fakeMigrationDB: fakeMigrationDB{
			columns: map[string][]connection.ColumnDefinition{"target_db.users": columns},
		},
		applyErr: errors.New("target write boom"),
	}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	stages := make([]string, 0)
	result := NewSyncEngine(Reporter{OnProgress: func(event SyncProgressEvent) {
		stages = append(stages, event.Stage)
	}}).RunSync(SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "mysql", Database: "source_db", Host: "mysql.local"},
		TargetConfig:   connection.ConnectionConfig{Type: "mysql", Database: "target_db", Host: "mysql.local"},
		SourceDatabase: "source_db",
		TargetDatabase: "target_db",
		Tables:         []string{"users"},
		Content:        "data",
		Mode:           "insert_only",
		JobID:          "apply-error-job",
	})

	if result.Success {
		t.Fatalf("expected target write failure to fail the task: %+v", result)
	}
	if result.TablesSynced != 0 || result.RowsInserted != 0 {
		t.Fatalf("unexpected successful work counters: %+v", result)
	}
	if !strings.Contains(result.Message, "users") || !strings.Contains(result.Message, "target write boom") {
		t.Fatalf("expected actionable apply failure message, got %q", result.Message)
	}
	if targetDB.appliedTable != "users" {
		t.Fatalf("expected MySQL apply to use target connection's default database, table=%q", targetDB.appliedTable)
	}
	if len(stages) == 0 || stages[len(stages)-1] != localizedSyncBackendText("data_sync.progress.stage.failed", nil) {
		t.Fatalf("expected final failed progress stage, got %v", stages)
	}
}

func TestRunSyncKeepsDirectImportCountsWhenLaterPageFails(t *testing.T) {
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
	}
	firstPage := make([]map[string]interface{}, defaultSyncReadPageSize)
	for i := range firstPage {
		firstPage[i] = map[string]interface{}{"id": i + 1}
	}
	firstQuery := buildPagedSourceTableQuery("mysql", "source_db.users", columns, "id", defaultSyncReadPageSize, 0)
	secondQuery := buildPagedSourceTableQuery("mysql", "source_db.users", columns, "id", defaultSyncReadPageSize, defaultSyncReadPageSize)
	sourceDB := &errorMigrationDB{
		fakeMigrationDB: fakeMigrationDB{
			columns: map[string][]connection.ColumnDefinition{"source_db.users": columns},
			queryData: map[string][]map[string]interface{}{
				firstQuery: firstPage,
			},
		},
		queryErrors: map[string]error{secondQuery: errors.New("second source page boom")},
	}
	targetDB := &fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"target_db.users": columns},
	}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "mysql", Database: "source_db", Host: "source.mysql.local"},
		TargetConfig:   connection.ConnectionConfig{Type: "mysql", Database: "target_db", Host: "target.mysql.local"},
		SourceDatabase: "source_db",
		TargetDatabase: "target_db",
		Tables:         []string{"users"},
		Content:        "data",
		Mode:           "insert_only",
	})

	if result.Success {
		t.Fatalf("expected later source page failure: %+v", result)
	}
	if result.RowsInserted != defaultSyncReadPageSize {
		t.Fatalf("expected already committed direct-import rows to be reported, got %+v", result)
	}
	if len(targetDB.appliedChanges.Inserts) != defaultSyncReadPageSize {
		t.Fatalf("expected first page to remain committed, got %d rows", len(targetDB.appliedChanges.Inserts))
	}
	if !strings.Contains(result.Message, "second source page boom") {
		t.Fatalf("expected later page error in result, got %q", result.Message)
	}
}

func TestRunSyncKeepsPagedDiffCountsWhenLaterPageFails(t *testing.T) {
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
	}
	firstPage := make([]map[string]interface{}, defaultSyncReadPageSize)
	for i := range firstPage {
		firstPage[i] = map[string]interface{}{"id": i + 1}
	}
	firstQuery := buildPagedSourceTableQuery("mysql", "source_db.users", columns, "id", defaultSyncReadPageSize, 0)
	secondQuery := buildPagedSourceTableQuery("mysql", "source_db.users", columns, "id", defaultSyncReadPageSize, defaultSyncReadPageSize)
	sourceDB := &errorMigrationDB{
		fakeMigrationDB: fakeMigrationDB{
			columns: map[string][]connection.ColumnDefinition{"source_db.users": columns},
			queryData: map[string][]map[string]interface{}{
				firstQuery: firstPage,
			},
		},
		queryErrors: map[string]error{secondQuery: errors.New("second diff page boom")},
	}
	targetDB := &fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"target_db.users": columns},
	}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "mysql", Database: "source_db", Host: "source.mysql.local"},
		TargetConfig:   connection.ConnectionConfig{Type: "mysql", Database: "target_db", Host: "target.mysql.local"},
		SourceDatabase: "source_db",
		TargetDatabase: "target_db",
		Tables:         []string{"users"},
		Content:        "data",
		Mode:           "insert_update",
	})

	if result.Success {
		t.Fatalf("expected later diff page failure: %+v", result)
	}
	if result.RowsInserted != defaultSyncReadPageSize {
		t.Fatalf("expected already committed diff rows to be reported, got %+v", result)
	}
	if len(targetDB.appliedChanges.Inserts) != defaultSyncReadPageSize {
		t.Fatalf("expected first diff page to remain committed, got %d rows", len(targetDB.appliedChanges.Inserts))
	}
	if !strings.Contains(result.Message, "second diff page boom") {
		t.Fatalf("expected later page error in result, got %q", result.Message)
	}
}

func TestRunSyncContinuesOtherTablesButReportsPartialFailure(t *testing.T) {
	goodColumns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
	}
	badColumns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO"},
	}
	sourceDB := &fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{
		"source_db.good": goodColumns,
		"source_db.bad":  badColumns,
	}}
	targetDB := &fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"target_db.good": goodColumns,
			"target_db.bad":  badColumns,
		},
	}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	stages := make([]string, 0)
	result := NewSyncEngine(Reporter{OnProgress: func(event SyncProgressEvent) {
		stages = append(stages, event.Stage)
	}}).RunSync(SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "mysql", Database: "source_db", Host: "mysql.local"},
		TargetConfig:   connection.ConnectionConfig{Type: "mysql", Database: "target_db", Host: "mysql.local"},
		SourceDatabase: "source_db",
		TargetDatabase: "target_db",
		Tables:         []string{"good", "bad"},
		Content:        "data",
		Mode:           "insert_update",
		JobID:          "partial-failure-job",
	})

	if result.Success {
		t.Fatalf("expected mixed table outcomes to fail overall: %+v", result)
	}
	if result.TablesSynced != 1 {
		t.Fatalf("expected the successful no-op table to remain counted, got %+v", result)
	}
	if !strings.Contains(result.Message, "bad") || !strings.Contains(result.Message, "主键") {
		t.Fatalf("expected failed table summary, got %q", result.Message)
	}
	if len(stages) == 0 || stages[len(stages)-1] != localizedSyncBackendText("data_sync.progress.stage.failed", nil) {
		t.Fatalf("expected final failed progress stage, got %v", stages)
	}
}

func TestRunSyncKeepsConsistentEmptyTableAsSuccessfulNoOp(t *testing.T) {
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
	}
	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"source_db.users": columns},
	}
	targetDB := &fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"target_db.users": columns},
	}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	stages := make([]string, 0)
	result := NewSyncEngine(Reporter{OnProgress: func(event SyncProgressEvent) {
		stages = append(stages, event.Stage)
	}}).RunSync(SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "mysql", Database: "source_db", Host: "mysql.local"},
		TargetConfig:   connection.ConnectionConfig{Type: "mysql", Database: "target_db", Host: "mysql.local"},
		SourceDatabase: "source_db",
		TargetDatabase: "target_db",
		Tables:         []string{"users"},
		Content:        "data",
		Mode:           "insert_update",
		JobID:          "no-op-job",
	})

	if !result.Success {
		t.Fatalf("expected a genuinely consistent empty table to succeed: %+v", result)
	}
	if result.TablesSynced != 1 || result.RowsInserted != 0 || result.RowsUpdated != 0 || result.RowsDeleted != 0 {
		t.Fatalf("unexpected no-op counters: %+v", result)
	}
	if len(stages) == 0 || stages[len(stages)-1] != localizedSyncBackendText("data_sync.progress.stage.completed", nil) {
		t.Fatalf("expected final completed progress stage, got %v", stages)
	}
}

func TestRunSyncMySQLUsesSelectedSourceAndTargetDatabases(t *testing.T) {
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "varchar(255)", Nullable: "YES"},
	}
	sourceQuery := "SELECT `id`, `name` FROM `source_db`.`users` ORDER BY `id` ASC LIMIT 1000 OFFSET 0"
	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"source_db.users": columns},
		queryData: map[string][]map[string]interface{}{
			sourceQuery: {
				{"id": int64(1), "name": "Alice"},
			},
		},
	}
	targetDB := &fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"target_db.users": columns},
	}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "mysql", Database: "saved_source", Host: "mysql.local"},
		TargetConfig:        connection.ConnectionConfig{Type: "mysql", Database: "saved_target", Host: "mysql.local"},
		SourceDatabase:      "source_db",
		TargetDatabase:      "target_db",
		Tables:              []string{"users"},
		Content:             "data",
		Mode:                "insert_only",
		TargetTableStrategy: "existing_only",
	})

	if !result.Success {
		t.Fatalf("expected selected-database MySQL sync to succeed: %+v", result)
	}
	if result.TablesSynced != 1 || result.RowsInserted != 1 {
		t.Fatalf("unexpected cross-database counters: %+v", result)
	}
	if len(sourceDB.queryLog) == 0 || sourceDB.queryLog[0] != sourceQuery {
		t.Fatalf("expected source query to use source_db, got %v", sourceDB.queryLog)
	}
	if targetDB.appliedTable != "users" {
		t.Fatalf("expected apply to use target connection's selected default database, table=%q", targetDB.appliedTable)
	}
	if len(targetDB.appliedChanges.Inserts) != 1 {
		t.Fatalf("expected one target insert, got %+v", targetDB.appliedChanges)
	}
}

func TestRunSyncFallbackReportsRowsCommittedBeforeLaterBatchFailure(t *testing.T) {
	columns := []connection.ColumnDefinition{{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"}}
	rows := make([]map[string]interface{}, defaultSyncApplyBatchSize+1)
	for index := range rows {
		rows[index] = map[string]interface{}{"id": index + 1}
	}
	sourceDB := &staticRowsSyncSourceDB{
		fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"source_db.users": columns}},
		rows:            rows,
	}
	targetDB := &failOnApplyCallSyncTargetDB{
		fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"target_db.users": columns}},
		failCall:        2,
	}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "oracle", Database: "ORCLPDB1"},
		TargetConfig:   connection.ConnectionConfig{Type: "mysql", Database: "target_db"},
		SourceDatabase: "source_db",
		TargetDatabase: "target_db",
		Tables:         []string{"users"},
		Content:        "data",
		Mode:           "insert_only",
	})

	if result.Success {
		t.Fatalf("expected the second batch failure to fail the sync: %+v", result)
	}
	if result.TablesSynced != 0 || result.RowsInserted != defaultSyncApplyBatchSize {
		t.Fatalf("expected committed first-batch rows to be reported: %+v", result)
	}
	if len(targetDB.committedChanges.Inserts) != defaultSyncApplyBatchSize || targetDB.applyCalls != 2 {
		t.Fatalf("unexpected committed changes/calls: rows=%d calls=%d", len(targetDB.committedChanges.Inserts), targetDB.applyCalls)
	}
	if !strings.Contains(result.Message, "此前已确认完整提交") || !strings.Contains(result.Message, "失败批次可能部分落库") || !strings.Contains(result.Message, "批次 2/2") {
		t.Fatalf("expected an actionable partial-commit message, got %q", result.Message)
	}
}

func TestRunSyncSourceQueryFallbackReportsRowsCommittedBeforeLaterBatchFailure(t *testing.T) {
	columns := []connection.ColumnDefinition{{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"}}
	rows := make([]map[string]interface{}, defaultSyncApplyBatchSize+1)
	for index := range rows {
		rows[index] = map[string]interface{}{"id": index + 1}
	}
	sourceDB := &staticRowsSyncSourceDB{rows: rows}
	targetDB := &failOnApplyCallSyncTargetDB{
		fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"target_db.users": columns}},
		failCall:        2,
	}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "oracle", Database: "ORCLPDB1"},
		TargetConfig:   connection.ConnectionConfig{Type: "mysql", Database: "target_db"},
		TargetDatabase: "target_db",
		Tables:         []string{"users"},
		SourceQuery:    "SELECT id FROM source_users",
		Content:        "data",
		Mode:           "insert_only",
	})

	if result.Success {
		t.Fatalf("expected the second source-query batch failure to fail the sync: %+v", result)
	}
	if result.TablesSynced != 0 || result.RowsInserted != defaultSyncApplyBatchSize {
		t.Fatalf("expected source-query committed rows to be reported: %+v", result)
	}
	if len(targetDB.committedChanges.Inserts) != defaultSyncApplyBatchSize || targetDB.applyCalls != 2 {
		t.Fatalf("unexpected source-query committed changes/calls: rows=%d calls=%d", len(targetDB.committedChanges.Inserts), targetDB.applyCalls)
	}
	if !strings.Contains(result.Message, "此前已确认完整提交") || !strings.Contains(result.Message, "失败批次可能部分落库") || !strings.Contains(result.Message, "批次 2/2") {
		t.Fatalf("expected source-query partial-commit message, got %q", result.Message)
	}
}
