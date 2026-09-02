package runharness

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func startModelAtomicRun(t *testing.T, maxTokens int) (*Ledger, RunSnapshot, Lease) {
	t.Helper()
	ledger := testLedger(t)
	ctx := context.Background()
	policy := DefaultRunPolicy()
	policy.MaxTotalTokens = maxTokens
	run, err := ledger.CreateRun(ctx, CreateRunRequest{SessionID: "model-atomic-session", Policy: policy, InitialMessage: &Message{ID: "model-user-message", Role: "user", Content: "answer"}})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := ledger.AcquireLease(ctx, run.ID, "model-atomic-owner", time.Minute)
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

func TestCommitModelTurnAtomicallyPersistsMessageEventsCheckpointAndUsage(t *testing.T) {
	ledger, run, lease := startModelAtomicRun(t, 100)
	ctx := context.Background()
	reservation, err := ledger.ReserveTokens(ctx, ReserveTokensRequest{RunID: run.ID, ReservationID: "model-reservation", Tokens: 20, ExpectedRevision: run.Revision, OwnerToken: lease.Token})
	if err != nil {
		t.Fatal(err)
	}
	run, err = ledger.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	result, err := ledger.CommitModelTurn(ctx, CommitModelTurnRequest{
		RunID: run.ID, ExpectedRevision: run.Revision, OwnerToken: lease.Token,
		ReservationID:      reservation.ID,
		AssistantMessage:   &Message{ID: "model-assistant-message", Content: "done", Reasoning: "checked"},
		ModelCompleted:     ModelCompletedEvent{Text: "done", Reasoning: "checked", Usage: Usage{PromptTokens: 4, CompletionTokens: 3, TotalTokens: 7}},
		Usage:              Usage{PromptTokens: 4, CompletionTokens: 3, TotalTokens: 7},
		ConversationCursor: "cursor-1", ProviderState: json.RawMessage(`{"provider":"state"}`),
		ResultingState: RunStateRunningModel,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Run.TotalTokens != 7 || result.Run.PromptTokens != 4 || result.Run.CompletionTokens != 3 || result.Run.ReservedTokens != 0 {
		t.Fatalf("token projection = %#v", result.Run)
	}
	if result.Message == nil || result.Message.ID != "model-assistant-message" {
		t.Fatalf("message = %#v", result.Message)
	}
	if len(result.Events) != 3 || result.Events[0].Kind != EventModelCompleted || result.Events[1].Kind != EventUsage || result.Events[2].Kind != EventCheckpoint {
		t.Fatalf("events = %#v", result.Events)
	}
	if result.Checkpoint.ID == "" || result.Checkpoint.ConversationCursor != "cursor-1" {
		t.Fatalf("checkpoint = %#v", result.Checkpoint)
	}
	var count int
	if err := ledger.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages WHERE run_id=? AND role='assistant'`, run.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("assistant messages = %d", count)
	}
	reservationAfter, err := ledger.GetTokenReservation(ctx, reservation.ID)
	if err != nil {
		t.Fatal(err)
	}
	if reservationAfter.Status != "reconciled" || reservationAfter.TotalTokens != 7 || reservationAfter.CommittedSequence == 0 {
		t.Fatalf("reservation = %#v", reservationAfter)
	}

	// A lost response can be retried with the same reservation. The commit
	// marker returns a no-op and cannot append a second assistant/event set.
	retry, err := ledger.CommitModelTurn(ctx, CommitModelTurnRequest{
		RunID: run.ID, OwnerToken: lease.Token, ReservationID: reservation.ID,
		AssistantMessage: &Message{ID: "different-message", Content: "duplicate"},
		ModelCompleted:   ModelCompletedEvent{Text: "duplicate"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !retry.AlreadyCommitted || len(retry.Events) != 0 {
		t.Fatalf("retry = %#v", retry)
	}
	if err := ledger.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM events WHERE run_id=?`, run.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 3 {
		t.Fatalf("events after retry = %d", count)
	}
}

func TestCommitModelTurnRollsBackOnAssistantMessageConflict(t *testing.T) {
	ledger, run, lease := startModelAtomicRun(t, 100)
	ctx := context.Background()
	reservation, err := ledger.ReserveTokens(ctx, ReserveTokensRequest{RunID: run.ID, ReservationID: "rollback-reservation", Tokens: 10, ExpectedRevision: run.Revision, OwnerToken: lease.Token})
	if err != nil {
		t.Fatal(err)
	}
	run, _ = ledger.GetRun(ctx, run.ID)
	_, err = ledger.CommitModelTurn(ctx, CommitModelTurnRequest{
		RunID: run.ID, ExpectedRevision: run.Revision, OwnerToken: lease.Token, ReservationID: reservation.ID,
		AssistantMessage: &Message{ID: "model-user-message", Content: "conflict"},
		ModelCompleted:   ModelCompletedEvent{Text: "conflict"}, Usage: Usage{TotalTokens: 5},
	})
	if err == nil {
		t.Fatal("expected duplicate message conflict")
	}
	after, err := ledger.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Revision != run.Revision || after.TotalTokens != 0 || after.ReservedTokens != 10 || after.NextSequence != run.NextSequence {
		t.Fatalf("run changed after rollback: before=%#v after=%#v", run, after)
	}
	var count int
	if err := ledger.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM events WHERE run_id=?`, run.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("events after rollback = %d", count)
	}
	reservationAfter, err := ledger.GetTokenReservation(ctx, reservation.ID)
	if err != nil {
		t.Fatal(err)
	}
	if reservationAfter.Status != "reserved" {
		t.Fatalf("reservation after rollback = %#v", reservationAfter)
	}
}

func TestCommitModelTurnRejectsBudgetOverrunWithoutMutation(t *testing.T) {
	ledger, run, lease := startModelAtomicRun(t, 5)
	ctx := context.Background()
	reservation, err := ledger.ReserveTokens(ctx, ReserveTokensRequest{RunID: run.ID, ReservationID: "budget-reservation", Tokens: 5, ExpectedRevision: run.Revision, OwnerToken: lease.Token})
	if err != nil {
		t.Fatal(err)
	}
	run, _ = ledger.GetRun(ctx, run.ID)
	if _, err := ledger.CommitModelTurn(ctx, CommitModelTurnRequest{RunID: run.ID, ExpectedRevision: run.Revision, OwnerToken: lease.Token, ReservationID: reservation.ID, ModelCompleted: ModelCompletedEvent{Text: "too much"}, Usage: Usage{TotalTokens: 6}}); !errors.Is(err, ErrTokenBudgetExceeded) {
		t.Fatalf("budget error = %v", err)
	}
	after, _ := ledger.GetRun(ctx, run.ID)
	if after.TotalTokens != 0 || after.ReservedTokens != 5 || after.Revision != run.Revision {
		t.Fatalf("budget mutation = %#v", after)
	}
}

func TestCommitModelTurnRetryIsIdempotentAfterTerminalAndLeaseRelease(t *testing.T) {
	ledger, run, lease := startModelAtomicRun(t, 100)
	ctx := context.Background()
	reservation, err := ledger.ReserveTokens(ctx, ReserveTokensRequest{
		RunID: run.ID, ReservationID: "terminal-retry-reservation", Tokens: 20,
		ExpectedRevision: run.Revision, OwnerToken: lease.Token,
	})
	if err != nil {
		t.Fatal(err)
	}
	run, err = ledger.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	committed, err := ledger.CommitModelTurn(ctx, CommitModelTurnRequest{
		RunID: run.ID, ExpectedRevision: run.Revision, OwnerToken: lease.Token,
		ReservationID:    reservation.ID,
		AssistantMessage: &Message{ID: "terminal-retry-message", Content: "done"},
		ModelCompleted:   ModelCompletedEvent{Text: "done"},
		Usage:            Usage{PromptTokens: 2, CompletionTokens: 2},
	})
	if err != nil {
		t.Fatal(err)
	}
	terminalEvent, err := ledger.AppendEvent(ctx, AppendEventRequest{
		RunID: committed.Run.ID, ExpectedRevision: committed.Run.Revision,
		OwnerToken: lease.Token, Kind: EventTerminal, ResultingState: RunStateCompleted,
		Payload: map[string]any{"reason": "completed"}, TerminalReason: "completed",
	})
	if err != nil {
		t.Fatal(err)
	}
	if terminalEvent.ResultingState != RunStateCompleted {
		t.Fatalf("terminal event = %#v", terminalEvent)
	}
	if err := ledger.ReleaseLease(ctx, lease); err != nil {
		t.Fatal(err)
	}

	// The callback may arrive after both the owner lease and the run have
	// advanced. The reservation marker must make this a no-op even when the
	// retry carries stale revision data and an otherwise invalid payload.
	retry, err := ledger.CommitModelTurn(ctx, CommitModelTurnRequest{
		RunID:            run.ID,
		ExpectedRevision: 1,
		ReservationID:    reservation.ID,
		ResultingState:   RunStateCompleted,
		ModelCompleted:   ModelCompletedEvent{Text: "invalid duplicate", Usage: Usage{PromptTokens: -1}},
		Usage:            Usage{PromptTokens: -1},
	})
	if err != nil {
		t.Fatalf("idempotent retry after terminal = %v", err)
	}
	if !retry.AlreadyCommitted || retry.Run.State != RunStateCompleted {
		t.Fatalf("retry = %#v", retry)
	}
	var events, messages int
	if err := ledger.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM events WHERE run_id=?`, run.ID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if err := ledger.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages WHERE run_id=? AND role='assistant'`, run.ID).Scan(&messages); err != nil {
		t.Fatal(err)
	}
	if events != 4 || messages != 1 {
		t.Fatalf("duplicate durable rows: events=%d messages=%d", events, messages)
	}
}

func TestCommitModelTurnPromotesSeparatelyReconciledReservation(t *testing.T) {
	ledger, run, lease := startModelAtomicRun(t, 100)
	ctx := context.Background()
	reservation, err := ledger.ReserveTokens(ctx, ReserveTokensRequest{
		RunID: run.ID, ReservationID: "separate-reconcile-reservation", Tokens: 20,
		ExpectedRevision: run.Revision, OwnerToken: lease.Token,
	})
	if err != nil {
		t.Fatal(err)
	}
	run, err = ledger.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	reconciled, err := ledger.ReconcileTokens(ctx, ReconcileTokensRequest{
		RunID: run.ID, ReservationID: reservation.ID,
		Usage:            Usage{PromptTokens: 3, CompletionTokens: 4, TotalTokens: 7},
		ExpectedRevision: run.Revision, OwnerToken: lease.Token,
	})
	if err != nil {
		t.Fatal(err)
	}
	run, err = ledger.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	result, err := ledger.CommitModelTurn(ctx, CommitModelTurnRequest{
		RunID: run.ID, ExpectedRevision: run.Revision, OwnerToken: lease.Token,
		ReservationID:    reservation.ID,
		AssistantMessage: &Message{ID: "separate-reconcile-message", Content: "done"},
		ModelCompleted:   ModelCompletedEvent{Text: "done", Usage: reconciledToUsage(reconciled)},
		Usage:            reconciledToUsage(reconciled),
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Run.TotalTokens != 7 || result.Run.PromptTokens != 3 || result.Run.CompletionTokens != 4 || result.Run.ReservedTokens != 0 {
		t.Fatalf("double-counted reconciled usage: %#v", result.Run)
	}
	after, err := ledger.GetTokenReservation(ctx, reservation.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.CommittedSequence == 0 || after.CommittedRevision == 0 || after.TotalTokens != 7 {
		t.Fatalf("reservation marker = %#v", after)
	}
}

func reconciledToUsage(reservation TokenReservation) Usage {
	return Usage{PromptTokens: reservation.PromptTokens, CompletionTokens: reservation.CompletionTokens, TotalTokens: reservation.TotalTokens}
}
