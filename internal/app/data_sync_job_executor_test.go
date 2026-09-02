package app

import (
	"encoding/json"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
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
	if !dataSyncJobMappingNeedsExplicitProjection(syncjob.JobDefinition{Kind: syncjob.JobKindReconcile}, input) {
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

func boolPtr(value bool) *bool { return &value }

// 旧存储记录里 autoAddColumns 因 omitempty 缺失；运行路径必须按
// migration+both 兜底为开启，而不是要求用户先重新保存（issue #1014）。
func TestBuildDataSyncJobEngineConfigDefaultsLegacyMigrationAutoAddColumns(t *testing.T) {
	raw := []byte(`{
		"id": "sync-job-legacy",
		"name": "一次性迁移",
		"kind": "migration",
		"lifecycle": "ready",
		"sourceMode": "tables",
		"source": {"connectionId": "src"},
		"target": {"connectionId": "dst"},
		"mappings": [{"enabled": true, "sourceTable": "test", "targetTable": "test"}],
		"options": {"content": "both", "syncMode": "insert_update", "targetTableStrategy": "smart"}
	}`)
	var definition syncjob.JobDefinition
	if err := json.Unmarshal(raw, &definition); err != nil {
		t.Fatalf("unmarshal legacy definition: %v", err)
	}
	if definition.Options.AutoAddColumns != nil {
		t.Fatal("legacy definition must retain a missing autoAddColumns field")
	}

	config, err := buildDataSyncJobEngineConfig(definition, "run-legacy",
		resolvedDataSyncJobEndpoint{Database: "ecom_test_0705"},
		resolvedDataSyncJobEndpoint{Database: "ecom_dev_0705"},
		definition.Mappings[0])
	if err != nil {
		t.Fatalf("buildDataSyncJobEngineConfig returned error: %v", err)
	}
	if !config.AutoAddColumns {
		t.Fatalf("legacy migration must run with AutoAddColumns enabled without a re-save")
	}
	if len(config.Mappings) != 0 {
		t.Fatalf("structure migration with detected key columns must stay implicit, got %#v", config.Mappings)
	}
}

func TestDataSyncJobMappingProjectionRespectsTaskKindAndContent(t *testing.T) {
	tests := []struct {
		name       string
		definition syncjob.JobDefinition
		mapping    syncjob.TableMapping
		want       bool
	}{
		{
			name: "identity across schemas uses migration planner",
			definition: syncjob.JobDefinition{
				Kind:    syncjob.JobKindMigration,
				Options: syncjob.ExecutionOptions{Content: "schema"},
			},
			mapping: syncjob.TableMapping{
				SourceSchema: "source_schema",
				SourceTable:  "orders",
				TargetSchema: "target_schema",
				TargetTable:  "orders",
			},
			want: false,
		},
		{
			name:       "ordinary reconcile across schemas remains explicit",
			definition: syncjob.JobDefinition{Kind: syncjob.JobKindReconcile},
			mapping: syncjob.TableMapping{
				SourceSchema: "source_schema",
				SourceTable:  "orders",
				TargetSchema: "target_schema",
				TargetTable:  "orders",
			},
			want: true,
		},
		{
			name: "data-only migration across schemas remains explicit",
			definition: syncjob.JobDefinition{
				Kind:    syncjob.JobKindMigration,
				Options: syncjob.ExecutionOptions{Content: "data"},
			},
			mapping: syncjob.TableMapping{
				SourceSchema: "source_schema",
				SourceTable:  "orders",
				TargetSchema: "target_schema",
				TargetTable:  "orders",
			},
			want: true,
		},
		{
			name: "both-content migration uses migration planner",
			definition: syncjob.JobDefinition{
				Kind:    syncjob.JobKindMigration,
				Options: syncjob.ExecutionOptions{Content: "both"},
			},
			mapping: syncjob.TableMapping{
				SourceSchema: "source_schema",
				SourceTable:  "orders",
				TargetSchema: "target_schema",
				TargetTable:  "orders",
			},
			want: false,
		},
		{
			name:       "different table names remain explicit",
			definition: syncjob.JobDefinition{Kind: syncjob.JobKindMigration, Options: syncjob.ExecutionOptions{Content: "schema"}},
			mapping: syncjob.TableMapping{
				SourceTable: "orders",
				TargetTable: "orders_archive",
			},
			want: true,
		},
		{
			// issue #1014：UI 会把检测到的物理主键自动写入识别列；
			// 结构型迁移的隐式路径同样按物理主键匹配，识别列不再触发降级。
			name: "auto-detected key columns keep structure migration implicit",
			definition: syncjob.JobDefinition{
				Kind:    syncjob.JobKindMigration,
				Options: syncjob.ExecutionOptions{Content: "both"},
			},
			mapping: syncjob.TableMapping{
				SourceSchema: "source_schema",
				SourceTable:  "orders",
				TargetSchema: "target_schema",
				TargetTable:  "orders",
				KeyColumns:   []string{"id"},
			},
			want: false,
		},
		{
			name: "keys remain explicit for non-migration kinds",
			definition: syncjob.JobDefinition{
				Kind:    syncjob.JobKindReconcile,
				Options: syncjob.ExecutionOptions{Content: "data"},
			},
			mapping: syncjob.TableMapping{
				SourceTable: "orders",
				TargetTable: "orders",
				KeyColumns:  []string{"id"},
			},
			want: true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := dataSyncJobMappingNeedsExplicitProjection(test.definition, test.mapping); got != test.want {
				t.Fatalf("explicit projection = %v, want %v", got, test.want)
			}
		})
	}
}

func TestBuildDataSyncJobEngineConfigKeepsSchemaMigrationPlannerForCrossSchemaIdentity(t *testing.T) {
	config, err := buildDataSyncJobEngineConfig(syncjob.JobDefinition{
		Kind: syncjob.JobKindMigration,
		Options: syncjob.ExecutionOptions{
			Content:        "schema",
			SyncMode:       "insert_update",
			AutoAddColumns: boolPtr(true),
		},
	}, "run-schema", resolvedDataSyncJobEndpoint{Database: "source_db"}, resolvedDataSyncJobEndpoint{Database: "target_db", Schema: "target_schema"}, syncjob.TableMapping{
		SourceSchema: "source_schema",
		SourceTable:  "orders",
		TargetSchema: "target_schema",
		TargetTable:  "orders",
	})
	if err != nil {
		t.Fatalf("buildDataSyncJobEngineConfig returned error: %v", err)
	}
	if len(config.Mappings) != 0 {
		t.Fatalf("identity schema migration unexpectedly compiled an explicit mapping: %#v", config.Mappings)
	}
	if config.Content != "schema" || !config.AutoAddColumns {
		t.Fatalf("schema migration config lost content/options: content=%q autoAddColumns=%v", config.Content, config.AutoAddColumns)
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

func TestBuildDataSyncJobEngineConfigDefaultsEmptySyncModeToInsertUpdate(t *testing.T) {
	tests := []struct {
		name       string
		definition syncjob.JobDefinition
		mapping    syncjob.TableMapping
		optionKey  string
	}{
		{
			name: "table mapping",
			mapping: syncjob.TableMapping{
				SourceTable: "events",
				TargetTable: "events_archive",
			},
			optionKey: "events",
		},
		{
			name: "query sink mapping",
			definition: syncjob.JobDefinition{
				Kind:        syncjob.JobKindQuerySink,
				SourceQuery: "SELECT id FROM events",
			},
			mapping: syncjob.TableMapping{
				SourceTable: "__query_result__",
				TargetTable: "events_archive",
			},
			optionKey: "__query_result__",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			config, err := buildDataSyncJobEngineConfig(test.definition, "run-empty-mode", resolvedDataSyncJobEndpoint{}, resolvedDataSyncJobEndpoint{}, test.mapping)
			if err != nil {
				t.Fatalf("buildDataSyncJobEngineConfig returned error: %v", err)
			}
			if config.Mode != "insert_update" {
				t.Fatalf("mode = %q, want insert_update", config.Mode)
			}
			if !config.TableOptions[test.optionKey].Update {
				t.Fatalf("table option %q must enable updates for the default mode", test.optionKey)
			}
		})
	}
}

func TestBuildDataSyncJobEngineConfigKeepsSchemaOnlyAutoAddForExplicitMapping(t *testing.T) {
	config, err := buildDataSyncJobEngineConfig(
		syncjob.JobDefinition{
			Options: syncjob.ExecutionOptions{
				Content:             "schema",
				AutoAddColumns:      boolPtr(true),
				TargetTableStrategy: "existing_only",
				SyncMode:            "insert_update",
			},
		},
		"run-1",
		resolvedDataSyncJobEndpoint{
			Config:   connection.ConnectionConfig{Type: "mysql"},
			Database: "local",
		},
		resolvedDataSyncJobEndpoint{
			Config:   connection.ConnectionConfig{Type: "mysql"},
			Database: "online",
		},
		syncjob.TableMapping{
			SourceSchema: "local",
			SourceTable:  "orders",
			TargetSchema: "online",
			TargetTable:  "orders_archive",
		},
	)
	if err != nil {
		t.Fatalf("buildDataSyncJobEngineConfig returned error: %v", err)
	}
	if !config.AutoAddColumns {
		t.Fatal("schema-only explicit mapping lost autoAddColumns")
	}
	if len(config.Mappings) != 1 || config.TargetTableStrategy != "existing_only" {
		t.Fatalf("unexpected explicit schema mapping config: %+v", config)
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
