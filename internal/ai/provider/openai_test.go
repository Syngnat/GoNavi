package provider

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/ai"
)

type openAIRoundTripFunc func(*http.Request) (*http.Response, error)

func (fn openAIRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func TestOpenAIHTTPClientSeparatesStreamBodyAndResponseHeaderTimeouts(t *testing.T) {
	client := newOpenAIHTTPClient()
	if client.Timeout != openAIHTTPTimeout {
		t.Fatalf("non-stream client timeout = %s, want %s", client.Timeout, openAIHTTPTimeout)
	}
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport type = %T, want *http.Transport", client.Transport)
	}
	if transport.ResponseHeaderTimeout != openAIHTTPTimeout {
		t.Fatalf("response header timeout = %s, want %s", transport.ResponseHeaderTimeout, openAIHTTPTimeout)
	}

	streamClient := openAIHTTPClientForRequest(client, true)
	if streamClient == client {
		t.Fatal("stream client must be a shallow copy so its timeout cannot mutate non-stream requests")
	}
	if streamClient.Timeout != 0 {
		t.Fatalf("stream client timeout = %s, want 0 to avoid bounding SSE body reads", streamClient.Timeout)
	}
	if streamClient.Transport != client.Transport {
		t.Fatal("stream client must preserve the transport and its response-header/connect limits")
	}

	if got := openAIHTTPClientForRequest(client, false); got != client {
		t.Fatal("non-stream request must retain the original client timeout")
	}
}

func TestNormalizeOpenAICompatibleBaseURL(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "empty uses default openai base url",
			raw:  "",
			want: "https://api.openai.com/v1",
		},
		{
			name: "domain only appends v1",
			raw:  "https://api.openai.com",
			want: "https://api.openai.com/v1",
		},
		{
			name: "keeps existing v1 suffix",
			raw:  "https://api.deepseek.com/v1",
			want: "https://api.deepseek.com/v1",
		},
		{
			name: "keeps dashscope compatible mode path",
			raw:  "https://dashscope.aliyuncs.com/compatible-mode/v1",
			want: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		},
		{
			name: "keeps zhipu v4 path",
			raw:  "https://open.bigmodel.cn/api/paas/v4",
			want: "https://open.bigmodel.cn/api/paas/v4",
		},
		{
			name: "keeps volcengine ark v3 path",
			raw:  "https://ark.cn-beijing.volces.com/api/v3",
			want: "https://ark.cn-beijing.volces.com/api/v3",
		},
		{
			name: "keeps volcengine coding plan v3 path",
			raw:  "https://ark.cn-beijing.volces.com/api/coding/v3",
			want: "https://ark.cn-beijing.volces.com/api/coding/v3",
		},
		{
			name: "strips chat completions suffix before normalizing",
			raw:  "https://api.openai.com/v1/chat/completions",
			want: "https://api.openai.com/v1",
		},
		{
			name: "strips responses suffix before normalizing",
			raw:  "https://api.openai.com/v1/responses",
			want: "https://api.openai.com/v1",
		},
		{
			name: "strips models suffix before normalizing",
			raw:  "https://ark.cn-beijing.volces.com/api/coding/v3/models",
			want: "https://ark.cn-beijing.volces.com/api/coding/v3",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := NormalizeOpenAICompatibleBaseURL(tt.raw); got != tt.want {
				t.Fatalf("expected normalized base url %q, got %q", tt.want, got)
			}
		})
	}
}

func TestResolveOpenAICompatibleEndpoint(t *testing.T) {
	got := ResolveOpenAICompatibleEndpoint("https://ark.cn-beijing.volces.com/api/coding/v3/models", "chat/completions")
	want := "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions"
	if got != want {
		t.Fatalf("expected endpoint %q, got %q", want, got)
	}
}

func TestOpenAIProvider_Validate_MissingAPIKey(t *testing.T) {
	p, err := NewOpenAIProvider(ai.ProviderConfig{Type: "openai", Model: "gpt-4o"})
	if err != nil {
		t.Fatalf("unexpected constructor error: %v", err)
	}
	if err := p.Validate(); err == nil {
		t.Fatal("expected validation error for missing API key")
	}
}

