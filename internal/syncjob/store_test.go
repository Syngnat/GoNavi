package syncjob

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"
	"time"
)

func TestStoreSchedulerLeaseAllowsOnlyTheOwnerUntilExpiry(t *testing.T) {
	store := openTestStore(t)
	now := time.Now().Truncate(time.Millisecond)
	acquired, err := store.AcquireSchedulerLease(context.Background(), "scheduler", "owner-a", now, time.Second)
	if err != nil || !acquired {
		t.Fatalf("owner-a acquire = %v, %v", acquired, err)
	}
	acquired, err = store.AcquireSchedulerLease(context.Background(), "scheduler", "owner-b", now.Add(500*time.Millisecond), time.Second)
	if err != nil {
		t.Fatalf("owner-b acquire before expiry: %v", err)
	}
	if acquired {
		t.Fatal("owner-b acquired a live lease")
	}
	acquired, err = store.AcquireSchedulerLease(context.Background(), "scheduler", "owner-b", now.Add(time.Second), time.Second)
	if err != nil || !acquired {
		t.Fatalf("owner-b takeover = %v, %v", acquired, err)
	}
	if err := store.ReleaseSchedulerLease(context.Background(), "scheduler", "owner-a"); err != nil {
		t.Fatalf("old owner release: %v", err)
	}
	acquired, err = store.AcquireSchedulerLease(context.Background(), "scheduler", "owner-c", now.Add(1500*time.Millisecond), time.Second)
	if err != nil {
		t.Fatalf("owner-c acquire while owner-b live: %v", err)
	}
	if acquired {
		t.Fatal("old owner release removed the replacement lease")
	}
}

func TestStorePersistsConcurrentRunEventsWithContiguousSequences(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "queue")
	snapshot, err := json.Marshal(definition)
	if err != nil {
		t.Fatalf("marshal definition: %v", err)
	}
	run, err := store.CreateRun(context.Background(), RunRecord{
		JobID:              definition.ID,
		JobRevision:        definition.Revision,
		DefinitionSnapshot: snapshot,
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}

	const count = 32
	errorsSeen := make(chan error, count)
	var wait sync.WaitGroup
	for index := 0; index < count; index++ {
		index := index
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, appendErr := store.AppendRunEvent(context.Background(), RunEvent{
				RunID:   run.ID,
				Type:    RunEventLog,
				Message: fmt.Sprintf("event-%d", index),
			})
			if appendErr != nil {
				errorsSeen <- appendErr
			}
		}()
	}
	wait.Wait()
	close(errorsSeen)
	for appendErr := range errorsSeen {
		t.Errorf("append event: %v", appendErr)
	}
	events, err := store.ListRunEvents(context.Background(), run.ID, 0, count)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	if len(events) != count {
		t.Fatalf("event count = %d, want %d", len(events), count)
	}
	for index, event := range events {
		if event.Sequence != int64(index+1) {
			t.Fatalf("event sequence at %d = %d, want %d", index, event.Sequence, index+1)
		}
	}
}

