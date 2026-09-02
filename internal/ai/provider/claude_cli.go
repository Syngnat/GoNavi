package provider

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	ai "GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/logger"
)

var claudeLookPath = lookupLocalCLICommand
var claudeCommandContext = exec.CommandContext
var claudeEvalSymlinks = filepath.EvalSymlinks
var claudeCLIRequestTimeout = 90 * time.Second
var claudeCLIAuthStatusTimeout = 10 * time.Second

var claudeCLILocalAuthBlockedEnvKeys = []string{
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_BEDROCK_BASE_URL",
	"ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
	"ANTHROPIC_CUSTOM_HEADERS",
	"ANTHROPIC_FOUNDRY_API_KEY",
	"ANTHROPIC_FOUNDRY_AUTH_TOKEN",
	"ANTHROPIC_FOUNDRY_BASE_URL",
	"ANTHROPIC_FOUNDRY_RESOURCE",
	"ANTHROPIC_VERTEX_BASE_URL",
	"ANTHROPIC_VERTEX_PROJECT_ID",
	"AWS_ACCESS_KEY_ID",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_PROFILE",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"CLAUDE_API_KEY",
	"CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
	"CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
	"CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
	"CLAUDE_CODE_SKIP_BEDROCK_AUTH",
	"CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
	"CLAUDE_CODE_SKIP_MANTLE_AUTH",
	"CLAUDE_CODE_SKIP_VERTEX_AUTH",
	"CLAUDE_CODE_USE_ANTHROPIC_AWS",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_USE_MANTLE",
	"CLAUDE_CODE_USE_VERTEX",
	"GCLOUD_PROJECT",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
}

var claudeCLILocalAuthIsolationEnvKeys = []string{
	"CLAUDE_CODE_DISABLE_CLAUDE_MDS",
	"CLAUDE_CODE_DISABLE_AUTO_MEMORY",
	"CLAUDE_CODE_DISABLE_POLICY_SKILLS",
	"CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL",
	"CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL",
	"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
}

var claudeCLILocalAuthSettings = buildClaudeCLILocalAuthSettings()

func buildClaudeCLILocalAuthSettings() string {
	settings := map[string]any{
		"apiKeyHelper":     "",
		"claudeMdExcludes": []string{"**"},
		"disableAllHooks":  true,
		"enabledPlugins":   map[string]bool{},
		// Replace the complete user-settings env block. Per-key null values are
		// materialized as environment entries by Claude Code and can shadow OAuth.
		"env": nil,
	}
	encoded, err := json.Marshal(settings)
	if err != nil {
		panic(fmt.Sprintf("encode Claude CLI isolation settings: %v", err))
	}
	return string(encoded)
}

type claudeCLIAuthStatus struct {
	LoggedIn     bool   `json:"loggedIn"`
	AuthMethod   string `json:"authMethod"`
	APIProvider  string `json:"apiProvider"`
	APIKeySource string `json:"apiKeySource"`
	// SubscriptionType 是新版 Claude Code 直接给出的订阅事实（如 max / pro / team）。
	// 它比 authMethod 的措辞可靠：2.1.241 起订阅登录的 authMethod 已改报 "claude.ai"，
	// 只按旧的 oauth 词表判定会把真实的 Max 订阅误判成"未连接"。
	SubscriptionType string `json:"subscriptionType"`
}

// claudeCLINonSubscriptionPlans 是明确不算订阅的取值；其余非空取值一律视为有效订阅，
// 这样上游新增套餐名不会再次把可用账号判死。
var claudeCLINonSubscriptionPlans = map[string]struct{}{
	"":     {},
	"none": {},
	"free": {},
}

// claudeCLISubscriptionAuthMethods 是旧版 CLI 未提供 subscriptionType 时的回退词表。
var claudeCLISubscriptionAuthMethods = map[string]struct{}{
	"oauth":       {},
	"oauth_token": {},
	"claude.ai":   {},
	"claude_ai":   {},
}

type claudeCLICommand struct {
	Path string
}

// ClaudeCLIProvider 通过 Claude Code CLI 发送聊天请求。
// AuthMode=local-cli 时复用 Claude Code 官方登录态；其他配置仍支持兼容代理服务。
type ClaudeCLIProvider struct {
	config ai.ProviderConfig
}

// NewClaudeCLIProvider 创建 ClaudeCLIProvider 实例
func NewClaudeCLIProvider(config ai.ProviderConfig) (Provider, error) {
	return &ClaudeCLIProvider{config: config}, nil
}

func (p *ClaudeCLIProvider) Name() string {
	return "ClaudeCLI"
}

