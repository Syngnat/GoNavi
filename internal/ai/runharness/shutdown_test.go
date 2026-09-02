package runharness

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

type shutdownModel struct{}

func (shutdownModel) Execute(context.Context, ModelTurnRequest, ModelDeltaSink) (ModelTurnResult, error) {
	return ModelTurnResult{ToolCalls: []ToolIntent{{CallID: "shutdown-write", ToolName: "write", Effect: ToolEffectSideEffect, Arguments: json.RawMessage(`{}`)}}, Completed: true}, nil
}

type shutdownExecutor struct {
	started chan struct{}
	once    sync.Once
}

func (e *shutdownExecutor) Execute(ctx context.Context, _ ToolExecutionRequest) (ToolExecutionResult, error) {
	e.once.Do(func() { close(e.started) })
	<-ctx.Done()
	return ToolExecutionResult{Status: "failed", ErrorCode: "transport", UnknownOutcome: false}, ctx.Err()
}

type shutdownCatalog struct{ executor *shutdownExecutor }

func (c shutdownCatalog) List(context.Context) ([]ToolDescriptor, error) {
	return []ToolDescriptor{{Name: "write", Effect: ToolEffectSideEffect, InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`)}}, nil
}

func (c shutdownCatalog) Resolve(context.Context, string) (ToolDescriptor, ToolExecutor, error) {
	return ToolDescriptor{Name: "write", Effect: ToolEffectSideEffect, InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`)}, c.executor, nil
}

func TestCloseLetsSideEffectSettleThenRecordsUnknown(t *testing.T) {
	l := testLedger(t)
	executor := &shutdownExecutor{started: make(chan struct{})}
	approvals := contractApprovalHandler{}
	h, err := NewAgentRunHarness(HarnessConfig{
		Ledger: l, Model: shutdownModel{}, Tools: shutdownCatalog{executor: executor}, Approvals: &approvals,
		RootContext: context.Background(), OwnerID: "shutdown-owner", LeaseDuration: time.Second,
		PollInterval: time.Millisecond, ShutdownGracePeriod: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := h.SubmitInput(context.Background(), AgentInputRequest{RequestID: "shutdown-request", Content: "write"})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-executor.started:
	case <-time.After(time.Second):
		t.Fatal("side-effect executor did not start")
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	run, err := l.GetRun(context.Background(), receipt.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if run.State != RunStateRecoveryRequired {
		t.Fatalf("closed run state = %s, want %s", run.State, RunStateRecoveryRequired)
	}
	var status string
	var unknown int
	if err := l.db.QueryRow(`SELECT status,unknown_outcome FROM tool_calls WHERE run_id=? AND call_id=?`, receipt.RunID, "shutdown-write").Scan(&status, &unknown); err != nil {
		t.Fatal(err)
	}
	if status != "unknown" || unknown != 1 {
		t.Fatalf("closed tool = status %q unknown %d", status, unknown)
	}
	if err := l.Close(); err != nil && !errors.Is(err, ErrClosed) {
		t.Fatal(err)
	}
}