func TestStoreCompletesOwnedRunWithTerminalEventForEveryStatus(t *testing.T) {
	testCases := []struct {
		status    RunStatus
		eventType RunEventType
		resumable bool
	}{
		{status: RunStatusSucceeded, eventType: RunEventSucceeded},
		{status: RunStatusPartial, eventType: RunEventPartial},
		{status: RunStatusFailed, eventType: RunEventFailed},
		{status: RunStatusCanceled, eventType: RunEventCanceled},
		{status: RunStatusInterrupted, eventType: RunEventInterrupted, resumable: true},
	}

	for _, testCase := range testCases {
		t.Run(string(testCase.status), func(t *testing.T) {
			store := openTestStore(t)
			definition := putTestJob(t, store, "queue")
			run := createStoredRun(t, store, definition, RunStatusQueued)
			if _, err := store.AppendRunEvent(context.Background(), RunEvent{
				RunID: run.ID, Type: RunEventQueued, Status: RunStatusQueued, Message: "queued",
			}); err != nil {
				t.Fatalf("append queued event: %v", err)
			}
			claimed, ok, err := store.ClaimRun(context.Background(), run.ID, time.Now().UnixMilli())
			if err != nil || !ok {
				t.Fatalf("claim run = %#v, claimed=%v, err=%v", claimed, ok, err)
			}
			claimed, err = store.UpdateRunProgressOwned(context.Background(), claimed.ID, claimed.OwnerToken, RunProgress{
				Current: 2, Total: 3, Table: "orders", Stage: "write",
			}, claimed.StartedAt+1)
			if err != nil {
				t.Fatalf("update owned progress: %v", err)
			}
			if _, err := store.AppendRunEvent(context.Background(), RunEvent{
				RunID: claimed.ID, Type: RunEventStarted, Status: RunStatusRunning, Message: "started",
			}); err != nil {
				t.Fatalf("append started event: %v", err)
			}

			finishedAt := claimed.StartedAt + 2
			outcome := ExecutionOutcome{RowsInserted: 2, Message: "terminal " + string(testCase.status)}
			completed, event, err := store.CompleteRunOwnedWithTerminalEvent(
				context.Background(), claimed.ID, claimed.OwnerToken, testCase.status, outcome, "", finishedAt,
			)
			if err != nil {
				t.Fatalf("complete run with terminal event: %v", err)
			}
			if completed.Status != testCase.status || completed.OwnerToken != "" || completed.FinishedAt != finishedAt || completed.Resumable != testCase.resumable {
				t.Fatalf("completed run = %#v", completed)
			}
			if event.Type != testCase.eventType || event.Status != testCase.status || event.Sequence != 3 || event.Message != outcome.Message {
				t.Fatalf("terminal event = %#v", event)
			}
			if event.Current != completed.Current || event.Total != completed.Total || event.Table != completed.Table || event.Stage != completed.Stage {
				t.Fatalf("terminal event progress = %#v, completed run = %#v", event, completed)
			}
			events, err := store.ListRunEvents(context.Background(), run.ID, 0, 10)
			if err != nil {
				t.Fatalf("list run events: %v", err)
			}
			if len(events) != 3 {
				t.Fatalf("event count = %d, want 3: %#v", len(events), events)
			}
			for index, persisted := range events {
				if persisted.Sequence != int64(index+1) {
					t.Fatalf("event sequence at %d = %d, want %d", index, persisted.Sequence, index+1)
				}
			}
		})
	}
}

func TestStoreRollsBackOwnedCompletionWhenTerminalEventCannotPersist(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "queue")
	run := createStoredRun(t, store, definition, RunStatusQueued)
	claimed, ok, err := store.ClaimRun(context.Background(), run.ID, time.Now().UnixMilli())
	if err != nil || !ok {
		t.Fatalf("claim run = %#v, claimed=%v, err=%v", claimed, ok, err)
	}
	if _, err := store.AppendRunEvent(context.Background(), RunEvent{
		RunID: claimed.ID, Type: RunEventStarted, Status: RunStatusRunning, Message: "started",
	}); err != nil {
		t.Fatalf("append started event: %v", err)
	}
	if _, err := store.db.ExecContext(context.Background(), `CREATE TRIGGER fail_terminal_run_event
		BEFORE INSERT ON data_sync_run_events WHEN NEW.event_type IN ('succeeded', 'partial', 'failed', 'canceled', 'interrupted')
		BEGIN SELECT RAISE(ABORT, 'injected terminal event failure'); END`); err != nil {
		t.Fatalf("create terminal event failure trigger: %v", err)
	}

	if _, _, err := store.CompleteRunOwnedWithTerminalEvent(context.Background(), claimed.ID, claimed.OwnerToken,
		RunStatusSucceeded, ExecutionOutcome{RowsInserted: 1}, "completed", claimed.StartedAt+1); err == nil {
		t.Fatal("completion succeeded despite terminal event failure")
	}
	persisted, err := store.GetRun(context.Background(), claimed.ID)
	if err != nil {
		t.Fatalf("get run after rollback: %v", err)
	}
	if persisted.Status != RunStatusRunning || persisted.OwnerToken != claimed.OwnerToken || persisted.FinishedAt != 0 {
		t.Fatalf("run completion was not rolled back: %#v", persisted)
	}
	events, err := store.ListRunEvents(context.Background(), claimed.ID, 0, 10)
	if err != nil {
		t.Fatalf("list events after rollback: %v", err)
	}
	if len(events) != 1 || events[0].Type != RunEventStarted || events[0].Sequence != 1 {
		t.Fatalf("events changed despite rollback: %#v", events)
	}
}

