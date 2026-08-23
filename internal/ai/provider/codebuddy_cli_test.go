package provider

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
)

func TestBuildCodeBuddyCLIEnv_IncludesOfficialEnvNames(t *testing.T) {
	env, err := buildCodeBuddyCLIEnv(ai.ProviderConfig{
		BaseURL: "https://gateway.codebuddy.example/",
		APIKey:  "cb-test",
		Headers: map[string]string{
			"X-Workspace": "gonavi",
		},
	}, []string{"PATH=/usr/bin"}, "darwin", func(name string) (string, error) {
		return "", errors.New("unexpected lookup")
	}, func(path string) bool {
		return false
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if got := envValue(env, "CODEBUDDY_BASE_URL"); got != "https://gateway.codebuddy.example" {
		t.Fatalf("expected trimmed base url, got %q", got)
	}
	if got := envValue(env, "CODEBUDDY_API_KEY"); got != "cb-test" {
		t.Fatalf("expected api key in env, got %q", got)
	}
	if got := envValue(env, "CODEBUDDY_AUTH_TOKEN"); got != "cb-test" {
		t.Fatalf("expected auth token in env, got %q", got)
	}
	if got := envValue(env, "CODEBUDDY_CUSTOM_HEADERS"); !strings.Contains(got, `"X-Workspace":"gonavi"`) {
		t.Fatalf("expected custom headers JSON in env, got %q", got)
	}
}

func TestBuildCodeBuddyCLIEnv_AllowsMissingGitBashOnWindows(t *testing.T) {
	env, err := buildCodeBuddyCLIEnv(ai.ProviderConfig{}, []string{"ProgramFiles=C:\\Program Files"}, "windows", func(name string) (string, error) {
		return "", errors.New("not found")
	}, func(path string) bool {
		return false
	})
	if err != nil {
		t.Fatalf("expected no error when git bash is missing on windows, got %v", err)
	}
	if got := envValue(env, "CODEBUDDY_CODE_GIT_BASH_PATH"); got != "" {
		t.Fatalf("expected no git bash env when missing, got %q", got)
	}
}

func TestResolveCodeBuddyGitBashPathPrefersGitForWindowsOverWSLLauncher(t *testing.T) {
	const (
		wslBash = `C:\Windows\System32\bash.exe`
		gitExe  = `C:\Program Files\Git\cmd\git.exe`
		gitBash = `C:\Program Files\Git\bin\bash.exe`
	)

	got, err := resolveCodeBuddyGitBashPath(nil, "windows", func(name string) (string, error) {
		switch name {
		case "bash.exe", "bash":
			return wslBash, nil
		case "git.exe":
			return gitExe, nil
		default:
			return "", errors.New("not found")
		}
	}, func(path string) bool {
		return path == wslBash || path == gitExe || path == gitBash
	})
	if err != nil {
		t.Fatalf("resolve CodeBuddy Git Bash: %v", err)
	}
	if got != gitBash {
		t.Fatalf("expected Git for Windows bash %q, got %q", gitBash, got)
	}
}

func TestResolveCodeBuddyGitBashPathRejectsConfiguredWSLLauncher(t *testing.T) {
	const wslBash = `C:\Users\tester\AppData\Local\Microsoft\WindowsApps\bash.exe`
	_, err := resolveCodeBuddyGitBashPath(
		[]string{"CODEBUDDY_CODE_GIT_BASH_PATH=" + wslBash},
		"windows",
		func(name string) (string, error) { return "", errors.New("not found") },
		func(path string) bool { return path == wslBash },
	)
	if err == nil || !strings.Contains(err.Error(), "WSL launcher") {
		t.Fatalf("expected actionable WSL launcher error, got %v", err)
	}
}

func TestResolveCodeBuddyGitBashPathIgnoresPATHWSLLauncher(t *testing.T) {
	const wslBash = `C:\Windows\System32\bash.exe`
	got, err := resolveCodeBuddyGitBashPath(nil, "windows", func(name string) (string, error) {
		if name == "bash.exe" || name == "bash" {
			return wslBash, nil
		}
		return "", errors.New("not found")
	}, func(path string) bool { return path == wslBash })
	if err != nil {
		t.Fatalf("expected missing Git Bash to remain optional for CodeBuddy, got %v", err)
	}
	if got != "" {
		t.Fatalf("expected PATH WSL launcher to be ignored, got %q", got)
	}
}

func TestCodeBuddyCLIProvider_ChatParsesJSONEventArray(t *testing.T) {
	fakeCodeBuddy := writeFakeCodeBuddyScript(t, "#!/bin/sh\necho '[{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hello \"}]}},{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"hello world\"}]'\n")
	restore := overrideCodeBuddyCLIForTest(t, fakeCodeBuddy)
	defer restore()

	provider, err := NewCodeBuddyCLIProvider(ai.ProviderConfig{
		APIKey: "cb-test",
	})
	if err != nil {
		t.Fatalf("unexpected provider error: %v", err)
	}

	resp, err := provider.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping"}},
	})
	if err != nil {
		t.Fatalf("expected chat to succeed, got %v", err)
	}
	if resp.Content != "hello world" {
		t.Fatalf("expected result content, got %#v", resp)
	}
}

