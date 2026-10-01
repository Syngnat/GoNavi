package app

import (
	"context"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/uievents"
)

type queryProgressEventRecorder struct {
	mu     sync.Mutex
	events []queryExecutionProgressEvent
}

func (r *queryProgressEventRecorder) Emit(name string, args ...any) {
	if name != queryProgressEventName || len(args) != 1 {
		return
	}
	event, ok := args[0].(queryExecutionProgressEvent)
	if !ok {
		return
	}
	r.mu.Lock()
	r.events = append(r.events, event)
	r.mu.Unlock()
}

func (r *queryProgressEventRecorder) snapshot() []queryExecutionProgressEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]queryExecutionProgressEvent, len(r.events))
	copy(out, r.events)
	return out
}

type delayedExecDB struct {
	db.Database
	started  chan struct{}
	release  chan struct{}
	affected int64
}

func (d *delayedExecDB) Connect(connection.ConnectionConfig) error { return nil }
func (d *delayedExecDB) Close() error                              { return nil }
func (d *delayedExecDB) Ping() error                               { return nil }
func (d *delayedExecDB) Query(string) ([]map[string]interface{}, []string, error) {
	return nil, nil, nil
}
func (d *delayedExecDB) Exec(string) (int64, error) { return d.affected, nil }
func (d *delayedExecDB) ExecContext(ctx context.Context, _ string) (int64, error) {
	close(d.started)
	select {
	case <-ctx.Done():
		return 0, ctx.Err()
	case <-d.release:
		return d.affected, nil
	}
}

func TestQueryExecutionAffectedRows(t *testing.T) {
	t.Parallel()

	if got, ok := queryExecutionAffectedRows(connection.QueryResult{Data: map[string]int64{"affectedRows": 100000}}); !ok || got != 100000 {
		t.Fatalf("map[string]int64 affectedRows = (%d, %v), want 100000", got, ok)
	}
	sets := []connection.ResultSetData{{
		Columns: []string{"affectedRows"},
		Rows:    []map[string]interface{}{{"affectedRows": int64(12)}},
	}}
	if got, ok := queryExecutionAffectedRows(connection.QueryResult{Data: sets}); !ok || got != 12 {
		t.Fatalf("result set affectedRows = (%d, %v), want 12", got, ok)
	}
}

func TestQueryExecutionLifecycleEmitsHeartbeatAndDone(t *testing.T) {
	originalInterval := queryExecutionHeartbeatInterval
	queryExecutionHeartbeatInterval = 20 * time.Millisecond
	t.Cleanup(func() { queryExecutionHeartbeatInterval = originalInterval })

	recorder := &queryProgressEventRecorder{}
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.ctx = uievents.WithEmitter(context.Background(), recorder)

	lifecycle := application.beginQueryExecutionLifecycle("query-delete-1")
	time.Sleep(50 * time.Millisecond)
	lifecycle.complete(connection.QueryResult{
		Success: true,
		Data:    map[string]int64{"affectedRows": 100000},
		QueryID: "query-delete-1",
	})
	time.Sleep(30 * time.Millisecond)

	events := recorder.snapshot()
	if len(events) < 3 {
		t.Fatalf("expected start, heartbeat, and done events, got %#v", events)
	}
	if events[0].Status != queryExecutionStatusRunning || events[0].Stage != queryExecutionStageStarting {
		t.Fatalf("unexpected first event: %#v", events[0])
	}
	foundHeartbeat := false
	for _, event := range events {
		if event.Status == queryExecutionStatusRunning && event.Stage == queryExecutionStageExecuting {
			foundHeartbeat = true
		}
	}
	if !foundHeartbeat {
		t.Fatalf("missing heartbeat event: %#v", events)
	}
	last := events[len(events)-1]
	if last.Status != queryExecutionStatusDone || !last.HasAffectedRows || last.AffectedRows != 100000 {
		t.Fatalf("expected done event with affected rows, got %#v", last)
	}
}

