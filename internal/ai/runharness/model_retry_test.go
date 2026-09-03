package runharness

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
)

type scriptedModelTurn struct {
	mu            sync.Mutex
	calls         int
	steps         []scriptedModelStep
	defaultResult ModelTurnResult
}

type scriptedModelStep struct {
	result ModelTurnResult
	err    error
}

func (m *scriptedModelTurn) Execute(context.Context, ModelTurnRequest, ModelDeltaSink) (ModelTurnResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	index := m.calls
	m.calls++
	if index < len(m.steps) {
		return m.steps[index].result, m.steps[index].err
	}
	return m.defaultResult, nil
}

func (m *scriptedModelTurn) callCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.calls
}

func TestHarnessRetriesTransientModelTransportOnce(t *testing.T) {
	model := &scriptedModelTurn{
		steps:         []scriptedModelStep{{err: errors.New("read OpenAI Responses streaming response failed: connection reset by peer")}},
		defaultResult: ModelTurnResult{Text: "recovered", Completed: true},
	}
	harness, _ := newContractHarness(t, model, nil, nil)

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{RequestID: "transport-retry", Content: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if read.Run.State != RunStateCompleted {
		t.Fatalf("run state = %s, want completed", read.Run.State)
	}
	if got := model.callCount(); got != 2 {
		t.Fatalf("model calls = %d, want one retry (2 total)", got)
	}
}

func TestHarnessDoesNotRetryPermanentProviderError(t *testing.T) {
	model := &scriptedModelTurn{
		steps: []scriptedModelStep{{err: errors.New("OpenAI Responses API returned error (HTTP 401): invalid api key")}},
	}
	harness, _ := newContractHarness(t, model, nil, nil)

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{RequestID: "provider-no-retry", Content: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if read.Run.State != RunStateFailed {
		t.Fatalf("run state = %s, want failed", read.Run.State)
	}
	const providerDetail = "OpenAI Responses API returned error (HTTP 401): invalid api key"
	if read.Run.TerminalReason != providerDetail {
		t.Fatalf("terminal reason = %q, want provider detail", read.Run.TerminalReason)
	}
	if got := model.callCount(); got != 1 {
		t.Fatalf("model calls = %d, want no retry", got)
	}
	var foundError bool
	var foundTerminal bool
	for _, event := range read.Events {
		switch event.Kind {
		case EventRunError:
			var payload RunErrorEvent
			if err := json.Unmarshal(event.Payload, &payload); err != nil {
				t.Fatal(err)
			}
			foundError = true
			if payload.Code != ModelErrorProvider || payload.Retryable {
				t.Fatalf("provider error payload = %+v", payload)
			}
		case EventTerminal:
			var payload TerminalEvent
			if err := json.Unmarshal(event.Payload, &payload); err != nil {
				t.Fatal(err)
			}
			foundTerminal = true
			if payload.Reason != providerDetail || payload.ErrorCode != ModelErrorProvider {
				t.Fatalf("terminal payload = %+v", payload)
			}
		}
	}
	if !foundError {
		t.Fatal("missing run error event")
	}
	if !foundTerminal {
		t.Fatal("missing terminal event")
	}
}

func TestHarnessDoesNotRetryTransportAfterCommittedTool(t *testing.T) {
	model := &scriptedModelTurn{
		steps: []scriptedModelStep{
			{result: ModelTurnResult{ToolCalls: []ToolIntent{{CallID: "call-read", ToolName: "read", Arguments: json.RawMessage(`{}`)}}, Completed: true}},
			{err: errors.New("connection reset by peer")},
		},
	}
	executor := &contractToolExecutor{result: ToolExecutionResult{Status: "completed", Value: map[string]any{"ok": true}}}
	catalog := &contractToolCatalog{
		descriptor: ToolDescriptor{Name: "read", Effect: ToolEffectReadOnly, InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`)},
		executor:   executor,
		effect:     ToolEffectReadOnly,
	}
	harness, ledger := newContractHarness(t, model, catalog, nil)

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{RequestID: "tool-no-retry", Content: "read"})
	if err != nil {
		t.Fatal(err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if read.Run.State != RunStateFailed {
		t.Fatalf("run state = %s, want failed", read.Run.State)
	}
	if got := model.callCount(); got != 2 {
		t.Fatalf("model calls = %d, want no retry after tool (2 total)", got)
	}
	var toolMessages int
	if err := ledger.db.QueryRow(`SELECT COUNT(*) FROM messages WHERE run_id=? AND role='tool'`, receipt.RunID).Scan(&toolMessages); err != nil {
		t.Fatal(err)
	}
	if toolMessages != 1 {
		t.Fatalf("tool messages = %d, want 1", toolMessages)
	}
}
