package app

import (
	"encoding/json"
	"strings"
	"testing"

	syncbackend "GoNavi-Wails/internal/sync"
	"GoNavi-Wails/internal/syncjob"
)

func TestBuildEngineObjectMappingPreservesNumericDefaultPrecision(t *testing.T) {
	mapping, err := buildEngineObjectMapping(syncjob.TableMapping{
		SourceTable: "source_events",
		TargetTable: "target_events",
		Columns: []syncjob.ColumnMapping{{
			Target:       "event_id",
			DefaultValue: json.RawMessage(`9007199254740993`),
		}},
	})
	if err != nil {
		t.Fatalf("buildEngineObjectMapping returned error: %v", err)
	}
	if got := mapping.Columns[0].Default.Value; got != "9007199254740993" {
		t.Fatalf("numeric default = %q, want exact integer", got)
	}
}

func TestBuildEngineObjectMappingCarriesStableKeysWithoutColumnRemap(t *testing.T) {
	input := syncjob.TableMapping{
		SourceTable: "events",
		TargetTable: "events",
		KeyColumns:  []string{"tenant_id", "event_id"},
	}
	if !dataSyncJobMappingNeedsExplicitProjection(input) {
		t.Fatal("stable keys must force an explicit engine mapping")
	}
	mapping, err := buildEngineObjectMapping(input)
	if err != nil {
		t.Fatalf("buildEngineObjectMapping returned error: %v", err)
	}
	if got := strings.Join(mapping.KeyColumns, ","); got != "tenant_id,event_id" {
		t.Fatalf("engine key columns = %q", got)
	}
}

func TestDecodeDataSyncJobJSONRejectsTrailingValue(t *testing.T) {
	var decoded interface{}
	if err := decodeDataSyncJobJSON(json.RawMessage(`{"ok":true} false`), &decoded); err == nil {
		t.Fatal("expected trailing JSON value to be rejected")
	}
}

func TestBuildDataSyncJobEngineConfigRejectsIgnoredFilter(t *testing.T) {
	_, err := buildDataSyncJobEngineConfig(syncjob.JobDefinition{}, "run-1", resolvedDataSyncJobEndpoint{}, resolvedDataSyncJobEndpoint{}, syncjob.TableMapping{
		SourceTable: "events",
		TargetTable: "events_archive",
		Filter:      "tenant_id = 7",
	})
	if err == nil {
		t.Fatal("table filter must be rejected until it has an executable plan")
	}
}

func TestBuildDataSyncJobEngineConfigPropagatesDeletePolicy(t *testing.T) {
	config, err := buildDataSyncJobEngineConfig(syncjob.JobDefinition{
		Options: syncjob.ExecutionOptions{
			SyncMode:         "insert_update",
			PropagateDeletes: true,
			BatchSize:        321,
		},
	}, "run-1", resolvedDataSyncJobEndpoint{}, resolvedDataSyncJobEndpoint{}, syncjob.TableMapping{
		SourceTable: "events",
		TargetTable: "events",
	})
	if err != nil {
		t.Fatalf("buildDataSyncJobEngineConfig returned error: %v", err)
	}
	if !config.TableOptions["events"].Delete {
		t.Fatal("delete propagation was lost while compiling the engine config")
	}
	if config.BatchSize != 321 {
		t.Fatalf("engine batch size = %d, want 321", config.BatchSize)
	}
}

func TestDataSyncJobMappingRetrySafetyRejectsInsertOnly(t *testing.T) {
	if dataSyncJobMappingRetrySafe(syncjob.JobDefinition{Options: syncjob.ExecutionOptions{SyncMode: "insert_only"}}) {
		t.Fatal("insert-only mapping retries can duplicate partially committed batches")
	}
	if !dataSyncJobMappingRetrySafe(syncjob.JobDefinition{Options: syncjob.ExecutionOptions{SyncMode: "insert_update"}}) {
		t.Fatal("idempotent insert-update mappings should remain retryable")
	}
}

func TestDecodeDataSyncWatermarkStateRejectsStaleRevision(t *testing.T) {
	definition := syncjob.JobDefinition{Revision: 4}
	state, _, err := decodeDataSyncWatermarkState(&syncjob.Checkpoint{
		DefinitionRevision: 3,
		Kind:               "watermark",
		CursorType:         "watermark_map",
		Cursor:             json.RawMessage(`{"version":1,"mappings":{}}`),
		SchemaHash:         "hash",
	}, definition, "hash")
	if err != nil || state.Version != dataSyncWatermarkStateVersion {
		t.Fatalf("metadata-only revision should preserve checkpoint, state=%#v err=%v", state, err)
	}
}

func TestDecodeDataSyncWatermarkStatePreservesTypedCursor(t *testing.T) {
	definition := syncjob.JobDefinition{Revision: 2}
	wantCursor := syncbackend.WatermarkCursor{
		Version:           syncbackend.WatermarkCursorVersion,
		SourceTable:       "orders",
		WatermarkColumn:   "updated_at",
		TieBreakerColumns: []string{"id"},
		Watermark:         syncbackend.WatermarkCursorValue{Type: "timestamp", Value: "2026-08-08T00:00:00Z"},
		TieBreakers:       []syncbackend.WatermarkCursorValue{{Type: "int64", Value: "9007199254740993"}},
	}
	payload, err := json.Marshal(dataSyncWatermarkState{
		Version:  dataSyncWatermarkStateVersion,
		Mappings: map[string]syncbackend.WatermarkCursor{"orders -> archive": wantCursor},
	})
	if err != nil {
		t.Fatalf("marshal state: %v", err)
	}
	state, sequence, err := decodeDataSyncWatermarkState(&syncjob.Checkpoint{
		DefinitionRevision: definition.Revision,
		Kind:               "watermark",
		CursorType:         "watermark_map",
		Cursor:             payload,
		BatchSequence:      17,
		SchemaHash:         "plan-hash",
	}, definition, "plan-hash")
	if err != nil {
		t.Fatalf("decode state: %v", err)
	}
	got := state.Mappings["orders -> archive"]
	if sequence != 17 || got.TieBreakers[0].Value != "9007199254740993" || got.Watermark != wantCursor.Watermark {
		t.Fatalf("decoded state = %#v, sequence=%d", got, sequence)
	}
}
