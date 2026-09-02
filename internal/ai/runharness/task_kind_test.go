package runharness

import (
	"context"
	"encoding/json"
	"reflect"
	"sync"
	"testing"
)

type disabledToolsModel struct {
	mu       sync.Mutex
	requests []ModelTurnRequest
}

func (m *disabledToolsModel) Execute(_ context.Context, request ModelTurnRequest, _ ModelDeltaSink) (ModelTurnResult, error) {
	m.mu.Lock()
	m.requests = append(m.requests, request)
	call := len(m.requests)
	m.mu.Unlock()
	if call == 1 {
		return ModelTurnResult{
			ToolCalls: []ToolIntent{{
				CallID:    "disabled-call",
				ToolName:  "must_not_run",
				Arguments: json.RawMessage(`{}`),
			}},
			Completed: true,
		}, nil
	}
	return ModelTurnResult{Text: "tools were disabled", Completed: true}, nil
}

func (m *disabledToolsModel) recordedRequests() []ModelTurnRequest {
	m.mu.Lock()
	defer m.mu.Unlock()
	requests := make([]ModelTurnRequest, len(m.requests))
	copy(requests, m.requests)
	return requests
}

type taskKindProjectionModel struct {
	mu       sync.Mutex
	requests []ModelTurnRequest
}

func (m *taskKindProjectionModel) Execute(_ context.Context, request ModelTurnRequest, _ ModelDeltaSink) (ModelTurnResult, error) {
	m.mu.Lock()
	request.Messages = cloneMessages(request.Messages)
	request.Tools = append([]ToolDescriptor(nil), request.Tools...)
	m.requests = append(m.requests, request)
	m.mu.Unlock()
	return ModelTurnResult{Text: "done", Completed: true}, nil
}

func (m *taskKindProjectionModel) recordedRequests() []ModelTurnRequest {
	m.mu.Lock()
	defer m.mu.Unlock()
	requests := make([]ModelTurnRequest, len(m.requests))
	copy(requests, m.requests)
	return requests
}

func requestContents(request ModelTurnRequest) []string {
	contents := make([]string, 0, len(request.Messages))
	for _, message := range request.Messages {
		contents = append(contents, message.Content)
	}
	return contents
}

type disabledToolsCatalog struct {
	mu           sync.Mutex
	listCalls    int
	resolveCalls int
	executor     *contractToolExecutor
}

func (c *disabledToolsCatalog) List(context.Context) ([]ToolDescriptor, error) {
	c.mu.Lock()
	c.listCalls++
	c.mu.Unlock()
	return []ToolDescriptor{{Name: "must_not_run", Effect: ToolEffectSideEffect}}, nil
}

func (c *disabledToolsCatalog) Resolve(context.Context, string) (ToolDescriptor, ToolExecutor, error) {
	c.mu.Lock()
	c.resolveCalls++
	c.mu.Unlock()
	return ToolDescriptor{Name: "must_not_run", Effect: ToolEffectSideEffect}, c.executor, nil
}

func (c *disabledToolsCatalog) calls() (list, resolve int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.listCalls, c.resolveCalls
}

