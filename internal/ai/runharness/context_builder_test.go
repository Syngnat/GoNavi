package runharness

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestDeterministicContextBuilderRetainsTranscriptAndTrimsProjection(t *testing.T) {
	messages := []Message{
		{ID: "m-1", SessionID: "session-1", Sequence: 1, Role: "user", Content: "old context that must be omitted", CreatedAt: time.Unix(1, 0).UTC()},
		{ID: "m-2", SessionID: "session-1", Sequence: 2, Role: "assistant", Content: "recent answer", CreatedAt: time.Unix(2, 0).UTC()},
		{ID: "m-3", SessionID: "session-1", Sequence: 3, Role: "user", Content: "latest question", CreatedAt: time.Unix(3, 0).UTC()},
	}
	lastTwoBytes, _ := contextMessagesSize(messages[1:], nil)
	builder := &DeterministicContextBuilder{MaxBytes: lastTwoBytes}

	result, err := builder.Build(context.Background(), ContextBuildRequest{
		Run: RunSnapshot{ID: "run-1", SessionID: "session-1", Policy: DefaultRunPolicy()}, Messages: messages,
	})
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	if !reflect.DeepEqual(result.Transcript, messages) {
		t.Fatalf("Transcript = %#v, want full durable transcript %#v", result.Transcript, messages)
	}
	if got, want := messageIDs(result.Request.Messages), []string{"m-2", "m-3"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("provider projection IDs = %v, want %v", got, want)
	}
	metadata := result.Compression
	if !metadata.Applied || metadata.OmittedMessageCount != 1 {
		t.Fatalf("compression metadata = %#v, want one omitted message", metadata)
	}
	if metadata.OmittedFromMessageID != "m-1" || metadata.OmittedThroughMessageID != "m-1" ||
		metadata.OmittedFromSequence != 1 || metadata.OmittedThroughSequence != 1 {
		t.Fatalf("omitted cursor = %#v, want m-1 sequence 1", metadata)
	}
	if metadata.RetainedFromMessageID != "m-2" || metadata.RetainedThroughMessageID != "m-3" ||
		metadata.RetainedFromSequence != 2 || metadata.RetainedThroughSequence != 3 {
		t.Fatalf("retained cursor = %#v, want m-2 through m-3", metadata)
	}
	if metadata.ProviderBytes > lastTwoBytes {
		t.Fatalf("provider bytes = %d, max = %d", metadata.ProviderBytes, lastTwoBytes)
	}
}

func TestDeterministicContextBuilderUsesInjectedTokenEstimator(t *testing.T) {
	messages := []Message{
		{ID: "m-1", Sequence: 1, Role: "user", Content: "old"},
		{ID: "m-2", Sequence: 2, Role: "user", Content: "new"},
	}
	builder := &DeterministicContextBuilder{
		MaxTokens: 2,
		EstimateTokens: func(message Message) int {
			if message.ID == "m-2" {
				return 2
			}
			return 1
		},
	}

	result, err := builder.Build(context.Background(), ContextBuildRequest{Messages: messages})
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	if got, want := messageIDs(result.Request.Messages), []string{"m-2"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("provider projection IDs = %v, want %v", got, want)
	}
	if result.Compression.ProviderTokens != 2 || result.Compression.TranscriptTokens != 3 {
		t.Fatalf("token totals = %#v, want provider=2 transcript=3", result.Compression)
	}
	if result.Compression.ProviderBytes <= 0 || result.Compression.MaxBytes != 0 {
		t.Fatalf("byte limit must be disabled while bytes remain observable: %#v", result.Compression)
	}
}

func TestDeterministicContextBuilderMeasuresEachMessageOnceAndIsolatesEstimator(t *testing.T) {
	messages := []Message{{ID: "m-1", Role: "user", Content: "one", Images: []string{"image"}}}
	calls := 0
	builder := &DeterministicContextBuilder{EstimateTokens: func(message Message) int {
		calls++
		message.Images[0] = "estimator-mutation"
		return 1
	}}
	result, err := builder.Build(context.Background(), ContextBuildRequest{Messages: messages})
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	if calls != 1 {
		t.Fatalf("token estimator calls = %d, want exactly one", calls)
	}
	if messages[0].Images[0] != "image" || result.Transcript[0].Images[0] != "image" || result.Request.Messages[0].Images[0] != "image" {
		t.Fatalf("estimator mutation escaped isolation: input=%#v transcript=%#v request=%#v", messages, result.Transcript, result.Request.Messages)
	}
}

