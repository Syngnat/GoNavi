package runharness

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/provider"
)

// ProviderResolver creates a provider for a frozen model-turn request. The
// resolver is intentionally called once per attempt so a run cannot silently
// switch provider configuration halfway through a turn.
type ProviderResolver func(context.Context, ModelTurnRequest) (provider.Provider, error)

// ProviderImagePrompts carries the optional localized text used by legacy
// providers when an image message has no text or when the selected upstream
// cannot accept images. Keeping this outside ModelTurnRequest avoids storing
// display-language strings in the durable provider checkpoint while still
// letting a desktop host supply the current locale for every model turn.
type ProviderImagePrompts struct {
	FallbackPrompt string
	OmittedNotice  string
}

// ProviderImagePromptResolver is host-owned because the Harness itself has no
// UI language or localization dependency. A nil resolver deliberately leaves
// the provider defaults in place, which is the intended CLI behavior.
type ProviderImagePromptResolver func(context.Context, ModelTurnRequest) (ProviderImagePrompts, error)

// ProviderModelTurnAdapter is the standard adapter for GoNavi's existing
// Provider implementations. It converts the legacy stream callback into the
// typed ModelDeltaSink contract and keeps provider state opaque to the runner.
type ProviderModelTurnAdapter struct {
	Resolve             ProviderResolver
	ResolveImagePrompts ProviderImagePromptResolver
}

func NewProviderModelTurnAdapter(resolve ProviderResolver, imagePromptResolver ...ProviderImagePromptResolver) *ProviderModelTurnAdapter {
	adapter := &ProviderModelTurnAdapter{Resolve: resolve}
	if len(imagePromptResolver) > 0 {
		adapter.ResolveImagePrompts = imagePromptResolver[0]
	}
	return adapter
}