func (p *ClaudeCLIProvider) Validate() error {
	_, err := resolveClaudeCLICommand(runtime.GOOS, runtime.GOARCH, claudeLookPath, fileExists)
	if err != nil {
		return err
	}
	if _, err := resolveClaudeCodeGitBashPath(os.Environ(), runtime.GOOS, claudeLookPath, fileExists); err != nil {
		return err
	}
	return nil
}

// CheckClaudeCLILocalAuth validates the local Claude Code subscription login
// without sending a model request or consuming subscription quota.
func CheckClaudeCLILocalAuth(ctx context.Context) error {
	command, err := resolveClaudeCLICommand(runtime.GOOS, runtime.GOARCH, claudeLookPath, fileExists)
	if err != nil {
		return err
	}

	ctx, cancel := ensureClaudeCLITimeout(ctx, claudeCLIAuthStatusTimeout)
	defer cancel()

	args := append(buildClaudeCLILocalAuthIsolationArgs(), "auth", "status", "--json")
	cmd := newClaudeCLICommand(ctx, command.Path, args...)
	env, err := buildClaudeCLIEnv(ai.ProviderConfig{AuthMode: "local-cli"}, cmd.Environ(), runtime.GOOS, claudeLookPath, fileExists)
	if err != nil {
		return err
	}
	cmd.Env = EnrichCLICommandPATH(env, command.Path)

	output, commandErr := cmd.Output()
	if errors.Is(ctx.Err(), context.Canceled) {
		return context.Canceled
	}
	if isClaudeCLITimeout(ctx, commandErr) {
		return fmt.Errorf("Claude Code authentication status check timed out after %s", claudeCLIAuthStatusTimeout)
	}

	var status claudeCLIAuthStatus
	parseErr := json.Unmarshal(output, &status)
	if parseErr == nil {
		if err := validateClaudeCLISubscriptionStatus(status); err != nil {
			return err
		}
		if commandErr == nil {
			return nil
		}
	}

	if commandErr != nil {
		detail := strings.TrimSpace(commandErr.Error())
		if exitErr, ok := commandErr.(*exec.ExitError); ok {
			if stderr := strings.TrimSpace(string(exitErr.Stderr)); stderr != "" {
				detail = stderr
			}
		}
		return fmt.Errorf("Claude Code authentication status check failed: %s", detail)
	}
	return fmt.Errorf("parse Claude Code authentication status failed: %w", parseErr)
}

func validateClaudeCLISubscriptionStatus(status claudeCLIAuthStatus) error {
	if !status.LoggedIn {
		return fmt.Errorf("Claude Code CLI is not logged in; run claude auth login with a Claude subscription")
	}
	if source := strings.TrimSpace(status.APIKeySource); source != "" {
		return fmt.Errorf("Claude Code CLI is being overridden by API key source %s; remove that API key before using the Claude subscription provider", source)
	}
	providerName := strings.NewReplacer("-", "", "_", "").Replace(strings.ToLower(strings.TrimSpace(status.APIProvider)))
	if providerName != "" && providerName != "firstparty" {
		return fmt.Errorf("Claude Code CLI is using provider %s instead of the first-party Claude subscription", status.APIProvider)
	}
	// subscriptionType 是权威事实，优先于 authMethod 的措辞。
	// 只有该字段缺失（旧版 CLI）时才回退到词表匹配。
	plan := strings.ToLower(strings.TrimSpace(status.SubscriptionType))
	if _, notSubscription := claudeCLINonSubscriptionPlans[plan]; !notSubscription {
		return nil
	}
	if status.SubscriptionType != "" {
		return fmt.Errorf("Claude Code CLI reports subscription %s, which is not a paid Claude subscription; run claude auth login", status.SubscriptionType)
	}

	authMethod := strings.NewReplacer("-", "_", " ", "_").Replace(strings.ToLower(strings.TrimSpace(status.AuthMethod)))
	if _, ok := claudeCLISubscriptionAuthMethods[authMethod]; !ok {
		return fmt.Errorf("Claude Code CLI is authenticated with %s instead of a Claude subscription; run claude auth login", firstNonEmptyCLIValue(status.AuthMethod, "an unsupported method"))
	}
	return nil
}

func firstNonEmptyCLIValue(value string, fallback string) string {
	if value = strings.TrimSpace(value); value != "" {
		return value
	}
	return fallback
}

