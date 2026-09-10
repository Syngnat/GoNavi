package provider

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"

	ai "GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/logger"
	"github.com/BurntSushi/toml"
)

var codexLookPath = lookupLocalCLICommand
var codexCommandContext = exec.CommandContext
var codexEvalSymlinks = filepath.EvalSymlinks
var codexCLILocalAuthCheck = CheckCodexCLIAuthWithConfig

const codexCLIMaxJSONLineBytes = 8 * 1024 * 1024
const codexCLIConfigMaxBytes = 2 * 1024 * 1024
const codexCLILoginConfigOverride = `model_reasoning_effort="high"`

// Codex CLI is used as a credentialed model transport, not as a coding agent.
// Keep every optional capability off so database context cannot reach local or
// remote tools through user-installed apps, plugins, hooks, or browser helpers.
var codexCLIDisabledFeatures = []string{
	"shell_tool",
	"shell_snapshot",
	"code_mode",
	"code_mode_only",
	"web_search_request",
	"web_search_cached",
	"hooks",
	"request_permissions_tool",
	"memories",
	"chronicle",
	// "child_agents_md" 已在 Codex CLI 0.150.1 中移除；继续传入会让 codex 在配置校验阶段
	// 直接以 `Unknown feature flag: child_agents_md` 退出，导致整个 provider 不可用。
	// 子 Agent 能力仍由下面的 multi_agent / multi_agent_v2 / enable_fanout 关闭，隔离未削弱。
	"multi_agent",
	"multi_agent_v2",
	"enable_fanout",
	"apps",
	"enable_mcp_apps",
	"tool_suggest",
	"plugins",
	"plugin_hooks",
	"in_app_browser",
	"browser_use",
	"browser_use_external",
	"computer_use",
	"remote_plugin",
	"plugin_sharing",
	"external_migration",
	"image_generation",
	"skill_mcp_dependency_install",
	"mentions_v2",
	"steer",
	"default_mode_request_user_input",
	"guardian_approval",
	"goals",
	"collaboration_modes",
	"auth_elicitation",
	"personality",
	"artifact",
	"fast_mode",
	"realtime_conversation",
	"remote_control",
	"workspace_dependencies",
}

type codexCLICommand struct {
	Path       string
	PrefixArgs []string
}

type codexCLIEvent struct {
	Type    string        `json:"type"`
	Message string        `json:"message"`
	Item    codexCLIItem  `json:"item"`
	Error   codexCLIError `json:"error"`
	Usage   codexCLIUsage `json:"usage"`
}

type codexCLIItem struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type codexCLIError struct {
	Message string `json:"message"`
}

type codexCLIUsage struct {
	InputTokens           int `json:"input_tokens"`
	CachedInputTokens     int `json:"cached_input_tokens"`
	OutputTokens          int `json:"output_tokens"`
	ReasoningOutputTokens int `json:"reasoning_output_tokens"`
}

type codexCLIResult struct {
	Content       string
	Thinking      string
	Usage         ai.TokenUsage
	Completed     bool
	TerminalError string
	LastError     string
}

// codexCLIUserConfig intentionally decodes only model routing. GoNavi keeps
// --ignore-user-config enabled and never projects user instructions, MCP
// servers, hooks, plugins, permissions, or other agent behavior into a chat.
type codexCLIUserConfig struct {
	Model          string                                 `toml:"model"`
	ModelProvider  string                                 `toml:"model_provider"`
	ModelProviders map[string]codexCLIModelProviderConfig `toml:"model_providers"`
}

type codexCLIModelProviderConfig struct {
	Name                        string                        `toml:"name"`
	BaseURL                     string                        `toml:"base_url"`
	EnvKey                      string                        `toml:"env_key"`
	EnvKeyInstructions          string                        `toml:"env_key_instructions"`
	WireAPI                     string                        `toml:"wire_api"`
	ExperimentalBearerToken     string                        `toml:"experimental_bearer_token"`
	RequiresOpenAIAuth          *bool                         `toml:"requires_openai_auth"`
	QueryParams                 map[string]string             `toml:"query_params"`
	HTTPHeaders                 map[string]string             `toml:"http_headers"`
	EnvHTTPHeaders              map[string]string             `toml:"env_http_headers"`
	RequestMaxRetries           *int64                        `toml:"request_max_retries"`
	StreamMaxRetries            *int64                        `toml:"stream_max_retries"`
	StreamIdleTimeoutMS         *int64                        `toml:"stream_idle_timeout_ms"`
	WebSocketConnectTimeoutMS   *int64                        `toml:"websocket_connect_timeout_ms"`
	SupportsWebSockets          *bool                         `toml:"supports_websockets"`
	SupportsStandaloneWebSearch *bool                         `toml:"supports_standalone_web_search"`
	Auth                        *codexCLIModelProviderAuth    `toml:"auth"`
	AWS                         *codexCLIModelProviderAWSAuth `toml:"aws"`
}

