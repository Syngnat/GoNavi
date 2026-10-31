package sync

import (
	"context"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestHiveQueryResultHasNoPartitionConstraintButCanWritePartitions(t *testing.T) {
	sourceFields := []connection.ColumnDefinition{{Name: "value", Type: "string"}, {Name: "day", Type: "string"}}
	targetFields := append([]connection.ColumnDefinition(nil), sourceFields...)
	targetFields[1].Extra = "partition"
	source := newHiveSyncTestDB("src", sourceFields, []map[string]interface{}{{"value": "one", "day": "2026-10-25"}})
	target := newHiveSyncTestDB("dst", targetFields, nil)
	config := hiveTestConfig("full_overwrite")
	config.SourceQuery = "SELECT value, day FROM events"
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
	if !result.Success || result.RowsInserted != 1 || target.applied[0].Inserts[0]["day"] != "2026-10-25" {
		t.Fatalf("partition query copy = %+v, rows=%v", result, target.applied)
	}
}

func TestHiveQueryMissingPartitionValueFailsBeforeClear(t *testing.T) {
	sourceFields := []connection.ColumnDefinition{{Name: "value", Type: "string"}}
	targetFields := []connection.ColumnDefinition{{Name: "value", Type: "string"}, {Name: "day", Type: "string", Extra: "partition"}}
	source := newHiveSyncTestDB("src", sourceFields, []map[string]interface{}{{"value": "one"}})
	target := newHiveSyncTestDB("dst", targetFields, nil)
	config := hiveTestConfig("full_overwrite")
	config.SourceQuery = "SELECT value FROM events"
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
	if result.Success {
		t.Fatalf("missing partition value accepted: %+v", result)
	}
	assertHiveNoWrites(t, target)
}