// Chat 非流式聊天：调用 claude -p "prompt" --output-format json
func (p *ClaudeCLIProvider) Chat(ctx context.Context, req ai.ChatRequest) (*ai.ChatResponse, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	if isLocalCLIAuthMode(p.config) {
		if err := CheckClaudeCLILocalAuth(ctx); err != nil {
			return nil, err
		}
	}

	ctx, cancel := ensureClaudeCLITimeout(ctx, claudeCLIRequestTimeout)
	defer cancel()

	prompt := buildPrompt(req.Messages)
	args := buildClaudeCLIArgs(p.config, prompt, false)
	if p.config.Model != "" {
		args = append(args, "--model", p.config.Model)
	}

	command, err := resolveClaudeCLICommand(runtime.GOOS, runtime.GOARCH, claudeLookPath, fileExists)
	if err != nil {
		return nil, err
	}
	cmd := newClaudeCLICommand(ctx, command.Path, args...)
	if err := p.setEnv(cmd); err != nil {
		return nil, err
	}
	cleanup, err := configureClaudeCLILocalAuthCommand(cmd, p.config, prompt)
	if err != nil {
		return nil, err
	}
	defer cleanup()

	requestLog := logAIUpstreamRequestStart(
		p.Name(),
		"CLI",
		claudeCLIEndpointForLog(p.config),
		buildClaudeCLIRequestLogBody("json", args, prompt, p.config, req),
	)
	var requestErr error
	defer func() {
		logAIUpstreamRequestFinish(requestLog, 0, requestErr)
	}()

	output, err := cmd.Output()
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			requestErr = context.Canceled
			return nil, context.Canceled
		}
		if isClaudeCLITimeout(ctx, err) {
			requestErr = fmt.Errorf("claude CLI timed out after %s; the current Base URL or API key may not be returning a valid response", claudeCLIRequestTimeout)
			return nil, requestErr
		}
		if exitErr, ok := err.(*exec.ExitError); ok {
			requestErr = fmt.Errorf("claude CLI execution failed: %s", string(exitErr.Stderr))
			return nil, requestErr
		}
		requestErr = fmt.Errorf("claude CLI execution failed: %w", err)
		return nil, requestErr
	}

	// 解析 JSON 输出
	var result cliStreamEvent
	if err := json.Unmarshal(output, &result); err != nil {
		// 如果 JSON 解析失败，直接返回原始文本
		return &ai.ChatResponse{Content: strings.TrimSpace(string(output))}, nil
	}
	if errMsg, hasError := extractClaudeCLIEventError(result); hasError {
		requestErr = fmt.Errorf("claude CLI returned an error: %s", errMsg)
		return nil, requestErr
	}

	return &ai.ChatResponse{Content: result.Result}, nil
}