func TestOpenAIProvider_Validate_Valid(t *testing.T) {
	p, err := NewOpenAIProvider(ai.ProviderConfig{
		Type: "openai", APIKey: "sk-test-key", Model: "gpt-4o",
	})
	if err != nil {
		t.Fatalf("unexpected constructor error: %v", err)
	}
	if err := p.Validate(); err != nil {
		t.Fatalf("unexpected validation error: %v", err)
	}
}

func TestOpenAIProvider_Name_Custom(t *testing.T) {
	p, err := NewOpenAIProvider(ai.ProviderConfig{
		Type: "openai", Name: "My OpenAI", APIKey: "sk-test", Model: "gpt-4o",
	})
	if err != nil {
		t.Fatalf("unexpected constructor error: %v", err)
	}
	if p.Name() != "My OpenAI" {
		t.Fatalf("expected name 'My OpenAI', got '%s'", p.Name())
	}
}

func TestOpenAIProvider_Name_Default(t *testing.T) {
	p, err := NewOpenAIProvider(ai.ProviderConfig{
		Type: "openai", APIKey: "sk-test", Model: "gpt-4o",
	})
	if err != nil {
		t.Fatalf("unexpected constructor error: %v", err)
	}
	if p.Name() != "OpenAI" {
		t.Fatalf("expected default name 'OpenAI', got '%s'", p.Name())
	}
}

func TestOpenAIProvider_DefaultBaseURL(t *testing.T) {
	p, _ := NewOpenAIProvider(ai.ProviderConfig{
		Type: "openai", APIKey: "sk-test", Model: "gpt-4o",
	})
	op := p.(*OpenAIProvider)
	if op.baseURL != "https://api.openai.com/v1" {
		t.Fatalf("expected default base URL, got '%s'", op.baseURL)
	}
}

func TestOpenAIProvider_CustomBaseURL(t *testing.T) {
	p, err := NewOpenAIProvider(ai.ProviderConfig{
		Type: "openai", APIKey: "sk-test", BaseURL: "https://my-proxy.com/v1", Model: "gpt-4o",
	})
	if err != nil {
		t.Fatalf("unexpected constructor error: %v", err)
	}
	op := p.(*OpenAIProvider)
	if op.baseURL != "https://my-proxy.com/v1" {
		t.Fatalf("expected custom base URL, got '%s'", op.baseURL)
	}
}

func TestOpenAIProvider_RejectsMissingModel(t *testing.T) {
	_, err := NewOpenAIProvider(ai.ProviderConfig{
		Type: "openai", APIKey: "sk-test",
	})
	if err == nil {
		t.Fatal("expected constructor error for missing model")
	}
}

func TestOpenAIProvider_DefaultMaxTokens(t *testing.T) {
	p, err := NewOpenAIProvider(ai.ProviderConfig{
		Type: "openai", APIKey: "sk-test", Model: "gpt-4o",
	})
	if err != nil {
		t.Fatalf("unexpected constructor error: %v", err)
	}
	op := p.(*OpenAIProvider)
	if op.config.MaxTokens != 4096 {
		t.Fatalf("expected default max tokens 4096, got %d", op.config.MaxTokens)
	}
}

func TestOpenAIProviderChatUsesRequestMaxTokens(t *testing.T) {
	var received openAIChatRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatalf("decode request body failed: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"pong"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIProvider(ai.ProviderConfig{
		Type:        "openai",
		APIKey:      "sk-test",
		BaseURL:     server.URL,
		Model:       "gpt-chat",
		MaxTokens:   4096,
		Temperature: 0.7,
	})
	if err != nil {
		t.Fatalf("create provider failed: %v", err)
	}

	_, err = providerInstance.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{
			Role:    "user",
			Content: "ping",
		}},
		MaxTokens:   192,
		Temperature: 0.1,
	})
	if err != nil {
		t.Fatalf("chat failed: %v", err)
	}
	if received.MaxTokens != 192 {
		t.Fatalf("expected request max_tokens 192, got %d", received.MaxTokens)
	}
	if received.Temperature != 0.1 {
		t.Fatalf("expected request temperature 0.1, got %f", received.Temperature)
	}
	if received.Model != "gpt-chat" {
		t.Fatalf("expected configured model, got %q", received.Model)
	}
}