func TestStorePersistsIncompleteDraftButManagerWillNotRunIt(t *testing.T) {
	store := openTestStore(t)
	draft, err := store.PutJob(context.Background(), JobDefinition{
		Name:      "unfinished sync",
		Lifecycle: JobLifecycleDraft,
	})
	if err != nil {
		t.Fatalf("persist draft: %v", err)
	}
	if draft.Enabled || draft.NextRunAt != 0 || draft.Lifecycle != JobLifecycleDraft {
		t.Fatalf("normalized draft = %#v", draft)
	}
	manager := newTestManager(t, store, ExecutorFunc(func(context.Context, ExecutionRequest, RunReporter) (ExecutionOutcome, error) {
		t.Fatal("draft executor must not run")
		return ExecutionOutcome{}, nil
	}))
	if _, err := manager.StartRun(context.Background(), draft.ID); !errors.Is(err, ErrJobDisabled) {
		t.Fatalf("start draft error = %v, want ErrJobDisabled", err)
	}
	if _, err := store.PutJob(context.Background(), JobDefinition{
		Name:      "invalid ready job",
		Lifecycle: JobLifecycleReady,
	}); err == nil {
		t.Fatal("ready job without endpoints and mappings was persisted")
	}
}

func TestStorePutJobUsesPersistedRevisionAsTheCASValue(t *testing.T) {
	store := openTestStore(t)
	first := putTestJob(t, store, "forbid")
	if first.Revision != 1 {
		t.Fatalf("first persisted revision = %d, want 1", first.Revision)
	}

	updated := first
	updated.Name = "orders sync updated"
	second, err := store.PutJob(context.Background(), updated)
	if err != nil {
		t.Fatalf("second save with current revision failed: %v", err)
	}
	if second.Revision != 2 {
		t.Fatalf("second persisted revision = %d, want 2", second.Revision)
	}

	first.Name = "stale edit"
	if _, err := store.PutJob(context.Background(), first); !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("stale save error = %v, want ErrRevisionConflict", err)
	}
}

func TestStoreResetCheckpointRejectsActiveRun(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "forbid")
	snapshot, err := json.Marshal(definition)
	if err != nil {
		t.Fatalf("marshal definition: %v", err)
	}
	run, err := store.CreateRun(context.Background(), RunRecord{
		JobID:              definition.ID,
		JobRevision:        definition.Revision,
		Status:             RunStatusRunning,
		DefinitionSnapshot: snapshot,
	})
	if err != nil {
		t.Fatalf("create running run: %v", err)
	}
	if _, err := store.PutCheckpoint(context.Background(), Checkpoint{
		Version:            1,
		Kind:               "watermark",
		JobID:              definition.ID,
		RunID:              run.ID,
		DefinitionRevision: definition.Revision,
		Table:              "orders",
		Phase:              "batch_committed",
		CursorType:         "watermark_map",
		Cursor:             json.RawMessage(`{"orders":{"id":42}}`),
	}); err != nil {
		t.Fatalf("put checkpoint: %v", err)
	}
	if err := store.ResetCheckpoint(context.Background(), definition.ID); !errors.Is(err, ErrRunAlreadyActive) {
		t.Fatalf("reset with active run error = %v, want ErrRunAlreadyActive", err)
	}
	if _, err := store.CompleteRun(context.Background(), run.ID, RunStatusFailed, ExecutionOutcome{Resumable: true}, "failed", time.Now().UnixMilli()); err != nil {
		t.Fatalf("complete run: %v", err)
	}
	if err := store.ResetCheckpoint(context.Background(), definition.ID); err != nil {
		t.Fatalf("reset checkpoint: %v", err)
	}
	if err := store.ResetCheckpoint(context.Background(), definition.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second reset error = %v, want ErrNotFound", err)
	}
}

