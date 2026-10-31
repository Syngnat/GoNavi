package sync

import (
	"context"
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestHivePartitionAndMissingColumnMismatchesDoNotWrite(t *testing.T) {
	for _, test := range []struct {
		name           string
		source, target []connection.ColumnDefinition
		autoAdd        bool
	}{
		{"partition lost", []connection.ColumnDefinition{{Name: "day", Type: "string", Extra: "partition"}}, []connection.ColumnDefinition{{Name: "day", Type: "string"}}, false},
		{"missing partition cannot be added", []connection.ColumnDefinition{{Name: "name", Type: "string"}, {Name: "day", Type: "string", Extra: "partition"}}, []connection.ColumnDefinition{{Name: "name", Type: "string"}}, true},
		{"missing value must not be dropped", []connection.ColumnDefinition{{Name: "name", Type: "string"}}, []connection.ColumnDefinition{{Name: "other", Type: "string"}}, false},
		{"decimal narrowing", []connection.ColumnDefinition{{Name: "value", Type: "decimal(38,18)"}}, []connection.ColumnDefinition{{Name: "value", Type: "decimal(20,4)"}}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			source, target := newHiveSyncTestDB("src", test.source, nil), newHiveSyncTestDB("dst", test.target, nil)
			config := hiveTestConfig("full_overwrite")
			config.AutoAddColumns, config.Content = test.autoAdd, "both"
			useHiveSyncTestDBs(t, source, target)
			result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
			if result.Success {
				t.Fatalf("unsafe schema accepted: %+v", result)
			}
			assertHiveNoWrites(t, target)
		})
	}
}

func TestHiveStreamConsumerCopiesBuffersAndEnforcesProtocol(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var batches [][]map[string]interface{}
	consumer := &hiveSyncStreamConsumer{ctx: ctx, batchSize: 2, consume: func(rows []map[string]interface{}) error { batches = append(batches, rows); return nil }}
	if err := consumer.ConsumeRow(map[string]interface{}{"data": []byte{1}}); err == nil {
		t.Fatal("row before metadata was accepted")
	}
	if err := consumer.SetColumns([]string{"data"}); err != nil {
		t.Fatal(err)
	}
	buffer := []byte{1}
	if err := consumer.ConsumeRow(map[string]interface{}{"data": buffer}); err != nil {
		t.Fatal(err)
	}
	buffer[0] = 2
	if err := consumer.ConsumeRow(map[string]interface{}{"data": buffer}); err != nil {
		t.Fatal(err)
	}
	buffer[0] = 3
	if len(batches) != 1 || batches[0][0]["data"].([]byte)[0] != 1 || batches[0][1]["data"].([]byte)[0] != 2 {
		t.Fatalf("reused Thrift buffers corrupted rows: %v", batches)
	}
	cancel()
	if err := consumer.ConsumeRow(map[string]interface{}{"data": buffer}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel = %v", err)
	}
}

func TestHivePreflightRejectsUnavailableCapabilitiesAndExternalOverwrite(t *testing.T) {
	config := hiveTestConfig("full_overwrite")
	plain := &fakeMigrationDB{}
	if err := validateHiveTargetMode(context.Background(), config, plain, "dst.events", true, TableOptions{Insert: true}); err == nil {
		t.Fatal("missing capabilities must fail closed")
	}
	fields := []connection.ColumnDefinition{{Name: "name", Type: "string"}}
	source, target := newHiveSyncTestDB("src", fields, nil), newHiveSyncTestDB("dst", fields, nil)
	target.capabilities.Truncate = false
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
	if result.Success {
		t.Fatalf("unsupported external overwrite = %+v", result)
	}
	assertHiveNoWrites(t, target)
}

func TestHiveSourceQueryAnalysisRejectsComplexTypeWithoutReadingRows(t *testing.T) {
	fields := []connection.ColumnDefinition{{Name: "value", Type: "array<int>"}}
	source := newHiveSyncTestDB("src", fields, []map[string]interface{}{{"value": "[1]"}})
	target := newHiveSyncTestDB("dst", []connection.ColumnDefinition{{Name: "value", Type: "TEXT"}}, nil)
	config := hiveTestConfig("insert_only")
	config.SourceQuery, config.TargetConfig.Type, config.TargetSchema = "SELECT value FROM events", "postgres", "dst"
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).AnalyzeContext(context.Background(), config)
	if !result.Success || len(result.Tables) != 1 || result.Tables[0].CanSync {
		t.Fatalf("unsafe query analysis = %+v", result)
	}
	if len(source.queries) != 0 {
		t.Fatalf("read/count query result before type validation: %v", source.queries)
	}
}

func TestHiveSourceQueryAnalysisStopsAtMetadataForSafeTypes(t *testing.T) {
	fields := []connection.ColumnDefinition{{Name: "value", Type: "string"}}
	source := newHiveSyncTestDB("src", fields, []map[string]interface{}{{"value": "one"}})
	target := newHiveSyncTestDB("dst", fields, nil)
	config := hiveTestConfig("insert_only")
	config.SourceQuery = "SELECT value FROM events"
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).AnalyzeContext(context.Background(), config)
	if !result.Success || len(result.Tables) != 1 || !result.Tables[0].CanSync || result.Tables[0].Inserts != 1 {
		t.Fatalf("safe query analysis = %+v", result)
	}
	if len(source.streamQueries) != 1 || len(source.queries) != 1 || !strings.Contains(source.queries[0], "COUNT(*)") {
		t.Fatalf("analysis should inspect only types then count: %v %v", source.streamQueries, source.queries)
	}
}
