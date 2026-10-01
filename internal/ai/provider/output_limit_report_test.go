package provider

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
)

// 输出被模型的长度上限截断时，agent 需要拿到「已流出的内容 + 截断信号」以便续写；
// 没有要求上报的调用方（行内补全等显式小上限）行为保持不变。

func sseServer(t *testing.T, lines ...string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(strings.Join(lines, "\n") + "\n"))
	}))
}

func streamAll(t *testing.T, p Provider, req ai.ChatRequest) (string, error) {
	t.Helper()
	var content strings.Builder
	err := p.ChatStream(context.Background(), req, func(chunk ai.StreamChunk) {
		content.WriteString(chunk.Content)
	})
	return content.String(), err
}

func requireOutputLimit(t *testing.T, err error) {
	t.Helper()
	var limit *ai.OutputLimitError
	if !errors.As(err, &limit) {
		t.Fatalf("err = %v, want *ai.OutputLimitError", err)
	}
}

func TestOpenAIChatStreamReportsLengthTruncation(t *testing.T) {
	server := sseServer(t,
		`data: {"choices":[{"delta":{"content":"SELECT a, "},"finish_reason":null}]}`, ``,
		`data: {"choices":[{"delta":{},"finish_reason":"length"}]}`, ``,
		`data: [DONE]`, ``,
	)
	defer server.Close()
	providerInstance, err := NewOpenAIProvider(ai.ProviderConfig{Type: "openai", APIKey: "sk-test", BaseURL: server.URL, Model: "gpt-chat"})
	if err != nil {
		t.Fatal(err)
	}

	content, err := streamAll(t, providerInstance, ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "q"}}, ReportOutputLimit: true})
	requireOutputLimit(t, err)
	if content != "SELECT a, " {
		t.Fatalf("streamed content = %q, the partial output must still be delivered", content)
	}

	content, err = streamAll(t, providerInstance, ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "q"}}})
	if err != nil || content != "SELECT a, " {
		t.Fatalf("without ReportOutputLimit behavior must be unchanged, got content=%q err=%v", content, err)
	}
}

func TestAnthropicStreamReportsMaxTokensTruncation(t *testing.T) {
	server := sseServer(t,
		`data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}`, ``,
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"SELECT a, "}}`, ``,
		`data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":5}}`, ``,
		`data: {"type":"message_stop"}`, ``,
	)
	defer server.Close()
	providerInstance, err := NewAnthropicProvider(ai.ProviderConfig{Type: "anthropic", APIKey: "sk-test", BaseURL: server.URL, Model: "claude-x"})
	if err != nil {
		t.Fatal(err)
	}

	content, err := streamAll(t, providerInstance, ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "q"}}, ReportOutputLimit: true})
	requireOutputLimit(t, err)
	if content != "SELECT a, " {
		t.Fatalf("streamed content = %q", content)
	}

	if _, err = streamAll(t, providerInstance, ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "q"}}}); err != nil {
		t.Fatalf("without ReportOutputLimit behavior must be unchanged, got %v", err)
	}
}

func TestGeminiStreamReportsMaxTokensTruncation(t *testing.T) {
	server := sseServer(t,
		`data: {"candidates":[{"content":{"parts":[{"text":"SELECT a, "}]},"finishReason":"MAX_TOKENS"}]}`, ``,
	)
	defer server.Close()
	providerInstance, err := NewGeminiProvider(ai.ProviderConfig{Type: "gemini", APIKey: "test", BaseURL: server.URL, Model: "gemini-x"})
	if err != nil {
		t.Fatal(err)
	}

	content, err := streamAll(t, providerInstance, ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "q"}}, ReportOutputLimit: true})
	requireOutputLimit(t, err)
	if content != "SELECT a, " {
		t.Fatalf("streamed content = %q", content)
	}

	if _, err = streamAll(t, providerInstance, ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "q"}}}); err != nil {
		t.Fatalf("without ReportOutputLimit behavior must be unchanged, got %v", err)
	}
}

func TestOpenAIResponsesReportsIncompleteMaxOutputTokensOnlyWhenAsked(t *testing.T) {
	event := `data: {"type":"response.incomplete","response":{"id":"r","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}`
	delta := `data: {"type":"response.output_text.delta","delta":"SELECT a, "}`
	server := sseServer(t, delta, ``, event, ``)
	defer server.Close()
	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "openai", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "gpt-5.6",
	})
	if err != nil {
		t.Fatal(err)
	}

	content, err := streamAll(t, providerInstance, ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "q"}}, ReportOutputLimit: true})
	requireOutputLimit(t, err)
	if content != "SELECT a, " {
		t.Fatalf("streamed content = %q", content)
	}
	if !strings.Contains(err.Error(), "max_output_tokens") {
		t.Fatalf("message must keep the provider's wording, got %q", err.Error())
	}

	// 没要求上报：仍是原来的普通错误，行内补全等显式小上限的行为不变。
	_, err = streamAll(t, providerInstance, ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "q"}}})
	if err == nil || !strings.Contains(err.Error(), "max_output_tokens") {
		t.Fatalf("err = %v, want the original incomplete error", err)
	}
	var limit *ai.OutputLimitError
	if errors.As(err, &limit) {
		t.Fatal("a caller that did not ask for truncation reports must keep the plain error")
	}
}