type codexCLIModelProviderAuth struct {
	Command           string   `toml:"command"`
	Args              []string `toml:"args"`
	TimeoutMS         *int64   `toml:"timeout_ms"`
	RefreshIntervalMS *int64   `toml:"refresh_interval_ms"`
	Cwd               string   `toml:"cwd"`
}

type codexCLIModelProviderAWSAuth struct {
	Profile          string                           `toml:"profile"`
	Region           string                           `toml:"region"`
	CredentialExport *codexCLIModelProviderAWSCommand `toml:"credential_export"`
	AuthRefresh      *codexCLIModelProviderAWSCommand `toml:"auth_refresh"`
}

type codexCLIModelProviderAWSCommand struct {
	Command   string   `toml:"command"`
	Args      []string `toml:"args"`
	TimeoutMS *int64   `toml:"timeout_ms"`
}

type codexCLIProviderRouting struct {
	Model      string
	ProviderID string
	Provider   *codexCLIModelProviderConfig
	Env        map[string]string
}

// CodexCLIProvider 通过官方 Codex CLI 复用本机认证（ChatGPT、Codex API key
// 或自定义 model provider 自己的 API key）。
// CLI 在隔离临时目录、只读 sandbox 且禁用 shell/web 的条件下运行。
type CodexCLIProvider struct {
	config ai.ProviderConfig
}

func NewCodexCLIProvider(config ai.ProviderConfig) (Provider, error) {
	if !strings.EqualFold(strings.TrimSpace(config.AuthMode), "local-cli") {
		return nil, fmt.Errorf("Codex CLI provider requires local-cli authentication")
	}
	return &CodexCLIProvider{config: config}, nil
}

func (p *CodexCLIProvider) Name() string {
	return "CodexCLI"
}

func (p *CodexCLIProvider) Validate() error {
	_, err := resolveCodexCLICommand(runtime.GOOS, runtime.GOARCH, lookPathWithOverride(p.config.CLIPath, codexLookPath), fileExists)
	return err
}

// CheckCodexCLIAuth verifies that the official CLI is installed and that its
// selected provider has an applicable local authentication route. It deliberately
// does not send a model request.
func CheckCodexCLIAuth(ctx context.Context) error {
	return CheckCodexCLIAuthWithConfig(ctx, ai.ProviderConfig{AuthMode: "local-cli"})
}

// CheckCodexCLIAuthWithConfig validates the exact CLI executable/environment
// selected for the provider while preserving the CLI's active authentication.
func CheckCodexCLIAuthWithConfig(ctx context.Context, config ai.ProviderConfig) error {
	command, err := resolveCodexCLICommand(runtime.GOOS, runtime.GOARCH, lookPathWithOverride(config.CLIPath, codexLookPath), fileExists)
	if err != nil {
		return err
	}
	routing, err := loadCodexCLIProviderRouting(config.CLIEnv)
	if err != nil {
		return err
	}
	if err := validateCodexCLIProviderAuthEnvironment(routing, config.CLIEnv); err != nil {
		return err
	}
	if !codexCLIProviderNeedsLocalAuth(routing) {
		return nil
	}

	args := append(append([]string(nil), command.PrefixArgs...),
		"login", "status", "-c", codexCLILoginConfigOverride,
	)
	cmd := newLocalCLICommand(codexCommandContext, ctx, command.Path, args...)
	cmd.Env = buildCodexCLIEnvWithConfig(cmd.Environ(), command.Path, config.CLIEnv)
	output, err := cmd.CombinedOutput()
	detail := strings.TrimSpace(string(output))
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		if detail == "" {
			detail = err.Error()
		}
		return fmt.Errorf("Codex CLI login check failed: %s; run codex login first", RedactAIUpstreamLogText(detail))
	}
	if !isCodexCLIAuthenticatedStatus(detail) {
		if detail == "" {
			detail = "unknown login type"
		}
		return fmt.Errorf("Codex CLI is not authenticated with ChatGPT or an API key (status: %s); run codex login or codex login --with-api-key", RedactAIUpstreamLogText(detail))
	}
	return nil
}

func isCodexCLIAuthenticatedStatus(status string) bool {
	normalized := strings.ToLower(strings.TrimSpace(status))
	return strings.Contains(normalized, "logged in using chatgpt") ||
		strings.Contains(normalized, "logged in using an api key") ||
		strings.Contains(normalized, "logged in using api key") ||
		strings.Contains(normalized, "logged in using an access token")
}

