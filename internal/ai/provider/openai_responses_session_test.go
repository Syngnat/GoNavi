package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
)

func TestOpenAIResponsesProviderSessionReplaysRawReasoningAndToolItems(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		defer r.Body.Close()
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if payload["store"] != false || payload["previous_response_id"] != nil {
			t.Fatalf("expected local stateless request, got %#v", payload)
		}
		include, _ := payload["include"].([]any)
		if len(include) != 1 || include[0] != "reasoning.encrypted_content" {
			t.Fatalf("expected encrypted reasoning include, got %#v", payload["include"])
		}

		w.Header().Set("Content-Type", "application/json")
		if requestCount == 1 {
			_, _ = w.Write([]byte(`{
				"id":"resp_tool",
				"status":"completed",
				"output":[
					{"id":"rs_1","type":"reasoning","encrypted_content":"opaque-reasoning-token","summary":[{"type":"summary_text","text":"Inspect metadata."}]},
					{"id":"msg_1","type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"I will inspect it."}]},
					{"id":"fc_1","type":"function_call","status":"completed","call_id":"call_1","name":"get_columns","arguments":"{\"table\":\"orders\"}"}
				]
			}`))
			return
		}

		inputJSON, _ := json.Marshal(payload["input"])
		inputText := string(inputJSON)
		for _, expected := range []string{
			`"encrypted_content":"opaque-reasoning-token"`,
			`"phase":"commentary"`,
			`"type":"function_call"`,
			`"type":"function_call_output"`,
			`"call_id":"call_1"`,
		} {
			if !strings.Contains(inputText, expected) {
				t.Fatalf("expected replayed input to contain %s, got %s", expected, inputText)
			}
		}
		_, _ = w.Write([]byte(`{
			"id":"resp_final",
			"status":"completed",
			"output":[
				{"id":"msg_2","type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"The table has an id column."}]}
			]
		}`))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "openai", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "gpt-test",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	sessionProvider, ok := providerInstance.(SessionChatProvider)
	if !ok {
		t.Fatalf("expected SessionChatProvider, got %T", providerInstance)
	}

	first, state, err := sessionProvider.ChatWithState(context.Background(), nil, ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "Inspect orders"}},
	})
	if err != nil {
		t.Fatalf("first response: %v", err)
	}
	if first.Content != "I will inspect it." || len(first.ToolCalls) != 1 || len(state) == 0 {
		t.Fatalf("unexpected first response/state: response=%#v state=%s", first, state)
	}

	second, nextState, err := sessionProvider.ChatWithState(context.Background(), state, ai.ChatRequest{
		Messages: []ai.Message{{Role: "tool", ToolCallID: "call_1", Content: `{"columns":["id"]}`}},
	})
	if err != nil {
		t.Fatalf("second response: %v", err)
	}
	if second.Content != "The table has an id column." || len(nextState) == 0 || requestCount != 2 {
		t.Fatalf("unexpected second response/state: response=%#v state=%s requests=%d", second, nextState, requestCount)
	}
}

func TestOpenAIResponsesProviderStreamSessionAddsOnlyNewMultiToolOutputs(t *testing.T) {
	requestCount := 0
	var replayInputs [][]map[string]any
	transport := responsesRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		requestCount++
		if r.URL.Path != "/responses" {
			return nil, fmt.Errorf("DeepSeek Responses path = %q, want /responses", r.URL.Path)
		}
		var payload struct {
			Input []map[string]any `json:"input"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			return nil, err
		}
		body := `data: {"type":"response.completed","response":{"id":"resp_final","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}}

`
		if requestCount == 1 {
			body = `data: {"type":"response.completed","response":{"id":"resp_tools","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Checking two probes."}]},{"type":"function_call","call_id":"call_a","name":"probe_a","arguments":"{}"},{"type":"function_call","call_id":"call_b","name":"probe_b","arguments":"{}"}]}}

