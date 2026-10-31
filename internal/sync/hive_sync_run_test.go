package sync

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func TestHiveAppendStreamsNoKeyDuplicatesInBoundedBatches(t *testing.T) {
	fields := []connection.ColumnDefinition{{Name: "amount", Type: "decimal(38,18)"}, {Name: "payload", Type: "array<string>"}, {Name: "binary", Type: "binary"}}
	rows := make([]map[string]interface{}, 5)
	for i := range rows {
		rows[i] = map[string]interface{}{"amount": json.Number("12345678901234567890.123456789012345678"), "payload": "[\"same\"]", "binary": []byte{0, 255, byte(i)}}
	}
	source, target := newHiveSyncTestDB("src", fields, rows), newHiveSyncTestDB("dst", fields, nil)
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), hiveTestConfig("insert_only"))
	if !result.Success || result.RowsInserted != 5 || result.RowsUpdated != 0 || result.RowsDeleted != 0 {
		t.Fatalf("append = %+v", result)
	}
	if len(source.streamQueries) != 1 || len(source.queries) != 0 {
		t.Fatalf("source must use one stream, no snapshots/OFFSET: %v %v", source.streamQueries, source.queries)
	}
	if len(target.applied) != 3 || len(target.applied[0].Inserts) != 2 || len(target.applied[2].Inserts) != 1 {
		t.Fatalf("unexpected batches: %v", target.applied)
	}
	for _, table := range target.applyTables {
		if table != "dst.events" {
			t.Fatalf("unqualified apply table %s", table)
		}
	}
	if target.applied[0].Inserts[0]["amount"] != rows[0]["amount"] {
		t.Fatal("decimal precision was changed")
	}
}

func TestHiveFullOverwriteUsesCapabilitySafeClear(t *testing.T) {
	for _, test := range []struct {
		name             string
		truncate, delete bool
		want             string
	}{
		{"ordinary managed", true, false, "TRUNCATE TABLE"}, {"acid delete", false, true, "DELETE FROM"},
	} {
		t.Run(test.name, func(t *testing.T) {
			fields := []connection.ColumnDefinition{{Name: "name", Type: "string"}}
			source, target := newHiveSyncTestDB("src", fields, []map[string]interface{}{{"name": "copied"}}), newHiveSyncTestDB("dst", fields, nil)
			target.capabilities.Truncate, target.capabilities.Delete = test.truncate, test.delete
			useHiveSyncTestDBs(t, source, target)
			result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), hiveTestConfig("full_overwrite"))
			if !result.Success || result.RowsInserted != 1 {
				t.Fatalf("overwrite = %+v", result)
			}
			if len(target.executed) != 1 || !strings.HasPrefix(target.executed[0], test.want) {
				t.Fatalf("clear = %v", target.executed)
			}
		})
	}
}

func TestHiveFullOverwriteReadFailureKeepsTarget(t *testing.T) {
	fields := []connection.ColumnDefinition{{Name: "name", Type: "string"}}
	source, target := newHiveSyncTestDB("src", fields, nil), newHiveSyncTestDB("dst", fields, nil)
	source.streamError = errHiveTestStream
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), hiveTestConfig("full_overwrite"))
	if result.Success || !strings.Contains(result.Message, errHiveTestStream.Error()) {
		t.Fatalf("unexpected result: %+v", result)
	}
	assertHiveNoWrites(t, target)
}

func TestHiveAutoCreateWithoutPrimaryKeyKeepsPartitionColumns(t *testing.T) {
	fields := []connection.ColumnDefinition{{Name: "payload", Type: "struct<a:array<int>>"}, {Name: "day", Type: "string", Extra: "partition"}}
	source, target := newHiveSyncTestDB("src", fields, []map[string]interface{}{{"payload": "{\"a\":[1,2]}", "day": "2026-10-25"}}), newHiveSyncTestDB("dst", nil, nil)
	target.createColumns = fields
	config := hiveTestConfig("insert_update")
	config.Content, config.TargetTableStrategy = "both", "auto_create_if_missing"
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
	if !result.Success || result.RowsInserted != 1 || result.TablesSynced != 1 {
		t.Fatalf("create copy = %+v", result)
	}
	if len(target.executed) != 1 || !strings.Contains(target.executed[0], "PARTITIONED BY") || strings.Contains(target.executed[0], "PRIMARY KEY") {
		t.Fatalf("DDL = %v", target.executed)
	}
}

