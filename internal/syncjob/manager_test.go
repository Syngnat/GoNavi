package syncjob

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestManagerQueuesRunsForTheSameJobWithoutOverlap(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "queue")

	started := make(chan string, 2)
	release := make(chan struct{}, 2)
	var active atomic.Int32
	var maxActive atomic.Int32
	executor := ExecutorFunc(func(ctx context.Context, request ExecutionRequest, _ RunReporter) (ExecutionOutcome, error) {
		current := active.Add(1)
		defer active.Add(-1)
		for {
			maximum := maxActive.Load()
			if current <= maximum || maxActive.CompareAndSwap(maximum, current) {
				break
			}
		}
		started <- request.Run.ID
		select {
		case <-ctx.Done():
			return ExecutionOutcome{}, context.Cause(ctx)
		case <-release:
			return ExecutionOutcome{RowsInserted: 1}, nil
		}
	})
	manager, err := NewManager(context.Background(), store, executor, ManagerOptions{
		SchedulerInterval: time.Hour,
		HeartbeatInterval: time.Hour,
	})
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := manager.Shutdown(ctx); err != nil {
			t.Errorf("shutdown manager: %v", err)
		}
	})

	first, err := manager.StartRun(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("start first run: %v", err)
	}
	if got := receiveString(t, started); got != first.ID {
		t.Fatalf("first executed run = %q, want %q", got, first.ID)
	}
	second, err := manager.StartRun(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("queue second run: %v", err)
	}
	assertRunStatus(t, store, second.ID, RunStatusQueued)
	select {
	case got := <-started:
		t.Fatalf("second run %q overlapped first run", got)
	case <-time.After(75 * time.Millisecond):
	}

	release <- struct{}{}
	waitRunStatus(t, store, first.ID, RunStatusSucceeded)
	if got := receiveString(t, started); got != second.ID {
		t.Fatalf("second executed run = %q, want %q", got, second.ID)
	}
	release <- struct{}{}
	waitRunStatus(t, store, second.ID, RunStatusSucceeded)
	if got := maxActive.Load(); got != 1 {
		t.Fatalf("maximum concurrent executions = %d, want 1", got)
	}

	for _, runID := range []string{first.ID, second.ID} {
		events, err := store.ListRunEvents(context.Background(), runID, 0, 20)
		if err != nil {
			t.Fatalf("list events for %s: %v", runID, err)
		}
		if len(events) != 3 {
			t.Fatalf("event count for %s = %d, want 3: %#v", runID, len(events), events)
		}
		for index, event := range events {
			if event.Sequence != int64(index+1) {
				t.Fatalf("event sequence at %d = %d, want %d", index, event.Sequence, index+1)
			}
		}
	}
}

func TestManagerCancelsQueuedAndRunningRuns(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "queue")
	started := make(chan string, 2)
	exited := make(chan struct{}, 1)
	executor := ExecutorFunc(func(ctx context.Context, request ExecutionRequest, _ RunReporter) (ExecutionOutcome, error) {
		started <- request.Run.ID
		<-ctx.Done()
		exited <- struct{}{}
		return ExecutionOutcome{}, context.Cause(ctx)
	})
	manager := newTestManager(t, store, executor)

	first, err := manager.StartRun(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("start first run: %v", err)
	}
	if got := receiveString(t, started); got != first.ID {
		t.Fatalf("executed run = %q, want %q", got, first.ID)
	}
	second, err := manager.StartRun(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("queue second run: %v", err)
	}
	if err := manager.CancelRun(context.Background(), second.ID); err != nil {
		t.Fatalf("cancel queued run: %v", err)
	}
	waitRunStatus(t, store, second.ID, RunStatusCanceled)
	if err := manager.CancelRun(context.Background(), first.ID); err != nil {
		t.Fatalf("cancel running run: %v", err)
	}
	waitRunStatus(t, store, first.ID, RunStatusCanceled)
	select {
	case <-exited:
	case <-time.After(time.Second):
		t.Fatal("executor did not observe cancellation")
	}
	select {
	case got := <-started:
		t.Fatalf("canceled queued run unexpectedly executed: %s", got)
	case <-time.After(75 * time.Millisecond):
	}
	events, err := store.ListRunEvents(context.Background(), first.ID, 0, 20)
	if err != nil {
		t.Fatalf("list canceled run events: %v", err)
	}
	if len(events) < 4 || events[len(events)-2].Type != RunEventCancelling || events[len(events)-1].Type != RunEventCanceled {
		t.Fatalf("cancellation event order = %#v", events)
	}
}

