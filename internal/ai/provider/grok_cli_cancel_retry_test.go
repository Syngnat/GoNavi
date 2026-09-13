package provider

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
)

func TestGrokCLIExecutionErrorTranslatesBareCancelled(t *testing.T) {
	tests := []struct {
		name          string
		detail        string
		wantSentinel  bool
		wantSubstring string
	}{
		{name: "bare enum value", detail: "cancelled", wantSentinel: true, wantSubstring: "请重新发送重试"},
		{name: "us spelling", detail: "canceled", wantSentinel: true},
		{name: "request cancelled message", detail: "Request cancelled", wantSentinel: true},
		{
			name:          "upstream detail passthrough",
			detail:        "API error (status 402 Payment Required): Grok Build usage balance exhausted",
			wantSubstring: "402 Payment Required",
		},
		{name: "empty passthrough", detail: "empty output"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := grokCLIExecutionError(test.detail)
			if errors.Is(err, errGrokCLIUpstreamCancelled) != test.wantSentinel {
				t.Fatalf("sentinel mismatch for %q: %v", test.detail, err)
			}
			if test.wantSubstring != "" && !strings.Contains(err.Error(), test.wantSubstring) {
				t.Fatalf("message %q missing %q", err.Error(), test.wantSubstring)
			}
			if !test.wantSentinel && !strings.Contains(err.Error(), test.detail) {
				t.Fatalf("non-cancelled detail must pass through verbatim: %q", err.Error())
			}
		})
	}
}

func TestGrokCLITerminalCancelled(t *testing.T) {
	tests := []struct {
		name   string
		output string
		want   bool
	}{
		{name: "snake case result line", output: "{\"type\":\"result\",\"is_error\":true,\"stop_reason\":\"cancelled\"}\n", want: true},
		{name: "camel case result line", output: "{\"type\":\"result\",\"stopReason\":\"cancelled\"}", want: true},
		{name: "successful result line", output: "{\"type\":\"result\",\"subtype\":\"success\",\"stop_reason\":\"end_turn\"}", want: false},
		{name: "usage line never counts", output: "{\"type\":\"usage\",\"stopReason\":\"cancelled\"}", want: false},
		{name: "buffered json object is not a result line", output: "{\"text\":\"\",\"stopReason\":\"cancelled\"}", want: false},
		{name: "non json noise", output: "grok: connection reset by peer", want: false},
		{name: "empty output", output: "", want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := grokCLITerminalCancelled(test.output); got != test.want {
				t.Fatalf("grokCLITerminalCancelled(%q) = %v, want %v", test.output, got, test.want)
			}
		})
	}
}

func TestGrokCLIProviderChatStreamRetriesCancelledTurnOnce(t *testing.T) {
	counter := filepath.Join(t.TempDir(), "attempts")
	restore := overrideGrokCLIWithEnv(t, "cancel-once-then-ok", "GO_GROK_HELPER_COUNTER="+counter)
	defer restore()

	provider, err := NewGrokCLIProvider(ai.ProviderConfig{AuthMode: "local-cli"})
	if err != nil {
		t.Fatal(err)
	}
	var chunks []ai.StreamChunk
	if err := provider.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "hello"}},
	}, func(chunk ai.StreamChunk) { chunks = append(chunks, chunk) }); err != nil {
		t.Fatalf("stream: %v", err)
	}
	if len(chunks) != 2 || chunks[0].Content != "hello" || !chunks[1].Done || chunks[1].Error != "" {
		t.Fatalf("retry must complete the turn cleanly, got %#v", chunks)
	}
	if count := readGrokHelperCounter(t, counter); count != 2 {
		t.Fatalf("attempt count = %d, want 2", count)
	}
}

func TestGrokCLIProviderChatStreamDoesNotRetryAfterPartialContent(t *testing.T) {
	counter := filepath.Join(t.TempDir(), "attempts")
	restore := overrideGrokCLIWithEnv(t, "cancel-after-content", "GO_GROK_HELPER_COUNTER="+counter)
	defer restore()

	provider, err := NewGrokCLIProvider(ai.ProviderConfig{AuthMode: "local-cli"})
	if err != nil {
		t.Fatal(err)
	}
	var chunks []ai.StreamChunk
	if err := provider.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "hello"}},
	}, func(chunk ai.StreamChunk) { chunks = append(chunks, chunk) }); err != nil {
		t.Fatalf("stream: %v", err)
	}
	// 已展示的内容不能靠重试重说一遍：部分输出后取消只报错，不再重跑。
	if count := readGrokHelperCounter(t, counter); count != 1 {
		t.Fatalf("partial content must not retry, attempt count = %d", count)
	}
	if len(chunks) != 2 || chunks[0].Content != "hello" || !chunks[1].Done {
		t.Fatalf("unexpected chunks: %#v", chunks)
	}
	if !strings.Contains(chunks[1].Error, "上游推理请求在回合中途被取消") {
		t.Fatalf("cancelled turn must surface the translated error: %q", chunks[1].Error)
	}
}

