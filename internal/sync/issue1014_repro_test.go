package sync

import (
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// 复现 issue #1014：MySQL→MySQL 同名表、跨库、目标缺列且已有数据行。
// 期望：结构阶段 ALTER 补列后，数据阶段按主键 UPDATE 回填新列的值，
// 而不是留下 NULL。
type reproSourceDB struct {
	fakeMigrationDB
}

func (f *reproSourceDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if strings.Contains(query, "`source_db`.`test`") {
		return []map[string]interface{}{
			{"id": int64(1), "new_column": "test"},
		}, []string{"id", "new_column"}, nil
	}
	return f.fakeMigrationDB.Query(query)
}

type reproTargetDB struct {
	fakeQuerySyncTargetDB
	execLog      []string
	addedColumns []connection.ColumnDefinition
}

func (f *reproTargetDB) targetRows() ([]map[string]interface{}, []string) {
	rows := []map[string]interface{}{{"id": int64(1)}}
	names := []string{"id"}
	for _, col := range f.addedColumns {
		for _, row := range rows {
			row[col.Name] = nil
		}
		names = append(names, col.Name)
	}
	return rows, names
}

func (f *reproTargetDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if strings.Contains(query, "`target_db`.`test`") {
		rows, names := f.targetRows()
		return rows, names, nil
	}
	return f.fakeMigrationDB.Query(query)
}

func (f *reproTargetDB) Exec(query string) (int64, error) {
	f.execLog = append(f.execLog, query)
	if strings.Contains(query, "ADD COLUMN") && strings.Contains(query, "new_column") {
		f.addedColumns = append(f.addedColumns, connection.ColumnDefinition{
			Name: "new_column", Type: "varchar(255)", Nullable: "YES",
		})
	}
	return 0, nil
}

func TestRunSyncIssue1014AddsColumnAndBackfillsExistingRow(t *testing.T) {
	sourceDB := &reproSourceDB{fakeMigrationDB: fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"source_db.test": {
			{Name: "id", Type: "int(11)", Nullable: "NO", Key: "PRI", Extra: "auto_increment"},
			{Name: "new_column", Type: "varchar(255)", Nullable: "YES", Charset: "utf8mb4", Collation: "utf8mb4_unicode_ci"},
		}},
	}}
	targetDB := &reproTargetDB{fakeQuerySyncTargetDB: fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"target_db.test": {
			{Name: "id", Type: "int(11)", Nullable: "NO", Key: "PRI", Extra: "auto_increment"},
		}},
	}}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "mysql", Database: "source_db", Host: "127.0.0.1"},
		TargetConfig:        connection.ConnectionConfig{Type: "mysql", Database: "target_db", Host: "127.0.0.1"},
		SourceDatabase:      "source_db",
		TargetDatabase:      "target_db",
		Tables:              []string{"test"},
		Content:             "both",
		Mode:                "insert_update",
		AutoAddColumns:      true,
		TargetTableStrategy: "existing_only",
		BatchSize:           200,
		TableOptions: map[string]TableOptions{
			"test": {Insert: true, Update: true, Delete: false},
		},
	})

	if !result.Success || result.TablesSynced != 1 {
		t.Fatalf("expected sync to succeed: success=%v tables=%d message=%s", result.Success, result.TablesSynced, result.Message)
	}

	alterExecuted := false
	for _, sql := range targetDB.execLog {
		if strings.Contains(sql, "ALTER TABLE") && strings.Contains(sql, "new_column") {
			alterExecuted = true
		}
	}
	if !alterExecuted {
		t.Fatalf("expected ALTER TABLE ADD COLUMN new_column to execute, execLog=%v", targetDB.execLog)
	}

	if len(targetDB.appliedChanges.Updates) != 1 {
		t.Fatalf("expected existing row (id=1) to be UPDATED with new_column value, updates=%+v inserts=%+v",
			targetDB.appliedChanges.Updates, targetDB.appliedChanges.Inserts)
	}
	update := targetDB.appliedChanges.Updates[0]
	if got, ok := update.Values["new_column"]; !ok || got != "test" {
		t.Fatalf("expected update to backfill new_column='test', got values=%+v", update.Values)
	}
	if !reflect.DeepEqual(update.Keys, map[string]interface{}{"id": int64(1)}) {
		t.Fatalf("expected update keyed by id=1, got keys=%+v", update.Keys)
	}
}

func TestRunSyncIssue1014PKLessExistingTableFailsBeforeSchemaOrDataWrites(t *testing.T) {
	sourceDB := &reproSourceDB{fakeMigrationDB: fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"source_db.test": {
			{Name: "name", Type: "varchar(64)", Nullable: "NO"},
			{Name: "new_column", Type: "varchar(255)", Nullable: "YES"},
		}},
	}}
	targetDB := &reproTargetDB{fakeQuerySyncTargetDB: fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"target_db.test": {
			{Name: "name", Type: "varchar(64)", Nullable: "NO"},
		}},
	}}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "mysql", Database: "source_db", Host: "127.0.0.1"},
		TargetConfig:        connection.ConnectionConfig{Type: "mysql", Database: "target_db", Host: "127.0.0.1"},
		SourceDatabase:      "source_db",
		TargetDatabase:      "target_db",
		Tables:              []string{"test"},
		Content:             "both",
		Mode:                "insert_update",
		AutoAddColumns:      true,
		TargetTableStrategy: "existing_only",
		BatchSize:           200,
		TableOptions: map[string]TableOptions{
			"test": {Insert: true, Update: true, Delete: false},
		},
	})

	if result.Success || result.TablesSynced != 0 {
		t.Fatalf("expected PK-less insert_update to fail: success=%v message=%s", result.Success, result.Message)
	}
	if !strings.Contains(result.Message, "未找到主键") {
		t.Fatalf("expected actionable primary-key failure, got %q", result.Message)
	}
	if len(targetDB.execLog) != 0 {
		t.Fatalf("PK-less failure must not run schema DDL, execLog=%v", targetDB.execLog)
	}
	if len(targetDB.appliedChanges.Inserts) != 0 || len(targetDB.appliedChanges.Updates) != 0 || len(targetDB.appliedChanges.Deletes) != 0 {
		t.Fatalf("PK-less failure must not write rows: %+v", targetDB.appliedChanges)
	}
}
