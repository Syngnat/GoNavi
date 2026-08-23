package app

import (
	"context"
	"errors"
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

type blockingLegacyCancelDB struct {
	db.Database
	queryStarted chan struct{}
	queryRelease chan struct{}
	queryDone    chan struct{}
	execStarted  chan struct{}
	execRelease  chan struct{}
	execDone     chan struct{}
}

func (f *blockingLegacyCancelDB) Connect(connection.ConnectionConfig) error { return nil }
func (f *blockingLegacyCancelDB) Close() error                              { return nil }
func (f *blockingLegacyCancelDB) Ping() error                               { return nil }

func (f *blockingLegacyCancelDB) Query(string) ([]map[string]interface{}, []string, error) {
	close(f.queryStarted)
	<-f.queryRelease
	close(f.queryDone)
	return []map[string]interface{}{{"value": 1}}, []string{"value"}, nil
}

func (f *blockingLegacyCancelDB) Exec(string) (int64, error) {
	if f.execStarted == nil || f.execRelease == nil || f.execDone == nil {
		return 0, errors.New("unexpected legacy Exec call")
	}
	close(f.execStarted)
	<-f.execRelease
	close(f.execDone)
	return 1, nil
}

type blockingContextCancelDB struct {
	*blockingLegacyCancelDB
	contextQueryStarted chan struct{}
	contextQueryDone    chan struct{}
	contextExecStarted  chan struct{}
	contextExecDone     chan struct{}
}

func (f *blockingContextCancelDB) QueryContext(ctx context.Context, _ string) ([]map[string]interface{}, []string, error) {
	close(f.contextQueryStarted)
	<-ctx.Done()
	close(f.contextQueryDone)
	return nil, nil, ctx.Err()
}

func (f *blockingContextCancelDB) ExecContext(ctx context.Context, _ string) (int64, error) {
	close(f.contextExecStarted)
	<-ctx.Done()
	close(f.contextExecDone)
	return 0, ctx.Err()
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

	var result connection.QueryResult
	select {
	case result = <-resultCh:
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled query did not return while Connect was still blocked")
	}

	if !firstCancel.Success {
		t.Errorf("first cancellation while connecting should succeed, got: %s", firstCancel.Message)
	}
	if !secondCancel.Success {
		t.Errorf("repeated cancellation should succeed until the query owner exits, got: %s", secondCancel.Message)
	}
	if result.Success {
		t.Fatalf("query should not execute successfully after cancellation, got: %+v", result)
	}
	if !strings.Contains(strings.ToLower(result.Message), "canceled") {
		t.Fatalf("cancelled connect returned unexpected result: %+v", result)
	}
	select {
	case observedContextErr := <-database.queryContextErr:
		t.Fatalf("SQL execution started after connect cancellation: %v", observedContextErr)
	default:
	}

	close(database.connectRelease)
	released = true
	app.Shutdown()

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

func TestDBQueryWithCancel_LegacyOnlyDriverReportsCancellationUnsupported(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })

	database := &blockingLegacyCancelDB{
		queryStarted: make(chan struct{}),
		queryRelease: make(chan struct{}),
		queryDone:    make(chan struct{}),
	}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }

	app := NewApp()
	t.Cleanup(app.Shutdown)
	const queryID = "legacy-single-query"
	resultCh := make(chan connection.QueryResult, 1)
	go func() {
		resultCh <- app.DBQueryWithCancel(connection.ConnectionConfig{
			Type: "postgres", Host: "legacy-single.test", Port: 5432,
		}, "app", "SELECT 1", queryID)
	}()

	select {
	case <-database.queryStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for legacy query execution")
	}

	cancelResult := app.CancelQuery(queryID)
	if cancelResult.Success || cancelResult.CancellationState != connection.QueryCancellationStateUnsupported {
		t.Fatalf("legacy cancellation must report unsupported, got %#v", cancelResult)
	}
	select {
	case result := <-resultCh:
		t.Fatalf("legacy query falsely returned before underlying execution completed: %#v", result)
	case <-time.After(100 * time.Millisecond):
	}

	close(database.queryRelease)
	result := <-resultCh
	if !result.Success {
		t.Fatalf("legacy query should return its real completion result, got %#v", result)
	}
	select {
	case <-database.queryDone:
	default:
		t.Fatal("query result returned before the legacy driver completed")
	}
	app.queryMu.RLock()
	_, stillRegistered := app.runningQueries[queryID]
	app.queryMu.RUnlock()
	if stillRegistered {
		t.Fatal("legacy query registration was not released after real completion")
	}
}