func TestHiveOrdinaryMutationIsRejectedBeforeSchemaOrDataWrites(t *testing.T) {
	fields := []connection.ColumnDefinition{{Name: "id", Type: "bigint"}, {Name: "name", Type: "string"}}
	source, target := newHiveSyncTestDB("src", fields, []map[string]interface{}{{"id": int64(1), "name": "new"}}), newHiveSyncTestDB("dst", fields, nil)
	config := hiveTestConfig("insert_update")
	config.Mappings = hiveLogicalKeyMapping()
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
	if result.Success || !strings.Contains(result.Message, "UPDATE") {
		t.Fatalf("expected unsupported update: %+v", result)
	}
	assertHiveNoWrites(t, target)
	if len(source.streamQueries) != 0 {
		t.Fatal("read source rows before mutation capability preflight")
	}
}

func TestHiveACIDDiffUsesDeclaredKeyWithoutInventingPrimaryKey(t *testing.T) {
	fields := []connection.ColumnDefinition{{Name: "id", Type: "bigint", Nullable: "YES"}, {Name: "name", Type: "string"}}
	source := newHiveSyncTestDB("src", fields, []map[string]interface{}{{"id": int64(1), "name": "new"}, {"id": int64(2), "name": "added"}})
	target := newHiveSyncTestDB("dst", fields, []map[string]interface{}{{"id": int64(1), "name": "old"}, {"id": int64(3), "name": "removed"}})
	target.capabilities.Update, target.capabilities.Delete, target.capabilities.Transactional = true, true, true
	config := hiveTestConfig("insert_update")
	config.Mappings = hiveLogicalKeyMapping()
	config.TableOptions = map[string]TableOptions{"events": {Insert: true, Update: true, Delete: true}}
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
	if !result.Success || result.RowsInserted != 1 || result.RowsUpdated != 1 || result.RowsDeleted != 1 {
		t.Fatalf("ACID diff = %+v", result)
	}
	if len(target.executed) != 0 || target.capabilities.AtomicBatch {
		t.Fatal("ACID must not imply an explicit transaction or atomic multi-statement batch")
	}
}

func TestHiveDiffRejectsDuplicateLogicalKeysBeforeWrites(t *testing.T) {
	fields := []connection.ColumnDefinition{{Name: "id", Type: "bigint"}, {Name: "name", Type: "string"}}
	source := newHiveSyncTestDB("src", fields, []map[string]interface{}{{"id": int64(1), "name": "new"}})
	target := newHiveSyncTestDB("dst", fields, []map[string]interface{}{{"id": int64(1), "name": "old"}, {"id": int64(1), "name": "other"}})
	target.capabilities.Update = true
	config := hiveTestConfig("insert_update")
	config.Mappings = hiveLogicalKeyMapping()
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
	if result.Success || !strings.Contains(result.Message, "duplicate") {
		t.Fatalf("duplicate logical key = %+v", result)
	}
	assertHiveNoWrites(t, target)
}

func TestHiveNonAtomicWriteFailureNeverReportsSuccessOrRetries(t *testing.T) {
	fields := []connection.ColumnDefinition{{Name: "name", Type: "string"}}
	source, target := newHiveSyncTestDB("src", fields, []map[string]interface{}{{"name": "one"}, {"name": "two"}}), newHiveSyncTestDB("dst", fields, nil)
	target.applyError = db.MarkWriteOutcomeUnknown(errors.New("partial hive batch"))
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), hiveTestConfig("insert_only"))
	if result.Success || !result.OutcomeUnknown || len(target.applied) != 1 || result.RowsInserted != 0 {
		t.Fatalf("partial write = %+v; calls %d", result, len(target.applied))
	}
}
