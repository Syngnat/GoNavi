package app

import (
	"context"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

type blockingConnectCancelDB struct {
	db.Database
	connectStarted  chan struct{}
	connectRelease  chan struct{}
	queryContextErr chan error
}

func (f *blockingConnectCancelDB) Connect(connection.ConnectionConfig) error {
	close(f.connectStarted)
	<-f.connectRelease
	return nil
}

func (f *blockingConnectCancelDB) Close() error { return nil }

func (f *blockingConnectCancelDB) Ping() error { return nil }

func (f *blockingConnectCancelDB) QueryContext(ctx context.Context, _ string) ([]map[string]interface{}, []string, error) {
	err := ctx.Err()
	f.queryContextErr <- err
	if err != nil {
		return nil, nil, err
	}
	return []map[string]interface{}{{"value": 1}}, []string{"value"}, nil
}

func TestGenerateQueryID(t *testing.T) {
	app := NewApp()
	id := app.GenerateQueryID()
	if id == "" {
		t.Fatal("GenerateQueryID returned empty string")
	}
	// Should start with "query-"
	if !strings.HasPrefix(id, "query-") {
		t.Fatalf("Expected query ID to start with 'query-', got: %s", id)
	}
	// Should be reasonably unique (not equal to another generated ID)
	id2 := app.GenerateQueryID()
	if id == id2 {
		t.Fatal("Two consecutive GenerateQueryID calls returned identical IDs")
	}
}

func TestCancelQuery_NonExistent(t *testing.T) {
	app := NewApp()
	res := app.CancelQuery("non-existent-query-id")
	if res.Success {
		t.Fatal("CancelQuery should fail for non-existent query ID")
	}
	if expected := app.appText("query_editor.message.cancel_no_running", nil); res.Message != expected {
		t.Fatalf("expected localized missing-query message %q, got %q", expected, res.Message)
	}
}

func TestCancelQuery_ValidQuery(t *testing.T) {
	app := NewApp()

	// First, generate a query ID and simulate a running query
	queryID := app.GenerateQueryID()

	// Store a cancel function in runningQueries map
	_, cancel := context.WithCancel(context.Background())
	app.queryMu.Lock()
	app.runningQueries[queryID] = queryContext{
		cancel:  cancel,
		started: time.Now(),
	}
	app.queryMu.Unlock()

	// Ensure cleanup after test
	defer func() {
		app.queryMu.Lock()
		delete(app.runningQueries, queryID)
		app.queryMu.Unlock()
	}()

	// Cancel the query
	res := app.CancelQuery(queryID)
	if !res.Success {
		t.Fatalf("CancelQuery should succeed for valid query ID, got: %s", res.Message)
	}
	if expected := app.appText("query_editor.message.cancel_success", nil); res.Message != expected {
		t.Fatalf("expected localized cancel success message %q, got %q", expected, res.Message)
	}

	// Verify query removed from map
	app.queryMu.Lock()
	_, exists := app.runningQueries[queryID]
	app.queryMu.Unlock()
	if exists {
		t.Fatal("Query should be removed from runningQueries after cancellation")
	}
}

func TestDBQueryMulti_CanBeCancelledWhileConnecting(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })

	database := &blockingConnectCancelDB{
		connectStarted:  make(chan struct{}),
		connectRelease:  make(chan struct{}),
		queryContextErr: make(chan error, 1),
	}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }

	app := NewApp()
	queryID := "cancel-while-connecting"
	resultCh := make(chan connection.QueryResult, 1)
	go func() {
		resultCh <- app.DBQueryMulti(connection.ConnectionConfig{
			Type:    "mysql",
			Host:    "cancel-connect.test",
			Port:    3306,
			User:    "tester",
			Timeout: 5,
		}, "test", "SELECT 1", queryID)
	}()

	released := false
	defer func() {
		if !released {
			close(database.connectRelease)
		}
	}()
	select {
	case <-database.connectStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for database connection attempt")
	}

	firstCancel := app.CancelQuery(queryID)
	secondCancel := app.CancelQuery(queryID)
	close(database.connectRelease)
	released = true

	var result connection.QueryResult
	select {
	case result = <-resultCh:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for cancelled query to return")
	}
	var observedContextErr error
	select {
	case observedContextErr = <-database.queryContextErr:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for query context observation")
	}

	if !firstCancel.Success {
		t.Errorf("first cancellation while connecting should succeed, got: %s", firstCancel.Message)
	}
	if !secondCancel.Success {
		t.Errorf("repeated cancellation should succeed until the query owner exits, got: %s", secondCancel.Message)
	}
	if observedContextErr != context.Canceled {
		t.Errorf("query should receive the cancellation requested during connect, got context error: %v", observedContextErr)
	}
	if result.Success {
		t.Fatalf("query should not execute successfully after cancellation, got: %+v", result)
	}

	app.queryMu.RLock()
	_, stillRegistered := app.runningQueries[queryID]
	app.queryMu.RUnlock()
	if stillRegistered {
		t.Fatal("query should be removed from runningQueries after its owner exits")
	}
	if thirdCancel := app.CancelQuery(queryID); thirdCancel.Success {
		t.Fatal("cancellation should fail after the query owner exits")
	}
}

