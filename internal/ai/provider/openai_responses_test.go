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

type responsesRoundTripFunc func(*http.Request) (*http.Response, error)

func (fn responsesRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func TestOpenAIResponsesProviderGLM53UsesResponsesCompatibleEffortLevels(t *testing.T) {
	var received map[string]any
	transport := responsesRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			return nil, err
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"id":"glm","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}`)),
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Request:    r,
		}, nil
	})
	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "openai", APIFormat: "openai-responses", APIKey: "sk-test",
		BaseURL: "https://api.example.com/v1", Model: "z-ai/glm-5.3-free", ThinkingIntensity: "medium",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	provider := providerInstance.(*OpenAIResponsesProvider)
	provider.client = &http.Client{Transport: transport}
	if _, err := provider.Chat(context.Background(), ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "ping"}}}); err != nil {
		t.Fatalf("chat: %v", err)
	}
	reasoning, _ := received["reasoning"].(map[string]any)
	if reasoning["effort"] != "medium" {
		t.Fatalf("GLM-5.3 medium effort = %#v, want medium", reasoning["effort"])
	}

	provider.config.ThinkingIntensity = "max"
	received = nil
	if _, err := provider.Chat(context.Background(), ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "ping"}}}); err != nil {
		t.Fatalf("chat max: %v", err)
	}
	reasoning, _ = received["reasoning"].(map[string]any)
	if reasoning["effort"] != "xhigh" {
		t.Fatalf("GLM-5.3 max effort = %#v, want xhigh", reasoning["effort"])
	}
}

func TestOpenAIResponsesProviderChatUsesResponsesRequestAndParsesOutputItems(t *testing.T) {
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses" {
			t.Fatalf("expected /v1/responses, got %q", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sk-test" {
			t.Fatalf("expected bearer auth, got %q", got)
		}
		defer r.Body.Close()
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"id":"resp_1",
			"status":"completed",
			"output":[
				{"type":"reasoning","summary":[{"type":"summary_text","text":"inspect schema first"}]},
				{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Checking now."}]},
				{"type":"function_call","call_id":"call_schema","name":"inspect_table_schema","arguments":"{\"table\":\"orders\"}"}
			],
			"usage":{"input_tokens":12,"output_tokens":7,"total_tokens":19}
		}`))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type:              "custom",
		APIFormat:         "openai-responses",
		Name:              "Responses proxy",
		APIKey:            "sk-test",
		BaseURL:           server.URL + "/v1",
		Model:             "gpt-5.4",
		MaxTokens:         4096,
		Temperature:       0.2,
		ThinkingIntensity: "high",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}

	response, err := providerInstance.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{
			{Role: "system", Content: "You are a database assistant."},
			{Role: "user", Content: "Inspect orders", Images: []string{"data:image/png;base64,abc"}},
			{Role: "assistant", ToolCalls: []ai.ToolCall{{
				ID:   "call_previous",
				Type: "function",
				Function: ai.ToolCallFunction{
					Name:      "get_columns",
					Arguments: `{"table":"orders"}`,
				},
			}},
			},
			{Role: "tool", ToolCallID: "call_previous", Content: `{"columns":["id"]}`},
		},
		Tools: []ai.Tool{{
			Type: "function",
			Function: ai.ToolFunction{
				Name:        "inspect_table_schema",
				Description: "Inspect a table schema",
				Parameters: map[string]any{
					"type": "object",
				},
			},
		}},
		MaxTokens:   256,
		Temperature: 0.1,
	})
	if err != nil {
		t.Fatalf("chat: %v", err)
	}

	if received["model"] != "gpt-5.4" || received["store"] != false {
		t.Fatalf("unexpected request envelope: %#v", received)
	}
	if stream, present := received["stream"]; present && stream != false {
		t.Fatalf("expected non-stream request to omit stream or set it to false, got %#v", stream)
	}
	if received["max_output_tokens"] != float64(256) || received["temperature"] != 0.1 {
		t.Fatalf("unexpected generation options: %#v", received)
	}
	reasoning, _ := received["reasoning"].(map[string]any)
	if reasoning["effort"] != "high" || reasoning["summary"] != "detailed" {
		t.Fatalf("unexpected reasoning config: %#v", reasoning)
	}
	tools, _ := received["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("expected one tool, got %#v", received["tools"])
	}
	tool, _ := tools[0].(map[string]any)
	if tool["type"] != "function" || tool["name"] != "inspect_table_schema" || tool["function"] != nil {
		t.Fatalf("expected internally-tagged Responses tool, got %#v", tool)
	}
	inputJSON, _ := json.Marshal(received["input"])
	inputText := string(inputJSON)
	for _, expected := range []string{`"type":"input_image"`, `"type":"function_call"`, `"call_id":"call_previous"`, `"type":"function_call_output"`} {
		if !strings.Contains(inputText, expected) {
			t.Fatalf("expected input to contain %s, got %s", expected, inputText)
		}
	}

	if response.Content != "Checking now." || response.ReasoningContent != "inspect schema first" {
		t.Fatalf("unexpected response content: %#v", response)
	}
	if response.TokensUsed != (ai.TokenUsage{PromptTokens: 12, CompletionTokens: 7, TotalTokens: 19}) {
		t.Fatalf("unexpected usage: %#v", response.TokensUsed)
	}
	if len(response.ToolCalls) != 1 || response.ToolCalls[0].ID != "call_schema" || response.ToolCalls[0].Function.Name != "inspect_table_schema" {
		t.Fatalf("unexpected tool calls: %#v", response.ToolCalls)
	}
}

func TestOpenAIResponsesProviderDeepSeekUsesRootResponsesEndpointAndCompatibleRequest(t *testing.T) {
	var received map[string]any
	transport := responsesRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/responses" {
			return nil, fmt.Errorf("expected DeepSeek Responses endpoint /responses, got %q", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			return nil, err
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"id":"resp_deepseek","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"pong"}]}]}`)),
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Request:    r,
		}, nil
	})

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type:              "openai",
		APIFormat:         "openai-responses",
		APIKey:            "sk-test",
		BaseURL:           "https://api.deepseek.com/v1",
		Model:             "deepseek-v4-flash",
		ThinkingIntensity: "high",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	provider := providerInstance.(*OpenAIResponsesProvider)
	provider.client = &http.Client{Transport: transport}

	response, err := providerInstance.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping"}},
	})
	if err != nil {
		t.Fatalf("chat: %v", err)
	}
	if response.Content != "pong" {
		t.Fatalf("unexpected response: %#v", response)
	}
	if _, hasInclude := received["include"]; hasInclude {
		t.Fatalf("DeepSeek Responses request must not send include: %#v", received)
	}
	if _, hasStore := received["store"]; hasStore {
		t.Fatalf("DeepSeek Responses request must not send store: %#v", received)
	}
	reasoning, _ := received["reasoning"].(map[string]any)
	if reasoning["effort"] != "high" || reasoning["summary"] != nil {
		t.Fatalf("unexpected DeepSeek reasoning request: %#v", reasoning)
	}
}

