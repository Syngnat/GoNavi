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
	args := buildCodexCLIArgs(ai.ProviderConfig{Model: "gpt-5-codex"}, codexCLIProviderRouting{})

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
	if !hasArgSequence(args, "-c", `model_reasoning_summary="auto"`) {
		t.Fatalf("expected displayable reasoning summaries to be enabled, got %#v", args)
	}
	if strings.Contains(strings.Join(args, " "), "show_raw_agent_reasoning") {
		t.Fatalf("raw private reasoning must remain disabled, got %#v", args)
	}
	if !hasArgSequence(args, "-m", "gpt-5-codex") {
		t.Fatalf("expected explicit model, got %#v", args)
	}
	if strings.Contains(strings.Join(args, " "), "secret prompt") {
		t.Fatalf("prompt must not be passed in argv: %#v", args)
	}
}

func TestBuildCodexCLIArgsLeavesModelToSubscriptionDefault(t *testing.T) {
	args := buildCodexCLIArgs(ai.ProviderConfig{}, codexCLIProviderRouting{})
	if hasArg(args, "-m") {
		t.Fatalf("expected no model override, got %#v", args)
	}
}

func TestNewCodexCLIProviderRejectsAPIKeyAuthMode(t *testing.T) {
	if _, err := NewCodexCLIProvider(ai.ProviderConfig{AuthMode: "api-key"}); err == nil || !strings.Contains(err.Error(), "local-cli") {
		t.Fatalf("expected an actionable local-cli auth error, got %v", err)
	}
}

func TestBuildCodexCLIEnvPreservesActiveCLIAuthentication(t *testing.T) {
	env := buildCodexCLIEnv([]string{
		"PATH=/usr/bin",
		"CODEX_HOME=/tmp/codex-home",
		"CODEX_API_KEY=codex-key",
		"OPENAI_API_KEY=openai-key",
		"OPENAI_BASE_URL=https://example.invalid",
	}, "")

	for key, want := range map[string]string{
		"CODEX_API_KEY":   "codex-key",
		"OPENAI_API_KEY":  "openai-key",
		"OPENAI_BASE_URL": "https://example.invalid",
	} {
		if got := envValue(env, key); got != want {
			t.Fatalf("expected %s=%q to be preserved, got %q", key, want, got)
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
		Usage: codexCLIUsage{InputTokens: 10, CachedInputTokens: 3, OutputTokens: 4, ReasoningOutputTokens: 2},
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
	if result.Usage.CachedTokens == nil || *result.Usage.CachedTokens != 3 {
		t.Fatalf("unexpected cached usage: %#v", result.Usage.CachedTokens)
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
	if resp.TokensUsed.CachedTokens == nil || *resp.TokensUsed.CachedTokens != 1 {
		t.Fatalf("unexpected cached usage: %#v", resp.TokensUsed.CachedTokens)
	}
}

func TestCodexCLIProviderCustomEnvironmentCanSelectAPIKeyAuthentication(t *testing.T) {
	restore := overrideCodexCLIForTest(t, "success")
	defer restore()

	helperCommandContext := codexCommandContext
	var modelCommand *exec.Cmd
	codexCommandContext = func(ctx context.Context, path string, args ...string) *exec.Cmd {
		command := helperCommandContext(ctx, path, args...)
		modelCommand = command
		return command
	}
	provider, err := NewCodexCLIProvider(ai.ProviderConfig{
		AuthMode: "local-cli",
		CLIEnv: map[string]string{
			"GONAVI_CODEX_CUSTOM": "configured",
			"OPENAI_API_KEY":      "configured-api-key",
			"OPENAI_BASE_URL":     "https://configured-endpoint.invalid",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Chat(context.Background(), ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "hello"}}}); err != nil {
		t.Fatal(err)
	}
	if modelCommand == nil {
		t.Fatal("model command was not created")
	}
	if got := envValue(modelCommand.Env, "GONAVI_CODEX_CUSTOM"); got != "configured" {
		t.Fatalf("custom environment = %q, want configured", got)
	}
	if got := envValue(modelCommand.Env, "OPENAI_API_KEY"); got != "configured-api-key" {
		t.Fatalf("OPENAI_API_KEY = %q, want configured CLI authentication", got)
	}
	if got := envValue(modelCommand.Env, "OPENAI_BASE_URL"); got != "https://configured-endpoint.invalid" {
		t.Fatalf("OPENAI_BASE_URL = %q, want configured CLI endpoint", got)
	}
}

func TestCodexCLIProviderPreservesSelectedCustomModelProvider(t *testing.T) {
	restore := overrideCodexCLIForTest(t, "success")
	defer restore()

	codexHome := t.TempDir()
	configTOML := `model = "proxy-model"
model_provider = "proxy"
developer_instructions = "must not reach GoNavi"

[model_providers.proxy]
name = "Compatible proxy"
base_url = "https://proxy.example/v1"
wire_api = "responses"
requires_openai_auth = true

[model_providers.unused]
base_url = "https://unused.example/v1"

[mcp_servers.untrusted]
command = "must-not-run"
`
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte(configTOML), 0o600); err != nil {
		t.Fatal(err)
	}

	helperCommandContext := codexCommandContext
	var modelArgs []string
	codexCommandContext = func(ctx context.Context, path string, args ...string) *exec.Cmd {
		modelArgs = append([]string(nil), args...)
		return helperCommandContext(ctx, path, args...)
	}

	provider, err := NewCodexCLIProvider(ai.ProviderConfig{
		AuthMode: "local-cli",
		CLIEnv:   map[string]string{"CODEX_HOME": codexHome},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "hello"}},
	}); err != nil {
		t.Fatal(err)
	}

	joined := strings.Join(modelArgs, "\n")
	for _, want := range []string{`model_provider="proxy"`, `https://proxy.example/v1`, "-m\nproxy-model"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("Codex invocation did not preserve %q: %#v", want, modelArgs)
		}
	}
	for _, forbidden := range []string{"must not reach GoNavi", "https://unused.example/v1", "must-not-run"} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("Codex invocation leaked unrelated user config %q: %#v", forbidden, modelArgs)
		}
	}
	if !hasArg(modelArgs, "--ignore-user-config") {
		t.Fatalf("provider routing must not disable user-config isolation: %#v", modelArgs)
	}
}

