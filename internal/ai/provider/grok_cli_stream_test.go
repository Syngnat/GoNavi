package provider

import (
	"context"
	"encoding/json"
	"fmt"
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

func TestGrokStreamUsageFromLine(t *testing.T) {
	usage := grokStreamUsageFromLine([]byte(`{"type":"result","usage":{"input_tokens":10,"output_tokens":3,"total_tokens":13,"cached_input_tokens":4}}`))
	if usage == nil || usage.PromptTokens != 10 || usage.CompletionTokens != 3 || usage.TotalTokens != 13 {
		t.Fatalf("usage = %#v", usage)
	}
	if usage.CachedTokens == nil || *usage.CachedTokens != 4 {
		t.Fatalf("cached usage = %#v", usage.CachedTokens)
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

func TestGrokCLIProviderPreservesAPIKeyAuthenticationEnvironment(t *testing.T) {
	restore := overrideGrokCLIForTest(t, "stream")
	defer restore()

	helperCommandContext := grokCommandContext
	var modelCommand *exec.Cmd
	grokCommandContext = func(ctx context.Context, path string, args ...string) *exec.Cmd {
		command := helperCommandContext(ctx, path, args...)
		modelCommand = command
		return command
	}
	provider, err := NewGrokCLIProvider(ai.ProviderConfig{
		AuthMode: "local-cli",
		CLIEnv: map[string]string{
			"XAI_API_KEY":      "xai-cli-key",
			"XAI_API_BASE_URL": "https://api.example.invalid",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := provider.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "hello"}},
	}, func(ai.StreamChunk) {}); err != nil {
		t.Fatal(err)
	}
	if modelCommand == nil {
		t.Fatal("model command was not created")
	}
	if got := envValue(modelCommand.Env, "XAI_API_KEY"); got != "xai-cli-key" {
		t.Fatalf("XAI_API_KEY = %q, want configured CLI authentication", got)
	}
	if got := envValue(modelCommand.Env, "XAI_API_BASE_URL"); got != "https://api.example.invalid" {
		t.Fatalf("XAI_API_BASE_URL = %q, want configured CLI endpoint", got)
	}
}

func TestGrokCLIProviderChatStreamKeepsLargePromptOutOfCommandLine(t *testing.T) {
	originalLookPath := grokLookPath
	originalCommand := grokCommandContext
	t.Cleanup(func() {
		grokLookPath = originalLookPath
		grokCommandContext = originalCommand
	})

	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	largePrompt := strings.Repeat("large Windows prompt ", 4_000)
	var capturedArgs []string
	var promptFilePath string
	var promptFileContent string
	var promptFileMode os.FileMode
	grokLookPath = func(string) (string, error) { return executable, nil }
	grokCommandContext = func(ctx context.Context, _ string, args ...string) *exec.Cmd {
		capturedArgs = append([]string(nil), args...)
		for index, arg := range args {
			if arg != "--prompt-file" || index+1 >= len(args) {
				continue
			}
			promptFilePath = args[index+1]
			content, readErr := os.ReadFile(promptFilePath)
			if readErr != nil {
				t.Fatalf("read prompt file: %v", readErr)
			}
			promptFileContent = string(content)
			info, statErr := os.Stat(promptFilePath)
			if statErr != nil {
				t.Fatalf("stat prompt file: %v", statErr)
			}
			promptFileMode = info.Mode().Perm()
		}
		cmd := exec.CommandContext(ctx, executable, "-test.run=TestGrokCLIHelperProcess", "--")
		cmd.Env = append(os.Environ(), "GO_WANT_GROK_HELPER=1", "GO_GROK_HELPER_MODE=stream")
		return cmd
	}

	provider, _ := NewGrokCLIProvider(ai.ProviderConfig{AuthMode: "local-cli"})
	if err := provider.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: largePrompt}},
	}, func(ai.StreamChunk) {}); err != nil {
		t.Fatal(err)
	}
	if promptFilePath == "" {
		t.Fatalf("expected --prompt-file, got argv=%#v", capturedArgs)
	}
	if !strings.Contains(promptFileContent, largePrompt) {
		t.Fatal("prompt file did not contain the complete prompt")
	}
	if promptFileMode != 0o600 {
		t.Fatalf("prompt file permissions = %o, want 600", promptFileMode)
	}
	for _, arg := range capturedArgs {
		if strings.Contains(arg, largePrompt) {
			t.Fatal("large prompt must not be embedded in the process command line")
		}
	}
	if _, err := os.Stat(promptFilePath); !os.IsNotExist(err) {
		t.Fatalf("temporary prompt file was not removed: %v", err)
	}
}

func TestGrokCLIStructuredErrorDetailFromBufferedError(t *testing.T) {
	output := `{"type":"error","message":"Internal error: {\n  \"message\": \"API error (status 402 Payment Required): Grok Build usage balance exhausted\",\n  \"http_status\": 402\n}"}`
	detail := grokCLIStructuredErrorDetail(output)
	if detail != "API error (status 402 Payment Required): Grok Build usage balance exhausted" {
		t.Fatalf("unexpected detail: %q", detail)
	}
}

func TestGrokCLIProviderChatStreamReportsStructuredInternalError(t *testing.T) {
	restore := overrideGrokCLIForTest(t, "balance-error")
	defer restore()

	provider, _ := NewGrokCLIProvider(ai.ProviderConfig{AuthMode: "local-cli"})
	var chunks []ai.StreamChunk
	if err := provider.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "hello"}},
	}, func(chunk ai.StreamChunk) { chunks = append(chunks, chunk) }); err != nil {
		t.Fatal(err)
	}
	if len(chunks) != 1 || !chunks[0].Done {
		t.Fatalf("expected one terminal error chunk, got %#v", chunks)
	}
	if !strings.Contains(chunks[0].Error, "402 Payment Required") ||
		!strings.Contains(chunks[0].Error, "Grok Build usage balance exhausted") {
		t.Fatalf("structured upstream detail was lost: %q", chunks[0].Error)
	}
	if strings.HasSuffix(chunks[0].Error, "Internal error: {") {
		t.Fatalf("error was truncated to the first line: %q", chunks[0].Error)
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
	case "balance-error":
		detail := "Internal error: {\n  \"message\": \"API error (status 402 Payment Required): Grok Build usage balance exhausted\",\n  \"http_status\": 402\n}"
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{
			"type":     "result",
			"is_error": true,
			"errors":   []string{detail},
		})
		_, _ = fmt.Fprintln(os.Stderr, "Error: "+detail)
		os.Exit(1)
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
