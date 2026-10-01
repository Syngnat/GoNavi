package runharness

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
)

// recordingModelTurn 按脚本返回结果，并记录每一轮收到的请求，用来断言续写时模型看到了什么。
type recordingModelTurn struct {
	mu            sync.Mutex
	requests      []ModelTurnRequest
	steps         []ModelTurnResult
	defaultResult ModelTurnResult
}

func (m *recordingModelTurn) Execute(_ context.Context, request ModelTurnRequest, _ ModelDeltaSink) (ModelTurnResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	index := len(m.requests)
	m.requests = append(m.requests, request)
	if index < len(m.steps) {
		return m.steps[index], nil
	}
	return m.defaultResult, nil
}

func (m *recordingModelTurn) callCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.requests)
}

func (m *recordingModelTurn) request(index int) ModelTurnRequest {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.requests[index]
}

func TestHarnessContinuesAfterTruncatedTextTurn(t *testing.T) {
	model := &recordingModelTurn{steps: []ModelTurnResult{
		{Text: "SELECT a, b, ", Truncated: true},
		{Text: "c FROM t", Completed: true},
	}}
	harness, _ := newContractHarness(t, model, nil, nil)

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{RequestID: "truncated-text", Content: "write a query"})
	if err != nil {
		t.Fatal(err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if read.Run.State != RunStateCompleted {
		t.Fatalf("run state = %s (%s), want completed instead of failing on truncation", read.Run.State, read.Run.TerminalReason)
	}
	if got := model.callCount(); got != 2 {
		t.Fatalf("model calls = %d, want one continuation (2 total)", got)
	}

	// 续写那一轮：已生成的部分作为 assistant 消息保留，随后跟着一条要求接着写的提示。
	var partialIndex, nudgeIndex = -1, -1
	for index, message := range model.request(1).Messages {
		switch {
		case message.Role == "assistant" && message.Content == "SELECT a, b, ":
			partialIndex = index
		case message.Role == "system" && strings.Contains(message.Content, "output length limit"):
			nudgeIndex = index
		}
	}
	if partialIndex < 0 {
		t.Fatalf("continuation request lost the truncated partial output: %+v", model.request(1).Messages)
	}
	if nudgeIndex < 0 || nudgeIndex < partialIndex {
		t.Fatalf("continuation request must end with the resume instruction after the partial output (partial=%d nudge=%d)", partialIndex, nudgeIndex)
	}
}

func TestHarnessDropsToolCallsFromTruncatedTurn(t *testing.T) {
	model := &recordingModelTurn{steps: []ModelTurnResult{
		// 参数在中途被截断的工具调用不可信，不能执行。
		{ToolCalls: []ToolIntent{{CallID: "call-read", ToolName: "read", Arguments: json.RawMessage(`{}`)}}, Truncated: true},
		{Text: "done", Completed: true},
	}}
	executor := &contractToolExecutor{result: ToolExecutionResult{Status: "completed", Value: map[string]any{"ok": true}}}
	catalog := &contractToolCatalog{
		descriptor: ToolDescriptor{Name: "read", Effect: ToolEffectReadOnly, InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`)},
		executor:   executor,
		effect:     ToolEffectReadOnly,
	}
	harness, _ := newContractHarness(t, model, catalog, nil)

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{RequestID: "truncated-tool", Content: "read"})
	if err != nil {
		t.Fatal(err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if read.Run.State != RunStateCompleted {
		t.Fatalf("run state = %s (%s), want completed", read.Run.State, read.Run.TerminalReason)
	}
	if _, called := executor.lastRequest(); called {
		t.Fatal("a tool call from a truncated turn must never be executed")
	}
	if got := model.callCount(); got != 2 {
		t.Fatalf("model calls = %d, want the model to be asked again (2 total)", got)
	}
	var sawNudge bool
	for _, message := range model.request(1).Messages {
		if message.Role == "system" && strings.Contains(message.Content, "smaller") {
			sawNudge = true
		}
	}
	if !sawNudge {
		t.Fatal("continuation after a truncated tool call must tell the model to redo it in smaller pieces")
	}
}

func TestHarnessGivesUpAfterRepeatedTruncation(t *testing.T) {
	model := &recordingModelTurn{defaultResult: ModelTurnResult{Text: "more ", Truncated: true}}
	harness, _ := newContractHarness(t, model, nil, nil)

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{RequestID: "truncated-forever", Content: "write a lot"})
	if err != nil {
		t.Fatal(err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if read.Run.State != RunStateFailed {
		t.Fatalf("run state = %s, want failed after the continuation limit", read.Run.State)
	}
	if got, want := model.callCount(), maxOutputContinuations+1; got != want {
		t.Fatalf("model calls = %d, want the first turn plus %d continuations", got, maxOutputContinuations)
	}
	var found bool
	for _, event := range read.Events {
		if event.Kind != EventTerminal {
			continue
		}
		var payload TerminalEvent
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		found = true
		if payload.ErrorCode != ModelErrorOutputLimit {
			t.Fatalf("terminal error code = %q, want %q", payload.ErrorCode, ModelErrorOutputLimit)
		}
	}
	if !found {
		t.Fatal("missing terminal event")
	}
}

func TestHarnessResetsContinuationBudgetAfterAHealthyTurn(t *testing.T) {
	model := &recordingModelTurn{steps: []ModelTurnResult{
		{Text: "a", Truncated: true},
		{ToolCalls: []ToolIntent{{CallID: "call-read", ToolName: "read", Arguments: json.RawMessage(`{}`)}}, Completed: true},
		{Text: "b", Truncated: true},
		{Text: "c", Completed: true},
	}}
	executor := &contractToolExecutor{result: ToolExecutionResult{Status: "completed", Value: map[string]any{"ok": true}}}
	catalog := &contractToolCatalog{
		descriptor: ToolDescriptor{Name: "read", Effect: ToolEffectReadOnly, InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`)},
		executor:   executor,
		effect:     ToolEffectReadOnly,
	}
	harness, _ := newContractHarness(t, model, catalog, nil)

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{RequestID: "truncated-reset", Content: "go"})
	if err != nil {
		t.Fatal(err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if read.Run.State != RunStateCompleted {
		t.Fatalf("run state = %s (%s), want completed", read.Run.State, read.Run.TerminalReason)
	}
}

func TestHarnessContinuesAfterTruncatedTurnWithNoOutputAtAll(t *testing.T) {
	// 推理把额度耗尽、一个字都没输出的截断，也应该续写而不是把 run 判为失败。
	model := &recordingModelTurn{steps: []ModelTurnResult{
		{Truncated: true},
		{Text: "ok", Completed: true},
	}}
	harness, _ := newContractHarness(t, model, nil, nil)

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{RequestID: "truncated-empty", Content: "think hard"})
	if err != nil {
		t.Fatal(err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if read.Run.State != RunStateCompleted {
		t.Fatalf("run state = %s (%s), want completed", read.Run.State, read.Run.TerminalReason)
	}
	if got := model.callCount(); got != 2 {
		t.Fatalf("model calls = %d, want 2", got)
	}
}

func TestHarnessRepairPromptExplainsWhyTheToolCallWasRejected(t *testing.T) {
	model := &recordingModelTurn{steps: []ModelTurnResult{
		{ToolCalls: []ToolIntent{{CallID: "call-x", ToolName: "no_such_tool", Arguments: json.RawMessage(`{}`)}}, Completed: true},
		{Text: "fixed", Completed: true},
	}}
	executor := &contractToolExecutor{result: ToolExecutionResult{Status: "completed", Value: map[string]any{"ok": true}}}
	catalog := &contractToolCatalog{
		descriptor: ToolDescriptor{Name: "read", Effect: ToolEffectReadOnly, InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`)},
		executor:   executor,
		effect:     ToolEffectReadOnly,
	}
	harness, _ := newContractHarness(t, model, catalog, nil)

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{RequestID: "repair-prompt", Content: "go"})
	if err != nil {
		t.Fatal(err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if read.Run.State != RunStateCompleted {
		t.Fatalf("run state = %s (%s), want completed after one repair round", read.Run.State, read.Run.TerminalReason)
	}
	var repair string
	for _, message := range model.request(1).Messages {
		if message.Role == "system" && strings.Contains(message.Content, "could not be executed") {
			repair = message.Content
		}
	}
	if repair == "" {
		t.Fatalf("repair request must tell the model in words that the call was rejected: %+v", model.request(1).Messages)
	}
	if !strings.Contains(repair, "no_such_tool") {
		t.Fatalf("repair instruction must include the concrete reason, got %q", repair)
	}
}