func TestCodexCLIProviderUsesExplicitGoNaviModelOverCLIConfigDefault(t *testing.T) {
	providerConfig := codexCLIModelProviderConfig{BaseURL: "https://proxy.example/v1"}
	args := buildCodexCLIArgs(ai.ProviderConfig{Model: "gonavi-model"}, codexCLIProviderRouting{
		Model:      "cli-default-model",
		ProviderID: "proxy",
		Provider:   &providerConfig,
	})
	if !hasArgSequence(args, "-m", "gonavi-model") || hasArg(args, "cli-default-model") {
		t.Fatalf("expected GoNavi model to override CLI default, got %#v", args)
	}
}

func TestLoadCodexCLIProviderRoutingPrefersConfiguredCODEXHome(t *testing.T) {
	processHome := t.TempDir()
	configuredHome := t.TempDir()
	t.Setenv("CODEX_HOME", processHome)
	for path, model := range map[string]string{
		processHome:    "process-model",
		configuredHome: "configured-model",
	} {
		if err := os.WriteFile(filepath.Join(path, "config.toml"), []byte(`model = "`+model+`"`), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	routing, err := loadCodexCLIProviderRouting(map[string]string{"CODEX_HOME": configuredHome})
	if err != nil {
		t.Fatal(err)
	}
	if routing.Model != "configured-model" {
		t.Fatalf("model = %q, want configured CODEX_HOME model", routing.Model)
	}
}

func TestCodexCLIProviderMovesStaticProviderSecretsOutOfArgsAndLogs(t *testing.T) {
	codexHome := t.TempDir()
	configTOML := `model_provider = "proxy"

[model_providers.proxy]
base_url = "https://proxy.example/v1"
wire_api = "responses"
experimental_bearer_token = "secret-static-bearer"
http_headers = { Authorization = "Bearer secret-header-value", X-Tenant = "tenant-secret" }
env_http_headers = { X-Existing = "EXISTING_HEADER_ENV" }
query_params = { api-version = "secret-query-value" }
`
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte(configTOML), 0o600); err != nil {
		t.Fatal(err)
	}

	routing, err := loadCodexCLIProviderRouting(map[string]string{"CODEX_HOME": codexHome})
	if err != nil {
		t.Fatal(err)
	}
	args := buildCodexCLIArgs(ai.ProviderConfig{}, routing)
	joinedArgs := strings.Join(args, "\n")
	for _, secret := range []string{"secret-static-bearer", "secret-header-value", "tenant-secret"} {
		if strings.Contains(joinedArgs, secret) {
			t.Fatalf("provider secret leaked into argv: %q in %#v", secret, args)
		}
	}
	if routing.Env["GONAVI_CODEX_PROVIDER_BEARER_TOKEN"] != "secret-static-bearer" {
		t.Fatalf("static bearer token was not moved to the child environment: %#v", routing.Env)
	}
	if routing.Env["GONAVI_CODEX_PROVIDER_HTTP_HEADER_0"] != "Bearer secret-header-value" ||
		routing.Env["GONAVI_CODEX_PROVIDER_HTTP_HEADER_1"] != "tenant-secret" {
		t.Fatalf("static headers were not moved to the child environment: %#v", routing.Env)
	}

	loggedArgs := sanitizeCodexCLIArgsForLog(args)
	joinedLog := strings.Join(loggedArgs, "\n")
	for _, hidden := range []string{"https://proxy.example/v1", "secret-query-value", "GONAVI_CODEX_PROVIDER_BEARER_TOKEN"} {
		if strings.Contains(joinedLog, hidden) {
			t.Fatalf("provider config leaked into request log: %q in %#v", hidden, loggedArgs)
		}
	}
	if !strings.Contains(joinedLog, "model_providers.proxy.base_url=[REDACTED]") {
		t.Fatalf("expected provider config values to be redacted, got %#v", loggedArgs)
	}
}

func TestLoadCodexCLIProviderRoutingRejectsMissingSelectedProvider(t *testing.T) {
	codexHome := t.TempDir()
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte(`model_provider = "missing"`), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := loadCodexCLIProviderRouting(map[string]string{"CODEX_HOME": codexHome})
	if err == nil || !strings.Contains(err.Error(), "refusing to fall back") {
		t.Fatalf("expected missing provider to block OpenAI fallback, got %v", err)
	}
}

func TestLoadCodexCLIProviderRoutingAllowsBuiltInProviderWithoutTable(t *testing.T) {
	codexHome := t.TempDir()
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte(`model_provider = "ollama"`), 0o600); err != nil {
		t.Fatal(err)
	}

	routing, err := loadCodexCLIProviderRouting(map[string]string{"CODEX_HOME": codexHome})
	if err != nil {
		t.Fatal(err)
	}
	if routing.ProviderID != "ollama" || routing.Provider != nil || codexCLIProviderNeedsLocalAuth(routing) {
		t.Fatalf("unexpected built-in provider routing: %#v", routing)
	}
	args := buildCodexCLIArgs(ai.ProviderConfig{}, routing)
	if !hasArgSequence(args, "-c", `model_provider="ollama"`) {
		t.Fatalf("built-in provider selection was not preserved: %#v", args)
	}
}

