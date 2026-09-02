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
	"time"

	"GoNavi-Wails/internal/ai"
)

func TestBuildClaudeCLIEnv_IncludesAnthropicProxyEnv(t *testing.T) {
	env, err := buildClaudeCLIEnv(ai.ProviderConfig{
		BaseURL: "https://proxy.example.com/",
		APIKey:  "sk-test",
	}, []string{"PATH=/usr/bin"}, "darwin", func(name string) (string, error) {
		return "", errors.New("unexpected lookup")
	}, func(path string) bool {
		return false
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if got := envValue(env, "ANTHROPIC_BASE_URL"); got != "https://proxy.example.com" {
		t.Fatalf("expected trimmed base url, got %q", got)
	}
	if got := envValue(env, "ANTHROPIC_API_KEY"); got != "sk-test" {
		t.Fatalf("expected api key in env, got %q", got)
	}
	if got := envValue(env, "ANTHROPIC_AUTH_TOKEN"); got != "sk-test" {
		t.Fatalf("expected auth token in env, got %q", got)
	}
}

func TestBuildClaudeCLIEnv_LocalAuthRemovesAPIOverrides(t *testing.T) {
	env, err := buildClaudeCLIEnv(ai.ProviderConfig{
		AuthMode: "local-cli",
		BaseURL:  "https://proxy.example",
		APIKey:   "should-not-be-used",
	}, []string{
		"PATH=/usr/bin",
		"ANTHROPIC_BASE_URL=https://environment-proxy.example",
		"ANTHROPIC_AUTH_TOKEN=environment-token",
		"ANTHROPIC_API_KEY=environment-key",
		"ANTHROPIC_FOUNDRY_API_KEY=foundry-key",
		"AWS_ACCESS_KEY_ID=aws-access-key",
		"CLAUDE_API_KEY=claude-api-key",
		"CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR=9",
		"CLAUDE_CODE_USE_BEDROCK=1",
		"CLAUDE_CODE_USE_VERTEX=1",
		"CLAUDE_CODE_USE_FOUNDRY=1",
		"CLAUDE_CODE_USE_MANTLE=1",
		"CLAUDE_CODE_USE_ANTHROPIC_AWS=1",
		"GOOGLE_APPLICATION_CREDENTIALS=/tmp/google-credentials.json",
		"CLAUDE_CONFIG_DIR=/tmp/claude-config",
		"CLAUDE_CODE_OAUTH_TOKEN=oauth-token",
	}, "darwin", func(name string) (string, error) {
		return "", errors.New("unexpected lookup")
	}, func(path string) bool {
		return false
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	for _, key := range []string{
		"ANTHROPIC_BASE_URL",
		"ANTHROPIC_AUTH_TOKEN",
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_FOUNDRY_API_KEY",
		"AWS_ACCESS_KEY_ID",
		"CLAUDE_API_KEY",
		"CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
		"CLAUDE_CODE_USE_BEDROCK",
		"CLAUDE_CODE_USE_VERTEX",
		"CLAUDE_CODE_USE_FOUNDRY",
		"CLAUDE_CODE_USE_MANTLE",
		"CLAUDE_CODE_USE_ANTHROPIC_AWS",
		"GOOGLE_APPLICATION_CREDENTIALS",
	} {
		if got := envValue(env, key); got != "" {
			t.Fatalf("expected %s to be removed in local auth mode, got %q", key, got)
		}
	}
	if got := envValue(env, "CLAUDE_CONFIG_DIR"); got != "/tmp/claude-config" {
		t.Fatalf("expected Claude config directory to be preserved for OAuth, got %q", got)
	}
	if got := envValue(env, "CLAUDE_CODE_OAUTH_TOKEN"); got != "oauth-token" {
		t.Fatalf("expected OAuth token to be preserved, got %q", got)
	}
	for _, key := range claudeCLILocalAuthIsolationEnvKeys {
		if got := envValue(env, key); got != "1" {
			t.Fatalf("expected %s=1 in local auth mode, got %q", key, got)
		}
	}
}

func TestBuildClaudeCLIArgs_LocalAuthKeepsPromptOutOfArgvAndDisablesTools(t *testing.T) {
	args := buildClaudeCLIArgs(ai.ProviderConfig{AuthMode: "local-cli"}, "private prompt", true)
	if strings.Contains(strings.Join(args, " "), "private prompt") {
		t.Fatalf("expected prompt to stay out of argv, got %#v", args)
	}
	if !hasArgSequence(args, "--tools", "") {
		t.Fatalf("expected tools to be disabled, got %#v", args)
	}
	if !hasArgSequence(args, "--permission-mode", "dontAsk") {
		t.Fatalf("expected non-interactive permission mode, got %#v", args)
	}
	if !hasArg(args, "--print") || hasArg(args, "-p") {
		t.Fatalf("expected stdin-based --print mode without a prompt argument, got %#v", args)
	}
	if !hasArgSequence(args, "--setting-sources", "user") {
		t.Fatalf("expected user settings source so Claude 2.1.132 can load OAuth, got %#v", args)
	}
	if !hasArgSequence(args, "--settings", claudeCLILocalAuthSettings) {
		t.Fatalf("expected inline hook and CLAUDE.md isolation settings, got %#v", args)
	}
	for _, expected := range []string{"--disable-slash-commands", "--no-chrome", "--no-session-persistence"} {
		if !hasArg(args, expected) {
			t.Fatalf("expected %q in args, got %#v", expected, args)
		}
	}
	if !hasArg(args, "--strict-mcp-config") {
		t.Fatalf("expected MCP configuration isolation, got %#v", args)
	}
	if hasArg(args, "--bare") {
		t.Fatalf("--bare disables OAuth and must not be used for subscription auth: %#v", args)
	}
}

func TestClaudeCLILocalAuthSettingsNeutralizeUserEnvironmentOverrides(t *testing.T) {
	var settings struct {
		APIKeyHelper string `json:"apiKeyHelper"`
		Env          any    `json:"env"`
	}
	if err := json.Unmarshal([]byte(claudeCLILocalAuthSettings), &settings); err != nil {
		t.Fatalf("parse isolation settings: %v", err)
	}
	if settings.APIKeyHelper != "" {
		t.Fatalf("expected user apiKeyHelper to be disabled, got %q", settings.APIKeyHelper)
	}
	if settings.Env != nil {
		t.Fatalf("expected complete user settings env block to be neutralized, got %#v", settings.Env)
	}
}

func TestValidateClaudeCLISubscriptionStatus(t *testing.T) {
	tests := []struct {
		name       string
		status     claudeCLIAuthStatus
		wantErr    bool
		wantDetail string
	}{
		{
			name: "oauth subscription",
			status: claudeCLIAuthStatus{
				LoggedIn:    true,
				AuthMethod:  "oauth_token",
				APIProvider: "firstParty",
			},
		},
		{
			name:       "logged out",
			status:     claudeCLIAuthStatus{},
			wantErr:    true,
			wantDetail: "claude auth login",
		},
		{
			name: "api key override",
			status: claudeCLIAuthStatus{
				LoggedIn:     true,
				AuthMethod:   "oauth_token",
				APIProvider:  "firstParty",
				APIKeySource: "ANTHROPIC_API_KEY",
			},
			wantErr:    true,
			wantDetail: "ANTHROPIC_API_KEY",
		},
		{
			name: "third-party provider",
			status: claudeCLIAuthStatus{
				LoggedIn:    true,
				AuthMethod:  "oauth_token",
				APIProvider: "bedrock",
			},
			wantErr:    true,
			wantDetail: "bedrock",
		},
		{
			name: "non-oauth method",
			status: claudeCLIAuthStatus{
				LoggedIn:    true,
				AuthMethod:  "api_key",
				APIProvider: "firstParty",
			},
			wantErr:    true,
			wantDetail: "api_key",
		},
		{
			name: "misleading oauth substring",
			status: claudeCLIAuthStatus{
				LoggedIn:    true,
				AuthMethod:  "not_oauth",
				APIProvider: "firstParty",
			},
			wantErr:    true,
			wantDetail: "not_oauth",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateClaudeCLISubscriptionStatus(tt.status)
			if (err != nil) != tt.wantErr {
				t.Fatalf("validate status error = %v, wantErr %v", err, tt.wantErr)
			}
			if tt.wantDetail != "" && (err == nil || !strings.Contains(err.Error(), tt.wantDetail)) {
				t.Fatalf("expected error containing %q, got %v", tt.wantDetail, err)
			}
		})
	}
}

func TestCheckClaudeCLILocalAuthUsesStatusWithoutModelRequest(t *testing.T) {
	restore := overrideClaudeCLIWithTestProcess(t, "auth-success")
	defer restore()

	if err := CheckClaudeCLILocalAuth(context.Background()); err != nil {
		t.Fatalf("expected OAuth status check success, got %v", err)
	}
}

func TestCheckClaudeCLILocalAuthReportsLoggedOutStatus(t *testing.T) {
	restore := overrideClaudeCLIWithTestProcess(t, "logged-out")
	defer restore()

	err := CheckClaudeCLILocalAuth(context.Background())
	if err == nil || !strings.Contains(err.Error(), "claude auth login") {
		t.Fatalf("expected actionable logged-out error, got %v", err)
	}
}

func TestClaudeCLILocalAuthRejectsAPIKeyOverrideBeforeChatAndStream(t *testing.T) {
	restore := overrideClaudeCLIWithTestProcess(t, "api-key-override")
	defer restore()

	provider, err := NewClaudeCLIProvider(ai.ProviderConfig{AuthMode: "local-cli"})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	request := ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "ping"}}}

	if _, err := provider.Chat(context.Background(), request); err == nil || !strings.Contains(err.Error(), "apiKeyHelper") {
		t.Fatalf("expected Chat to reject API key override before model request, got %v", err)
	}
	if err := provider.ChatStream(context.Background(), request, func(ai.StreamChunk) {}); err == nil || !strings.Contains(err.Error(), "apiKeyHelper") {
		t.Fatalf("expected ChatStream to reject API key override before model request, got %v", err)
	}
}