func (a *ProviderModelTurnAdapter) Execute(ctx context.Context, request ModelTurnRequest, sink ModelDeltaSink) (ModelTurnResult, error) {
	if ctx == nil {
		return ModelTurnResult{}, ErrRootContextRequired
	}
	if a == nil || a.Resolve == nil {
		return ModelTurnResult{}, errors.New("model provider resolver is unavailable")
	}
	if err := ctx.Err(); err != nil {
		return ModelTurnResult{}, err
	}
	convertedMessages, err := toAIMessages(request.Messages)
	if err != nil {
		return ModelTurnResult{}, err
	}
	temperature, maxTokens, err := providerChatOptions(request)
	if err != nil {
		return ModelTurnResult{}, err
	}
	p, err := a.Resolve(ctx, request)
	if err != nil {
		return ModelTurnResult{}, err
	}
	if p == nil {
		return ModelTurnResult{}, errors.New("model provider is unavailable")
	}
	chatRequest := ai.ChatRequest{
		Messages:    convertedMessages,
		Tools:       toAITools(request.Tools),
		Temperature: temperature,
		MaxTokens:   maxTokens,
	}
	if a.ResolveImagePrompts != nil {
		prompts, err := a.ResolveImagePrompts(ctx, request)
		if err != nil {
			return ModelTurnResult{}, err
		}
		chatRequest.ImageFallbackPrompt = prompts.FallbackPrompt
		chatRequest.ImageOmittedNotice = prompts.OmittedNotice
	}
	var (
		stateMu       sync.Mutex
		callbackMu    sync.Mutex
		callbackWG    sync.WaitGroup
		closed        bool
		doneSeen      bool
		content       strings.Builder
		reasoning     strings.Builder
		toolCalls     []ai.ToolCall
		firstSinkErr  error
		firstChunkErr error
	)
	emit := func(chunk ai.StreamChunk) {
		// Some legacy providers launch their callback from a helper goroutine and
		// return from ChatStream before that goroutine has stopped. Register the
		// callback under a gate so the adapter can close the gate and wait for
		// callbacks already in flight without allowing a late callback to mutate
		// the next turn's result.
		callbackMu.Lock()
		if closed {
			callbackMu.Unlock()
			return
		}
		callbackWG.Add(1)
		callbackMu.Unlock()
		defer callbackWG.Done()

		stateMu.Lock()
		defer stateMu.Unlock()
		// Done is a one-way boundary. Providers occasionally deliver a final
		// callback from a helper goroutine after returning; accepting it would
		// append text or tool calls to the next harness step.
		if doneSeen {
			return
		}
		// A number of legacy providers report stream failures through the
		// callback and return nil (the callback is their only way to preserve
		// the upstream diagnostic). Capture that error before checking the
		// sink; otherwise the adapter would turn a failed turn into a successful
		// empty response and the next harness step could use corrupt state.
		if firstChunkErr != nil || firstSinkErr != nil {
			if chunk.Done {
				doneSeen = true
			}
			return
		}
		if strings.TrimSpace(chunk.Error) != "" {
			firstChunkErr = errors.New(strings.TrimSpace(chunk.Error))
			if chunk.Done {
				doneSeen = true
			}
			return
		}
		if ctx.Err() != nil {
			if chunk.Done {
				doneSeen = true
			}
			return
		}
		if chunk.Content != "" {
			content.WriteString(chunk.Content)
		}
		reasoningDelta := chunk.ReasoningContent
		if reasoningDelta == "" {
			reasoningDelta = chunk.Thinking
		}
		if reasoningDelta != "" {
			reasoning.WriteString(reasoningDelta)
		}
		if len(chunk.ToolCalls) > 0 {
			toolCalls = cloneAIToolCalls(chunk.ToolCalls)
		}
		delta := ModelDelta{Text: chunk.Content, Reasoning: reasoningDelta}
		if len(chunk.ToolCalls) > 0 {
			delta.ToolCalls = toToolIntents(chunk.ToolCalls)
		}
		if chunk.Done {
			doneSeen = true
		}
		if delta.Text == "" && delta.Reasoning == "" && len(delta.ToolCalls) == 0 {
			return
		}
		if err := sink.Delta(ctx, delta); err != nil {
			firstSinkErr = err
		}
	}

	// Provider implementations are not all well behaved about context
	// cancellation. Run the legacy call out of band so a provider that blocks
	// forever cannot strand the harness worker. The result channel is buffered:
	// after cancellation the provider may eventually return, and must be able
	// to publish its result without another goroutine leak.
	type streamResult struct {
		state json.RawMessage
		err   error
	}
	resultCh := make(chan streamResult, 1)
	var closeOnce sync.Once
	closeCallbacks := func() {
		closeOnce.Do(func() {
			// Add is always performed while callbackMu is held, so closing the
			// gate before Wait prevents a late callback from racing WaitGroup.Add.
			callbackMu.Lock()
			closed = true
			callbackMu.Unlock()
			callbackWG.Wait()
		})
	}
	go func() {
		var result streamResult
		if stateful, ok := p.(provider.SessionStreamProvider); ok {
			result.state, result.err = stateful.ChatStreamWithState(ctx, cloneRaw(request.ProviderState), chatRequest, emit)
		} else {
			result.err = p.ChatStream(ctx, chatRequest, emit)
		}
		// Close the gate in the provider goroutine, immediately after the
		// provider returns. This makes callbacks scheduled after return late by
		// definition, even if the adapter has not received resultCh yet.
		closeCallbacks()
		resultCh <- result
	}()

	var stream streamResult
	select {
	case stream = <-resultCh:
		// The provider goroutine closes the callback gate before publishing its
		// result. Calling it here is idempotent and covers a future adapter
		// implementation that writes the result through another path.
		closeCallbacks()
	case <-ctx.Done():
		closeCallbacks()
		return ModelTurnResult{}, ctx.Err()
	}

	stateMu.Lock()
	callbackErr := errors.Join(firstChunkErr, firstSinkErr)
	hasOutput := content.Len() > 0 || reasoning.Len() > 0 || len(toolCalls) > 0
	completed := doneSeen
	text := content.String()
	reasoningText := reasoning.String()
	convertedToolCalls := toToolIntents(toolCalls)
	stateMu.Unlock()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ModelTurnResult{}, ctxErr
	}
	// A provider's context/sentinel error describes cancellation/deadline more
	// authoritatively than a callback diagnostic. For other errors preserve both
	// details while keeping the callback error first (legacy providers often
	// return a generic error and put the useful HTTP detail in the callback).
	if stream.err != nil {
		if errors.Is(stream.err, context.Canceled) || errors.Is(stream.err, context.DeadlineExceeded) {
			if callbackErr != nil {
				return ModelTurnResult{}, errors.Join(stream.err, callbackErr)
			}
			return ModelTurnResult{}, stream.err
		}
		if callbackErr != nil {
			return ModelTurnResult{}, errors.Join(callbackErr, stream.err)
		}
		return ModelTurnResult{}, stream.err
	}
	if callbackErr != nil {
		return ModelTurnResult{}, callbackErr
	}
	if !completed && !hasOutput {
		return ModelTurnResult{}, errors.New("model provider returned empty response")
	}
	result := ModelTurnResult{
		Text: text, Reasoning: reasoningText,
		ToolCalls: convertedToolCalls, ProviderState: cloneRaw(stream.state), Completed: true,
	}
	return result, nil
}