func TestLoadCodexCLIProviderRoutingPreservesBedrockAWSOverridesWithoutBaseURL(t *testing.T) {
	codexHome := t.TempDir()
	configTOML := `model_provider = "amazon-bedrock"

[model_providers.amazon-bedrock.aws]
region = "us-west-2"

[model_providers.amazon-bedrock.aws.credential_export]
command = "aws-creds"
args = ["export", "--json"]
timeout_ms = 1234
`
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte(configTOML), 0o600); err != nil {
		t.Fatal(err)
	}

	routing, err := loadCodexCLIProviderRouting(map[string]string{"CODEX_HOME": codexHome})
	if err != nil {
		t.Fatal(err)
	}
	args := buildCodexCLIArgs(ai.ProviderConfig{}, routing)
	for _, expected := range []string{
		`model_providers.amazon-bedrock.aws.region="us-west-2"`,
		`model_providers.amazon-bedrock.aws.credential_export.command="aws-creds"`,
		`model_providers.amazon-bedrock.aws.credential_export.args=["export","--json"]`,
		`model_providers.amazon-bedrock.aws.credential_export.timeout_ms=1234`,
	} {
		if !hasArg(args, expected) {
			t.Fatalf("expected %q in Bedrock routing args: %#v", expected, args)
		}
	}
}

func TestCodexCLIProviderDoesNotRequireOpenAILoginForProviderOwnedAuth(t *testing.T) {
	restore := overrideCodexCLIForTest(t, "success")
	defer restore()

	codexHome := t.TempDir()
	configTOML := `model_provider = "proxy"

[model_providers.proxy]
base_url = "https://proxy.example/v1"
env_key = "THIRD_PARTY_API_KEY"
`
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte(configTOML), 0o600); err != nil {
		t.Fatal(err)
	}
	authChecks := 0
	codexCLILocalAuthCheck = func(context.Context, ai.ProviderConfig) error {
		authChecks++
		return errors.New("OpenAI login must not be required")
	}

	provider, err := NewCodexCLIProvider(ai.ProviderConfig{
		AuthMode: "local-cli",
		CLIEnv: map[string]string{
			"CODEX_HOME":          codexHome,
			"THIRD_PARTY_API_KEY": "configured",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Chat(context.Background(), ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "hello"}}}); err != nil {
		t.Fatal(err)
	}
	if authChecks != 0 {
		t.Fatalf("provider-owned API key unexpectedly triggered %d OpenAI login checks", authChecks)
	}
}

