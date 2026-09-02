package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/ai"
)

type responsesRoundTripFunc func(*http.Request) (*http.Response, error)

func (fn responsesRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
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
	if reasoning["effort"] != "high" || reasoning["summary"] != "auto" {
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

func TestOpenAIResponsesProviderChatStreamParsesTypedEvents(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses" {
			t.Fatalf("expected /v1/responses, got %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(strings.Join([]string{
			`data: {"type":"response.created","response":{"id":"resp_stream","status":"in_progress"}}`,
			``,
			`data: {"type":"response.reasoning_summary_text.delta","delta":"Need schema. "}`,
			``,
			`data: {"type":"response.output_text.delta","delta":"Checking "}`,
			``,
			`data: {"type":"response.output_text.delta","delta":"now."}`,
			``,
			`data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_columns","arguments":""}}`,
			``,
			`data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":1,"delta":"{\"table\":"}`,
			``,
			`data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":1,"delta":"\"orders\"}"}`,
			``,
			`data: {"type":"response.function_call_arguments.done","item_id":"fc_1","output_index":1,"arguments":"{\"table\":\"orders\"}"}`,
			``,
			`data: {"type":"response.completed","response":{"id":"resp_stream","status":"completed","usage":{"input_tokens":5,"output_tokens":4,"total_tokens":9}}}`,
			``,
		}, "\n")))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "custom", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "gpt-5.4",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}

	var chunks []ai.StreamChunk
	err = providerInstance.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "Inspect orders"}},
	}, func(chunk ai.StreamChunk) {
		chunks = append(chunks, chunk)
	})
	if err != nil {
		t.Fatalf("stream: %v", err)
	}

	var content, reasoning strings.Builder
	var toolCalls []ai.ToolCall
	for _, chunk := range chunks {
		content.WriteString(chunk.Content)
		reasoning.WriteString(chunk.ReasoningContent)
		if len(chunk.ToolCalls) > 0 {
			toolCalls = chunk.ToolCalls
		}
	}
	if content.String() != "Checking now." || reasoning.String() != "Need schema. " {
		t.Fatalf("unexpected streamed text: content=%q reasoning=%q chunks=%#v", content.String(), reasoning.String(), chunks)
	}
	if len(toolCalls) != 1 || toolCalls[0].ID != "call_1" || toolCalls[0].Function.Name != "get_columns" || toolCalls[0].Function.Arguments != `{"table":"orders"}` {
		t.Fatalf("unexpected streamed tool calls: %#v", toolCalls)
	}
	if len(chunks) == 0 || !chunks[len(chunks)-1].Done {
		t.Fatalf("expected final done chunk, got %#v", chunks)
	}
}

func TestOpenAIResponsesProviderChatStreamOutlivesHTTPClientTimeout(t *testing.T) {
	const clientTimeout = 50 * time.Millisecond
	attempts := 0
	transport := responsesRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		attempts++
		reader, writer := io.Pipe()
		go func() {
			defer writer.Close()
			_, _ = io.WriteString(writer, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"slow \"}\n\n")

			timer := time.NewTimer(3 * clientTimeout)
			defer timer.Stop()
			select {
			case <-timer.C:
				_, _ = io.WriteString(writer, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"done\"}\n\n")
				_, _ = io.WriteString(writer, "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_slow\",\"status\":\"completed\"}}\n\n")
			case <-req.Context().Done():
				_ = writer.CloseWithError(req.Context().Err())
			}
		}()

		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       reader,
			Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
			Request:    req,
		}, nil
	})

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type:      "custom",
		APIFormat: "openai-responses",
		APIKey:    "sk-test",
		BaseURL:   "https://provider.test/v1",
		Model:     "glm-test",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	provider := providerInstance.(*OpenAIResponsesProvider)
	provider.client = &http.Client{Transport: transport, Timeout: clientTimeout}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var content strings.Builder
	done := false
	err = provider.ChatStream(ctx, ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping"}},
	}, func(chunk ai.StreamChunk) {
		content.WriteString(chunk.Content)
		done = done || chunk.Done
	})
	if err != nil {
		t.Fatalf("slow stream: %v", err)
	}
	if content.String() != "slow done" || !done {
		t.Fatalf("chunks content=%q done=%t", content.String(), done)
	}
	if attempts != 1 {
		t.Fatalf("requests=%d, want 1 (no retry)", attempts)
	}
}

