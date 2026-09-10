package provider

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
)

func TestNormalizeAnthropicMessagesURL_AppendsMessagesSuffix(t *testing.T) {
	url := normalizeAnthropicMessagesURL("https://api.anthropic.com")
	if url != "https://api.anthropic.com/v1/messages" {
		t.Fatalf("expected normalized anthropic messages url, got %q", url)
	}
}

func TestNormalizeAnthropicMessagesURL_UsesMoonshotAnthropicMessagesEndpoint(t *testing.T) {
	url := normalizeAnthropicMessagesURL("https://api.moonshot.cn/anthropic")
	if url != "https://api.moonshot.cn/anthropic/v1/messages" {
		t.Fatalf("expected moonshot anthropic messages url, got %q", url)
	}
}

func TestNormalizeAnthropicMessagesURL_DeepSeekCustomEndpointUsesAnthropicPath(t *testing.T) {
	cases := map[string]string{
		"https://api.deepseek.com":                       "https://api.deepseek.com/anthropic/v1/messages",
		"https://api.deepseek.com/":                      "https://api.deepseek.com/anthropic/v1/messages",
		"https://api.deepseek.com/v1":                    "https://api.deepseek.com/anthropic/v1/messages",
		"https://api.deepseek.com/anthropic":             "https://api.deepseek.com/anthropic/v1/messages",
		"https://api.deepseek.com/anthropic/v1":          "https://api.deepseek.com/anthropic/v1/messages",
		"https://api.deepseek.com/anthropic/v1/messages": "https://api.deepseek.com/anthropic/v1/messages",
	}
	for input, want := range cases {
		if got := normalizeAnthropicMessagesURL(input); got != want {
			t.Fatalf("normalizeAnthropicMessagesURL(%q)=%q, want %q", input, got, want)
		}
	}
}

func TestBuildAnthropicMessagesReplaysThinkingBlocksForDeepSeek(t *testing.T) {
	msgs := buildAnthropicMessagesWithOptions([]ai.Message{{
		Role:             "assistant",
		Content:          "done",
		ReasoningContent: "step by step",
		ToolCalls: []ai.ToolCall{{
			ID:   "call_1",
			Type: "function",
			Function: ai.ToolCallFunction{
				Name:      "get_tables",
				Arguments: `{"connectionId":"c1"}`,
			},
		}},
	}}, true)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	parts, ok := msgs[0].Content.([]map[string]interface{})
	if !ok || len(parts) < 2 {
		t.Fatalf("expected multi-part content, got %#v", msgs[0].Content)
	}
	if parts[0]["type"] != "thinking" || parts[0]["thinking"] != "step by step" {
		t.Fatalf("expected leading thinking block, got %#v", parts[0])
	}
}

func TestAnthropicProviderAppliesThinkingIntensity(t *testing.T) {
	providerInstance, err := NewAnthropicProvider(ai.ProviderConfig{
		Type:              "custom",
		Name:              "deepseek-anthropic",
		APIKey:            "sk-test",
		BaseURL:           "https://api.deepseek.com",
		Model:             "deepseek-chat",
		MaxTokens:         128,
		Temperature:       0.2,
		ThinkingIntensity: "high",
	})
	if err != nil {
		t.Fatalf("create provider failed: %v", err)
	}
	p := providerInstance.(*AnthropicProvider)
	if p.baseURL != "https://api.deepseek.com/anthropic" {
		t.Fatalf("expected deepseek base normalized with /anthropic, got %q", p.baseURL)
	}
	body := anthropicRequest{Model: p.config.Model, MaxTokens: 128}
	p.applyThinkingToRequest(&body)
	if body.Thinking == nil || body.Thinking.Type != "enabled" || body.Thinking.BudgetTokens != 16000 {
		t.Fatalf("expected high thinking config, got %#v", body.Thinking)
	}
	if body.OutputConfig == nil || body.OutputConfig.Effort != "high" {
		t.Fatalf("expected high effort, got %#v", body.OutputConfig)
	}

	// DeepSeek 档位集不含 xhigh，应钳制到 high
	p.config.ThinkingIntensity = "xhigh"
	body = anthropicRequest{Model: p.config.Model, MaxTokens: 128}
	p.applyThinkingToRequest(&body)
	if body.OutputConfig == nil || body.OutputConfig.Effort != "high" {
		t.Fatalf("expected deepseek to clamp xhigh to high, got %#v", body.OutputConfig)
	}

	// 官方 Anthropic 应保留 xhigh
	official, err := NewAnthropicProvider(ai.ProviderConfig{
		Type:              "anthropic",
		Name:              "claude",
		APIKey:            "sk-test",
		BaseURL:           "https://api.anthropic.com",
		Model:             "claude-opus-4",
		MaxTokens:         128,
		Temperature:       0.2,
		ThinkingIntensity: "xhigh",
	})
	if err != nil {
		t.Fatalf("create official anthropic provider failed: %v", err)
	}
	op := official.(*AnthropicProvider)
	body = anthropicRequest{Model: op.config.Model, MaxTokens: 128}
	op.applyThinkingToRequest(&body)
	if body.OutputConfig == nil || body.OutputConfig.Effort != "xhigh" {
		t.Fatalf("expected anthropic xhigh effort, got %#v", body.OutputConfig)
	}
}

