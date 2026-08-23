package syncjob

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestStoreClaimRunRequiresRunnableJobLifecycle(t *testing.T) {
	store := openTestStore(t)

	enabled := putTestJob(t, store, "queue")
	ready := putLifecycleTestJob(t, store, "ready", JobLifecycleReady)
	draft, err := store.PutJob(context.Background(), JobDefinition{Name: "draft", Lifecycle: JobLifecycleDraft})
	if err != nil {
		t.Fatalf("put draft job: %v", err)
	}
	paused := putLifecycleTestJob(t, store, "paused", JobLifecycleReady)
	paused, err = store.PauseJob(context.Background(), paused.ID)
	if err != nil {
		t.Fatalf("pause job: %v", err)
	}
	archived := putLifecycleTestJob(t, store, "archived", JobLifecycleReady)
	if err := store.DeleteJob(context.Background(), archived.ID); err != nil {
		t.Fatalf("archive job: %v", err)
	}
	archived, err = store.GetJob(context.Background(), archived.ID)
	if err != nil {
		t.Fatalf("get archived job: %v", err)
	}

	for _, test := range []struct {
		name      string
		job       JobDefinition
		claimable bool
	}{
		{name: "enabled", job: enabled, claimable: true},
		{name: "ready", job: ready, claimable: true},
		{name: "draft", job: draft, claimable: false},
		{name: "paused", job: paused, claimable: false},
		{name: "archived", job: archived, claimable: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			run := createStoredRun(t, store, test.job, RunStatusQueued)
			claimed, ok, err := store.ClaimRun(context.Background(), run.ID, time.Now().UnixMilli())
			if err != nil {
				t.Fatalf("claim run: %v", err)
			}
			if ok != test.claimable {
				t.Fatalf("claimed = %v, want %v", ok, test.claimable)
			}
			if ok && claimed.OwnerToken == "" {
				t.Fatal("claimed run has no fencing token")
			}
		})
	}
}

func TestManagerArchiveCancelsQueuedAndRunningRuns(t *testing.T) {
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

	running, err := manager.StartRun(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("start running run: %v", err)
	}
	if got := receiveString(t, started); got != running.ID {
		t.Fatalf("started run = %s, want %s", got, running.ID)
	}
	queued, err := manager.StartRun(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("start queued run: %v", err)
	}
	if err := manager.DeleteJob(context.Background(), definition.ID); err != nil {
		t.Fatalf("archive job: %v", err)
	}
	waitRunStatus(t, store, queued.ID, RunStatusCanceled)
	waitRunStatus(t, store, running.ID, RunStatusCanceled)
	select {
	case <-exited:
	case <-time.After(time.Second):
		t.Fatal("running executor did not observe archive cancellation")
	}
	select {
	case got := <-started:
		t.Fatalf("archived queued run unexpectedly executed: %s", got)
	case <-time.After(75 * time.Millisecond):
	}
	archived, err := store.GetJob(context.Background(), definition.ID)
	if err != nil || archived.Lifecycle != JobLifecycleArchived || archived.Enabled {
		t.Fatalf("archived definition = %#v, err=%v", archived, err)
	}
}

