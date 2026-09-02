package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/ai"
)

func TestBuildCodexCLIArgsUsesIsolatedReadOnlyExecutionAndStdin(t *testing.T) {
	args := buildCodexCLIArgs(ai.ProviderConfig{Model: "gpt-5-codex"})

	for _, expected := range []string{
		"exec",
		"--ignore-user-config",
		"--ignore-rules",
		"--ephemeral",
		"--skip-git-repo-check",
		"--json",
		"-",
	} {
		if !hasArg(args, expected) {
			t.Fatalf("expected %q in Codex args, got %#v", expected, args)
		}
	}
	if !hasArgSequence(args, "--sandbox", "read-only") {
		t.Fatalf("expected read-only sandbox, got %#v", args)
	}
	if !hasArgSequence(args, "--disable", "shell_tool") {
		t.Fatalf("expected shell tool to be disabled, got %#v", args)
	}
	for _, feature := range codexCLIDisabledFeatures {
		if !hasArgSequence(args, "--disable", feature) {
			t.Fatalf("expected feature %q to be disabled, got %#v", feature, args)
		}
	}
	for _, criticalFeature := range []string{
		"shell_tool", "hooks", "memories", "multi_agent", "apps", "enable_mcp_apps",
		"plugins", "plugin_hooks", "in_app_browser", "browser_use", "browser_use_external",
		"computer_use", "image_generation", "remote_control",
	} {
		if !hasArgSequence(args, "--disable", criticalFeature) {
			t.Fatalf("expected critical capability %q to be disabled, got %#v", criticalFeature, args)
		}
	}
	if !hasArgSequence(args, "-c", "mcp_servers={}") {
		t.Fatalf("expected MCP servers to be cleared, got %#v", args)
	}
	for _, configOverride := range []string{"skills.include_instructions=false", "skills.bundled.enabled=false"} {
		if !hasArgSequence(args, "-c", configOverride) {
			t.Fatalf("expected skill isolation override %q, got %#v", configOverride, args)
		}
	}
	if !hasArgSequence(args, "-m", "gpt-5-codex") {
		t.Fatalf("expected explicit model, got %#v", args)
	}
	if strings.Contains(strings.Join(args, " "), "secret prompt") {
		t.Fatalf("prompt must not be passed in argv: %#v", args)
	}
}

func TestBuildCodexCLIArgsLeavesModelToSubscriptionDefault(t *testing.T) {
	args := buildCodexCLIArgs(ai.ProviderConfig{})
	if hasArg(args, "-m") {
		t.Fatalf("expected no model override, got %#v", args)
	}
}

func TestNewCodexCLIProviderRejectsAPIKeyAuthMode(t *testing.T) {
	if _, err := NewCodexCLIProvider(ai.ProviderConfig{AuthMode: "api-key"}); err == nil || !strings.Contains(err.Error(), "local-cli") {
		t.Fatalf("expected an actionable local-cli auth error, got %v", err)
	}
}

func TestBuildCodexCLIEnvRemovesAPIKeyOverrides(t *testing.T) {
	env := buildCodexCLIEnv([]string{
		"PATH=/usr/bin",
		"CODEX_HOME=/tmp/codex-home",
		"CODEX_API_KEY=codex-key",
		"OPENAI_API_KEY=openai-key",
		"OPENAI_BASE_URL=https://example.invalid",
	}, "")

	for _, key := range []string{"CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"} {
		if got := envValue(env, key); got != "" {
			t.Fatalf("expected %s to be removed, got %q", key, got)
		}
	}
	if got := envValue(env, "CODEX_HOME"); got != "/tmp/codex-home" {
		t.Fatalf("expected login home to be preserved, got %q", got)
	}
}