func TestRegisterRunningQuery_OldCleanupDoesNotDeleteReplacement(t *testing.T) {
	app := NewApp()
	queryID := "reused-query-id"

	firstCtx, firstCancel := context.WithCancel(context.Background())
	defer firstCancel()
	cleanupFirst := app.registerRunningQuery(queryID, firstCancel, true)

	secondCtx, secondCancel := context.WithCancel(context.Background())
	defer secondCancel()
	cleanupSecond := app.registerRunningQuery(queryID, secondCancel, true)
	cleanupFirst()

	if result := app.CancelQuery(queryID); !result.Success {
		t.Fatalf("old cleanup removed the replacement registration: %s", result.Message)
	}
	select {
	case <-secondCtx.Done():
	case <-time.After(time.Second):
		t.Fatal("replacement cancel function was not called")
	}
	select {
	case <-firstCtx.Done():
		t.Fatal("cancelling the replacement should not cancel the old registration")
	default:
	}

	cleanupSecond()
	app.queryMu.RLock()
	_, exists := app.runningQueries[queryID]
	app.queryMu.RUnlock()
	if exists {
		t.Fatal("replacement cleanup should remove its own registration")
	}
}

func TestCleanupStaleQueries(t *testing.T) {
	app := NewApp()

	// Add a stale query (started 2 hours ago)
	queryID := app.GenerateQueryID()
	_, cancel := context.WithCancel(context.Background())
	app.queryMu.Lock()
	app.runningQueries[queryID] = queryContext{
		cancel:  cancel,
		started: time.Now().Add(-2 * time.Hour),
	}
	app.queryMu.Unlock()

	// Cleanup queries older than 1 hour
	app.cleanupStaleQueries(1 * time.Hour)

	// Verify stale query was removed
	app.queryMu.Lock()
	_, exists := app.runningQueries[queryID]
	app.queryMu.Unlock()
	if exists {
		t.Fatal("Stale query should be removed by CleanupStaleQueries")
	}

	// Add a fresh query (started 30 minutes ago)
	freshID := app.GenerateQueryID()
	_, cancel2 := context.WithCancel(context.Background())
	app.queryMu.Lock()
	app.runningQueries[freshID] = queryContext{
		cancel:  cancel2,
		started: time.Now().Add(-30 * time.Minute),
	}
	app.queryMu.Unlock()
	defer cancel2()

	// Cleanup queries older than 1 hour
	app.cleanupStaleQueries(1 * time.Hour)

	// Verify fresh query still exists
	app.queryMu.Lock()
	_, exists = app.runningQueries[freshID]
	app.queryMu.Unlock()
	if !exists {
		t.Fatal("Fresh query should not be removed by CleanupStaleQueries")
	}

	// Clean up
	app.queryMu.Lock()
	delete(app.runningQueries, freshID)
	app.queryMu.Unlock()
}

func TestDBQueryWithCancel_QueryIDPropagation(t *testing.T) {
	// This test verifies that query ID is properly propagated in QueryResult
	// Since we can't easily mock database connections, we'll test the integration
	// by checking that DBQueryWithCancel returns a QueryResult with QueryID field

	app := NewApp()

	// Create a minimal config for a database type that doesn't require actual connection
	config := connection.ConnectionConfig{
		Type: "duckdb",
		Host: ":memory:", // In-memory duckdb for testing
	}

	// This will fail because we can't actually connect, but we can test the error path
	result := app.DBQueryWithCancel(config, "", "SELECT 1", "test-query-id")

	// The query should fail (no actual database), but QueryID should be present
	if result.QueryID != "test-query-id" {
		t.Fatalf("Expected QueryID 'test-query-id' in result, got: %s", result.QueryID)
	}
}

func TestNewQueryExecutionContext_UsesTimeoutForNetworkDatabases(t *testing.T) {
	ctx, cancel := newQueryExecutionContext(connection.ConnectionConfig{Type: "mysql", Timeout: 7})
	defer cancel()

	deadline, ok := ctx.Deadline()
	if !ok {
		t.Fatal("expected network database query context to carry a deadline")
	}
	remaining := time.Until(deadline)
	if remaining <= 0 || remaining > 8*time.Second {
		t.Fatalf("expected deadline around 7s, got remaining=%s", remaining)
	}
}

func TestNewQueryExecutionContext_DoesNotApplyConnectTimeoutToDuckDBQueries(t *testing.T) {
	ctx, cancel := newQueryExecutionContext(connection.ConnectionConfig{Type: "duckdb", Timeout: 1})
	defer cancel()

	if _, ok := ctx.Deadline(); ok {
		t.Fatal("expected DuckDB query context to avoid connection-timeout deadline")
	}
}