func TestManagerPauseAndPausedPutCancelActiveRuns(t *testing.T) {
	store := openTestStore(t)
	first := putTestJob(t, store, "queue")
	second := putTestJob(t, store, "queue")
	started := make(chan string, 2)
	executor := ExecutorFunc(func(ctx context.Context, request ExecutionRequest, _ RunReporter) (ExecutionOutcome, error) {
		started <- request.Run.JobID
		<-ctx.Done()
		return ExecutionOutcome{}, context.Cause(ctx)
	})
	manager, err := NewManager(context.Background(), store, executor, ManagerOptions{
		SchedulerInterval: time.Hour,
		HeartbeatInterval: time.Hour,
		MaxConcurrentRuns: 2,
	})
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	t.Cleanup(func() { shutdownTestManager(t, manager) })

	firstRun, err := manager.StartRun(context.Background(), first.ID)
	if err != nil {
		t.Fatalf("start first run: %v", err)
	}
	secondRun, err := manager.StartRun(context.Background(), second.ID)
	if err != nil {
		t.Fatalf("start second run: %v", err)
	}
	seen := map[string]bool{receiveString(t, started): true, receiveString(t, started): true}
	if !seen[first.ID] || !seen[second.ID] {
		t.Fatalf("started jobs = %#v", seen)
	}
	paused, err := manager.PauseJob(context.Background(), first.ID)
	if err != nil || paused.Lifecycle != JobLifecyclePaused || paused.Enabled {
		t.Fatalf("pause job = %#v, err=%v", paused, err)
	}
	second.Lifecycle = JobLifecyclePaused
	second.Enabled = false
	pausedByPut, err := manager.PutJob(context.Background(), second)
	if err != nil || pausedByPut.Lifecycle != JobLifecyclePaused || pausedByPut.Enabled {
		t.Fatalf("put paused job = %#v, err=%v", pausedByPut, err)
	}
	waitRunStatus(t, store, firstRun.ID, RunStatusCanceled)
	waitRunStatus(t, store, secondRun.ID, RunStatusCanceled)
}

func TestManagerEnforcesMaximumConcurrentRunsAcrossJobs(t *testing.T) {
	store := openTestStore(t)
	jobs := make([]JobDefinition, 0, 5)
	for index := 0; index < 5; index++ {
		jobs = append(jobs, putTestJob(t, store, "queue"))
	}
	started := make(chan string, len(jobs))
	release := make(chan struct{}, len(jobs))
	var active atomic.Int32
	var maximum atomic.Int32
	executor := ExecutorFunc(func(ctx context.Context, request ExecutionRequest, _ RunReporter) (ExecutionOutcome, error) {
		current := active.Add(1)
		defer active.Add(-1)
		for {
			seen := maximum.Load()
			if current <= seen || maximum.CompareAndSwap(seen, current) {
				break
			}
		}
		started <- request.Run.ID
		select {
		case <-ctx.Done():
			return ExecutionOutcome{}, context.Cause(ctx)
		case <-release:
			return ExecutionOutcome{}, nil
		}
	})
	manager, err := NewManager(context.Background(), store, executor, ManagerOptions{
		SchedulerInterval: time.Hour,
		HeartbeatInterval: time.Hour,
		MaxConcurrentRuns: 2,
	})
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	t.Cleanup(func() { shutdownTestManager(t, manager) })
	runs := make([]RunRecord, 0, len(jobs))
	for _, job := range jobs {
		run, err := manager.StartRun(context.Background(), job.ID)
		if err != nil {
			t.Fatalf("start run: %v", err)
		}
		runs = append(runs, run)
	}
	_ = receiveString(t, started)
	_ = receiveString(t, started)
	select {
	case runID := <-started:
		t.Fatalf("third run exceeded concurrency limit: %s", runID)
	case <-time.After(75 * time.Millisecond):
	}
	for index := 0; index < len(jobs); index++ {
		release <- struct{}{}
	}
	for _, run := range runs {
		waitRunStatus(t, store, run.ID, RunStatusSucceeded)
	}
	if got := maximum.Load(); got != 2 {
		t.Fatalf("maximum concurrent runs = %d, want 2", got)
	}
}

