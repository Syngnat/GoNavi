package sync

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

type staticRowsSyncSourceDB struct {
	fakeMigrationDB
	rows []map[string]interface{}
}

func (f *staticRowsSyncSourceDB) Query(query string) ([]map[string]interface{}, []string, error) {
	f.queryLog = append(f.queryLog, query)
	return f.rows, nil, nil
}

type recordingNonBatchSyncTargetDB struct {
	fakeMigrationDB
	execLog []string
}

func (f *recordingNonBatchSyncTargetDB) Exec(query string) (int64, error) {
	f.execLog = append(f.execLog, query)
	return 0, nil
}

func containsDestructiveClear(queries []string) bool {
	for _, query := range queries {
		upper := strings.ToUpper(query)
		if strings.Contains(upper, "TRUNCATE TABLE") || strings.Contains(upper, "DELETE FROM") {
			return true
		}
	}
	return false
}

func TestRunSyncFallbackFullOverwriteValidatesColumnsBeforeClear(t *testing.T) {
	columns := []connection.ColumnDefinition{{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"}}
	sourceDB := &staticRowsSyncSourceDB{
		fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"app.users": columns}},
		rows:            []map[string]interface{}{{"id": 1, "dynamic_column": "value"}},
	}
	targetDB := &recordingExecSyncTargetDB{fakeQuerySyncTargetDB: fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"app.users": columns},
	}}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "mysql", Host: "mysql.local", Port: 3306, Database: "app"},
		TargetConfig:   connection.ConnectionConfig{Type: "mysql", Host: "mysql.local", Port: 3306, Database: "app"},
		SourceDatabase: "app",
		TargetDatabase: "app",
		Tables:         []string{"users"},
		Content:        "data",
		Mode:           "full_overwrite",
		AutoAddColumns: true,
	})

	if result.Success || !strings.Contains(result.Message, "dynamic_column") {
		t.Fatalf("expected field validation failure, got %+v", result)
	}
	if containsDestructiveClear(targetDB.execLog) {
		t.Fatalf("target was cleared before field validation completed: %v", targetDB.execLog)
	}
	if len(targetDB.appliedChanges.Inserts) != 0 {
		t.Fatalf("rows were applied after field validation failed: %+v", targetDB.appliedChanges)
	}
}

func TestRunSyncDataOnlyRejectsPlannedSchemaChanges(t *testing.T) {
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "varchar(255)", Nullable: "YES"},
	}
	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"source_db.users": columns},
		indexes: map[string][]connection.IndexDefinition{"source_db.users": {
			{Name: "idx_users_name", ColumnName: "name", NonUnique: 1, SeqInIndex: 1, IndexType: "BTREE"},
		}},
	}
	targetDB := &recordingExecSyncTargetDB{fakeQuerySyncTargetDB: fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"target_db.users": {columns[0]}},
	}}}
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
		AutoAddColumns: true,
		CreateIndexes:  true,
		TableOptions:   map[string]TableOptions{"users": {}},
	})

	if result.Success || !strings.Contains(result.Message, "仅同步数据") {
		t.Fatalf("expected data-only schema-change rejection, got %+v", result)
	}
	if len(targetDB.execLog) != 0 {
		t.Fatalf("data-only sync must not execute schema SQL: %v", targetDB.execLog)
	}
}

func TestRunSyncDataOnlyRejectsMissingTargetAutoCreate(t *testing.T) {
	columns := []connection.ColumnDefinition{{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"}}
	sourceDB := &fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"source_db.users": columns}}
	targetDB := &recordingNonBatchSyncTargetDB{}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "mysql", Database: "source_db"},
		TargetConfig:        connection.ConnectionConfig{Type: "mysql", Database: "target_db"},
		SourceDatabase:      "source_db",
		TargetDatabase:      "target_db",
		Tables:              []string{"users"},
		Content:             "data",
		Mode:                "insert_update",
		TargetTableStrategy: "auto_create_if_missing",
		TableOptions:        map[string]TableOptions{"users": {}},
	})

	if result.Success || !strings.Contains(result.Message, "仅同步数据") {
		t.Fatalf("expected data-only target-create rejection, got %+v", result)
	}
	if len(targetDB.execLog) != 0 {
		t.Fatalf("data-only sync must not create a missing target: %v", targetDB.execLog)
	}
}

func TestRunSyncDataOnlyRejectsPostDataSchemaChanges(t *testing.T) {
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "varchar(255)", Nullable: "YES"},
	}
	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"source_db.users": columns},
		indexes: map[string][]connection.IndexDefinition{"source_db.users": {
			{Name: "idx_users_name", ColumnName: "name", NonUnique: 1, SeqInIndex: 1, IndexType: "BTREE"},
		}},
	}
	targetDB := &recordingNonBatchSyncTargetDB{fakeMigrationDB: fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"target_db.users": columns},
	}}
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
		CreateIndexes:  true,
		TableOptions:   map[string]TableOptions{"users": {}},
	})

	if !result.Success {
		t.Fatalf("data-only no-op should remain successful, got %+v", result)
	}
	if len(targetDB.execLog) != 0 {
		t.Fatalf("data-only sync must not create indexes: %v", targetDB.execLog)
	}
}

