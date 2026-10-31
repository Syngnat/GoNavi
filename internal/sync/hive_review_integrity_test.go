package sync

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

func TestHiveReviewRequiredValuesCheckedBeforeOverwrite(t *testing.T) {
	for _, test := range []struct {
		name   string
		fields []connection.ColumnDefinition
		row    map[string]interface{}
	}{
		{"missing", []connection.ColumnDefinition{{Name: "id", Type: "int"}}, map[string]interface{}{"id": int64(1)}},
		{"NULL", []connection.ColumnDefinition{{Name: "id", Type: "int"}, {Name: "required", Type: "string"}}, map[string]interface{}{"id": int64(1), "required": nil}},
	} {
		t.Run(test.name, func(t *testing.T) {
			targetFields := []connection.ColumnDefinition{{Name: "id", Type: "int"}, {Name: "required", Type: "string", Nullable: "NO"}}
			source, target := newHiveSyncTestDB("src", test.fields, []map[string]interface{}{test.row}), newHiveSyncTestDB("dst", targetFields, nil)
			config := hiveTestConfig("full_overwrite")
			config.SourceQuery = "SELECT * FROM events"
			useHiveSyncTestDBs(t, source, target)
			result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
			if result.Success {
				t.Fatalf("required value accepted: %+v", result)
			}
			assertHiveNoWrites(t, target)
		})
	}
}

func TestHiveReviewBinaryIsDecodedOnlyForCrossFamilyWrites(t *testing.T) {
	for _, queryMode := range []bool{false, true} {
		t.Run(map[bool]string{false: "table", true: "SQL query"}[queryMode], func(t *testing.T) {
			sourceFields := []connection.ColumnDefinition{{Name: "payload", Type: "binary"}}
			source := newHiveSyncTestDB("src", sourceFields, []map[string]interface{}{{"payload": "0x00ff"}})
			target := newHiveSyncTestDB("dst", []connection.ColumnDefinition{{Name: "payload", Type: "longblob"}}, nil)
			config := hiveTestConfig("insert_only")
			config.TargetConfig.Type = "mysql"
			if queryMode {
				config.SourceQuery = "SELECT payload FROM events"
			}
			useHiveSyncTestDBs(t, source, target)
			result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
			if !result.Success || result.RowsInserted != 1 {
				t.Fatalf("binary copy = %+v", result)
			}
			value, ok := target.applied[0].Inserts[0]["payload"].([]byte)
			if !ok || !bytes.Equal(value, []byte{0, 255}) {
				t.Fatalf("binary bound as ASCII: %#v", target.applied)
			}
		})
	}
	config := hiveTestConfig("insert_only")
	rows := []map[string]interface{}{{"payload": "0x00ff"}}
	converted, err := restoreHiveBinaryRows(config, []connection.ColumnDefinition{{Name: "payload", Type: "binary"}}, rows)
	if err != nil || converted[0]["payload"] != "0x00ff" {
		t.Fatalf("Hive target representation changed: %#v %v", converted, err)
	}
}

func TestHiveReviewTypedSQLKeysRejectCoercionDuplicatesAndMatchRerun(t *testing.T) {
	for _, test := range []struct {
		name    string
		rows    []map[string]interface{}
		success bool
		updates int
	}{
		{"duplicate cast", []map[string]interface{}{{"id": "1", "name": "one"}, {"id": "01", "name": "two"}}, false, 0},
		{"equivalent rerun", []map[string]interface{}{{"id": "01", "name": "old"}}, true, 0},
		{"equivalent update", []map[string]interface{}{{"id": "01", "name": "new"}}, true, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			source := newHiveSyncTestDB("src", []connection.ColumnDefinition{{Name: "id", Type: "varchar(10)"}, {Name: "name", Type: "varchar(10)"}}, test.rows)
			target := newHiveSyncTestDB("dst", []connection.ColumnDefinition{{Name: "id", Type: "int"}, {Name: "name", Type: "string"}}, []map[string]interface{}{{"id": int64(1), "name": "old"}})
			target.capabilities.Update = true
			config := hiveTestConfig("insert_update")
			config.SourceConfig.Type = "mysql"
			config.SourceQuery = "SELECT id,name FROM events"
			config.Mappings = hiveLogicalKeyMapping()
			useHiveSyncTestDBs(t, source, target)
			result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
			if result.Success != test.success || result.RowsInserted != 0 || result.RowsUpdated != test.updates {
				t.Fatalf("typed identity = %+v", result)
			}
			if !test.success {
				assertHiveNoWrites(t, target)
			}
			if test.updates == 1 && target.applied[0].Updates[0].Keys["id"] != int64(1) {
				t.Fatalf("key binding is not normalized: %#v", target.applied)
			}
		})
	}
}