func TestCheckClaudeCLILocalAuthReturnsContextCanceled(t *testing.T) {
	restore := overrideClaudeCLIWithTestProcess(t, "sleep")
	defer restore()

	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)
	err := CheckClaudeCLILocalAuth(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled from auth status, got %v", err)
	}
}

func TestClaudeCLIChatReturnsContextCanceled(t *testing.T) {
	restore := overrideClaudeCLIWithTestProcess(t, "sleep")
	defer restore()

	provider, err := NewClaudeCLIProvider(ai.ProviderConfig{
		BaseURL: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
		APIKey:  "qwen-key",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)
	_, err = provider.Chat(ctx, ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "ping"}}})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled from Chat, got %v", err)
	}
}

func TestClaudeCLIChatStreamReturnsContextCanceledWithoutErrorChunk(t *testing.T) {
	restore := overrideClaudeCLIWithTestProcess(t, "sleep")
	defer restore()

	provider, err := NewClaudeCLIProvider(ai.ProviderConfig{
		BaseURL: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
		APIKey:  "qwen-key",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)
	var chunks []ai.StreamChunk
	err = provider.ChatStream(ctx, ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "ping"}}}, func(chunk ai.StreamChunk) {
		chunks = append(chunks, chunk)
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled from ChatStream, got %v", err)
	}
	if len(chunks) != 0 {
		t.Fatalf("cancellation must not emit a user-facing error chunk, got %#v", chunks)
	}
}