func TestDBQueryMulti_LegacyOnlyParentCancellationIsExplicit(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })

	database := &blockingLegacyCancelDB{
		queryStarted: make(chan struct{}),
		queryRelease: make(chan struct{}),
		queryDone:    make(chan struct{}),
	}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }

	app := NewApp()
	t.Cleanup(app.Shutdown)
	ctx, cancel := context.WithCancel(context.Background())
	resultCh := make(chan connection.QueryResult, 1)
	go func() {
		resultCh <- NewCLIQueryExecutor(app).DBQueryMulti(ctx, connection.ConnectionConfig{
			Type: "postgres", Host: "legacy-parent-context.test", Port: 5432,
		}, "app", "SELECT 1", "legacy-parent-context")
	}()

	select {
	case <-database.queryStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for legacy multi-query execution")
	}
	cancel()
	select {
	case result := <-resultCh:
		t.Fatalf("legacy multi-query falsely returned on parent cancellation: %#v", result)
	case <-time.After(100 * time.Millisecond):
	}

	close(database.queryRelease)
	result := <-resultCh
	if !result.Success || result.CancellationState != connection.QueryCancellationStateUnsupported {
		t.Fatalf("legacy parent cancellation must be explicit, got %#v", result)
	}
	data, _ := result.Data.(map[string]any)
	if data["cancelled"] == true {
		t.Fatalf("legacy execution must not be reported as stopped, got %#v", result)
	}
	select {
	case <-database.queryDone:
	default:
		t.Fatal("legacy multi-query returned before its underlying execution completed")
	}
}

func TestDBQueryMulti_ContextDriverStopsOnParentCancellation(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })

	legacy := &blockingLegacyCancelDB{
		queryStarted: make(chan struct{}),
		queryRelease: make(chan struct{}),
		queryDone:    make(chan struct{}),
	}
	database := &blockingContextCancelDB{
		blockingLegacyCancelDB: legacy,
		contextQueryStarted:    make(chan struct{}),
		contextQueryDone:       make(chan struct{}),
	}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }

	app := NewApp()
	t.Cleanup(app.Shutdown)
	ctx, cancel := context.WithCancel(context.Background())
	resultCh := make(chan connection.QueryResult, 1)
	go func() {
		resultCh <- NewCLIQueryExecutor(app).DBQueryMulti(ctx, connection.ConnectionConfig{
			Type: "postgres", Host: "context-parent.test", Port: 5432,
		}, "app", "SELECT 1", "context-parent")
	}()

	select {
	case <-database.contextQueryStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for QueryContext execution")
	}
	cancel()
	select {
	case result := <-resultCh:
		if result.Success {
			t.Fatalf("cancelled Context query should fail, got %#v", result)
		}
		data, _ := result.Data.(map[string]any)
		if data["cancelled"] != true || result.CancellationState != "" {
			t.Fatalf("Context cancellation should report a real stop, got %#v", result)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Context-capable query did not stop after parent cancellation")
	}
	select {
	case <-database.contextQueryDone:
	default:
		t.Fatal("QueryContext result returned before the driver observed cancellation")
	}
	select {
	case <-legacy.queryStarted:
		t.Fatal("Context-capable driver unexpectedly fell back to legacy Query")
	default:
	}
}

