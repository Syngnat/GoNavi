package app

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/shared/i18n"
)

func TestDBListLockWaitsUnsupportedDoesNotOpenConnection(t *testing.T) {
	var factoryCalls atomic.Int32
	installDatabaseCacheConcurrencyTestHooks(t)
	newDatabaseFunc = func(string) (db.Database, error) {
		factoryCalls.Add(1)
		return &sessionWorkbenchRecordingDB{}, nil
	}
	app := newDatabaseCacheConcurrencyTestApp()

	for _, test := range []struct {
		databaseType string
		reason       string
	}{
		{databaseType: "clickhouse", reason: "unsupported"},
		{databaseType: "sqlite", reason: "not_applicable"},
	} {
		result := app.DBListLockWaits(sessionWorkbenchConfig(test.databaseType), "")
		if !result.Success {
			t.Fatalf("%s: success = false, message = %q", test.databaseType, result.Message)
		}
		payload, ok := result.Data.(connection.LockWaitPayload)
		if !ok {
			t.Fatalf("%s: result.Data type = %T", test.databaseType, result.Data)
		}
		if payload.Capability.Supported || payload.Capability.ReasonCode != test.reason || payload.Waits == nil {
			t.Fatalf("%s: payload = %+v", test.databaseType, payload)
		}
	}
	if got := factoryCalls.Load(); got != 0 {
		t.Fatalf("unsupported listing opened %d connections", got)
	}
}

func TestDBListLockWaitsReturnsEdgesAndClosesIsolatedConnection(t *testing.T) {
	database := &sessionWorkbenchRecordingDB{
		query: func(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
			if !strings.Contains(query, "pg_blocking_pids") {
				t.Fatalf("lock-wait query = %q", query)
			}
			if _, ok := ctx.Deadline(); !ok {
				t.Fatal("lock-wait context has no query deadline")
			}
			return []map[string]interface{}{{
				"waiting_session_id":  int64(42),
				"waiting_statement":   "UPDATE orders SET status = 'paid' WHERE id = 7",
				"wait_ms":             int64(8200),
				"blocking_session_id": int64(17),
				"blocking_state":      "idle in transaction",
				"blocking_ms":         int64(65000),
				"database_or_tenant":  "shop",
				"lock_type":           "transactionid",
				"lock_mode":           "ShareLock",
			}}, nil, nil
		},
	}
	app := sessionWorkbenchTestApp(t, database)
	config := sessionWorkbenchConfig("postgres")
	config.QueryTimeout = 5

	result := app.DBListLockWaits(config, "shop")
	if !result.Success {
		t.Fatalf("DBListLockWaits failed: %q", result.Message)
	}
	payload, ok := result.Data.(connection.LockWaitPayload)
	if !ok || len(payload.Waits) != 1 || payload.ScopedDatabase != "shop" {
		t.Fatalf("payload = %#v", result.Data)
	}
	if got := payload.Waits[0]; got.WaitingSessionID != "42" || got.BlockingSessionID != "17" || got.BlockingDurationMs != 65000 {
		t.Fatalf("edge = %+v", got)
	}
	if database.connectCalls.Load() != 1 || database.closeCalls.Load() != 1 {
		t.Fatalf("connect/close = %d/%d, want 1/1", database.connectCalls.Load(), database.closeCalls.Load())
	}
}

func TestDBListLockWaitsLocalizesFailures(t *testing.T) {
	database := &sessionWorkbenchRecordingDB{
		query: func(context.Context, string) ([]map[string]interface{}, []string, error) {
			return nil, nil, errors.New("permission denied for view pg_locks")
		},
	}
	app := sessionWorkbenchTestApp(t, database)
	app.SetLanguage(string(i18n.LanguageZhCN))

	result := app.DBListLockWaits(sessionWorkbenchConfig("postgres"), "shop")
	if result.Success || !strings.Contains(result.Message, "加载锁等待失败") || !strings.Contains(result.Message, "permission denied") {
		t.Fatalf("result = %+v", result)
	}
}
