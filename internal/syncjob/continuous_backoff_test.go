package syncjob

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestContinuousFailureBackoffPersistsAcrossRestartAndSuccessResets(t *testing.T) {
	path := t.TempDir() + "/continuous.db"
	store, err := Open(path)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	definition := putContinuousTestJob(t, store)
	failedAt := time.Now().Truncate(time.Millisecond)
	createTerminalHistoryRun(t, store, definition, RunStatusFailed, failedAt)
	now := failedAt.Add(time.Second)
	if _, err := store.db.ExecContext(context.Background(), `UPDATE data_sync_jobs SET next_run_at = ? WHERE id = ?`, now.Add(-time.Millisecond).UnixMilli(), definition.ID); err != nil {
		t.Fatalf("make continuous job due: %v", err)
	}
	manager := newManualSchedulerManager(store, now, "first-owner")
	notBefore, failures, err := manager.continuousFailureNotBefore(context.Background(), definition)
	if err != nil || failures != 1 {
		t.Fatalf("failure backoff = %d, failures=%d, err=%v", notBefore, failures, err)
	}
	delay := time.Duration(notBefore-failedAt.UnixMilli()) * time.Millisecond
	if delay < 5*time.Second || delay > 6*time.Second {
		t.Fatalf("first failure delay = %s, want [5s, 6s]", delay)
	}
	manager.runSchedulerCycle()
	delayed, err := store.GetJob(context.Background(), definition.ID)
	if err != nil || delayed.NextRunAt != notBefore {
		t.Fatalf("delayed job = %#v, err=%v", delayed, err)
	}
	runs, err := store.ListRuns(context.Background(), definition.ID, 10)
	if err != nil || len(runs) != 1 {
		t.Fatalf("runs during backoff = %#v, err=%v", runs, err)
	}
	_ = store.ReleaseSchedulerLease(context.Background(), "data-sync-scheduler", "first-owner")
	if err := store.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	restarted := newManualSchedulerManager(reopened, now, "restart-owner")
	reloaded, err := reopened.GetJob(context.Background(), definition.ID)
	if err != nil || reloaded.NextRunAt != notBefore {
		t.Fatalf("reloaded delayed job = %#v, err=%v", reloaded, err)
	}
	restartedNotBefore, restartedFailures, err := restarted.continuousFailureNotBefore(context.Background(), reloaded)
	if err != nil || restartedFailures != failures || restartedNotBefore != notBefore {
		t.Fatalf("restart backoff = %d/%d, want %d/%d, err=%v", restartedNotBefore, restartedFailures, notBefore, failures, err)
	}
	restarted.runSchedulerCycle()
	runs, err = reopened.ListRuns(context.Background(), definition.ID, 10)
	if err != nil || len(runs) != 1 {
		t.Fatalf("restart runs during backoff = %#v, err=%v", runs, err)
	}

	createTerminalHistoryRun(t, reopened, reloaded, RunStatusSucceeded, failedAt.Add(2*time.Second))
	resetAt, resetFailures, err := restarted.continuousFailureNotBefore(context.Background(), reloaded)
	if err != nil || resetAt != 0 || resetFailures != 0 {
		t.Fatalf("success reset backoff = %d, failures=%d, err=%v", resetAt, resetFailures, err)
	}
}

func TestContinuousFailureBackoffIsStableExponentialAndCapped(t *testing.T) {
	previous := time.Duration(0)
	for failures := 1; failures <= 12; failures++ {
		first := continuousFailureBackoff("job", "run", failures)
		second := continuousFailureBackoff("job", "run", failures)
		if first != second {
			t.Fatalf("failure %d jitter is not stable: %s != %s", failures, first, second)
		}
		if first < previous || first > 5*time.Minute {
			t.Fatalf("failure %d backoff = %s, previous=%s", failures, first, previous)
		}
		previous = first
	}
	if previous != 5*time.Minute {
		t.Fatalf("capped backoff = %s, want 5m", previous)
	}
}