func TestBuildClaudeCLIArgs_ProxyModePreservesExistingPromptArgument(t *testing.T) {
	args := buildClaudeCLIArgs(ai.ProviderConfig{}, "proxy prompt", false)
	if !hasArgSequence(args, "-p", "proxy prompt") {
		t.Fatalf("expected proxy mode to preserve argv prompt for compatibility, got %#v", args)
	}
}

func TestBuildClaudeCLIRequestLogBodyRedactsSecretsAndKeepsRequestShape(t *testing.T) {
	prompt := "请分析订单表。临时凭证 Bearer abcdefghijklmnopqrstuvwxyz，另一个 key 是 sk-live-abcdefghijklmnopqrstuvwxyz"
	args := []string{"-p", prompt, "--output-format", "stream-json", "--model", "claude-sonnet"}
	originalPromptArg := args[1]

	body := buildClaudeCLIRequestLogBody("stream-json", args, prompt, ai.ProviderConfig{
		BaseURL: "https://proxy.example.com/api/anthropic?key=proxy-secret&alt=sse",
		APIKey:  "sk-config-secret-1234567890",
		Model:   "claude-sonnet",
	}, ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: prompt}},
		Tools: []ai.Tool{{
			Type: "function",
			Function: ai.ToolFunction{
				Name:        "inspect_ai_upstream_logs",
				Description: "读取 AI 上游请求日志",
			},
		}},
	})

	got := formatAIUpstreamRequestLogBody(body)

	for _, want := range []string{
		`"command":"claude"`,
		`"output_format":"stream-json"`,
		`"model":"claude-sonnet"`,
		`"has_api_key":true`,
		`"message_count":1`,
		`"tool_count":1`,
		`"[prompt logged separately]"`,
		`inspect_ai_upstream_logs`,
		`key=%5BREDACTED%5D`,
		`[REDACTED]`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected Claude CLI request log body to contain %q, got %s", want, got)
		}
	}

	for _, leaked := range []string{
		"proxy-secret",
		"sk-config-secret",
		"Bearer abcdefghijklmnopqrstuvwxyz",
		"sk-live-abcdefghijklmnopqrstuvwxyz",
	} {
		if strings.Contains(got, leaked) {
			t.Fatalf("Claude CLI request log body leaked %q: %s", leaked, got)
		}
	}
	if args[1] != originalPromptArg {
		t.Fatalf("expected original args to remain unchanged, got %q", args[1])
	}
}