func TestStoreRunOwnershipFencesStaleExecutorMutations(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "queue")
	first := createStoredRun(t, store, definition, RunStatusQueued)
	first, claimed, err := store.ClaimRun(context.Background(), first.ID, time.Now().UnixMilli())
	if err != nil || !claimed || first.OwnerToken == "" {
		t.Fatalf("claim first run = %#v, claimed=%v, err=%v", first, claimed, err)
	}
	if _, err := store.PutCheckpointOwned(context.Background(), testCheckpoint(definition, first, 1), first.OwnerToken); err != nil {
		t.Fatalf("save first checkpoint: %v", err)
	}
	recovered, err := store.InterruptStaleRuns(context.Background(), first.HeartbeatAt+1, first.HeartbeatAt+2)
	if err != nil || len(recovered) != 1 || recovered[0].ID != first.ID {
		t.Fatalf("recover first run = %#v, err=%v", recovered, err)
	}

	second := createStoredRun(t, store, definition, RunStatusQueued)
	second, claimed, err = store.ClaimRun(context.Background(), second.ID, first.HeartbeatAt+3)
	if err != nil || !claimed || second.OwnerToken == "" || second.OwnerToken == first.OwnerToken {
		t.Fatalf("claim second run = %#v, claimed=%v, err=%v", second, claimed, err)
	}
	if _, err := store.PutCheckpointOwned(context.Background(), testCheckpoint(definition, second, 2), second.OwnerToken); err != nil {
		t.Fatalf("save second checkpoint: %v", err)
	}
	if err := store.TouchRun(context.Background(), second.ID, first.HeartbeatAt+4); !errors.Is(err, ErrRunOwnershipLost) {
		t.Fatalf("unowned heartbeat bypass error = %v, want ErrRunOwnershipLost", err)
	}
	if _, err := store.PutCheckpoint(context.Background(), testCheckpoint(definition, second, 3)); !errors.Is(err, ErrRunOwnershipLost) {
		t.Fatalf("unowned checkpoint bypass error = %v, want ErrRunOwnershipLost", err)
	}
	if err := store.DeleteCheckpoint(context.Background(), definition.ID); !errors.Is(err, ErrRunOwnershipLost) {
		t.Fatalf("unowned checkpoint delete bypass error = %v, want ErrRunOwnershipLost", err)
	}
	if _, err := store.CompleteRun(context.Background(), second.ID, RunStatusSucceeded, ExecutionOutcome{}, "unowned success", first.HeartbeatAt+4); !errors.Is(err, ErrRunOwnershipLost) {
		t.Fatalf("unowned completion bypass error = %v, want ErrRunOwnershipLost", err)
	}

	if err := store.TouchRunOwned(context.Background(), first.ID, first.OwnerToken, first.HeartbeatAt+4); !errors.Is(err, ErrRunOwnershipLost) {
		t.Fatalf("stale heartbeat error = %v, want ErrRunOwnershipLost", err)
	}
	if _, err := store.UpdateRunProgressOwned(context.Background(), first.ID, first.OwnerToken, RunProgress{Current: 1, Total: 1}, first.HeartbeatAt+4); !errors.Is(err, ErrRunOwnershipLost) {
		t.Fatalf("stale progress error = %v, want ErrRunOwnershipLost", err)
	}
	if _, err := store.PutCheckpointOwned(context.Background(), testCheckpoint(definition, first, 99), first.OwnerToken); !errors.Is(err, ErrRunOwnershipLost) {
		t.Fatalf("stale checkpoint error = %v, want ErrRunOwnershipLost", err)
	}
	if err := store.DeleteCheckpointOwned(context.Background(), definition.ID, first.ID, first.OwnerToken); !errors.Is(err, ErrRunOwnershipLost) {
		t.Fatalf("stale checkpoint delete error = %v, want ErrRunOwnershipLost", err)
	}
	if _, err := store.CompleteRunOwned(context.Background(), first.ID, first.OwnerToken, RunStatusSucceeded, ExecutionOutcome{}, "stale success", first.HeartbeatAt+4); !errors.Is(err, ErrRunOwnershipLost) {
		t.Fatalf("stale completion error = %v, want ErrRunOwnershipLost", err)
	}
	checkpoint, err := store.GetCheckpoint(context.Background(), definition.ID)
	if err != nil || checkpoint.RunID != second.ID || checkpoint.BatchSequence != 2 {
		t.Fatalf("checkpoint after stale writes = %#v, err=%v", checkpoint, err)
	}
	if _, err := store.CompleteRunOwned(context.Background(), second.ID, second.OwnerToken, RunStatusSucceeded, ExecutionOutcome{}, "", first.HeartbeatAt+5); err != nil {
		t.Fatalf("complete second run: %v", err)
	}
}