func TestManagerForbidPolicyRejectsAnUnfinishedRun(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "forbid")
	started := make(chan string, 1)
	executor := ExecutorFunc(func(ctx context.Context, request ExecutionRequest, _ RunReporter) (ExecutionOutcome, error) {
		started <- request.Run.ID
		<-ctx.Done()
		return ExecutionOutcome{}, context.Cause(ctx)
	})
	manager := newTestManager(t, store, executor)
	first, err := manager.StartRun(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("start first run: %v", err)
	}
	if got := receiveString(t, started); got != first.ID {
		t.Fatalf("executed run = %q, want %q", got, first.ID)
	}
	if _, err := manager.StartRun(context.Background(), definition.ID); !errors.Is(err, ErrRunAlreadyActive) {
		t.Fatalf("start overlapping run error = %v, want ErrRunAlreadyActive", err)
	}
}

func TestManagerResumesAFailedRunFromItsCheckpoint(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "forbid")
	requests := make(chan ExecutionRequest, 2)
	var calls atomic.Int32
	executor := ExecutorFunc(func(_ context.Context, request ExecutionRequest, reporter RunReporter) (ExecutionOutcome, error) {
		requests <- request
		if calls.Add(1) == 1 {
			if err := reporter.SaveCheckpoint(Checkpoint{
				Kind:       "watermark",
				Table:      "orders",
				Phase:      "copy",
				CursorType: "primary_key",
				Cursor:     []byte(`{"id":42}`),
			}); err != nil {
				return ExecutionOutcome{}, err
			}
			return ExecutionOutcome{RowsInserted: 42, Resumable: true}, errors.New("target unavailable")
		}
		return ExecutionOutcome{RowsInserted: 1}, nil
	})
	manager := newTestManager(t, store, executor)

	failed, err := manager.StartRun(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("start run: %v", err)
	}
	waitRunStatus(t, store, failed.ID, RunStatusFailed)
	resumed, err := manager.ResumeRun(context.Background(), failed.ID)
	if err != nil {
		t.Fatalf("resume run: %v", err)
	}
	if resumed.ParentRunID != failed.ID || resumed.Attempt != 2 || resumed.Trigger != RunTriggerResume {
		t.Fatalf("resumed run lineage = %#v", resumed)
	}
	waitRunStatus(t, store, resumed.ID, RunStatusSucceeded)

	firstRequest := receiveRequest(t, requests)
	secondRequest := receiveRequest(t, requests)
	if firstRequest.Checkpoint != nil {
		t.Fatalf("initial request unexpectedly received checkpoint: %#v", firstRequest.Checkpoint)
	}
	if secondRequest.Checkpoint == nil || secondRequest.Checkpoint.RunID != failed.ID || string(secondRequest.Checkpoint.Cursor) != `{"id":42}` {
		t.Fatalf("resume checkpoint = %#v", secondRequest.Checkpoint)
	}
}

func TestManagerClearsCheckpointAfterSuccessfulSnapshot(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "forbid")
	executor := ExecutorFunc(func(_ context.Context, _ ExecutionRequest, reporter RunReporter) (ExecutionOutcome, error) {
		if err := reporter.SaveCheckpoint(Checkpoint{
			Version:    1,
			Kind:       "resume",
			Table:      "orders",
			Phase:      "mapping_completed",
			CursorType: "mapping_index",
			Cursor:     json.RawMessage(`{"nextMapping":1}`),
		}); err != nil {
			return ExecutionOutcome{}, err
		}
		return ExecutionOutcome{RowsInserted: 1}, nil
	})
	manager, err := NewManager(context.Background(), store, executor, ManagerOptions{
		SchedulerInterval: time.Hour,
		HeartbeatInterval: time.Hour,
	})
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = manager.Shutdown(ctx)
	})
	run, err := manager.StartRun(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("start run: %v", err)
	}
	waitRunStatus(t, store, run.ID, RunStatusSucceeded)
	if _, err := store.GetCheckpoint(context.Background(), definition.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("completed snapshot checkpoint error = %v, want ErrNotFound", err)
	}
}

