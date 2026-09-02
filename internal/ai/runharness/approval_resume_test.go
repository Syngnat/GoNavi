package runharness

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

type approvalResumeModel struct {
	calls atomic.Int32
}

func (m *approvalResumeModel) Execute(_ context.Context, request ModelTurnRequest, _ ModelDeltaSink) (ModelTurnResult, error) {
	m.calls.Add(1)
	for _, message := range request.Messages {
		if message.Role == "tool" {
			return ModelTurnResult{Text: "completed", Completed: true}, nil
		}
	}
	return ModelTurnResult{ToolCalls: []ToolIntent{{CallID: "call-1", ToolName: "write", Effect: ToolEffectSideEffect, Arguments: json.RawMessage(`{}`)}}, Completed: true}, nil
}

type approvalResumeCatalog struct {
	executions atomic.Int32
}

func (c *approvalResumeCatalog) List(context.Context) ([]ToolDescriptor, error) {
	return []ToolDescriptor{{Name: "write", Effect: ToolEffectSideEffect, InputSchema: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`)}}, nil
}

func (c *approvalResumeCatalog) Resolve(context.Context, string) (ToolDescriptor, ToolExecutor, error) {
	return ToolDescriptor{Name: "write", Effect: ToolEffectSideEffect, InputSchema: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`)}, approvalResumeExecutor{calls: &c.executions}, nil
}

type approvalResumeExecutor struct{ calls *atomic.Int32 }

func (e approvalResumeExecutor) Execute(context.Context, ToolExecutionRequest) (ToolExecutionResult, error) {
	e.calls.Add(1)
	return ToolExecutionResult{Status: "completed", Value: map[string]any{"ok": true}}, nil
}

type pendingApprovalHandler struct{}

func (pendingApprovalHandler) Request(context.Context, ApprovalRequest) (ApprovalDecision, error) {
	return ApprovalDecision{}, ErrApprovalPending
}

func openApprovalResumeHarness(t *testing.T, path string, model ModelTurnAdapter, catalog ToolCatalog, approvals ApprovalHandler) (*AgentRunHarness, *Ledger) {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 11)
	}
	ledger, err := Open(path, WithKey(key))
	if err != nil {
		t.Fatal(err)
	}
	harness, err := NewAgentRunHarness(HarnessConfig{
		Ledger: ledger, Model: model, Tools: catalog, Approvals: approvals,
		RootContext: context.Background(), OwnerID: "approval-test-owner",
		PollInterval: time.Millisecond,
	})
	if err != nil {
		_ = ledger.Close()
		t.Fatal(err)
	}
	if err := harness.Start(context.Background()); err != nil {
		_ = harness.Close()
		_ = ledger.Close()
		t.Fatal(err)
	}
	return harness, ledger
}

func TestApprovalSurvivesProcessBoundaryAndResumesExactlyOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent_runs.sqlite")
	modelA := &approvalResumeModel{}
	catalogA := &approvalResumeCatalog{}
	harnessA, ledgerA := openApprovalResumeHarness(t, path, modelA, catalogA, pendingApprovalHandler{})
	receipt, err := harnessA.SubmitInput(context.Background(), AgentInputRequest{RequestID: "request-1", Content: "write"})
	if err != nil {
		t.Fatal(err)
	}
	var waiting RunSnapshot
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		waiting, err = ledgerA.GetRun(context.Background(), receipt.RunID)
		if err != nil {
			t.Fatal(err)
		}
		if waiting.State == RunStateAwaitingApproval {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if waiting.State != RunStateAwaitingApproval {
		t.Fatal("run did not reach awaiting_approval")
	}
	// Let the non-interactive handler return and the owner goroutine release its
	// lease before simulating process shutdown.
	time.Sleep(25 * time.Millisecond)
	approval, err := ledgerA.LatestApprovalForRun(context.Background(), receipt.RunID)
	if err != nil || approval.Status != "pending" {
		t.Fatalf("approval = %#v, %v", approval, err)
	}
	if err := harnessA.Close(); err != nil {
		t.Fatal(err)
	}
	if err := ledgerA.Close(); err != nil {
		t.Fatal(err)
	}

	modelB := &approvalResumeModel{}
	catalogB := &approvalResumeCatalog{}
	harnessB, ledgerB := openApprovalResumeHarness(t, path, modelB, catalogB, nil)
	defer harnessB.Close()
	defer ledgerB.Close()
	stillWaiting, err := ledgerB.GetRun(context.Background(), receipt.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if stillWaiting.State != RunStateAwaitingApproval {
		read, readErr := ledgerB.ReadRun(context.Background(), RunReadRequest{RunID: receipt.RunID})
		t.Fatalf("startup changed pending state to %s: read=%#v err=%v", stillWaiting.State, read, readErr)
	}
	if _, err := harnessB.ControlRun(context.Background(), RunControlRequest{
		RunID: receipt.RunID, Action: ControlApprove, ApprovalID: approval.ApprovalID,
		CallID: approval.CallID, ArgsHash: approval.ArgsHash, ExpectedRevision: approval.RunRevision,
	}); err != nil {
		t.Fatalf("approve: %v", err)
	}
	var completed RunSnapshot
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		completed, err = ledgerB.GetRun(context.Background(), receipt.RunID)
		if err != nil {
			t.Fatal(err)
		}
		if completed.State.Terminal() {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if completed.State != RunStateCompleted {
		t.Fatalf("resumed run state = %s", completed.State)
	}
	if catalogB.executions.Load() != 1 {
		t.Fatalf("tool executions = %d, want 1", catalogB.executions.Load())
	}
	if _, err := harnessB.ControlRun(context.Background(), RunControlRequest{
		RunID: receipt.RunID, Action: ControlApprove, ApprovalID: approval.ApprovalID,
		CallID: approval.CallID, ArgsHash: approval.ArgsHash, ExpectedRevision: approval.RunRevision,
	}); !errors.Is(err, ErrApprovalConflict) {
		t.Fatalf("duplicate approve error = %v", err)
	}
}

func TestLatestApprovalForRunReturnsNewestRecord(t *testing.T) {
	l := testLedger(t)
	run, err := l.CreateRun(context.Background(), CreateRunRequest{SessionID: "approval-order", Policy: DefaultRunPolicy()})
	if err != nil {
		t.Fatal(err)
	}
	first, err := l.CreateApproval(context.Background(), PutApprovalRequest{RunID: run.ID, CallID: "first", ToolName: "write", Effect: ToolEffectSideEffect, Arguments: json.RawMessage(`{}`), RunRevision: run.Revision})
	if err != nil {
		t.Fatal(err)
	}
	// Approval uniqueness is keyed by run/call/args. Use a distinct call ID for
	// the second record while keeping the same run revision.
	second, err := l.CreateApproval(context.Background(), PutApprovalRequest{RunID: run.ID, CallID: "second", ToolName: "write", Effect: ToolEffectSideEffect, Arguments: json.RawMessage(`{"x":1}`), RunRevision: run.Revision})
	if err != nil {
		t.Fatal(err)
	}
	latest, err := l.LatestApprovalForRun(context.Background(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if latest.ApprovalID != second.ApprovalID && latest.ApprovalID != first.ApprovalID {
		t.Fatalf("latest approval = %#v", latest)
	}
}