func TestManagerHeartbeatCancelsExecutorAfterOwnershipLoss(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "queue")
	started := make(chan string, 1)
	exited := make(chan error, 1)
	executor := ExecutorFunc(func(ctx context.Context, request ExecutionRequest, _ RunReporter) (ExecutionOutcome, error) {
		started <- request.Run.ID
		<-ctx.Done()
		exited <- context.Cause(ctx)
		return ExecutionOutcome{}, nil
	})
	manager, err := NewManager(context.Background(), store, executor, ManagerOptions{
		SchedulerInterval:  time.Hour,
		HeartbeatInterval:  10 * time.Millisecond,
		RecoveryStaleAfter: time.Hour,
	})
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	t.Cleanup(func() { shutdownTestManager(t, manager) })
	run, err := manager.StartRun(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("start run: %v", err)
	}
	if got := receiveString(t, started); got != run.ID {
		t.Fatalf("started run = %s, want %s", got, run.ID)
	}
	if _, err := store.db.ExecContext(context.Background(), `UPDATE data_sync_runs SET owner_token = 'replacement-owner' WHERE id = ?`, run.ID); err != nil {
		t.Fatalf("replace run owner: %v", err)
	}
	select {
	case cause := <-exited:
		if !errors.Is(cause, ErrRunOwnershipLost) {
			t.Fatalf("executor cancellation cause = %v, want ErrRunOwnershipLost", cause)
		}
	case <-time.After(time.Second):
		t.Fatal("executor was not canceled after ownership loss")
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		manager.mu.Lock()
		_, active := manager.active[run.ID]
		manager.mu.Unlock()
		if !active {
			break
		}
		time.Sleep(time.Millisecond)
	}
	persisted, err := store.GetRun(context.Background(), run.ID)
	if err != nil {
		t.Fatalf("get fenced run: %v", err)
	}
	if persisted.Status != RunStatusRunning || persisted.OwnerToken != "replacement-owner" {
		t.Fatalf("stale executor overwrote fenced run: %#v", persisted)
	}
}

func TestStandbyLeaseHolderPeriodicallyRecoversStaleRuns(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "queue")
	run := createStoredRun(t, store, definition, RunStatusQueued)
	run, claimed, err := store.ClaimRun(context.Background(), run.ID, time.Now().UnixMilli())
	if err != nil || !claimed {
		t.Fatalf("claim run: claimed=%v, err=%v", claimed, err)
	}
	now := time.Now()
	if acquired, err := store.AcquireSchedulerLease(context.Background(), "data-sync-scheduler", "primary", now, 100*time.Millisecond); err != nil || !acquired {
		t.Fatalf("prime scheduler lease: acquired=%v, err=%v", acquired, err)
	}
	executor := ExecutorFunc(func(context.Context, ExecutionRequest, RunReporter) (ExecutionOutcome, error) {
		t.Fatal("recovered direct run must not execute")
		return ExecutionOutcome{}, nil
	})
	primary, err := NewManager(context.Background(), store, executor, ManagerOptions{
		SchedulerInterval:  10 * time.Millisecond,
		LeaseTTL:           100 * time.Millisecond,
		HeartbeatInterval:  time.Hour,
		RecoveryStaleAfter: 120 * time.Millisecond,
		RecoveryInterval:   20 * time.Millisecond,
		LeaseOwner:         "primary",
	})
	if err != nil {
		t.Fatalf("new primary manager: %v", err)
	}
	standby, err := NewManager(context.Background(), store, executor, ManagerOptions{
		SchedulerInterval:  10 * time.Millisecond,
		LeaseTTL:           100 * time.Millisecond,
		HeartbeatInterval:  time.Hour,
		RecoveryStaleAfter: 120 * time.Millisecond,
		RecoveryInterval:   20 * time.Millisecond,
		LeaseOwner:         "standby",
	})
	if err != nil {
		shutdownTestManager(t, primary)
		t.Fatalf("new standby manager: %v", err)
	}
	t.Cleanup(func() { shutdownTestManager(t, standby) })
	shutdownTestManager(t, primary)
	recovered := waitRunStatus(t, store, run.ID, RunStatusInterrupted)
	if !recovered.Resumable {
		t.Fatalf("recovered run is not resumable: %#v", recovered)
	}
}

