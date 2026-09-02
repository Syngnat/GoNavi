package runharness

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/provider"
)

type captureAdapterProvider struct {
	request ai.ChatRequest
}

func (p *captureAdapterProvider) Chat(context.Context, ai.ChatRequest) (*ai.ChatResponse, error) {
	return &ai.ChatResponse{}, nil
}

func (p *captureAdapterProvider) ChatStream(_ context.Context, request ai.ChatRequest, callback func(ai.StreamChunk)) error {
	p.request = request
	if callback != nil {
		callback(ai.StreamChunk{Content: "ok", Done: true})
	}
	return nil
}

func (p *captureAdapterProvider) Name() string    { return "capture" }
func (p *captureAdapterProvider) Validate() error { return nil }

var _ provider.Provider = (*captureAdapterProvider)(nil)

func TestToAIMessagesConvertsHarnessToolIntent(t *testing.T) {
	toolCalls, err := json.Marshal([]ToolIntent{{
		CallID: "call-write", ToolName: "execute_sql",
		Arguments: json.RawMessage(`{"connectionId":"conn-1","sql":"SELECT 1"}`),
		Effect:    ToolEffectReadOnly,
	}})
	if err != nil {
		t.Fatal(err)
	}
	messages, err := toAIMessages([]Message{{
		ID: "message-1", Role: "assistant", Content: "checking",
		Reasoning: "inspect schema first", ToolCalls: toolCalls,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 1 || len(messages[0].ToolCalls) != 1 {
		t.Fatalf("messages = %#v", messages)
	}
	call := messages[0].ToolCalls[0]
	if call.ID != "call-write" || call.Type != "function" || call.Function.Name != "execute_sql" {
		t.Fatalf("converted call = %#v", call)
	}
	if call.Function.Arguments != `{"connectionId":"conn-1","sql":"SELECT 1"}` {
		t.Fatalf("converted arguments = %q", call.Function.Arguments)
	}
	if messages[0].ReasoningContent != "inspect schema first" {
		t.Fatalf("reasoning = %q", messages[0].ReasoningContent)
	}
}

func TestProviderModelTurnAdapterExecuteUsesConvertedHarnessHistory(t *testing.T) {
	toolCalls, err := json.Marshal([]ToolIntent{{
		CallID: "call-write", ToolName: "write", Arguments: json.RawMessage(`{"value":1}`),
	}})
	if err != nil {
		t.Fatal(err)
	}
	captured := &captureAdapterProvider{}
	adapter := NewProviderModelTurnAdapter(func(context.Context, ModelTurnRequest) (provider.Provider, error) {
		return captured, nil
	})
	result, err := adapter.Execute(context.Background(), ModelTurnRequest{Messages: []Message{{
		ID: "message-1", Role: "assistant", ToolCalls: toolCalls,
	}}}, func(context.Context, ModelDelta) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != "ok" {
		t.Fatalf("result = %#v", result)
	}
	if len(captured.request.Messages) != 1 || len(captured.request.Messages[0].ToolCalls) != 1 {
		t.Fatalf("provider request = %#v", captured.request.Messages)
	}
	call := captured.request.Messages[0].ToolCalls[0]
	if call.ID != "call-write" || call.Function.Name != "write" || call.Function.Arguments != `{"value":1}` {
		t.Fatalf("provider call = %#v", call)
	}
}

func TestProviderModelTurnAdapterPassesHostImagePrompts(t *testing.T) {
	captured := &captureAdapterProvider{}
	promptCalls := 0
	adapter := NewProviderModelTurnAdapter(
		func(context.Context, ModelTurnRequest) (provider.Provider, error) { return captured, nil },
		func(_ context.Context, request ModelTurnRequest) (ProviderImagePrompts, error) {
			promptCalls++
			if request.RunID != "run-images" {
				t.Fatalf("request = %#v", request)
			}
			return ProviderImagePrompts{
				FallbackPrompt: "Describe this localized image.",
				OmittedNotice:  "[Localized image unavailable]",
			}, nil
		},
	)
	if _, err := adapter.Execute(context.Background(), ModelTurnRequest{
		RunID:    "run-images",
		Messages: []Message{{Role: "user", Images: []string{"data:image/png;base64,AA=="}}},
	}, nil); err != nil {
		t.Fatal(err)
	}
	if promptCalls != 1 {
		t.Fatalf("prompt resolver calls = %d, want 1", promptCalls)
	}
	if captured.request.ImageFallbackPrompt != "Describe this localized image." || captured.request.ImageOmittedNotice != "[Localized image unavailable]" {
		t.Fatalf("image prompts = %#v", captured.request)
	}
}

func TestProviderModelTurnAdapterUsesFrozenProviderBindingOptions(t *testing.T) {
	captured := &captureAdapterProvider{}
	binding, err := NewProviderBinding("provider-a", ai.ProviderConfig{
		ID: "provider-a", Temperature: 0.2, MaxTokens: 99,
	})
	if err != nil {
		t.Fatalf("new provider binding: %v", err)
	}
	turnTemperature := 0.9
	turnMaxTokens := 1000
	adapter := NewProviderModelTurnAdapter(func(context.Context, ModelTurnRequest) (provider.Provider, error) {
		return captured, nil
	})

	if _, err := adapter.Execute(context.Background(), ModelTurnRequest{
		Provider: "provider-a", ProviderBinding: &binding,
		Temperature: &turnTemperature, MaxTokens: &turnMaxTokens,
	}, nil); err != nil {
		t.Fatalf("execute adapter: %v", err)
	}
	if captured.request.Temperature != 0.2 || captured.request.MaxTokens != 99 {
		t.Fatalf("provider options = temperature=%v maxTokens=%d, want frozen binding values", captured.request.Temperature, captured.request.MaxTokens)
	}
}

func TestProviderModelTurnAdapterIgnoresUnboundTurnOptions(t *testing.T) {
	captured := &captureAdapterProvider{}
	turnTemperature := 0.9
	turnMaxTokens := 1000
	adapter := NewProviderModelTurnAdapter(func(context.Context, ModelTurnRequest) (provider.Provider, error) {
		return captured, nil
	})

	if _, err := adapter.Execute(context.Background(), ModelTurnRequest{
		Temperature: &turnTemperature, MaxTokens: &turnMaxTokens,
	}, nil); err != nil {
		t.Fatalf("execute adapter: %v", err)
	}
	if captured.request.Temperature != 0 || captured.request.MaxTokens != 0 {
		t.Fatalf("provider options = temperature=%v maxTokens=%d, want zero values without a binding", captured.request.Temperature, captured.request.MaxTokens)
	}
}

func TestProviderModelTurnAdapterRequiresLifecycleContext(t *testing.T) {
	resolved := false
	adapter := NewProviderModelTurnAdapter(func(context.Context, ModelTurnRequest) (provider.Provider, error) {
		resolved = true
		return &captureAdapterProvider{}, nil
	})

	_, err := adapter.Execute(nil, ModelTurnRequest{}, nil)
	if !errors.Is(err, ErrRootContextRequired) {
		t.Fatalf("Execute(nil) error = %v, want ErrRootContextRequired", err)
	}
	if resolved {
		t.Fatal("provider resolver ran without a lifecycle context")
	}
}

func TestProviderModelTurnAdapterRejectsMalformedHistoryBeforeResolvingProvider(t *testing.T) {
	resolved := false
	adapter := NewProviderModelTurnAdapter(func(context.Context, ModelTurnRequest) (provider.Provider, error) {
		resolved = true
		return &captureAdapterProvider{}, nil
	})
	_, err := adapter.Execute(context.Background(), ModelTurnRequest{Messages: []Message{{
		ID: "message-bad", Role: "assistant", ToolCalls: json.RawMessage(`[{"callId":"call-1","toolName":"write","arguments":{"bad":}]`),
	}}}, nil)
	if !errors.Is(err, ErrMalformedToolCall) {
		t.Fatalf("error = %v, want ErrMalformedToolCall", err)
	}
	if resolved {
		t.Fatal("provider resolver was called for malformed persisted history")
	}
}

func TestProviderModelTurnAdapterRejectsDuplicatePersistedCallsBeforeResolvingProvider(t *testing.T) {
	resolved := false
	adapter := NewProviderModelTurnAdapter(func(context.Context, ModelTurnRequest) (provider.Provider, error) {
		resolved = true
		return &captureAdapterProvider{}, nil
	})
	_, err := adapter.Execute(context.Background(), ModelTurnRequest{Messages: []Message{{
		ID: "message-duplicate", Role: "assistant", ToolCalls: json.RawMessage(`[
			{"id":" call-1 ","type":"function","function":{"name":" read ","arguments":"{}"}},
			{"id":"call-1","type":"function","function":{"name":"write","arguments":"{}"}}
		]`),
	}}}, nil)
	if !errors.Is(err, ErrMalformedToolCall) {
		t.Fatalf("error = %v, want ErrMalformedToolCall", err)
	}
	if resolved {
		t.Fatal("provider resolver was called for duplicate persisted calls")
	}
}

func TestToAIMessagesPreservesLegacyToolCall(t *testing.T) {
	legacy := json.RawMessage(`[{
		"id":"call-read",
		"type":"function",
		"function":{"name":"inspect_table","arguments":"{}"}
	}]`)
	messages, err := toAIMessages([]Message{{ID: "legacy", Role: "assistant", ToolCalls: legacy}})
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 1 || len(messages[0].ToolCalls) != 1 {
		t.Fatalf("messages = %#v", messages)
	}
	call := messages[0].ToolCalls[0]
	if call.ID != "call-read" || call.Function.Name != "inspect_table" || call.Function.Arguments != "{}" {
		t.Fatalf("legacy call = %#v", call)
	}
}

func TestToAIMessagesDefaultsEmptyArguments(t *testing.T) {
	toolCalls, err := json.Marshal([]ToolIntent{{CallID: "call-empty", ToolName: "ping"}})
	if err != nil {
		t.Fatal(err)
	}
	messages, err := toAIMessages([]Message{{ID: "empty", Role: "assistant", ToolCalls: toolCalls}})
	if err != nil {
		t.Fatal(err)
	}
	if got := messages[0].ToolCalls[0].Function.Arguments; got != "{}" {
		t.Fatalf("arguments = %q, want {}", got)
	}
}

func TestToAIMessagesRejectsMalformedPersistedToolCall(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{name: "invalid array", raw: `[{"callId":"call-1"}`},
		{name: "missing id", raw: `[{"toolName":"write","arguments":{}}]`},
		{name: "missing name", raw: `[{"callId":"call-1","arguments":{}}]`},
		{name: "invalid arguments", raw: `[{"callId":"call-1","toolName":"write","arguments":{"unterminated":}]`},
		{name: "non-object arguments", raw: `[{"callId":"call-1","toolName":"write","arguments":[]}]`},
		{name: "duplicate call id", raw: `[{"callId":"call-1","toolName":"read","arguments":{}},{"callId":"call-1","toolName":"write","arguments":{}}]`},
		{name: "legacy invalid arguments", raw: `[{"id":"call-1","function":{"name":"write","arguments":"{"}}]`},
		{name: "legacy non-object arguments", raw: `[{"id":"call-1","function":{"name":"write","arguments":"[]"}}]`},
		{name: "legacy duplicate call id", raw: `[{"id":"call-1","function":{"name":"read","arguments":"{}"}},{"id":"call-1","function":{"name":"write","arguments":"{}"}}]`},
		{name: "legacy duplicate call id after trimming", raw: `[{"id":" call-1 ","function":{"name":" read ","arguments":"{}"}},{"id":"call-1","function":{"name":"write","arguments":"{}"}}]`},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			_, err := toAIMessages([]Message{{ID: test.name, Role: "assistant", ToolCalls: json.RawMessage(test.raw)}})
			if !errors.Is(err, ErrMalformedToolCall) {
				t.Fatalf("error = %v, want ErrMalformedToolCall", err)
			}
			if !strings.Contains(err.Error(), test.name) {
				t.Fatalf("error = %v, want message ID", err)
			}
		})
	}
}

func TestDecodePersistedToolCallsDoesNotMutateInput(t *testing.T) {
	original := json.RawMessage(`[{"callId":"call-1","toolName":"write","arguments":{}}]`)
	copyBefore := append([]byte(nil), original...)
	converted, err := decodePersistedToolCalls(original)
	if err != nil {
		t.Fatal(err)
	}
	if len(converted) != 1 || converted[0].Function.Name != "write" {
		t.Fatalf("converted = %#v", converted)
	}
	if string(original) != string(copyBefore) {
		t.Fatalf("input mutated: before=%s after=%s", copyBefore, original)
	}
}

type lateCallbackProvider struct {
	started      chan struct{}
	allow        chan struct{}
	callbackDone chan struct{}
}

func (p *lateCallbackProvider) Chat(context.Context, ai.ChatRequest) (*ai.ChatResponse, error) {
	return nil, errors.New("unexpected non-stream call")
}

func (p *lateCallbackProvider) ChatStream(_ context.Context, _ ai.ChatRequest, callback func(ai.StreamChunk)) error {
	close(p.started)
	go func() {
		defer close(p.callbackDone)
		<-p.allow
		callback(ai.StreamChunk{Content: "late"})
	}()
	return nil
}

func (*lateCallbackProvider) Name() string    { return "late-callback" }
func (*lateCallbackProvider) Validate() error { return nil }

// A provider callback that starts after ChatStream returns must be ignored.
// The test also runs under -race: the adapter's callback gate must not leave
// the result builders exposed to concurrent writes.
func TestProviderModelTurnAdapterDropsLateCallbacksAfterProviderReturns(t *testing.T) {
	lateProvider := &lateCallbackProvider{started: make(chan struct{}), allow: make(chan struct{}), callbackDone: make(chan struct{})}
	adapter := NewProviderModelTurnAdapter(func(context.Context, ModelTurnRequest) (provider.Provider, error) {
		return lateProvider, nil
	})

	var mu sync.Mutex
	var deltas []ModelDelta
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = adapter.Execute(context.Background(), ModelTurnRequest{}, func(_ context.Context, delta ModelDelta) error {
			mu.Lock()
			deltas = append(deltas, delta)
			mu.Unlock()
			return nil
		})
	}()
	select {
	case <-lateProvider.started:
	case <-time.After(time.Second):
		t.Fatal("provider did not start")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("adapter did not return")
	}
	// The provider invokes the callback only after Execute has returned.
	close(lateProvider.allow)
	select {
	case <-lateProvider.callbackDone:
	case <-time.After(time.Second):
		t.Fatal("late callback did not finish")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(deltas) != 0 {
		t.Fatalf("deltas = %#v, want late callback to be dropped", deltas)
	}
}

// A legacy provider may ignore context cancellation while it waits on an
// upstream process. The adapter must return cancellation to the harness
// without allowing that provider to block the run worker forever.
type ignoresCancellationProvider struct {
	started  chan struct{}
	allow    chan struct{}
	finished chan struct{}
}

func (p *ignoresCancellationProvider) Chat(context.Context, ai.ChatRequest) (*ai.ChatResponse, error) {
	return nil, errors.New("unexpected non-stream call")
}

func (p *ignoresCancellationProvider) ChatStream(_ context.Context, _ ai.ChatRequest, callback func(ai.StreamChunk)) error {
	close(p.started)
	<-p.allow
	defer close(p.finished)
	if callback != nil {
		callback(ai.StreamChunk{Content: "late", Done: true})
	}
	return nil
}

func (*ignoresCancellationProvider) Name() string    { return "ignores-cancellation" }
func (*ignoresCancellationProvider) Validate() error { return nil }

func TestProviderModelTurnAdapterReturnsWhenProviderIgnoresCancellation(t *testing.T) {
	providerInstance := &ignoresCancellationProvider{started: make(chan struct{}), allow: make(chan struct{}), finished: make(chan struct{})}
	adapter := NewProviderModelTurnAdapter(func(context.Context, ModelTurnRequest) (provider.Provider, error) {
		return providerInstance, nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	resultCh := make(chan error, 1)
	callbackCalled := make(chan struct{}, 1)
	go func() {
		_, err := adapter.Execute(ctx, ModelTurnRequest{}, func(context.Context, ModelDelta) error {
			callbackCalled <- struct{}{}
			return nil
		})
		resultCh <- err
	}()
	select {
	case <-providerInstance.started:
	case <-time.After(time.Second):
		t.Fatal("provider did not start")
	}
	cancel()
	select {
	case err := <-resultCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("adapter remained blocked after context cancellation")
	}
	// Let the provider goroutine finish so the test does not leak a blocked
	// goroutine into subsequent tests.
	close(providerInstance.allow)
	select {
	case <-providerInstance.finished:
	case <-time.After(time.Second):
		t.Fatal("provider did not finish after release")
	}
	select {
	case <-callbackCalled:
		t.Fatal("canceled provider callback must be dropped")
	default:
	}
}

type doneThenLateProvider struct{}

func (*doneThenLateProvider) Chat(context.Context, ai.ChatRequest) (*ai.ChatResponse, error) {
	return nil, errors.New("unexpected non-stream call")
}

func (*doneThenLateProvider) ChatStream(_ context.Context, _ ai.ChatRequest, callback func(ai.StreamChunk)) error {
	callback(ai.StreamChunk{Content: "first", Done: true})
	callback(ai.StreamChunk{Content: "late", Error: "late failure", Done: true})
	return nil
}

func (*doneThenLateProvider) Name() string    { return "done-then-late" }
func (*doneThenLateProvider) Validate() error { return nil }

func TestProviderModelTurnAdapterIgnoresCallbacksAfterDone(t *testing.T) {
	adapter := NewProviderModelTurnAdapter(func(context.Context, ModelTurnRequest) (provider.Provider, error) {
		return &doneThenLateProvider{}, nil
	})
	var deltas []ModelDelta
	result, err := adapter.Execute(context.Background(), ModelTurnRequest{}, func(_ context.Context, delta ModelDelta) error {
		deltas = append(deltas, delta)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != "first" {
		t.Fatalf("result text = %q, want first callback only", result.Text)
	}
	if len(deltas) != 1 || deltas[0].Text != "first" {
		t.Fatalf("deltas = %#v, want one first delta", deltas)
	}
}

type emptyStreamProvider struct{}

func (*emptyStreamProvider) Chat(context.Context, ai.ChatRequest) (*ai.ChatResponse, error) {
	return nil, errors.New("unexpected non-stream call")
}

func (*emptyStreamProvider) ChatStream(context.Context, ai.ChatRequest, func(ai.StreamChunk)) error {
	return nil
}

func (*emptyStreamProvider) Name() string    { return "empty-stream" }
func (*emptyStreamProvider) Validate() error { return nil }

func TestProviderModelTurnAdapterRejectsEmptyStream(t *testing.T) {
	adapter := NewProviderModelTurnAdapter(func(context.Context, ModelTurnRequest) (provider.Provider, error) {
		return &emptyStreamProvider{}, nil
	})
	_, err := adapter.Execute(context.Background(), ModelTurnRequest{}, nil)
	if err == nil || classifyError(err) != ModelErrorProtocol {
		t.Fatalf("error = %v, want protocol empty-response error", err)
	}
}