func TestOpenAIResponsesProviderChatStreamRespectsContextCancellation(t *testing.T) {
	transport := responsesRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		reader, writer := io.Pipe()
		go func() {
			_, _ = io.WriteString(writer, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"started\"}\n\n")
			<-req.Context().Done()
			_ = writer.CloseWithError(req.Context().Err())
		}()
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       reader,
			Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
			Request:    req,
		}, nil
	})

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type:      "custom",
		APIFormat: "openai-responses",
		APIKey:    "sk-test",
		BaseURL:   "https://provider.test/v1",
		Model:     "glm-test",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	provider := providerInstance.(*OpenAIResponsesProvider)
	provider.client = &http.Client{Transport: transport, Timeout: 50 * time.Millisecond}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	err = provider.ChatStream(ctx, ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping"}},
	}, func(chunk ai.StreamChunk) {
		if chunk.Content == "started" {
			cancel()
		}
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("stream error=%v, want context canceled", err)
	}
}

func TestOpenAIResponsesProviderChatStreamBoundsErrorBodyRead(t *testing.T) {
	const clientTimeout = 40 * time.Millisecond
	transport := responsesRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		reader, writer := io.Pipe()
		go func() {
			<-req.Context().Done()
			_ = writer.CloseWithError(req.Context().Err())
		}()
		return &http.Response{
			StatusCode:    http.StatusBadRequest,
			Body:          reader,
			ContentLength: -1,
			Header:        http.Header{"Content-Type": []string{"application/json"}},
			Request:       req,
		}, nil
	})

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type:      "custom",
		APIFormat: "openai-responses",
		APIKey:    "sk-test",
		BaseURL:   "https://provider.test/v1",
		Model:     "glm-test",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	provider := providerInstance.(*OpenAIResponsesProvider)
	provider.client = &http.Client{Transport: transport, Timeout: clientTimeout}

	ctx, cancel := context.WithTimeout(context.Background(), 10*clientTimeout)
	defer cancel()
	started := time.Now()
	err = provider.ChatStream(ctx, ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping"}},
	}, func(ai.StreamChunk) {})
	if err == nil || !strings.Contains(err.Error(), "error response body read timed out") {
		t.Fatalf("stream error=%v, want bounded error-body timeout", err)
	}
	if ctx.Err() != nil {
		t.Fatalf("outer context ended unexpectedly: %v", ctx.Err())
	}
	if elapsed := time.Since(started); elapsed > 5*clientTimeout {
		t.Fatalf("error body read returned after %s, want timeout near %s", elapsed, clientTimeout)
	}
}

func TestOpenAIResponsesProviderChatKeepsHTTPClientTimeout(t *testing.T) {
	const clientTimeout = 50 * time.Millisecond
	transport := responsesRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		reader, writer := io.Pipe()
		go func() {
			<-req.Context().Done()
			_ = writer.CloseWithError(req.Context().Err())
		}()
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       reader,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Request:    req,
		}, nil
	})

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type:      "custom",
		APIFormat: "openai-responses",
		APIKey:    "sk-test",
		BaseURL:   "https://provider.test/v1",
		Model:     "glm-test",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	provider := providerInstance.(*OpenAIResponsesProvider)
	provider.client = &http.Client{Transport: transport, Timeout: clientTimeout}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	started := time.Now()
	_, err = provider.Chat(ctx, ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping"}},
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("chat error=%v, want HTTP client timeout", err)
	}
	if ctx.Err() != nil {
		t.Fatalf("outer context ended unexpectedly: %v", ctx.Err())
	}
	if elapsed := time.Since(started); elapsed > 5*clientTimeout {
		t.Fatalf("chat timed out after %s, want client timeout near %s", elapsed, clientTimeout)
	}
}

func TestBuildOpenAIResponsesInputPreservesAssistantTextAsMessage(t *testing.T) {
	input := buildOpenAIResponsesInput([]ai.Message{
		{Role: "assistant", Content: "I will inspect the schema first."},
	}, "https://api.openai.com/v1")

	if len(input) != 1 {
		t.Fatalf("expected one assistant message item, got %#v", input)
	}
	if input[0].Type != "message" || input[0].Role != "assistant" || input[0].Content != "I will inspect the schema first." {
		t.Fatalf("unexpected assistant history item: %#v", input[0])
	}
}