// ChatStream 流式聊天：调用 claude -p "prompt" --output-format stream-json
func (p *ClaudeCLIProvider) ChatStream(ctx context.Context, req ai.ChatRequest, callback func(ai.StreamChunk)) error {
	if err := p.Validate(); err != nil {
		return err
	}
	if isLocalCLIAuthMode(p.config) {
		if err := CheckClaudeCLILocalAuth(ctx); err != nil {
			return err
		}
	}

	ctx, cancel := ensureClaudeCLITimeout(ctx, claudeCLIRequestTimeout)
	defer cancel()

	prompt := buildPrompt(req.Messages)
	args := buildClaudeCLIArgs(p.config, prompt, true)
	if p.config.Model != "" {
		args = append(args, "--model", p.config.Model)
	}

	command, err := resolveClaudeCLICommand(runtime.GOOS, runtime.GOARCH, claudeLookPath, fileExists)
	if err != nil {
		return err
	}
	cmd := newClaudeCLICommand(ctx, command.Path, args...)
	if err := p.setEnv(cmd); err != nil {
		return err
	}
	cleanup, err := configureClaudeCLILocalAuthCommand(cmd, p.config, prompt)
	if err != nil {
		return err
	}
	defer cleanup()

	requestLog := logAIUpstreamRequestStart(
		p.Name(),
		"CLI",
		claudeCLIEndpointForLog(p.config),
		buildClaudeCLIRequestLogBody("stream-json", args, prompt, p.config, req),
	)
	var requestErr error
	defer func() {
		logAIUpstreamRequestFinish(requestLog, 0, requestErr)
	}()

	// 代理模式的 prompt 已在 argv 中；订阅模式则通过 stdin 传入，避免出现在进程列表。
	if !isLocalCLIAuthMode(p.config) {
		cmd.Stdin = nil
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		requestErr = fmt.Errorf("failed to create stdout pipe: %w", err)
		return requestErr
	}

	// 捕获 stderr
	var stderrBuf bytes.Buffer
	cmd.Stderr = &stderrBuf

	if err := cmd.Start(); err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			requestErr = context.Canceled
			return context.Canceled
		}
		requestErr = fmt.Errorf("failed to start claude CLI: %w", err)
		return requestErr
	}

	if cmd.Process != nil {
		logger.Infof("ClaudeCLI 请求进程已启动：requestId=%s pid=%d", requestLog.id, cmd.Process.Pid)
	}

	// 前端已有 loading 动画，无需在 content 中注入"正在思考"

	// 逐行读取流式 JSON 输出
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}

		var event cliStreamEvent
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			logger.Warnf("ClaudeCLI 忽略非 JSON 输出：requestId=%s line=%s", requestLog.id, RedactAIUpstreamLogText(line))
			continue
		}

		switch event.Type {
		case "system":
			if isClaudeCLISystemRetryEvent(event) {
				if errMsg, hasError := extractClaudeCLISystemRetryError(event); hasError {
					callback(ai.StreamChunk{Error: errMsg, Done: true})
					requestErr = fmt.Errorf("claude CLI authentication failed: %s", errMsg)
					if cmd.Process != nil {
						_ = cmd.Process.Kill()
					}
					_ = cmd.Wait()
					return nil
				}
			}
		case "assistant":
			if errMsg, hasError := extractClaudeCLIEventError(event); hasError {
				callback(ai.StreamChunk{Error: errMsg, Done: true})
				requestErr = fmt.Errorf("claude CLI returned an error: %s", errMsg)
				_ = cmd.Wait()
				return nil
			}
			// 助手消息开始或文本内容
			if event.Message.Content != nil {
				for _, block := range event.Message.Content {
					if block.Type == "thinking" && block.Thinking != "" {
						callback(ai.StreamChunk{Thinking: block.Thinking})
					} else if block.Type == "text" && block.Text != "" {
						callback(ai.StreamChunk{Content: block.Text})
					}
				}
			}
		case "content_block_delta":
			// 增量文本或增量思考
			if event.Delta.Type == "thinking_delta" && event.Delta.Thinking != "" {
				callback(ai.StreamChunk{Thinking: event.Delta.Thinking})
			} else if event.Delta.Text != "" {
				callback(ai.StreamChunk{Content: event.Delta.Text})
			}
		case "result":
			if errMsg, hasError := extractClaudeCLIEventError(event); hasError {
				callback(ai.StreamChunk{Error: errMsg, Done: true})
				requestErr = fmt.Errorf("claude CLI returned an error: %s", errMsg)
				_ = cmd.Wait()
				return nil
			}
			// 最终结果事件 — 不发送 content（assistant 事件已包含），只标记完成
			callback(ai.StreamChunk{Done: true})
			_ = cmd.Wait()
			return nil
		case "error":
			errMsg, _ := extractClaudeCLIEventError(event)
			callback(ai.StreamChunk{Error: errMsg, Done: true})
			requestErr = fmt.Errorf("claude CLI returned an error: %s", errMsg)
			_ = cmd.Wait()
			return nil
		}
	}

	waitErr := cmd.Wait()
	stderrStr := strings.TrimSpace(stderrBuf.String())
	if errors.Is(ctx.Err(), context.Canceled) {
		requestErr = context.Canceled
		return context.Canceled
	}

	if isClaudeCLITimeout(ctx, waitErr) {
		requestErr = fmt.Errorf("claude CLI timed out after %s; the current Base URL or API key may not be returning a valid response", claudeCLIRequestTimeout)
		callback(ai.StreamChunk{
			Error: requestErr.Error(),
			Done:  true,
		})
		return nil
	}

	if waitErr != nil {
		errMsg := fmt.Sprintf("claude CLI exited unexpectedly: %v", waitErr)
		if stderrStr != "" {
			errMsg = fmt.Sprintf("claude CLI exited unexpectedly: %s", stderrStr)
		}
		requestErr = fmt.Errorf("%s", errMsg)
		callback(ai.StreamChunk{Error: errMsg, Done: true})
		return nil
	}

	callback(ai.StreamChunk{Done: true})
	return nil
}

func ensureClaudeCLITimeout(ctx context.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
	if _, hasDeadline := ctx.Deadline(); hasDeadline || timeout <= 0 {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, timeout)
}

func isClaudeCLITimeout(ctx context.Context, err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded)
}

func newClaudeCLICommand(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := claudeCommandContext(ctx, name, args...)
	configureClaudeCLICommand(cmd)
	return cmd
}

func claudeCLIEndpointForLog(config ai.ProviderConfig) string {
	baseURL := strings.TrimRight(strings.TrimSpace(config.BaseURL), "/")
	if baseURL != "" {
		return sanitizeAIUpstreamURL(baseURL)
	}
	return "claude://cli"
}

