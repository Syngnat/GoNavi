package sync

import (
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

type directImportIntegrityTargetDB struct {
	fakeQuerySyncTargetDB
	getColumnsErr error
	execErr       error
	execs         []string
}

func (d *directImportIntegrityTargetDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	if d.getColumnsErr != nil {
		return nil, d.getColumnsErr
	}
	return d.fakeQuerySyncTargetDB.GetColumns(dbName, tableName)
}

func (d *directImportIntegrityTargetDB) Exec(query string) (int64, error) {
	d.execs = append(d.execs, query)
	if d.execErr != nil {
		return 0, d.execErr
	}
	return 0, nil
}

func (d *directImportIntegrityTargetDB) clearedTarget() bool {
	for _, query := range d.execs {
		upper := strings.ToUpper(query)
		if strings.Contains(upper, "TRUNCATE TABLE") || strings.Contains(upper, "DELETE FROM") {
			return true
		}
	}
	return false
}

func TestDirectImportFullOverwriteValidatesTargetColumnsBeforeClearing(t *testing.T) {
	engine := &SyncEngine{}
	source := &fakeMigrationDB{}
	target := &directImportIntegrityTargetDB{getColumnsErr: errors.New("metadata unavailable")}
	config := SyncConfig{
		JobID:        "direct-import-columns",
		Mode:         "full_overwrite",
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Host: "source", Database: "src"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Host: "target", Database: "dst"},
	}
	plan := SchemaMigrationPlan{
		SourceQueryTable:  "src.users",
		TargetQueryTable:  "dst.users",
		TargetSchema:      "dst",
		TargetTable:       "users",
		TargetTableExists: true,
	}
	sourceCols := []connection.ColumnDefinition{{Name: "id", Type: "bigint", Key: "PRI"}}

	handled, inserted, err := engine.tryApplyDirectImportInPages(
		config, &SyncResult{}, 0, 1, "users", source, target, plan,
		sourceCols, nil, TableOptions{Insert: true}, "mysql", "mysql", "users",
	)
	if !handled {
		t.Fatal("direct import should handle the request")
	}
	if err == nil || !strings.Contains(err.Error(), "metadata unavailable") {
		t.Fatalf("expected target column metadata error, got %v", err)
	}
	if inserted != 0 {
		t.Fatalf("expected no inserted rows, got %d", inserted)
	}
	if target.clearedTarget() {
		t.Fatalf("target table was cleared before column validation: %v", target.execs)
	}
}

func TestDirectImportFullOverwriteStopsBeforeClearingWhenAutoAddColumnFails(t *testing.T) {
	engine := &SyncEngine{}
	source := &fakeMigrationDB{}
	target := &directImportIntegrityTargetDB{execErr: errors.New("add column rejected")}
	config := SyncConfig{
		JobID:          "direct-import-auto-add",
		Content:        "both",
		Mode:           "full_overwrite",
		AutoAddColumns: true,
		SourceConfig:   connection.ConnectionConfig{Type: "mysql", Host: "source", Database: "src"},
		TargetConfig:   connection.ConnectionConfig{Type: "mysql", Host: "target", Database: "dst"},
	}
	plan := SchemaMigrationPlan{
		SourceQueryTable:  "src.users",
		TargetQueryTable:  "dst.users",
		TargetSchema:      "dst",
		TargetTable:       "users",
		TargetTableExists: true,
	}
	sourceCols := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Key: "PRI"},
		{Name: "name", Type: "varchar(128)"},
	}
	targetCols := []connection.ColumnDefinition{{Name: "id", Type: "bigint", Key: "PRI"}}

	handled, inserted, err := engine.tryApplyDirectImportInPages(
		config, &SyncResult{}, 0, 1, "users", source, target, plan,
		sourceCols, targetCols, TableOptions{Insert: true}, "mysql", "mysql", "users",
	)
	if !handled {
		t.Fatal("direct import should handle the request")
	}
	if err == nil || !strings.Contains(err.Error(), "add column rejected") {
		t.Fatalf("expected auto-add column error, got %v", err)
	}
	if inserted != 0 {
		t.Fatalf("expected no inserted rows, got %d", inserted)
	}
	if len(target.appliedChanges.Inserts) != 0 {
		t.Fatalf("rows were applied after auto-add failure: %+v", target.appliedChanges.Inserts)
	}
	if target.clearedTarget() {
		t.Fatalf("target table was cleared after auto-add failure: %v", target.execs)
	}
}

func TestDirectImportDataOnlyRejectsAutoAddColumnsBeforeClearing(t *testing.T) {
	engine := &SyncEngine{}
	source := &fakeMigrationDB{}
	target := &directImportIntegrityTargetDB{}
	config := SyncConfig{
		JobID:          "direct-import-data-only",
		Content:        "data",
		Mode:           "full_overwrite",
		AutoAddColumns: true,
		SourceConfig:   connection.ConnectionConfig{Type: "mysql", Host: "source", Database: "src"},
		TargetConfig:   connection.ConnectionConfig{Type: "mysql", Host: "target", Database: "dst"},
	}
	plan := SchemaMigrationPlan{
		SourceQueryTable:  "src.users",
		TargetQueryTable:  "dst.users",
		TargetSchema:      "dst",
		TargetTable:       "users",
		TargetTableExists: true,
	}
	sourceCols := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Key: "PRI"},
		{Name: "name", Type: "varchar(128)"},
	}
	targetCols := []connection.ColumnDefinition{{Name: "id", Type: "bigint", Key: "PRI"}}

	handled, inserted, err := engine.tryApplyDirectImportInPages(
		config, &SyncResult{}, 0, 1, "users", source, target, plan,
		sourceCols, targetCols, TableOptions{Insert: true}, "mysql", "mysql", "users",
	)
	if !handled {
		t.Fatal("direct import should handle the request")
	}
	if err == nil || !strings.Contains(err.Error(), "仅同步数据") {
		t.Fatalf("expected data-only auto-add rejection, got %v", err)
	}
	if inserted != 0 || len(target.execs) != 0 || target.clearedTarget() {
		t.Fatalf("data-only direct import modified the target: inserted=%d exec=%v", inserted, target.execs)
	}
}

func TestDirectImportInsertOnlySamePhysicalTableSkipsPaging(t *testing.T) {
	config := SyncConfig{
		Mode: "insert_only",
		SourceConfig: connection.ConnectionConfig{
			Type: "mysql", Host: "db.internal", Port: 3306, Database: "app",
		},
		TargetConfig: connection.ConnectionConfig{
			Type: "mysql", Host: "db.internal", Port: 3306, Database: "app",
		},
	}
	plan := SchemaMigrationPlan{
		SourceQueryTable:  "app.events",
		TargetQueryTable:  "app.events",
		TargetTableExists: true,
	}

	handled, inserted, err := (&SyncEngine{}).tryApplyDirectImportInPages(
		config, &SyncResult{}, 0, 1, "events", nil, nil, plan,
		[]connection.ColumnDefinition{{Name: "id", Type: "bigint", Key: "PRI"}}, nil,
		TableOptions{Insert: true}, "mysql", "mysql", "events",
	)
	if err != nil || handled || inserted != 0 {
		t.Fatalf("self insert-only paging = handled %v inserted %d err %v, want false 0 nil", handled, inserted, err)
	}
}