func TestOpenAIProviderChatMovesSystemMessagesToRequestPrefix(t *testing.T) {
	var received openAIChatRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatalf("decode request body failed: %v", err)
		}

		seenNonSystemMessage := false
		for _, message := range received.Messages {
			if message.Role == "system" {
				if seenNonSystemMessage {
					http.Error(w, `{"error":{"message":"System message must be at the beginning."}}`, http.StatusBadRequest)
					return
				}
				continue
			}
			seenNonSystemMessage = true
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"pong"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIProvider(ai.ProviderConfig{
		Type:    "openai",
		APIKey:  "sk-test",
		BaseURL: server.URL,
		Model:   "gpt-chat",
	})
	if err != nil {
		t.Fatalf("create provider failed: %v", err)
	}

	_, err = providerInstance.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{
			{Role: "user", Content: "first question"},
			{Role: "system", Content: "follow the product rules"},
			{Role: "assistant", Content: "first answer"},
			{Role: "system", Content: "follow the workspace rules"},
			{Role: "user", Content: "next question"},
		},
	})
	if err != nil {
		t.Fatalf("chat should normalize system message ordering, got %v", err)
	}

	gotRoles := make([]string, len(received.Messages))
	for index, message := range received.Messages {
		gotRoles[index] = message.Role
	}
	wantRoles := []string{"system", "system", "user", "assistant", "user"}
	if len(gotRoles) != len(wantRoles) {
		t.Fatalf("expected roles %v, got %v", wantRoles, gotRoles)
	}
	for index, want := range wantRoles {
		if gotRoles[index] != want {
			t.Fatalf("expected roles %v, got %v", wantRoles, gotRoles)
		}
	}
}

func TestOpenAIProviderChatDropsCompleteToolCallTurnWithMalformedArguments(t *testing.T) {
	var received openAIChatRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatalf("decode request body failed: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"pong"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIProvider(ai.ProviderConfig{
		Type:    "openai",
		APIKey:  "sk-test",
		BaseURL: server.URL,
		Model:   "gpt-chat",
	})
	if err != nil {
		t.Fatalf("create provider failed: %v", err)
	}

	_, err = providerInstance.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{
			{Role: "user", Content: "Inspect the connection."},
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
		},
	})
	if err != nil {
		t.Fatalf("chat failed: %v", err)
	}

	if len(received.Messages) != 2 {
		t.Fatalf("expected malformed tool-call turn to be removed, got %#v", received.Messages)
	}
	if received.Messages[0].Role != "user" || received.Messages[0].Content != "Inspect the connection." ||
		received.Messages[1].Role != "user" || received.Messages[1].Content != "Continue." {
		t.Fatalf("expected surrounding user messages to remain, got %#v", received.Messages)
	}
}

func TestOpenAIProviderChatNormalizesBlankToolArgumentsToEmptyObject(t *testing.T) {
	var received openAIChatRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatalf("decode request body failed: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"pong"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIProvider(ai.ProviderConfig{
		Type:    "openai",
		APIKey:  "sk-test",
		BaseURL: server.URL,
		Model:   "gpt-chat",
	})
	if err != nil {
		t.Fatalf("create provider failed: %v", err)
	}

	messages := []ai.Message{
		{
			Role: "assistant",
			ToolCalls: []ai.ToolCall{{
				ID:   "call_no_args",
				Type: "function",
				Function: ai.ToolCallFunction{
					Name:      "list_connections",
					Arguments: " \t\n ",
				},
			}},
		},
		{Role: "tool", ToolCallID: "call_no_args", Content: `{"connections":[]}`},
	}
	_, err = providerInstance.Chat(context.Background(), ai.ChatRequest{Messages: messages})
	if err != nil {
		t.Fatalf("chat failed: %v", err)
	}

	if len(received.Messages) != 2 || len(received.Messages[0].ToolCalls) != 1 {
		t.Fatalf("expected blank-argument tool-call turn to remain, got %#v", received.Messages)
	}
	if got := received.Messages[0].ToolCalls[0].Function.Arguments; got != `{}` {
		t.Fatalf("expected blank tool arguments to be normalized to {}, got %q", got)
	}
	if got := messages[0].ToolCalls[0].Function.Arguments; got != " \t\n " {
		t.Fatalf("expected request history to remain unmodified, got arguments %q", got)
	}
}