func TestCodeBuddyCLIProvider_ChatPreservesExecutionFailureDetails(t *testing.T) {
	fakeCodeBuddy := writeFakeCodeBuddyScript(t, "#!/bin/sh\necho 'partial output'\necho 'specific failure' >&2\nexit 7\n")
	restore := overrideCodeBuddyCLIForTest(t, fakeCodeBuddy)
	defer restore()

	provider, err := NewCodeBuddyCLIProvider(ai.ProviderConfig{APIKey: "cb-test"})
	if err != nil {
		t.Fatalf("unexpected provider error: %v", err)
	}

	_, err = provider.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping"}},
	})
	if err == nil {
		t.Fatal("expected CodeBuddy CLI execution error")
	}
	for _, want := range []string{"stderr: specific failure", "stdout: 15 bytes omitted", "error: exit status 7"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("expected execution error to contain %q, got %q", want, err.Error())
		}
	}
	if strings.Contains(err.Error(), "partial output") {
		t.Fatalf("expected execution error to omit raw stdout, got %q", err.Error())
	}
}

func TestCodeBuddyCLIProviderChatWithState_StartsTrackedSession(t *testing.T) {
	fakeCodeBuddy := writeFakeCodeBuddyScript(t, "#!/bin/sh\necho '[{\"type\":\"assistant\",\"session_id\":\"session-new\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hello \"}]}},{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"hello world\",\"session_id\":\"session-new\"}]'\n")
	var capturedArgs []string
	restore := overrideCodeBuddyCLIForTestWithCapture(t, fakeCodeBuddy, func(args []string) {
		capturedArgs = append([]string(nil), args...)
	})
	defer restore()

	providerInstance, err := NewCodeBuddyCLIProvider(ai.ProviderConfig{
		APIKey: "cb-test",
		Model:  "deepseek-v3",
	})
	if err != nil {
		t.Fatalf("unexpected provider error: %v", err)
	}

	resp, nextState, err := providerInstance.(SessionChatProvider).ChatWithState(
		context.Background(),
		nil,
		ai.ChatRequest{
			Messages: []ai.Message{{Role: "user", Content: "ping"}},
		},
	)
	if err != nil {
		t.Fatalf("expected chat with state to succeed, got %v", err)
	}

	if resp == nil || resp.Content != "hello world" {
		t.Fatalf("unexpected response: %#v", resp)
	}
	if string(nextState) != `{"sessionId":"session-new"}` {
		t.Fatalf("expected new session state, got %s", string(nextState))
	}
	if !hasArg(capturedArgs, "--enable-session-tracking") {
		t.Fatalf("expected session tracking flag, got args %#v", capturedArgs)
	}
	if hasArg(capturedArgs, "--no-session-persistence") {
		t.Fatalf("did not expect no-session-persistence flag, got args %#v", capturedArgs)
	}
	if hasArg(capturedArgs, "--resume") {
		t.Fatalf("did not expect resume flag for first session, got args %#v", capturedArgs)
	}
	if !hasArgSequence(capturedArgs, "--model", "deepseek-v3") {
		t.Fatalf("expected model flag to be preserved, got args %#v", capturedArgs)
	}
}

func TestCodeBuddyCLIProviderChatWithState_ResumesExistingSession(t *testing.T) {
	fakeCodeBuddy := writeFakeCodeBuddyScript(t, "#!/bin/sh\necho '[{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"continued\"}]}}]'\n")
	var capturedArgs []string
	restore := overrideCodeBuddyCLIForTestWithCapture(t, fakeCodeBuddy, func(args []string) {
		capturedArgs = append([]string(nil), args...)
	})
	defer restore()

	providerInstance, err := NewCodeBuddyCLIProvider(ai.ProviderConfig{
		APIKey: "cb-test",
	})
	if err != nil {
		t.Fatalf("unexpected provider error: %v", err)
	}

	resp, nextState, err := providerInstance.(SessionChatProvider).ChatWithState(
		context.Background(),
		json.RawMessage(`{"sessionId":"session-existing"}`),
		ai.ChatRequest{
			Messages: []ai.Message{{Role: "user", Content: "ping again"}},
		},
	)
	if err != nil {
		t.Fatalf("expected resumed chat with state to succeed, got %v", err)
	}

	if resp == nil || resp.Content != "continued" {
		t.Fatalf("unexpected response: %#v", resp)
	}
	if string(nextState) != `{"sessionId":"session-existing"}` {
		t.Fatalf("expected existing session state to be preserved, got %s", string(nextState))
	}
	if !hasArgSequence(capturedArgs, "--resume", "session-existing") {
		t.Fatalf("expected resume args, got %#v", capturedArgs)
	}
	if !hasArg(capturedArgs, "--enable-session-tracking") {
		t.Fatalf("expected session tracking flag, got args %#v", capturedArgs)
	}
}