func TestManagerRestartFinalizesStaleCancellingWithoutAutoResume(t *testing.T) {
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
	staleAt := time.Now().Add(-time.Hour).UnixMilli()
	stale, err := store.CreateRun(context.Background(), RunRecord{
		JobID:              definition.ID,
		JobRevision:        definition.Revision,
		Status:             RunStatusRunning,
		StartedAt:          staleAt,
		HeartbeatAt:        staleAt,
		DefinitionSnapshot: snapshot,
	})
	if err != nil {
		t.Fatalf("create stale run: %v", err)
	}
	if _, err := store.PutCheckpoint(context.Background(), testCheckpoint(definition, stale, 1)); err != nil {
		t.Fatalf("put stale checkpoint: %v", err)
	}
	if _, err := store.RequestCancelRun(context.Background(), stale.ID, staleAt+1); err != nil {
		t.Fatalf("request stale cancellation: %v", err)
	}

	var executions atomic.Int32
	manager, err := NewManager(context.Background(), store, ExecutorFunc(func(context.Context, ExecutionRequest, RunReporter) (ExecutionOutcome, error) {
		executions.Add(1)
		return ExecutionOutcome{}, nil
	}), ManagerOptions{
		SchedulerInterval:  time.Hour,
		HeartbeatInterval:  time.Hour,
		RecoveryStaleAfter: time.Second,
	})
	if err != nil {
		t.Fatalf("restart manager: %v", err)
	}
	t.Cleanup(func() { shutdownTestManager(t, manager) })

	recovered, err := store.GetRun(context.Background(), stale.ID)
	if err != nil {
		t.Fatalf("get recovered cancellation: %v", err)
	}
	if recovered.Status != RunStatusCanceled || recovered.Resumable || recovered.OwnerToken != "" {
		t.Fatalf("recovered cancellation = %#v", recovered)
	}
	events, err := store.ListRunEvents(context.Background(), stale.ID, 0, 10)
	if err != nil {
		t.Fatalf("list recovery events: %v", err)
	}
	if len(events) != 1 || events[0].Type != RunEventCanceled {
		t.Fatalf("recovery events = %#v", events)
	}
	time.Sleep(50 * time.Millisecond)
	runs, err := store.ListRuns(context.Background(), definition.ID, 10)
	if err != nil {
		t.Fatalf("list runs after recovery: %v", err)
	}
	if len(runs) != 1 || executions.Load() != 0 {
		t.Fatalf("cancellation resumed after restart: runs=%#v executions=%d", runs, executions.Load())
	}
}

func TestManagerResumeAcceptsCheckpointFromAncestorRun(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "forbid")
	requests := make(chan ExecutionRequest, 3)
	var calls atomic.Int32
	executor := ExecutorFunc(func(_ context.Context, request ExecutionRequest, reporter RunReporter) (ExecutionOutcome, error) {
		requests <- request
		switch calls.Add(1) {
		case 1:
			if err := reporter.SaveCheckpoint(Checkpoint{
				Kind: "watermark", Table: "orders", Phase: "copy", CursorType: "primary_key", Cursor: json.RawMessage(`{"id":1}`),
			}); err != nil {
				return ExecutionOutcome{}, err
			}
			return ExecutionOutcome{Resumable: true}, errors.New("first failure")
		case 2:
			return ExecutionOutcome{Resumable: true}, errors.New("resume failed before checkpoint")
		default:
			return ExecutionOutcome{}, nil
		}
	})
	manager := newTestManager(t, store, executor)
	first, err := manager.StartRun(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("start first run: %v", err)
	}
	firstRequest := receiveRequest(t, requests)
	if firstRequest.Run.ID != first.ID {
		t.Fatalf("first request run = %s, want %s", firstRequest.Run.ID, first.ID)
	}
	waitRunStatus(t, store, first.ID, RunStatusFailed)
	second, err := manager.ResumeRun(context.Background(), first.ID)
	if err != nil {
		t.Fatalf("resume first run: %v", err)
	}
	secondRequest := receiveRequest(t, requests)
	if secondRequest.Run.ID != second.ID || secondRequest.Checkpoint == nil || secondRequest.Checkpoint.RunID != first.ID {
		t.Fatalf("second request = %#v", secondRequest)
	}
	waitRunStatus(t, store, second.ID, RunStatusFailed)
	third, err := manager.ResumeRun(context.Background(), second.ID)
	if err != nil {
		t.Fatalf("resume second run from ancestor checkpoint: %v", err)
	}
	thirdRequest := receiveRequest(t, requests)
	if thirdRequest.Run.ID != third.ID || thirdRequest.Checkpoint == nil || thirdRequest.Checkpoint.RunID != first.ID {
		t.Fatalf("third request = %#v", thirdRequest)
	}
	waitRunStatus(t, store, third.ID, RunStatusSucceeded)
}

