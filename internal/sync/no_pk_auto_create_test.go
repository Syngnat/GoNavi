package sync

import (
	"context"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

type noPKAutoCreateSourceDB struct {
	fakeMigrationDB
	rows     []map[string]interface{}
	queryLog []string
}

func (d *noPKAutoCreateSourceDB) Query(query string) ([]map[string]interface{}, []string, error) {
	d.queryLog = append(d.queryLog, query)
	return d.rows, []string{"event_name", "created_at"}, nil
}

func (d *noPKAutoCreateSourceDB) QueryContext(_ context.Context, query string) ([]map[string]interface{}, []string, error) {
	return d.Query(query)
}

type noPKAutoCreateTargetDB struct {
	fakeQuerySyncTargetDB
	execLog        []string
	createdColumns []connection.ColumnDefinition
}

func (d *noPKAutoCreateTargetDB) GetColumns(_, _ string) ([]connection.ColumnDefinition, error) {
	return append([]connection.ColumnDefinition(nil), d.createdColumns...), nil
}

func (d *noPKAutoCreateTargetDB) Exec(query string) (int64, error) {
	d.execLog = append(d.execLog, query)
	if strings.Contains(query, "CREATE TABLE") {
		d.createdColumns = []connection.ColumnDefinition{
			{Name: "event_name", Type: "varchar(128)", Nullable: "NO"},
			{Name: "created_at", Type: "datetime", Nullable: "NO"},
		}
	}
	return 0, nil
}

func (d *noPKAutoCreateTargetDB) ExecContext(_ context.Context, query string) (int64, error) {
	return d.Exec(query)
}

func noPKAutoCreateConfig() SyncConfig {
	return SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "mysql", Database: "source_db", Host: "source"},
		TargetConfig:        connection.ConnectionConfig{Type: "mysql", Database: "target_db", Host: "target"},
		SourceDatabase:      "source_db",
		TargetDatabase:      "target_db",
		Tables:              []string{"logs"},
		Content:             "both",
		Mode:                "insert_update",
		TargetTableStrategy: "auto_create_if_missing",
		TableOptions: map[string]TableOptions{
			"logs": {Insert: true, Update: true},
		},
	}
}

func newNoPKAutoCreateSource() *noPKAutoCreateSourceDB {
	return &noPKAutoCreateSourceDB{
		fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{
			"source_db.logs": {
				{Name: "event_name", Type: "varchar(128)", Nullable: "NO"},
				{Name: "created_at", Type: "datetime", Nullable: "NO"},
			},
		}},
		rows: []map[string]interface{}{{"event_name": "started", "created_at": "2026-08-23 12:00:00"}},
	}
}

func TestAnalyzeAllowsNoPrimaryKeyWhenTargetWillBeCreated(t *testing.T) {
	sourceDB := newNoPKAutoCreateSource()
	targetDB := &noPKAutoCreateTargetDB{}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).Analyze(noPKAutoCreateConfig())
	if !result.Success || len(result.Tables) != 1 || !result.Tables[0].CanSync {
		t.Fatalf("Analyze() = %+v, want a runnable auto-create plan without a primary key", result)
	}
	if result.Tables[0].TargetTableExists {
		t.Fatalf("Analyze() = %+v, want a missing target table", result.Tables[0])
	}
}

func TestPreviewAllowsNoPrimaryKeyWhenTargetWillBeCreated(t *testing.T) {
	sourceDB := newNoPKAutoCreateSource()
	targetDB := &noPKAutoCreateTargetDB{}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	preview, err := NewSyncEngine(Reporter{}).Preview(noPKAutoCreateConfig(), "logs", 20)
	if err != nil {
		t.Fatalf("Preview() error = %v, want an auto-create preview without a primary key", err)
	}
	if preview.PKColumn != "" || preview.RowSelectionSupported {
		t.Fatalf("Preview() key metadata = pk=%q selectable=%t, want no synthetic stable key", preview.PKColumn, preview.RowSelectionSupported)
	}
	if preview.TotalInserts != 1 || len(preview.Inserts) != 1 || preview.Inserts[0].Row["event_name"] != "started" {
		t.Fatalf("Preview() = %+v, want one insert sample", preview)
	}
}

func TestExistingTargetInsertUpdateWithoutKeyIsRejected(t *testing.T) {
	sourceDB := newNoPKAutoCreateSource()
	targetDB := &fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"target_db.logs": {
				{Name: "event_name", Type: "varchar(128)", Nullable: "NO"},
				{Name: "created_at", Type: "datetime", Nullable: "NO"},
			},
		},
	}}
	config := noPKAutoCreateConfig()
	config.TargetTableStrategy = "existing_only"
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	analysis := NewSyncEngine(Reporter{}).Analyze(config)
	if !analysis.Success || len(analysis.Tables) != 1 || analysis.Tables[0].CanSync {
		t.Fatalf("Analyze() = %+v, want existing-target insert_update preflight rejection", analysis)
	}
	if !strings.Contains(analysis.Tables[0].Message, "主键") && !strings.Contains(analysis.Tables[0].Message, "稳定 key") {
		t.Fatalf("Analyze() rejection = %q, want a key requirement", analysis.Tables[0].Message)
	}

	sourceDB = newNoPKAutoCreateSource()
	targetDB = &fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"target_db.logs": {
				{Name: "event_name", Type: "varchar(128)", Nullable: "NO"},
				{Name: "created_at", Type: "datetime", Nullable: "NO"},
			},
		},
	}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(config)
	if result.Success || result.RowsInserted != 0 || len(targetDB.appliedChanges.Inserts) != 0 {
		t.Fatalf("RunSync() = %+v, want rejection before any write", result)
	}
}