func TestOpenAIResponsesProviderChatStreamFallsBackToCompletedOutput(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(`data: {"type":"response.completed","response":{"id":"resp_complete","status":"completed","output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"Use metadata."}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done."}]},{"type":"function_call","call_id":"call_complete","name":"get_columns","arguments":"{\"table\":\"orders\"}"}]}}

`))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "openai", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "gpt-test",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}

	var chunks []ai.StreamChunk
	err = providerInstance.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "Inspect orders"}},
	}, func(chunk ai.StreamChunk) {
		chunks = append(chunks, chunk)
	})
	if err != nil {
		t.Fatalf("stream: %v", err)
	}

	var content, reasoning strings.Builder
	var toolCalls []ai.ToolCall
	for _, chunk := range chunks {
		content.WriteString(chunk.Content)
		reasoning.WriteString(chunk.ReasoningContent)
		if len(chunk.ToolCalls) > 0 {
			toolCalls = chunk.ToolCalls
		}
	}
	if content.String() != "Done." || reasoning.String() != "Use metadata." {
		t.Fatalf("unexpected completed fallback chunks: %#v", chunks)
	}
	if len(toolCalls) != 1 || toolCalls[0].ID != "call_complete" || toolCalls[0].Function.Name != "get_columns" {
		t.Fatalf("unexpected completed fallback tool calls: %#v", toolCalls)
	}
	if len(chunks) == 0 || !chunks[len(chunks)-1].Done {
		t.Fatalf("expected completed event to finish stream: %#v", chunks)
	}
}

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

func TestOpenAIResponsesProviderChatReportsAPIAndEmptyOutputErrors(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{
			name: "api_error",
			body: `{"error":{"message":"permission denied"}}`,
			want: "permission denied",
		},
		{
			name: "empty_output",
			body: `{"id":"resp_empty","status":"completed","output":[]}`,
			want: "empty response",
		},
		{
			name: "incomplete_output",
			body: `{"id":"resp_incomplete","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"partial"}]}]}`,
			want: "max_output_tokens",
		},
		{
			name: "failed_output_with_code_only",
			body: `{"id":"resp_failed","status":"failed","error":{"code":"provider_overloaded"},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"must not be accepted"}]}]}`,
			want: "provider_overloaded",
		},
		{
			name: "completed_output_with_code_only_error",
			body: `{"id":"resp_failed","status":"completed","error":{"code":"provider_overloaded"},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"must not be accepted"}]}]}`,
			want: "provider_overloaded",
		},
		{
			name: "cancelled_output",
			body: `{"id":"resp_cancelled","status":"cancelled","error":{"code":"user_cancelled"},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"must not be accepted"}]}]}`,
			want: "user_cancelled",
		},
		{
			name: "unexpected_terminal_status",
			body: `{"id":"resp_in_progress","status":"in_progress","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"must not be accepted"}]}]}`,
			want: "in_progress",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(tt.body))
			}))
			defer server.Close()

			providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
				Type: "custom", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "gpt-test",
			})
			if err != nil {
				t.Fatalf("create provider: %v", err)
			}

			_, err = providerInstance.Chat(context.Background(), ai.ChatRequest{
				Messages: []ai.Message{{Role: "user", Content: "ping"}},
			})
			if err == nil || !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(tt.want)) {
				t.Fatalf("expected error containing %q, got %v", tt.want, err)
			}
		})
	}
}