func TestNormalizeAnthropicMessagesURL_PreservesExplicitMessagesPath(t *testing.T) {
	url := normalizeAnthropicMessagesURL("https://api.moonshot.cn/anthropic/v1/messages")
	if url != "https://api.moonshot.cn/anthropic/v1/messages" {
		t.Fatalf("expected explicit messages path to be preserved, got %q", url)
	}
}

func TestApplyAnthropicAuthHeaders_UsesOfficialAnthropicHeadersForAnthropicAPI(t *testing.T) {
	headers := http.Header{}
	ApplyAnthropicAuthHeaders(headers, "https://api.anthropic.com", "sk-test")

	if got := headers.Get("x-api-key"); got != "sk-test" {
		t.Fatalf("expected x-api-key header, got %q", got)
	}
	if got := headers.Get("anthropic-version"); got != anthropicAPIVersion {
		t.Fatalf("expected anthropic-version header, got %q", got)
	}
	if got := headers.Get("Authorization"); got != "" {
		t.Fatalf("expected no authorization header for official anthropic, got %q", got)
	}
}

func TestApplyAnthropicAuthHeaders_UsesBearerForDashScopeCompatibleAnthropic(t *testing.T) {
	headers := http.Header{}
	ApplyAnthropicAuthHeaders(headers, "https://coding.dashscope.aliyuncs.com/apps/anthropic", "sk-sp-test")

	if got := headers.Get("Authorization"); got != "Bearer sk-sp-test" {
		t.Fatalf("expected bearer authorization header, got %q", got)
	}
	if got := headers.Get("x-api-key"); got != "sk-sp-test" {
		t.Fatalf("expected x-api-key header, got %q", got)
	}
	if got := headers.Get("anthropic-version"); got != "" {
		t.Fatalf("expected no anthropic-version header for DashScope, got %q", got)
	}
}