func TestBuildClaudeCLIEnv_UsesDetectedGitBashOnWindows(t *testing.T) {
	env, err := buildClaudeCLIEnv(ai.ProviderConfig{}, []string{"ProgramFiles=C:\\Program Files"}, "windows", func(name string) (string, error) {
		switch name {
		case "bash.exe":
			return "", errors.New("not found")
		case "bash":
			return "", errors.New("not found")
		case "git.exe":
			return "C:\\Program Files\\Git\\cmd\\git.exe", nil
		default:
			return "", errors.New("unexpected lookup")
		}
	}, func(path string) bool {
		return path == `C:\Program Files\Git\bin\bash.exe`
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if got := envValue(env, "CLAUDE_CODE_GIT_BASH_PATH"); got != `C:\Program Files\Git\bin\bash.exe` {
		t.Fatalf("expected detected git bash path, got %q", got)
	}
}

func TestResolveClaudeCodeGitBashPathPrefersGitForWindowsOverWSLLauncher(t *testing.T) {
	const (
		wslBash = `C:\Windows\System32\bash.exe`
		gitExe  = `C:\Program Files\Git\cmd\git.exe`
		gitBash = `C:\Program Files\Git\bin\bash.exe`
	)

	got, err := resolveClaudeCodeGitBashPath(nil, "windows", func(name string) (string, error) {
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
		t.Fatalf("resolve Claude Code Git Bash: %v", err)
	}
	if got != gitBash {
		t.Fatalf("expected Git for Windows bash %q, got %q", gitBash, got)
	}
}

func TestResolveClaudeCodeGitBashPathRejectsConfiguredWSLLauncher(t *testing.T) {
	const wslBash = `C:\Windows\System32\bash.exe`
	_, err := resolveClaudeCodeGitBashPath(
		[]string{"CLAUDE_CODE_GIT_BASH_PATH=" + wslBash},
		"windows",
		func(name string) (string, error) { return "", errors.New("not found") },
		func(path string) bool { return path == wslBash },
	)
	if err == nil || !strings.Contains(err.Error(), "WSL launcher") {
		t.Fatalf("expected actionable WSL launcher error, got %v", err)
	}
}

func TestResolveClaudeCodeGitBashPathIgnoresPATHWSLLauncher(t *testing.T) {
	const wslBash = `C:\Windows\System32\bash.exe`
	_, err := resolveClaudeCodeGitBashPath(nil, "windows", func(name string) (string, error) {
		if name == "bash.exe" || name == "bash" {
			return wslBash, nil
		}
		return "", errors.New("not found")
	}, func(path string) bool { return path == wslBash })
	if err == nil || !strings.Contains(err.Error(), "Install Git for Windows") {
		t.Fatalf("expected PATH WSL launcher to be ignored with an install hint, got %v", err)
	}
}

func TestBuildClaudeCLIEnv_ReturnsActionableErrorWhenGitBashMissingOnWindows(t *testing.T) {
	_, err := buildClaudeCLIEnv(ai.ProviderConfig{}, []string{"ProgramFiles=C:\\Program Files"}, "windows", func(name string) (string, error) {
		return "", errors.New("not found")
	}, func(path string) bool {
		return false
	})
	if err == nil {
		t.Fatal("expected error when git bash is missing on windows")
	}
	if !strings.Contains(err.Error(), "git-bash") {
		t.Fatalf("expected git-bash hint, got %v", err)
	}
	if !strings.Contains(err.Error(), "CLAUDE_CODE_GIT_BASH_PATH") {
		t.Fatalf("expected env var hint, got %v", err)
	}
	for _, notWant := range []string{
		"在 Windows 下需要",
		"请安装",
		"如果已安装",
		"指向",
	} {
		if strings.Contains(err.Error(), notWant) {
			t.Fatalf("expected English git-bash error, got %q", err.Error())
		}
	}
}

func TestClaudeCLIProviderValidateReturnsEnglishInstallHintWhenCommandMissing(t *testing.T) {
	originalLookPath := claudeLookPath
	claudeLookPath = func(name string) (string, error) {
		return "", errors.New("not found")
	}
	defer func() {
		claudeLookPath = originalLookPath
	}()

	provider, err := NewClaudeCLIProvider(ai.ProviderConfig{})
	if err != nil {
		t.Fatalf("create provider failed: %v", err)
	}

	err = provider.Validate()
	if err == nil {
		t.Fatal("expected missing claude command error")
	}
	const want = "claude command was not found; install Claude Code CLI first: npm install -g @anthropic-ai/claude-code"
	if err.Error() != want {
		t.Fatalf("expected %q, got %q", want, err.Error())
	}
	if strings.Contains(err.Error(), "未找到 claude 命令") || strings.Contains(err.Error(), "请先安装") {
		t.Fatalf("expected English missing claude error, got %q", err.Error())
	}
}

func TestResolveClaudeCLICommandUsesNPMNativeBinaryOnWindows(t *testing.T) {
	cmdPath := filepath.Join("npm", "claude.cmd")
	nativePath := filepath.Join("npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
	standalonePath := filepath.Join("standalone", "claude.exe")

	command, err := resolveClaudeCLICommand("windows", "amd64", func(name string) (string, error) {
		switch name {
		case "claude.cmd":
			return cmdPath, nil
		case "claude.exe":
			return standalonePath, nil
		default:
			return "", errors.New("not found")
		}
	}, func(path string) bool {
		return path == cmdPath || path == nativePath || path == standalonePath
	})
	if err != nil {
		t.Fatalf("resolve Claude CLI command: %v", err)
	}
	if command.Path != nativePath {
		t.Fatalf("expected npm native binary %q, got %#v", nativePath, command)
	}
}

func TestResolveClaudeCLICommandFallsBackToStandaloneExeOnWindows(t *testing.T) {
	cmdPath := filepath.Join("npm", "claude.cmd")
	standalonePath := filepath.Join("standalone", "claude.exe")

	command, err := resolveClaudeCLICommand("windows", "amd64", func(name string) (string, error) {
		switch name {
		case "claude.cmd":
			return cmdPath, nil
		case "claude.exe":
			return standalonePath, nil
		default:
			return "", errors.New("not found")
		}
	}, func(path string) bool {
		return path == cmdPath || path == standalonePath
	})
	if err != nil {
		t.Fatalf("resolve Claude CLI command: %v", err)
	}
	if command.Path != standalonePath {
		t.Fatalf("expected standalone binary %q, got %#v", standalonePath, command)
	}
}

func TestResolveClaudeCLICommandDoesNotReturnCmdWhenNativeBinaryIsMissing(t *testing.T) {
	cmdPath := filepath.Join("npm", "claude.cmd")
	_, err := resolveClaudeCLICommand("windows", "amd64", func(name string) (string, error) {
		if name == "claude.cmd" || name == "claude" {
			return cmdPath, nil
		}
		return "", errors.New("not found")
	}, func(path string) bool {
		return path == cmdPath
	})
	if err == nil {
		t.Fatal("expected missing native executable error instead of returning the cmd launcher")
	}
	if err.Error() != claudeCLIInstallError().Error() {
		t.Fatalf("expected actionable install error, got %v", err)
	}
}

func TestClaudeNPMNativeBinaryCandidatesSupportsWindowsArm64(t *testing.T) {
	candidates := claudeNPMNativeBinaryCandidates(filepath.Join("npm", "claude.cmd"), "windows", "arm64")
	wantPart := filepath.Join("@anthropic-ai", "claude-code-win32-arm64", "claude.exe")
	found := false
	for _, candidate := range candidates {
		if strings.Contains(candidate, wantPart) {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected Windows arm64 native package candidate, got %#v", candidates)
	}
}

func TestClaudeNPMPlatformTargetSupportsOfficialPackages(t *testing.T) {
	tests := []struct {
		goos       string
		goarch     string
		wantPkg    string
		wantBinary string
	}{
		{"windows", "amd64", "claude-code-win32-x64", "claude.exe"},
		{"windows", "arm64", "claude-code-win32-arm64", "claude.exe"},
		{"darwin", "amd64", "claude-code-darwin-x64", "claude"},
		{"darwin", "arm64", "claude-code-darwin-arm64", "claude"},
		{"linux", "amd64", "claude-code-linux-x64", "claude"},
		{"linux", "arm64", "claude-code-linux-arm64", "claude"},
	}
	for _, tt := range tests {
		t.Run(tt.goos+"-"+tt.goarch, func(t *testing.T) {
			pkg, binary, ok := claudeNPMPlatformTarget(tt.goos, tt.goarch)
			if !ok || pkg != tt.wantPkg || binary != tt.wantBinary {
				t.Fatalf("unexpected target: package=%q binary=%q ok=%v", pkg, binary, ok)
			}
		})
	}
}

func TestResolveClaudeCodeGitBashPathReturnsEnglishErrors(t *testing.T) {
	_, err := resolveClaudeCodeGitBashPath(
		[]string{`CLAUDE_CODE_GIT_BASH_PATH=C:\missing\bash.exe`},
		"windows",
		func(name string) (string, error) { return "", errors.New("not found") },
		func(path string) bool { return false },
	)
	if err == nil {
		t.Fatal("expected configured git-bash path error")
	}
	const want = `Claude Code CLI requires git-bash on Windows, but CLAUDE_CODE_GIT_BASH_PATH points to a missing bash.exe: C:\missing\bash.exe`
	if err.Error() != want {
		t.Fatalf("expected %q, got %q", want, err.Error())
	}
	if strings.Contains(err.Error(), "在 Windows 下需要") || strings.Contains(err.Error(), "不存在") || strings.Contains(err.Error(), "指向") {
		t.Fatalf("expected English configured git-bash error, got %q", err.Error())
	}
}

func TestClaudeCLIProvider_ChatTimesOutWhenCommandDoesNotFinish(t *testing.T) {
	fakeClaude := writeFakeClaudeScript(t, "#!/bin/sh\nsleep 5\n")
	restore := overrideClaudeCLIForTest(t, fakeClaude)
	defer restore()

	originalRequestTimeout := claudeCLIRequestTimeout
	claudeCLIRequestTimeout = 200 * time.Millisecond
	defer func() {
		claudeCLIRequestTimeout = originalRequestTimeout
	}()

	provider, err := NewClaudeCLIProvider(ai.ProviderConfig{
		BaseURL: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
		APIKey:  "sk-test",
		Model:   "qwen3.5-plus",
	})
	if err != nil {
		t.Fatalf("unexpected provider error: %v", err)
	}

	start := time.Now()
	_, err = provider.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping"}},
	})
	if err == nil {
		t.Fatal("expected chat timeout error")
	}
	assertClaudeCLIRuntimeErrorIsEnglish(t, err.Error())
	if strings.Contains(err.Error(), "timed out") && time.Since(start) < 200*time.Millisecond {
		t.Fatalf("expected timeout path to wait for configured deadline, took %s", time.Since(start))
	}
}

func TestClaudeCLIProvider_ChatStreamUsesRequestTimeoutWhenNoMeaningfulResponseArrives(t *testing.T) {
	fakeClaude := writeFakeClaudeScript(t, "#!/bin/sh\necho '{\"type\":\"system\",\"subtype\":\"init\"}'\nexec sleep 5\n")
	restore := overrideClaudeCLIForTest(t, fakeClaude)
	defer restore()

	originalRequestTimeout := claudeCLIRequestTimeout
	claudeCLIRequestTimeout = 200 * time.Millisecond
	defer func() {
		claudeCLIRequestTimeout = originalRequestTimeout
	}()

	provider, err := NewClaudeCLIProvider(ai.ProviderConfig{
		BaseURL: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
		APIKey:  "sk-test",
		Model:   "qwen3.5-plus",
	})
	if err != nil {
		t.Fatalf("unexpected provider error: %v", err)
	}

	var chunks []ai.StreamChunk
	err = provider.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping"}},
	}, func(chunk ai.StreamChunk) {
		chunks = append(chunks, chunk)
	})
	if err != nil {
		t.Fatalf("expected stream provider to report timeout via callback, got %v", err)
	}
	if len(chunks) == 0 {
		t.Fatal("expected timeout chunk")
	}
	lastChunk := chunks[len(chunks)-1]
	if !lastChunk.Done {
		t.Fatalf("expected timeout chunk to terminate stream, got %#v", lastChunk)
	}
	assertClaudeCLIRuntimeErrorIsEnglish(t, lastChunk.Error)
}

func assertClaudeCLIRuntimeErrorIsEnglish(t *testing.T, message string) {
	t.Helper()
	if strings.TrimSpace(message) == "" {
		t.Fatal("expected runtime error message")
	}
	for _, notWant := range []string{
		"执行超时",
		"执行失败",
		"返回错误",
		"创建 stdout 管道失败",
		"启动 claude CLI 失败",
		"鉴权失败",
		"异常退出",
		"返回未知错误",
	} {
		if strings.Contains(message, notWant) {
			t.Fatalf("expected English Claude CLI runtime error, got %q", message)
		}
	}
}

func TestClaudeCLIProvider_ChatStreamAllowsDelayedMeaningfulResponse(t *testing.T) {
	restore := overrideClaudeCLIWithTestProcess(t, "delayed-stream-success")
	defer restore()

	originalRequestTimeout := claudeCLIRequestTimeout
	claudeCLIRequestTimeout = 5 * time.Second
	defer func() {
		claudeCLIRequestTimeout = originalRequestTimeout
	}()

	provider, err := NewClaudeCLIProvider(ai.ProviderConfig{
		BaseURL: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
		APIKey:  "sk-test",
		Model:   "qwen3.5-plus",
	})
	if err != nil {
		t.Fatalf("unexpected provider error: %v", err)
	}

	var chunks []ai.StreamChunk
	err = provider.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping"}},
	}, func(chunk ai.StreamChunk) {
		chunks = append(chunks, chunk)
	})
	if err != nil {
		t.Fatalf("expected delayed response to complete via callback, got %v", err)
	}
	if len(chunks) == 0 {
		t.Fatal("expected delayed response chunks")
	}
	if chunks[0].Content != "OK" {
		t.Fatalf("expected delayed content chunk, got %#v", chunks)
	}
	if !chunks[len(chunks)-1].Done {
		t.Fatalf("expected terminal done chunk, got %#v", chunks[len(chunks)-1])
	}
}

