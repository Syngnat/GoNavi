package runharness

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func newAtomicToolRun(t *testing.T) (*Ledger, RunSnapshot, Lease) {
	t.Helper()
	ledger := testLedger(t)
	ctx := context.Background()
	run, err := ledger.CreateRun(ctx, CreateRunRequest{
		SessionID: "atomic-tool-session",
		Policy:    DefaultRunPolicy(),
		InitialMessage: &Message{
			ID: "existing-message", Role: "user", Content: "run tool",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := ledger.AcquireLease(ctx, run.ID, "atomic-tool-owner", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	run, err = ledger.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	run, err = ledger.TransitionRun(ctx, run.ID, RunStateQueued, RunStateRunningModel, run.Revision, lease.Token)
	if err != nil {
		t.Fatal(err)
	}
	return ledger, run, lease
}

func startAtomicToolRun(t *testing.T) (*Ledger, RunSnapshot, Lease) {
	t.Helper()
	ledger, run, lease := newAtomicToolRun(t)
	if _, err := ledger.StartToolAndEvent(context.Background(), StartToolAndEventRequest{StartToolRequest: StartToolRequest{
		RunID: run.ID, CallID: "atomic-call", Attempt: run.Attempt,
		ToolName: "read", Effect: ToolEffectReadOnly,
		Arguments:        json.RawMessage(`{"value":1}`),
		ExpectedRevision: run.Revision, OwnerToken: lease.Token,
	}}); err != nil {
		t.Fatal(err)
	}
	var err error
	run, err = ledger.GetRun(context.Background(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	return ledger, run, lease
}

func TestStartToolAndEventPersistsReplayableStartBoundary(t *testing.T) {
	ledger, before, lease := newAtomicToolRun(t)
	ctx := context.Background()
	arguments := json.RawMessage(`{"value":1}`)
	workspace := &WorkspaceSnapshotReference{
		SourceID: "desktop", SourceInstanceID: "desktop-instance",
		Revision: 7, ContentHash: "snapshot-hash",
	}

	started, err := ledger.StartToolAndEvent(ctx, StartToolAndEventRequest{
		StartToolRequest: StartToolRequest{
			RunID: before.ID, CallID: "started-call", Attempt: before.Attempt,
			ToolName: "read", Effect: ToolEffectReadOnly, Arguments: arguments,
			WorkspaceSnapshot: workspace, ExpectedRevision: before.Revision, OwnerToken: lease.Token,
		},
		ToolEvent:          ToolEvent{Status: "ignored"},
		ConversationCursor: "cursor-before-tool",
		ProviderState:      json.RawMessage(`{"provider":"state"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if started.AlreadyStarted || started.Tool.Status != "started" || started.Tool.ArgsHash != hashBytes(arguments) {
		t.Fatalf("started tool = %#v", started)
	}
	if started.Event.Kind != EventTool || started.Event.Sequence != before.NextSequence ||
		started.Event.ResultingState != RunStateRunningTool || started.Checkpoint.ID == "" ||
		started.Checkpoint.Sequence != started.Event.Sequence {
		t.Fatalf("started boundary = %#v", started)
	}
	if started.Tool.WorkspaceSnapshot == nil || *started.Tool.WorkspaceSnapshot != *workspace ||
		started.Checkpoint.WorkspaceSnapshot == nil || *started.Checkpoint.WorkspaceSnapshot != *workspace {
		t.Fatalf("workspace reference was not persisted: %#v", started)
	}

	after, err := ledger.GetRun(ctx, before.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.State != RunStateRunningTool || after.Revision != before.Revision+1 ||
		after.NextSequence != before.NextSequence+1 || after.CheckpointID != started.Checkpoint.ID {
		t.Fatalf("run after start = %#v", after)
	}
	replay, err := ledger.ReadRun(ctx, RunReadRequest{RunID: before.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(replay.Events) != 1 || replay.Events[0].Sequence != started.Event.Sequence {
		t.Fatalf("replayed events = %#v", replay.Events)
	}
	var event ToolEvent
	if err := json.Unmarshal(replay.Events[0].Payload, &event); err != nil {
		t.Fatal(err)
	}
	if event.Status != "started" || event.CallID != "started-call" || event.ArgsHash != started.Tool.ArgsHash ||
		event.WorkspaceSnapshot == nil || *event.WorkspaceSnapshot != *workspace {
		t.Fatalf("replayed start event = %#v", event)
	}

	duplicate := StartToolAndEventRequest{StartToolRequest: StartToolRequest{
		RunID: before.ID, CallID: "started-call", Attempt: before.Attempt,
		ToolName: "read", Effect: ToolEffectReadOnly, Arguments: arguments,
		WorkspaceSnapshot: workspace, OwnerToken: lease.Token,
	}}
	again, err := ledger.StartToolAndEvent(ctx, duplicate)
	if err != nil || !again.AlreadyStarted || again.Event.Sequence != 0 {
		t.Fatalf("idempotent start = %#v, %v", again, err)
	}
}

func TestStartToolAndEventRollsBackOnEventFailure(t *testing.T) {
	ledger, before, lease := newAtomicToolRun(t)
	ctx := context.Background()
	if _, err := ledger.db.ExecContext(ctx, `CREATE TRIGGER reject_started_tool_event
		BEFORE INSERT ON events WHEN NEW.kind='tool'
		BEGIN SELECT RAISE(ABORT, 'reject started tool event'); END`); err != nil {
		t.Fatal(err)
	}
	counts := func() (tools, checkpoints, events int) {
		t.Helper()
		if err := ledger.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM tool_calls WHERE run_id=?`, before.ID).Scan(&tools); err != nil {
			t.Fatal(err)
		}
		if err := ledger.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM checkpoints WHERE run_id=?`, before.ID).Scan(&checkpoints); err != nil {
			t.Fatal(err)
		}
		if err := ledger.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM events WHERE run_id=?`, before.ID).Scan(&events); err != nil {
			t.Fatal(err)
		}
		return tools, checkpoints, events
	}
	beforeTools, beforeCheckpoints, beforeEvents := counts()
	if _, err := ledger.StartToolAndEvent(ctx, StartToolAndEventRequest{StartToolRequest: StartToolRequest{
		RunID: before.ID, CallID: "rollback-call", Attempt: before.Attempt,
		ToolName: "read", Effect: ToolEffectReadOnly, Arguments: json.RawMessage(`{}`),
		ExpectedRevision: before.Revision, OwnerToken: lease.Token,
	}}); err == nil {
		t.Fatal("expected started event trigger failure")
	}
	after, err := ledger.GetRun(ctx, before.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Revision != before.Revision || after.State != before.State || after.NextSequence != before.NextSequence || after.CheckpointID != before.CheckpointID {
		t.Fatalf("run changed after start rollback: before=%#v after=%#v", before, after)
	}
	afterTools, afterCheckpoints, afterEvents := counts()
	if afterTools != beforeTools || afterCheckpoints != beforeCheckpoints || afterEvents != beforeEvents {
		t.Fatalf("start rollback records = tools %d/%d checkpoints %d/%d events %d/%d", afterTools, beforeTools, afterCheckpoints, beforeCheckpoints, afterEvents, beforeEvents)
	}
}

func TestFinishToolAndEventRollsBackEveryRecordWhenMessageInsertFails(t *testing.T) {
	ledger, before, lease := startAtomicToolRun(t)
	ctx := context.Background()

	_, err := ledger.FinishToolAndEvent(ctx, FinishToolAndEventRequest{
		FinishToolRequest: FinishToolRequest{
			RunID: before.ID, CallID: "atomic-call", Status: "completed",
			Result: map[string]any{"ok": true}, ExpectedRevision: before.Revision,
			OwnerToken: lease.Token,
		},
		ResultingState: RunStateRunningModel,
		ToolEvent:      ToolEvent{Status: "completed"},
		// Reusing the initial user message ID forces the final insert in the
		// transaction to fail after the tool/checkpoint/event/run writes.
		ToolMessage: &Message{ID: "existing-message", Content: `{"ok":true}`},
	})
	if err == nil {
		t.Fatal("expected duplicate message insert to fail")
	}

	after, getErr := ledger.GetRun(ctx, before.ID)
	if getErr != nil {
		t.Fatal(getErr)
	}
	if after.Revision != before.Revision || after.State != before.State || after.CheckpointID != before.CheckpointID || after.NextSequence != before.NextSequence {
		t.Fatalf("run changed after rollback: before=%#v after=%#v", before, after)
	}
	var status string
	if err := ledger.db.QueryRowContext(ctx, `SELECT status FROM tool_calls WHERE run_id=? AND call_id=?`, before.ID, "atomic-call").Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "started" {
		t.Fatalf("tool status after rollback = %q", status)
	}
	for name, query := range map[string]string{
		"events":      `SELECT COUNT(*) FROM events WHERE run_id=?`,
		"checkpoints": `SELECT COUNT(*) FROM checkpoints WHERE run_id=?`,
	} {
		var count int
		if err := ledger.db.QueryRowContext(ctx, query, before.ID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("%s count after rollback = %d, want durable start boundary only", name, count)
		}
	}
	var messages int
	if err := ledger.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages WHERE session_id=?`, before.SessionID).Scan(&messages); err != nil {
		t.Fatal(err)
	}
	if messages != 1 {
		t.Fatalf("message count after rollback = %d", messages)
	}
}

func TestFinishToolAndEventIsIdempotentWithoutDuplicateMessage(t *testing.T) {
	ledger, run, lease := startAtomicToolRun(t)
	ctx := context.Background()
	request := FinishToolAndEventRequest{
		FinishToolRequest: FinishToolRequest{
			RunID: run.ID, CallID: "atomic-call", Status: "completed",
			Result: map[string]any{"ok": true}, ExpectedRevision: run.Revision,
			OwnerToken: lease.Token,
		},
		ResultingState: RunStateRunningModel,
		ToolEvent:      ToolEvent{Status: "completed"},
		ToolMessage:    &Message{ID: "atomic-tool-message", Content: `{"ok":true}`},
	}
	first, err := ledger.FinishToolAndEvent(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if first.Message.ID != "atomic-tool-message" || first.Event.Kind != EventTool || first.Checkpoint.ID == "" {
		t.Fatalf("first completion = %#v", first)
	}

	request.ExpectedRevision = 0
	second, err := ledger.FinishToolAndEvent(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if !second.AlreadyFinished || second.Event.Sequence != 0 || second.Message.ID != "" {
		t.Fatalf("idempotent completion = %#v", second)
	}
	for name, query := range map[string]string{
		"events":      `SELECT COUNT(*) FROM events WHERE run_id=? AND kind='tool'`,
		"checkpoints": `SELECT COUNT(*) FROM checkpoints WHERE run_id=?`,
		"messages":    `SELECT COUNT(*) FROM messages WHERE run_id=? AND role='tool'`,
	} {
		var count int
		if err := ledger.db.QueryRowContext(ctx, query, run.ID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		want := 1
		if name != "messages" {
			want = 2 // durable started + completed boundaries
		}
		if count != want {
			t.Fatalf("%s count = %d, want %d", name, count, want)
		}
	}
}
