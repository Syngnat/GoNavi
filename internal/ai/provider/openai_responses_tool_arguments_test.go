package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
)

var openAIResponsesInvalidToolArgumentsCases = []struct {
	name      string
	arguments string
}{
	{name: "malformed", arguments: `{"connectionId":"1787533241017"`},
	{name: "array", arguments: `[]`},
	{name: "null", arguments: `null`},
	{name: "string", arguments: `"connection-1"`},
}

var openAIResponsesBlankToolArgumentsCases = []struct {
	name      string
	arguments string
}{
	{name: "empty", arguments: ""},
	{name: "whitespace", arguments: " \t\n "},
}

func TestBuildOpenAIResponsesInputDropsCompleteToolTurnWithInvalidArguments(t *testing.T) {
	items := buildOpenAIResponsesInput([]ai.Message{
		{Role: "user", Content: "Inspect."},
		{
			Role: "assistant",
			ToolCalls: []ai.ToolCall{{
				ID:   "call_execute_sql",
				Type: "function",
				Function: ai.ToolCallFunction{
					Name:      "execute_sql",
					Arguments: `{"connectionId":"1787533241017"`,
				},
			}},
		},
		{Role: "tool", ToolCallID: "call_execute_sql", Content: `{"error":"arguments parse failed"}`},
		{Role: "user", Content: "Continue."},
	}, "https://api.openai.com/v1")

	if len(items) != 2 || items[0].Role != "user" || items[1].Role != "user" {
		t.Fatalf("expected malformed Responses tool turn to be removed, got %#v", items)
	}
}

func TestOpenAIResponsesProviderChatWithStateRejectsInvalidCompletedToolArguments(t *testing.T) {
	for _, testCase := range openAIResponsesInvalidToolArgumentsCases {
		t.Run(testCase.name, func(t *testing.T) {
			provider := newOpenAIResponsesToolArgumentsTestProvider(t, false, testCase.arguments)
			oldState := openAIResponsesToolArgumentsTestOldState()

			response, nextState, err := provider.ChatWithState(context.Background(), oldState, ai.ChatRequest{
				Messages: []ai.Message{{Role: "user", Content: "Continue."}},
			})

			assertOpenAIResponsesInvalidToolArgumentsError(t, err)
			if response != nil {
				t.Fatalf("expected invalid completed tool call to return no response, got %#v", response)
			}
			if !bytes.Equal(nextState, oldState) {
				t.Fatalf("expected invalid completed tool call to preserve old state, old=%s next=%s", oldState, nextState)
			}
		})
	}
}

func TestOpenAIResponsesProviderChatStreamWithStateRejectsInvalidCompletedToolArguments(t *testing.T) {
	for _, testCase := range openAIResponsesInvalidToolArgumentsCases {
		t.Run(testCase.name, func(t *testing.T) {
			provider := newOpenAIResponsesToolArgumentsTestProvider(t, true, testCase.arguments)
			oldState := openAIResponsesToolArgumentsTestOldState()
			done := false

			nextState, err := provider.ChatStreamWithState(context.Background(), oldState, ai.ChatRequest{
				Messages: []ai.Message{{Role: "user", Content: "Continue."}},
			}, func(chunk ai.StreamChunk) {
				done = done || chunk.Done
			})

			assertOpenAIResponsesInvalidToolArgumentsError(t, err)
			if done {
				t.Fatal("expected invalid completed tool call not to emit Done")
			}
			if !bytes.Equal(nextState, oldState) {
				t.Fatalf("expected invalid completed tool call to preserve old state, old=%s next=%s", oldState, nextState)
			}
		})
	}
}

func TestOpenAIResponsesProviderRejectsNonStringCompletedToolArguments(t *testing.T) {
	cases := []struct {
		name      string
		arguments any
	}{
		{name: "object", arguments: map[string]any{"connectionId": "1787533241017"}},
		{name: "null", arguments: nil},
		{name: "number", arguments: 1},
		{name: "boolean", arguments: true},
	}
	for _, testCase := range cases {
		for _, stream := range []bool{false, true} {
			mode := "non_stream"
			if stream {
				mode = "stream"
			}
			t.Run(testCase.name+"/"+mode, func(t *testing.T) {
				assertOpenAIResponsesRejectsNonStringCompletedToolArguments(t, stream, testCase.arguments)
			})
		}
	}
}