func TestAutoCreateWithoutKeyRejectsRequestedRowSelection(t *testing.T) {
	sourceDB := newNoPKAutoCreateSource()
	targetDB := &noPKAutoCreateTargetDB{}
	config := noPKAutoCreateConfig()
	config.TableOptions["logs"] = TableOptions{
		Insert:            true,
		Update:            true,
		SelectedInsertPKs: []string{"started"},
	}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(config)
	if result.Success || !strings.Contains(result.Message, "不能按指定行同步") {
		t.Fatalf("RunSync() = %+v, want a stable-key selection rejection", result)
	}
	if len(targetDB.execLog) != 0 {
		t.Fatalf("RunSync() must reject before schema changes, got SQL %v", targetDB.execLog)
	}
	if len(targetDB.appliedChanges.Inserts) != 0 {
		t.Fatalf("RunSync() wrote rows despite rejected selection: %+v", targetDB.appliedChanges)
	}
}

func TestRunSyncAutoCreatesAndImportsTableWithoutPrimaryKey(t *testing.T) {
	sourceDB := newNoPKAutoCreateSource()
	targetDB := &noPKAutoCreateTargetDB{}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(noPKAutoCreateConfig())
	if !result.Success || result.TablesSynced != 1 || result.RowsInserted != 1 {
		t.Fatalf("RunSync() = %+v, want a created table with one imported row", result)
	}
	if len(targetDB.execLog) != 1 || !strings.Contains(targetDB.execLog[0], "CREATE TABLE") {
		t.Fatalf("expected CREATE TABLE to execute, got %v", targetDB.execLog)
	}
	if len(targetDB.appliedChanges.Inserts) != 1 {
		t.Fatalf("expected one imported row, got %+v", targetDB.appliedChanges)
	}
}

func TestRunSyncAutoCreateWithoutPrimaryKeyDoesNotUseUnorderedOffsetPaging(t *testing.T) {
	sourceDB := newNoPKAutoCreateSource()
	sourceDB.rows = append(sourceDB.rows,
		map[string]interface{}{"event_name": "stopped", "created_at": "2026-08-23 12:01:00"},
	)
	targetDB := &noPKAutoCreateTargetDB{}
	config := noPKAutoCreateConfig()
	config.BatchSize = 1
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(config)
	if !result.Success || result.RowsInserted != 2 {
		t.Fatalf("RunSync() = %+v, want two rows imported without a primary key", result)
	}
	if len(targetDB.appliedChanges.Inserts) != 2 {
		t.Fatalf("expected two inserted rows, got %+v", targetDB.appliedChanges)
	}
	for _, query := range sourceDB.queryLog {
		if strings.Contains(strings.ToUpper(query), "LIMIT") || strings.Contains(strings.ToUpper(query), "OFFSET") {
			t.Fatalf("no-primary-key import must not use unordered OFFSET paging, query=%q", query)
		}
	}
}

func TestExplicitMappingKeySupportsInsertPreviewAndRowSelection(t *testing.T) {
	sourceDB := newNoPKAutoCreateSource()
	sourceDB.rows = append(sourceDB.rows,
		map[string]interface{}{"event_name": "stopped", "created_at": "2026-08-23 12:01:00"},
	)
	config := noPKAutoCreateConfig()
	config.Content = "data"
	config.Mode = "insert_only"
	config.TargetTableStrategy = "existing_only"
	config.Mappings = []SyncObjectMapping{{
		Source:     SyncObjectRef{Name: "logs"},
		Target:     SyncObjectRef{Name: "logs"},
		KeyColumns: []string{"event_name"},
		Columns: []SyncColumnMapping{
			{Source: "event_name", Target: "event_name"},
			{Source: "created_at", Target: "created_at"},
		},
	}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: &noPKAutoCreateTargetDB{createdColumns: []connection.ColumnDefinition{
			{Name: "event_name", Type: "varchar(128)", Nullable: "NO"},
			{Name: "created_at", Type: "datetime", Nullable: "NO"},
		}}},
	)

	preview, err := NewSyncEngine(Reporter{}).Preview(config, "logs", 20)
	if err != nil {
		t.Fatalf("Preview() error = %v", err)
	}
	if !preview.RowSelectionSupported || preview.PKColumn != "event_name" || len(preview.Inserts) != 2 || preview.Inserts[0].PK != "started" {
		t.Fatalf("Preview() = %+v, want mapping key metadata and selectable insert rows", preview)
	}

	sourceDB = newNoPKAutoCreateSource()
	sourceDB.rows = append(sourceDB.rows,
		map[string]interface{}{"event_name": "stopped", "created_at": "2026-08-23 12:01:00"},
	)
	targetDB := &noPKAutoCreateTargetDB{createdColumns: []connection.ColumnDefinition{
		{Name: "event_name", Type: "varchar(128)", Nullable: "NO"},
		{Name: "created_at", Type: "datetime", Nullable: "NO"},
	}}
	config.TableOptions["logs"] = TableOptions{
		Insert:            true,
		SelectedInsertPKs: []string{"started"},
	}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(config)
	if !result.Success || result.RowsInserted != 1 || len(targetDB.appliedChanges.Inserts) != 1 {
		t.Fatalf("RunSync() = %+v, want only the selected mapped row inserted", result)
	}
	if got := targetDB.appliedChanges.Inserts[0]["event_name"]; got != "started" {
		t.Fatalf("selected row = %#v, want event_name=started", targetDB.appliedChanges.Inserts[0])
	}
}