func (p *CodexCLIProvider) Chat(ctx context.Context, req ai.ChatRequest) (*ai.ChatResponse, error) {
	result, err := p.run(ctx, req, nil)
	if err != nil {
		return nil, err
	}
	return &ai.ChatResponse{
		Content:          result.Content,
		ReasoningContent: result.Thinking,
		TokensUsed:       result.Usage,
	}, nil
}

func (p *CodexCLIProvider) ChatStream(ctx context.Context, req ai.ChatRequest, callback func(ai.StreamChunk)) error {
	_, err := p.run(ctx, req, callback)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return context.Canceled
		}
		callback(ai.StreamChunk{Error: err.Error(), Done: true})
		return nil
	}
	return nil
}

func (p *CodexCLIProvider) run(ctx context.Context, req ai.ChatRequest, onChunk func(ai.StreamChunk)) (codexCLIResult, error) {
	ctx, watchdog := startCLIIdleWatchdog(ctx, cliStreamIdleTimeout, cliStreamMaxTimeout)
	defer watchdog.Close()
	routing, err := loadCodexCLIProviderRouting(p.config.CLIEnv)
	if err != nil {
		return codexCLIResult{}, err
	}
	if err := validateCodexCLIProviderAuthEnvironment(routing, p.config.CLIEnv); err != nil {
		return codexCLIResult{}, err
	}
	if codexCLIProviderNeedsLocalAuth(routing) {
		if err := codexCLILocalAuthCheck(ctx, p.config); err != nil {
			return codexCLIResult{}, err
		}
	}

	command, err := resolveCodexCLICommand(runtime.GOOS, runtime.GOARCH, lookPathWithOverride(p.config.CLIPath, codexLookPath), fileExists)
	if err != nil {
		return codexCLIResult{}, err
	}

	workDir, err := os.MkdirTemp("", "gonavi-codex-")
	if err != nil {
		return codexCLIResult{}, fmt.Errorf("create isolated Codex CLI workspace failed: %w", err)
	}
	defer func() {
		if removeErr := os.RemoveAll(workDir); removeErr != nil {
			logger.Warnf("CodexCLI 清理临时目录失败：path=%s err=%v", workDir, removeErr)
		}
	}()

	prompt := buildPrompt(req.Messages)
	args := append(append([]string(nil), command.PrefixArgs...), buildCodexCLIArgs(p.config, routing)...)
	cmd := newLocalCLICommand(codexCommandContext, ctx, command.Path, args...)
	cmd.Dir = workDir
	cmd.Stdin = strings.NewReader(prompt)
	cmd.Env = buildCodexCLIEnvWithConfig(cmd.Environ(), command.Path, mergeCodexCLIProviderEnv(p.config.CLIEnv, routing.Env))

	requestLog := logAIUpstreamRequestStart(
		p.Name(),
		"CLI",
		"codex://cli",
		buildCodexCLIRequestLogBody(args, prompt, p.config, req),
	)
	var requestErr error
	defer func() {
		logAIUpstreamRequestFinish(requestLog, 0, requestErr)
	}()

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		requestErr = fmt.Errorf("create Codex CLI stdout pipe failed: %w", err)
		return codexCLIResult{}, requestErr
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		requestErr = fmt.Errorf("start Codex CLI failed: %w", err)
		return codexCLIResult{}, requestErr
	}
	if cmd.Process != nil {
		logger.Infof("CodexCLI 请求进程已启动：requestId=%s pid=%d", requestLog.id, cmd.Process.Pid)
	}

	result := codexCLIResult{}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), codexCLIMaxJSONLineBytes)
	for scanner.Scan() {
		watchdog.Bump()
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var event codexCLIEvent
		if err := json.Unmarshal(line, &event); err != nil {
			logger.Warnf("CodexCLI 忽略非 JSON 输出：requestId=%s line=%s", requestLog.id, RedactAIUpstreamLogText(string(line)))
			continue
		}
		delta := consumeCodexCLIEvent(&result, event)
		if onChunk != nil && delta.Thinking != "" {
			onChunk(ai.StreamChunk{Thinking: delta.Thinking})
		}
	}
	scanErr := scanner.Err()
	waitErr := cmd.Wait()

	if watchdog.TimedOut() || isClaudeCLITimeout(ctx, waitErr) {
		requestErr = watchdog.TimeoutError("Codex CLI")
		return codexCLIResult{}, requestErr
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		requestErr = context.Canceled
		return codexCLIResult{}, requestErr
	}
	if scanErr != nil {
		requestErr = fmt.Errorf("read Codex CLI JSON output failed: %w", scanErr)
		return codexCLIResult{}, requestErr
	}
	if result.TerminalError != "" {
		requestErr = fmt.Errorf("Codex CLI returned an error: %s", result.TerminalError)
		return codexCLIResult{}, requestErr
	}
	if waitErr != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = result.LastError
		}
		if detail == "" {
			detail = waitErr.Error()
		}
		requestErr = fmt.Errorf("Codex CLI execution failed: %s", detail)
		return codexCLIResult{}, requestErr
	}
	if !result.Completed {
		detail := result.LastError
		if detail == "" {
			detail = strings.TrimSpace(stderr.String())
		}
		if detail == "" {
			detail = "the command ended without a turn.completed event"
		}
		requestErr = fmt.Errorf("Codex CLI did not complete the request: %s", detail)
		return codexCLIResult{}, requestErr
	}
	if onChunk != nil {
		if result.Content != "" {
			onChunk(ai.StreamChunk{Content: result.Content})
		}
		usage := result.Usage
		onChunk(ai.StreamChunk{Done: true, Usage: &usage})
	}
	return result, nil
}