func TestManagerKeepsCheckpointAfterSuccessfulWatermarkRun(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "forbid")
	definition.IncrementalMode = IncrementalWatermark
	definition.Mappings[0].Watermark = &WatermarkSpec{Column: "updated_at", TieBreakerColumns: []string{"id"}}
	definition, err := store.PutJob(context.Background(), definition)
	if err != nil {
		t.Fatalf("update watermark definition: %v", err)
	}
	executor := ExecutorFunc(func(_ context.Context, request ExecutionRequest, reporter RunReporter) (ExecutionOutcome, error) {
		if request.Definition.IncrementalMode != IncrementalWatermark {
			return ExecutionOutcome{}, errors.New("executor received non-watermark definition")
		}
		if err := reporter.SaveCheckpoint(Checkpoint{
			Version:    1,
			Kind:       "watermark",
			Table:      "orders",
			Phase:      "batch_committed",
			CursorType: "watermark_map",
			Cursor:     json.RawMessage(`{"orders":{"updatedAt":"2026-08-08T00:00:00Z","id":42}}`),
		}); err != nil {
			return ExecutionOutcome{}, err
		}
		return ExecutionOutcome{RowsUpdated: 1}, nil
	})
	manager := newTestManager(t, store, executor)
	run, err := manager.StartRun(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("start run: %v", err)
	}
	waitRunStatus(t, store, run.ID, RunStatusSucceeded)
	checkpoint, err := store.GetCheckpoint(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("get watermark checkpoint: %v", err)
	}
	if checkpoint.RunID != run.ID || checkpoint.Kind != "watermark" {
		t.Fatalf("unexpected watermark checkpoint: %#v", checkpoint)
	}
}

func TestManagerRecoversStaleRunningAndQueuedRunsOnStartup(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "queue")
	snapshot, err := json.Marshal(definition)
	if err != nil {
		t.Fatalf("marshal definition: %v", err)
	}
	stale, err := store.CreateRun(context.Background(), RunRecord{
		JobID:              definition.ID,
		JobRevision:        definition.Revision,
		Status:             RunStatusRunning,
		StartedAt:          time.Now().Add(-time.Hour).UnixMilli(),
		HeartbeatAt:        time.Now().Add(-time.Hour).UnixMilli(),
		DefinitionSnapshot: snapshot,
	})
	if err != nil {
		t.Fatalf("create stale run: %v", err)
	}
	queued, err := store.CreateRun(context.Background(), RunRecord{
		JobID:              definition.ID,
		JobRevision:        definition.Revision,
		Status:             RunStatusQueued,
		DefinitionSnapshot: snapshot,
	})
	if err != nil {
		t.Fatalf("create queued run: %v", err)
	}
	executed := make(chan string, 1)
	manager, err := NewManager(context.Background(), store, ExecutorFunc(func(_ context.Context, request ExecutionRequest, _ RunReporter) (ExecutionOutcome, error) {
		executed <- request.Run.ID
		return ExecutionOutcome{}, nil
	}), ManagerOptions{
		SchedulerInterval:  time.Hour,
		HeartbeatInterval:  time.Hour,
		RecoveryStaleAfter: time.Second,
	})
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := manager.Shutdown(ctx); err != nil {
			t.Errorf("shutdown manager: %v", err)
		}
	})

	recovered := waitRunStatus(t, store, stale.ID, RunStatusInterrupted)
	if !recovered.Resumable || recovered.FinishedAt == 0 {
		t.Fatalf("recovered stale run = %#v", recovered)
	}
	if got := receiveString(t, executed); got != queued.ID {
		t.Fatalf("restored queued run = %q, want %q", got, queued.ID)
	}
	waitRunStatus(t, store, queued.ID, RunStatusSucceeded)
	events, err := store.ListRunEvents(context.Background(), stale.ID, 0, 10)
	if err != nil {
		t.Fatalf("list stale run events: %v", err)
	}
	if len(events) != 1 || events[0].Type != RunEventInterrupted {
		t.Fatalf("stale run events = %#v", events)
	}
}

