package runharness

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

// contextHarnessModel captures the provider projection after the Harness has
// applied its ContextBuilder boundary. It intentionally does not synthesize
// deltas: callers can verify idle timeout behavior against a quiet provider.
type contextHarnessModel struct {
	mu       sync.Mutex
	calls    int
	requests []ModelTurnRequest
	result   ModelTurnResult
	execute  func(context.Context, ModelTurnRequest, ModelDeltaSink) (ModelTurnResult, error)
}

func (m *contextHarnessModel) Execute(ctx context.Context, request ModelTurnRequest, sink ModelDeltaSink) (ModelTurnResult, error) {
	m.mu.Lock()
	m.calls++
	m.requests = append(m.requests, cloneContextHarnessModelRequest(request))
	execute := m.execute
	result := m.result
	m.mu.Unlock()
	if execute != nil {
		return execute(ctx, request, sink)
	}
	return result, nil
}

func (m *contextHarnessModel) callCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.calls
}

func (m *contextHarnessModel) latestRequest() (ModelTurnRequest, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.requests) == 0 {
		return ModelTurnRequest{}, false
	}
	return cloneContextHarnessModelRequest(m.requests[len(m.requests)-1]), true
}

func cloneContextHarnessModelRequest(request ModelTurnRequest) ModelTurnRequest {
	copy := request
	copy.Messages = cloneContextMessages(request.Messages)
	copy.Tools = cloneContextTools(request.Tools)
	copy.ProviderState = cloneContextRaw(request.ProviderState)
	copy.Temperature = cloneContextFloat(request.Temperature)
	copy.MaxTokens = cloneContextInt(request.MaxTokens)
	return copy
}

// newestOnlyContextBuilder selects a byte budget dynamically from the newest
// durable message. This avoids coupling the Harness integration test to UUID
// and timestamp serialization while still requiring a genuine compression.
type newestOnlyContextBuilder struct {
	mu          sync.Mutex
	compression ContextCompressionMetadata
}

func (b *newestOnlyContextBuilder) Build(ctx context.Context, input ContextBuildRequest) (ContextBuildResult, error) {
	maxBytes := 0
	if len(input.Messages) > 0 {
		maxBytes, _ = contextMessagesSize(input.Messages[len(input.Messages)-1:], nil)
	}
	result, err := (&DeterministicContextBuilder{MaxBytes: maxBytes}).Build(ctx, input)
	if err != nil {
		return ContextBuildResult{}, err
	}
	b.mu.Lock()
	b.compression = result.Compression
	b.mu.Unlock()
	return result, nil
}

func (b *newestOnlyContextBuilder) lastCompression() ContextCompressionMetadata {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.compression
}

func newContextBuilderHarness(t *testing.T, model ModelTurnAdapter, tools ToolCatalog, builder ContextBuilder) (*AgentRunHarness, *Ledger) {
	t.Helper()
	ledger, err := OpenWithKey(":memory:", bytes.Repeat([]byte{0x63}, 32))
	if err != nil {
		t.Fatalf("open ledger: %v", err)
	}
	harness, err := NewAgentRunHarness(HarnessConfig{
		Ledger: ledger, Model: model, Tools: tools, ContextBuilder: builder,
		RootContext: context.Background(), OwnerID: "context-builder-test-owner",
		LeaseDuration: time.Second, PollInterval: 5 * time.Millisecond,
	})
	if err != nil {
		_ = ledger.Close()
		t.Fatalf("new harness: %v", err)
	}
	t.Cleanup(func() {
		_ = harness.Close()
		_ = ledger.Close()
	})
	return harness, ledger
}