func assertOpenAIResponsesRejectsNonStringCompletedToolArguments(t *testing.T, stream bool, arguments any) {
	t.Helper()
	response := map[string]any{
		"id":     "resp_non_string_arguments",
		"status": "completed",
		"output": []any{
			map[string]any{
				"type": "message",
				"role": "assistant",
				"content": []any{map[string]any{
					"type": "output_text",
					"text": "Preparing to execute SQL.",
				}},
			},
			map[string]any{
				"type":      "function_call",
				"call_id":   "call_execute_sql",
				"name":      "execute_sql",
				"arguments": arguments,
			},
		},
	}
	responseBody, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("encode completed response: %v", err)
	}
	contentType := "application/json"
	if stream {
		contentType = "text/event-stream"
		eventBody, err := json.Marshal(map[string]any{
			"type":     "response.completed",
			"response": response,
		})
		if err != nil {
			t.Fatalf("encode completed stream event: %v", err)
		}
		responseBody = append(append([]byte("data: "), eventBody...), '\n', '\n')
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", contentType)
		_, _ = w.Write(responseBody)
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type:      "custom",
		APIFormat: "openai-responses",
		APIKey:    "sk-test",
		BaseURL:   server.URL + "/v1",
		Model:     "gpt-test",
	})
	if err != nil {
		t.Fatalf("create Responses provider: %v", err)
	}
	provider := providerInstance.(*OpenAIResponsesProvider)
	oldState := openAIResponsesToolArgumentsTestOldState()
	if stream {
		done := false
		nextState, streamErr := provider.ChatStreamWithState(
			context.Background(),
			oldState,
			ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "Continue."}}},
			func(chunk ai.StreamChunk) { done = done || chunk.Done },
		)
		assertOpenAIResponsesInvalidToolArgumentsError(t, streamErr)
		if done {
			t.Fatal("expected non-string tool arguments not to emit Done")
		}
		if !bytes.Equal(nextState, oldState) {
			t.Fatalf("expected non-string tool arguments to preserve old state, old=%s next=%s", oldState, nextState)
		}
		return
	}

	responseValue, nextState, chatErr := provider.ChatWithState(
		context.Background(),
		oldState,
		ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "Continue."}}},
	)
	assertOpenAIResponsesInvalidToolArgumentsError(t, chatErr)
	if responseValue != nil {
		t.Fatalf("expected non-string tool arguments to return no response, got %#v", responseValue)
	}
	if !bytes.Equal(nextState, oldState) {
		t.Fatalf("expected non-string tool arguments to preserve old state, old=%s next=%s", oldState, nextState)
	}
}

func TestOpenAIResponsesProviderChatStreamRejectsInvalidDeltaOnlyToolArguments(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(strings.Join([]string{
			`data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_execute_sql","name":"execute_sql","arguments":""}}`,
			``,
			`data: {"type":"response.function_call_arguments.done","output_index":0,"name":"execute_sql","arguments":"{\"connectionId\":\"1787533241017\""}`,
			``,
			`data: {"type":"response.completed","response":{"id":"resp_delta_only","status":"completed","output":[]}}`,
			``,
		}, "\n")))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type:      "custom",
		APIFormat: "openai-responses",
		APIKey:    "sk-test",
		BaseURL:   server.URL + "/v1",
		Model:     "gpt-test",
	})
	if err != nil {
		t.Fatalf("create Responses provider: %v", err)
	}
	oldState := openAIResponsesToolArgumentsTestOldState()
	done := false
	nextState, err := providerInstance.(*OpenAIResponsesProvider).ChatStreamWithState(
		context.Background(),
		oldState,
		ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "Continue."}}},
		func(chunk ai.StreamChunk) { done = done || chunk.Done },
	)

	assertOpenAIResponsesInvalidToolArgumentsError(t, err)
	if done {
		t.Fatal("expected invalid delta-only tool call not to emit Done")
	}
	if !bytes.Equal(nextState, oldState) {
		t.Fatalf("expected invalid delta-only tool call to preserve old state, old=%s next=%s", oldState, nextState)
	}
}

func TestOpenAIResponsesProviderChatStreamNormalizesBlankDeltaOnlyToolArguments(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(strings.Join([]string{
			`data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_list_connections","name":"list_connections","arguments":""}}`,
			``,
			`data: {"type":"response.function_call_arguments.done","output_index":0,"name":"list_connections","arguments":" \t "}`,
			``,
			`data: {"type":"response.completed","response":{"id":"resp_delta_only","status":"completed","output":[]}}`,
			``,
		}, "\n")))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type:      "custom",
		APIFormat: "openai-responses",
		APIKey:    "sk-test",
		BaseURL:   server.URL + "/v1",
		Model:     "gpt-test",
	})
	if err != nil {
		t.Fatalf("create Responses provider: %v", err)
	}
	var toolCalls []ai.ToolCall
	done := false
	err = providerInstance.ChatStream(
		context.Background(),
		ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "List connections."}}},
		func(chunk ai.StreamChunk) {
			if len(chunk.ToolCalls) > 0 {
				toolCalls = append([]ai.ToolCall(nil), chunk.ToolCalls...)
			}
			done = done || chunk.Done
		},
	)
	if err != nil {
		t.Fatalf("blank delta-only tool arguments should remain compatible: %v", err)
	}
	if !done {
		t.Fatal("expected compatible delta-only tool call to emit Done")
	}
	if len(toolCalls) != 1 || toolCalls[0].Function.Arguments != `{}` {
		t.Fatalf("expected blank delta-only arguments to normalize to {}, got %#v", toolCalls)
	}
}