func buildCodexCLIArgs(config ai.ProviderConfig, routing codexCLIProviderRouting) []string {
	args := []string{
		"exec",
		"--ignore-user-config",
		"--ignore-rules",
		"--ephemeral",
		"--sandbox", "read-only",
		"--skip-git-repo-check",
		"-c", `web_search="disabled"`,
		"-c", `approval_policy="never"`,
		"-c", "project_doc_max_bytes=0",
		"-c", "mcp_servers={}",
		"-c", "skills.include_instructions=false",
		"-c", "skills.bundled.enabled=false",
		// --ignore-user-config also drops the user's reasoning-summary preference.
		// Request the model-provided summary so the chat can render its existing
		// collapsible thinking block without exposing raw private reasoning.
		"-c", `model_reasoning_summary="auto"`,
		"--color", "never",
		"--json",
	}
	args = appendCodexCLIProviderRoutingArgs(args, routing)
	for _, feature := range codexCLIDisabledFeatures {
		args = append(args, "--disable", feature)
	}
	model := strings.TrimSpace(config.Model)
	if model == "" {
		model = routing.Model
	}
	if model != "" {
		args = append(args, "-m", model)
	}
	// codex 没有专用档位 flag，只能走 -c 配置键；形态与值域由能力表持有。
	// 注意 --ignore-user-config 已经把用户 config.toml 整个隔离掉了，
	// 所以这里不传就等于跑 codex 内置默认档位，用户在 codex 侧调的偏好不会生效。
	if capability, ok := LookupCLICapability("codex-cli"); ok {
		if effort, err := capability.NormalizeEffort(config.Effort); err == nil {
			args = capability.AppendEffortArgs(args, effort)
		}
	}
	return append(args, "-")
}

func loadCodexCLIProviderRouting(extraEnv map[string]string) (codexCLIProviderRouting, error) {
	configPath, err := codexCLIUserConfigPath(extraEnv)
	if err != nil {
		return codexCLIProviderRouting{}, err
	}

	file, err := os.Open(configPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return codexCLIProviderRouting{}, nil
		}
		return codexCLIProviderRouting{}, fmt.Errorf("read Codex CLI config %s failed: %w", configPath, err)
	}
	defer file.Close()

	contents, err := io.ReadAll(io.LimitReader(file, codexCLIConfigMaxBytes+1))
	if err != nil {
		return codexCLIProviderRouting{}, fmt.Errorf("read Codex CLI config %s failed: %w", configPath, err)
	}
	if len(contents) > codexCLIConfigMaxBytes {
		return codexCLIProviderRouting{}, fmt.Errorf("Codex CLI config %s exceeds the %d-byte safety limit", configPath, codexCLIConfigMaxBytes)
	}

	var userConfig codexCLIUserConfig
	if _, err := toml.Decode(string(contents), &userConfig); err != nil {
		return codexCLIProviderRouting{}, fmt.Errorf("parse Codex CLI config %s failed: %w", configPath, err)
	}

	routing := codexCLIProviderRouting{
		Model:      strings.TrimSpace(userConfig.Model),
		ProviderID: strings.TrimSpace(userConfig.ModelProvider),
	}
	if routing.ProviderID == "" {
		return routing, nil
	}

	providerConfig, found := userConfig.ModelProviders[routing.ProviderID]
	if !found {
		if isCodexCLIBuiltInModelProvider(routing.ProviderID) {
			return routing, nil
		}
		return codexCLIProviderRouting{}, fmt.Errorf(
			"Codex CLI config selects model_provider %q, but [model_providers.%s] is missing; refusing to fall back to the OpenAI endpoint",
			routing.ProviderID,
			routing.ProviderID,
		)
	}
	if isCodexCLINonOverridableBuiltInModelProvider(routing.ProviderID) {
		return routing, nil
	}
	if err := validateCodexCLIModelProvider(routing.ProviderID, providerConfig); err != nil {
		return codexCLIProviderRouting{}, err
	}

	providerConfig, routing.Env = secureCodexCLIModelProvider(providerConfig)
	routing.Provider = &providerConfig
	return routing, nil
}