func TestOpenAIResponsesProviderChatStreamRejectsInvalidTerminalEvent(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{
			name: "failed",
			body: `{"type":"response.completed","response":{"id":"resp_failed","status":"failed","error":{"code":"provider_overloaded"},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"must not be accepted"}]}]}}`,
			want: "provider_overloaded",
		},
		{
			name: "incomplete",
			body: `{"type":"response.completed","response":{"id":"resp_incomplete","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"partial"}]}]}}`,
			want: "max_output_tokens",
		},
		{
			name: "cancelled",
			body: `{"type":"response.completed","response":{"id":"resp_cancelled","status":"cancelled","error":{"code":"user_cancelled"},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"must not be accepted"}]}]}}`,
			want: "user_cancelled",
		},
		{
			name: "canceled",
			body: `{"type":"response.completed","response":{"id":"resp_canceled","status":"canceled","error":{"code":"user_canceled"},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"must not be accepted"}]}]}}`,
			want: "user_canceled",
		},
		{
			name: "unexpected_terminal_status",
			body: `{"type":"response.completed","response":{"id":"resp_in_progress","status":"in_progress","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"must not be accepted"}]}]}}`,
			want: "in_progress",
		},
		{
			name: "completed_with_top_level_message",
			body: `{"type":"response.completed","message":"upstream response failed","response":{"id":"resp_completed","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"must not be accepted"}]}]}}`,
			want: "upstream response failed",
		},
		{
			name: "completed_with_top_level_code",
			body: `{"type":"response.completed","code":"provider_overloaded","response":{"id":"resp_completed","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"must not be accepted"}]}]}}`,
			want: "provider_overloaded",
		},
		{
			name: "completed_with_top_level_error",
			body: `{"type":"response.completed","error":{"message":"invalid tool output"},"response":{"id":"resp_completed","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"must not be accepted"}]}]}}`,
			want: "invalid tool output",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = w.Write([]byte("data: " + tt.body + "\n\n"))
			}))
			defer server.Close()

			providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
				Type: "custom", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "gpt-test",
			})
			if err != nil {
				t.Fatalf("create provider: %v", err)
			}

			oldState := json.RawMessage(`{"input":[{"type":"message","role":"user","content":"previous"}]}`)
			done := false
			nextState, err := providerInstance.(*OpenAIResponsesProvider).ChatStreamWithState(
				context.Background(), oldState, ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "ping"}}},
				func(chunk ai.StreamChunk) { done = done || chunk.Done },
			)
			if err == nil || !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(tt.want)) {
				t.Fatalf("expected stream error containing %q, got %v", tt.want, err)
			}
			if done {
				t.Fatal("non-completed terminal status emitted Done")
			}
			if string(nextState) != string(oldState) {
				t.Fatalf("terminal failure advanced provider state: old=%s next=%s", oldState, nextState)
			}
		})
	}
}

func TestOpenAIResponsesProviderChatStreamReportsFailedAndErrorEvents(t *testing.T) {
	tests := []struct {
		name  string
		event string
		want  string
	}{
		{
			name:  "response_failed",
			event: `data: {"type":"response.failed","response":{"id":"resp_failed","status":"failed","error":{"message":"rate limited"}}}`,
			want:  "rate limited",
		},
		{
			name:  "response_failed_top_level_error",
			event: `data: {"type":"response.failed","error":{"code":"invalid_request_error","message":"invalid tool output"}}`,
			want:  "invalid tool output",
		},
		{
			name:  "response_failed_top_level_message_before_nested_code",
			event: `data: {"type":"response.failed","message":"request input is invalid","response":{"status":"failed","error":{"code":"server_error"}}}`,
			want:  "request input is invalid",
		},
		{
			name:  "response_failed_nested_code_only",
			event: `data: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error"}}}`,
			want:  "server_error",
		},
		{
			name:  "response_failed_top_level_error_code_only",
			event: `data: {"type":"response.failed","error":{"code":"provider_overloaded"}}`,
			want:  "provider_overloaded",
		},
		{
			name:  "response_failed_top_level_code_only",
			event: `data: {"type":"response.failed","code":"response_validation_failed"}`,
			want:  "response_validation_failed",
		},
		{
			name:  "response_failed_top_level_error_string",
			event: `data: {"type":"response.failed","error":"provider rejected the response"}`,
			want:  "provider rejected the response",
		},
		{
			name:  "response_failed_nested_error_string",
			event: `data: {"type":"response.failed","response":{"status":"failed","error":"provider overloaded"}}`,
			want:  "provider overloaded",
		},
		{
			name:  "response_failed_blank_details_use_fallback",
			event: `data: {"type":"response.failed","message":"  ","code":"\t","error":{"message":"\n","code":" "},"response":{"status":"failed","error":{"message":" ","code":"  "}}}`,
			want:  "OpenAI Responses request failed",
		},
		{
			name:  "error_event",
			event: `data: {"type":"error","code":"server_error","message":"upstream unavailable"}`,
			want:  "upstream unavailable",
		},
		{
			name:  "error_event_code_only",
			event: `data: {"type":"error","code":"gateway_timeout"}`,
			want:  "gateway_timeout",
		},
		{
			name:  "response_incomplete",
			event: `data: {"type":"response.incomplete","response":{"id":"resp_incomplete","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}`,
			want:  "max_output_tokens",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = w.Write([]byte(tt.event + "\n\n"))
			}))
			defer server.Close()

			providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
				Type: "custom", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "gpt-test",
			})
			if err != nil {
				t.Fatalf("create provider: %v", err)
			}

			err = providerInstance.ChatStream(context.Background(), ai.ChatRequest{
				Messages: []ai.Message{{Role: "user", Content: "ping"}},
			}, func(ai.StreamChunk) {})
			if err == nil || !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(tt.want)) {
				t.Fatalf("expected stream error containing %q, got %v", tt.want, err)
			}
		})
	}
}