func TestClaudeCLIProvider_ChatReturnsErrorWhenJSONResponseIsError(t *testing.T) {
	fakeClaude := writeFakeClaudeScript(t, "#!/bin/sh\necho '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":true,\"result\":\"API Error: Unable to connect to API (ECONNRESET)\",\"error\":\"unknown\"}'\n")
	restore := overrideClaudeCLIForTest(t, fakeClaude)
	defer restore()

	provider, err := NewClaudeCLIProvider(ai.ProviderConfig{
		BaseURL: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
		APIKey:  "sk-test",
		Model:   "qwen3.5-plus",
	})
	if err != nil {
		t.Fatalf("unexpected provider error: %v", err)
	}

	_, err = provider.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping"}},
	})
	if err == nil {
		t.Fatal("expected chat error when CLI JSON marks request as failed")
	}
	if !strings.Contains(err.Error(), "Unable to connect to API") {
		t.Fatalf("expected upstream API error, got %v", err)
	}
}

func TestClaudeCLIProvider_ChatStreamReportsAssistantErrorEvent(t *testing.T) {
	fakeClaude := writeFakeClaudeScript(t, "#!/bin/sh\necho '{\"type\":\"assistant\",\"is_error\":true,\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"API Error: Unable to connect to API (ECONNRESET)\"}]},\"error\":\"unknown\"}'\n")
	restore := overrideClaudeCLIForTest(t, fakeClaude)
	defer restore()

	provider, err := NewClaudeCLIProvider(ai.ProviderConfig{
		BaseURL: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
		APIKey:  "sk-test",
		Model:   "qwen3.5-plus",
	})
	if err != nil {
		t.Fatalf("unexpected provider error: %v", err)
	}

	var chunks []ai.StreamChunk
	err = provider.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping"}},
	}, func(chunk ai.StreamChunk) {
		chunks = append(chunks, chunk)
	})
	if err != nil {
		t.Fatalf("expected stream provider to report error via callback, got %v", err)
	}
	if len(chunks) != 1 {
		t.Fatalf("expected a single terminal error chunk, got %#v", chunks)
	}
	if chunks[0].Content != "" {
		t.Fatalf("expected assistant error event to avoid content output, got %#v", chunks[0])
	}
	if !chunks[0].Done || !strings.Contains(chunks[0].Error, "Unable to connect to API") {
		t.Fatalf("expected upstream API error chunk, got %#v", chunks[0])
	}
}