func TestManagerReadsAndDiscardsErrorRowWithOneWayCAS(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "queue")
	snapshot, err := json.Marshal(definition)
	if err != nil {
		t.Fatalf("marshal definition: %v", err)
	}
	run, err := store.CreateRun(context.Background(), RunRecord{
		JobID:              definition.ID,
		JobRevision:        definition.Revision,
		Status:             RunStatusFailed,
		DefinitionSnapshot: snapshot,
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	row, err := store.AppendErrorRow(context.Background(), ErrorRow{
		RunID: run.ID,
		JobID: definition.ID,
		Error: "duplicate key",
	})
	if err != nil {
		t.Fatalf("append error row: %v", err)
	}
	manager := newTestManager(t, store, ExecutorFunc(func(context.Context, ExecutionRequest, RunReporter) (ExecutionOutcome, error) {
		return ExecutionOutcome{}, nil
	}))
	read, err := manager.GetErrorRow(context.Background(), row.ID)
	if err != nil || read.ID != row.ID || read.Status != ErrorRowPending {
		t.Fatalf("get error row = %#v, err=%v", read, err)
	}
	if err := manager.RecordErrorRowRetryFailure(context.Background(), row.ID); err != nil {
		t.Fatalf("record retry failure: %v", err)
	}
	read, err = manager.GetErrorRow(context.Background(), row.ID)
	if err != nil || read.Status != ErrorRowPending || read.Attempts != 1 {
		t.Fatalf("pending retried error row = %#v, err=%v", read, err)
	}
	if err := manager.DiscardErrorRow(context.Background(), row.ID); err != nil {
		t.Fatalf("discard error row: %v", err)
	}
	discarded, err := manager.GetErrorRow(context.Background(), row.ID)
	if err != nil || discarded.Status != ErrorRowDiscarded {
		t.Fatalf("discarded error row = %#v, err=%v", discarded, err)
	}
	if err := manager.DiscardErrorRow(context.Background(), row.ID); !errors.Is(err, ErrErrorRowStateConflict) {
		t.Fatalf("repeat discard error = %v, want ErrErrorRowStateConflict", err)
	}
	if err := manager.RecordErrorRowRetryFailure(context.Background(), row.ID); !errors.Is(err, ErrErrorRowStateConflict) {
		t.Fatalf("discarded retry failure error = %v, want ErrErrorRowStateConflict", err)
	}
	if err := store.UpdateErrorRowStatus(context.Background(), row.ID, ErrorRowResolved, true); !errors.Is(err, ErrErrorRowStateConflict) {
		t.Fatalf("discarded to resolved error = %v, want ErrErrorRowStateConflict", err)
	}
	resolvedRow, err := store.AppendErrorRow(context.Background(), ErrorRow{
		RunID: run.ID,
		JobID: definition.ID,
		Error: "timeout",
	})
	if err != nil {
		t.Fatalf("append resolvable error row: %v", err)
	}
	if err := manager.ResolveErrorRow(context.Background(), resolvedRow.ID, true); err != nil {
		t.Fatalf("resolve error row: %v", err)
	}
	resolved, err := manager.GetErrorRow(context.Background(), resolvedRow.ID)
	if err != nil || resolved.Status != ErrorRowResolved || resolved.Attempts != 1 {
		t.Fatalf("resolved error row = %#v, err=%v", resolved, err)
	}
	if err := manager.DiscardErrorRow(context.Background(), resolvedRow.ID); !errors.Is(err, ErrErrorRowStateConflict) {
		t.Fatalf("resolved to discarded error = %v, want ErrErrorRowStateConflict", err)
	}
}

func TestStoreErrorRowRetryClaimFencesTransitionsAndRecoversExpiredLease(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "queue")
	run := createStoredRun(t, store, definition, RunStatusFailed)
	row, err := store.AppendErrorRow(context.Background(), ErrorRow{
		RunID: run.ID,
		JobID: definition.ID,
		Error: "duplicate key",
	})
	if err != nil {
		t.Fatalf("append error row: %v", err)
	}
	now := time.Now().UnixMilli()
	claimed, err := store.ClaimErrorRowRetry(context.Background(), row.ID, now, time.Second)
	if err != nil {
		t.Fatalf("claim error row retry: %v", err)
	}
	if claimed.Status != ErrorRowRetrying || claimed.RetryOwner == "" || claimed.RetryLeaseExpiresAt != now+time.Second.Milliseconds() {
		t.Fatalf("claimed error row = %#v", claimed)
	}
	if _, err := store.ClaimErrorRowRetry(context.Background(), row.ID, now+500, time.Second); !errors.Is(err, ErrErrorRowStateConflict) {
		t.Fatalf("concurrent claim error = %v, want ErrErrorRowStateConflict", err)
	}
	if err := store.UpdateErrorRowStatus(context.Background(), row.ID, ErrorRowDiscarded, false); !errors.Is(err, ErrErrorRowStateConflict) {
		t.Fatalf("discard retrying row error = %v, want ErrErrorRowStateConflict", err)
	}
	if err := store.ResolveErrorRowRetry(context.Background(), row.ID, "wrong-owner", now+600); !errors.Is(err, ErrErrorRowRetryOwnershipLost) {
		t.Fatalf("wrong-owner resolution error = %v, want ErrErrorRowRetryOwnershipLost", err)
	}
	if err := store.RenewErrorRowRetry(context.Background(), row.ID, claimed.RetryOwner, now+500, time.Second); err != nil {
		t.Fatalf("renew retry claim: %v", err)
	}
	if recovered, err := store.RecoverExpiredErrorRowRetries(context.Background(), now+time.Second.Milliseconds()+1); err != nil || recovered != 0 {
		t.Fatalf("recover live renewed retry claims = %d, err=%v", recovered, err)
	}

	recovered, err := store.RecoverExpiredErrorRowRetries(context.Background(), now+1501)
	if err != nil || recovered != 1 {
		t.Fatalf("recover expired retry claims = %d, err=%v", recovered, err)
	}
	pending, err := store.GetErrorRow(context.Background(), row.ID)
	if err != nil || pending.Status != ErrorRowPending || pending.Attempts != 1 || pending.RetryOwner != "" || pending.RetryLeaseExpiresAt != 0 {
		t.Fatalf("recovered retry row = %#v, err=%v", pending, err)
	}

	reclaimed, err := store.ClaimErrorRowRetry(context.Background(), row.ID, now+2000, time.Second)
	if err != nil {
		t.Fatalf("reclaim recovered error row: %v", err)
	}
	if err := store.ResolveErrorRowRetry(context.Background(), row.ID, reclaimed.RetryOwner, now+2100); err != nil {
		t.Fatalf("resolve reclaimed error row: %v", err)
	}
	resolved, err := store.GetErrorRow(context.Background(), row.ID)
	if err != nil || resolved.Status != ErrorRowResolved || resolved.Attempts != 2 || resolved.RetryOwner != "" || resolved.RetryLeaseExpiresAt != 0 {
		t.Fatalf("resolved retried row = %#v, err=%v", resolved, err)
	}
}