func buildClaudeCLIRequestLogBody(outputFormat string, args []string, prompt string, config ai.ProviderConfig, req ai.ChatRequest) map[string]any {
	return map[string]any{
		"command":       "claude",
		"args":          claudeCLIArgsForLog(args),
		"prompt":        prompt,
		"output_format": outputFormat,
		"model":         strings.TrimSpace(config.Model),
		"base_url":      claudeCLIEndpointForLog(config),
		"has_api_key":   strings.TrimSpace(config.APIKey) != "",
		"message_count": len(req.Messages),
		"tool_count":    len(req.Tools),
		"tool_names":    claudeCLIToolNamesForLog(req.Tools),
	}
}

func resolveClaudeCLICommand(goos, goarch string, lookPath func(string) (string, error), exists func(string) bool) (claudeCLICommand, error) {
	if strings.EqualFold(strings.TrimSpace(goos), "windows") {
		if launcherPath, err := lookPath("claude.cmd"); err == nil && exists(launcherPath) {
			for _, nativePath := range claudeNPMNativeBinaryCandidates(launcherPath, goos, goarch) {
				if exists(nativePath) {
					return claudeCLICommand{Path: nativePath}, nil
				}
			}
		}

		if path, err := lookPath("claude.exe"); err == nil && exists(path) {
			return claudeCLICommand{Path: path}, nil
		}
		if path, err := lookPath("claude"); err == nil && exists(path) && strings.EqualFold(filepath.Ext(path), ".exe") {
			return claudeCLICommand{Path: path}, nil
		}
		return claudeCLICommand{}, claudeCLIInstallError()
	}

	path, err := lookPath("claude")
	if err != nil || !exists(path) {
		return claudeCLICommand{}, claudeCLIInstallError()
	}
	for _, nativePath := range claudeNPMNativeBinaryCandidates(path, goos, goarch) {
		if exists(nativePath) {
			return claudeCLICommand{Path: nativePath}, nil
		}
	}
	return claudeCLICommand{Path: path}, nil
}

func claudeNPMNativeBinaryCandidates(launcherPath, goos, goarch string) []string {
	packageRoots := []string{
		filepath.Join(filepath.Dir(launcherPath), "node_modules", "@anthropic-ai", "claude-code"),
		filepath.Join(filepath.Dir(filepath.Dir(launcherPath)), "lib", "node_modules", "@anthropic-ai", "claude-code"),
		filepath.Join(filepath.Dir(filepath.Dir(launcherPath)), "@anthropic-ai", "claude-code"),
	}

	resolvedPath := ""
	if resolved, err := claudeEvalSymlinks(launcherPath); err == nil {
		resolvedPath = resolved
		packageRoots = append(packageRoots,
			filepath.Join(filepath.Dir(resolved), "node_modules", "@anthropic-ai", "claude-code"),
			filepath.Join(filepath.Dir(filepath.Dir(resolved)), "lib", "node_modules", "@anthropic-ai", "claude-code"),
			filepath.Join(filepath.Dir(filepath.Dir(resolved)), "@anthropic-ai", "claude-code"),
		)
		if strings.EqualFold(filepath.Base(resolved), "claude.exe") && strings.EqualFold(filepath.Base(filepath.Dir(resolved)), "bin") {
			packageRoots = append(packageRoots, filepath.Dir(filepath.Dir(resolved)))
		}
	}

	platformPackage, platformBinary, hasPlatformPackage := claudeNPMPlatformTarget(goos, goarch)
	seen := make(map[string]struct{})
	candidates := make([]string, 0, len(packageRoots)*3+1)
	appendCandidate := func(candidate string) {
		candidate = filepath.Clean(candidate)
		key := candidate
		if strings.EqualFold(strings.TrimSpace(goos), "windows") {
			key = strings.ToLower(candidate)
		}
		if _, found := seen[key]; found {
			return
		}
		seen[key] = struct{}{}
		candidates = append(candidates, candidate)
	}

	if resolvedPath != "" && strings.EqualFold(filepath.Ext(resolvedPath), ".exe") {
		appendCandidate(resolvedPath)
	}
	for _, packageRoot := range packageRoots {
		if hasPlatformPackage {
			appendCandidate(filepath.Join(filepath.Dir(packageRoot), platformPackage, platformBinary))
			appendCandidate(filepath.Join(packageRoot, "node_modules", "@anthropic-ai", platformPackage, platformBinary))
		}
		appendCandidate(filepath.Join(packageRoot, "bin", "claude.exe"))
	}
	return candidates
}

func claudeNPMPlatformTarget(goos, goarch string) (packageName, binaryName string, ok bool) {
	arch := strings.ToLower(strings.TrimSpace(goarch))
	archName := ""
	switch arch {
	case "amd64":
		archName = "x64"
	case "arm64":
		archName = "arm64"
	default:
		return "", "", false
	}

	switch strings.ToLower(strings.TrimSpace(goos)) {
	case "windows":
		return "claude-code-win32-" + archName, "claude.exe", true
	case "darwin":
		return "claude-code-darwin-" + archName, "claude", true
	case "linux":
		return "claude-code-linux-" + archName, "claude", true
	default:
		return "", "", false
	}
}