func TestDeterministicContextBuilderPrependsDeterministicWorkspaceMessage(t *testing.T) {
	snapshot := &WorkspaceSnapshot{
		SchemaVersion:    CurrentSchemaVersion,
		SourceKind:       WorkspaceDesktop,
		SourceID:         "desktop",
		SourceInstanceID: "window-1",
		Revision:         8,
		CapturedAt:       time.Unix(100, 0).UTC(),
		ContentHash:      "snapshot-hash",
		ActiveContext:    map[string]any{"database": "demo", "host": "local"},
		Shortcuts:        map[string]string{"run": "cmd-enter"},
	}
	reference := &WorkspaceSnapshotReference{SourceID: "desktop", SourceInstanceID: "window-1", Revision: 8, ContentHash: "snapshot-hash"}
	input := ContextBuildRequest{Messages: []Message{{ID: "m-1", Sequence: 1, Role: "user", Content: "inspect it"}}, WorkspaceSnapshot: snapshot, WorkspaceReference: reference}
	builder := NewDeterministicContextBuilder()

	first, err := builder.Build(context.Background(), input)
	if err != nil {
		t.Fatalf("first Build() error = %v", err)
	}
	second, err := builder.Build(context.Background(), input)
	if err != nil {
		t.Fatalf("second Build() error = %v", err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("two builds differ:\nfirst=%#v\nsecond=%#v", first, second)
	}
	if len(first.Request.Messages) != 2 || first.Request.Messages[0].Role != "system" || first.Request.Messages[1].ID != "m-1" {
		t.Fatalf("projection = %#v, want workspace system message followed by transcript", first.Request.Messages)
	}
	var envelope struct {
		Kind      string                      `json:"kind"`
		Snapshot  WorkspaceSnapshot           `json:"snapshot"`
		Reference *WorkspaceSnapshotReference `json:"reference"`
	}
	if err := json.Unmarshal([]byte(first.Request.Messages[0].Content), &envelope); err != nil {
		t.Fatalf("decode workspace message: %v", err)
	}
	if envelope.Kind != "workspace_snapshot" || envelope.Snapshot.ActiveContext["database"] != "demo" || !sameWorkspaceSnapshotReference(envelope.Reference, reference) {
		t.Fatalf("workspace envelope = %#v", envelope)
	}
	if !first.Compression.WorkspaceIncluded || !sameWorkspaceSnapshotReference(first.Compression.Workspace, reference) {
		t.Fatalf("workspace compression metadata = %#v", first.Compression)
	}

	// The serialized system message must retain its captured view after the
	// caller changes its own source object.
	snapshot.ActiveContext["database"] = "mutated"
	if strings.Contains(first.Request.Messages[0].Content, "mutated") {
		t.Fatalf("workspace system message aliases caller workspace: %q", first.Request.Messages[0].Content)
	}
}

func TestDeterministicContextBuilderMapsRunAndDoesNotAliasInputs(t *testing.T) {
	temperature := 0.35
	maxTokens := 2048
	messages := []Message{{
		ID: "message-1", SessionID: "session-1", Sequence: 1, Role: "assistant", Content: "answer",
		Images: []string{"image-a"}, Attachments: []Attachment{{Name: "file-a", Data: "payload"}},
		ToolCalls: json.RawMessage(`[{"callId":"call-1"}]`), Metadata: json.RawMessage(`{"meta":"value"}`),
	}}
	tools := []ToolDescriptor{{Name: "read", InputSchema: json.RawMessage(`{"type":"object"}`), Capabilities: []string{"workspace"}, Effect: ToolEffectReadOnly}}
	providerState := json.RawMessage(`{"cursor":"one"}`)
	snapshot := &WorkspaceSnapshot{
		SchemaVersion: CurrentSchemaVersion, SourceKind: WorkspaceCLI, SourceID: "cli", SourceInstanceID: "pid-1", Revision: 2,
		CapturedAt: time.Unix(200, 0).UTC(), ContentHash: "snapshot-2", ActiveContext: map[string]any{"cwd": "/work"},
	}
	reference := &WorkspaceSnapshotReference{SourceID: "cli", SourceInstanceID: "pid-1", Revision: 2, ContentHash: "snapshot-2"}
	run := RunSnapshot{
		ID: "run-1", SessionID: "session-1", Provider: "custom", Model: "model-a", Thinking: "high", Temperature: &temperature, MaxTokens: &maxTokens, Policy: DefaultRunPolicy(),
	}
	result, err := NewDeterministicContextBuilder().Build(context.Background(), ContextBuildRequest{
		Run: run, Messages: messages, Tools: tools, WorkspaceSnapshot: snapshot, WorkspaceReference: reference,
		ConversationCursor: "cursor-1", ProviderState: providerState,
	})
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	request := result.Request
	if request.RunID != run.ID || request.SessionID != run.SessionID || request.Provider != run.Provider || request.Model != run.Model || request.Thinking != run.Thinking || request.ConversationCursor != "cursor-1" {
		t.Fatalf("request run mapping = %#v", request)
	}
	if request.Temperature == nil || *request.Temperature != temperature || request.MaxTokens == nil || *request.MaxTokens != maxTokens || !reflect.DeepEqual(request.Policy, run.Policy) {
		t.Fatalf("request configuration mapping = %#v", request)
	}

	// Mutate every reference-like caller field after Build. Neither the
	// provider projection nor the returned full transcript may observe it.
	messages[0].Images[0] = "changed-image"
	messages[0].Attachments[0].Data = "changed-attachment"
	messages[0].ToolCalls[0] = 'x'
	messages[0].Metadata[0] = 'x'
	tools[0].InputSchema[0] = 'x'
	tools[0].Capabilities[0] = "changed-capability"
	providerState[0] = 'x'
	snapshot.ActiveContext["cwd"] = "changed"
	reference.ContentHash = "changed-reference"
	temperature = 0.99
	maxTokens = 1

	projectedMessage := result.Request.Messages[1] // index zero is workspace.
	if projectedMessage.Images[0] != "image-a" || projectedMessage.Attachments[0].Data != "payload" || string(projectedMessage.ToolCalls) != `[{"callId":"call-1"}]` || string(projectedMessage.Metadata) != `{"meta":"value"}` {
		t.Fatalf("request message aliases caller: %#v", projectedMessage)
	}
	if result.Transcript[0].Images[0] != "image-a" || result.Transcript[0].Attachments[0].Data != "payload" {
		t.Fatalf("transcript aliases caller: %#v", result.Transcript[0])
	}
	if string(request.Tools[0].InputSchema) != `{"type":"object"}` || request.Tools[0].Capabilities[0] != "workspace" || string(request.ProviderState) != `{"cursor":"one"}` {
		t.Fatalf("request tool/provider state aliases caller: %#v", request)
	}
	if *request.Temperature != 0.35 || *request.MaxTokens != 2048 || result.Compression.Workspace.ContentHash != "snapshot-2" {
		t.Fatalf("request pointers/reference alias caller: %#v", result)
	}
}

func TestDeterministicContextBuilderAllowsEmptyContext(t *testing.T) {
	builder := NewDeterministicContextBuilder()
	first, err := builder.Build(context.Background(), ContextBuildRequest{})
	if err != nil {
		t.Fatalf("first Build() error = %v", err)
	}
	second, err := builder.Build(context.Background(), ContextBuildRequest{})
	if err != nil {
		t.Fatalf("second Build() error = %v", err)
	}
	if !reflect.DeepEqual(first, second) || len(first.Transcript) != 0 || len(first.Request.Messages) != 0 || first.Compression.Applied || first.Compression.WorkspaceIncluded {
		t.Fatalf("empty build result = %#v", first)
	}
}

func TestDeterministicContextBuilderRejectsInvalidLimitsAndCanceledContext(t *testing.T) {
	if _, err := (&DeterministicContextBuilder{MaxBytes: -1}).Build(context.Background(), ContextBuildRequest{}); err == nil {
		t.Fatal("negative byte limit should fail")
	}
	if _, err := (&DeterministicContextBuilder{MaxTokens: -1}).Build(context.Background(), ContextBuildRequest{}); err == nil {
		t.Fatal("negative token limit should fail")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := NewDeterministicContextBuilder().Build(ctx, ContextBuildRequest{}); err == nil {
		t.Fatal("canceled context should fail")
	}
}

func messageIDs(messages []Message) []string {
	result := make([]string, len(messages))
	for index, message := range messages {
		result[index] = message.ID
	}
	return result
}