func codexCLIUserConfigPath(extraEnv map[string]string) (string, error) {
	if codexHome := strings.TrimSpace(extraEnv["CODEX_HOME"]); codexHome != "" {
		return filepath.Join(codexHome, "config.toml"), nil
	}
	if codexHome := strings.TrimSpace(os.Getenv("CODEX_HOME")); codexHome != "" {
		return filepath.Join(codexHome, "config.toml"), nil
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve Codex CLI config directory failed: %w", err)
	}
	return filepath.Join(userHome, ".codex", "config.toml"), nil
}

func validateCodexCLIModelProvider(providerID string, providerConfig codexCLIModelProviderConfig) error {
	if (providerID == "amazon-bedrock" || providerID == "amazon-bedrock-runtime") &&
		(len(providerConfig.HTTPHeaders) > 0 || len(providerConfig.EnvHTTPHeaders) > 0) {
		return fmt.Errorf(
			"Codex CLI built-in model provider %q uses header overrides that cannot be safely projected while user config is isolated",
			providerID,
		)
	}
	baseURL := strings.TrimSpace(providerConfig.BaseURL)
	if baseURL == "" {
		if isCodexCLIBuiltInModelProvider(providerID) {
			return nil
		}
		return fmt.Errorf("Codex CLI model provider %q has no base_url; refusing to fall back to the OpenAI endpoint", providerID)
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return fmt.Errorf("Codex CLI model provider %q has invalid base_url %q", providerID, sanitizeAIUpstreamURL(baseURL))
	}
	return nil
}

func isCodexCLIBuiltInModelProvider(providerID string) bool {
	switch providerID {
	case "openai", "amazon-bedrock", "amazon-bedrock-runtime", "ollama", "lmstudio":
		return true
	default:
		return false
	}
}

func isCodexCLINonOverridableBuiltInModelProvider(providerID string) bool {
	switch providerID {
	case "openai", "ollama", "lmstudio":
		return true
	default:
		return false
	}
}

func secureCodexCLIModelProvider(providerConfig codexCLIModelProviderConfig) (codexCLIModelProviderConfig, map[string]string) {
	env := make(map[string]string)
	usedEnvKeys := make(map[string]struct{}, len(providerConfig.EnvHTTPHeaders)+1)
	for _, envKey := range providerConfig.EnvHTTPHeaders {
		usedEnvKeys[envKey] = struct{}{}
	}
	if providerConfig.EnvKey != "" {
		usedEnvKeys[providerConfig.EnvKey] = struct{}{}
	}
	nextGeneratedEnvKey := func(prefix string) string {
		for index := 0; ; index++ {
			candidate := prefix
			if index > 0 {
				candidate += "_" + strconv.Itoa(index)
			}
			if _, exists := usedEnvKeys[candidate]; exists {
				continue
			}
			usedEnvKeys[candidate] = struct{}{}
			return candidate
		}
	}
	if providerConfig.ExperimentalBearerToken != "" {
		tokenEnvKey := nextGeneratedEnvKey("GONAVI_CODEX_PROVIDER_BEARER_TOKEN")
		env[tokenEnvKey] = providerConfig.ExperimentalBearerToken
		providerConfig.ExperimentalBearerToken = ""
		providerConfig.EnvKey = tokenEnvKey
	}

	if len(providerConfig.HTTPHeaders) > 0 {
		headerNames := make([]string, 0, len(providerConfig.HTTPHeaders))
		for headerName := range providerConfig.HTTPHeaders {
			headerNames = append(headerNames, headerName)
		}
		sort.Strings(headerNames)
		if providerConfig.EnvHTTPHeaders == nil {
			providerConfig.EnvHTTPHeaders = make(map[string]string, len(headerNames))
		} else {
			cloned := make(map[string]string, len(providerConfig.EnvHTTPHeaders)+len(headerNames))
			for headerName, envKey := range providerConfig.EnvHTTPHeaders {
				cloned[headerName] = envKey
			}
			providerConfig.EnvHTTPHeaders = cloned
		}
		for index, headerName := range headerNames {
			envKey := nextGeneratedEnvKey("GONAVI_CODEX_PROVIDER_HTTP_HEADER_" + strconv.Itoa(index))
			env[envKey] = providerConfig.HTTPHeaders[headerName]
			providerConfig.EnvHTTPHeaders[headerName] = envKey
		}
		providerConfig.HTTPHeaders = nil
	}
	return providerConfig, env
}

