package app

import (
	"errors"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
)

func TestDBQueryMultiPrefersResultSetForExecStoredProcedure(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "EXEC sp_who2"
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"SPID": 77, "STATUS": "SUSPENDED"},
			},
		},
		fieldMap: map[string][]string{
			query: {"SPID", "STATUS"},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryMulti(config, "master", query, "sp-who2-multi-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 1 || len(resultSets[0].Rows) != 1 {
		t.Fatalf("unexpected result sets: %#v", resultSets)
	}
	if got := resultSets[0].Rows[0]["SPID"]; got != 77 {
		t.Fatalf("expected SPID=77, got %#v", got)
	}
	if fakeDB.execCalls != 0 {
		t.Fatalf("expected exec path to be skipped, got execCalls=%d", fakeDB.execCalls)
	}
}

func TestDBQueryMultiDoesNotBatchExecStoredProcedureAsWriteStatement(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "EXEC sp_who2"
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"SPID": 88, "STATUS": "RUNNING"},
			},
		},
		fieldMap: map[string][]string{
			query: {"SPID", "STATUS"},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryMulti(config, "master", query, "sp-who2-batch-guard-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("expected stored procedure to skip batch write path, got batchCalls=%d", fakeDB.batchCalls)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 1 || len(resultSets[0].Rows) != 1 {
		t.Fatalf("unexpected result sets: %#v", resultSets)
	}
	if got := resultSets[0].Rows[0]["SPID"]; got != 88 {
		t.Fatalf("expected SPID=88, got %#v", got)
	}
}

func TestDBQueryMultiSurfacesUnknownBatchWriteOutcome(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })

	query := "UPDATE demo SET value = 2"
	fakeDB := &fakeBatchWriteDB{batchErr: db.MarkWriteOutcomeUnknown(errors.New("write response lost"))}
	newDatabaseFunc = func(string) (db.Database, error) { return fakeDB, nil }

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.DBQueryMulti(connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432}, "app", query, "cli-unknown-batch")
	if result.Success {
		t.Fatalf("unknown batch write unexpectedly succeeded: %#v", result)
	}
	data, ok := result.Data.(map[string]any)
	if !ok || data["outcomeUnknown"] != true {
		t.Fatalf("unknown batch write did not expose outcomeUnknown: %#v", result)
	}
	if fakeDB.batchCalls != 1 {
		t.Fatalf("unknown batch write was retried: batchCalls=%d", fakeDB.batchCalls)
	}
}

func TestDBQueryMultiDoesNotReplayOpaqueConnectionLossWrite(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })

	query := "UPDATE demo SET value = 3"
	fakeDB := &fakeBatchWriteDB{batchErr: errors.New("connection reset by peer")}
	newDatabaseFunc = func(string) (db.Database, error) { return fakeDB, nil }

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.DBQueryMulti(connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432}, "app", query, "cli-opaque-batch")
	if result.Success {
		t.Fatalf("opaque connection-loss write unexpectedly succeeded: %#v", result)
	}
	data, ok := result.Data.(map[string]any)
	if !ok || data["outcomeUnknown"] != true {
		t.Fatalf("opaque connection-loss write did not expose outcomeUnknown: %#v", result)
	}
	if fakeDB.batchCalls != 1 {
		t.Fatalf("opaque connection-loss write was replayed: batchCalls=%d", fakeDB.batchCalls)
	}
}

func TestDBQueryWithCancelDoesNotReplayOpaqueConnectionLossReturningWrite(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })

	query := "INSERT INTO audit_logs(id) VALUES (3) RETURNING id"
	fakeDB := &fakeBatchWriteDB{queryErr: map[string]error{query: errors.New("connection reset by peer")}}
	newDatabaseFunc = func(string) (db.Database, error) { return fakeDB, nil }

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.DBQueryWithCancel(connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432}, "app", query, "cli-opaque-returning")
	if result.Success {
		t.Fatalf("opaque connection-loss returning write unexpectedly succeeded: %#v", result)
	}
	data, ok := result.Data.(map[string]any)
	if !ok || data["outcomeUnknown"] != true {
		t.Fatalf("opaque connection-loss returning write did not expose outcomeUnknown: %#v", result)
	}
	if fakeDB.queryCalls != 1 || fakeDB.execCalls != 0 {
		t.Fatalf("opaque connection-loss returning write was replayed: queryCalls=%d execCalls=%d", fakeDB.queryCalls, fakeDB.execCalls)
	}
}
