package db

import (
	"GoNavi-Wails/internal/connection"
	"strings"
	"testing"
)

func TestMySQLApplyChangesUsesEveryCompositeKeyColumn(t *testing.T) {
	dbConn, state := openOracleRecordingDB(t)
	database := &MySQLDB{conn: dbConn}
	changes := connection.ChangeSet{
		Deletes: []map[string]interface{}{{"tenant_id": 3, "order_id": 7}},
		Updates: []connection.UpdateRow{{
			Keys:   map[string]interface{}{"tenant_id": 1, "order_id": 7},
			Values: map[string]interface{}{"status": "paid"},
		}},
	}

	if err := database.ApplyChanges("orders", changes); err != nil {
		t.Fatalf("ApplyChanges() error = %v", err)
	}
	queries := state.snapshotExecQueries()
	if len(queries) != 2 {
		t.Fatalf("exec queries = %#v", queries)
	}
	for _, query := range queries {
		if !strings.Contains(query, "`tenant_id` = ?") || !strings.Contains(query, "`order_id` = ?") || !strings.Contains(query, " AND ") {
			t.Fatalf("composite-key predicate missing from %q", query)
		}
	}
}

func TestPostgresApplyChangesUsesEveryCompositeKeyColumn(t *testing.T) {
	dbConn, state := openOracleRecordingDB(t)
	database := &PostgresDB{conn: dbConn}
	changes := connection.ChangeSet{
		Deletes: []map[string]interface{}{{"tenant_id": 3, "order_id": 7}},
		Updates: []connection.UpdateRow{{
			Keys:   map[string]interface{}{"tenant_id": 1, "order_id": 7},
			Values: map[string]interface{}{"status": "paid"},
		}},
	}

	if err := database.ApplyChanges("public.orders", changes); err != nil {
		t.Fatalf("ApplyChanges() error = %v", err)
	}
	queries := state.snapshotExecQueries()
	if len(queries) != 2 {
		t.Fatalf("exec queries = %#v", queries)
	}
	for _, query := range queries {
		if !strings.Contains(query, `"tenant_id" = $`) || !strings.Contains(query, `"order_id" = $`) || !strings.Contains(query, " AND ") {
			t.Fatalf("composite-key predicate missing from %q", query)
		}
	}
}