func TestDBQueryMulti_LegacyOnlyWriteParentCancellationIsExplicit(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })

	database := &blockingLegacyCancelDB{
		execStarted: make(chan struct{}),
		execRelease: make(chan struct{}),
		execDone:    make(chan struct{}),
	}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }

	app := NewApp()
	t.Cleanup(app.Shutdown)
	ctx, cancel := context.WithCancel(context.Background())
	resultCh := make(chan connection.QueryResult, 1)
	go func() {
		resultCh <- NewCLIQueryExecutor(app).DBQueryMulti(ctx, connection.ConnectionConfig{
			Type: "postgres", Host: "legacy-write-context.test", Port: 5432,
		}, "app", "UPDATE users SET active = 1", "legacy-write-context")
	}()

	select {
	case <-database.execStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for legacy Exec")
	}
	cancel()
	select {
	case result := <-resultCh:
		t.Fatalf("legacy Exec falsely returned on parent cancellation: %#v", result)
	case <-time.After(100 * time.Millisecond):
	}

	close(database.execRelease)
	result := <-resultCh
	if !result.Success || result.CancellationState != connection.QueryCancellationStateUnsupported {
		t.Fatalf("legacy Exec cancellation must report unsupported, got %#v", result)
	}
	select {
	case <-database.execDone:
	default:
		t.Fatal("legacy write result returned before Exec completed")
	}
}

func TestDBQueryMulti_ContextWriteStopsOnParentCancellation(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })

	legacy := &blockingLegacyCancelDB{
		execStarted: make(chan struct{}),
		execRelease: make(chan struct{}),
		execDone:    make(chan struct{}),
	}
	database := &blockingContextCancelDB{
		blockingLegacyCancelDB: legacy,
		contextExecStarted:     make(chan struct{}),
		contextExecDone:        make(chan struct{}),
	}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }

	app := NewApp()
	t.Cleanup(app.Shutdown)
	ctx, cancel := context.WithCancel(context.Background())
	resultCh := make(chan connection.QueryResult, 1)
	go func() {
		resultCh <- NewCLIQueryExecutor(app).DBQueryMulti(ctx, connection.ConnectionConfig{
			Type: "postgres", Host: "context-write.test", Port: 5432,
		}, "app", "UPDATE users SET active = 1", "context-write")
	}()

	select {
	case <-database.contextExecStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for ExecContext")
	}
	cancel()
	select {
	case result := <-resultCh:
		if result.Success || result.CancellationState != "" {
			t.Fatalf("cancelled Context write returned an invalid state: %#v", result)
		}
		data, _ := result.Data.(map[string]any)
		if data["outcomeUnknown"] != true {
			t.Fatalf("dispatched Context write cancellation must keep outcome unknown, got %#v", result)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Context-capable Exec did not stop after parent cancellation")
	}
	select {
	case <-database.contextExecDone:
	default:
		t.Fatal("ExecContext result returned before the driver observed cancellation")
	}
	select {
	case <-legacy.execStarted:
		t.Fatal("Context-capable driver unexpectedly fell back to legacy Exec")
	default:
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

func TestNewQueryExecutionContext_UsesExplicitQueryTimeout(t *testing.T) {
	ctx, cancel := newQueryExecutionContext(connection.ConnectionConfig{
		Type:         "mysql",
		Timeout:      1,
		QueryTimeout: 7,
	})
	defer cancel()

	deadline, ok := ctx.Deadline()
	if !ok {
		t.Fatal("expected explicit query timeout to carry a deadline")
	}
	remaining := time.Until(deadline)
	if remaining <= 0 || remaining > 8*time.Second {
		t.Fatalf("expected deadline around 7s, got remaining=%s", remaining)
	}
}

func TestCLIQueryExecutor_CancelledOpaqueWriteFailureIsUnknown(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })

	const statement = "CREATE TABLE cancelled_write_probe (id INTEGER)"
	database := &fakeBatchWriteDB{
		execErr:           map[string]error{statement: errors.New("driver returned an opaque write failure")},
		execIgnoreContext: true,
	}
	execStarted := make(chan string, 1)
	execRelease := make(chan struct{})
	database.execStarted = execStarted
	database.execRelease = execRelease
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }

	ctx, cancel := context.WithCancel(context.Background())
	resultCh := make(chan connection.QueryResult, 1)
	go func() {
		resultCh <- NewCLIQueryExecutor(NewApp()).DBQueryMulti(ctx, connection.ConnectionConfig{
			Type: "postgres",
			Host: "127.0.0.1",
			Port: 5432,
		}, "app", statement, "cli-cancelled-write")
	}()
	select {
	case <-execStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for write execution")
	}
	cancel()
	close(execRelease)
	result := <-resultCh
	if result.Success {
		t.Fatalf("cancelled write should fail, got %#v", result)
	}
	data, _ := result.Data.(map[string]any)
	if data["outcomeUnknown"] != true {
		t.Fatalf("cancelled opaque write must be outcome-unknown, got %#v", result)
	}
}

