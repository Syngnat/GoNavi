package runharness

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func runningModelRunForRecoveryTest(t *testing.T, sessionID string) (*Ledger, RunSnapshot, Lease) {
	t.Helper()
	l := testLedger(t)
	ctx := context.Background()
	run, err := l.CreateRun(ctx, CreateRunRequest{SessionID: sessionID, Policy: DefaultRunPolicy()})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := l.AcquireLease(ctx, run.ID, "recovery-checkpoint-owner", time.Minute)
	if err != nil {
		l.Close()
		t.Fatal(err)
	}
	run, err = l.GetRun(ctx, run.ID)
	if err != nil {
		l.Close()
		t.Fatal(err)
	}
	run, err = l.TransitionRun(ctx, run.ID, RunStateQueued, RunStateRunningModel, run.Revision, lease.Token)
	if err != nil {
		l.Close()
		t.Fatal(err)
	}
	return l, run, lease
}

func TestSaveCheckpointRejectsInvalidStateAndStaleBoundary(t *testing.T) {
	ctx := context.Background()
	l, run, lease := runningModelRunForRecoveryTest(t, "checkpoint-boundary")
	defer l.Close()

	first, err := l.SaveCheckpoint(ctx, SaveCheckpointRequest{
		RunID: run.ID, State: RunStateRunningModel, Sequence: 0,
		ExpectedRevision: run.Revision, OwnerToken: lease.Token,
	})
	if err != nil {
		t.Fatalf("save first checkpoint: %v", err)
	}
	if first.Sequence != 0 {
		t.Fatalf("first checkpoint sequence = %d, want 0", first.Sequence)
	}

	var before int
	if err := l.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM checkpoints WHERE run_id=?`, run.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	invalidStates := []RunState{
		RunStateQueued, RunStateInterrupted, RunStateRecoveryRequired,
		RunStateCanceling, RunStateCompleted,
	}
	for _, state := range invalidStates {
		current, getErr := l.GetRun(ctx, run.ID)
		if getErr != nil {
			t.Fatal(getErr)
		}
		_, saveErr := l.SaveCheckpoint(ctx, SaveCheckpointRequest{
			RunID: run.ID, State: state, Sequence: 0,
			ExpectedRevision: current.Revision, OwnerToken: lease.Token,
		})
		if saveErr == nil {
			t.Fatalf("save checkpoint state %s unexpectedly succeeded", state)
		}
	}
	var afterInvalid int
	if err := l.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM checkpoints WHERE run_id=?`, run.ID).Scan(&afterInvalid); err != nil {
		t.Fatal(err)
	}
	if afterInvalid != before {
		t.Fatalf("invalid checkpoint attempts left rows: before=%d after=%d", before, afterInvalid)
	}

	current, err := l.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.AppendEvent(ctx, AppendEventRequest{
		RunID: current.ID, ExpectedRevision: current.Revision,
		ExpectedSequence: current.NextSequence, Kind: EventModelDelta,
		ResultingState: RunStateRunningModel, Payload: ModelDeltaEvent{Text: "boundary"},
		OwnerToken: lease.Token,
	}); err != nil {
		t.Fatal(err)
	}
	current, err = l.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.NextSequence != 2 {
		t.Fatalf("next sequence = %d, want 2", current.NextSequence)
	}
	if _, err := l.SaveCheckpoint(ctx, SaveCheckpointRequest{
		RunID: run.ID, State: RunStateRunningModel, Sequence: 0,
		ExpectedRevision: current.Revision, OwnerToken: lease.Token,
	}); !errors.Is(err, ErrSequenceConflict) {
		t.Fatalf("stale checkpoint sequence error = %v, want ErrSequenceConflict", err)
	}
	if _, err := l.SaveCheckpoint(ctx, SaveCheckpointRequest{
		RunID: run.ID, State: RunStateRunningModel, Sequence: 2,
		ExpectedRevision: current.Revision, OwnerToken: lease.Token,
	}); !errors.Is(err, ErrSequenceConflict) {
		t.Fatalf("future checkpoint sequence error = %v, want ErrSequenceConflict", err)
	}
	valid, err := l.SaveCheckpoint(ctx, SaveCheckpointRequest{
		RunID: run.ID, State: RunStateRunningModel, Sequence: 1,
		ExpectedRevision: current.Revision, OwnerToken: lease.Token,
	})
	if err != nil {
		t.Fatalf("save boundary checkpoint: %v", err)
	}
	if valid.Sequence != current.NextSequence-1 {
		t.Fatalf("checkpoint sequence = %d, want %d", valid.Sequence, current.NextSequence-1)
	}

	// A second write at an older boundary must not be able to create a row even
	// when its run revision is current.
	current, err = l.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.SaveCheckpoint(ctx, SaveCheckpointRequest{
		RunID: run.ID, State: RunStateRunningModel, Sequence: 0,
		ExpectedRevision: current.Revision, OwnerToken: lease.Token,
	}); !errors.Is(err, ErrSequenceConflict) {
		t.Fatalf("old checkpoint overwrite error = %v, want ErrSequenceConflict", err)
	}
}