func TestOpenAIResponsesProviderChatRetriesWithoutToolsOnHTTP400(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read request: %v", err)
		}
		defer r.Body.Close()

		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if _, hasTools := payload["tools"]; hasTools {
			http.Error(w, `{"error":{"message":"tools unsupported"}}`, http.StatusBadRequest)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"id":"resp_without_tools",
			"status":"completed",
			"output":[
				{"type":"message","role":"assistant","content":[{"type":"output_text","text":"pong"}]}
			],
			"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}
		}`))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "custom", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "gpt-test",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}

	response, err := providerInstance.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping"}},
		Tools: []ai.Tool{{
			Type: "function",
			Function: ai.ToolFunction{
				Name:       "inspect_table_schema",
				Parameters: map[string]any{"type": "object"},
			},
		}},
	})
	if err != nil {
		t.Fatalf("expected tools fallback to succeed, got %v", err)
	}
	if requestCount != 2 {
		t.Fatalf("expected one retry without unsupported tools, got %d requests", requestCount)
	}
	if response.Content != "pong" {
		t.Fatalf("unexpected fallback response: %#v", response)
	}
}

func TestOpenAIResponsesProviderChatRetriesWithoutUnsupportedIncludeOnHTTP400(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		defer r.Body.Close()
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if _, hasInclude := payload["include"]; hasInclude {
			http.Error(w, `{"error":{"message":"include unsupported"}}`, http.StatusBadRequest)
			return
		}
		if _, hasTools := payload["tools"]; !hasTools {
			t.Fatalf("expected include fallback to preserve tools, got %#v", payload)
		}
		inputJSON, _ := json.Marshal(payload["input"])
		if !strings.Contains(string(inputJSON), `"type":"input_image"`) {
			t.Fatalf("expected include fallback to preserve images, got %s", inputJSON)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"resp_without_include","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"pong"}]}]}`))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "custom", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "gpt-test",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	response, err := providerInstance.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping", Images: []string{"data:image/png;base64,abc"}}},
		Tools: []ai.Tool{{
			Type: "function",
			Function: ai.ToolFunction{
				Name:       "inspect_table_schema",
				Parameters: map[string]any{"type": "object"},
			},
		}},
	})
	if err != nil {
		t.Fatalf("expected include fallback to succeed, got %v", err)
	}
	if response.Content != "pong" || requestCount != 2 {
		t.Fatalf("unexpected include fallback result: response=%#v requests=%d", response, requestCount)
	}
}