func TestManagersUseSQLiteLeaseToScheduleOneRun(t *testing.T) {
	databasePath := t.TempDir() + "/shared-sync-jobs.db"
	firstStore, err := Open(databasePath)
	if err != nil {
		t.Fatalf("open first store: %v", err)
	}
	t.Cleanup(func() { _ = firstStore.Close() })
	secondStore, err := Open(databasePath)
	if err != nil {
		t.Fatalf("open second store: %v", err)
	}
	t.Cleanup(func() { _ = secondStore.Close() })
	definition, err := firstStore.PutJob(context.Background(), JobDefinition{
		Name:              "scheduled orders sync",
		Enabled:           true,
		Kind:              JobKindReconcile,
		IncrementalMode:   IncrementalSnapshot,
		Source:            EndpointRef{ConnectionID: "source"},
		Target:            EndpointRef{ConnectionID: "target"},
		Mappings:          []TableMapping{{SourceTable: "orders", TargetTable: "orders", Enabled: true}},
		ConcurrencyPolicy: "queue",
		Schedule: ScheduleSpec{
			Kind:            ScheduleInterval,
			IntervalSeconds: 10,
			MisfirePolicy:   "run_once",
		},
	})
	if err != nil {
		t.Fatalf("put scheduled job: %v", err)
	}
	dueAt := time.Now().Add(-time.Second).UnixMilli()
	if _, err := firstStore.db.ExecContext(context.Background(), `UPDATE data_sync_jobs SET next_run_at = ? WHERE id = ?`, dueAt, definition.ID); err != nil {
		t.Fatalf("make job due: %v", err)
	}

	var executions atomic.Int32
	executor := ExecutorFunc(func(context.Context, ExecutionRequest, RunReporter) (ExecutionOutcome, error) {
		executions.Add(1)
		return ExecutionOutcome{}, nil
	})
	firstManager := newScheduledTestManager(t, firstStore, executor, "owner-a")
	_ = firstManager
	secondManager := newScheduledTestManager(t, secondStore, executor, "owner-b")
	_ = secondManager

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		runs, listErr := firstStore.ListRuns(context.Background(), definition.ID, 10)
		if listErr == nil && len(runs) == 1 && runs[0].Status == RunStatusSucceeded {
			if runs[0].Trigger != RunTriggerSchedule {
				t.Fatalf("scheduled run trigger = %q", runs[0].Trigger)
			}
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond)
	runs, err := firstStore.ListRuns(context.Background(), definition.ID, 10)
	if err != nil {
		t.Fatalf("list scheduled runs: %v", err)
	}
	if len(runs) != 1 || executions.Load() != 1 {
		t.Fatalf("scheduled runs = %d, executions = %d; want one", len(runs), executions.Load())
	}
}

func TestManagerShutdownCancelsExecutorsAndWaitsForGoroutines(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "queue")
	started := make(chan struct{})
	exited := make(chan struct{})
	executor := ExecutorFunc(func(ctx context.Context, _ ExecutionRequest, _ RunReporter) (ExecutionOutcome, error) {
		close(started)
		<-ctx.Done()
		time.Sleep(25 * time.Millisecond)
		close(exited)
		return ExecutionOutcome{Resumable: true}, context.Cause(ctx)
	})
	manager, err := NewManager(context.Background(), store, executor, ManagerOptions{
		SchedulerInterval: time.Hour,
		HeartbeatInterval: time.Hour,
	})
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	run, err := manager.StartRun(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("start run: %v", err)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("executor did not start")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := manager.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown manager: %v", err)
	}
	select {
	case <-exited:
	default:
		t.Fatal("shutdown returned before executor goroutine exited")
	}
	recovered := waitRunStatus(t, store, run.ID, RunStatusInterrupted)
	if !recovered.Resumable {
		t.Fatalf("shutdown-interrupted run is not resumable: %#v", recovered)
	}
}