func TestOpenAIResponsesProviderDeepSeekKeepsRootEndpointWithQueryOrTrailingSlash(t *testing.T) {
	for _, rawBaseURL := range []string{
		"https://api.deepseek.com/",
		"https://api.deepseek.com/v1/?ignored=true",
	} {
		t.Run(rawBaseURL, func(t *testing.T) {
			providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
				Type: "openai", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: rawBaseURL, Model: "deepseek-v4-flash",
			})
			if err != nil {
				t.Fatalf("create provider: %v", err)
			}
			if got := providerInstance.(*OpenAIResponsesProvider).baseURL; got != "https://api.deepseek.com" {
				t.Fatalf("expected DeepSeek root base URL, got %q", got)
			}
		})
	}
}

func TestOpenAIResponsesProviderDeepSeekParsesReasoningTextDelta(t *testing.T) {
	transport := responsesRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/responses" {
			return nil, fmt.Errorf("expected DeepSeek Responses endpoint /responses, got %q", r.URL.Path)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body: io.NopCloser(strings.NewReader(strings.Join([]string{
				`data: {"type":"response.reasoning_text.delta","delta":"Inspect schema. "}`,
				``,
				`data: {"type":"response.output_text.delta","delta":"Done."}`,
				``,
				`data: {"type":"response.completed","response":{"id":"resp_deepseek_stream","status":"completed"}}`,
				``,
			}, "\n"))),
			Header:  http.Header{"Content-Type": []string{"text/event-stream"}},
			Request: r,
		}, nil
	})

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "openai", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: "https://api.deepseek.com/v1", Model: "deepseek-v4-flash",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	providerInstance.(*OpenAIResponsesProvider).client = &http.Client{Transport: transport}

	var content, reasoning strings.Builder
	err = providerInstance.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "inspect"}},
	}, func(chunk ai.StreamChunk) {
		content.WriteString(chunk.Content)
		reasoning.WriteString(chunk.ReasoningContent)
	})
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	if content.String() != "Done." || reasoning.String() != "Inspect schema. " {
		t.Fatalf("unexpected DeepSeek stream: content=%q reasoning=%q", content.String(), reasoning.String())
	}
}

func TestBuildOpenAIResponsesInputDropsIncompleteToolCallHistory(t *testing.T) {
	callA := ai.ToolCall{ID: "call_a", Type: "function", Function: ai.ToolCallFunction{Name: "get_schema", Arguments: `{}`}}
	callB := ai.ToolCall{ID: "call_b", Type: "function", Function: ai.ToolCallFunction{Name: "get_rows", Arguments: `{}`}}
	items := buildOpenAIResponsesInput([]ai.Message{
		{Role: "user", Content: "inspect"},
		{Role: "assistant", ToolCalls: []ai.ToolCall{callA, callB}},
		{Role: "tool", ToolCallID: callA.ID, Content: `{"ok":true}`},
		{Role: "user", Content: "continue"},
	}, "https://api.deepseek.com")

	if len(items) != 2 || items[0].Role != "user" || items[1].Role != "user" {
		t.Fatalf("expected incomplete Responses tool-call turn to be removed, got %#v", items)
	}
}

func TestBuildOpenAIResponsesInputDropsStandaloneToolResultWithoutSessionState(t *testing.T) {
	items := buildOpenAIResponsesInput([]ai.Message{
		{Role: "user", Content: "inspect"},
		{Role: "tool", ToolCallID: "call_orphaned", Content: `{"ok":true}`},
		{Role: "user", Content: "continue"},
	}, "https://api.deepseek.com")

	if len(items) != 2 || items[0].Role != "user" || items[1].Role != "user" {
		t.Fatalf("expected standalone Responses tool result without state to be removed, got %#v", items)
	}
}

func TestBuildOpenAIResponsesInputKeepsOnlyStandaloneToolResultsBackedBySessionState(t *testing.T) {
	items := buildOpenAIResponsesInputWithToolCallIDs([]ai.Message{
		{Role: "tool", ToolCallID: "call_previous", Content: `{"columns":["id"]}`},
		{Role: "tool", ToolCallID: "call_orphaned", Content: `{"ok":true}`},
	}, "https://api.deepseek.com", map[string]struct{}{"call_previous": {}})

	if len(items) != 1 || items[0].Type != "function_call_output" || items[0].CallID != "call_previous" {
		t.Fatalf("expected only session-backed tool result to remain, got %#v", items)
	}
}
