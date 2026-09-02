package provider

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/ai"
)

func TestGrokStreamChunkFromLine(t *testing.T) {
	tests := []struct {
		name         string
		line         string
		wantThinking string
		wantContent  string
	}{
		{
			name:        "text delta",
			line:        `{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}`,
			wantContent: "Hi",
		},
		{
			name:         "thinking delta",
			line:         `{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"plan"}}`,
			wantThinking: "plan",
		},
		{
			name:        "nested stream_event",
			line:        `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"SQL"}}}`,
			wantContent: "SQL",
		},
		{
			name:         "final json fallback",
			line:         `{"text":"done","thought":"why"}`,
			wantThinking: "why",
			wantContent:  "done",
		},
		{
			name: "assistant snapshot ignored",
			line: `{"type":"assistant","message":{"content":[{"type":"text","text":"full"}]}}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			thinking, content := grokStreamChunkFromLine([]byte(test.line))
			if thinking != test.wantThinking || content != test.wantContent {
				t.Fatalf("got thinking=%q content=%q want %q / %q", thinking, content, test.wantThinking, test.wantContent)
			}
		})
	}
}

func TestBuildGrokCLIArgsStreamingFormat(t *testing.T) {
	args, err := buildGrokCLIArgsWithStream(ai.ProviderConfig{Model: "grok-4.6"}, "hi", true)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	for _, expected := range []string{
		"--output-format streaming-messages-json",
		"--include-partial-messages",
		"--system-prompt-override",
		"--disable-web-search",
		"-m grok-4.6",
	} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("missing %q in %v", expected, args)
		}
	}
	if strings.Contains(joined, "--output-format json") {
		t.Fatalf("stream args must not request buffered json: %v", args)
	}
}

func TestGrokCLIProviderChatStreamEmitsDeltasThenDone(t *testing.T) {
	restore := overrideGrokCLIForTest(t, "stream")
	defer restore()

	provider, err := NewGrokCLIProvider(ai.ProviderConfig{AuthMode: "local-cli"})
	if err != nil {
		t.Fatal(err)
	}
	var chunks []ai.StreamChunk
	if err := provider.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "hello"}},
	}, func(chunk ai.StreamChunk) {
		chunks = append(chunks, chunk)
	}); err != nil {
		t.Fatalf("stream: %v", err)
	}
	if len(chunks) != 3 || chunks[0].Thinking != "plan" || chunks[1].Content != "hello" || !chunks[2].Done {
		t.Fatalf("unexpected chunks: %#v", chunks)
	}
}

func TestGrokCLIProviderChatStreamReportsTimeout(t *testing.T) {
	originalIdle, originalMax := cliStreamIdleTimeout, cliStreamMaxTimeout
	cliStreamIdleTimeout = 50 * time.Millisecond
	cliStreamMaxTimeout = time.Second
	defer func() {
		cliStreamIdleTimeout = originalIdle
		cliStreamMaxTimeout = originalMax
	}()
	restore := overrideGrokCLIForTest(t, "sleep")
	defer restore()

	provider, _ := NewGrokCLIProvider(ai.ProviderConfig{AuthMode: "local-cli"})
	var chunks []ai.StreamChunk
	err := provider.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "slow"}},
	}, func(chunk ai.StreamChunk) { chunks = append(chunks, chunk) })
	if err != nil {
		t.Fatalf("expected callback error convention, got %v", err)
	}
	if len(chunks) != 1 || !chunks[0].Done || !strings.Contains(chunks[0].Error, "timed out after") {
		t.Fatalf("expected timeout chunk, got %#v", chunks)
	}
}

func TestGrokCLIProviderChatStreamKeepsAliveAcrossThinkingGaps(t *testing.T) {
	originalIdle, originalMax := cliStreamIdleTimeout, cliStreamMaxTimeout
	cliStreamIdleTimeout = 100 * time.Millisecond
	cliStreamMaxTimeout = 2 * time.Second
	defer func() {
		cliStreamIdleTimeout = originalIdle
		cliStreamMaxTimeout = originalMax
	}()
	restore := overrideGrokCLIForTest(t, "keepalive")
	defer restore()

	provider, _ := NewGrokCLIProvider(ai.ProviderConfig{AuthMode: "local-cli"})
	var chunks []ai.StreamChunk
	if err := provider.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "slow thinking"}},
	}, func(chunk ai.StreamChunk) {
		chunks = append(chunks, chunk)
	}); err != nil {
		t.Fatalf("stream: %v", err)
	}
	if len(chunks) < 3 || chunks[0].Thinking == "" || chunks[len(chunks)-2].Content != "hello" || !chunks[len(chunks)-1].Done {
		t.Fatalf("thinking gaps must not abort the stream: %#v", chunks)
	}
}

func TestGrokCLIHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_GROK_HELPER") != "1" {
		return
	}
	switch os.Getenv("GO_GROK_HELPER_MODE") {
	case "sleep":
		time.Sleep(2 * time.Second)
	case "keepalive":
		encoder := json.NewEncoder(os.Stdout)
		_ = encoder.Encode(map[string]any{
			"type":  "content_block_delta",
			"delta": map[string]string{"type": "thinking_delta", "thinking": "plan"},
		})
		time.Sleep(60 * time.Millisecond)
		_ = encoder.Encode(map[string]any{
			"type":  "content_block_delta",
			"delta": map[string]string{"type": "thinking_delta", "thinking": " more"},
		})
		time.Sleep(60 * time.Millisecond)
		_ = encoder.Encode(map[string]any{
			"type":  "content_block_delta",
			"delta": map[string]string{"type": "text_delta", "text": "hello"},
		})
	default:
		encoder := json.NewEncoder(os.Stdout)
		_ = encoder.Encode(map[string]any{
			"type":  "content_block_delta",
			"delta": map[string]string{"type": "thinking_delta", "thinking": "plan"},
		})
		_ = encoder.Encode(map[string]any{
			"type":  "content_block_delta",
			"delta": map[string]string{"type": "text_delta", "text": "hello"},
		})
	}
}

func overrideGrokCLIForTest(t *testing.T, mode string) func() {
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
		cmd.Env = append(os.Environ(), "GO_WANT_GROK_HELPER=1", "GO_GROK_HELPER_MODE="+mode)
		return cmd
	}
	return func() {
		grokLookPath = originalLookPath
		grokCommandContext = originalCommand
	}
}