func TestLoadRunResumeContextRestoresCheckpointAndPendingTool(t *testing.T) {
	ctx := context.Background()
	l, run, lease := runningModelRunForRecoveryTest(t, "resume-context")
	defer l.Close()

	checkpoint, err := l.SaveCheckpoint(ctx, SaveCheckpointRequest{
		RunID: run.ID, State: RunStateRunningModel, Sequence: 0,
		ConversationCursor: "cursor-before-tool",
		ProviderState:      json.RawMessage(`{"provider":"checkpoint"}`),
		ExpectedRevision:   run.Revision, OwnerToken: lease.Token,
	})
	if err != nil {
		t.Fatal(err)
	}
	run, err = l.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	started, err := l.StartToolAndEvent(ctx, StartToolAndEventRequest{StartToolRequest: StartToolRequest{
		RunID: run.ID, CallID: "pending-read", Attempt: run.Attempt,
		ToolName: "read", Effect: ToolEffectReadOnly,
		Arguments:        json.RawMessage(`{"table":"orders"}`),
		ExpectedRevision: run.Revision, OwnerToken: lease.Token,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if started.Tool.Status != "started" {
		t.Fatalf("started tool status = %s", started.Tool.Status)
	}

	resume, err := l.LoadRunResumeContext(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if resume.Run.State != RunStateRunningTool || resume.ResumeState != RunStateRunningTool {
		t.Fatalf("resume state = run:%s resume:%s, want running_tool", resume.Run.State, resume.ResumeState)
	}
	if resume.Checkpoint == nil || resume.Checkpoint.ID == checkpoint.ID || resume.Checkpoint.Sequence != 1 || resume.Checkpoint.State != RunStateRunningTool {
		t.Fatalf("resume checkpoint = %#v, want start-boundary checkpoint after %s", resume.Checkpoint, checkpoint.ID)
	}
	if resume.Checkpoint.ConversationCursor != "cursor-before-tool" || string(resume.Checkpoint.ProviderState) != `{"provider":"checkpoint"}` {
		t.Fatalf("resume checkpoint payload = %#v", resume.Checkpoint)
	}
	if resume.PendingTool == nil || resume.PendingTool.CallID != "pending-read" || resume.PendingTool.Attempt != run.Attempt {
		t.Fatalf("pending tool = %#v", resume.PendingTool)
	}
}

func TestLoadRunResumeContextPrefersUnknownSideEffect(t *testing.T) {
	ctx := context.Background()
	l, run, lease := runningModelRunForRecoveryTest(t, "resume-unknown")
	defer l.Close()

	if _, err := l.StartTool(ctx, StartToolRequest{
		RunID: run.ID, CallID: "pending-write", Attempt: run.Attempt,
		ToolName: "write", Effect: ToolEffectSideEffect,
		Arguments:        json.RawMessage(`{"value":1}`),
		ExpectedRevision: run.Revision, OwnerToken: lease.Token,
	}); err != nil {
		t.Fatal(err)
	}
	resume, err := l.LoadRunResumeContext(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if resume.ResumeState != RunStateRecoveryRequired {
		t.Fatalf("resume state = %s, want recovery_required", resume.ResumeState)
	}
	if resume.PendingTool == nil || resume.PendingTool.Effect != ToolEffectSideEffect || resume.PendingTool.Status != "started" {
		t.Fatalf("pending unknown tool = %#v", resume.PendingTool)
	}
}

func TestLoadRunResumeContextNoCheckpointIsSafe(t *testing.T) {
	l, run, _ := runningModelRunForRecoveryTest(t, "resume-empty")
	defer l.Close()
	resume, err := l.LoadRunResumeContext(context.Background(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if resume.Checkpoint != nil || resume.PendingTool != nil || resume.PendingApproval != nil {
		t.Fatalf("empty resume context = %#v", resume)
	}
	if resume.ResumeState != RunStateRunningModel {
		t.Fatalf("empty resume state = %s, want running_model", resume.ResumeState)
	}
	if _, err := l.GetCheckpoint(context.Background(), "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing checkpoint error = %v", err)
	}
}