func codexCLIProviderNeedsLocalAuth(routing codexCLIProviderRouting) bool {
	if routing.Provider == nil {
		return routing.ProviderID == "" || routing.ProviderID == "openai"
	}
	return routing.Provider.RequiresOpenAIAuth != nil && *routing.Provider.RequiresOpenAIAuth
}

func validateCodexCLIProviderAuthEnvironment(routing codexCLIProviderRouting, configuredEnv map[string]string) error {
	if routing.Provider == nil || codexCLIProviderNeedsLocalAuth(routing) {
		return nil
	}
	envKey := strings.TrimSpace(routing.Provider.EnvKey)
	if envKey == "" {
		return nil
	}
	if value := strings.TrimSpace(routing.Env[envKey]); value != "" {
		return nil
	}
	if value := strings.TrimSpace(configuredEnv[envKey]); value != "" {
		return nil
	}
	if value := strings.TrimSpace(os.Getenv(envKey)); value != "" {
		return nil
	}
	return fmt.Errorf("Codex CLI model provider %q requires environment variable %s, but it is not set", routing.ProviderID, envKey)
}

func mergeCodexCLIProviderEnv(configured, generated map[string]string) map[string]string {
	if len(generated) == 0 {
		return configured
	}
	merged := make(map[string]string, len(configured)+len(generated))
	for key, value := range configured {
		merged[key] = value
	}
	for key, value := range generated {
		merged[key] = value
	}
	return merged
}

func appendCodexCLIProviderRoutingArgs(args []string, routing codexCLIProviderRouting) []string {
	if routing.ProviderID == "" {
		return args
	}
	args = appendCodexCLIConfigArg(args, "model_provider", tomlStringValue(routing.ProviderID))
	if routing.Provider == nil {
		return args
	}

	provider := routing.Provider
	prefix := "model_providers." + tomlKeySegment(routing.ProviderID) + "."
	appendString := func(name, value string) {
		if value != "" {
			args = appendCodexCLIConfigArg(args, prefix+name, tomlStringValue(value))
		}
	}
	appendInt := func(name string, value *int64) {
		if value != nil {
			args = appendCodexCLIConfigArg(args, prefix+name, strconv.FormatInt(*value, 10))
		}
	}
	appendBool := func(name string, value *bool) {
		if value != nil {
			args = appendCodexCLIConfigArg(args, prefix+name, strconv.FormatBool(*value))
		}
	}

	appendString("name", provider.Name)
	appendString("base_url", provider.BaseURL)
	appendString("env_key", provider.EnvKey)
	appendString("env_key_instructions", provider.EnvKeyInstructions)
	appendString("wire_api", provider.WireAPI)
	appendBool("requires_openai_auth", provider.RequiresOpenAIAuth)
	if len(provider.QueryParams) > 0 {
		args = appendCodexCLIConfigArg(args, prefix+"query_params", tomlStringMapValue(provider.QueryParams))
	}
	if len(provider.EnvHTTPHeaders) > 0 {
		args = appendCodexCLIConfigArg(args, prefix+"env_http_headers", tomlStringMapValue(provider.EnvHTTPHeaders))
	}
	appendInt("request_max_retries", provider.RequestMaxRetries)
	appendInt("stream_max_retries", provider.StreamMaxRetries)
	appendInt("stream_idle_timeout_ms", provider.StreamIdleTimeoutMS)
	appendInt("websocket_connect_timeout_ms", provider.WebSocketConnectTimeoutMS)
	appendBool("supports_websockets", provider.SupportsWebSockets)
	appendBool("supports_standalone_web_search", provider.SupportsStandaloneWebSearch)

	if provider.Auth != nil {
		authPrefix := prefix + "auth."
		if provider.Auth.Command != "" {
			args = appendCodexCLIConfigArg(args, authPrefix+"command", tomlStringValue(provider.Auth.Command))
		}
		if len(provider.Auth.Args) > 0 {
			args = appendCodexCLIConfigArg(args, authPrefix+"args", tomlStringSliceValue(provider.Auth.Args))
		}
		if provider.Auth.TimeoutMS != nil {
			args = appendCodexCLIConfigArg(args, authPrefix+"timeout_ms", strconv.FormatInt(*provider.Auth.TimeoutMS, 10))
		}
		if provider.Auth.RefreshIntervalMS != nil {
			args = appendCodexCLIConfigArg(args, authPrefix+"refresh_interval_ms", strconv.FormatInt(*provider.Auth.RefreshIntervalMS, 10))
		}
		if provider.Auth.Cwd != "" {
			args = appendCodexCLIConfigArg(args, authPrefix+"cwd", tomlStringValue(provider.Auth.Cwd))
		}
	}
	if provider.AWS != nil {
		awsPrefix := prefix + "aws."
		if provider.AWS.Profile != "" {
			args = appendCodexCLIConfigArg(args, awsPrefix+"profile", tomlStringValue(provider.AWS.Profile))
		}
		if provider.AWS.Region != "" {
			args = appendCodexCLIConfigArg(args, awsPrefix+"region", tomlStringValue(provider.AWS.Region))
		}
		args = appendCodexCLIAWSCommandArgs(args, awsPrefix+"credential_export.", provider.AWS.CredentialExport)
		args = appendCodexCLIAWSCommandArgs(args, awsPrefix+"auth_refresh.", provider.AWS.AuthRefresh)
	}
	return args
}