func TestOpenAIProviderChatStreamMovesSystemMessagesToRequestPrefix(t *testing.T) {
	var received openAIChatRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatalf("decode request body failed: %v", err)
		}

		seenNonSystemMessage := false
		for _, message := range received.Messages {
			if message.Role == "system" {
				if seenNonSystemMessage {
					http.Error(w, `{"error":{"message":"System message must be at the beginning."}}`, http.StatusBadRequest)
					return
				}
				continue
			}
			seenNonSystemMessage = true
		}

		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"pong\"}}]}\n\ndata: [DONE]\n\n"))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIProvider(ai.ProviderConfig{
		Type:    "openai",
		APIKey:  "sk-test",
		BaseURL: server.URL,
		Model:   "gpt-chat",
	})
	if err != nil {
		t.Fatalf("create provider failed: %v", err)
	}

	var response string
	err = providerInstance.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{
			{Role: "user", Content: "first question"},
			{Role: "system", Content: "follow the product rules"},
		},
	}, func(chunk ai.StreamChunk) {
		response += chunk.Content
	})
	if err != nil {
		t.Fatalf("chat stream should normalize system message ordering, got %v", err)
	}
	if response != "pong" {
		t.Fatalf("expected streamed content pong, got %q", response)
	}
	if len(received.Messages) != 2 || received.Messages[0].Role != "system" || received.Messages[1].Role != "user" {
		t.Fatalf("expected system message before user message, got %#v", received.Messages)
	}
}