func TestCodexCLIProviderRejectsMissingProviderOwnedAPIKeyBeforeRequest(t *testing.T) {
	restore := overrideCodexCLIForTest(t, "success")
	defer restore()

	codexHome := t.TempDir()
	configTOML := `model_provider = "proxy"

[model_providers.proxy]
base_url = "https://proxy.example/v1"
env_key = "MISSING_THIRD_PARTY_API_KEY"
`
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte(configTOML), 0o600); err != nil {
		t.Fatal(err)
	}
	modelStarted := false
	helperCommandContext := codexCommandContext
	codexCommandContext = func(ctx context.Context, path string, args ...string) *exec.Cmd {
		modelStarted = true
		return helperCommandContext(ctx, path, args...)
	}

	provider, err := NewCodexCLIProvider(ai.ProviderConfig{
		AuthMode: "local-cli",
		CLIEnv:   map[string]string{"CODEX_HOME": codexHome},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = provider.Chat(context.Background(), ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "hello"}}})
	if err == nil || !strings.Contains(err.Error(), "MISSING_THIRD_PARTY_API_KEY") {
		t.Fatalf("expected actionable missing API key error, got %v", err)
	}
	if modelStarted {
		t.Fatal("model request started despite missing provider-owned API key")
	}
}

func TestCodexCLIProviderChatStopsWhenAuthenticationCheckFails(t *testing.T) {
	originalAuthCheck := codexCLILocalAuthCheck
	originalCommandContext := codexCommandContext
	defer func() {
		codexCLILocalAuthCheck = originalAuthCheck
		codexCommandContext = originalCommandContext
	}()

	codexCLILocalAuthCheck = func(context.Context, ai.ProviderConfig) error {
		return errors.New("Codex CLI is not authenticated")
	}
	modelStarted := false
	codexCommandContext = func(ctx context.Context, path string, args ...string) *exec.Cmd {
		modelStarted = true
		return originalCommandContext(ctx, path, args...)
	}

	provider, _ := NewCodexCLIProvider(ai.ProviderConfig{
		AuthMode: "local-cli",
		CLIEnv:   map[string]string{"CODEX_HOME": t.TempDir()},
	})
	_, err := provider.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "must not be sent"}},
	})
	if err == nil || !strings.Contains(err.Error(), "not authenticated") {
		t.Fatalf("expected authentication error, got %v", err)
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

func TestCheckCodexCLIAuthAcceptsAPIKeyLogin(t *testing.T) {
	restore := overrideCodexCLIForTest(t, "login-api-key")
	defer restore()

	if err := CheckCodexCLIAuth(context.Background()); err != nil {
		t.Fatalf("expected API key login to be accepted, got %v", err)
	}
}

func TestCheckCodexCLIAuthAcceptsCustomProviderOwnedAPIKey(t *testing.T) {
	restore := overrideCodexCLIForTest(t, "login-failed")
	defer restore()

	codexHome := t.TempDir()
	configTOML := `model_provider = "proxy"

[model_providers.proxy]
base_url = "https://proxy.example/v1"
env_key = "THIRD_PARTY_API_KEY"
`
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte(configTOML), 0o600); err != nil {
		t.Fatal(err)
	}
	commandsStarted := 0
	helperCommandContext := codexCommandContext
	codexCommandContext = func(ctx context.Context, path string, args ...string) *exec.Cmd {
		commandsStarted++
		return helperCommandContext(ctx, path, args...)
	}

	err := CheckCodexCLIAuthWithConfig(context.Background(), ai.ProviderConfig{
		AuthMode: "local-cli",
		CLIEnv: map[string]string{
			"CODEX_HOME":          codexHome,
			"THIRD_PARTY_API_KEY": "configured",
		},
	})
	if err != nil {
		t.Fatalf("expected provider-owned API key auth to be accepted, got %v", err)
	}
	if commandsStarted != 0 {
		t.Fatalf("provider-owned API key should not run OpenAI login status, started %d command(s)", commandsStarted)
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
	t.Setenv("CODEX_HOME", t.TempDir())
	originalLookPath := codexLookPath
	originalCommandContext := codexCommandContext
	originalAuthCheck := codexCLILocalAuthCheck
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
	codexCLILocalAuthCheck = func(context.Context, ai.ProviderConfig) error { return nil }
	return func() {
		codexLookPath = originalLookPath
		codexCommandContext = originalCommandContext
		codexCLILocalAuthCheck = originalAuthCheck
	}
}