func TestManagerConstructorContextCancellationStopsExecutor(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "queue")
	started := make(chan struct{})
	exited := make(chan error, 1)
	executor := ExecutorFunc(func(ctx context.Context, _ ExecutionRequest, _ RunReporter) (ExecutionOutcome, error) {
		close(started)
		<-ctx.Done()
		cause := context.Cause(ctx)
		exited <- cause
		return ExecutionOutcome{}, cause
	})
	managerCtx, cancelManager := context.WithCancel(context.Background())
	manager, err := NewManager(managerCtx, store, executor, ManagerOptions{
		SchedulerInterval: time.Hour,
		HeartbeatInterval: time.Hour,
	})
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := manager.Shutdown(ctx); err != nil {
			t.Errorf("shutdown manager: %v", err)
		}
	})
	if _, err := manager.StartRun(context.Background(), definition.ID); err != nil {
		t.Fatalf("start run: %v", err)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("executor did not start")
	}

	cancelManager()
	select {
	case <-manager.ctx.Done():
	case <-time.After(250 * time.Millisecond):
		t.Fatal("manager runtime context did not observe constructor context cancellation")
	}
	select {
	case cause := <-exited:
		if !errors.Is(cause, context.Canceled) {
			t.Fatalf("executor cancellation cause = %v, want context.Canceled", cause)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("executor did not observe constructor context cancellation")
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := manager.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown after constructor context cancellation: %v", err)
	}
}

func TestManagerAutomaticallyResumesRecoveredRunWhenConfigured(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "forbid")
	definition.ResumePolicy = "auto"
	definition, err := store.PutJob(context.Background(), definition)
	if err != nil {
		t.Fatalf("enable auto resume: %v", err)
	}
	snapshot, err := json.Marshal(definition)
	if err != nil {
		t.Fatalf("marshal definition: %v", err)
	}
	stale, err := store.CreateRun(context.Background(), RunRecord{
		JobID:              definition.ID,
		JobRevision:        definition.Revision,
		Status:             RunStatusRunning,
		StartedAt:          time.Now().Add(-time.Hour).UnixMilli(),
		HeartbeatAt:        time.Now().Add(-time.Hour).UnixMilli(),
		DefinitionSnapshot: snapshot,
	})
	if err != nil {
		t.Fatalf("create stale run: %v", err)
	}
	if _, err := store.PutCheckpoint(context.Background(), Checkpoint{
		Kind:               "watermark",
		JobID:              definition.ID,
		RunID:              stale.ID,
		DefinitionRevision: definition.Revision,
		Table:              "orders",
		Phase:              "copy",
		CursorType:         "primary_key",
		Cursor:             []byte(`{"id":99}`),
	}); err != nil {
		t.Fatalf("put checkpoint: %v", err)
	}
	requests := make(chan ExecutionRequest, 1)
	manager, err := NewManager(context.Background(), store, ExecutorFunc(func(_ context.Context, request ExecutionRequest, _ RunReporter) (ExecutionOutcome, error) {
		requests <- request
		return ExecutionOutcome{}, nil
	}), ManagerOptions{
		SchedulerInterval:  time.Hour,
		HeartbeatInterval:  time.Hour,
		RecoveryStaleAfter: time.Second,
	})
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = manager.Shutdown(ctx)
	})
	request := receiveRequest(t, requests)
	if request.Run.Trigger != RunTriggerResume || request.Run.ParentRunID != stale.ID || request.Checkpoint == nil || request.Checkpoint.RunID != stale.ID {
		t.Fatalf("automatic resume request = %#v", request)
	}
	waitRunStatus(t, store, request.Run.ID, RunStatusSucceeded)
}