func TestPermanentExecutionErrorPausesOwningJob(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "queue")
	manager := newTestManager(t, store, ExecutorFunc(func(context.Context, ExecutionRequest, RunReporter) (ExecutionOutcome, error) {
		return ExecutionOutcome{}, MarkPermanentExecutionError(errors.New("unsupported source topology"))
	}))
	run, err := manager.StartRun(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("start run: %v", err)
	}
	waitRunStatus(t, store, run.ID, RunStatusFailed)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		paused, getErr := store.GetJob(context.Background(), definition.ID)
		if getErr == nil && paused.Lifecycle == JobLifecyclePaused && !paused.Enabled {
			if _, err := manager.StartRun(context.Background(), definition.ID); !errors.Is(err, ErrJobDisabled) {
				t.Fatalf("start paused job error = %v, want ErrJobDisabled", err)
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("permanent failure did not pause job")
}

func putContinuousTestJob(t *testing.T, store *Store) JobDefinition {
	t.Helper()
	definition := JobDefinition{
		Name: "continuous orders", Lifecycle: JobLifecycleEnabled, Enabled: true, Kind: JobKindReconcile,
		IncrementalMode: IncrementalCDC, Source: EndpointRef{ConnectionID: "source"}, Target: EndpointRef{ConnectionID: "target"},
		Mappings: []TableMapping{{SourceTable: "orders", TargetTable: "orders", KeyColumns: []string{"id"}, Enabled: true}},
		CDC:      &CDCSpec{Adapter: "mongodb-change-stream", StartPosition: "checkpoint"},
		Schedule: ScheduleSpec{Kind: ScheduleContinuous}, ConcurrencyPolicy: "forbid",
	}
	saved, err := store.PutJob(context.Background(), definition)
	if err != nil {
		t.Fatalf("put continuous job: %v", err)
	}
	return saved
}

func createTerminalHistoryRun(t *testing.T, store *Store, definition JobDefinition, status RunStatus, finishedAt time.Time) RunRecord {
	t.Helper()
	snapshot, err := json.Marshal(definition)
	if err != nil {
		t.Fatalf("marshal definition: %v", err)
	}
	run, err := store.CreateRun(context.Background(), RunRecord{
		JobID: definition.ID, JobRevision: definition.Revision, Status: RunStatusRunning, DefinitionSnapshot: snapshot,
	})
	if err != nil {
		t.Fatalf("create history run: %v", err)
	}
	run, err = store.CompleteRun(context.Background(), run.ID, status, ExecutionOutcome{}, string(status), finishedAt.UnixMilli())
	if err != nil {
		t.Fatalf("complete history run: %v", err)
	}
	if _, err := store.db.ExecContext(context.Background(), `UPDATE data_sync_runs SET created_at = ?, updated_at = ? WHERE id = ?`,
		finishedAt.UnixMilli(), finishedAt.UnixMilli(), run.ID); err != nil {
		t.Fatalf("order history run: %v", err)
	}
	return run
}

func newManualSchedulerManager(store *Store, now time.Time, owner string) *Manager {
	ctx, cancel := context.WithCancelCause(context.Background())
	options := normalizeManagerOptions(ManagerOptions{
		SchedulerInterval: time.Hour, LeaseTTL: time.Minute, HeartbeatInterval: time.Hour,
		RecoveryStaleAfter: time.Hour, RecoveryInterval: time.Hour, LeaseOwner: owner, Now: func() time.Time { return now },
	})
	return &Manager{
		store: store, executor: ExecutorFunc(func(context.Context, ExecutionRequest, RunReporter) (ExecutionOutcome, error) {
			return ExecutionOutcome{}, nil
		}),
		options: options, ctx: ctx, cancel: cancel, wake: make(chan struct{}, 1), active: make(map[string]activeExecution),
		lastRecoveryAt: now, done: make(chan struct{}),
	}
}