func TestHarnessContextCompressionDisablesProviderToolsAndPreservesLedgerTranscript(t *testing.T) {
	model := &contextHarnessModel{result: ModelTurnResult{Text: "compressed answer", Completed: true}}
	catalog := &contractToolCatalog{
		descriptor: ToolDescriptor{
			Name: "read_metadata", Effect: ToolEffectReadOnly,
			InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`),
		},
		executor: &contractToolExecutor{result: ToolExecutionResult{Status: "completed"}},
		effect:   ToolEffectReadOnly,
	}
	builder := &newestOnlyContextBuilder{}
	harness, ledger := newContextBuilderHarness(t, model, catalog, builder)

	session, err := ledger.CreateSession(context.Background(), CreateSessionRequest{SessionID: "context-compression-session"})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	history := []Message{
		{ID: "context-history-1", SessionID: session.ID, Role: "user", Content: strings.Repeat("first historical message ", 80)},
		{ID: "context-history-2", SessionID: session.ID, Role: "assistant", Content: strings.Repeat("second historical message ", 80)},
		{ID: "context-history-3", SessionID: session.ID, Role: "user", Content: strings.Repeat("third historical message ", 80)},
	}
	for _, message := range history {
		if _, err := ledger.AppendMessage(context.Background(), message); err != nil {
			t.Fatalf("append history %q: %v", message.ID, err)
		}
	}
	current, err := ledger.GetSession(context.Background(), session.ID, false)
	if err != nil {
		t.Fatalf("read session revision: %v", err)
	}

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{
		RequestID: "context-compression-request", SessionID: session.ID, Content: "answer only the newest question",
		ExpectedRevision: current.Revision,
	})
	if err != nil {
		t.Fatalf("submit input: %v", err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if read.Run.State != RunStateCompleted {
		t.Fatalf("run state = %s, want completed", read.Run.State)
	}

	request, ok := model.latestRequest()
	if !ok {
		t.Fatal("provider was not called")
	}
	if len(request.Tools) != 0 {
		t.Fatalf("provider tools after compressed projection = %#v, want none", request.Tools)
	}
	if len(request.Messages) != 1 || request.Messages[0].Content != "answer only the newest question" {
		t.Fatalf("provider projection = %#v, want only newest durable input", request.Messages)
	}
	if compression := builder.lastCompression(); !compression.Applied || compression.OmittedMessageCount < len(history) {
		t.Fatalf("builder compression = %#v, want all historical messages omitted", compression)
	}

	projection, err := ledger.GetSession(context.Background(), session.ID, true)
	if err != nil {
		t.Fatalf("read durable transcript: %v", err)
	}
	for _, historical := range history {
		found := false
		for _, message := range projection.Messages {
			if message.ID == historical.ID && message.Content == historical.Content {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("compressed provider projection deleted durable history message %q", historical.ID)
		}
	}

	var completed ModelCompletedEvent
	foundCompleted := false
	for _, event := range read.Events {
		if event.Kind != EventModelCompleted {
			continue
		}
		var decodeErr error
		completed, decodeErr = DecodeEventPayload[ModelCompletedEvent](event)
		if decodeErr != nil {
			t.Fatalf("decode model completed: %v", decodeErr)
		}
		foundCompleted = true
		break
	}
	if !foundCompleted {
		t.Fatal("missing model completed event")
	}
	if !completed.Compression.Applied || completed.Compression.OmittedMessageCount < len(history) {
		t.Fatalf("persisted compression = %#v, want historical omission metadata", completed.Compression)
	}
}

func TestHarnessContextBuilderUsesLiveWorkspaceAndPersistsExactReference(t *testing.T) {
	model := &contextHarnessModel{result: ModelTurnResult{Text: "workspace answer", Completed: true}}
	harness, ledger := newContextBuilderHarness(t, model, nil, nil)

	snapshot, err := ledger.PutWorkspaceSnapshot(context.Background(), WorkspaceSnapshot{
		SourceKind: WorkspaceDesktop, SourceID: "context-workspace-source", SourceInstanceID: "context-workspace-instance",
		Revision: 17, ActiveContext: map[string]any{"connection": "demo", "database": "sales", "object": "orders"},
	})
	if err != nil {
		t.Fatalf("put workspace snapshot: %v", err)
	}
	want := workspaceSnapshotReference(snapshot)
	if want == nil {
		t.Fatal("workspace snapshot did not produce a reference")
	}

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{
		RequestID: "context-workspace-request", Content: "inspect the selected object",
		ContextSourceID: snapshot.SourceID, ContextSourceInstanceID: snapshot.SourceInstanceID,
	})
	if err != nil {
		t.Fatalf("submit input: %v", err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if read.Run.State != RunStateCompleted {
		t.Fatalf("run state = %s, want completed", read.Run.State)
	}

	request, ok := model.latestRequest()
	if !ok {
		t.Fatal("provider was not called")
	}
	requestReference, foundWorkspace := contextWorkspaceReference(request.Messages)
	if !foundWorkspace || !sameWorkspaceSnapshotReference(requestReference, want) {
		t.Fatalf("provider workspace reference = %#v, want %#v", requestReference, want)
	}

	var completed ModelCompletedEvent
	var checkpointEvent CheckpointEvent
	foundCompleted, foundCheckpoint := false, false
	for _, event := range read.Events {
		switch event.Kind {
		case EventModelCompleted:
			var decodeErr error
			completed, decodeErr = DecodeEventPayload[ModelCompletedEvent](event)
			if decodeErr != nil {
				t.Fatalf("decode model completed: %v", decodeErr)
			}
			foundCompleted = true
		case EventCheckpoint:
			candidate, decodeErr := DecodeEventPayload[CheckpointEvent](event)
			if decodeErr != nil {
				t.Fatalf("decode checkpoint: %v", decodeErr)
			}
			if sameWorkspaceSnapshotReference(candidate.WorkspaceSnapshot, want) {
				checkpointEvent = candidate
				foundCheckpoint = true
			}
		}
	}
	if !foundCompleted {
		t.Fatal("missing model completed event")
	}
	if !sameWorkspaceSnapshotReference(completed.WorkspaceSnapshot, want) {
		t.Fatalf("model completed workspace reference = %#v, want %#v", completed.WorkspaceSnapshot, want)
	}
	if !completed.Compression.WorkspaceIncluded || !sameWorkspaceSnapshotReference(completed.Compression.Workspace, want) {
		t.Fatalf("model completed workspace compression = %#v, want %#v", completed.Compression, want)
	}
	if !foundCheckpoint || !sameWorkspaceSnapshotReference(checkpointEvent.WorkspaceSnapshot, want) {
		t.Fatalf("checkpoint event workspace reference = %#v, want %#v", checkpointEvent.WorkspaceSnapshot, want)
	}
	checkpoint, err := ledger.LatestCheckpoint(context.Background(), receipt.RunID)
	if err != nil {
		t.Fatalf("latest checkpoint: %v", err)
	}
	if !sameWorkspaceSnapshotReference(checkpoint.WorkspaceSnapshot, want) {
		t.Fatalf("checkpoint workspace reference = %#v, want %#v", checkpoint.WorkspaceSnapshot, want)
	}
}

func TestHarnessContextLimitDoesNotInvokeProviderOrLeakReservation(t *testing.T) {
	model := &contextHarnessModel{result: ModelTurnResult{Text: "must not be sent", Completed: true}}
	harness, ledger := newContextBuilderHarness(t, model, nil, &DeterministicContextBuilder{MaxBytes: 1})
	policy := DefaultRunPolicy()
	policy.MaxTotalTokens = 128
	if err := harness.SetDefaultPolicy(policy); err != nil {
		t.Fatalf("set policy: %v", err)
	}
	maxTokens := 37
	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{
		RequestID: "context-limit-request", Content: "this newest durable input cannot fit", MaxTokens: &maxTokens,
	})
	if err != nil {
		t.Fatalf("submit input: %v", err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if read.Run.State != RunStateFailed {
		t.Fatalf("run state = %s, want failed", read.Run.State)
	}
	if got := model.callCount(); got != 0 {
		t.Fatalf("provider calls = %d, want 0 after context limit", got)
	}
	if read.Run.ReservedTokens != 0 {
		t.Fatalf("reserved tokens = %d, want 0", read.Run.ReservedTokens)
	}

	foundError := false
	for _, event := range read.Events {
		if event.Kind != EventRunError {
			continue
		}
		payload, decodeErr := DecodeEventPayload[RunErrorEvent](event)
		if decodeErr != nil {
			t.Fatalf("decode run error: %v", decodeErr)
		}
		if payload.Code != "context_limit" {
			continue
		}
		foundError = true
		if !strings.Contains(payload.Message, ErrContextLimit.Error()) {
			t.Fatalf("context limit error message = %q, want %q", payload.Message, ErrContextLimit)
		}
	}
	if !foundError {
		t.Fatal("missing context_limit error event")
	}
	var reserved int
	if err := ledger.db.QueryRow(`SELECT COUNT(*) FROM token_reservations WHERE run_id=? AND status='reserved'`, receipt.RunID).Scan(&reserved); err != nil {
		t.Fatalf("count reserved tokens: %v", err)
	}
	if reserved != 0 {
		t.Fatalf("reserved token rows = %d, want 0", reserved)
	}
}

func TestHarnessModelIdleTimeoutSurfacesDeadline(t *testing.T) {
	model := &contextHarnessModel{execute: func(ctx context.Context, _ ModelTurnRequest, _ ModelDeltaSink) (ModelTurnResult, error) {
		<-ctx.Done()
		return ModelTurnResult{}, ctx.Err()
	}}
	harness, _ := newContextBuilderHarness(t, model, nil, nil)
	policy := DefaultRunPolicy()
	policy.ModelIdleTimeout = 30 * time.Millisecond
	if err := harness.SetDefaultPolicy(policy); err != nil {
		t.Fatalf("set policy: %v", err)
	}

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{RequestID: "idle-timeout-request", Content: "wait without deltas"})
	if err != nil {
		t.Fatalf("submit input: %v", err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if read.Run.State != RunStateFailed {
		t.Fatalf("run state = %s, want failed", read.Run.State)
	}
	if got := model.callCount(); got != 1 {
		t.Fatalf("provider calls = %d, want 1", got)
	}

	foundDeadline := false
	for _, event := range read.Events {
		if event.Kind != EventRunError {
			continue
		}
		payload, decodeErr := DecodeEventPayload[RunErrorEvent](event)
		if decodeErr != nil {
			t.Fatalf("decode run error: %v", decodeErr)
		}
		if payload.Code == ModelErrorDeadline {
			foundDeadline = true
		}
	}
	if !foundDeadline {
		t.Fatalf("missing deadline run error event for model idle timeout; events=%#v", read.Events)
	}
}

func contextWorkspaceReference(messages []Message) (*WorkspaceSnapshotReference, bool) {
	for _, message := range messages {
		if message.Role != "system" {
			continue
		}
		var envelope struct {
			Kind      string                      `json:"kind"`
			Reference *WorkspaceSnapshotReference `json:"reference"`
		}
		if err := json.Unmarshal([]byte(message.Content), &envelope); err != nil || envelope.Kind != "workspace_snapshot" {
			continue
		}
		return envelope.Reference, true
	}
	return nil, false
}