func TestHiveReviewNonHiveSQLNanosecondsFailBeforeClear(t *testing.T) {
	for _, family := range []string{"spark", "impala"} {
		t.Run(family, func(t *testing.T) {
			fields := []connection.ColumnDefinition{{Name: "stamp", Type: "timestamp"}}
			source := newHiveSyncTestDB("src", fields, []map[string]interface{}{{"stamp": time.Date(2026, 10, 25, 1, 2, 3, 123456789, time.UTC)}})
			target := newHiveSyncTestDB("dst", fields, nil)
			target.capabilities.Family = family
			if family == "impala" {
				target.capabilities.Properties = map[string]string{"storage_handler": "org.apache.hadoop.hive.kudu.KuduStorageHandler"}
			}
			config := hiveTestConfig("full_overwrite")
			config.SourceConfig.Type = "duckdb"
			config.SourceQuery = "SELECT stamp FROM events"
			config.TargetConfig.ConnectionParams = "hiveFamily=" + family
			useHiveSyncTestDBs(t, source, target)
			result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
			if result.Success || !strings.Contains(result.Message, "microseconds") {
				t.Fatalf("nanosecond loss was not blocked: %+v", result)
			}
			assertHiveNoWrites(t, target)
		})
	}
}

func TestHiveReviewKuduSchemaPrecisionRejectsBeforeSourceRead(t *testing.T) {
	fields := []connection.ColumnDefinition{{Name: "stamp", Type: "timestamp"}}
	source, target := newHiveSyncTestDB("src", fields, nil), newHiveSyncTestDB("dst", fields, nil)
	target.capabilities.Family = "impala"
	target.capabilities.Update = true
	target.capabilities.Properties = map[string]string{"kudu.table_name": "impala::events"}
	config := hiveTestConfig("insert_only")
	config.TargetConfig.ConnectionParams = "hiveFamily=impala"
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
	if result.Success || len(source.streamQueries) != 0 {
		t.Fatalf("Kudu source type range was not rejected early: %+v", result)
	}
	assertHiveNoWrites(t, target)
}

func TestHiveReviewPartitionedACIDUpdateAcceptsPartialPatch(t *testing.T) {
	fields := []connection.ColumnDefinition{{Name: "id", Type: "bigint"}, {Name: "name", Type: "string"}, {Name: "day", Type: "string", Extra: "partition"}, {Name: "required", Type: "string", Nullable: "NO"}}
	source := newHiveSyncTestDB("src", fields, []map[string]interface{}{{"id": int64(1), "name": "new", "day": "2026-10-25", "required": "kept"}})
	target := newHiveSyncTestDB("dst", fields, []map[string]interface{}{{"id": int64(1), "name": "old", "day": "2026-10-25", "required": "kept"}})
	target.capabilities.Update = true
	config := hiveTestConfig("insert_update")
	config.Mappings = hiveLogicalKeyMapping()
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
	if !result.Success || result.RowsUpdated != 1 {
		t.Fatalf("valid partial patch rejected: %+v", result)
	}
	if len(target.applied[0].Updates[0].Values) != 1 {
		t.Fatalf("patch unexpectedly expanded: %#v", target.applied)
	}
}

func TestHiveReviewWatermarkBinaryLookupUsesTargetType(t *testing.T) {
	plan := watermarkRuntimePlan{targetType: "hive", targetQueryTable: "dst.events", targetTieColumns: []string{"id"}, targetColumns: []connection.ColumnDefinition{{Name: "id", Type: "binary"}}}
	query, err := buildWatermarkTargetLookupQuery(plan, []map[string]interface{}{{"id": "0x00ff"}})
	if err != nil || !strings.Contains(query, "unhex('00ff')") || strings.Contains(query, "'0x00ff'") {
		t.Fatalf("binary lookup = %s %v", query, err)
	}
}

func TestHiveReviewMySQLBooleanAliasIsCompatible(t *testing.T) {
	if !hiveMigrationTypeCompatible("mysql", "BOOLEAN", "tinyint(1)") {
		t.Fatal("MySQL BOOLEAN native alias rejects rerun")
	}
}