func TestCLIQueryExecutor_CancelledBeforeConnectionIsCancelled(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	newDatabaseFunc = func(string) (db.Database, error) { return &fakeBatchWriteDB{}, nil }

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result := NewCLIQueryExecutor(NewApp()).DBQueryMulti(ctx, connection.ConnectionConfig{
		Type: "postgres",
		Host: "cancel-before-connect.test",
		Port: 5432,
	}, "app", "CREATE TABLE cancelled_write_probe (id INTEGER)", "cli-cancel-before-connect")
	if result.Success {
		t.Fatalf("cancelled query should fail, got %#v", result)
	}
	data, _ := result.Data.(map[string]any)
	if data["cancelled"] != true || data["errorKind"] != nil || data["outcomeUnknown"] != nil {
		t.Fatalf("pre-connect cancellation must be classified as cancelled, got %#v", result)
	}
}

func TestCLIQueryExecutor_ContextDeadlineDuringReadIsCancelled(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })

	const statement = "SELECT 1"
	database := &fakeBatchWriteDB{
		queryErr: map[string]error{statement: context.DeadlineExceeded},
	}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }

	result := NewCLIQueryExecutor(NewApp()).DBQueryMulti(
		context.Background(),
		connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432, QueryTimeout: 1},
		"app",
		statement,
		"cli-deadline-read",
	)
	if result.Success {
		t.Fatalf("deadline read should fail, got %#v", result)
	}
	data, _ := result.Data.(map[string]any)
	if data["cancelled"] != true || data["outcomeUnknown"] != nil {
		t.Fatalf("deadline read must be classified as cancelled, got %#v", result)
	}
}

func TestCLIQueryExecutor_ConnectionFailureIsStructured(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	newDatabaseFunc = func(string) (db.Database, error) {
		return nil, errors.New("database authentication failed")
	}

	result := NewCLIQueryExecutor(newSQLAuditTestApp(t)).DBQueryMulti(
		context.Background(),
		connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432},
		"app",
		"SELECT 1",
		"cli-connection-failure",
	)
	data, _ := result.Data.(map[string]any)
	if result.Success || data["errorKind"] != headlessResultErrorKindConnection {
		t.Fatalf("CLI connection failure should be structured, got %#v", result)
	}
}

func TestNewQueryExecutionContext_AllDataSourcesDoNotApplyConnectTimeout(t *testing.T) {
	tests := []struct {
		name   string
		config connection.ConnectionConfig
	}{
		{name: "mysql", config: connection.ConnectionConfig{Type: "mysql", Timeout: 7}},
		{name: "goldendb", config: connection.ConnectionConfig{Type: "goldendb", Timeout: 7}},
		{name: "custom gdb", config: connection.ConnectionConfig{Type: "custom", Driver: "gdb", Timeout: 7}},
		{name: "postgres", config: connection.ConnectionConfig{Type: "postgres", Timeout: 7}},
		{name: "oracle", config: connection.ConnectionConfig{Type: "oracle", Timeout: 7}},
		{name: "sqlserver", config: connection.ConnectionConfig{Type: "sqlserver", Timeout: 7}},
		{name: "elasticsearch", config: connection.ConnectionConfig{Type: "elasticsearch", Timeout: 7}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx, cancel := newQueryExecutionContext(tt.config)

			if _, ok := ctx.Deadline(); ok {
				cancel()
				t.Fatal("expected query context to avoid inheriting the connection-timeout deadline")
			}
			cancel()
			if !errors.Is(ctx.Err(), context.Canceled) {
				t.Fatalf("expected manual cancellation to remain effective, got %v", ctx.Err())
			}
		})
	}
}

func TestNewQueryExecutionContext_DoesNotApplyConnectTimeoutToDuckDBQueries(t *testing.T) {
	ctx, cancel := newQueryExecutionContext(connection.ConnectionConfig{Type: "duckdb", Timeout: 1})
	defer cancel()

	if _, ok := ctx.Deadline(); ok {
		t.Fatal("expected DuckDB query context to avoid connection-timeout deadline")
	}
}
