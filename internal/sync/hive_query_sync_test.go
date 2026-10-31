package sync

import (
	"context"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

func TestHiveSourceQueryStreamsWithoutPrimaryKeyOrOffset(t *testing.T) {
	fields := []connection.ColumnDefinition{{Name: "created", Type: "timestamp"}, {Name: "payload", Type: "map<string,array<decimal(38,18)>>"}}
	stamp := time.Date(2026, 10, 25, 1, 2, 3, 123456789, time.UTC)
	rows := []map[string]interface{}{{"created": stamp, "payload": "{\"key\":[\"1.123456789012345678\"]}"}, {"created": stamp, "payload": "{}"}}
	source, target := newHiveSyncTestDB("src", fields, rows), newHiveSyncTestDB("dst", fields, nil)
	config := hiveTestConfig("insert_only")
	config.SourceQuery = "SELECT created, payload FROM events WHERE flag = 1"
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
	if !result.Success || result.RowsInserted != 2 {
		t.Fatalf("query copy = %+v", result)
	}
	if len(source.streamQueries) != 1 || source.streamQueries[0] != config.SourceQuery {
		t.Fatalf("query rewritten/paged: %v", source.streamQueries)
	}
	if target.applied[0].Inserts[0]["created"] != stamp {
		t.Fatal("nanosecond timestamp was changed")
	}
}

func TestHiveSourceQueryRejectsLossyCrossFamilyBeforeOverwrite(t *testing.T) {
	for _, inputType := range []string{"array<int>", "map<string,string>", "struct<a:string>", "timestamp"} {
		t.Run(inputType, func(t *testing.T) {
			fields := []connection.ColumnDefinition{{Name: "value", Type: inputType}}
			source := newHiveSyncTestDB("src", fields, []map[string]interface{}{{"value": "[1]"}})
			target := newHiveSyncTestDB("dst", []connection.ColumnDefinition{{Name: "value", Type: "TEXT"}}, nil)
			config := hiveTestConfig("full_overwrite")
			config.TargetConfig.Type, config.SourceQuery = "postgres", "SELECT value FROM events"
			config.TargetSchema = "dst"
			useHiveSyncTestDBs(t, source, target)
			result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
			if result.Success {
				t.Fatalf("lossy query accepted: %+v", result)
			}
			assertHiveNoWrites(t, target)
		})
	}
}

func TestHiveSourceQueryExplicitStringCastCanCopyAcrossFamilies(t *testing.T) {
	fields := []connection.ColumnDefinition{{Name: "value", Type: "STRING"}}
	source := newHiveSyncTestDB("src", fields, []map[string]interface{}{{"value": "[1,2]"}})
	target := newHiveSyncTestDB("dst", []connection.ColumnDefinition{{Name: "value", Type: "TEXT"}}, nil)
	config := hiveTestConfig("insert_only")
	config.TargetConfig.Type, config.SourceQuery = "postgres", "SELECT CAST(value AS STRING) AS value FROM events"
	config.TargetSchema = "dst"
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
	if !result.Success || result.RowsInserted != 1 {
		t.Fatalf("explicit cast = %+v", result)
	}
}

func TestHiveSourceQueryRequiresExactTypesEvenForEmptyResult(t *testing.T) {
	fields := []connection.ColumnDefinition{{Name: "value", Type: "string"}}
	source, target := newHiveSyncTestDB("src", fields, nil), newHiveSyncTestDB("dst", fields, nil)
	source.missingTypes = true
	config := hiveTestConfig("full_overwrite")
	config.SourceQuery = "SELECT value FROM events"
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
	if result.Success || !strings.Contains(result.Message, "column types") {
		t.Fatalf("missing query metadata = %+v", result)
	}
	assertHiveNoWrites(t, target)
}

func TestHiveSourceQueryEmptyResultClearsOnlyAfterSuccessfulStream(t *testing.T) {
	fields := []connection.ColumnDefinition{{Name: "value", Type: "string"}}
	source, target := newHiveSyncTestDB("src", fields, nil), newHiveSyncTestDB("dst", fields, nil)
	config := hiveTestConfig("full_overwrite")
	config.SourceQuery = "SELECT value FROM events WHERE 1 = 0"
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
	if !result.Success || result.RowsInserted != 0 || len(target.executed) != 1 || len(target.applied) != 0 {
		t.Fatalf("empty overwrite = %+v exec=%v apply=%v", result, target.executed, target.applied)
	}
}

func TestHiveQueryRejectsFloatingDecimalBeforeClearing(t *testing.T) {
	source := newHiveSyncTestDB("src", []connection.ColumnDefinition{{Name: "value", Type: "decimal(20,4)"}}, []map[string]interface{}{{"value": 1.2345}})
	target := newHiveSyncTestDB("dst", []connection.ColumnDefinition{{Name: "value", Type: "decimal(20,4)"}}, nil)
	config := hiveTestConfig("full_overwrite")
	config.SourceConfig.Type, config.SourceQuery = "postgres", "SELECT value FROM events"
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
	if result.Success {
		t.Fatalf("floating decimal accepted: %+v", result)
	}
	assertHiveNoWrites(t, target)
}

func TestHiveAnalysisAndPreviewRejectOrdinaryUpdateMode(t *testing.T) {
	fields := []connection.ColumnDefinition{{Name: "id", Type: "bigint"}}
	config := hiveTestConfig("insert_update")
	config.Mappings = hiveLogicalKeyMapping()
	source, target := newHiveSyncTestDB("src", fields, nil), newHiveSyncTestDB("dst", fields, nil)
	useHiveSyncTestDBs(t, source, target)
	analysis := NewSyncEngine(Reporter{}).AnalyzeContext(context.Background(), config)
	if !analysis.Success || len(analysis.Tables) != 1 || analysis.Tables[0].CanSync {
		t.Fatalf("analysis promised unsupported mutations: %+v", analysis)
	}
	source, target = newHiveSyncTestDB("src", fields, nil), newHiveSyncTestDB("dst", fields, nil)
	useHiveSyncTestDBs(t, source, target)
	if _, err := NewSyncEngine(Reporter{}).PreviewContext(context.Background(), config, "events", 5); err == nil {
		t.Fatal("preview promised unsupported mutations")
	}
}
