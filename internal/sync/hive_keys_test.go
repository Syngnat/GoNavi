package sync

import (
	"context"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestHiveSnapshotRejectsNullEmptyAndTransformedDuplicateKeys(t *testing.T) {
	for _, test := range []struct {
		name      string
		rows      []map[string]interface{}
		transform bool
	}{
		{"null", []map[string]interface{}{{"id": nil, "name": "value"}}, false},
		{"empty", []map[string]interface{}{{"id": "", "name": "value"}}, false},
		{"transformed duplicate", []map[string]interface{}{{"id": "A", "name": "one"}, {"id": "a", "name": "two"}}, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			fields := []connection.ColumnDefinition{{Name: "id", Type: "string"}, {Name: "name", Type: "string"}}
			source, target := newHiveSyncTestDB("src", fields, test.rows), newHiveSyncTestDB("dst", fields, nil)
			target.capabilities.Update = true
			config := hiveTestConfig("insert_update")
			config.Mappings = hiveLogicalKeyMapping()
			if test.transform {
				config.Mappings[0].Columns = []SyncColumnMapping{{Source: "id", Target: "id", Transforms: []SyncValueTransform{{Type: "lower"}}}, {Source: "name", Target: "name"}}
			}
			useHiveSyncTestDBs(t, source, target)
			result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
			if result.Success {
				t.Fatalf("invalid source identity accepted: %+v", result)
			}
			assertHiveNoWrites(t, target)
		})
	}
}

func TestHiveWatermarkRejectsKeyTransformsAcrossBatches(t *testing.T) {
	fields := hiveWatermarkFields()
	fields[1].Type = "string"
	source, target := newHiveSyncTestDB("src", fields, nil), newHiveSyncTestDB("dst", fields, nil)
	request := hiveWatermarkRequest("insert_only")
	request.Sync.Mappings[0].Columns = []SyncColumnMapping{{Source: "id", Target: "id", Transforms: []SyncValueTransform{{Type: "lower"}}}, {Source: "updated_at", Target: "updated_at"}, {Source: "name", Target: "name"}}
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunWatermarkSync(context.Background(), request, nil)
	if result.Success || !strings.Contains(result.Message, "identity value") {
		t.Fatalf("unstable transformed key = %+v", result)
	}
	assertHiveNoWrites(t, target)
	if len(source.streamQueries) != 0 || len(source.queries) != 0 {
		t.Fatal("key transform rejection happened after data reads")
	}
}

func TestHiveWatermarkChecksLogicalKeysOnNonHiveSourceBeforeWrites(t *testing.T) {
	sourceFields := []connection.ColumnDefinition{{Name: "updated_at", Type: "bigint", Nullable: "NO"}, {Name: "id", Type: "bigint", Nullable: "NO"}, {Name: "name", Type: "varchar(32)"}}
	source, target := newHiveSyncTestDB("src", sourceFields, nil), newHiveSyncTestDB("dst", hiveWatermarkFields(), nil)
	source.queryFunc = func(query string) ([]map[string]interface{}, []string, error) {
		if strings.Contains(query, "HAVING COUNT(*) > 1") {
			return []map[string]interface{}{{"id": int64(1)}}, []string{"id"}, nil
		}
		return nil, nil, nil
	}
	request := hiveWatermarkRequest("insert_only")
	request.Sync.SourceConfig.Type = "mysql"
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunWatermarkSync(context.Background(), request, nil)
	if result.Success || !strings.Contains(result.Message, "duplicate") {
		t.Fatalf("unenforced non-Hive key = %+v", result)
	}
	assertHiveNoWrites(t, target)
}

func TestHiveWatermarkRejectsWhitespaceAndBinaryEmptyKeys(t *testing.T) {
	for _, keyType := range []string{"string", "binary"} {
		t.Run(keyType, func(t *testing.T) {
			fields := hiveWatermarkFields()
			fields[1].Type = keyType
			source, target := newHiveSyncTestDB("src", fields, nil), newHiveSyncTestDB("dst", fields, nil)
			source.queryFunc = func(query string) ([]map[string]interface{}, []string, error) {
				if strings.Contains(query, "LTRIM(") || strings.Contains(query, "LENGTH(") {
					return []map[string]interface{}{{"id": ""}}, []string{"id"}, nil
				}
				return nil, nil, nil
			}
			useHiveSyncTestDBs(t, source, target)
			result := NewSyncEngine(Reporter{}).RunWatermarkSync(context.Background(), hiveWatermarkRequest("insert_only"), nil)
			if result.Success || !strings.Contains(result.Message, "empty") {
				t.Fatalf("empty logical key = %+v", result)
			}
			assertHiveNoWrites(t, target)
		})
	}
}

func TestHiveWatermarkRejectsComplexCursorKeys(t *testing.T) {
	fields := hiveWatermarkFields()
	fields[1].Type = "array<int>"
	source, target := newHiveSyncTestDB("src", fields, nil), newHiveSyncTestDB("dst", fields, nil)
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunWatermarkSync(context.Background(), hiveWatermarkRequest("insert_only"), nil)
	if result.Success || !strings.Contains(result.Message, "scalar cursor") {
		t.Fatalf("complex cursor = %+v", result)
	}
	assertHiveNoWrites(t, target)
}

func TestHiveStreamRejectsMismatchedTypedMetadata(t *testing.T) {
	consumer := &hiveSyncStreamConsumer{ctx: context.Background(), consume: func([]map[string]interface{}) error { t.Fatal("consumed invalid stream"); return nil }}
	if err := consumer.SetColumns([]string{"actual"}); err != nil {
		t.Fatal(err)
	}
	if err := consumer.SetColumnDefinitions([]connection.ColumnDefinition{{Name: "different", Type: "string"}}); err == nil {
		t.Fatal("mismatched typed column names were accepted")
	}
}