func TestClaudeCLIProvider_ChatStreamReportsResultErrorEvent(t *testing.T) {
	fakeClaude := writeFakeClaudeScript(t, "#!/bin/sh\necho '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":true,\"result\":\"API Error: Unable to connect to API (ECONNRESET)\",\"error\":\"unknown\"}'\n")
	restore := overrideClaudeCLIForTest(t, fakeClaude)
	defer restore()

	provider, err := NewClaudeCLIProvider(ai.ProviderConfig{
		BaseURL: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
		APIKey:  "sk-test",
		Model:   "qwen3.5-plus",
	})
	if err != nil {
		t.Fatalf("unexpected provider error: %v", err)
	}

	var chunks []ai.StreamChunk
	err = provider.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping"}},
	}, func(chunk ai.StreamChunk) {
		chunks = append(chunks, chunk)
	})
	if err != nil {
		t.Fatalf("expected stream provider to report error via callback, got %v", err)
	}
	if len(chunks) != 1 {
		t.Fatalf("expected a single terminal error chunk, got %#v", chunks)
	}
	if chunks[0].Content != "" {
		t.Fatalf("expected result error event to avoid content output, got %#v", chunks[0])
	}
	if !chunks[0].Done || !strings.Contains(chunks[0].Error, "Unable to connect to API") {
		t.Fatalf("expected upstream API error chunk, got %#v", chunks[0])
	}
}