func TestQueryExecutionLifecycleKeepsStartingStageUntilConnectionReady(t *testing.T) {
	originalInterval := queryExecutionHeartbeatInterval
	queryExecutionHeartbeatInterval = 10 * time.Millisecond
	t.Cleanup(func() { queryExecutionHeartbeatInterval = originalInterval })

	recorder := &queryProgressEventRecorder{}
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.ctx = uievents.WithEmitter(context.Background(), recorder)

	lifecycle := application.beginQueryExecutionLifecycleWithConnection("query-connecting-1")
	time.Sleep(60 * time.Millisecond)
	for _, event := range recorder.snapshot() {
		if event.Stage == queryExecutionStageExecuting {
			t.Fatalf("heartbeat must stay in starting while connecting: %#v", event)
		}
	}

	lifecycle.markExecuting()
	lifecycle.markExecuting() // 幂等：不重复上报
	time.Sleep(30 * time.Millisecond)
	lifecycle.complete(connection.QueryResult{Success: true, QueryID: "query-connecting-1"})

	firstExecuting := -1
	for index, event := range recorder.snapshot() {
		if event.Stage == queryExecutionStageExecuting {
			firstExecuting = index
			break
		}
	}
	if firstExecuting < 0 {
		t.Fatalf("markExecuting must emit an executing event: %#v", recorder.snapshot())
	}
	if event := recorder.snapshot()[firstExecuting]; event.Status != queryExecutionStatusRunning {
		t.Fatalf("unexpected executing event: %#v", event)
	}
}

func TestCancelQueryEmitsCancellingProgress(t *testing.T) {
	recorder := &queryProgressEventRecorder{}
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.ctx = uievents.WithEmitter(context.Background(), recorder)

	_, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	application.registerRunningQuery("query-cancel-1", cancel, true)
	result := application.CancelQuery("query-cancel-1")
	if !result.Success {
		t.Fatalf("CancelQuery failed: %#v", result)
	}
	events := recorder.snapshot()
	if len(events) != 1 || events[0].Status != queryExecutionStatusCancelling {
		t.Fatalf("expected cancelling progress event, got %#v", events)
	}
}

func TestDBQueryWithCancelEmitsWriteLifecycle(t *testing.T) {
	originalInterval := queryExecutionHeartbeatInterval
	queryExecutionHeartbeatInterval = 15 * time.Millisecond
	t.Cleanup(func() { queryExecutionHeartbeatInterval = originalInterval })

	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	database := &delayedExecDB{
		started:  make(chan struct{}),
		release:  make(chan struct{}),
		affected: 100000,
	}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }

	recorder := &queryProgressEventRecorder{}
	application := NewApp()
	t.Cleanup(application.Shutdown)
	application.ctx = uievents.WithEmitter(context.Background(), recorder)

	resultCh := make(chan connection.QueryResult, 1)
	go func() {
		resultCh <- application.DBQueryWithCancel(connection.ConnectionConfig{
			Type: "postgres", Host: "lifecycle-delete.test", Port: 5432,
		}, "app", "DELETE FROM t", "query-lifecycle-delete")
	}()

	select {
	case <-database.started:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for DELETE execution")
	}
	deadline := time.Now().Add(time.Second)
	for {
		events := recorder.snapshot()
		heartbeats := 0
		for _, event := range events {
			if event.QueryID == "query-lifecycle-delete" && event.Stage == queryExecutionStageExecuting {
				heartbeats++
			}
		}
		if heartbeats > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("missing executing heartbeat, events=%#v", events)
		}
		time.Sleep(10 * time.Millisecond)
	}
	close(database.release)

	result := <-resultCh
	if !result.Success {
		t.Fatalf("DELETE failed: %#v", result)
	}
	events := recorder.snapshot()
	last := events[len(events)-1]
	if last.Status != queryExecutionStatusDone || last.AffectedRows != 100000 {
		t.Fatalf("expected terminal done event with 100000 rows, got %#v", last)
	}
}
