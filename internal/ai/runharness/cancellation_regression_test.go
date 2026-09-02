package runharness

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

type ignoresTurnCancellationModel struct {
	started      chan struct{}
	release      chan struct{}
	lateCallback chan error
	once         sync.Once
}

func (m *ignoresTurnCancellationModel) Execute(_ context.Context, _ ModelTurnRequest, sink ModelDeltaSink) (ModelTurnResult, error) {
	m.once.Do(func() { close(m.started) })
	<-m.release // Intentionally ignore the caller's cancellation context.
	m.lateCallback <- sink(context.Background(), ModelDelta{Text: "late delta"})
	return ModelTurnResult{Text: "late completion", Completed: true}, nil
}

func TestHarnessDeadlineDropsLateModelCallbackAfterTerminal(t *testing.T) {
	model := &ignoresTurnCancellationModel{
		started:      make(chan struct{}),
		release:      make(chan struct{}),
		lateCallback: make(chan error, 1),
	}
	harness, _ := newContractHarness(t, model, nil, nil)
	policy := DefaultRunPolicy()
	policy.ModelTurnTimeout = 20 * time.Millisecond
	policy.MaxModelRetriesPerTurn = 0
	if err := harness.SetDefaultPolicy(policy); err != nil {
		t.Fatalf("set default policy: %v", err)
	}

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{RequestID: "late-model-callback", Content: "wait"})
	if err != nil {
		t.Fatalf("submit input: %v", err)
	}
	select {
	case <-model.started:
	case <-time.After(time.Second):
		t.Fatal("model did not start")
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if read.Run.State != RunStateFailed {
		t.Fatalf("run state = %s, want %s", read.Run.State, RunStateFailed)
	}
	assertDeadlineTerminal(t, read.Events)
	sequenceBeforeRelease := read.Run.NextSequence

	close(model.release)
	select {
	case callbackErr := <-model.lateCallback:
		if !errors.Is(callbackErr, context.Canceled) {
			t.Fatalf("late callback error = %v, want context.Canceled", callbackErr)
		}
	case <-time.After(time.Second):
		t.Fatal("late model callback did not return")
	}

	// Give the detached adapter goroutine a chance to finish. Its callback must
	// not be able to append an event after the terminal boundary.
	time.Sleep(30 * time.Millisecond)
	after, err := harness.ReadRun(context.Background(), RunReadRequest{RunID: receipt.RunID, Limit: 100})
	if err != nil {
		t.Fatalf("read terminal run: %v", err)
	}
	if after.Run.NextSequence != sequenceBeforeRelease {
		t.Fatalf("late callback advanced sequence from %d to %d", sequenceBeforeRelease, after.Run.NextSequence)
	}
	assertDeadlineTerminal(t, after.Events)
}

func assertDeadlineTerminal(t *testing.T, events []RunEvent) {
	t.Helper()
	terminalCount := 0
	seenDeadline := false
	for index, event := range events {
		if event.Kind == EventRunError {
			var payload RunErrorEvent
			if err := json.Unmarshal(event.Payload, &payload); err != nil {
				t.Fatalf("decode run error: %v", err)
			}
			seenDeadline = seenDeadline || payload.Code == ModelErrorDeadline
		}
		if event.Kind != EventTerminal {
			continue
		}
		terminalCount++
		if event.ResultingState != RunStateFailed {
			t.Fatalf("terminal state = %s, want %s", event.ResultingState, RunStateFailed)
		}
		if index != len(events)-1 {
			t.Fatalf("event after terminal: %#v", events[index+1:])
		}
	}
	if !seenDeadline {
		t.Fatalf("events missing deadline error: %#v", events)
	}
	if terminalCount != 1 {
		t.Fatalf("terminal events = %d, want 1", terminalCount)
	}
}

type steeringModel struct {
	mu       sync.Mutex
	requests []ModelTurnRequest
}

func (m *steeringModel) Execute(_ context.Context, request ModelTurnRequest, _ ModelDeltaSink) (ModelTurnResult, error) {
	m.mu.Lock()
	m.requests = append(m.requests, request)
	call := len(m.requests)
	m.mu.Unlock()
	if call == 1 {
		return ModelTurnResult{ToolCalls: []ToolIntent{{
			CallID: "steered-read", ToolName: "read", Arguments: json.RawMessage(`{}`),
		}}, Completed: true}, nil
	}
	return ModelTurnResult{Text: "steered result", Completed: true}, nil
}