func TestClaudeCLIProvider_ChatStreamReportsApiRetryAuthenticationFailure(t *testing.T) {
	fakeClaude := writeFakeClaudeScript(t, "#!/bin/sh\necho '{\"type\":\"system\",\"subtype\":\"api_retry\",\"attempt\":1,\"max_retries\":10,\"retry_delay_ms\":536.11,\"error_status\":401,\"error\":\"authentication_failed\",\"session_id\":\"retry-1\"}'\nexec sleep 5\n")
	restore := overrideClaudeCLIForTest(t, fakeClaude)
	defer restore()

	provider, err := NewClaudeCLIProvider(ai.ProviderConfig{
		BaseURL: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
		APIKey:  "sk-test",
		Model:   "qwen3.5-plus",
	})
	if err != nil {
		t.Fatalf("unexpected provider error: %v", err)
	}

	var chunks []ai.StreamChunk
	err = provider.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping"}},
	}, func(chunk ai.StreamChunk) {
		chunks = append(chunks, chunk)
	})
	if err != nil {
		t.Fatalf("expected stream provider to report authentication error via callback, got %v", err)
	}
	if len(chunks) != 1 {
		t.Fatalf("expected a single terminal error chunk, got %#v", chunks)
	}
	if !chunks[0].Done {
		t.Fatalf("expected terminal error chunk, got %#v", chunks[0])
	}
	if strings.Contains(chunks[0].Error, "未收到模型响应") {
		t.Fatalf("expected auth failure instead of startup timeout, got %#v", chunks[0])
	}
	if !strings.Contains(chunks[0].Error, "401") || !strings.Contains(chunks[0].Error, "authentication_failed") {
		t.Fatalf("expected auth retry error details, got %#v", chunks[0])
	}
}

func writeFakeClaudeScript(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()

	if runtime.GOOS == "windows" {
		scriptPath := filepath.Join(dir, "claude.sh")
		if err := os.WriteFile(scriptPath, []byte(content), 0o755); err != nil {
			t.Fatalf("failed to write fake claude shell script: %v", err)
		}
		return scriptPath
	}

	path := filepath.Join(dir, "claude")
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatalf("failed to write fake claude script: %v", err)
	}
	return path
}

func overrideClaudeCLIForTest(t *testing.T, fakeClaudePath string) func() {
	t.Helper()

	originalLookPath := claudeLookPath
	originalCommandContext := claudeCommandContext
	claudeLookPath = func(name string) (string, error) {
		if name == "claude" || name == "claude.cmd" || name == "claude.exe" {
			return fakeClaudePath, nil
		}
		return originalLookPath(name)
	}
	claudeCommandContext = func(ctx context.Context, name string, args ...string) *exec.Cmd {
		if name == "claude" || name == fakeClaudePath {
			if runtime.GOOS == "windows" {
				bashPath := resolveGitBashForFakeClaudeTest(t, originalLookPath)
				bashScriptPath := gitBashTestPath(fakeClaudePath)
				return exec.CommandContext(ctx, bashPath, append([]string{bashScriptPath}, args...)...)
			}
			return exec.CommandContext(ctx, fakeClaudePath, args...)
		}
		return originalCommandContext(ctx, name, args...)
	}

	originalPath := os.Getenv("PATH")
	if err := os.Setenv("PATH", filepath.Dir(fakeClaudePath)+string(os.PathListSeparator)+originalPath); err != nil {
		t.Fatalf("failed to override PATH: %v", err)
	}

	return func() {
		claudeLookPath = originalLookPath
		claudeCommandContext = originalCommandContext
		_ = os.Setenv("PATH", originalPath)
	}
}

func overrideClaudeCLIWithTestProcess(t *testing.T, mode string) func() {
	t.Helper()
	testExecutable, err := os.Executable()
	if err != nil {
		t.Fatalf("resolve test executable: %v", err)
	}

	originalLookPath := claudeLookPath
	originalCommandContext := claudeCommandContext
	claudeLookPath = func(name string) (string, error) {
		if name == "claude" || name == "claude.cmd" || name == "claude.exe" {
			return testExecutable, nil
		}
		return originalLookPath(name)
	}
	claudeCommandContext = func(ctx context.Context, name string, args ...string) *exec.Cmd {
		isAuthStatus := hasArg(args, "auth") && hasArg(args, "status") && hasArg(args, "--json")
		helperMode := mode
		switch mode {
		case "auth-success", "logged-out":
			if !isAuthStatus {
				helperMode = "unexpected-model-request"
			}
		case "api-key-override":
			if !isAuthStatus {
				helperMode = "model-success"
			}
		}
		helperArgs := []string{"-test.run=^TestClaudeCLIHelperProcess$"}
		cmd := exec.CommandContext(ctx, testExecutable, helperArgs...)
		cmd.Env = append(os.Environ(),
			"GO_WANT_CLAUDE_CLI_HELPER_PROCESS=1",
			"GONAVI_CLAUDE_CLI_HELPER_MODE="+helperMode,
		)
		return cmd
	}

	return func() {
		claudeLookPath = originalLookPath
		claudeCommandContext = originalCommandContext
	}
}

func TestClaudeCLIHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_CLAUDE_CLI_HELPER_PROCESS") != "1" {
		return
	}

	switch os.Getenv("GONAVI_CLAUDE_CLI_HELPER_MODE") {
	case "auth-success":
		_, _ = os.Stdout.WriteString(`{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}`)
		os.Exit(0)
	case "logged-out":
		_, _ = os.Stdout.WriteString(`{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}`)
		os.Exit(1)
	case "api-key-override":
		_, _ = os.Stdout.WriteString(`{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty","apiKeySource":"apiKeyHelper"}`)
		os.Exit(0)
	case "model-success":
		_, _ = os.Stdout.WriteString(`{"type":"result","subtype":"success","is_error":false,"result":"model request should not run"}`)
		os.Exit(0)
	case "delayed-stream-success":
		_, _ = os.Stdout.WriteString("{\"type\":\"system\",\"subtype\":\"init\"}\n")
		time.Sleep(200 * time.Millisecond)
		_, _ = os.Stdout.WriteString("{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"OK\"}]}}\n")
		_, _ = os.Stdout.WriteString("{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"OK\"}\n")
		os.Exit(0)
	case "sleep":
		time.Sleep(5 * time.Second)
		os.Exit(0)
	case "unexpected-model-request":
		_, _ = os.Stderr.WriteString("unexpected model request")
		os.Exit(9)
	default:
		_, _ = os.Stderr.WriteString("unknown Claude CLI helper mode")
		os.Exit(10)
	}
}

func resolveGitBashForFakeClaudeTest(t *testing.T, lookPath func(string) (string, error)) string {
	t.Helper()
	if configured := strings.TrimSpace(os.Getenv("CLAUDE_CODE_GIT_BASH_PATH")); configured != "" && fileExists(configured) {
		return configured
	}
	gitPath, err := lookPath("git.exe")
	if err == nil {
		gitDir := parentWindowsPath(gitPath)
		for _, candidate := range []string{
			joinWindowsPath(parentWindowsPath(gitDir), "bin", "bash.exe"),
			joinWindowsPath(gitDir, "bash.exe"),
		} {
			if candidate != "" && fileExists(candidate) {
				return candidate
			}
		}
	}
	t.Fatalf("failed to resolve Git for Windows bash.exe for fake claude command")
	return ""
}

func gitBashTestPath(path string) string {
	slashed := strings.ReplaceAll(path, `\`, `/`)
	volume := filepath.VolumeName(slashed)
	if len(volume) == 2 && volume[1] == ':' {
		drive := strings.ToLower(volume[:1])
		rest := strings.TrimPrefix(slashed[len(volume):], "/")
		return "/" + drive + "/" + rest
	}
	return slashed
}

// Claude Code 2.1.241 起，订阅登录的 authMethod 改报 "claude.ai" 而不再是 "oauth"，
// 同时新增权威字段 subscriptionType。只按旧词表判定会把真实 Max 订阅误判为未连接。
// 本用例用实测到的真实载荷锁住这一行为。
func TestValidateClaudeCLISubscriptionAcceptsClaudeAIMaxPayload(t *testing.T) {
	realPayload := claudeCLIAuthStatus{
		LoggedIn:         true,
		AuthMethod:       "claude.ai",
		APIProvider:      "firstParty",
		SubscriptionType: "max",
	}
	if err := validateClaudeCLISubscriptionStatus(realPayload); err != nil {
		t.Fatalf("真实 Max 订阅载荷应通过校验：%v", err)
	}

	// 旧版没有 subscriptionType 时仍要接受 oauth。
	legacy := claudeCLIAuthStatus{LoggedIn: true, AuthMethod: "oauth", APIProvider: "firstParty"}
	if err := validateClaudeCLISubscriptionStatus(legacy); err != nil {
		t.Fatalf("旧版 oauth 载荷应继续通过：%v", err)
	}

	// 明确的非订阅套餐仍要拒绝。
	free := claudeCLIAuthStatus{LoggedIn: true, AuthMethod: "claude.ai", APIProvider: "firstParty", SubscriptionType: "free"}
	if err := validateClaudeCLISubscriptionStatus(free); err == nil {
		t.Fatal("free 套餐不应被当作付费订阅")
	}

	// API key 覆盖仍要优先拒绝，即便订阅字段看起来正常。
	overridden := claudeCLIAuthStatus{LoggedIn: true, AuthMethod: "claude.ai", APIProvider: "firstParty", SubscriptionType: "max", APIKeySource: "ANTHROPIC_API_KEY"}
	if err := validateClaudeCLISubscriptionStatus(overridden); err == nil {
		t.Fatal("存在 API key 覆盖时不应放行")
	}
}