func TestManagerPersistsReporterOutputBeforePublishingHooks(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "queue")
	var hookMu sync.Mutex
	hooked := make([]RunEvent, 0)
	executor := ExecutorFunc(func(_ context.Context, _ ExecutionRequest, reporter RunReporter) (ExecutionOutcome, error) {
		if err := reporter.ReportProgress(RunProgress{Current: 3, Total: 5, Table: "orders", Stage: "write", Message: "batch 3"}); err != nil {
			return ExecutionOutcome{}, err
		}
		if err := reporter.AppendErrorRow(ErrorRow{Error: "duplicate key", SourceTable: "orders", TargetTable: "orders", SourceKey: []byte(`{"id":3}`)}); err != nil {
			return ExecutionOutcome{}, err
		}
		if err := reporter.Emit(RunEventLog, "executor log", []byte(`{"level":"info"}`)); err != nil {
			return ExecutionOutcome{}, err
		}
		return ExecutionOutcome{RowsInserted: 2, RowsFailed: 1, Message: "completed with errors"}, nil
	})
	manager, err := NewManager(context.Background(), store, executor, ManagerOptions{
		SchedulerInterval: time.Hour,
		HeartbeatInterval: time.Hour,
		Hooks: ManagerHooks{OnRunEvent: func(event RunEvent) {
			persisted, listErr := store.ListRunEvents(context.Background(), event.RunID, event.Sequence-1, 1)
			if listErr != nil || len(persisted) != 1 || persisted[0].Sequence != event.Sequence {
				t.Errorf("hook observed event before persistence: event=%#v persisted=%#v err=%v", event, persisted, listErr)
			}
			switch event.Type {
			case RunEventSucceeded, RunEventPartial, RunEventFailed, RunEventCanceled, RunEventInterrupted:
				run, runErr := store.GetRun(context.Background(), event.RunID)
				if runErr != nil || run.Status != event.Status || run.OwnerToken != "" {
					t.Errorf("hook observed terminal event before run completion commit: event=%#v run=%#v err=%v", event, run, runErr)
				}
			}
			hookMu.Lock()
			hooked = append(hooked, event)
			hookMu.Unlock()
		}},
	})
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = manager.Shutdown(ctx)
	})
	run, err := manager.StartRun(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("start run: %v", err)
	}
	completed := waitRunStatus(t, store, run.ID, RunStatusPartial)
	if completed.Current != 3 || completed.Total != 5 || completed.RowsInserted != 2 || completed.RowsFailed != 1 {
		t.Fatalf("persisted run output = %#v", completed)
	}
	errorRows, err := store.ListErrorRows(context.Background(), run.ID, ErrorRowPending, 10)
	if err != nil || len(errorRows) != 1 || errorRows[0].Error != "duplicate key" {
		t.Fatalf("persisted error rows = %#v, err=%v", errorRows, err)
	}
	wantTypes := []RunEventType{RunEventQueued, RunEventStarted, RunEventProgress, RunEventErrorRow, RunEventLog, RunEventPartial}
	events := waitRunEventCount(t, store, run.ID, len(wantTypes))
	for index, want := range wantTypes {
		if events[index].Type != want {
			t.Fatalf("event %d type = %q, want %q", index, events[index].Type, want)
		}
	}
	var hookCount int
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		hookMu.Lock()
		hookCount = len(hooked)
		hookMu.Unlock()
		if hookCount == len(events) {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if hookCount != len(events) {
		t.Fatalf("hook event count = %d, persisted = %d", hookCount, len(events))
	}
}

func TestManagerRetriesTerminalRunWithOriginalSnapshotAndLineage(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "forbid")
	requests := make(chan ExecutionRequest, 2)
	var calls atomic.Int32
	executor := ExecutorFunc(func(_ context.Context, request ExecutionRequest, _ RunReporter) (ExecutionOutcome, error) {
		requests <- request
		if calls.Add(1) == 1 {
			return ExecutionOutcome{}, errors.New("temporary target failure")
		}
		return ExecutionOutcome{}, nil
	})
	manager := newTestManager(t, store, executor)

	failed, err := manager.StartRun(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("start run: %v", err)
	}
	waitRunStatus(t, store, failed.ID, RunStatusFailed)
	retried, err := manager.RetryRun(context.Background(), failed.ID)
	if err != nil {
		t.Fatalf("retry failed run: %v", err)
	}
	if retried.Trigger != RunTriggerRetry || retried.ParentRunID != failed.ID || retried.Attempt != failed.Attempt+1 {
		t.Fatalf("retry lineage = %#v", retried)
	}
	waitRunStatus(t, store, retried.ID, RunStatusSucceeded)
	_ = receiveRequest(t, requests)
	retryRequest := receiveRequest(t, requests)
	if retryRequest.Definition.ID != definition.ID || retryRequest.Definition.Revision != definition.Revision {
		t.Fatalf("retry definition snapshot = %#v", retryRequest.Definition)
	}
	if _, err := manager.RetryRun(context.Background(), retried.ID); !errors.Is(err, ErrRunNotRetryable) {
		t.Fatalf("retry succeeded run error = %v, want ErrRunNotRetryable", err)
	}
}

