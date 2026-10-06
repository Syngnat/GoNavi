package app

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func TestDBGetSessionMonitorCapabilitiesNeverConnects(t *testing.T) {
	var factoryCalls atomic.Int32
	installDatabaseCacheConcurrencyTestHooks(t)
	newDatabaseFunc = func(string) (db.Database, error) {
		factoryCalls.Add(1)
		return &sessionWorkbenchRecordingDB{}, nil
	}
	app := newDatabaseCacheConcurrencyTestApp()

	result := app.DBGetSessionMonitorCapabilities(sessionWorkbenchConfig("dameng"))
	capabilities, ok := result.Data.(connection.SessionMonitorCapabilities)
	if !result.Success || !ok {
		t.Fatalf("result = %+v", result)
	}
	// Dameng reports lock waits but no transaction start time.
	if capabilities.Engine != "dameng" || !capabilities.LockWaits.Supported || capabilities.LongTransactions.Supported {
		t.Fatalf("capabilities = %+v", capabilities)
	}
	if factoryCalls.Load() != 0 {
		t.Fatal("capability lookup opened a connection")
	}
}

func TestDBListLongTransactionsReturnsRowsAndClosesConnection(t *testing.T) {
	database := &sessionWorkbenchRecordingDB{
		query: func(_ context.Context, query string) ([]map[string]interface{}, []string, error) {
			if !strings.Contains(query, "xact_start") {
				t.Fatalf("query = %q", query)
			}
			return []map[string]interface{}{{
				"session_id": int64(17), "user_name": "app", "state": "idle in transaction",
				"duration_ms": int64(720000), "statement": "UPDATE orders SET status = 'paid' WHERE id = 7",
			}}, nil, nil
		},
	}
	app := sessionWorkbenchTestApp(t, database)

	result := app.DBListLongTransactions(sessionWorkbenchConfig("postgres"), "shop")
	payload, ok := result.Data.(connection.LongTransactionPayload)
	if !result.Success || !ok || len(payload.Transactions) != 1 || payload.Transactions[0].DurationMs != 720000 {
		t.Fatalf("result = %+v", result)
	}
	if database.connectCalls.Load() != 1 || database.closeCalls.Load() != 1 {
		t.Fatalf("connect/close = %d/%d", database.connectCalls.Load(), database.closeCalls.Load())
	}
}