func claudeCLIInstallError() error {
	return fmt.Errorf("claude command was not found; install Claude Code CLI first: npm install -g @anthropic-ai/claude-code")
}

func buildClaudeCLIArgs(config ai.ProviderConfig, prompt string, stream bool) []string {
	args := []string{"--print"}
	if !isLocalCLIAuthMode(config) {
		args = []string{"-p", prompt}
	}
	outputFormat := "json"
	if stream {
		outputFormat = "stream-json"
	}
	args = append(args, "--output-format", outputFormat)
	if stream {
		args = append(args, "--verbose", "--include-partial-messages")
	}
	args = append(args, "--no-session-persistence")
	if isLocalCLIAuthMode(config) {
		args = append(args, buildClaudeCLILocalAuthIsolationArgs()...)
	}
	// Claude Code 对非法 --effort 只打警告然后静默降级为默认档位并照常执行，
	// 所以这里必须先按能力表校验；下发一个会被降级的值等于让用户以为档位生效了。
	if capability, ok := LookupCLICapability("claude-cli"); ok {
		if effort, err := capability.NormalizeEffort(config.Effort); err == nil {
			args = capability.AppendEffortArgs(args, effort)
		}
	}
	return args
}

func buildClaudeCLILocalAuthIsolationArgs() []string {
	// Claude Code 2.1.132 ties Windows OAuth credential loading to the user source.
	// Keep that source for authentication, then neutralize its executable and
	// instruction-bearing extensions explicitly. An empty setting source would
	// also hide the OAuth credential and make subscription login unusable.
	return []string{
		"--setting-sources", "user",
		"--settings", claudeCLILocalAuthSettings,
		"--strict-mcp-config",
		"--tools", "",
		"--disable-slash-commands",
		"--permission-mode", "dontAsk",
		"--no-chrome",
	}
}

func isLocalCLIAuthMode(config ai.ProviderConfig) bool {
	return strings.EqualFold(strings.TrimSpace(config.AuthMode), "local-cli")
}

func configureClaudeCLILocalAuthCommand(cmd *exec.Cmd, config ai.ProviderConfig, prompt string) (func(), error) {
	if !isLocalCLIAuthMode(config) {
		return func() {}, nil
	}

	workDir, err := os.MkdirTemp("", "gonavi-claude-")
	if err != nil {
		return nil, fmt.Errorf("create isolated Claude CLI workspace failed: %w", err)
	}
	cmd.Dir = workDir
	cmd.Stdin = strings.NewReader(prompt)
	return func() {
		if removeErr := os.RemoveAll(workDir); removeErr != nil {
			logger.Warnf("ClaudeCLI 清理临时目录失败：path=%s err=%v", workDir, removeErr)
		}
	}, nil
}

func claudeCLIArgsForLog(args []string) []string {
	result := append([]string(nil), args...)
	for i := 0; i < len(result)-1; i++ {
		if result[i] == "-p" {
			result[i+1] = "[prompt logged separately]"
			i++
		}
	}
	return result
}

func claudeCLIToolNamesForLog(tools []ai.Tool) []string {
	names := make([]string, 0, len(tools))
	for _, tool := range tools {
		name := strings.TrimSpace(tool.Function.Name)
		if name != "" {
			names = append(names, name)
		}
	}
	return names
}

// setEnv 设置 Claude CLI 的环境变量
func (p *ClaudeCLIProvider) setEnv(cmd *exec.Cmd) error {
	env, err := buildClaudeCLIEnv(p.config, cmd.Environ(), runtime.GOOS, claudeLookPath, fileExists)
	if err != nil {
		return err
	}
	cmd.Env = env
	return nil
}

func buildClaudeCLIEnv(config ai.ProviderConfig, baseEnv []string, goos string, lookPath func(string) (string, error), exists func(string) bool) ([]string, error) {
	env := append([]string(nil), baseEnv...)
	if strings.EqualFold(strings.TrimSpace(config.AuthMode), "local-cli") {
		// 订阅模式必须交给 Claude Code 自身的登录态，避免进程环境中的 API Key 抢占认证。
		env = removeEnvKeys(env, claudeCLILocalAuthBlockedEnvKeys...)
		for _, key := range claudeCLILocalAuthIsolationEnvKeys {
			env = removeEnvKeys(env, key)
			env = upsertEnv(env, key, "1")
		}
	} else {
		if config.BaseURL != "" {
			env = upsertEnv(env, "ANTHROPIC_BASE_URL", strings.TrimRight(config.BaseURL, "/"))
		}
		if config.APIKey != "" {
			env = upsertEnv(env, "ANTHROPIC_AUTH_TOKEN", config.APIKey)
			env = upsertEnv(env, "ANTHROPIC_API_KEY", config.APIKey)
		}
	}

	gitBashPath, err := resolveClaudeCodeGitBashPath(env, goos, lookPath, exists)
	if err != nil {
		return nil, err
	}
	if gitBashPath != "" {
		env = upsertEnv(env, "CLAUDE_CODE_GIT_BASH_PATH", gitBashPath)
	}
	return EnrichCLICommandPATH(env, ""), nil
}