func TestRunSyncFallbackFullOverwriteChecksApplierBeforeClear(t *testing.T) {
	columns := []connection.ColumnDefinition{{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"}}
	sourceDB := &staticRowsSyncSourceDB{
		fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"source_db.users": columns}},
		rows:            []map[string]interface{}{{"id": 1}},
	}
	targetDB := &recordingNonBatchSyncTargetDB{fakeMigrationDB: fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"target_db.users": columns},
	}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "oracle", Database: "source_db"},
		TargetConfig:   connection.ConnectionConfig{Type: "mysql", Database: "target_db"},
		SourceDatabase: "source_db",
		TargetDatabase: "target_db",
		Tables:         []string{"users"},
		Content:        "data",
		Mode:           "full_overwrite",
	})

	if result.Success || !strings.Contains(result.Message, "ApplyChanges") {
		t.Fatalf("expected unsupported applier failure, got %+v", result)
	}
	if containsDestructiveClear(targetDB.execLog) {
		t.Fatalf("target was cleared before applier capability check: %v", targetDB.execLog)
	}
}

func TestRunSyncFallbackFullOverwriteAllowsEmptySourceToClearWithoutApplier(t *testing.T) {
	columns := []connection.ColumnDefinition{{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"}}
	sourceDB := &staticRowsSyncSourceDB{
		fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"source_db.users": columns}},
	}
	targetDB := &recordingNonBatchSyncTargetDB{fakeMigrationDB: fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"target_db.users": columns},
	}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "oracle", Database: "source_db"},
		TargetConfig:   connection.ConnectionConfig{Type: "mysql", Database: "target_db"},
		SourceDatabase: "source_db",
		TargetDatabase: "target_db",
		Tables:         []string{"users"},
		Content:        "data",
		Mode:           "full_overwrite",
	})

	if !result.Success || result.TablesSynced != 1 {
		t.Fatalf("expected empty-source full overwrite to clear successfully without an applier: %+v", result)
	}
	if !containsDestructiveClear(targetDB.execLog) {
		t.Fatalf("expected target clear for empty source, exec=%v", targetDB.execLog)
	}
}

func TestRunSyncSourceQueryFallbackChecksApplierBeforeClear(t *testing.T) {
	columns := []connection.ColumnDefinition{{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"}}
	sourceDB := &staticRowsSyncSourceDB{rows: []map[string]interface{}{{"id": 1}}}
	targetDB := &recordingNonBatchSyncTargetDB{fakeMigrationDB: fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"target_db.users": columns},
	}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "oracle", Database: "source_db"},
		TargetConfig:   connection.ConnectionConfig{Type: "mysql", Database: "target_db"},
		TargetDatabase: "target_db",
		Tables:         []string{"users"},
		SourceQuery:    "SELECT id FROM source_users",
		Mode:           "full_overwrite",
	})

	if result.Success || !strings.Contains(result.Message, "ApplyChanges") {
		t.Fatalf("expected source-query unsupported applier failure, got %+v", result)
	}
	if containsDestructiveClear(targetDB.execLog) {
		t.Fatalf("source-query fallback cleared before applier capability check: %v", targetDB.execLog)
	}
}

func TestRunSyncInsertUpdateNoOpStillCompletesCreatedStructureAndIndexes(t *testing.T) {
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "email", Type: "varchar(255)", Nullable: "YES"},
	}
	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"source_db.users": columns},
		indexes: map[string][]connection.IndexDefinition{"source_db.users": {
			{Name: "idx_users_email", ColumnName: "email", NonUnique: 1, SeqInIndex: 1, IndexType: "BTREE"},
		}},
	}
	targetDB := &recordingNonBatchSyncTargetDB{}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "mysql", Database: "source_db"},
		TargetConfig:        connection.ConnectionConfig{Type: "mysql", Database: "target_db"},
		SourceDatabase:      "source_db",
		TargetDatabase:      "target_db",
		Tables:              []string{"users"},
		Content:             "both",
		Mode:                "insert_update",
		TargetTableStrategy: "auto_create_if_missing",
		CreateIndexes:       true,
		TableOptions: map[string]TableOptions{
			"users": {},
		},
	})

	if !result.Success || result.TablesSynced != 1 {
		t.Fatalf("expected structure-only work in insert_update no-op to succeed: %+v", result)
	}
	executed := strings.Join(targetDB.execLog, "\n")
	if !strings.Contains(executed, "CREATE TABLE") || !strings.Contains(executed, "CREATE INDEX") {
		t.Fatalf("expected table and post-data index creation, exec=%v", targetDB.execLog)
	}
}

func TestRunSyncSourceQueryInsertUpdateWithoutOperationsIsSuccessfulNoOp(t *testing.T) {
	sourceDB := &fakeMigrationDB{}
	targetDB := &recordingNonBatchSyncTargetDB{}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "source_db"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "target_db"},
		Tables:       []string{"users"},
		SourceQuery:  "SELECT id FROM source_users",
		Mode:         "insert_update",
		TableOptions: map[string]TableOptions{"users": {}},
	})

	if !result.Success || result.TablesSynced != 1 {
		t.Fatalf("expected source-query insert_update no-op to succeed: %+v", result)
	}
	if len(sourceDB.queryLog) != 0 || len(targetDB.execLog) != 0 {
		t.Fatalf("no-op must not read or write data, sourceQueries=%v targetExec=%v", sourceDB.queryLog, targetDB.execLog)
	}
}