func TestCodeBuddyCLIProviderChatStreamWithState_StartsTrackedSession(t *testing.T) {
	fakeCodeBuddy := writeFakeCodeBuddyScript(t, "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"system\",\"session_id\":\"session-new\"}' '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hello from codebuddy\"}]}}' '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"hello from codebuddy\",\"session_id\":\"session-new\"}'\n")
	var capturedArgs []string
	restore := overrideCodeBuddyCLIForTestWithCapture(t, fakeCodeBuddy, func(args []string) {
		capturedArgs = append([]string(nil), args...)
	})
	defer restore()

	providerInstance, err := NewCodeBuddyCLIProvider(ai.ProviderConfig{
		APIKey: "cb-test",
		Model:  "deepseek-v3",
	})
	if err != nil {
		t.Fatalf("unexpected provider error: %v", err)
	}

	var chunks []ai.StreamChunk
	nextState, err := providerInstance.(SessionStreamProvider).ChatStreamWithState(
		context.Background(),
		nil,
		ai.ChatRequest{
			Messages: []ai.Message{{Role: "user", Content: "ping"}},
		},
		func(chunk ai.StreamChunk) {
			chunks = append(chunks, chunk)
		},
	)
	if err != nil {
		t.Fatalf("expected chat stream with state to succeed, got %v", err)
	}

	if string(nextState) != `{"sessionId":"session-new"}` {
		t.Fatalf("expected new session state, got %s", string(nextState))
	}
	if len(chunks) < 2 || chunks[0].Content != "hello from codebuddy" || !chunks[len(chunks)-1].Done {
		t.Fatalf("unexpected stream chunks: %#v", chunks)
	}
	if !hasArg(capturedArgs, "--enable-session-tracking") {
		t.Fatalf("expected session tracking flag, got args %#v", capturedArgs)
	}
	if hasArg(capturedArgs, "--no-session-persistence") {
		t.Fatalf("did not expect no-session-persistence flag, got args %#v", capturedArgs)
	}
	if hasArg(capturedArgs, "--resume") {
		t.Fatalf("did not expect resume flag for first session, got args %#v", capturedArgs)
	}
	if !hasArgSequence(capturedArgs, "--model", "deepseek-v3") {
		t.Fatalf("expected model flag to be preserved, got args %#v", capturedArgs)
	}
}

func TestCodeBuddyCLIProviderChatStreamWithState_ResumesExistingSessionWithoutDroppingState(t *testing.T) {
	fakeCodeBuddy := writeFakeCodeBuddyScript(t, "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"continued\"}]}}' '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"continued\"}'\n")
	var capturedArgs []string
	restore := overrideCodeBuddyCLIForTestWithCapture(t, fakeCodeBuddy, func(args []string) {
		capturedArgs = append([]string(nil), args...)
	})
	defer restore()

	providerInstance, err := NewCodeBuddyCLIProvider(ai.ProviderConfig{
		APIKey: "cb-test",
	})
	if err != nil {
		t.Fatalf("unexpected provider error: %v", err)
	}

	var chunks []ai.StreamChunk
	nextState, err := providerInstance.(SessionStreamProvider).ChatStreamWithState(
		context.Background(),
		json.RawMessage(`{"sessionId":"session-existing"}`),
		ai.ChatRequest{
			Messages: []ai.Message{{Role: "user", Content: "ping again"}},
		},
		func(chunk ai.StreamChunk) {
			chunks = append(chunks, chunk)
		},
	)
	if err != nil {
		t.Fatalf("expected resumed chat stream to succeed, got %v", err)
	}

	if string(nextState) != `{"sessionId":"session-existing"}` {
		t.Fatalf("expected existing session state to be preserved, got %s", string(nextState))
	}
	if len(chunks) < 2 || chunks[0].Content != "continued" || !chunks[len(chunks)-1].Done {
		t.Fatalf("unexpected stream chunks: %#v", chunks)
	}
	if !hasArgSequence(capturedArgs, "--resume", "session-existing") {
		t.Fatalf("expected resume args, got %#v", capturedArgs)
	}
	if !hasArg(capturedArgs, "--enable-session-tracking") {
		t.Fatalf("expected session tracking flag, got args %#v", capturedArgs)
	}
	if hasArg(capturedArgs, "--no-session-persistence") {
		t.Fatalf("did not expect no-session-persistence flag, got args %#v", capturedArgs)
	}
}