// providerChatOptions derives provider-facing options only from the immutable
// binding captured at run acceptance. ModelTurnRequest's legacy fields remain
// available for durable budget accounting, but cannot override this contract.
func providerChatOptions(request ModelTurnRequest) (float64, int, error) {
	if request.ProviderBinding == nil {
		return 0, 0, nil
	}
	binding, err := request.ProviderBinding.Validate()
	if err != nil {
		return 0, 0, fmt.Errorf("%w: %v", ErrProviderBindingCorrupt, err)
	}
	if requestedID := strings.TrimSpace(request.Provider); requestedID == "" || !strings.EqualFold(requestedID, binding.ProviderID) {
		return 0, 0, fmt.Errorf("%w: model request provider %q does not match binding %q", ErrProviderBindingCorrupt, request.Provider, binding.ProviderID)
	}
	var config ai.ProviderConfig
	if err := json.Unmarshal(binding.Config, &config); err != nil {
		return 0, 0, fmt.Errorf("%w: decode provider config: %v", ErrProviderBindingCorrupt, err)
	}
	config.ID = strings.TrimSpace(config.ID)
	if config.ID == "" || config.ID != binding.ProviderID {
		return 0, 0, fmt.Errorf("%w: provider config ID %q does not match binding %q", ErrProviderBindingCorrupt, config.ID, binding.ProviderID)
	}
	return config.Temperature, config.MaxTokens, nil
}

func cloneRaw(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	return append(json.RawMessage(nil), raw...)
}

func cloneAIToolCalls(calls []ai.ToolCall) []ai.ToolCall {
	if len(calls) == 0 {
		return nil
	}
	result := make([]ai.ToolCall, len(calls))
	copy(result, calls)
	return result
}

// toAIMessages converts the encrypted ledger representation to the legacy
// provider message shape.  New harness turns persist ToolIntent values
// (callId/toolName/arguments), while imported sessions may still contain the
// old OpenAI-compatible (id/function) shape.  Both forms are accepted here so
// a process restart never sends an assistant tool turn with empty IDs/names.
func toAIMessages(messages []Message) ([]ai.Message, error) {
	result := make([]ai.Message, 0, len(messages))
	for _, message := range messages {
		converted := ai.Message{Role: message.Role, Content: message.Content, Images: append([]string(nil), message.Images...), ToolCallID: message.ToolCallID, ReasoningContent: message.Reasoning}
		if len(message.ToolCalls) > 0 {
			calls, err := decodePersistedToolCalls(message.ToolCalls)
			if err != nil {
				return nil, fmt.Errorf("%w: message %s: %v", ErrMalformedToolCall, message.ID, err)
			}
			converted.ToolCalls = calls
		}
		result = append(result, converted)
	}
	return result, nil
}