func TestConsumeCodexCLIEventKeepsFinalMessageAndIgnoresRetryErrorAfterSuccess(t *testing.T) {
	result := codexCLIResult{}
	consumeCodexCLIEvent(&result, codexCLIEvent{Type: "error", Message: "temporary network error"})
	consumeCodexCLIEvent(&result, codexCLIEvent{Type: "item.completed", Item: codexCLIItem{Type: "agent_message", Text: "draft"}})
	consumeCodexCLIEvent(&result, codexCLIEvent{Type: "item.completed", Item: codexCLIItem{Type: "agent_message", Text: "final answer"}})
	consumeCodexCLIEvent(&result, codexCLIEvent{Type: "item.completed", Item: codexCLIItem{Type: "reasoning", Text: "summary"}})
	consumeCodexCLIEvent(&result, codexCLIEvent{
		Type:  "turn.completed",
		Usage: codexCLIUsage{InputTokens: 10, OutputTokens: 4, ReasoningOutputTokens: 2},
	})

	if !result.Completed || result.Content != "final answer" || result.Thinking != "summary" {
		t.Fatalf("unexpected parsed result: %#v", result)
	}
	if result.TerminalError != "" {
		t.Fatalf("retryable top-level error must not override success: %#v", result)
	}
	if result.Usage.CompletionTokens != 4 || result.Usage.TotalTokens != 14 {
		t.Fatalf("unexpected usage: %#v", result.Usage)
	}
}

func TestCodexCLIProviderChatReadsPromptFromStdinAndParsesJSONL(t *testing.T) {
	restore := overrideCodexCLIForTest(t, "success")
	defer restore()

	provider, err := NewCodexCLIProvider(ai.ProviderConfig{AuthMode: "local-cli"})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	resp, err := provider.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "hello from stdin"}},
	})
	if err != nil {
		t.Fatalf("chat failed: %v", err)
	}
	if resp.Content != "hello from stdin" {
		t.Fatalf("expected helper to echo stdin, got %#v", resp)
	}
	if resp.ReasoningContent != "checked safely" {
		t.Fatalf("expected reasoning summary, got %#v", resp)
	}
	if resp.TokensUsed.CompletionTokens != 3 || resp.TokensUsed.TotalTokens != 8 {
		t.Fatalf("unexpected usage: %#v", resp.TokensUsed)
	}
}

func TestCodexCLIProviderChatRejectsNonSubscriptionAuthBeforeModelRequest(t *testing.T) {
	originalAuthCheck := codexCLIChatGPTAuthCheck
	originalCommandContext := codexCommandContext
	defer func() {
		codexCLIChatGPTAuthCheck = originalAuthCheck
		codexCommandContext = originalCommandContext
	}()

	codexCLIChatGPTAuthCheck = func(context.Context) error {
		return errors.New("Codex CLI is not logged in with a ChatGPT subscription; API key login detected")
	}
	modelStarted := false
	codexCommandContext = func(ctx context.Context, path string, args ...string) *exec.Cmd {
		modelStarted = true
		return originalCommandContext(ctx, path, args...)
	}

	provider, _ := NewCodexCLIProvider(ai.ProviderConfig{AuthMode: "local-cli"})
	_, err := provider.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "must not be sent"}},
	})
	if err == nil || !strings.Contains(err.Error(), "ChatGPT subscription") {
		t.Fatalf("expected subscription auth error, got %v", err)
	}
	if modelStarted {
		t.Fatal("model command must not start when subscription auth validation fails")
	}
}

func TestCheckCodexCLIAuthUsesLoginStatusWithoutModelRequest(t *testing.T) {
	restore := overrideCodexCLIForTest(t, "login-chatgpt")
	defer restore()

	helperCommandContext := codexCommandContext
	var gotArgs []string
	codexCommandContext = func(ctx context.Context, path string, args ...string) *exec.Cmd {
		gotArgs = append([]string(nil), args...)
		return helperCommandContext(ctx, path, args...)
	}

	if err := CheckCodexCLIAuth(context.Background()); err != nil {
		t.Fatalf("check Codex login: %v", err)
	}
	expectedArgs := []string{"login", "status", "-c", codexCLILoginConfigOverride}
	if strings.Join(gotArgs, "\x00") != strings.Join(expectedArgs, "\x00") {
		t.Fatalf("expected login status only, got %#v", gotArgs)
	}
}

func TestCheckCodexCLIAuthRejectsAPIKeyLogin(t *testing.T) {
	restore := overrideCodexCLIForTest(t, "login-api-key")
	defer restore()

	err := CheckCodexCLIAuth(context.Background())
	if err == nil || !strings.Contains(err.Error(), "ChatGPT subscription") || !strings.Contains(err.Error(), "API key") {
		t.Fatalf("expected API key login to be rejected with an actionable error, got %v", err)
	}
}