func TestOpenAIResponsesProviderChatWithStateNormalizesBlankCompletedToolArguments(t *testing.T) {
	for _, testCase := range openAIResponsesBlankToolArgumentsCases {
		t.Run(testCase.name, func(t *testing.T) {
			provider := newOpenAIResponsesToolArgumentsTestProvider(t, false, testCase.arguments)

			response, nextState, err := provider.ChatWithState(context.Background(), nil, ai.ChatRequest{
				Messages: []ai.Message{{Role: "user", Content: "List connections."}},
			})
			if err != nil {
				t.Fatalf("blank completed tool arguments should remain compatible: %v", err)
			}
			if response == nil || len(response.ToolCalls) != 1 {
				t.Fatalf("expected one normalized tool call, got %#v", response)
			}
			if got := response.ToolCalls[0].Function.Arguments; got != `{}` {
				t.Fatalf("expected blank response tool arguments to normalize to {}, got %q", got)
			}
			assertOpenAIResponsesToolArgumentsInState(t, nextState, `{}`)
		})
	}
}

func TestOpenAIResponsesProviderChatStreamWithStateNormalizesBlankCompletedToolArguments(t *testing.T) {
	for _, testCase := range openAIResponsesBlankToolArgumentsCases {
		t.Run(testCase.name, func(t *testing.T) {
			provider := newOpenAIResponsesToolArgumentsTestProvider(t, true, testCase.arguments)
			var toolCalls []ai.ToolCall
			done := false

			nextState, err := provider.ChatStreamWithState(context.Background(), nil, ai.ChatRequest{
				Messages: []ai.Message{{Role: "user", Content: "List connections."}},
			}, func(chunk ai.StreamChunk) {
				if len(chunk.ToolCalls) > 0 {
					toolCalls = append([]ai.ToolCall(nil), chunk.ToolCalls...)
				}
				done = done || chunk.Done
			})
			if err != nil {
				t.Fatalf("blank completed tool arguments should remain compatible: %v", err)
			}
			if !done {
				t.Fatal("expected compatible blank tool arguments to complete the stream")
			}
			if len(toolCalls) != 1 || toolCalls[0].Function.Arguments != `{}` {
				t.Fatalf("expected one normalized streamed tool call, got %#v", toolCalls)
			}
			assertOpenAIResponsesToolArgumentsInState(t, nextState, `{}`)
		})
	}
}

func newOpenAIResponsesToolArgumentsTestProvider(t *testing.T, stream bool, arguments string) *OpenAIResponsesProvider {
	t.Helper()
	response := map[string]any{
		"id":     "resp_tool_arguments",
		"status": "completed",
		"output": []any{map[string]any{
			"id":        "fc_execute_sql",
			"type":      "function_call",
			"status":    "completed",
			"call_id":   "call_execute_sql",
			"name":      "execute_sql",
			"arguments": arguments,
		}},
	}
	responseBody, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("encode completed response: %v", err)
	}
	contentType := "application/json"
	if stream {
		contentType = "text/event-stream"
		eventBody, err := json.Marshal(map[string]any{
			"type":     "response.completed",
			"response": response,
		})
		if err != nil {
			t.Fatalf("encode completed stream event: %v", err)
		}
		responseBody = append(append([]byte("data: "), eventBody...), '\n', '\n')
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", contentType)
		_, _ = w.Write(responseBody)
	}))
	t.Cleanup(server.Close)

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type:      "custom",
		APIFormat: "openai-responses",
		APIKey:    "sk-test",
		BaseURL:   server.URL + "/v1",
		Model:     "gpt-test",
	})
	if err != nil {
		t.Fatalf("create Responses provider: %v", err)
	}
	return providerInstance.(*OpenAIResponsesProvider)
}

func openAIResponsesToolArgumentsTestOldState() json.RawMessage {
	return json.RawMessage(`{"input":[{"type":"message","role":"user","content":"Previous."}]}`)
}

func assertOpenAIResponsesInvalidToolArgumentsError(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("expected invalid completed tool arguments to return an error")
	}
	for _, expected := range []string{"execute_sql", "call_execute_sql", "JSON object"} {
		if !strings.Contains(err.Error(), expected) {
			t.Fatalf("expected explicit tool-arguments error containing %q, got %q", expected, err.Error())
		}
	}
}

func assertOpenAIResponsesToolArgumentsInState(t *testing.T, state json.RawMessage, want string) {
	t.Helper()
	decoded, ok := decodeOpenAIResponsesSessionState(state)
	if !ok {
		t.Fatalf("expected valid Responses session state, got %s", state)
	}
	for _, rawItem := range decoded.Input {
		var item openAIResponsesOutputItem
		if err := json.Unmarshal(rawItem, &item); err != nil {
			continue
		}
		if item.Type == "function_call" && item.CallID == "call_execute_sql" {
			if item.Arguments != want {
				t.Fatalf("expected persisted tool arguments %q, got %q in state %s", want, item.Arguments, state)
			}
			return
		}
	}
	t.Fatalf("expected persisted function_call in state %s", state)
}