func TestCreateRunPersistsTaskKindAndToolCapability(t *testing.T) {
	ledger, err := OpenWithKey(":memory:", make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ledger.Close() })

	allowTools := false
	run, err := ledger.CreateRun(context.Background(), CreateRunRequest{
		SessionID:  "query-editor-session",
		Policy:     DefaultRunPolicy(),
		TaskKind:   AgentTaskKindQueryEditorGeneration,
		AllowTools: &allowTools,
	})
	if err != nil {
		t.Fatal(err)
	}
	if run.TaskKind != AgentTaskKindQueryEditorGeneration || run.AllowTools {
		t.Fatalf("created run capability = kind=%q allowTools=%v", run.TaskKind, run.AllowTools)
	}

	loaded, err := ledger.GetRun(context.Background(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.TaskKind != AgentTaskKindQueryEditorGeneration || loaded.AllowTools {
		t.Fatalf("loaded run capability = kind=%q allowTools=%v", loaded.TaskKind, loaded.AllowTools)
	}
}

func TestHarnessDisablesToolCatalogAndExecutionForToollessRun(t *testing.T) {
	model := &disabledToolsModel{}
	executor := &contractToolExecutor{result: ToolExecutionResult{Status: "completed"}}
	catalog := &disabledToolsCatalog{executor: executor}
	harness, _ := newContractHarness(t, model, catalog, nil)

	allowTools := false
	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{
		RequestID:  "query-editor-no-tools",
		Content:    "generate SQL",
		TaskKind:   AgentTaskKindQueryEditorGeneration,
		AllowTools: &allowTools,
	})
	if err != nil {
		t.Fatal(err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if read.Run.State != RunStateCompleted {
		t.Fatalf("run state = %s, want completed after repair", read.Run.State)
	}
	if read.Run.TaskKind != AgentTaskKindQueryEditorGeneration || read.Run.AllowTools {
		t.Fatalf("run capability = kind=%q allowTools=%v", read.Run.TaskKind, read.Run.AllowTools)
	}

	requests := model.recordedRequests()
	if len(requests) != 2 {
		t.Fatalf("model requests = %d, want malformed-call repair retry", len(requests))
	}
	for index, request := range requests {
		if len(request.Tools) != 0 {
			t.Fatalf("model request %d exposes %d tools for a toolless run", index, len(request.Tools))
		}
	}
	if list, resolve := catalog.calls(); list != 0 || resolve != 0 {
		t.Fatalf("catalog calls = list:%d resolve:%d, want none", list, resolve)
	}
	if _, ok := executor.lastRequest(); ok {
		t.Fatal("tool executor was called for a toolless run")
	}

	errorEvents := 0
	for _, event := range read.Events {
		if event.Kind != EventRunError {
			continue
		}
		var payload RunErrorEvent
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		if payload.Code == "malformed_tool_call" {
			errorEvents++
		}
	}
	if errorEvents != 1 {
		t.Fatalf("malformed tool-call events = %d, want exactly one repair signal", errorEvents)
	}
}

func TestHarnessRejectsUnknownToolWhenCatalogIsEmpty(t *testing.T) {
	model := &disabledToolsModel{}
	harness, _ := newContractHarness(t, model, nil, nil)

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{
		RequestID: "unknown-tool-empty-catalog", Content: "try an unregistered tool",
	})
	if err != nil {
		t.Fatal(err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if read.Run.State != RunStateCompleted {
		t.Fatalf("run state = %s, want completed after repair", read.Run.State)
	}

	requests := model.recordedRequests()
	if len(requests) != 2 {
		t.Fatalf("model requests = %d, want malformed-call repair retry", len(requests))
	}
	for index, request := range requests {
		if len(request.Tools) != 0 {
			t.Fatalf("model request %d exposes %d tools for an empty catalog", index, len(request.Tools))
		}
	}

	errorEvents := 0
	for _, event := range read.Events {
		if event.Kind != EventRunError {
			continue
		}
		var payload RunErrorEvent
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		if payload.Code == "malformed_tool_call" {
			errorEvents++
		}
	}
	if errorEvents != 1 {
		t.Fatalf("malformed tool-call events = %d, want exactly one repair signal", errorEvents)
	}
}

func TestHarnessQueryEditorGenerationProjectsOnlyItsOwnRunMessages(t *testing.T) {
	model := &taskKindProjectionModel{}
	harness, ledger := newContractHarness(t, model, nil, nil)
	allowTools := false
	session, err := ledger.CreateSession(context.Background(), CreateSessionRequest{SessionID: "shared-query-editor-session"})
	if err != nil {
		t.Fatal(err)
	}

	first, err := harness.SubmitInput(context.Background(), AgentInputRequest{
		RequestID: "query-editor-isolation-first", SessionID: session.ID,
		Content: "first editor draft", TaskKind: AgentTaskKindQueryEditorGeneration, AllowTools: &allowTools,
		ExpectedRevision: session.Revision,
	})
	if err != nil {
		t.Fatal(err)
	}
	firstRead := waitContractRun(t, harness, first.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if firstRead.Run.State != RunStateCompleted {
		t.Fatalf("first run state = %s, want completed", firstRead.Run.State)
	}

	current, err := ledger.GetSession(context.Background(), first.SessionID, false)
	if err != nil {
		t.Fatal(err)
	}
	second, err := harness.SubmitInput(context.Background(), AgentInputRequest{
		RequestID: "query-editor-isolation-second", SessionID: first.SessionID,
		Content: "second editor draft", TaskKind: AgentTaskKindQueryEditorGeneration, AllowTools: &allowTools,
		ExpectedRevision: current.Revision,
	})
	if err != nil {
		t.Fatal(err)
	}
	secondRead := waitContractRun(t, harness, second.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if secondRead.Run.State != RunStateCompleted {
		t.Fatalf("second run state = %s, want completed", secondRead.Run.State)
	}

	requests := model.recordedRequests()
	if len(requests) != 2 {
		t.Fatalf("model requests = %d, want 2", len(requests))
	}
	if got, want := requestContents(requests[0]), []string{"first editor draft"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("first query-editor projection = %#v, want %#v", got, want)
	}
	if got, want := requestContents(requests[1]), []string{"second editor draft"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("second query-editor projection = %#v, want %#v", got, want)
	}
}

func TestHarnessChatKeepsSessionHistoryAcrossRuns(t *testing.T) {
	model := &taskKindProjectionModel{}
	harness, ledger := newContractHarness(t, model, nil, nil)
	session, err := ledger.CreateSession(context.Background(), CreateSessionRequest{SessionID: "shared-chat-session"})
	if err != nil {
		t.Fatal(err)
	}

	first, err := harness.SubmitInput(context.Background(), AgentInputRequest{
		RequestID: "chat-history-first", SessionID: session.ID, Content: "first chat input",
		ExpectedRevision: session.Revision,
	})
	if err != nil {
		t.Fatal(err)
	}
	firstRead := waitContractRun(t, harness, first.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if firstRead.Run.State != RunStateCompleted {
		t.Fatalf("first run state = %s, want completed", firstRead.Run.State)
	}

	current, err := ledger.GetSession(context.Background(), first.SessionID, false)
	if err != nil {
		t.Fatal(err)
	}
	second, err := harness.SubmitInput(context.Background(), AgentInputRequest{
		RequestID: "chat-history-second", SessionID: first.SessionID, Content: "second chat input",
		ExpectedRevision: current.Revision,
	})
	if err != nil {
		t.Fatal(err)
	}
	secondRead := waitContractRun(t, harness, second.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if secondRead.Run.State != RunStateCompleted {
		t.Fatalf("second run state = %s, want completed", secondRead.Run.State)
	}

	requests := model.recordedRequests()
	if len(requests) != 2 {
		t.Fatalf("model requests = %d, want 2", len(requests))
	}
	if got, want := requestContents(requests[1]), []string{"first chat input", "done", "second chat input"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("chat history projection = %#v, want %#v", got, want)
	}
}