func TestCheckCodexCLIAuthReportsMissingLogin(t *testing.T) {
	restore := overrideCodexCLIForTest(t, "login-failed")
	defer restore()

	err := CheckCodexCLIAuth(context.Background())
	if err == nil || !strings.Contains(err.Error(), "Not logged in") || !strings.Contains(err.Error(), "codex login") {
		t.Fatalf("expected actionable login error, got %v", err)
	}
}

func TestCodexCLIProviderChatStreamEmitsOneFinalAnswer(t *testing.T) {
	restore := overrideCodexCLIForTest(t, "success")
	defer restore()

	provider, _ := NewCodexCLIProvider(ai.ProviderConfig{AuthMode: "local-cli"})
	var chunks []ai.StreamChunk
	err := provider.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "stream answer"}},
	}, func(chunk ai.StreamChunk) {
		chunks = append(chunks, chunk)
	})
	if err != nil {
		t.Fatalf("stream failed: %v", err)
	}
	if len(chunks) != 3 {
		t.Fatalf("expected thinking, content, done chunks, got %#v", chunks)
	}
	if chunks[0].Thinking != "checked safely" || chunks[1].Content != "stream answer" || !chunks[2].Done {
		t.Fatalf("unexpected stream chunks: %#v", chunks)
	}
}

func TestCodexCLIProviderChatStreamReportsTurnFailure(t *testing.T) {
	restore := overrideCodexCLIForTest(t, "failed")
	defer restore()

	provider, _ := NewCodexCLIProvider(ai.ProviderConfig{AuthMode: "local-cli"})
	var chunks []ai.StreamChunk
	err := provider.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "fail"}},
	}, func(chunk ai.StreamChunk) {
		chunks = append(chunks, chunk)
	})
	if err != nil {
		t.Fatalf("expected callback error convention, got %v", err)
	}
	if len(chunks) != 1 || !chunks[0].Done || !strings.Contains(chunks[0].Error, "not logged in") {
		t.Fatalf("expected terminal authentication error chunk, got %#v", chunks)
	}
}

func TestCodexCLIProviderHonorsCancellation(t *testing.T) {
	restore := overrideCodexCLIForTest(t, "sleep")
	defer restore()

	provider, _ := NewCodexCLIProvider(ai.ProviderConfig{AuthMode: "local-cli"})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := provider.Chat(ctx, ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "cancel"}}})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context cancellation, got %v", err)
	}
}

func TestCodexCLIProviderStopsRunningProcessWhenDeadlineExpires(t *testing.T) {
	restore := overrideCodexCLIForTest(t, "sleep")
	defer restore()

	originalIdle, originalMax := cliStreamIdleTimeout, cliStreamMaxTimeout
	cliStreamIdleTimeout = 200 * time.Millisecond
	cliStreamMaxTimeout = time.Second
	defer func() {
		cliStreamIdleTimeout = originalIdle
		cliStreamMaxTimeout = originalMax
	}()

	provider, _ := NewCodexCLIProvider(ai.ProviderConfig{AuthMode: "local-cli"})
	started := time.Now()
	_, err := provider.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "timeout"}},
	})
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("expected timeout error, got %v", err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("expected the native CLI process to stop promptly, took %s", elapsed)
	}
}

func TestResolveCodexCLICommandUsesNPMVendorBinaryOnWindows(t *testing.T) {
	cmdPath := filepath.Join("npm", "codex.cmd")
	nativePath := filepath.Join(
		"npm", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64",
		"vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe",
	)
	command, err := resolveCodexCLICommand("windows", "amd64", func(name string) (string, error) {
		switch name {
		case "codex.cmd":
			return cmdPath, nil
		case "codex.exe":
			return filepath.Join("windows-apps", "codex.exe"), nil
		default:
			return "", errors.New("not found")
		}
	}, func(path string) bool {
		return path == cmdPath || path == nativePath || path == filepath.Join("windows-apps", "codex.exe")
	})
	if err != nil {
		t.Fatalf("resolve command: %v", err)
	}
	if command.Path != nativePath || len(command.PrefixArgs) != 0 {
		t.Fatalf("unexpected command: %#v", command)
	}
}