func TestOpenAIResponsesProviderChatDoesNotDropToolsForUnrelatedClientError(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		defer r.Body.Close()

		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if _, hasTools := payload["tools"]; !hasTools {
			t.Fatalf("tools were removed from retry request: %#v", payload)
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"Invalid JSON data: input did not match any variant of ResponseInput"}}`))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "custom", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "glm-test",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}

	_, err = providerInstance.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "continue"}},
		Tools: []ai.Tool{{
			Type: "function",
			Function: ai.ToolFunction{
				Name:       "execute_sql",
				Parameters: map[string]any{"type": "object"},
			},
		}},
	})
	if err == nil || !strings.Contains(err.Error(), "Invalid JSON data") {
		t.Fatalf("expected original input error, got %v", err)
	}
	if requestCount != 1 {
		t.Fatalf("requests=%d, want 1 (unrelated client errors must not trigger compatibility fallback)", requestCount)
	}
}

func TestOpenAIResponsesProviderChatDoesNotDropToolsForNestedSchemaJSONPointer(t *testing.T) {
	tests := []struct {
		name    string
		message string
	}{
		{
			name:    "relative JSON pointer",
			message: `unexpected field: tools/0/parameters/properties/sql/nullable`,
		},
		{
			name:    "fragment JSON pointer",
			message: `unexpected field: #/tools/0/parameters/properties/sql/nullable`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			requestCount := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requestCount++
				defer r.Body.Close()

				var payload map[string]any
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Fatalf("decode request: %v", err)
				}
				if _, hasTools := payload["tools"]; !hasTools {
					t.Fatalf("tools were removed from retry request: %#v", payload)
				}

				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnprocessableEntity)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"error": map[string]any{"message": tt.message},
				})
			}))
			defer server.Close()

			providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
				Type: "custom", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "glm-test",
			})
			if err != nil {
				t.Fatalf("create provider: %v", err)
			}

			_, err = providerInstance.Chat(context.Background(), ai.ChatRequest{
				Messages: []ai.Message{{Role: "user", Content: "continue"}},
				Tools: []ai.Tool{{
					Type: "function",
					Function: ai.ToolFunction{
						Name:       "execute_sql",
						Parameters: map[string]any{"type": "object"},
					},
				}},
			})
			if err == nil || !strings.Contains(err.Error(), tt.message) {
				t.Fatalf("expected original nested schema error, got %v", err)
			}
			if requestCount != 1 {
				t.Fatalf("requests=%d, want 1 (nested schema errors must not trigger tools fallback)", requestCount)
			}
		})
	}
}

func TestOpenAIResponsesUnsupportedCapabilityErrorClassification(t *testing.T) {
	tests := []struct {
		name string
		err  error
		is   func(error) bool
		want bool
	}{
		{
			name: "tools explicitly unsupported on 400",
			err:  fmt.Errorf("OpenAI Responses API returned error (HTTP 400): tools unsupported"),
			is:   isOpenAIResponsesUnsupportedToolsError,
			want: true,
		},
		{
			name: "function calling unsupported on 422",
			err:  fmt.Errorf("OpenAI Responses API returned error (HTTP 422): model does not support function calling"),
			is:   isOpenAIResponsesUnsupportedToolsError,
			want: true,
		},
		{
			name: "include unknown parameter",
			err:  fmt.Errorf("OpenAI Responses API returned error (HTTP 400): unknown parameter: include"),
			is:   isOpenAIResponsesUnsupportedIncludeError,
			want: true,
		},
		{
			name: "invalid response input is unrelated",
			err:  fmt.Errorf("OpenAI Responses API returned error (HTTP 400): input did not match any variant of ResponseInput"),
			is:   isOpenAIResponsesUnsupportedToolsError,
			want: false,
		},
		{
			name: "invalid tools schema is not unsupported",
			err:  fmt.Errorf("OpenAI Responses API returned error (HTTP 422): invalid tools schema"),
			is:   isOpenAIResponsesUnsupportedToolsError,
			want: false,
		},
		{
			name: "nested tools schema unexpected field is not unsupported",
			err:  fmt.Errorf(`OpenAI Responses API returned error (HTTP 422): tools[0].parameters: unexpected field "nullable"`),
			is:   isOpenAIResponsesUnsupportedToolsError,
			want: false,
		},
		{
			name: "nested tools schema path separated by whitespace is not unsupported",
			err:  fmt.Errorf(`OpenAI Responses API returned error (HTTP 422): unexpected field: tools [0].parameters.nullable`),
			is:   isOpenAIResponsesUnsupportedToolsError,
			want: false,
		},
		{
			name: "nested dotted tools path separated by whitespace is not unsupported",
			err:  fmt.Errorf(`OpenAI Responses API returned error (HTTP 422): unexpected field: tools .0.parameters.nullable`),
			is:   isOpenAIResponsesUnsupportedToolsError,
			want: false,
		},
		{
			name: "nested tools schema value not allowed is not unsupported",
			err:  fmt.Errorf(`OpenAI Responses API returned error (HTTP 400): tools[0].parameters.properties.sql: value is not allowed`),
			is:   isOpenAIResponsesUnsupportedToolsError,
			want: false,
		},
		{
			name: "nested tools schema relative JSON pointer is not unsupported",
			err:  fmt.Errorf(`OpenAI Responses API returned error (HTTP 422): unexpected field: tools/0/parameters/properties/sql/nullable`),
			is:   isOpenAIResponsesUnsupportedToolsError,
			want: false,
		},
		{
			name: "nested tools schema fragment JSON pointer is not unsupported",
			err:  fmt.Errorf(`OpenAI Responses API returned error (HTTP 422): unexpected field: #/tools/0/parameters/properties/sql/nullable`),
			is:   isOpenAIResponsesUnsupportedToolsError,
			want: false,
		},
		{
			name: "unsupported response input item is not unsupported tools",
			err:  fmt.Errorf("OpenAI Responses API returned error (HTTP 400): unsupported ResponseInput item type function_call"),
			is:   isOpenAIResponsesUnsupportedToolsError,
			want: false,
		},
		{
			name: "404 is not a compatibility fallback",
			err:  fmt.Errorf("OpenAI Responses API returned error (HTTP 404): tools unsupported"),
			is:   isOpenAIResponsesUnsupportedToolsError,
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.is(tt.err); got != tt.want {
				t.Fatalf("classification=%t, want %t for %v", got, tt.want, tt.err)
			}
		})
	}
}