func TestOpenAIProviderChatStreamOutlivesHTTPClientTimeout(t *testing.T) {
	const clientTimeout = 50 * time.Millisecond
	attempts := 0
	transport := openAIRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		attempts++
		reader, writer := io.Pipe()
		go func() {
			defer writer.Close()
			_, _ = io.WriteString(writer, "data: {\"choices\":[{\"delta\":{\"content\":\"slow \"}}]}\n\n")

			timer := time.NewTimer(3 * clientTimeout)
			defer timer.Stop()
			select {
			case <-timer.C:
				_, _ = io.WriteString(writer, "data: {\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":\"stop\"}]}\n\n")
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

	providerInstance, err := NewOpenAIProvider(ai.ProviderConfig{
		Type: "custom", APIKey: "sk-test", BaseURL: "https://provider.test/v1", Model: "glm-test",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	provider := providerInstance.(*OpenAIProvider)
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

func TestOpenAIProviderChatStreamRespectsContextCancellation(t *testing.T) {
	transport := openAIRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		reader, writer := io.Pipe()
		go func() {
			_, _ = io.WriteString(writer, "data: {\"choices\":[{\"delta\":{\"content\":\"started\"}}]}\n\n")
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

	providerInstance, err := NewOpenAIProvider(ai.ProviderConfig{
		Type: "custom", APIKey: "sk-test", BaseURL: "https://provider.test/v1", Model: "glm-test",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	provider := providerInstance.(*OpenAIProvider)
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

func TestOpenAIProviderChatStreamBoundsErrorBodyRead(t *testing.T) {
	const clientTimeout = 40 * time.Millisecond
	transport := openAIRoundTripFunc(func(req *http.Request) (*http.Response, error) {
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

	providerInstance, err := NewOpenAIProvider(ai.ProviderConfig{
		Type: "custom", APIKey: "sk-test", BaseURL: "https://provider.test/v1", Model: "glm-test",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	provider := providerInstance.(*OpenAIProvider)
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

func TestOpenAIProviderChatRetriesWithoutImagesOnHTTP400(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read request body failed: %v", err)
		}
		defer r.Body.Close()

		if strings.Contains(string(body), `"image_url"`) {
			http.Error(w, `{"error":{"message":"Model do not support image input"}}`, http.StatusBadRequest)
			return
		}
		if !strings.Contains(string(body), providerImageOmittedNotice("")) {
			t.Fatalf("expected retry body to explain omitted image, got %s", body)
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"pong"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIProvider(ai.ProviderConfig{
		Type:        "openai",
		Name:        "test-openai",
		APIKey:      "sk-test",
		BaseURL:     server.URL,
		Model:       "custom-text-model",
		MaxTokens:   64,
		Temperature: 0.1,
	})
	if err != nil {
		t.Fatalf("create provider failed: %v", err)
	}

	resp, err := providerInstance.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{
			Role:    "user",
			Content: "请描述这张图片",
			Images:  []string{"data:image/png;base64,abc"},
		}},
	})
	if err != nil {
		t.Fatalf("expected chat image fallback to succeed, got %v", err)
	}
	if resp.Content != "pong" {
		t.Fatalf("expected fallback content %q, got %q", "pong", resp.Content)
	}
	if requestCount != 2 {
		t.Fatalf("expected 2 requests (with image then fallback), got %d", requestCount)
	}
}

func TestOpenAIProviderChatOmitsImagesUpfrontForMiniMaxTextModel(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read request body failed: %v", err)
		}
		defer r.Body.Close()

		bodyText := string(body)
		if strings.Contains(bodyText, `"image_url"`) {
			t.Fatalf("expected MiniMax text request to omit image_url, got %s", body)
		}
		if !strings.Contains(bodyText, providerImageOmittedNotice("")) {
			t.Fatalf("expected request body to explain omitted image, got %s", body)
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"pong"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIProvider(ai.ProviderConfig{
		Type:        "openai",
		Name:        "test-openai",
		APIKey:      "sk-test",
		BaseURL:     server.URL,
		Model:       "MiniMax-M2.7-highspeed",
		MaxTokens:   64,
		Temperature: 0.1,
	})
	if err != nil {
		t.Fatalf("create provider failed: %v", err)
	}

	resp, err := providerInstance.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{
			Role:    "user",
			Content: "请描述这张图片",
			Images:  []string{"data:image/png;base64,abc"},
		}},
	})
	if err != nil {
		t.Fatalf("expected chat to succeed without sending image, got %v", err)
	}
	if resp.Content != "pong" {
		t.Fatalf("expected content %q, got %q", "pong", resp.Content)
	}
	if requestCount != 1 {
		t.Fatalf("expected 1 request without image retry, got %d", requestCount)
	}
}

func TestPrepareOpenAIRequestMessagesKeepsImagesForVisionModel(t *testing.T) {
	got := prepareOpenAIRequestMessages([]ai.Message{{
		Role:    "user",
		Content: "请描述图片",
		Images:  []string{"data:image/png;base64,abc"},
	}}, "gpt-5.4", "https://sub.syngnat.top/v1")

	if len(got) != 1 || len(got[0].Images) != 1 {
		t.Fatalf("expected vision-capable model to keep images, got %#v", got)
	}
}

func TestOpenAIProviderChatStreamRetriesWithoutToolsThenImagesOnHTTP400(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read request body failed: %v", err)
		}
		defer r.Body.Close()

		bodyText := string(body)
		if strings.Contains(bodyText, `"tools"`) {
			http.Error(w, `{"error":{"message":"A parameter specified in the request is not valid"}}`, http.StatusBadRequest)
			return
		}
		if strings.Contains(bodyText, `"image_url"`) {
			http.Error(w, `{"error":{"message":"A parameter specified in the request is not valid"}}`, http.StatusBadRequest)
			return
		}
		if !strings.Contains(bodyText, providerImageOmittedNotice("")) {
			t.Fatalf("expected retry body to explain omitted image, got %s", body)
		}

		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(strings.Join([]string{
			`data: {"choices":[{"delta":{"content":"pong"},"finish_reason":null}]}`,
			``,
			`data: [DONE]`,
			``,
		}, "\n")))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIProvider(ai.ProviderConfig{
		Type:        "openai",
		Name:        "test-openai",
		APIKey:      "sk-test",
		BaseURL:     server.URL,
		Model:       "custom-text-model",
		MaxTokens:   64,
		Temperature: 0.1,
	})
	if err != nil {
		t.Fatalf("create provider failed: %v", err)
	}

	var chunks []ai.StreamChunk
	err = providerInstance.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{
			Role:    "user",
			Content: "请描述这张图片",
			Images:  []string{"data:image/png;base64,abc"},
		}},
		Tools: []ai.Tool{{
			Type: "function",
			Function: ai.ToolFunction{
				Name:        "inspect_ai_last_render_error",
				Description: "test tool",
				Parameters:  map[string]interface{}{"type": "object"},
			},
		}},
	}, func(chunk ai.StreamChunk) {
		chunks = append(chunks, chunk)
	})
	if err != nil {
		t.Fatalf("expected stream fallback to succeed, got %v", err)
	}
	if requestCount != 3 {
		t.Fatalf("expected 3 requests (with tools, without tools, without images), got %d", requestCount)
	}
	if len(chunks) < 2 {
		t.Fatalf("expected content and done chunks, got %#v", chunks)
	}
	if chunks[0].Content != "pong" {
		t.Fatalf("expected first chunk content %q, got %#v", "pong", chunks[0])
	}
	if !chunks[len(chunks)-1].Done {
		t.Fatalf("expected final done chunk, got %#v", chunks[len(chunks)-1])
	}
}

func TestBuildOpenAIMessages_ReplaysDeepSeekReasoningContentForToolCalls(t *testing.T) {
	toolCall := testOpenAIToolCall()
	got := buildOpenAIMessages([]ai.Message{
		{
			Role:             "assistant",
			Content:          "",
			ToolCalls:        []ai.ToolCall{toolCall},
			ReasoningContent: "需要先检查表结构",
		},
		{
			Role:       "tool",
			Content:    `{"ok":true}`,
			ToolCallID: toolCall.ID,
		},
	}, "deepseek-v4", "https://api.deepseek.com/v1")

	if got[0].ReasoningContent != "需要先检查表结构" {
		t.Fatalf("expected reasoning_content to be replayed for DeepSeek tool call, got %q", got[0].ReasoningContent)
	}
	if got[1].ReasoningContent != "" {
		t.Fatalf("expected tool result message not to carry reasoning_content, got %q", got[1].ReasoningContent)
	}

	body, err := json.Marshal(got[0])
	if err != nil {
		t.Fatalf("marshal message: %v", err)
	}
	if !strings.Contains(string(body), `"reasoning_content":"需要先检查表结构"`) {
		t.Fatalf("expected JSON payload to include reasoning_content, got %s", body)
	}
}

func TestBuildOpenAIMessages_DropsIncompleteDeepSeekToolCallGroup(t *testing.T) {
	firstCall := testOpenAIToolCall()
	secondCall := firstCall
	secondCall.ID = "call_query"
	secondCall.Function.Name = "execute_query"

	got := buildOpenAIMessages([]ai.Message{
		{Role: "user", Content: "检查并查询订单表"},
		{Role: "assistant", ToolCalls: []ai.ToolCall{firstCall, secondCall}, ReasoningContent: "先检查表结构"},
		{Role: "tool", Content: `{"ok":true}`, ToolCallID: firstCall.ID},
		{Role: "user", Content: "继续"},
	}, "deepseek-v4-flash", "https://api.deepseek.com/v1")

	if len(got) != 2 || got[0].Role != "user" || got[1].Role != "user" {
		t.Fatalf("incomplete tool-call group was not removed: %#v", got)
	}
	for _, message := range got {
		if len(message.ToolCalls) > 0 || message.ToolCallID != "" {
			t.Fatalf("invalid tool history remains in request: %#v", got)
		}
	}
}

func TestBuildOpenAIMessages_PreservesCompleteMultiToolCallGroup(t *testing.T) {
	firstCall := testOpenAIToolCall()
	secondCall := firstCall
	secondCall.ID = "call_query"
	secondCall.Function.Name = "execute_query"

	got := buildOpenAIMessages([]ai.Message{
		{Role: "assistant", ToolCalls: []ai.ToolCall{firstCall, secondCall}},
		{Role: "tool", Content: `{"columns":[]}`, ToolCallID: firstCall.ID},
		{Role: "tool", Content: `{"rows":[]}`, ToolCallID: secondCall.ID},
	}, "deepseek-v4-flash", "https://api.deepseek.com/v1")

	if len(got) != 3 || len(got[0].ToolCalls) != 2 || got[1].ToolCallID != firstCall.ID || got[2].ToolCallID != secondCall.ID {
		t.Fatalf("complete tool-call group changed: %#v", got)
	}
}

func TestBuildOpenAIMessages_DropsOrphanToolResult(t *testing.T) {
	got := buildOpenAIMessages([]ai.Message{
		{Role: "tool", Content: `{"ok":true}`, ToolCallID: "missing_call"},
		{Role: "user", Content: "hello"},
	}, "deepseek-v4-flash", "https://api.deepseek.com/v1")

	if len(got) != 1 || got[0].Role != "user" {
		t.Fatalf("orphan tool result was not removed: %#v", got)
	}
}

func TestBuildOpenAIMessages_OmitsReasoningContentForNonDeepSeekProviders(t *testing.T) {
	toolCall := testOpenAIToolCall()
	got := buildOpenAIMessages([]ai.Message{
		{
			Role:             "assistant",
			Content:          "",
			ToolCalls:        []ai.ToolCall{toolCall},
			ReasoningContent: "reasoning should stay local",
		},
		{Role: "tool", Content: `{"ok":true}`, ToolCallID: toolCall.ID},
	}, "gpt-4o", "https://api.openai.com/v1")

	if got[0].ReasoningContent != "" {
		t.Fatalf("expected non-DeepSeek provider to omit reasoning_content, got %q", got[0].ReasoningContent)
	}
	body, err := json.Marshal(got[0])
	if err != nil {
		t.Fatalf("marshal message: %v", err)
	}
	if strings.Contains(string(body), "reasoning_content") {
		t.Fatalf("expected JSON payload to omit reasoning_content for non-DeepSeek provider, got %s", body)
	}
}

func TestBuildOpenAIMessagesDropsIncompleteToolCallHistory(t *testing.T) {
	callA := testOpenAIToolCall()
	callA.ID = "call_a"
	callB := callA
	callB.ID = "call_b"

	got := buildOpenAIMessages([]ai.Message{
		{Role: "user", Content: "Inspect the order tables."},
		{Role: "assistant", ToolCalls: []ai.ToolCall{callA, callB}},
		{Role: "tool", ToolCallID: callA.ID, Content: `{"ok":true}`},
		{Role: "user", Content: "Continue with the available results."},
	}, "deepseek-v4-flash", "https://api.deepseek.com/v1")

	if len(got) != 2 {
		t.Fatalf("expected incomplete tool-call turn to be removed, got %#v", got)
	}
	if got[0].Role != "user" || got[1].Role != "user" {
		t.Fatalf("expected user messages to remain after removing incomplete turn, got %#v", got)
	}
}

func TestBuildOpenAIMessagesDropsCompleteToolCallTurnWithNonObjectArguments(t *testing.T) {
	for name, arguments := range map[string]string{
		"array":   `[]`,
		"boolean": `true`,
		"null":    `null`,
		"number":  `1`,
		"string":  `"connection-1"`,
	} {
		t.Run(name, func(t *testing.T) {
			toolCall := testOpenAIToolCall()
			toolCall.Function.Arguments = arguments
			got := buildOpenAIMessages([]ai.Message{
				{Role: "user", Content: "Inspect."},
				{Role: "assistant", ToolCalls: []ai.ToolCall{toolCall}},
				{Role: "tool", ToolCallID: toolCall.ID, Content: `{"ok":true}`},
				{Role: "user", Content: "Continue."},
			}, "gpt-4o", "https://api.openai.com/v1")

			if len(got) != 2 || got[0].Role != "user" || got[1].Role != "user" {
				t.Fatalf("expected non-object tool-call turn to be removed, got %#v", got)
			}
		})
	}
}

func TestBuildOpenAIMessagesKeepsCompleteToolCallHistory(t *testing.T) {
	callA := testOpenAIToolCall()
	callA.ID = "call_a"
	callB := callA
	callB.ID = "call_b"

	got := buildOpenAIMessages([]ai.Message{
		{Role: "assistant", ToolCalls: []ai.ToolCall{callA, callB}},
		{Role: "tool", ToolCallID: callA.ID, Content: `{"a":true}`},
		{Role: "tool", ToolCallID: callB.ID, Content: `{"b":true}`},
	}, "deepseek-v4-flash", "https://api.deepseek.com/v1")

	if len(got) != 3 || len(got[0].ToolCalls) != 2 {
		t.Fatalf("expected complete tool-call turn to remain intact, got %#v", got)
	}
}

func TestBuildOpenAIMessages_ReplaysDeepSeekAssistantReasoningContentWithoutToolCalls(t *testing.T) {
	got := buildOpenAIMessages([]ai.Message{
		{
			Role:             "assistant",
			Content:          "最终分析",
			ReasoningContent: "工具调用轮次的最终思考也需要保留",
		},
	}, "deepseek-v4", "https://api.deepseek.com/v1")

	if got[0].ReasoningContent != "工具调用轮次的最终思考也需要保留" {
		t.Fatalf("expected DeepSeek assistant reasoning_content to be replayed, got %q", got[0].ReasoningContent)
	}
}

func testOpenAIToolCall() ai.ToolCall {
	var toolCall ai.ToolCall
	toolCall.ID = "call_schema"
	toolCall.Type = "function"
	toolCall.Function.Name = "inspect_table_schema"
	toolCall.Function.Arguments = `{"table":"orders"}`
	return toolCall
}