func resolveClaudeCodeGitBashPath(env []string, goos string, lookPath func(string) (string, error), exists func(string) bool) (string, error) {
	if goos != "windows" {
		return "", nil
	}

	if configured := strings.TrimSpace(envValue(env, "CLAUDE_CODE_GIT_BASH_PATH")); configured != "" {
		if exists(configured) {
			if isWindowsWSLBashLauncher(configured) {
				return "", fmt.Errorf("Claude Code CLI requires Git Bash on Windows, but CLAUDE_CODE_GIT_BASH_PATH points to a WSL launcher: %s", configured)
			}
			return configured, nil
		}
		return "", fmt.Errorf("Claude Code CLI requires git-bash on Windows, but CLAUDE_CODE_GIT_BASH_PATH points to a missing bash.exe: %s", configured)
	}

	if detected := detectWindowsGitBashPath(env, lookPath, exists); detected != "" {
		return detected, nil
	}

	return "", fmt.Errorf("Claude Code CLI requires git-bash on Windows. Install Git for Windows (https://git-scm.com/downloads/win); if Git is already installed but not on PATH, set CLAUDE_CODE_GIT_BASH_PATH to bash.exe, for example C:\\Program Files\\Git\\bin\\bash.exe")
}

func detectWindowsGitBashPath(env []string, lookPath func(string) (string, error), exists func(string) bool) string {
	if gitPath, err := lookPath("git.exe"); err == nil {
		gitDir := parentWindowsPath(gitPath)
		for _, candidate := range []string{
			joinWindowsPath(parentWindowsPath(gitDir), "bin", "bash.exe"),
			joinWindowsPath(gitDir, "bash.exe"),
		} {
			if candidate != "" && exists(candidate) {
				return candidate
			}
		}
	}

	for _, candidate := range windowsGitBashCandidates(env) {
		if exists(candidate) {
			return candidate
		}
	}

	for _, command := range []string{"bash.exe", "bash"} {
		if bashPath, err := lookPath(command); err == nil && exists(bashPath) && !isWindowsWSLBashLauncher(bashPath) {
			return bashPath
		}
	}
	return ""
}