func writeFakeCodeBuddyScript(t *testing.T, content string) string {
	t.Helper()
	tempRoot := t.TempDir()
	dir := filepath.Join(tempRoot, "包含 空格")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("failed to create fake CodeBuddy directory: %v", err)
	}

	if runtime.GOOS == "windows" {
		bashPath, err := resolveClaudeCodeGitBashPath(os.Environ(), runtime.GOOS, exec.LookPath, fileExists)
		if err != nil {
			t.Fatalf("failed to resolve git bash for fake codebuddy command: %v", err)
		}

		scriptPath := filepath.Join(dir, "codebuddy.sh")
		if err := os.WriteFile(scriptPath, []byte(content), 0o755); err != nil {
			t.Fatalf("failed to write fake codebuddy shell script: %v", err)
		}

		wrapperPath := filepath.Join(tempRoot, "codebuddy.cmd")
		wrapper := "@echo off\r\n\"" + bashPath + "\" \"" + scriptPath + "\" %*\r\n"
		if err := os.WriteFile(wrapperPath, []byte(wrapper), 0o755); err != nil {
			t.Fatalf("failed to write fake codebuddy wrapper: %v", err)
		}
		return wrapperPath
	}

	path := filepath.Join(dir, "codebuddy")
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatalf("failed to write fake codebuddy script: %v", err)
	}
	return path
}

func overrideCodeBuddyCLIForTest(t *testing.T, fakeCodeBuddyPath string) func() {
	t.Helper()

	originalLookPath := codebuddyLookPath
	originalCommandContext := codebuddyCommandContext
	codebuddyLookPath = func(name string) (string, error) {
		if name == "codebuddy" || name == "cbc" {
			return fakeCodeBuddyPath, nil
		}
		return originalLookPath(name)
	}
	codebuddyCommandContext = func(ctx context.Context, name string, args ...string) *exec.Cmd {
		if name == "codebuddy" || name == "cbc" {
			return exec.CommandContext(ctx, fakeCodeBuddyPath, args...)
		}
		return originalCommandContext(ctx, name, args...)
	}

	originalPath := os.Getenv("PATH")
	if err := os.Setenv("PATH", filepath.Dir(fakeCodeBuddyPath)+string(os.PathListSeparator)+originalPath); err != nil {
		t.Fatalf("failed to override PATH: %v", err)
	}

	return func() {
		codebuddyLookPath = originalLookPath
		codebuddyCommandContext = originalCommandContext
		_ = os.Setenv("PATH", originalPath)
	}
}

func overrideCodeBuddyCLIForTestWithCapture(t *testing.T, fakeCodeBuddyPath string, capture func(args []string)) func() {
	t.Helper()

	originalLookPath := codebuddyLookPath
	originalCommandContext := codebuddyCommandContext
	codebuddyLookPath = func(name string) (string, error) {
		if name == "codebuddy" || name == "cbc" {
			return fakeCodeBuddyPath, nil
		}
		return originalLookPath(name)
	}
	codebuddyCommandContext = func(ctx context.Context, name string, args ...string) *exec.Cmd {
		if name == "codebuddy" || name == "cbc" {
			if capture != nil {
				capture(args)
			}
			return exec.CommandContext(ctx, fakeCodeBuddyPath, args...)
		}
		return originalCommandContext(ctx, name, args...)
	}

	originalPath := os.Getenv("PATH")
	if err := os.Setenv("PATH", filepath.Dir(fakeCodeBuddyPath)+string(os.PathListSeparator)+originalPath); err != nil {
		t.Fatalf("failed to override PATH: %v", err)
	}

	return func() {
		codebuddyLookPath = originalLookPath
		codebuddyCommandContext = originalCommandContext
		_ = os.Setenv("PATH", originalPath)
	}
}

func hasArg(args []string, target string) bool {
	for _, arg := range args {
		if arg == target {
			return true
		}
	}
	return false
}

func hasArgSequence(args []string, key string, value string) bool {
	for index := 0; index < len(args)-1; index++ {
		if args[index] == key && args[index+1] == value {
			return true
		}
	}
	return false
}