func appendCodexCLIAWSCommandArgs(args []string, prefix string, command *codexCLIModelProviderAWSCommand) []string {
	if command == nil {
		return args
	}
	if command.Command != "" {
		args = appendCodexCLIConfigArg(args, prefix+"command", tomlStringValue(command.Command))
	}
	if len(command.Args) > 0 {
		args = appendCodexCLIConfigArg(args, prefix+"args", tomlStringSliceValue(command.Args))
	}
	if command.TimeoutMS != nil {
		args = appendCodexCLIConfigArg(args, prefix+"timeout_ms", strconv.FormatInt(*command.TimeoutMS, 10))
	}
	return args
}

func appendCodexCLIConfigArg(args []string, key, value string) []string {
	return append(args, "-c", key+"="+value)
}

func tomlStringValue(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func tomlKeySegment(value string) string {
	if value != "" && strings.IndexFunc(value, func(r rune) bool {
		return !(r >= 'a' && r <= 'z') && !(r >= 'A' && r <= 'Z') && !(r >= '0' && r <= '9') && r != '_' && r != '-'
	}) == -1 {
		return value
	}
	return tomlStringValue(value)
}

func tomlStringMapValue(values map[string]string) string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, tomlKeySegment(key)+"="+tomlStringValue(values[key]))
	}
	return "{" + strings.Join(parts, ",") + "}"
}

func tomlStringSliceValue(values []string) string {
	parts := make([]string, 0, len(values))
	for _, value := range values {
		parts = append(parts, tomlStringValue(value))
	}
	return "[" + strings.Join(parts, ",") + "]"
}

func buildCodexCLIEnv(baseEnv []string, commandPath string) []string {
	return EnrichCLICommandPATH(baseEnv, commandPath)
}

func buildCodexCLIEnvWithConfig(baseEnv []string, commandPath string, extra map[string]string) []string {
	return buildCodexCLIEnv(MergeProviderCLIEnv(baseEnv, extra), commandPath)
}

type codexCLIStreamDelta struct {
	Thinking string
}

func consumeCodexCLIEvent(result *codexCLIResult, event codexCLIEvent) codexCLIStreamDelta {
	delta := codexCLIStreamDelta{}
	switch event.Type {
	case "item.completed":
		switch event.Item.Type {
		case "agent_message":
			if text := strings.TrimSpace(event.Item.Text); text != "" {
				// Codex 可能在内部循环中产生多条 agent_message；最终一条才是用户可见答案。
				// 正文不能边到边推：前端按增量拼接，草稿+终稿会叠在一起。
				result.Content = text
			}
		case "reasoning":
			if text := strings.TrimSpace(event.Item.Text); text != "" {
				result.Thinking = text
				delta.Thinking = text
			}
		}
	case "turn.completed":
		result.Completed = true
		result.TerminalError = ""
		cached := event.Usage.CachedInputTokens
		result.Usage = ai.TokenUsage{
			PromptTokens: event.Usage.InputTokens,
			// Codex reports reasoning_output_tokens as a breakdown of output_tokens,
			// not an additional token bucket.
			CompletionTokens: event.Usage.OutputTokens,
			TotalTokens:      event.Usage.InputTokens + event.Usage.OutputTokens,
			CachedTokens:     &cached,
		}
	case "turn.failed":
		result.TerminalError = strings.TrimSpace(event.Error.Message)
		if result.TerminalError == "" {
			result.TerminalError = "turn failed"
		}
	case "error":
		// 顶层 error 可能是 CLI 即将重试的瞬时错误，只有缺少成功终态时才作为兜底。
		message := strings.TrimSpace(event.Message)
		if message == "" {
			message = strings.TrimSpace(event.Error.Message)
		}
		if message != "" {
			result.LastError = message
		}
	}
	return delta
}