func TestManagerRejectsResumeAndRetryForInsertOnlyRuns(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "forbid")
	definition.Options.SyncMode = "insert_only"
	definition, err := store.PutJob(context.Background(), definition)
	if err != nil {
		t.Fatalf("enable insert-only mode: %v", err)
	}
	executor := ExecutorFunc(func(_ context.Context, _ ExecutionRequest, reporter RunReporter) (ExecutionOutcome, error) {
		if err := reporter.SaveCheckpoint(Checkpoint{
			Kind: "watermark", Table: "orders", Phase: "copy", CursorType: "primary_key", Cursor: json.RawMessage(`{"id":1}`),
		}); err != nil {
			return ExecutionOutcome{}, err
		}
		return ExecutionOutcome{Resumable: true}, errors.New("partial insert-only failure")
	})
	manager := newTestManager(t, store, executor)
	run, err := manager.StartRun(context.Background(), definition.ID)
	if err != nil {
		t.Fatalf("start insert-only run: %v", err)
	}
	waitRunStatus(t, store, run.ID, RunStatusFailed)
	if _, err := manager.ResumeRun(context.Background(), run.ID); !errors.Is(err, ErrRunNotResumable) {
		t.Fatalf("insert-only resume error = %v, want ErrRunNotResumable", err)
	}
	if _, err := manager.RetryRun(context.Background(), run.ID); !errors.Is(err, ErrRunNotRetryable) {
		t.Fatalf("insert-only retry error = %v, want ErrRunNotRetryable", err)
	}
}

