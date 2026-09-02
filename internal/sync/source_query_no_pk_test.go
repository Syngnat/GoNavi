package sync

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

const sourceQueryWithoutPKSQL = "SELECT event_name, created_at FROM audit_events"

func sourceQueryWithoutPKConfig(mode string) SyncConfig {
	return SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "source_db", Host: "source"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "target_db", Host: "target"},
		Tables:       []string{"logs"},
		SourceQuery:  sourceQueryWithoutPKSQL,
		Content:      "data",
		Mode:         mode,
		TableOptions: map[string]TableOptions{
			"logs": {Insert: true, Update: true},
		},
	}
}

func newSourceQueryWithoutPKSource() *fakeMigrationDB {
	return &fakeMigrationDB{queryData: map[string][]map[string]interface{}{
		sourceQueryWithoutPKSQL: {
			{"event_name": "started", "created_at": "2026-08-23 12:00:00"},
			{"event_name": "stopped", "created_at": "2026-08-23 12:01:00"},
		},
	}}
}

func newSourceQueryWithoutPKTarget() *fakeQuerySyncTargetDB {
	return &fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"target_db.logs": {
				{Name: "event_name", Type: "varchar(128)", Nullable: "NO"},
				{Name: "created_at", Type: "datetime", Nullable: "NO"},
			},
		},
	}}
}

func TestSourceQueryWithoutPrimaryKeyAllowsDirectImportAnalysisAndPreview(t *testing.T) {
	sourceDB := newSourceQueryWithoutPKSource()
	targetDB := newSourceQueryWithoutPKTarget()
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	analysis := NewSyncEngine(Reporter{}).Analyze(sourceQueryWithoutPKConfig("insert_only"))
	if !analysis.Success || len(analysis.Tables) != 1 || !analysis.Tables[0].CanSync || analysis.Tables[0].Inserts != 2 {
		t.Fatalf("Analyze() = %+v, want a runnable two-row import without a primary key", analysis)
	}

	sourceDB = newSourceQueryWithoutPKSource()
	targetDB = newSourceQueryWithoutPKTarget()
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)
	preview, err := NewSyncEngine(Reporter{}).Preview(sourceQueryWithoutPKConfig("full_overwrite"), "logs", 20)
	if err != nil {
		t.Fatalf("Preview() error = %v, want an import preview without a primary key", err)
	}
	if preview.RowSelectionSupported || preview.PKColumn != "" || preview.TotalInserts != 2 || len(preview.Inserts) != 2 {
		t.Fatalf("Preview() = %+v, want a non-selectable two-row import sample", preview)
	}
}

func TestRunSourceQueryWithoutPrimaryKeyUsesSnapshotImport(t *testing.T) {
	for _, mode := range []string{"insert_only", "full_overwrite"} {
		mode := mode
		t.Run(mode, func(t *testing.T) {
			sourceDB := newSourceQueryWithoutPKSource()
			targetDB := newSourceQueryWithoutPKTarget()
			config := sourceQueryWithoutPKConfig(mode)
			config.BatchSize = 1
			useSyncDatabaseFactorySequence(t,
				syncDatabaseFactoryStep{db: sourceDB},
				syncDatabaseFactoryStep{db: targetDB},
			)

			result := NewSyncEngine(Reporter{}).RunSync(config)
			if !result.Success || result.RowsInserted != 2 || len(targetDB.appliedChanges.Inserts) != 2 {
				t.Fatalf("RunSync() = %+v, want a full two-row import without a primary key", result)
			}
			for _, query := range sourceDB.queryLog {
				if strings.Contains(strings.ToUpper(query), " OFFSET ") || strings.Contains(strings.ToUpper(query), " LIMIT ") {
					t.Fatalf("no-key query import must not use unordered paging, query=%q", query)
				}
			}
		})
	}
}

func TestSourceQueryWithoutPrimaryKeyRejectsOnlyUpdateAndRowSelection(t *testing.T) {
	sourceDB := newSourceQueryWithoutPKSource()
	targetDB := newSourceQueryWithoutPKTarget()
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)
	analysis := NewSyncEngine(Reporter{}).Analyze(sourceQueryWithoutPKConfig("insert_update"))
	if !analysis.Success || len(analysis.Tables) != 1 || analysis.Tables[0].CanSync {
		t.Fatalf("Analyze() = %+v, want insert_update preflight rejection", analysis)
	}

	sourceDB = newSourceQueryWithoutPKSource()
	targetDB = newSourceQueryWithoutPKTarget()
	config := sourceQueryWithoutPKConfig("insert_only")
	config.TableOptions["logs"] = TableOptions{Insert: true, SelectedInsertPKs: []string{"started"}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)
	result := NewSyncEngine(Reporter{}).RunSync(config)
	if result.Success || !strings.Contains(result.Message, "不能按指定行同步") {
		t.Fatalf("RunSync() = %+v, want a no-key row-selection rejection", result)
	}
	if len(targetDB.appliedChanges.Inserts) != 0 {
		t.Fatalf("row-selection rejection wrote rows: %+v", targetDB.appliedChanges)
	}
}

func TestSourceQueryExplicitMappingKeySupportsInsertUpdateWithoutTargetPrimaryKey(t *testing.T) {
	config := sourceQueryWithoutPKConfig("insert_update")
	config.Mappings = []SyncObjectMapping{{
		Source:     SyncObjectRef{Name: "logs"},
		Target:     SyncObjectRef{Name: "logs"},
		KeyColumns: []string{"event_name"},
		Columns: []SyncColumnMapping{
			{Source: "event_name", Target: "event_name"},
			{Source: "created_at", Target: "created_at"},
		},
	}}

	sourceDB := newSourceQueryWithoutPKSource()
	targetDB := newSourceQueryWithoutPKTarget()
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)
	analysis := NewSyncEngine(Reporter{}).Analyze(config)
	if !analysis.Success || len(analysis.Tables) != 1 || !analysis.Tables[0].CanSync || analysis.Tables[0].PKColumn != "event_name" || analysis.Tables[0].Inserts != 2 {
		t.Fatalf("Analyze() = %+v, want an explicit-key insert_update plan", analysis)
	}

	sourceDB = newSourceQueryWithoutPKSource()
	targetDB = newSourceQueryWithoutPKTarget()
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)
	preview, err := NewSyncEngine(Reporter{}).Preview(config, "logs", 20)
	if err != nil {
		t.Fatalf("Preview() error = %v, want an explicit-key insert_update preview", err)
	}
	if !preview.RowSelectionSupported || preview.PKColumn != "event_name" || preview.TotalInserts != 2 || len(preview.Inserts) != 2 {
		t.Fatalf("Preview() = %+v, want selectable rows keyed by event_name", preview)
	}

	sourceDB = newSourceQueryWithoutPKSource()
	targetDB = newSourceQueryWithoutPKTarget()
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
	if !result.Success || result.RowsInserted != 1 || len(targetDB.appliedChanges.Inserts) != 1 {
		t.Fatalf("RunSync() = %+v, want the selected explicit-key row inserted", result)
	}
	if targetDB.appliedChanges.Inserts[0]["event_name"] != "started" {
		t.Fatalf("inserted rows = %+v, want only event_name=started", targetDB.appliedChanges.Inserts)
	}
}