// decodePersistedToolCalls accepts both the harness-native ToolIntent JSON and
// the legacy ai.ToolCall JSON used by imported sessions.  It deliberately
// rejects incomplete calls instead of silently dropping them: doing so would
// produce an invalid assistant/tool pairing on the next provider request.
func decodePersistedToolCalls(raw json.RawMessage) ([]ai.ToolCall, error) {
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, fmt.Errorf("tool calls must be a JSON array: %w", err)
	}
	result := make([]ai.ToolCall, 0, len(entries))
	seenCallIDs := make(map[string]struct{}, len(entries))
	for index, entry := range entries {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(entry, &fields); err != nil || fields == nil {
			if err == nil {
				err = errors.New("tool call must be an object")
			}
			return nil, fmt.Errorf("tool call %d: %w", index, err)
		}
		if _, ok := fields["function"]; ok {
			var call ai.ToolCall
			if err := json.Unmarshal(entry, &call); err != nil {
				return nil, fmt.Errorf("tool call %d: %w", index, err)
			}
			call.ID = strings.TrimSpace(call.ID)
			call.Function.Name = strings.TrimSpace(call.Function.Name)
			if call.ID == "" {
				return nil, fmt.Errorf("tool call %d: call ID is empty", index)
			}
			if call.Function.Name == "" {
				return nil, fmt.Errorf("tool call %d: tool name is empty", index)
			}
			if _, exists := seenCallIDs[call.ID]; exists {
				return nil, fmt.Errorf("tool call %d: duplicate call ID %q", index, call.ID)
			}
			seenCallIDs[call.ID] = struct{}{}
			if call.Type == "" {
				call.Type = "function"
			}
			if call.Function.Arguments == "" {
				call.Function.Arguments = "{}"
			}
			if !validToolArgumentsObject(call.Function.Arguments) {
				return nil, fmt.Errorf("tool call %d: arguments must be a JSON object", index)
			}
			result = append(result, call)
			continue
		}

		var callID, toolName string
		for _, key := range []string{"callId", "call_id", "id"} {
			if value, exists := fields[key]; exists {
				if err := json.Unmarshal(value, &callID); err != nil {
					return nil, fmt.Errorf("tool call %d: invalid call ID: %w", index, err)
				}
				break
			}
		}
		for _, key := range []string{"toolName", "tool_name", "name"} {
			if value, exists := fields[key]; exists {
				if err := json.Unmarshal(value, &toolName); err != nil {
					return nil, fmt.Errorf("tool call %d: invalid tool name: %w", index, err)
				}
				break
			}
		}
		callID = strings.TrimSpace(callID)
		toolName = strings.TrimSpace(toolName)
		if callID == "" {
			return nil, fmt.Errorf("tool call %d: call ID is empty", index)
		}
		if toolName == "" {
			return nil, fmt.Errorf("tool call %d: tool name is empty", index)
		}
		if _, exists := seenCallIDs[callID]; exists {
			return nil, fmt.Errorf("tool call %d: duplicate call ID %q", index, callID)
		}
		seenCallIDs[callID] = struct{}{}
		arguments, exists := fields["arguments"]
		if !exists || len(strings.TrimSpace(string(arguments))) == 0 || string(arguments) == "null" {
			arguments = json.RawMessage(`{}`)
		}
		if !validToolArgumentsObject(string(arguments)) {
			return nil, fmt.Errorf("tool call %d: arguments must be a JSON object", index)
		}
		// A ToolIntent's arguments are a JSON value.  Legacy providers expect the
		// same value encoded as a string inside function.arguments.
		result = append(result, ai.ToolCall{ID: callID, Type: "function", Function: ai.ToolCallFunction{Name: toolName, Arguments: string(arguments)}})
	}
	return result, nil
}

func validToolArgumentsObject(arguments string) bool {
	var object map[string]json.RawMessage
	return json.Unmarshal([]byte(arguments), &object) == nil && object != nil
}

func toAITools(tools []ToolDescriptor) []ai.Tool {
	result := make([]ai.Tool, 0, len(tools))
	for _, descriptor := range tools {
		parameters := any(map[string]any{"type": "object", "properties": map[string]any{}})
		if len(descriptor.InputSchema) > 0 && json.Valid(descriptor.InputSchema) {
			var decoded any
			if err := json.Unmarshal(descriptor.InputSchema, &decoded); err == nil {
				parameters = decoded
			}
		}
		result = append(result, ai.Tool{Type: "function", Function: ai.ToolFunction{
			Name: descriptor.Name, Description: descriptor.Description, Parameters: parameters,
		}})
	}
	return result
}

func toToolIntents(calls []ai.ToolCall) []ToolIntent {
	if len(calls) == 0 {
		return nil
	}
	result := make([]ToolIntent, 0, len(calls))
	for _, call := range calls {
		arguments := json.RawMessage(strings.TrimSpace(call.Function.Arguments))
		if len(arguments) == 0 {
			arguments = json.RawMessage(`{}`)
		}
		intent := ToolIntent{CallID: strings.TrimSpace(call.ID), ToolName: strings.TrimSpace(call.Function.Name), Arguments: cloneRaw(arguments)}
		if json.Valid(arguments) {
			intent.ArgsHash, _ = HashJSON(arguments)
		}
		result = append(result, intent)
	}
	return result
}

// Ensure compile-time coverage of the adapter seam.
var _ ModelTurnAdapter = (*ProviderModelTurnAdapter)(nil)

func providerErrorCode(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, context.Canceled) {
		return "canceled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "deadline"
	}
	return fmt.Sprintf("provider: %s", err.Error())
}