func TestStorePagesAndClearsOnlyTerminalRunHistory(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "queue")
	first := createStoredRun(t, store, definition, RunStatusSucceeded)
	second := createStoredRun(t, store, definition, RunStatusFailed)
	third := createStoredRun(t, store, definition, RunStatusCanceled)
	active := createStoredRun(t, store, definition, RunStatusRunning)
	for index, run := range []RunRecord{first, second, third, active} {
		if _, err := store.db.ExecContext(context.Background(), `UPDATE data_sync_runs SET created_at = ? WHERE id = ?`, int64(1_000+index), run.ID); err != nil {
			t.Fatalf("set run created_at: %v", err)
		}
	}

	page, err := store.ListRunsPage(context.Background(), definition.ID, nil, 2)
	if err != nil {
		t.Fatalf("list first run page: %v", err)
	}
	if got := []string{page.Runs[0].ID, page.Runs[1].ID}; !reflect.DeepEqual(got, []string{active.ID, third.ID}) {
		t.Fatalf("first page = %#v", got)
	}
	if page.NextCursor == nil || page.NextCursor.ID != third.ID {
		t.Fatalf("first next cursor = %#v", page.NextCursor)
	}
	if page.Total != 4 {
		t.Fatalf("first total = %d, want 4", page.Total)
	}
	page, err = store.ListRunsPage(context.Background(), definition.ID, page.NextCursor, 2)
	if err != nil {
		t.Fatalf("list second run page: %v", err)
	}
	if got := []string{page.Runs[0].ID, page.Runs[1].ID}; !reflect.DeepEqual(got, []string{second.ID, first.ID}) {
		t.Fatalf("second page = %#v", got)
	}
	if page.NextCursor != nil {
		t.Fatalf("second next cursor = %#v, want nil", page.NextCursor)
	}
	if page.Total != 4 {
		t.Fatalf("second total = %d, want 4", page.Total)
	}

	if _, err := store.PutCheckpoint(context.Background(), Checkpoint{
		Version: 1, Kind: "watermark", JobID: definition.ID, RunID: third.ID,
		DefinitionRevision: definition.Revision, Table: "orders", Phase: "batch_committed",
		CursorType: "watermark", Cursor: json.RawMessage(`{"id":3}`),
	}); err != nil {
		t.Fatalf("put checkpoint: %v", err)
	}
	if err := store.DeleteRun(context.Background(), active.ID); !errors.Is(err, ErrRunNotDeletable) {
		t.Fatalf("delete active run error = %v, want ErrRunNotDeletable", err)
	}
	if err := store.PurgeJob(context.Background(), definition.ID); !errors.Is(err, ErrJobRunsActive) {
		t.Fatalf("purge active job error = %v, want ErrJobRunsActive", err)
	}
	if _, err := store.GetJob(context.Background(), definition.ID); err != nil {
		t.Fatalf("active job was deleted: %v", err)
	}
	if err := store.DeleteRun(context.Background(), third.ID); err != nil {
		t.Fatalf("delete terminal run: %v", err)
	}
	checkpoint, err := store.GetCheckpoint(context.Background(), definition.ID)
	if err != nil || checkpoint.RunID != third.ID {
		t.Fatalf("checkpoint after deleting its history run = %#v, err=%v", checkpoint, err)
	}
	deleted, err := store.ClearTerminalRuns(context.Background(), definition.ID)
	if err != nil || deleted != 2 {
		t.Fatalf("clear terminal runs = %d, %v; want 2, nil", deleted, err)
	}
	remaining, err := store.ListRuns(context.Background(), definition.ID, 10)
	if err != nil || len(remaining) != 1 || remaining[0].ID != active.ID {
		t.Fatalf("remaining runs = %#v, err=%v", remaining, err)
	}
}

func TestStorePurgeJobAllowsPausedRun(t *testing.T) {
	store := openTestStore(t)
	definition := putTestJob(t, store, "queue")
	_ = createStoredRun(t, store, definition, RunStatusPaused)

	if err := store.PurgeJob(context.Background(), definition.ID); err != nil {
		t.Fatalf("purge paused job: %v", err)
	}
	if _, err := store.GetJob(context.Background(), definition.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("purged job get error = %v, want ErrNotFound", err)
	}
}