func TestManagerRejectsRetryWhenOriginalSnapshotDoesNotMatchRun(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "forbid")
	snapshot, err := json.Marshal(definition)
	if err != nil {
		t.Fatalf("marshal definition: %v", err)
	}
	run, err := store.CreateRun(context.Background(), RunRecord{
		JobID:              definition.ID,
		JobRevision:        definition.Revision + 1,
		Status:             RunStatusFailed,
		DefinitionSnapshot: snapshot,
	})
	if err != nil {
		t.Fatalf("create inconsistent run: %v", err)
	}
	manager := newTestManager(t, store, ExecutorFunc(func(context.Context, ExecutionRequest, RunReporter) (ExecutionOutcome, error) {
		t.Fatal("inconsistent retry must not execute")
		return ExecutionOutcome{}, nil
	}))
	if _, err := manager.RetryRun(context.Background(), run.ID); err == nil || errors.Is(err, ErrRunNotRetryable) {
		t.Fatalf("inconsistent retry error = %v, want snapshot consistency error", err)
	}
}

func TestManagerRetriesAfterMetadataOnlyTaskRevisionChanges(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "forbid")
	manager := newTestManager(t, store, ExecutorFunc(func(context.Context, ExecutionRequest, RunReporter) (ExecutionOutcome, error) {
		return ExecutionOutcome{}, errors.New("temporary target failure")
	}))
	failed, err := manager.StartRun(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("start failing run: %v", err)
	}
	waitRunStatus(t, store, failed.ID, RunStatusFailed)
	definition.Name = "renamed task"
	if _, err := store.PutJob(context.Background(), definition); err != nil {
		t.Fatalf("update task: %v", err)
	}
	updated, err := store.GetJob(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("get renamed task: %v", err)
	}
	retried, err := manager.RetryRun(context.Background(), failed.ID)
	if err != nil {
		t.Fatalf("retry after metadata change: %v", err)
	}
	if retried.JobRevision != updated.Revision {
		t.Fatalf("retry revision = %d, want current %d", retried.JobRevision, updated.Revision)
	}
}

func TestManagerRejectsRetryAfterExecutionPlanChanges(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "forbid")
	manager := newTestManager(t, store, ExecutorFunc(func(context.Context, ExecutionRequest, RunReporter) (ExecutionOutcome, error) {
		return ExecutionOutcome{}, errors.New("temporary target failure")
	}))
	failed, err := manager.StartRun(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("start failing run: %v", err)
	}
	waitRunStatus(t, store, failed.ID, RunStatusFailed)
	definition.Mappings[0].TargetTable = "orders_v2"
	if _, err := store.PutJob(context.Background(), definition); err != nil {
		t.Fatalf("update task plan: %v", err)
	}
	if _, err := manager.RetryRun(context.Background(), failed.ID); !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("retry changed plan error = %v, want ErrRevisionConflict", err)
	}
}

func TestManagerRetryObeysForbidConcurrencyPolicy(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "forbid")
	started := make(chan string, 1)
	var calls atomic.Int32
	executor := ExecutorFunc(func(ctx context.Context, request ExecutionRequest, _ RunReporter) (ExecutionOutcome, error) {
		if calls.Add(1) == 1 {
			return ExecutionOutcome{}, errors.New("first run failed")
		}
		started <- request.Run.ID
		<-ctx.Done()
		return ExecutionOutcome{}, context.Cause(ctx)
	})
	manager := newTestManager(t, store, executor)
	failed, err := manager.StartRun(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("start failing run: %v", err)
	}
	waitRunStatus(t, store, failed.ID, RunStatusFailed)
	blocker, err := manager.StartRun(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("start blocking run: %v", err)
	}
	if got := receiveString(t, started); got != blocker.ID {
		t.Fatalf("blocking run = %q, want %q", got, blocker.ID)
	}
	if _, err := manager.RetryRun(context.Background(), failed.ID); !errors.Is(err, ErrRunAlreadyActive) {
		t.Fatalf("retry during active run error = %v, want ErrRunAlreadyActive", err)
	}
	if err := manager.CancelRun(context.Background(), blocker.ID); err != nil {
		t.Fatalf("cancel blocking run: %v", err)
	}
	waitRunStatus(t, store, blocker.ID, RunStatusCanceled)
}