func resolveCodexCLICommand(goos, goarch string, lookPath func(string) (string, error), exists func(string) bool) (codexCLICommand, error) {
	if goos != "windows" {
		path, err := lookPath("codex")
		if err != nil {
			return codexCLICommand{}, codexCLIInstallError()
		}
		for _, nativePath := range codexNPMNativeBinaryCandidates(path, goos, goarch) {
			if exists(nativePath) {
				return codexCLICommand{Path: nativePath}, nil
			}
		}
		return codexCLICommand{Path: path}, nil
	}

	cmdPath, err := lookPath("codex.cmd")
	if err == nil && exists(cmdPath) {
		for _, nativePath := range codexNPMNativeBinaryCandidates(cmdPath, goos, goarch) {
			if exists(nativePath) {
				return codexCLICommand{Path: nativePath}, nil
			}
		}
	}

	if path, err := lookPath("codex.exe"); err == nil && exists(path) {
		return codexCLICommand{Path: path}, nil
	}

	return codexCLICommand{}, codexCLIInstallError()
}

func codexNPMNativeBinaryCandidates(launcherPath, goos, goarch string) []string {
	platformPackage, targetTriple, binaryName, ok := codexNPMPlatformTarget(goos, goarch)
	if !ok {
		return nil
	}

	packageRoots := []string{
		filepath.Join(filepath.Dir(launcherPath), "node_modules", "@openai", "codex"),
		filepath.Join(filepath.Dir(filepath.Dir(launcherPath)), "lib", "node_modules", "@openai", "codex"),
	}
	if resolved, err := codexEvalSymlinks(launcherPath); err == nil {
		if strings.EqualFold(filepath.Base(resolved), "codex.js") && strings.EqualFold(filepath.Base(filepath.Dir(resolved)), "bin") {
			packageRoots = append(packageRoots, filepath.Dir(filepath.Dir(resolved)))
		}
	}

	seen := make(map[string]struct{})
	candidates := make([]string, 0, len(packageRoots)*4)
	for _, packageRoot := range packageRoots {
		platformVendor := filepath.Join(packageRoot, "node_modules", "@openai", platformPackage, "vendor", targetTriple)
		localVendor := filepath.Join(packageRoot, "vendor", targetTriple)
		for _, candidate := range []string{
			filepath.Join(platformVendor, "bin", binaryName),
			filepath.Join(platformVendor, "codex", binaryName),
			filepath.Join(localVendor, "bin", binaryName),
			filepath.Join(localVendor, "codex", binaryName),
		} {
			if _, exists := seen[candidate]; exists {
				continue
			}
			seen[candidate] = struct{}{}
			candidates = append(candidates, candidate)
		}
	}
	return candidates
}

func codexNPMPlatformTarget(goos, goarch string) (platformPackage, targetTriple, binaryName string, ok bool) {
	arch := strings.ToLower(strings.TrimSpace(goarch))
	switch strings.ToLower(strings.TrimSpace(goos)) {
	case "windows":
		switch arch {
		case "amd64":
			return "codex-win32-x64", "x86_64-pc-windows-msvc", "codex.exe", true
		case "arm64":
			return "codex-win32-arm64", "aarch64-pc-windows-msvc", "codex.exe", true
		}
	case "darwin":
		switch arch {
		case "amd64":
			return "codex-darwin-x64", "x86_64-apple-darwin", "codex", true
		case "arm64":
			return "codex-darwin-arm64", "aarch64-apple-darwin", "codex", true
		}
	case "linux":
		switch arch {
		case "amd64":
			return "codex-linux-x64", "x86_64-unknown-linux-musl", "codex", true
		case "arm64":
			return "codex-linux-arm64", "aarch64-unknown-linux-musl", "codex", true
		}
	}
	return "", "", "", false
}

func codexCLIInstallError() error {
	return fmt.Errorf("codex command was not found; install the official Codex CLI first: npm install -g @openai/codex")
}

func buildCodexCLIRequestLogBody(args []string, prompt string, config ai.ProviderConfig, req ai.ChatRequest) map[string]any {
	return map[string]any{
		"command":       "codex",
		"args":          sanitizeCodexCLIArgsForLog(args),
		"prompt":        prompt,
		"model":         strings.TrimSpace(config.Model),
		"auth_mode":     strings.TrimSpace(config.AuthMode),
		"message_count": len(req.Messages),
		"tool_count":    len(req.Tools),
		"tool_names":    claudeCLIToolNamesForLog(req.Tools),
	}
}

func sanitizeCodexCLIArgsForLog(args []string) []string {
	sanitized := append([]string(nil), args...)
	for index := 0; index < len(sanitized)-1; index++ {
		if sanitized[index] != "-c" && sanitized[index] != "--config" {
			continue
		}
		key, _, found := strings.Cut(sanitized[index+1], "=")
		if found && strings.HasPrefix(strings.TrimSpace(key), "model_providers.") {
			sanitized[index+1] = strings.TrimSpace(key) + "=[REDACTED]"
		}
		index++
	}
	return sanitized
}