func TestOpenAIResponsesProviderStreamWithoutCompletedReturnsErrorAndPreservesSessionState(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "openai", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "gpt-test",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	sessionProvider := providerInstance.(SessionStreamProvider)
	oldState := json.RawMessage(`{"input":[{"type":"message","role":"user","content":"old"}]}`)
	nextState, err := sessionProvider.ChatStreamWithState(context.Background(), oldState, ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "new"}},
	}, func(ai.StreamChunk) {})
	if err == nil || !strings.Contains(err.Error(), "response.completed") {
		t.Fatalf("expected missing response.completed error, got %v", err)
	}
	if string(nextState) != string(oldState) {
		t.Fatalf("expected failed stream to preserve old state, got %s", nextState)
	}
}

func TestOpenAIResponsesProviderEmptyCompletedResponseReturnsErrorAndPreservesSessionState(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_empty\",\"status\":\"completed\",\"output\":[]}}\n\n"))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "openai", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "gpt-test",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	sessionProvider := providerInstance.(SessionStreamProvider)
	oldState := json.RawMessage(`{"input":[{"type":"message","role":"user","content":"old"}]}`)
	nextState, err := sessionProvider.ChatStreamWithState(context.Background(), oldState, ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "new"}},
	}, func(ai.StreamChunk) {})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "empty response") {
		t.Fatalf("expected empty completed response error, got %v", err)
	}
	if string(nextState) != string(oldState) {
		t.Fatalf("expected empty completed response to preserve old state, got %s", nextState)
	}
}

func TestOpenAIResponsesProviderUsesConfiguredMaxOutputTokens(t *testing.T) {
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"resp_1","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"pong"}]}]}`))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "openai", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "gpt-test", MaxTokens: 321,
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	if _, err := providerInstance.Chat(context.Background(), ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "ping"}}}); err != nil {
		t.Fatalf("chat: %v", err)
	}
	if received["max_output_tokens"] != float64(321) {
		t.Fatalf("expected configured max_output_tokens, got %#v", received["max_output_tokens"])
	}
}

func TestProviderFactoriesSelectOpenAIResponsesProtocol(t *testing.T) {
	config := ai.ProviderConfig{
		Type: "custom", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: "https://api.example.com/v1", Model: "gpt-test",
	}
	customProvider, err := NewCustomProvider(config)
	if err != nil {
		t.Fatalf("create custom provider: %v", err)
	}
	custom, ok := customProvider.(*CustomProvider)
	if !ok {
		t.Fatalf("expected CustomProvider, got %T", customProvider)
	}
	if _, ok := custom.inner.(*OpenAIResponsesProvider); !ok {
		t.Fatalf("expected OpenAIResponsesProvider inner, got %T", custom.inner)
	}

	directProvider, err := NewProvider(ai.ProviderConfig{
		Type: "openai", APIFormat: "openai-responses", APIKey: "sk-test", Model: "gpt-test",
	})
	if err != nil {
		t.Fatalf("create direct provider: %v", err)
	}
	if _, ok := directProvider.(*OpenAIResponsesProvider); !ok {
		t.Fatalf("expected direct OpenAIResponsesProvider, got %T", directProvider)
	}
}
