package provider

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/ai"
)

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
			`data: {"type":"response.completed","response":{"id":"resp_stream","status":"completed","usage":{"input_tokens":5,"output_tokens":4,"total_tokens":9,"input_tokens_details":{"cached_tokens":2}}}}`,
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
	usage := chunks[len(chunks)-1].Usage
	if usage == nil || usage.PromptTokens != 5 || usage.CompletionTokens != 4 || usage.TotalTokens != 9 {
		t.Fatalf("expected final usage, got %#v", usage)
	}
	if usage.CachedTokens == nil || *usage.CachedTokens != 2 {
		t.Fatalf("expected cached usage, got %#v", usage.CachedTokens)
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