func TestGrokCLIProviderChatStreamReportsWhenRetryAlsoCancelled(t *testing.T) {
	counter := filepath.Join(t.TempDir(), "attempts")
	restore := overrideGrokCLIWithEnv(t, "cancelled", "GO_GROK_HELPER_COUNTER="+counter)
	defer restore()

	provider, err := NewGrokCLIProvider(ai.ProviderConfig{AuthMode: "local-cli"})
	if err != nil {
		t.Fatal(err)
	}
	var chunks []ai.StreamChunk
	if err := provider.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "hello"}},
	}, func(chunk ai.StreamChunk) { chunks = append(chunks, chunk) }); err != nil {
		t.Fatalf("stream: %v", err)
	}
	if count := readGrokHelperCounter(t, counter); count != 2 {
		t.Fatalf("cancelled turn must retry exactly once, attempt count = %d", count)
	}
	if len(chunks) != 1 || !chunks[0].Done {
		t.Fatalf("expected one terminal error chunk, got %#v", chunks)
	}
	if !strings.Contains(chunks[0].Error, "Grok CLI execution failed") ||
		!strings.Contains(chunks[0].Error, "上游推理请求在回合中途被取消") {
		t.Fatalf("error chunk must keep the prefix and carry the translated hint: %q", chunks[0].Error)
	}
}

func TestGrokCLIProviderChatRetriesCancelledTurnOnce(t *testing.T) {
	counter := filepath.Join(t.TempDir(), "attempts")
	restore := overrideGrokCLIWithEnv(t, "buffered-cancel-once-then-ok", "GO_GROK_HELPER_COUNTER="+counter)
	defer restore()

	provider, err := NewGrokCLIProvider(ai.ProviderConfig{AuthMode: "local-cli"})
	if err != nil {
		t.Fatal(err)
	}
	response, err := provider.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "hello"}},
	})
	if err != nil {
		t.Fatalf("chat: %v", err)
	}
	if response.Content != "done" {
		t.Fatalf("retry must return the completed answer, got %q", response.Content)
	}
	if count := readGrokHelperCounter(t, counter); count != 2 {
		t.Fatalf("attempt count = %d, want 2", count)
	}
}

func TestGrokCLIProviderChatTranslatesCancelledStopReason(t *testing.T) {
	counter := filepath.Join(t.TempDir(), "attempts")
	restore := overrideGrokCLIWithEnv(t, "buffered-cancelled", "GO_GROK_HELPER_COUNTER="+counter)
	defer restore()

	provider, err := NewGrokCLIProvider(ai.ProviderConfig{AuthMode: "local-cli"})
	if err != nil {
		t.Fatal(err)
	}
	response, err := provider.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "hello"}},
	})
	if err == nil || response != nil {
		t.Fatalf("cancelled stop reason must fail the chat, got response=%v err=%v", response, err)
	}
	if !errors.Is(err, errGrokCLIUpstreamCancelled) {
		t.Fatalf("error must carry the retryable sentinel: %v", err)
	}
	if !strings.Contains(err.Error(), "请重新发送重试") {
		t.Fatalf("error must carry the retry hint: %q", err.Error())
	}
	if count := readGrokHelperCounter(t, counter); count != 2 {
		t.Fatalf("buffered path must retry once, attempt count = %d", count)
	}
}

// overrideGrokCLIWithEnv 与 overrideGrokCLIForTest 相同，但向 helper 进程追加
// 环境变量；取消类模式用计数文件路径区分第 1 次尝试与重试。
func overrideGrokCLIWithEnv(t *testing.T, mode string, extra ...string) func() {
	t.Helper()
	originalLookPath := grokLookPath
	originalCommand := grokCommandContext
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	grokLookPath = func(string) (string, error) { return executable, nil }
	grokCommandContext = func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
		cmd := exec.CommandContext(ctx, executable, "-test.run=TestGrokCLIHelperProcess", "--")
		cmd.Env = append(append(os.Environ(), "GO_WANT_GROK_HELPER=1", "GO_GROK_HELPER_MODE="+mode), extra...)
		return cmd
	}
	return func() {
		grokLookPath = originalLookPath
		grokCommandContext = originalCommand
	}
}

func readGrokHelperCounter(t *testing.T, path string) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read attempt counter: %v", err)
	}
	count, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatalf("parse attempt counter %q: %v", data, err)
	}
	return count
}
