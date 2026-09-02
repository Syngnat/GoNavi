package runharness

import (
	"bytes"
	"context"
	"path/filepath"
	"sync"
	"testing"
)

func TestSubmitInputImplicitSessionIsStableAndIdempotent(t *testing.T) {
	ctx := context.Background()
	harness, ledger := newContractHarness(t, branchCompleteModel{}, nil, nil)
	request := AgentInputRequest{RequestID: "implicit-session-retry", Content: "hello"}

	first, err := harness.SubmitInput(ctx, request)
	if err != nil {
		t.Fatalf("first submit: %v", err)
	}
	waitContractRun(t, harness, first.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	second, err := harness.SubmitInput(ctx, request)
	if err != nil {
		t.Fatalf("retry submit: %v", err)
	}
	if second.RunID != first.RunID || second.SessionID != first.SessionID {
		t.Fatalf("retry receipt = %+v, first = %+v", second, first)
	}
	if second.SessionID != deterministicInputSessionID(request.RequestID) {
		t.Fatalf("implicit session id = %q", second.SessionID)
	}
	list, err := ledger.ListSessions(ctx, SessionListRequest{Limit: 10})
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	if list.Total != 1 || len(list.Sessions) != 1 || len(list.Sessions[0].Runs) != 1 {
		t.Fatalf("duplicate session/run created: %+v", list)
	}
	if len(list.Sessions[0].Messages) != 0 {
		// ListSessions intentionally omits messages. This guard documents that
		// the projection shape must not be used to infer message duplication.
		t.Fatalf("unexpected messages in list projection: %+v", list.Sessions[0].Messages)
	}
	full, err := ledger.GetSession(ctx, first.SessionID, true)
	if err != nil {
		t.Fatalf("read session: %v", err)
	}
	userMessages := 0
	for _, message := range full.Messages {
		if message.Role == "user" && message.Content == request.Content {
			userMessages++
		}
	}
	if userMessages != 1 {
		t.Fatalf("duplicate initial user message count = %d (all=%d)", userMessages, len(full.Messages))
	}
}

func TestSubmitInputImplicitSessionConcurrentRetryCreatesOneSessionAndRun(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent_runs.sqlite")
	key := bytes.Repeat([]byte{0x4d}, 32)
	ledgerA, err := Open(path, WithKey(key))
	if err != nil {
		t.Fatal(err)
	}
	ledgerB, err := Open(path, WithKey(key))
	if err != nil {
		_ = ledgerA.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = ledgerA.Close()
		_ = ledgerB.Close()
	})
	harnessA, err := NewAgentRunHarness(HarnessConfig{Ledger: ledgerA, Model: branchCompleteModel{}, RootContext: context.Background(), OwnerID: "owner-a"})
	if err != nil {
		t.Fatal(err)
	}
	harnessB, err := NewAgentRunHarness(HarnessConfig{Ledger: ledgerB, Model: branchCompleteModel{}, RootContext: context.Background(), OwnerID: "owner-b"})
	if err != nil {
		_ = harnessA.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = harnessA.Close()
		_ = harnessB.Close()
	})
	request := AgentInputRequest{RequestID: "cross-process-implicit-retry", Content: "hello"}
	var wg sync.WaitGroup
	receipts := make([]AgentInputReceipt, 2)
	errs := make([]error, 2)
	for i, harness := range []*AgentRunHarness{harnessA, harnessB} {
		wg.Add(1)
		go func(i int, harness *AgentRunHarness) {
			defer wg.Done()
			receipts[i], errs[i] = harness.SubmitInput(context.Background(), request)
		}(i, harness)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("submit %d: %v", i, err)
		}
	}
	if receipts[0].RunID != receipts[1].RunID || receipts[0].SessionID != receipts[1].SessionID {
		t.Fatalf("concurrent receipts differ: %#v", receipts)
	}
	list, err := ledgerA.ListSessions(context.Background(), SessionListRequest{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if list.Total != 1 || len(list.Sessions) != 1 || len(list.Sessions[0].Runs) != 1 {
		t.Fatalf("concurrent retry created duplicates: %+v", list)
	}
}

func TestSubmitInputImplicitSessionRevisionFailureRollsBackSession(t *testing.T) {
	harness, ledger := newContractHarness(t, branchCompleteModel{}, nil, nil)
	_, err := harness.SubmitInput(context.Background(), AgentInputRequest{
		RequestID:        "implicit-session-stale-revision",
		Content:          "hello",
		ExpectedRevision: 99,
	})
	if err == nil || !isRevisionConflict(err) {
		t.Fatalf("submit error = %v, want revision conflict", err)
	}
	list, err := ledger.ListSessions(context.Background(), SessionListRequest{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if list.Total != 0 {
		t.Fatalf("rolled-back submission left sessions: %+v", list)
	}
}

func isRevisionConflict(err error) bool {
	return err != nil && (err == ErrRevisionConflict || bytes.Contains([]byte(err.Error()), []byte(ErrRevisionConflict.Error())))
}
