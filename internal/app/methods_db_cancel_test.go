package app

import (
	"context"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

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
	if !strings.Contains(res.Message, "不存在") && !strings.Contains(res.Message, "not exist") {
		t.Fatalf("Expected error message about query not existing, got: %s", res.Message)
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

	// Verify query removed from map
	app.queryMu.Lock()
	_, exists := app.runningQueries[queryID]
	app.queryMu.Unlock()
	if exists {
		t.Fatal("Query should be removed from runningQueries after cancellation")
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
	app.CleanupStaleQueries(1 * time.Hour)

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
	app.CleanupStaleQueries(1 * time.Hour)

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