func TestAnthropicProviderChatRetriesWithoutToolsOnHTTP400(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		if r.URL.Path != "/v1/messages" {
			t.Fatalf("unexpected request path: %s", r.URL.Path)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read request body failed: %v", err)
		}
		defer r.Body.Close()

		var payload map[string]interface{}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("unmarshal request body failed: %v", err)
		}

		if _, hasTools := payload["tools"]; hasTools {
			http.Error(w, `{"error":{"message":"tools unsupported"}}`, http.StatusBadRequest)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"pong"}],"usage":{"input_tokens":1,"output_tokens":1}}`))
	}))
	defer server.Close()

	providerInstance, err := NewAnthropicProvider(ai.ProviderConfig{
		Type:        "anthropic",
		Name:        "test-anthropic",
		APIKey:      "sk-test",
		BaseURL:     server.URL,
		Model:       "claude-test",
		MaxTokens:   64,
		Temperature: 0.1,
	})
	if err != nil {
		t.Fatalf("create provider failed: %v", err)
	}

	resp, err := providerInstance.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping"}},
		Tools: []ai.Tool{{
			Type: "function",
			Function: ai.ToolFunction{
				Name:        "get_tables",
				Description: "test tool",
				Parameters: map[string]interface{}{
					"type": "object",
				},
			},
		}},
	})
	if err != nil {
		t.Fatalf("expected chat fallback to succeed, got %v", err)
	}
	if resp.Content != "pong" {
		t.Fatalf("expected fallback content %q, got %q", "pong", resp.Content)
	}
	if requestCount != 2 {
		t.Fatalf("expected 2 requests (with tools then fallback), got %d", requestCount)
	}
}

func TestAnthropicProviderChatStreamRetriesWithoutToolsOnHTTP400(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		if r.URL.Path != "/v1/messages" {
			t.Fatalf("unexpected request path: %s", r.URL.Path)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read request body failed: %v", err)
		}
		defer r.Body.Close()

		var payload map[string]interface{}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("unmarshal request body failed: %v", err)
		}

		if _, hasTools := payload["tools"]; hasTools {
			http.Error(w, `{"error":{"message":"tools unsupported"}}`, http.StatusBadRequest)
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(strings.Join([]string{
			`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"pong"}}`,
			``,
			`data: {"type":"message_stop"}`,
			``,
		}, "\n")))
	}))
	defer server.Close()

	providerInstance, err := NewAnthropicProvider(ai.ProviderConfig{
		Type:        "anthropic",
		Name:        "test-anthropic",
		APIKey:      "sk-test",
		BaseURL:     server.URL,
		Model:       "claude-test",
		MaxTokens:   64,
		Temperature: 0.1,
	})
	if err != nil {
		t.Fatalf("create provider failed: %v", err)
	}

	var chunks []ai.StreamChunk
	err = providerInstance.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping"}},
		Tools: []ai.Tool{{
			Type: "function",
			Function: ai.ToolFunction{
				Name:        "get_tables",
				Description: "test tool",
				Parameters: map[string]interface{}{
					"type": "object",
				},
			},
		}},
	}, func(chunk ai.StreamChunk) {
		chunks = append(chunks, chunk)
	})
	if err != nil {
		t.Fatalf("expected stream fallback to succeed, got %v", err)
	}
	if requestCount != 2 {
		t.Fatalf("expected 2 requests (with tools then fallback), got %d", requestCount)
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

func TestAnthropicProviderChatStreamPreservesUsageAndCacheHits(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(strings.Join([]string{
			`data: {"type":"message_start","message":{"usage":{"input_tokens":6,"cache_creation_input_tokens":2,"cache_read_input_tokens":12,"output_tokens":1}}}`,
			``,
			`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"pong"}}`,
			``,
			`data: {"type":"message_delta","usage":{"output_tokens":5}}`,
			``,
			`data: {"type":"message_stop"}`,
			``,
		}, "\n")))
	}))
	defer server.Close()

	providerInstance, err := NewAnthropicProvider(ai.ProviderConfig{
		Type: "anthropic", APIKey: "sk-test", BaseURL: server.URL, Model: "claude-test", MaxTokens: 64,
	})
	if err != nil {
		t.Fatal(err)
	}
	var chunks []ai.StreamChunk
	err = providerInstance.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping"}},
	}, func(chunk ai.StreamChunk) { chunks = append(chunks, chunk) })
	if err != nil {
		t.Fatal(err)
	}
	final := chunks[len(chunks)-1]
	if !final.Done || final.Usage == nil {
		t.Fatalf("final chunk = %#v", final)
	}
	if final.Usage.PromptTokens != 20 || final.Usage.CompletionTokens != 5 || final.Usage.TotalTokens != 25 {
		t.Fatalf("usage = %#v", final.Usage)
	}
	if final.Usage.CachedTokens == nil || *final.Usage.CachedTokens != 12 {
		t.Fatalf("cached usage = %#v", final.Usage.CachedTokens)
	}
}
