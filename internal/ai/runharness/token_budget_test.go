package runharness

import (
	"context"
	"errors"
	"testing"
)

func TestTokenReservationIsIdempotentAndReconcilesExactlyOnce(t *testing.T) {
	ledger := testLedger(t)
	ctx := context.Background()
	policy := DefaultRunPolicy()
	policy.MaxTotalTokens = 10
	run, err := ledger.CreateRun(ctx, CreateRunRequest{SessionID: "token-session", Policy: policy})
	if err != nil {
		t.Fatal(err)
	}
	first, err := ledger.ReserveTokens(ctx, ReserveTokensRequest{RunID: run.ID, ReservationID: "token-1", Tokens: 7, ExpectedRevision: run.Revision})
	if err != nil {
		t.Fatal(err)
	}
	second, err := ledger.ReserveTokens(ctx, ReserveTokensRequest{RunID: run.ID, ReservationID: "token-1", Tokens: 7, ExpectedRevision: 999})
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != second.ID || second.Status != "reserved" {
		t.Fatalf("reservation retry = %#v", second)
	}
	current, _ := ledger.GetRun(ctx, run.ID)
	if current.ReservedTokens != 7 || current.TotalTokens != 0 {
		t.Fatalf("reserved projection = %#v", current)
	}
	reconciled, err := ledger.ReconcileTokens(ctx, ReconcileTokensRequest{RunID: run.ID, ReservationID: "token-1", Usage: Usage{PromptTokens: 2, CompletionTokens: 3}, ExpectedRevision: current.Revision})
	if err != nil {
		t.Fatal(err)
	}
	if reconciled.Status != "reconciled" || reconciled.TotalTokens != 5 {
		t.Fatalf("reconciled = %#v", reconciled)
	}
	after, _ := ledger.GetRun(ctx, run.ID)
	if after.ReservedTokens != 0 || after.TotalTokens != 5 || after.PromptTokens != 2 || after.CompletionTokens != 3 {
		t.Fatalf("reconciled projection = %#v", after)
	}
	retry, err := ledger.ReconcileTokens(ctx, ReconcileTokensRequest{RunID: run.ID, ReservationID: "token-1", Usage: Usage{TotalTokens: 99}, ExpectedRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	if retry.TotalTokens != 5 || retry.Status != "reconciled" {
		t.Fatalf("reconcile retry = %#v", retry)
	}
	if _, err := ledger.ReserveTokens(ctx, ReserveTokensRequest{RunID: run.ID, ReservationID: "token-2", Tokens: 6}); !errors.Is(err, ErrTokenBudgetExceeded) {
		t.Fatalf("budget reservation error = %v", err)
	}
}