func (m *steeringModel) requestsSnapshot() []ModelTurnRequest {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]ModelTurnRequest(nil), m.requests...)
}

type steerCancelableReadExecutor struct {
	started  chan struct{}
	canceled chan error
	once     sync.Once
}

func (e *steerCancelableReadExecutor) Execute(ctx context.Context, _ ToolExecutionRequest) (ToolExecutionResult, error) {
	e.once.Do(func() { close(e.started) })
	<-ctx.Done()
	err := ctx.Err()
	e.canceled <- err
	return ToolExecutionResult{Status: "failed", ErrorCode: "canceled"}, err
}

func TestHarnessSteerCancelsReadOnlyToolThenRunsNewModelTurn(t *testing.T) {
	model := &steeringModel{}
	executor := &steerCancelableReadExecutor{
		started:  make(chan struct{}),
		canceled: make(chan error, 1),
	}
	catalog := &contractToolCatalog{
		descriptor: ToolDescriptor{
			Name: "read", Effect: ToolEffectReadOnly,
			InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`),
		},
		executor: executor,
		effect:   ToolEffectReadOnly,
	}
	harness, ledger := newContractHarness(t, model, catalog, nil)

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{RequestID: "steer-read-request", Content: "read first"})
	if err != nil {
		t.Fatalf("submit input: %v", err)
	}
	select {
	case <-executor.started:
	case <-time.After(time.Second):
		t.Fatal("read-only tool did not start")
	}
	active, err := ledger.GetRun(context.Background(), receipt.RunID)
	if err != nil {
		t.Fatalf("read active run revision: %v", err)
	}
	steer, err := harness.SubmitInput(context.Background(), AgentInputRequest{
		RequestID: "steer-read-command", SessionID: receipt.SessionID,
		Content: "instead, answer without reading", DispatchMode: DispatchSteer,
		ExpectedRevision: active.Revision,
	})
	if err != nil {
		t.Fatalf("submit steer: %v", err)
	}
	if steer.Disposition != "steered" || steer.RunID != receipt.RunID {
		t.Fatalf("steer receipt = %#v, want active run %q", steer, receipt.RunID)
	}
	select {
	case cancelErr := <-executor.canceled:
		if !errors.Is(cancelErr, context.Canceled) {
			t.Fatalf("read-only tool cancellation = %v, want context.Canceled", cancelErr)
		}
	case <-time.After(time.Second):
		t.Fatal("steer did not cancel the read-only tool")
	}

	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if read.Run.State != RunStateCompleted {
		t.Fatalf("steered run state = %s, want %s", read.Run.State, RunStateCompleted)
	}
	requests := model.requestsSnapshot()
	if len(requests) != 2 {
		t.Fatalf("model calls = %d, want 2", len(requests))
	}
	if !requestContainsContent(requests[1].Messages, "instead, answer without reading") {
		t.Fatalf("new model turn did not receive steer input: %#v", requests[1].Messages)
	}
	if requestContainsContent(requests[1].Messages, "steered result") {
		t.Fatalf("new model request contains its future result: %#v", requests[1].Messages)
	}
	var canceledTool bool
	for _, event := range read.Events {
		if event.Kind != EventTool {
			continue
		}
		var payload ToolEvent
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			t.Fatalf("decode tool event: %v", err)
		}
		canceledTool = canceledTool || (payload.CallID == "steered-read" && payload.Status == "failed" && payload.ErrorCode == "canceled")
	}
	if !canceledTool {
		t.Fatalf("events missing canceled read-only tool outcome: %#v", read.Events)
	}
}

func requestContainsContent(messages []Message, content string) bool {
	for _, message := range messages {
		if message.Content == content {
			return true
		}
	}
	return false
}

// multiIntentCatalog deliberately does not implement ToolEffectResolver. The
// provider response leaves Effect empty, so the harness must fill it from the
// frozen descriptors before the steer boundary records canceled intents.
type multiIntentCatalog struct {
	descriptors []ToolDescriptor
	executors   map[string]ToolExecutor
}

func (c *multiIntentCatalog) List(context.Context) ([]ToolDescriptor, error) {
	return append([]ToolDescriptor(nil), c.descriptors...), nil
}

func (c *multiIntentCatalog) Resolve(_ context.Context, name string) (ToolDescriptor, ToolExecutor, error) {
	for _, descriptor := range c.descriptors {
		if descriptor.Name == name {
			executor := c.executors[name]
			if executor == nil {
				return ToolDescriptor{}, nil, ErrToolNotFound
			}
			return descriptor, executor, nil
		}
	}
	return ToolDescriptor{}, nil, ErrToolNotFound
}

type multiIntentSteeringModel struct {
	mu       sync.Mutex
	requests []ModelTurnRequest
}

func (m *multiIntentSteeringModel) Execute(_ context.Context, request ModelTurnRequest, _ ModelDeltaSink) (ModelTurnResult, error) {
	m.mu.Lock()
	m.requests = append(m.requests, request)
	call := len(m.requests)
	m.mu.Unlock()
	if call == 1 {
		// Effect is intentionally omitted for both calls. The first tool blocks,
		// allowing the steer to arrive while the second call is still pending.
		return ModelTurnResult{ToolCalls: []ToolIntent{
			{CallID: "slow-read", ToolName: "slow-read", Arguments: json.RawMessage(`{}`)},
			{CallID: "must-not-run", ToolName: "must-not-run", Arguments: json.RawMessage(`{}`)},
		}, Completed: true}, nil
	}
	return ModelTurnResult{Text: "steered result", Completed: true}, nil
}

func (m *multiIntentSteeringModel) requestsSnapshot() []ModelTurnRequest {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]ModelTurnRequest(nil), m.requests...)
}

type blockingReadExecutor struct {
	started  chan struct{}
	canceled chan error
	once     sync.Once
}

func (e *blockingReadExecutor) Execute(ctx context.Context, _ ToolExecutionRequest) (ToolExecutionResult, error) {
	e.once.Do(func() { close(e.started) })
	<-ctx.Done()
	err := ctx.Err()
	e.canceled <- err
	return ToolExecutionResult{Status: "failed", ErrorCode: "canceled"}, err
}

type countingToolExecutor struct {
	mu    sync.Mutex
	calls int
}

func (e *countingToolExecutor) Execute(context.Context, ToolExecutionRequest) (ToolExecutionResult, error) {
	e.mu.Lock()
	e.calls++
	e.mu.Unlock()
	return ToolExecutionResult{Status: "completed", Value: map[string]any{"unexpected": true}}, nil
}

func (e *countingToolExecutor) callCount() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.calls
}

func TestHarnessSteerSupersedesAllRemainingToolIntents(t *testing.T) {
	model := &multiIntentSteeringModel{}
	first := &blockingReadExecutor{started: make(chan struct{}), canceled: make(chan error, 1)}
	second := &countingToolExecutor{}
	catalog := &multiIntentCatalog{
		descriptors: []ToolDescriptor{
			{Name: "slow-read", Effect: ToolEffectReadOnly, InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`)},
			{Name: "must-not-run", Effect: ToolEffectReadOnly, InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`)},
		},
		executors: map[string]ToolExecutor{"slow-read": first, "must-not-run": second},
	}
	harness, ledger := newContractHarness(t, model, catalog, nil)

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{RequestID: "steer-batch-request", Content: "read both"})
	if err != nil {
		t.Fatalf("submit input: %v", err)
	}
	select {
	case <-first.started:
	case <-time.After(time.Second):
		t.Fatal("first tool did not start")
	}
	active, err := ledger.GetRun(context.Background(), receipt.RunID)
	if err != nil {
		t.Fatalf("read active run revision: %v", err)
	}
	steer, err := harness.SubmitInput(context.Background(), AgentInputRequest{
		RequestID: "steer-batch-command", SessionID: receipt.SessionID,
		Content: "stop and answer directly", DispatchMode: DispatchSteer,
		ExpectedRevision: active.Revision,
	})
	if err != nil {
		t.Fatalf("submit steer: %v", err)
	}
	if steer.Disposition != "steered" || steer.RunID != receipt.RunID {
		t.Fatalf("steer receipt = %#v, want active run %q", steer, receipt.RunID)
	}
	select {
	case cancelErr := <-first.canceled:
		if !errors.Is(cancelErr, context.Canceled) {
			t.Fatalf("first tool cancellation = %v, want context.Canceled", cancelErr)
		}
	case <-time.After(time.Second):
		t.Fatal("steer did not cancel the first tool")
	}

	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if read.Run.State != RunStateCompleted {
		t.Fatalf("steered run state = %s, want %s", read.Run.State, RunStateCompleted)
	}
	if got := second.callCount(); got != 0 {
		t.Fatalf("second tool calls = %d, want 0", got)
	}
	requests := model.requestsSnapshot()
	if len(requests) != 2 {
		t.Fatalf("model calls = %d, want 2", len(requests))
	}
	if !requestContainsContent(requests[1].Messages, "stop and answer directly") {
		t.Fatalf("second model turn missing steer input: %#v", requests[1].Messages)
	}
	if requestContainsContent(requests[1].Messages, "steered result") {
		t.Fatalf("second model request contains its future result: %#v", requests[1].Messages)
	}

	toolEvents := map[string]ToolEvent{}
	for _, event := range read.Events {
		if event.Kind != EventTool {
			continue
		}
		payload, decodeErr := DecodeEventPayload[ToolEvent](event)
		if decodeErr != nil {
			t.Fatalf("decode tool event: %v", decodeErr)
		}
		if payload.Status == "failed" || payload.Status == "canceled" {
			toolEvents[payload.CallID] = payload
		}
	}
	firstEvent, firstOK := toolEvents["slow-read"]
	if !firstOK || firstEvent.Status != "failed" || firstEvent.ErrorCode != "canceled" {
		t.Fatalf("started read-only tool outcome = %#v, want canceled failure", firstEvent)
	}
	secondEvent, secondOK := toolEvents["must-not-run"]
	if !secondOK || secondEvent.Status != "canceled" || secondEvent.ErrorCode != "superseded_by_steer" {
		t.Fatalf("unstarted tool outcome = %#v, want superseded cancellation", secondEvent)
	}
	for _, event := range []ToolEvent{firstEvent, secondEvent} {
		if event.Effect != ToolEffectReadOnly {
			t.Fatalf("tool %q effect = %q, want read_only", event.CallID, event.Effect)
		}
	}

	persisted := map[string]struct {
		status    string
		errorCode string
	}{}
	rows, queryErr := ledger.db.Query(`SELECT call_id,status,error_code FROM tool_calls WHERE run_id=? ORDER BY call_id`, receipt.RunID)
	if queryErr != nil {
		t.Fatalf("read tool calls: %v", queryErr)
	}
	defer rows.Close()
	rowsSeen := 0
	for rows.Next() {
		var callID, status, errorCode string
		if scanErr := rows.Scan(&callID, &status, &errorCode); scanErr != nil {
			t.Fatalf("scan tool call: %v", scanErr)
		}
		rowsSeen++
		persisted[callID] = struct{ status, errorCode string }{status: status, errorCode: errorCode}
	}
	if rowsErr := rows.Err(); rowsErr != nil {
		t.Fatalf("iterate tool calls: %v", rowsErr)
	}
	if rowsSeen != 2 {
		t.Fatalf("tool call rows = %d, want 2", rowsSeen)
	}
	if record := persisted["slow-read"]; record.status != "failed" || record.errorCode != "canceled" {
		t.Fatalf("started read-only record = %#v, want canceled failure", record)
	}
	if record := persisted["must-not-run"]; record.status != "canceled" || record.errorCode != "superseded_by_steer" {
		t.Fatalf("unstarted record = %#v, want superseded cancellation", record)
	}

	messages, err := ledger.GetRunMessages(context.Background(), receipt.RunID, 0, 100)
	if err != nil {
		t.Fatalf("read run messages: %v", err)
	}
	toolMessages := make(map[string]Message)
	for _, message := range messages {
		if message.Role == "tool" {
			toolMessages[message.ToolCallID] = message
		}
	}
	if message, ok := toolMessages["slow-read"]; !ok || !json.Valid([]byte(message.Content)) {
		t.Fatalf("started tool message = %#v, want valid JSON", message)
	}
	if message, ok := toolMessages["must-not-run"]; !ok || message.Content != `{"error":"superseded_by_steer"}` {
		t.Fatalf("unstarted tool message = %#v, want superseded JSON", message)
	}
}