func TestCodexNPMNativeBinaryCandidatesSupportsArm64(t *testing.T) {
	candidates := codexNPMNativeBinaryCandidates(filepath.Join("npm", "codex.cmd"), "windows", "arm64")
	if len(candidates) == 0 || !strings.Contains(candidates[0], "codex-win32-arm64") || !strings.Contains(candidates[0], "aarch64-pc-windows-msvc") {
		t.Fatalf("unexpected arm64 candidates: %#v", candidates)
	}
}

func TestCodexNPMPlatformTargetSupportsOfficialPackages(t *testing.T) {
	tests := []struct {
		goos        string
		goarch      string
		wantPackage string
		wantTriple  string
		wantBinary  string
	}{
		{"linux", "amd64", "codex-linux-x64", "x86_64-unknown-linux-musl", "codex"},
		{"linux", "arm64", "codex-linux-arm64", "aarch64-unknown-linux-musl", "codex"},
		{"darwin", "amd64", "codex-darwin-x64", "x86_64-apple-darwin", "codex"},
		{"darwin", "arm64", "codex-darwin-arm64", "aarch64-apple-darwin", "codex"},
		{"windows", "amd64", "codex-win32-x64", "x86_64-pc-windows-msvc", "codex.exe"},
		{"windows", "arm64", "codex-win32-arm64", "aarch64-pc-windows-msvc", "codex.exe"},
	}
	for _, test := range tests {
		t.Run(test.goos+"-"+test.goarch, func(t *testing.T) {
			pkg, triple, binary, ok := codexNPMPlatformTarget(test.goos, test.goarch)
			if !ok || pkg != test.wantPackage || triple != test.wantTriple || binary != test.wantBinary {
				t.Fatalf("unexpected target: package=%q triple=%q binary=%q ok=%v", pkg, triple, binary, ok)
			}
		})
	}
}

func TestCodexCLIHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_CODEX_HELPER") != "1" {
		return
	}
	mode := os.Getenv("GO_CODEX_HELPER_MODE")
	if mode == "login-chatgpt" {
		_, _ = fmt.Fprintln(os.Stdout, "Logged in using ChatGPT")
		return
	}
	if mode == "login-api-key" {
		_, _ = fmt.Fprintln(os.Stdout, "Logged in using an API key")
		return
	}
	if mode == "login-failed" {
		_, _ = fmt.Fprintln(os.Stderr, "Not logged in")
		os.Exit(1)
	}
	if mode == "sleep" {
		time.Sleep(5 * time.Second)
		return
	}
	prompt, _ := io.ReadAll(os.Stdin)
	encoder := json.NewEncoder(os.Stdout)
	if mode == "failed" {
		_ = encoder.Encode(map[string]any{
			"type":  "turn.failed",
			"error": map[string]string{"message": "not logged in; run codex login"},
		})
		return
	}
	_ = encoder.Encode(map[string]any{
		"type": "item.completed",
		"item": map[string]string{"type": "reasoning", "text": "checked safely"},
	})
	_ = encoder.Encode(map[string]any{
		"type": "item.completed",
		"item": map[string]string{"type": "agent_message", "text": strings.TrimSpace(string(prompt))},
	})
	_ = encoder.Encode(map[string]any{
		"type": "turn.completed",
		"usage": map[string]int{
			"input_tokens":            5,
			"cached_input_tokens":     1,
			"output_tokens":           3,
			"reasoning_output_tokens": 1,
		},
	})
}

func overrideCodexCLIForTest(t *testing.T, mode string) func() {
	t.Helper()
	originalLookPath := codexLookPath
	originalCommandContext := codexCommandContext
	originalAuthCheck := codexCLIChatGPTAuthCheck
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("resolve test executable: %v", err)
	}
	codexLookPath = func(name string) (string, error) {
		if name == "codex" || name == "codex.exe" {
			return executable, nil
		}
		return "", fmt.Errorf("unexpected command lookup: %s", name)
	}
	codexCommandContext = func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
		cmd := exec.CommandContext(ctx, executable, "-test.run=TestCodexCLIHelperProcess", "--")
		cmd.Env = append(os.Environ(), "GO_WANT_CODEX_HELPER=1", "GO_CODEX_HELPER_MODE="+mode)
		return cmd
	}
	codexCLIChatGPTAuthCheck = func(context.Context) error { return nil }
	return func() {
		codexLookPath = originalLookPath
		codexCommandContext = originalCommandContext
		codexCLIChatGPTAuthCheck = originalAuthCheck
	}
}