func openTestStore(t *testing.T) *Store {
	t.Helper()
	store, err := Open(t.TempDir() + "/sync-jobs.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close store: %v", err)
		}
	})
	return store
}

func newTestManager(t *testing.T, store *Store, executor Executor) *Manager {
	t.Helper()
	manager, err := NewManager(context.Background(), store, executor, ManagerOptions{
		SchedulerInterval: time.Hour,
		HeartbeatInterval: time.Hour,
	})
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := manager.Shutdown(ctx); err != nil {
			t.Errorf("shutdown manager: %v", err)
		}
	})
	return manager
}

func newScheduledTestManager(t *testing.T, store *Store, executor Executor, owner string) *Manager {
	t.Helper()
	manager, err := NewManager(context.Background(), store, executor, ManagerOptions{
		SchedulerInterval:  10 * time.Millisecond,
		LeaseTTL:           100 * time.Millisecond,
		HeartbeatInterval:  time.Hour,
		RecoveryStaleAfter: time.Hour,
		LeaseOwner:         owner,
	})
	if err != nil {
		t.Fatalf("new scheduled manager: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := manager.Shutdown(ctx); err != nil {
			t.Errorf("shutdown scheduled manager: %v", err)
		}
	})
	return manager
}

func putTestJob(t *testing.T, store *Store, concurrencyPolicy string) JobDefinition {
	t.Helper()
	definition, err := store.PutJob(context.Background(), JobDefinition{
		Name:              "orders sync",
		Enabled:           true,
		Kind:              JobKindReconcile,
		IncrementalMode:   IncrementalSnapshot,
		Source:            EndpointRef{ConnectionID: "source"},
		Target:            EndpointRef{ConnectionID: "target"},
		Mappings:          []TableMapping{{SourceTable: "orders", TargetTable: "orders", Enabled: true}},
		ConcurrencyPolicy: concurrencyPolicy,
	})
	if err != nil {
		t.Fatalf("put test job: %v", err)
	}
	return definition
}

func receiveString(t *testing.T, values <-chan string) string {
	t.Helper()
	select {
	case value := <-values:
		return value
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for value")
		return ""
	}
}

func receiveRequest(t *testing.T, values <-chan ExecutionRequest) ExecutionRequest {
	t.Helper()
	select {
	case value := <-values:
		return value
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for execution request")
		return ExecutionRequest{}
	}
}

func assertRunStatus(t *testing.T, store *Store, runID string, want RunStatus) {
	t.Helper()
	run, err := store.GetRun(context.Background(), runID)
	if err != nil {
		t.Fatalf("get run %s: %v", runID, err)
	}
	if run.Status != want {
		t.Fatalf("run %s status = %q, want %q", runID, run.Status, want)
	}
}

func waitRunStatus(t *testing.T, store *Store, runID string, want RunStatus) RunRecord {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		run, err := store.GetRun(context.Background(), runID)
		if err == nil && run.Status == want {
			return run
		}
		time.Sleep(5 * time.Millisecond)
	}
	assertRunStatus(t, store, runID, want)
	return RunRecord{}
}

func waitRunEventCount(t *testing.T, store *Store, runID string, want int) []RunEvent {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		events, err := store.ListRunEvents(context.Background(), runID, 0, want+10)
		if err == nil && len(events) >= want {
			return events
		}
		time.Sleep(5 * time.Millisecond)
	}
	events, err := store.ListRunEvents(context.Background(), runID, 0, want+10)
	if err != nil {
		t.Fatalf("list run events: %v", err)
	}
	t.Fatalf("event count = %d, want at least %d: %#v", len(events), want, events)
	return nil
}
