package runharness

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func recoveryRunWithUnknownTool(t *testing.T) (*Ledger, RunSnapshot, Lease) {
	t.Helper()
	l := testLedger(t)
	ctx := context.Background()
	run, err := l.CreateRun(ctx, CreateRunRequest{SessionID: "recovery-session", Policy: DefaultRunPolicy()})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := l.AcquireLease(ctx, run.ID, "recovery-owner", 0)
	if err != nil {
		t.Fatal(err)
	}
	run, err = l.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	run, err = l.TransitionRun(ctx, run.ID, RunStateQueued, RunStateRunningModel, run.Revision, lease.Token)
	if err != nil {
		t.Fatal(err)
	}
	finished, err := l.StartTool(ctx, StartToolRequest{RunID: run.ID, CallID: "write-1", Attempt: 1, ToolName: "write", Effect: ToolEffectSideEffect, Arguments: json.RawMessage(`{"value":1}`), ExpectedRevision: run.Revision, OwnerToken: lease.Token})
	if err != nil || finished.Status != "started" {
		t.Fatalf("start tool = %#v, %v", finished, err)
	}
	run, err = l.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	atomicResult, err := l.FinishToolAndEvent(ctx, FinishToolAndEventRequest{
		FinishToolRequest: FinishToolRequest{RunID: run.ID, CallID: "write-1", Status: "unknown", Result: map[string]any{"request": "sent"}, UnknownOutcome: true, ExpectedRevision: run.Revision, OwnerToken: lease.Token},
		ResultingState:    RunStateRecoveryRequired,
		ToolEvent:         ToolEvent{CallID: "write-1", ToolName: "write", Effect: ToolEffectSideEffect, Status: "unknown"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if atomicResult.Event.Kind != EventTool || atomicResult.Event.ResultingState != RunStateRecoveryRequired {
		t.Fatalf("atomic result = %#v", atomicResult)
	}
	// A worker releases its lease before exposing recovery to another owner.
	if err := l.ReleaseLease(ctx, lease); err != nil {
		t.Fatal(err)
	}
	run, err = l.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	return l, run, lease
}

func TestApplyRecoveryActionMarkCompletedAndRetryAttempt(t *testing.T) {
	ctx := context.Background()
	l, run, _ := recoveryRunWithUnknownTool(t)
	defer l.Close()

	marked, err := l.ApplyRecoveryAction(ctx, RecoveryActionRequest{RunID: run.ID, Action: ControlMarkCompleted, ExpectedRevision: run.Revision})
	if err != nil {
		t.Fatal(err)
	}
	if marked.Run.State != RunStateRunningModel {
		t.Fatalf("mark completed state = %s", marked.Run.State)
	}
	var status string
	var unknown int
	var errorCode string
	if err := l.db.QueryRow(`SELECT status,unknown_outcome,error_code FROM tool_calls WHERE run_id=? AND call_id=?`, run.ID, "write-1").Scan(&status, &unknown, &errorCode); err != nil {
		t.Fatal(err)
	}
	if status != "completed" || unknown != 0 || errorCode != "user_confirmed_completed" {
		t.Fatalf("resolved tool = status %q unknown %d code %q", status, unknown, errorCode)
	}
	// Applying the same command after the state transition is a no-op.
	repeated, err := l.ApplyRecoveryAction(ctx, RecoveryActionRequest{RunID: run.ID, Action: ControlMarkCompleted})
	if err != nil || repeated.Run.Revision != marked.Run.Revision {
		t.Fatalf("repeated mark = %#v, %v", repeated.Run, err)
	}

	// A separate unknown run exercises retry's attempt fence.
	l2, run2, _ := recoveryRunWithUnknownTool(t)
	defer l2.Close()
	retried, err := l2.ApplyRecoveryAction(ctx, RecoveryActionRequest{RunID: run2.ID, Action: ControlRecover, ExpectedRevision: run2.Revision})
	if err != nil {
		t.Fatal(err)
	}
	if retried.Run.State != RunStateRunningModel || retried.Run.Attempt != run2.Attempt+1 {
		t.Fatalf("retry run = %#v", retried.Run)
	}
	lease, err := l2.AcquireLease(ctx, run2.ID, "retry-owner", 0)
	if err != nil {
		t.Fatal(err)
	}
	current, _ := l2.GetRun(ctx, run2.ID)
	if _, err := l2.StartTool(ctx, StartToolRequest{RunID: run2.ID, CallID: "write-1", Attempt: retried.Run.Attempt, ToolName: "write", Effect: ToolEffectSideEffect, Arguments: json.RawMessage(`{"value":1}`), ExpectedRevision: current.Revision, OwnerToken: lease.Token}); err != nil {
		t.Fatalf("new attempt start = %v", err)
	}
}

func TestApplyRecoveryActionResumeRestoresCheckpointState(t *testing.T) {
	ctx := context.Background()
	l := testLedger(t)
	defer l.Close()

	run, err := l.CreateRun(ctx, CreateRunRequest{SessionID: "resume-checkpoint-state", Policy: DefaultRunPolicy()})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := l.AcquireLease(ctx, run.ID, "resume-checkpoint-owner", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	run, err = l.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	run, err = l.TransitionRun(ctx, run.ID, RunStateQueued, RunStateRunningModel, run.Revision, lease.Token)
	if err != nil {
		t.Fatal(err)
	}
	checkpoint, err := l.SaveCheckpoint(ctx, SaveCheckpointRequest{
		RunID: run.ID, State: RunStateRunningTool, Sequence: 0,
		ConversationCursor: "before-interrupt", ExpectedRevision: run.Revision,
		OwnerToken: lease.Token,
	})
	if err != nil {
		t.Fatal(err)
	}
	if checkpoint.State != RunStateRunningTool {
		t.Fatalf("checkpoint state = %s", checkpoint.State)
	}
	if err := l.ReleaseLease(ctx, lease); err != nil {
		t.Fatal(err)
	}
	run, err = l.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	// Simulate a process interruption after the checkpoint was committed. The
	// recovery marker gets its own checkpoint, so resume must walk back to the
	// executable checkpoint above.
	if _, err := l.AppendEvent(ctx, AppendEventRequest{
		RunID: run.ID, ExpectedRevision: run.Revision,
		Kind: EventCheckpoint, ResultingState: RunStateInterrupted,
		Payload: CheckpointEvent{CheckpointID: checkpoint.ID, Sequence: run.NextSequence - 1},
	}); err != nil {
		t.Fatal(err)
	}
	run, err = l.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	resumed, err := l.ApplyRecoveryAction(ctx, RecoveryActionRequest{
		RunID: run.ID, Action: ControlResume, ExpectedRevision: run.Revision,
	})
	if err != nil {
		t.Fatal(err)
	}
	if resumed.Run.State != RunStateRunningTool {
		t.Fatalf("resumed state = %s, want %s", resumed.Run.State, RunStateRunningTool)
	}
	if len(resumed.Events) != 1 || resumed.Events[0].ResultingState != RunStateRunningTool {
		t.Fatalf("resume events = %#v", resumed.Events)
	}
}

func TestApplyRecoveryActionResumeUsesPriorCheckpointAfterRecoverRuns(t *testing.T) {
	ctx := context.Background()
	l := testLedger(t)
	defer l.Close()

	run, err := l.CreateRun(ctx, CreateRunRequest{SessionID: "resume-after-recover", Policy: DefaultRunPolicy()})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := l.AcquireLease(ctx, run.ID, "resume-after-recover-owner", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	run, err = l.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	run, err = l.TransitionRun(ctx, run.ID, RunStateQueued, RunStateRunningModel, run.Revision, lease.Token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.SaveCheckpoint(ctx, SaveCheckpointRequest{
		RunID: run.ID, State: RunStateAwaitingWorkspace, Sequence: 0,
		ExpectedRevision: run.Revision, OwnerToken: lease.Token,
	}); err != nil {
		t.Fatal(err)
	}
	if err := l.ReleaseLease(ctx, lease); err != nil {
		t.Fatal(err)
	}
	if _, err := l.RecoverRuns(ctx); err != nil {
		t.Fatal(err)
	}
	run, err = l.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if run.State != RunStateInterrupted {
		t.Fatalf("recovered state = %s", run.State)
	}
	resumed, err := l.ApplyRecoveryAction(ctx, RecoveryActionRequest{
		RunID: run.ID, Action: ControlResume, ExpectedRevision: run.Revision,
	})
	if err != nil {
		t.Fatal(err)
	}
	if resumed.Run.State != RunStateAwaitingWorkspace {
		t.Fatalf("resumed state = %s, want %s", resumed.Run.State, RunStateAwaitingWorkspace)
	}
}

func TestApplyRecoveryActionAbortIsSingleTerminal(t *testing.T) {
	ctx := context.Background()
	l, run, _ := recoveryRunWithUnknownTool(t)
	defer l.Close()
	aborted, err := l.ApplyRecoveryAction(ctx, RecoveryActionRequest{RunID: run.ID, Action: ControlAbortRecovery, ExpectedRevision: run.Revision})
	if err != nil {
		t.Fatal(err)
	}
	if aborted.Run.State != RunStateFailed || aborted.Run.TerminalReason != "user_aborted_recovery" {
		t.Fatalf("abort run = %#v", aborted.Run)
	}
	var terminals int
	if err := l.db.QueryRow(`SELECT COUNT(*) FROM events WHERE run_id=? AND kind='terminal'`, run.ID).Scan(&terminals); err != nil {
		t.Fatal(err)
	}
	if terminals != 1 {
		t.Fatalf("terminal count = %d", terminals)
	}
	repeated, err := l.ApplyRecoveryAction(ctx, RecoveryActionRequest{RunID: run.ID, Action: ControlAbortRecovery})
	if err != nil || repeated.Run.State != RunStateFailed {
		t.Fatalf("repeated abort = %#v, %v", repeated.Run, err)
	}
	if _, err := l.ApplyRecoveryAction(ctx, RecoveryActionRequest{RunID: run.ID, Action: ControlRecover}); !errors.Is(err, ErrTerminalRun) && err != nil {
		// A terminal recovery command is intentionally idempotent; either a
		// terminal no-op or the explicit terminal error is acceptable to callers.
		t.Fatalf("recover after abort = %v", err)
	}
}

func TestRecoverRunsReleasesOrphanedTokenReservations(t *testing.T) {
	l := testLedger(t)
	ctx := context.Background()
	run, err := l.CreateRun(ctx, CreateRunRequest{SessionID: "recovery-token-session", Policy: DefaultRunPolicy()})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := l.AcquireLease(ctx, run.ID, "recovery-token-owner", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	run, err = l.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	run, err = l.TransitionRun(ctx, run.ID, RunStateQueued, RunStateRunningModel, run.Revision, lease.Token)
	if err != nil {
		t.Fatal(err)
	}
	completedReservation, err := l.ReserveTokens(ctx, ReserveTokensRequest{
		RunID: run.ID, ReservationID: "completed-token-reservation", Tokens: 10,
		ExpectedRevision: run.Revision, OwnerToken: lease.Token,
	})
	if err != nil {
		t.Fatal(err)
	}
	run, err = l.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	completed, err := l.CommitModelTurn(ctx, CommitModelTurnRequest{
		RunID: run.ID, ExpectedRevision: run.Revision, OwnerToken: lease.Token,
		ReservationID:    completedReservation.ID,
		AssistantMessage: &Message{ID: "completed-token-message", Content: "persisted"},
		ModelCompleted:   ModelCompletedEvent{Text: "persisted"},
		Usage:            Usage{PromptTokens: 2, CompletionTokens: 3},
	})
	if err != nil {
		t.Fatal(err)
	}
	if completed.Run.TotalTokens != 5 {
		t.Fatalf("completed usage = %#v", completed.Run)
	}
	run, err = l.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	reservation, err := l.ReserveTokens(ctx, ReserveTokensRequest{
		RunID: run.ID, ReservationID: "orphaned-token-reservation", Tokens: 25,
		ExpectedRevision: run.Revision, OwnerToken: lease.Token,
	})
	if err != nil {
		t.Fatal(err)
	}
	if reservation.Status != "reserved" {
		t.Fatalf("reservation before recovery = %#v", reservation)
	}
	if err := l.ReleaseLease(ctx, lease); err != nil {
		t.Fatal(err)
	}

	recovered, err := l.RecoverRuns(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(recovered) != 1 || recovered[0].State != RunStateInterrupted {
		t.Fatalf("recovered = %#v", recovered)
	}
	afterRun, err := l.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if afterRun.ReservedTokens != 0 || afterRun.TotalTokens != 5 || afterRun.PromptTokens != 2 || afterRun.CompletionTokens != 3 {
		t.Fatalf("token counters after recovery = %#v", afterRun)
	}
	afterReservation, err := l.GetTokenReservation(ctx, reservation.ID)
	if err != nil {
		t.Fatal(err)
	}
	if afterReservation.Status != "reconciled" || afterReservation.PromptTokens != 0 || afterReservation.CompletionTokens != 0 || afterReservation.TotalTokens != 0 || afterReservation.ReconciledAt.IsZero() {
		t.Fatalf("reservation after recovery = %#v", afterReservation)
	}
}