func TestStoreMigratesRunOwnershipColumnFromVersionTwo(t *testing.T) {
	path := t.TempDir() + "/sync-jobs.db"
	store, err := Open(path)
	if err != nil {
		t.Fatalf("create current store: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close current store: %v", err)
	}
	database, err := sql.Open("sqlite", sqliteDSN(path))
	if err != nil {
		t.Fatalf("open raw store: %v", err)
	}
	if _, err := database.Exec(`ALTER TABLE data_sync_runs DROP COLUMN owner_token`); err != nil {
		_ = database.Close()
		t.Fatalf("remove ownership column: %v", err)
	}
	if _, err := database.Exec(`PRAGMA user_version=2`); err != nil {
		_ = database.Close()
		t.Fatalf("downgrade schema marker: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("close raw store: %v", err)
	}
	migrated, err := Open(path)
	if err != nil {
		t.Fatalf("migrate version two store: %v", err)
	}
	t.Cleanup(func() { _ = migrated.Close() })
	hasColumn, err := sqliteTableHasColumn(context.Background(), migrated.db, "data_sync_runs", "owner_token")
	if err != nil || !hasColumn {
		t.Fatalf("owner_token column present = %v, err=%v", hasColumn, err)
	}
}

func TestStoreMigratesErrorRowRetryLeaseFromVersionThree(t *testing.T) {
	path := t.TempDir() + "/sync-jobs.db"
	store, err := Open(path)
	if err != nil {
		t.Fatalf("create current store: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close current store: %v", err)
	}
	database, err := sql.Open("sqlite", sqliteDSN(path))
	if err != nil {
		t.Fatalf("open raw store: %v", err)
	}
	for _, statement := range []string{
		`DROP INDEX idx_data_sync_error_rows_retry`,
		`ALTER TABLE data_sync_error_rows DROP COLUMN retry_owner`,
		`ALTER TABLE data_sync_error_rows DROP COLUMN retry_lease_expires_at`,
		`PRAGMA user_version=3`,
	} {
		if _, err := database.Exec(statement); err != nil {
			_ = database.Close()
			t.Fatalf("prepare version three store (%s): %v", statement, err)
		}
	}
	if err := database.Close(); err != nil {
		t.Fatalf("close raw store: %v", err)
	}
	migrated, err := Open(path)
	if err != nil {
		t.Fatalf("migrate version three store: %v", err)
	}
	t.Cleanup(func() { _ = migrated.Close() })
	for _, column := range []string{"retry_owner", "retry_lease_expires_at"} {
		hasColumn, err := sqliteTableHasColumn(context.Background(), migrated.db, "data_sync_error_rows", column)
		if err != nil || !hasColumn {
			t.Fatalf("%s column present = %v, err=%v", column, hasColumn, err)
		}
	}
}

func TestManagerRunCreationRollsBackWhenQueuedEventCannotPersist(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "queue")
	if _, err := store.db.ExecContext(context.Background(), `CREATE TRIGGER fail_queued_run_event
		BEFORE INSERT ON data_sync_run_events WHEN NEW.event_type = 'queued'
		BEGIN SELECT RAISE(ABORT, 'injected queued event failure'); END`); err != nil {
		t.Fatalf("create event failure trigger: %v", err)
	}
	manager := newTestManager(t, store, ExecutorFunc(func(context.Context, ExecutionRequest, RunReporter) (ExecutionOutcome, error) {
		t.Fatal("run without queued event must not execute")
		return ExecutionOutcome{}, nil
	}))
	if _, err := manager.StartRun(context.Background(), definition.ID); err == nil {
		t.Fatal("start run succeeded despite queued event failure")
	}
	runs, err := store.ListRuns(context.Background(), definition.ID, 10)
	if err != nil {
		t.Fatalf("list runs: %v", err)
	}
	if len(runs) != 0 {
		t.Fatalf("run persisted without queued event: %#v", runs)
	}
}

func putLifecycleTestJob(t *testing.T, store *Store, name string, lifecycle JobLifecycle) JobDefinition {
	t.Helper()
	definition, err := store.PutJob(context.Background(), JobDefinition{
		Name: name, Lifecycle: lifecycle, Kind: JobKindReconcile, IncrementalMode: IncrementalSnapshot,
		Source: EndpointRef{ConnectionID: "source-" + name}, Target: EndpointRef{ConnectionID: "target-" + name},
		Mappings: []TableMapping{{SourceTable: "orders", TargetTable: "orders", Enabled: true}},
	})
	if err != nil {
		t.Fatalf("put %s job: %v", name, err)
	}
	return definition
}

func createStoredRun(t *testing.T, store *Store, definition JobDefinition, status RunStatus) RunRecord {
	t.Helper()
	snapshot, err := json.Marshal(definition)
	if err != nil {
		t.Fatalf("marshal run definition: %v", err)
	}
	run, err := store.CreateRun(context.Background(), RunRecord{
		JobID: definition.ID, JobRevision: definition.Revision, Status: status, DefinitionSnapshot: snapshot,
		SourceFingerprint: definition.Source.Fingerprint, TargetFingerprint: definition.Target.Fingerprint,
	})
	if err != nil {
		t.Fatalf("create stored run: %v", err)
	}
	return run
}

func testCheckpoint(definition JobDefinition, run RunRecord, sequence int64) Checkpoint {
	return Checkpoint{
		Kind: "watermark", JobID: definition.ID, RunID: run.ID, DefinitionRevision: definition.Revision,
		Table: "orders", Phase: "copy", CursorType: "primary_key", Cursor: json.RawMessage(`{"id":1}`), BatchSequence: sequence,
	}
}

func shutdownTestManager(t *testing.T, manager *Manager) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := manager.Shutdown(ctx); err != nil {
		t.Errorf("shutdown manager: %v", err)
	}
}