func isWindowsWSLBashLauncher(path string) bool {
	normalized := strings.ToLower(strings.Trim(strings.ReplaceAll(strings.TrimSpace(path), "/", `\`), `"`))
	if !strings.HasSuffix(normalized, `\bash.exe`) && !strings.HasSuffix(normalized, `\bash`) {
		return false
	}
	return strings.Contains(normalized, `\windows\system32\`) ||
		strings.Contains(normalized, `\windows\sysnative\`) ||
		strings.Contains(normalized, `\microsoft\windowsapps\`)
}

func windowsGitBashCandidates(env []string) []string {
	candidates := make([]string, 0, 3)
	for _, base := range []string{
		envValue(env, "ProgramFiles"),
		envValue(env, "ProgramFiles(x86)"),
		envValue(env, "LocalAppData"),
	} {
		base = strings.TrimSpace(base)
		if base == "" {
			continue
		}
		if strings.EqualFold(base, envValue(env, "LocalAppData")) {
			candidates = append(candidates, joinWindowsPath(base, "Programs", "Git", "bin", "bash.exe"))
			continue
		}
		candidates = append(candidates, joinWindowsPath(base, "Git", "bin", "bash.exe"))
	}
	return candidates
}

func envValue(env []string, key string) string {
	prefix := key + "="
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			return strings.TrimPrefix(entry, prefix)
		}
	}
	return ""
}

func upsertEnv(env []string, key, value string) []string {
	prefix := key + "="
	for i, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			env[i] = prefix + value
			return env
		}
	}
	return append(env, prefix+value)
}

func removeEnvKeys(env []string, keys ...string) []string {
	filtered := make([]string, 0, len(env))
	for _, entry := range env {
		separator := strings.IndexByte(entry, '=')
		entryKey := entry
		if separator >= 0 {
			entryKey = entry[:separator]
		}
		remove := false
		for _, key := range keys {
			if strings.EqualFold(entryKey, key) {
				remove = true
				break
			}
		}
		if !remove {
			filtered = append(filtered, entry)
		}
	}
	return filtered
}

func fileExists(path string) bool {
	info, err := os.Stat(strings.TrimSpace(path))
	return err == nil && !info.IsDir()
}

func joinWindowsPath(base string, parts ...string) string {
	result := strings.TrimSpace(strings.ReplaceAll(base, "/", `\`))
	if result != "" {
		result = strings.TrimRight(result, `\`)
	}

	for _, part := range parts {
		part = strings.Trim(strings.ReplaceAll(strings.TrimSpace(part), "/", `\`), `\`)
		if part == "" {
			continue
		}
		if result == "" {
			result = part
			continue
		}
		result += `\` + part
	}
	return result
}

func parentWindowsPath(path string) string {
	path = strings.TrimRight(strings.ReplaceAll(strings.TrimSpace(path), "/", `\`), `\`)
	idx := strings.LastIndex(path, `\`)
	if idx <= 0 {
		return ""
	}
	return path[:idx]
}

// buildPrompt 将消息列表拼接为适合 claude -p 的提示文本
func buildPrompt(messages []ai.Message) string {
	if len(messages) == 1 {
		return messages[0].Content
	}

	var sb strings.Builder
	for _, m := range messages {
		switch m.Role {
		case "system":
			sb.WriteString("[System]\n")
			sb.WriteString(m.Content)
			sb.WriteString("\n\n")
		case "user":
			sb.WriteString(m.Content)
			sb.WriteString("\n\n")
		case "assistant":
			sb.WriteString("[Previous Assistant Response]\n")
			sb.WriteString(m.Content)
			sb.WriteString("\n\n")
		}
	}
	return strings.TrimSpace(sb.String())
}

// cliStreamEvent Claude CLI stream-json 输出的事件结构
type cliStreamEvent struct {
	Type         string  `json:"type"`
	Subtype      string  `json:"subtype,omitempty"`
	IsError      bool    `json:"is_error,omitempty"`
	Attempt      int     `json:"attempt,omitempty"`
	MaxRetries   int     `json:"max_retries,omitempty"`
	RetryDelayMS float64 `json:"retry_delay_ms,omitempty"`
	ErrorStatus  int     `json:"error_status,omitempty"`
	SessionID    string  `json:"session_id,omitempty"`
	Message      struct {
		Content []struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			Thinking string `json:"thinking"`
		} `json:"content"`
	} `json:"message,omitempty"`
	Delta struct {
		Type     string `json:"type"`
		Text     string `json:"text"`
		Thinking string `json:"thinking"`
	} `json:"delta,omitempty"`
	Result string              `json:"result,omitempty"`
	Error  cliStreamEventError `json:"error,omitempty"`
}

type cliStreamEventError struct {
	Message string
}

func (e *cliStreamEventError) UnmarshalJSON(data []byte) error {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" || trimmed == "null" {
		e.Message = ""
		return nil
	}

	var text string
	if err := json.Unmarshal(data, &text); err == nil {
		e.Message = strings.TrimSpace(text)
		return nil
	}

	var payload struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return err
	}
	e.Message = strings.TrimSpace(payload.Message)
	return nil
}

func extractClaudeCLIEventError(event cliStreamEvent) (string, bool) {
	if event.Type != "error" && !event.IsError {
		return "", false
	}

	if msg := strings.TrimSpace(event.Result); msg != "" {
		return msg, true
	}

	for _, block := range event.Message.Content {
		if block.Type == "text" && strings.TrimSpace(block.Text) != "" {
			return strings.TrimSpace(block.Text), true
		}
	}

	if msg := strings.TrimSpace(event.Error.Message); msg != "" {
		return msg, true
	}

	return "claude CLI returned an unknown error", true
}

func isClaudeCLISystemRetryEvent(event cliStreamEvent) bool {
	return event.Type == "system" && event.Subtype == "api_retry"
}

func extractClaudeCLISystemRetryError(event cliStreamEvent) (string, bool) {
	if !isClaudeCLISystemRetryEvent(event) {
		return "", false
	}

	errText := strings.TrimSpace(event.Error.Message)
	if event.ErrorStatus != 401 && event.ErrorStatus != 403 && !strings.EqualFold(errText, "authentication_failed") {
		return "", false
	}

	if errText == "" {
		errText = "authentication_failed"
	}

	if event.ErrorStatus > 0 {
		return fmt.Sprintf("claude CLI authentication failed (HTTP %d): %s", event.ErrorStatus, errText), true
	}
	return fmt.Sprintf("claude CLI authentication failed: %s", errText), true
}
