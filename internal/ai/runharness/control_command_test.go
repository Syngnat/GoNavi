package runharness

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestLedgerControlCommandPersistsExpectedRevision(t *testing.T) {
	ledger := testLedger(t)
	ctx := context.Background()
	run, err := ledger.CreateRun(ctx, CreateRunRequest{
		SessionID: "control-command-session",
		RequestID: "control-command-request",
		Policy:    DefaultRunPolicy(),
	})
	if err != nil {
		t.Fatal(err)
	}

	command, err := ledger.EnqueueCommand(ctx, ControlCommand{
		ID:               "control-command-1",
		RunID:            run.ID,
		Action:           ControlCancel,
		Payload:          json.RawMessage(`{"reason":"test"}`),
		ExpectedRevision: run.Revision,
	})
	if err != nil {
		t.Fatal(err)
	}
	if command.ExpectedRevision != run.Revision {
		t.Fatalf("enqueued expected revision = %d, want %d", command.ExpectedRevision, run.Revision)
	}

	commands, err := ledger.DequeueCommands(ctx, run.ID, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(commands) != 1 {
		t.Fatalf("dequeued commands = %#v", commands)
	}
	if commands[0].ExpectedRevision != run.Revision {
		t.Fatalf("dequeued expected revision = %d, want %d", commands[0].ExpectedRevision, run.Revision)
	}
	if string(commands[0].Payload) != `{"reason":"test"}` {
		t.Fatalf("dequeued payload = %s", commands[0].Payload)
	}
}

func TestLedgerControlCommandRejectsStaleExpectedRevision(t *testing.T) {
	ledger := testLedger(t)
	ctx := context.Background()
	run, err := ledger.CreateRun(ctx, CreateRunRequest{
		SessionID: "control-command-stale-session",
		RequestID: "control-command-stale-request",
		Policy:    DefaultRunPolicy(),
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = ledger.EnqueueCommand(ctx, ControlCommand{
		ID:               "control-command-stale",
		RunID:            run.ID,
		Action:           ControlCancel,
		ExpectedRevision: run.Revision + 1,
	})
	if !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("stale enqueue error = %v, want revision conflict", err)
	}
	commands, err := ledger.DequeueCommands(ctx, run.ID, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(commands) != 0 {
		t.Fatalf("stale command was persisted: %#v", commands)
	}
}

func TestLedgerControlCommandRequiresExpectedRevision(t *testing.T) {
	ledger := testLedger(t)
	ctx := context.Background()
	run, err := ledger.CreateRun(ctx, CreateRunRequest{
		SessionID: "control-command-required-revision-session",
		RequestID: "control-command-required-revision-request",
		Policy:    DefaultRunPolicy(),
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = ledger.EnqueueCommand(ctx, ControlCommand{
		ID: "control-command-missing-revision", RunID: run.ID, Action: ControlCancel,
	})
	if !errors.Is(err, ErrRevisionConflict) || !strings.Contains(err.Error(), "revision_conflict") {
		t.Fatalf("missing revision error = %v, want stable revision conflict", err)
	}
	var queued int
	if err := ledger.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM control_commands WHERE id=?`, "control-command-missing-revision").Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 0 {
		t.Fatalf("missing revision queued %d commands", queued)
	}
}

func TestLedgerControlCommandIdempotencyBindsActionAndPayload(t *testing.T) {
	ledger := testLedger(t)
	ctx := context.Background()
	run, err := ledger.CreateRun(ctx, CreateRunRequest{
		SessionID: "control-command-idempotency-session",
		RequestID: "control-command-idempotency-run",
		Policy:    DefaultRunPolicy(),
	})
	if err != nil {
		t.Fatal(err)
	}
	first := ControlCommand{
		ID:               "control-command-idempotency",
		RunID:            run.ID,
		Action:           ControlCancel,
		Payload:          json.RawMessage(`{"reason":"first"}`),
		ExpectedRevision: run.Revision,
	}
	if _, err := ledger.EnqueueCommand(ctx, first); err != nil {
		t.Fatal(err)
	}
	// A transport retry with the exact same command is a successful no-op and
	// returns the original durable command (including its creation timestamp).
	replay, err := ledger.EnqueueCommand(ctx, first)
	if err != nil {
		t.Fatalf("exact command replay: %v", err)
	}
	if replay.ID != first.ID || replay.Action != first.Action || string(replay.Payload) != string(first.Payload) {
		t.Fatalf("replayed command = %#v, want %#v", replay, first)
	}

	// Reusing the idempotency key for a different action or payload must never be
	// treated as a swallowed UNIQUE constraint: doing so could execute a stale
	// cancel/steer request under the caller's new intent.
	_, err = ledger.EnqueueCommand(ctx, ControlCommand{
		ID:               first.ID,
		RunID:            run.ID,
		Action:           ControlSteer,
		Payload:          json.RawMessage(`{"content":"different"}`),
		ExpectedRevision: run.Revision,
	})
	if !errors.Is(err, ErrControlCommandConflict) {
		t.Fatalf("different command error = %v, want ErrControlCommandConflict", err)
	}
	commands, err := ledger.DequeueCommands(ctx, run.ID, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(commands) != 1 || commands[0].Action != ControlCancel {
		t.Fatalf("durable commands after conflict = %#v", commands)
	}
}

func TestControlCancelTerminatesUnleasedQueuedRunWithoutWorker(t *testing.T) {
	ledger := testLedger(t)
	ctx := context.Background()
	run, err := ledger.CreateRun(ctx, CreateRunRequest{
		SessionID: "queued-cancel-session",
		RequestID: "queued-cancel-request",
		Policy:    DefaultRunPolicy(),
	})
	if err != nil {
		t.Fatal(err)
	}
	harness, err := NewAgentRunHarness(HarnessConfig{
		Ledger: ledger, RootContext: context.Background(), OwnerID: "queued-cancel-owner",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = harness.Close() })

	canceled, err := harness.ControlRun(ctx, RunControlRequest{
		RequestID:        "queued-cancel-command",
		RunID:            run.ID,
		Action:           ControlCancel,
		ExpectedRevision: run.Revision,
	})
	if err != nil {
		t.Fatalf("cancel queued run: %v", err)
	}
	if canceled.State != RunStateCanceled {
		t.Fatalf("cancel result state = %s, want %s", canceled.State, RunStateCanceled)
	}
	read, err := ledger.ReadRun(ctx, RunReadRequest{RunID: run.ID, Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	terminalCount := 0
	for _, event := range read.Events {
		if event.Kind == EventTerminal {
			terminalCount++
			if event.ResultingState != RunStateCanceled {
				t.Fatalf("terminal state = %s, want %s", event.ResultingState, RunStateCanceled)
			}
		}
	}
	if terminalCount != 1 {
		t.Fatalf("terminal event count = %d, want 1", terminalCount)
	}
	var applied, consumed int64
	if err := ledger.db.QueryRowContext(ctx, `SELECT applied_at,consumed_at FROM control_commands WHERE id=?`, "queued-cancel-command").Scan(&applied, &consumed); err != nil {
		t.Fatal(err)
	}
	if applied == 0 || consumed == 0 {
		t.Fatalf("queued cancel command was not durably acknowledged: applied=%d consumed=%d", applied, consumed)
	}
	claimed, err := ledger.ClaimCommands(ctx, run.ID, "queued-cancel-owner", 10, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(claimed) != 0 {
		t.Fatalf("terminal queued cancel remained replayable: %#v", claimed)
	}
}

func TestControlCancelOnTerminalRunIsIdempotentWithoutQueueingCommand(t *testing.T) {
	ledger := testLedger(t)
	ctx := context.Background()
	run, err := ledger.CreateRun(ctx, CreateRunRequest{
		SessionID: "terminal-cancel-session",
		RequestID: "terminal-cancel-request",
		Policy:    DefaultRunPolicy(),
	})
	if err != nil {
		t.Fatal(err)
	}
	harness, err := NewAgentRunHarness(HarnessConfig{
		Ledger: ledger, RootContext: context.Background(), OwnerID: "terminal-cancel-owner",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = harness.Close() })

	terminated, err := harness.ControlRun(ctx, RunControlRequest{
		RequestID: "terminal-cancel-first", RunID: run.ID, Action: ControlCancel, ExpectedRevision: run.Revision,
	})
	if err != nil {
		t.Fatalf("first cancel: %v", err)
	}
	if !terminated.State.Terminal() {
		t.Fatalf("first cancel state = %s, want terminal", terminated.State)
	}

	replayed, err := harness.ControlRun(ctx, RunControlRequest{
		RequestID: "terminal-cancel-retry", RunID: run.ID, Action: ControlCancel, ExpectedRevision: terminated.Revision,
	})
	if err != nil {
		t.Fatalf("terminal cancel replay: %v", err)
	}
	if replayed.ID != terminated.ID || replayed.State != terminated.State || replayed.Revision != terminated.Revision {
		t.Fatalf("terminal cancel replay = %#v, want %#v", replayed, terminated)
	}
	var queued int
	if err := ledger.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM control_commands WHERE id=?`, "terminal-cancel-retry").Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 0 {
		t.Fatalf("terminal cancel retry queued %d commands", queued)
	}
}

func TestLedgerControlCommandRejectsNewCommandForTerminalRun(t *testing.T) {
	ledger := testLedger(t)
	ctx := context.Background()
	run, err := ledger.CreateRun(ctx, CreateRunRequest{
		SessionID: "terminal-command-session",
		RequestID: "terminal-command-request",
		Policy:    DefaultRunPolicy(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.TransitionRun(ctx, run.ID, RunStateQueued, RunStateRunningModel, run.Revision, ""); err != nil {
		t.Fatal(err)
	}
	run, err = ledger.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.AppendEvent(ctx, AppendEventRequest{
		RunID: run.ID, ExpectedRevision: run.Revision, Kind: EventTerminal,
		ResultingState: RunStateCompleted, Payload: TerminalEvent{Reason: "done"}, TerminalReason: "done",
	}); err != nil {
		t.Fatal(err)
	}
	terminal, err := ledger.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = ledger.EnqueueCommand(ctx, ControlCommand{
		ID: "terminal-command", RunID: run.ID, Action: ControlSteer,
		Payload: json.RawMessage(`{"content":"too late"}`), ExpectedRevision: terminal.Revision,
	})
	if !errors.Is(err, ErrTerminalRun) {
		t.Fatalf("terminal command error = %v, want ErrTerminalRun", err)
	}
	var queued int
	if err := ledger.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM control_commands WHERE id=?`, "terminal-command").Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 0 {
		t.Fatalf("terminal run retained %d new control commands", queued)
	}
}

func TestTerminalEventConsumesPendingCommandsWithoutApplyingThem(t *testing.T) {
	ledger := testLedger(t)
	ctx := context.Background()
	run, err := ledger.CreateRun(ctx, CreateRunRequest{
		SessionID: "terminal-command-cleanup-session",
		RequestID: "terminal-command-cleanup-request",
		Policy:    DefaultRunPolicy(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.TransitionRun(ctx, run.ID, RunStateQueued, RunStateRunningModel, run.Revision, ""); err != nil {
		t.Fatal(err)
	}
	run, err = ledger.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	command := ControlCommand{
		ID:               "terminal-command-cleanup-steer",
		RunID:            run.ID,
		Action:           ControlSteer,
		Payload:          json.RawMessage(`{"content":"too late"}`),
		ExpectedRevision: run.Revision,
	}
	if _, err := ledger.EnqueueCommand(ctx, command); err != nil {
		t.Fatal(err)
	}
	claimed, err := ledger.ClaimCommands(ctx, run.ID, "terminal-command-cleanup-owner", 1, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(claimed) != 1 || claimed[0].ID != command.ID {
		t.Fatalf("claimed commands = %#v", claimed)
	}

	if _, err := ledger.AppendEvent(ctx, AppendEventRequest{
		RunID: run.ID, ExpectedRevision: run.Revision, Kind: EventTerminal,
		ResultingState: RunStateCompleted, Payload: TerminalEvent{Reason: "done"}, TerminalReason: "done",
	}); err != nil {
		t.Fatal(err)
	}
	var applied, consumed int64
	var claimedBy string
	if err := ledger.db.QueryRowContext(ctx, `SELECT applied_at,consumed_at,COALESCE(claimed_by,'') FROM control_commands WHERE id=?`, command.ID).Scan(&applied, &consumed, &claimedBy); err != nil {
		t.Fatal(err)
	}
	if applied != 0 || consumed == 0 || claimedBy != "" {
		t.Fatalf("terminal cleanup command = applied:%d consumed:%d claimedBy:%q, want unapplied consumed unclaimed", applied, consumed, claimedBy)
	}
	// A delayed worker acknowledgement cannot revive the tombstoned command as
	// an applied action after the terminal event has committed.
	if err := ledger.AckCommand(ctx, command.ID, "terminal-command-cleanup-owner"); err != nil {
		t.Fatalf("ack terminal-tombstoned command: %v", err)
	}
	if err := ledger.db.QueryRowContext(ctx, `SELECT applied_at,consumed_at FROM control_commands WHERE id=?`, command.ID).Scan(&applied, &consumed); err != nil {
		t.Fatal(err)
	}
	if applied != 0 || consumed == 0 {
		t.Fatalf("delayed ack changed terminal cleanup command: applied:%d consumed:%d", applied, consumed)
	}
	claimed, err = ledger.ClaimCommands(ctx, run.ID, "terminal-command-cleanup-next-owner", 10, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(claimed) != 0 {
		t.Fatalf("terminal-tombstoned command remained claimable: %#v", claimed)
	}
}

func TestRecoveryAbortConsumesPendingCommandsWithoutApplyingThem(t *testing.T) {
	ledger := testLedger(t)
	ctx := context.Background()
	run, err := ledger.CreateRun(ctx, CreateRunRequest{
		SessionID: "recovery-terminal-command-cleanup-session",
		RequestID: "recovery-terminal-command-cleanup-request",
		Policy:    DefaultRunPolicy(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.TransitionRun(ctx, run.ID, RunStateQueued, RunStateRunningModel, run.Revision, ""); err != nil {
		t.Fatal(err)
	}
	run, err = ledger.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.AppendEvent(ctx, AppendEventRequest{
		RunID: run.ID, ExpectedRevision: run.Revision, Kind: EventCheckpoint,
		ResultingState: RunStateRecoveryRequired, Payload: CheckpointEvent{},
	}); err != nil {
		t.Fatal(err)
	}
	run, err = ledger.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	command := ControlCommand{
		ID:               "recovery-terminal-command-cleanup-steer",
		RunID:            run.ID,
		Action:           ControlSteer,
		Payload:          json.RawMessage(`{"content":"too late"}`),
		ExpectedRevision: run.Revision,
	}
	if _, err := ledger.EnqueueCommand(ctx, command); err != nil {
		t.Fatal(err)
	}
	result, err := ledger.ApplyRecoveryAction(ctx, RecoveryActionRequest{
		RunID: run.ID, Action: ControlAbortRecovery, ExpectedRevision: run.Revision,
		CommandID:      "recovery-terminal-command-cleanup-abort",
		CommandPayload: json.RawMessage(`{"reason":"user requested abort"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Run.State != RunStateFailed {
		t.Fatalf("recovery abort state = %s, want %s", result.Run.State, RunStateFailed)
	}
	var applied, consumed int64
	if err := ledger.db.QueryRowContext(ctx, `SELECT applied_at,consumed_at FROM control_commands WHERE id=?`, command.ID).Scan(&applied, &consumed); err != nil {
		t.Fatal(err)
	}
	if applied != 0 || consumed == 0 {
		t.Fatalf("recovery terminal cleanup command = applied:%d consumed:%d, want unapplied consumed", applied, consumed)
	}
}

func TestConsumeControlCommandsTombstonesStaleCommandAfterRevisionAdvances(t *testing.T) {
	ledger := testLedger(t)
	ctx := context.Background()
	run, err := ledger.CreateRun(ctx, CreateRunRequest{
		SessionID: "control-command-consumer-session",
		RequestID: "control-command-consumer-request",
		Policy:    DefaultRunPolicy(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.EnqueueCommand(ctx, ControlCommand{
		ID:               "control-command-consumer",
		RunID:            run.ID,
		Action:           ControlCancel,
		ExpectedRevision: run.Revision,
	}); err != nil {
		t.Fatal(err)
	}

	// Simulate a model/tool callback committing after the command was accepted
	// but before a different process obtains and consumes it.
	if _, err := ledger.AppendEvent(ctx, AppendEventRequest{
		RunID:            run.ID,
		ExpectedRevision: run.Revision,
		Kind:             EventCheckpoint,
		ResultingState:   RunStateQueued,
		Payload:          CheckpointEvent{},
	}); err != nil {
		t.Fatal(err)
	}

	harness, err := NewAgentRunHarness(HarnessConfig{Ledger: ledger, RootContext: context.Background(), OwnerID: "control-command-consumer"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = harness.Close() })
	executionCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	execution := &runExecution{
		runID:     run.ID,
		sessionID: run.SessionID,
		ctx:       executionCtx,
		cancel:    cancel,
		done:      make(chan struct{}),
		wake:      make(chan struct{}, 1),
	}

	if !harness.consumeControlCommands(ctx, execution) {
		t.Fatal("stale control command was not consumed")
	}
	if execution.cancelRequested.Load() {
		t.Fatal("stale cancel command changed execution state")
	}
	if executionCtx.Err() != nil {
		t.Fatalf("stale cancel command canceled execution: %v", executionCtx.Err())
	}

	read, err := ledger.ReadRun(ctx, RunReadRequest{RunID: run.ID, Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	if read.Run.State != RunStateQueued {
		t.Fatalf("run state = %s, want queued", read.Run.State)
	}
	conflicts := 0
	for _, event := range read.Events {
		if event.Kind != EventRunError {
			continue
		}
		var payload RunErrorEvent
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		if payload.Code == "revision_conflict" {
			conflicts++
		}
	}
	if conflicts != 1 {
		t.Fatalf("revision conflict events = %d, want 1", conflicts)
	}
	var applied, consumed int64
	var claimedBy string
	if err := ledger.db.QueryRowContext(ctx, `SELECT applied_at,consumed_at,COALESCE(claimed_by,'') FROM control_commands WHERE id=?`, "control-command-consumer").Scan(&applied, &consumed, &claimedBy); err != nil {
		t.Fatal(err)
	}
	if applied != 0 || consumed == 0 || claimedBy != "" {
		t.Fatalf("stale control command = applied:%d consumed:%d claimedBy:%q, want unapplied consumed unclaimed", applied, consumed, claimedBy)
	}
	// A delayed worker acknowledgement must not turn a rejected command into an
	// applied action after the conflict is durably observable.
	if err := ledger.AckCommand(ctx, "control-command-consumer", harness.controlOwnerToken(execution)); err != nil {
		t.Fatalf("ack stale command: %v", err)
	}
	if err := ledger.db.QueryRowContext(ctx, `SELECT applied_at,consumed_at FROM control_commands WHERE id=?`, "control-command-consumer").Scan(&applied, &consumed); err != nil {
		t.Fatal(err)
	}
	if applied != 0 || consumed == 0 {
		t.Fatalf("delayed ack changed stale command: applied:%d consumed:%d", applied, consumed)
	}
	commands, err := ledger.DequeueCommands(ctx, run.ID, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(commands) != 0 {
		t.Fatalf("stale command was replayable: %#v", commands)
	}
}

func TestApplyUnownedQueuedCancelTombstonesStaleCommand(t *testing.T) {
	ledger := testLedger(t)
	ctx := context.Background()
	run, err := ledger.CreateRun(ctx, CreateRunRequest{
		SessionID: "queued-stale-cancel-session",
		RequestID: "queued-stale-cancel-request",
		Policy:    DefaultRunPolicy(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.EnqueueCommand(ctx, ControlCommand{
		ID:               "queued-stale-cancel-command",
		RunID:            run.ID,
		Action:           ControlCancel,
		ExpectedRevision: run.Revision,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.AppendEvent(ctx, AppendEventRequest{
		RunID: run.ID, ExpectedRevision: run.Revision, Kind: EventCheckpoint,
		ResultingState: RunStateQueued, Payload: CheckpointEvent{},
	}); err != nil {
		t.Fatal(err)
	}

	harness, err := NewAgentRunHarness(HarnessConfig{
		Ledger: ledger, RootContext: context.Background(), OwnerID: "queued-stale-cancel-owner",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = harness.Close() })

	result, err := harness.applyUnownedQueuedCancel(ctx, run.ID, "queued-stale-cancel-command")
	if err != nil {
		t.Fatalf("apply stale queued cancel: %v", err)
	}
	if result.State != RunStateQueued {
		t.Fatalf("stale queued cancel state = %s, want queued", result.State)
	}
	read, err := ledger.ReadRun(ctx, RunReadRequest{RunID: run.ID, Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	conflicts := 0
	for _, event := range read.Events {
		if event.Kind != EventRunError {
			continue
		}
		payload, decodeErr := DecodeEventPayload[RunErrorEvent](event)
		if decodeErr != nil {
			t.Fatal(decodeErr)
		}
		if payload.Code == "revision_conflict" {
			conflicts++
		}
	}
	if conflicts != 1 {
		t.Fatalf("stale queued cancel conflict events = %d, want 1", conflicts)
	}
	var applied, consumed int64
	var claimedBy string
	if err := ledger.db.QueryRowContext(ctx, `SELECT applied_at,consumed_at,COALESCE(claimed_by,'') FROM control_commands WHERE id=?`, "queued-stale-cancel-command").Scan(&applied, &consumed, &claimedBy); err != nil {
		t.Fatal(err)
	}
	if applied != 0 || consumed == 0 || claimedBy != "" {
		t.Fatalf("stale queued cancel = applied:%d consumed:%d claimedBy:%q, want unapplied consumed unclaimed", applied, consumed, claimedBy)
	}
}

func TestConsumeControlCommandsTombstonesStaleSteerWithoutAppendingInput(t *testing.T) {
	ledger := testLedger(t)
	ctx := context.Background()
	run, err := ledger.CreateRun(ctx, CreateRunRequest{
		SessionID: "stale-steer-session",
		RequestID: "stale-steer-request",
		Policy:    DefaultRunPolicy(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.EnqueueCommand(ctx, ControlCommand{
		ID:               "stale-steer-command",
		RunID:            run.ID,
		Action:           ControlSteer,
		Payload:          json.RawMessage(`{"content":"must not be appended"}`),
		ExpectedRevision: run.Revision,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.AppendEvent(ctx, AppendEventRequest{
		RunID: run.ID, ExpectedRevision: run.Revision, Kind: EventCheckpoint,
		ResultingState: RunStateQueued, Payload: CheckpointEvent{},
	}); err != nil {
		t.Fatal(err)
	}

	harness, err := NewAgentRunHarness(HarnessConfig{Ledger: ledger, RootContext: context.Background(), OwnerID: "stale-steer-owner"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = harness.Close() })
	executionCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	execution := &runExecution{
		runID: run.ID, sessionID: run.SessionID, ctx: executionCtx, cancel: cancel,
		done: make(chan struct{}), wake: make(chan struct{}, 1),
	}

	if !harness.consumeControlCommands(ctx, execution) {
		t.Fatal("stale steer command was not consumed")
	}
	if execution.hasSteer() {
		t.Fatal("stale steer was retained for execution")
	}
	messages, err := ledger.GetRunMessages(ctx, run.ID, 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	for _, message := range messages {
		if message.Content == "must not be appended" {
			t.Fatalf("stale steer unexpectedly appended message %#v", message)
		}
	}
	read, err := ledger.ReadRun(ctx, RunReadRequest{RunID: run.ID, Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	if read.Run.State != RunStateQueued {
		t.Fatalf("stale steer state = %s, want queued", read.Run.State)
	}
	conflicts := 0
	for _, event := range read.Events {
		if event.Kind != EventRunError {
			continue
		}
		payload, decodeErr := DecodeEventPayload[RunErrorEvent](event)
		if decodeErr != nil {
			t.Fatal(decodeErr)
		}
		if payload.Code == "revision_conflict" {
			conflicts++
		}
	}
	if conflicts != 1 {
		t.Fatalf("stale steer conflict events = %d, want 1", conflicts)
	}
	var applied, consumed int64
	if err := ledger.db.QueryRowContext(ctx, `SELECT applied_at,consumed_at FROM control_commands WHERE id=?`, "stale-steer-command").Scan(&applied, &consumed); err != nil {
		t.Fatal(err)
	}
	if applied != 0 || consumed == 0 {
		t.Fatalf("stale steer = applied:%d consumed:%d, want unapplied consumed", applied, consumed)
	}
}