`
		} else {
			replayInputs = append(replayInputs, payload.Input)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(body)),
			Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
			Request:    r,
		}, nil
	})

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "openai", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: "https://api.deepseek.com/v1", Model: "DeepSeek-V4-Flash-0731",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	providerInstance.(*OpenAIResponsesProvider).client = &http.Client{Transport: transport}
	sessionProvider, ok := providerInstance.(SessionStreamProvider)
	if !ok {
		t.Fatalf("expected SessionStreamProvider, got %T", providerInstance)
	}

	var firstContent strings.Builder
	var firstCalls []ai.ToolCall
	state, err := sessionProvider.ChatStreamWithState(context.Background(), nil, ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "inspect"}},
	}, func(chunk ai.StreamChunk) {
		firstContent.WriteString(chunk.Content)
		if len(chunk.ToolCalls) > 0 {
			firstCalls = chunk.ToolCalls
		}
	})
	if err != nil {
		t.Fatalf("first response: %v", err)
	}
	if firstContent.String() != "Checking two probes." || len(firstCalls) != 2 || len(state) == 0 {
		t.Fatalf("unexpected first response/state: content=%q calls=%#v state=%s", firstContent.String(), firstCalls, state)
	}

	decodedState, ok := decodeOpenAIResponsesSessionState(state)
	if !ok || len(decodedState.MessageFingerprints) == 0 {
		t.Fatalf("new state must track represented messages: %s", state)
	}
	legacyState, err := json.Marshal(openAIResponsesSessionState{Input: decodedState.Input})
	if err != nil {
		t.Fatalf("marshal legacy state: %v", err)
	}

	for _, replayState := range []json.RawMessage{state, legacyState} {
		_, err = sessionProvider.ChatStreamWithState(context.Background(), replayState, ai.ChatRequest{
			Messages: []ai.Message{
				{Role: "user", Content: "inspect"},
				{Role: "assistant", Content: firstContent.String(), ToolCalls: firstCalls},
				{Role: "tool", ToolCallID: "call_a", Content: `{"ok":true}`},
				{Role: "tool", ToolCallID: "call_b", Content: `{"ok":true}`},
			},
		}, func(ai.StreamChunk) {})
		if err != nil {
			t.Fatalf("replay response: %v", err)
		}
	}

	if len(replayInputs) != 2 {
		t.Fatalf("replay requests = %d, want current and legacy state", len(replayInputs))
	}
	for index, replayInput := range replayInputs {
		messageCounts := map[string]int{}
		callCounts := map[string]int{}
		outputCounts := map[string]int{}
		for _, item := range replayInput {
			typeName, _ := item["type"].(string)
			callID, _ := item["call_id"].(string)
			switch typeName {
			case "message":
				role, _ := item["role"].(string)
				messageCounts[role]++
			case "function_call":
				callCounts[callID]++
			case "function_call_output":
				outputCounts[callID]++
			}
		}
		if len(replayInput) != 6 || messageCounts["user"] != 1 || messageCounts["assistant"] != 1 ||
			callCounts["call_a"] != 1 || callCounts["call_b"] != 1 ||
			outputCounts["call_a"] != 1 || outputCounts["call_b"] != 1 {
			t.Fatalf("replay %d duplicated completed transcript items: input=%#v messages=%v calls=%v outputs=%v", index, replayInput, messageCounts, callCounts, outputCounts)
		}
	}
}

func TestOpenAIResponsesProviderCompatibleSessionCanonicalizesFunctionCalls(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		defer r.Body.Close()
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}

		w.Header().Set("Content-Type", "application/json")
		if requestCount == 1 {
			_, _ = w.Write([]byte(`{
				"id":"resp_tool",
				"status":"completed",
				"output":[
					{"id":"fc_provider_only","type":"function_call","status":"completed","call_id":"call_1","name":"get_columns","arguments":"{\"table\":\"orders\"}"}
				]
			}`))
			return
		}

		input, ok := payload["input"].([]any)
		if !ok {
			t.Fatalf("expected input array, got %#v", payload["input"])
		}
		var functionCall map[string]any
		var functionCallOutput map[string]any
		for _, rawItem := range input {
			item, ok := rawItem.(map[string]any)
			if !ok {
				continue
			}
			switch item["type"] {
			case "function_call":
				functionCall = item
			case "function_call_output":
				functionCallOutput = item
			}
		}
		if functionCall == nil || functionCall["call_id"] != "call_1" || functionCall["name"] != "get_columns" {
			t.Fatalf("expected canonical function call, got %#v", functionCall)
		}
		if _, exists := functionCall["id"]; exists {
			t.Fatalf("compatibility replay must not send response-only function-call id: %#v", functionCall)
		}
		if _, exists := functionCall["status"]; exists {
			t.Fatalf("compatibility replay must not send response-only function-call status: %#v", functionCall)
		}
		if functionCallOutput == nil || functionCallOutput["call_id"] != "call_1" {
			t.Fatalf("expected matching function call output, got %#v", functionCallOutput)
		}
		_, _ = w.Write([]byte(`{
			"id":"resp_final",
			"status":"completed",
			"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]
		}`))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "openai", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "z-ai/glm-5.3-free",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	sessionProvider, ok := providerInstance.(SessionChatProvider)
	if !ok {
		t.Fatalf("expected SessionChatProvider, got %T", providerInstance)
	}

	_, state, err := sessionProvider.ChatWithState(context.Background(), nil, ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "Inspect orders"}},
	})
	if err != nil {
		t.Fatalf("first response: %v", err)
	}
	decoded, ok := decodeOpenAIResponsesSessionState(state)
	if !ok {
		t.Fatalf("expected valid session state, got %s", state)
	}
	foundFunctionCall := false
	for _, rawItem := range decoded.Input {
		var item map[string]any
		if err := json.Unmarshal(rawItem, &item); err != nil || item["type"] != "function_call" {
			continue
		}
		foundFunctionCall = true
		if _, exists := item["id"]; exists {
			t.Fatalf("new session state must not retain response-only function-call id: %#v", item)
		}
		if _, exists := item["status"]; exists {
			t.Fatalf("new session state must not retain response-only function-call status: %#v", item)
		}
	}
	if !foundFunctionCall {
		t.Fatal("expected function call in new session state")
	}

	// Existing sessions have already persisted the response-shaped item. Ensure
	// they are canonicalized while being replayed, rather than requiring users
	// to discard their active conversation after upgrading.
	legacyState, err := json.Marshal(openAIResponsesSessionState{Input: []json.RawMessage{
		json.RawMessage(`{"id":"fc_provider_only","type":"function_call","status":"completed","call_id":"call_1","name":"get_columns","arguments":"{\"table\":\"orders\"}"}`),
	}})
	if err != nil {
		t.Fatalf("marshal legacy state: %v", err)
	}
	response, _, err := sessionProvider.ChatWithState(context.Background(), legacyState, ai.ChatRequest{
		Messages: []ai.Message{{Role: "tool", ToolCallID: "call_1", Content: `{"columns":["id"]}`}},
	})
	if err != nil {
		t.Fatalf("second response: %v", err)
	}
	if response.Content != "done" || requestCount != 2 {
		t.Fatalf("unexpected response/request count: response=%#v requests=%d", response, requestCount)
	}
}

func TestOpenAIResponsesProviderStreamStateKeepsCompletedRawOutput(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(`data: {"type":"response.completed","response":{"id":"resp_stream_state","status":"completed","output":[{"id":"rs_stream","type":"reasoning","encrypted_content":"stream-secret","summary":[]},{"id":"msg_stream","type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"Checking."}]},{"id":"fc_stream","type":"function_call","call_id":"call_stream","name":"get_columns","arguments":"{}"}]}}

`))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "openai", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "gpt-test",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	sessionProvider, ok := providerInstance.(SessionStreamProvider)
	if !ok {
		t.Fatalf("expected SessionStreamProvider, got %T", providerInstance)
	}

	state, err := sessionProvider.ChatStreamWithState(context.Background(), nil, ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "Inspect orders"}},
	}, func(ai.StreamChunk) {})
	if err != nil {
		t.Fatalf("stream response: %v", err)
	}
	stateText := string(state)
	for _, expected := range []string{"stream-secret", `"phase":"commentary"`, `"type":"function_call"`} {
		if !strings.Contains(stateText, expected) {
			t.Fatalf("expected stream state to preserve %q, got %s", expected, stateText)
		}
	}
}

func TestOpenAIResponsesProviderPreservesExplicitResponsesEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses" {
			t.Fatalf("expected explicit responses endpoint to stay unchanged, got %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"id":"resp_explicit_endpoint",
			"status":"completed",
			"output":[
				{"type":"message","role":"assistant","content":[{"type":"output_text","text":"pong"}]}
			],
			"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}
		}`))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "custom", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1/responses", Model: "gpt-test",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}

	response, err := providerInstance.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping"}},
	})
	if err != nil {
		t.Fatalf("chat: %v", err)
	}
	if response.Content != "pong" {
		t.Fatalf("unexpected response: %#v", response)
	}
}
