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

	ai "GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/logger"
)

var codexLookPath = lookupLocalCLICommand
var codexCommandContext = exec.CommandContext
var codexEvalSymlinks = filepath.EvalSymlinks
var codexCLIChatGPTAuthCheck = CheckCodexCLIAuth

const codexCLIMaxJSONLineBytes = 8 * 1024 * 1024
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

// CodexCLIProvider 通过官方 Codex CLI 复用本机 ChatGPT 订阅登录态。
// CLI 在隔离临时目录、只读 sandbox 且禁用 shell/web 的条件下运行。
type CodexCLIProvider struct {
	config ai.ProviderConfig
}

func NewCodexCLIProvider(config ai.ProviderConfig) (Provider, error) {
	if !strings.EqualFold(strings.TrimSpace(config.AuthMode), "local-cli") {
		return nil, fmt.Errorf("Codex CLI provider requires local-cli subscription authentication")
	}
	return &CodexCLIProvider{config: config}, nil
}

func (p *CodexCLIProvider) Name() string {
	return "CodexCLI"
}

func (p *CodexCLIProvider) Validate() error {
	_, err := resolveCodexCLICommand(runtime.GOOS, runtime.GOARCH, codexLookPath, fileExists)
	return err
}

// CheckCodexCLIAuth verifies that the official CLI is installed and has a
// usable local login. It deliberately does not send a model request.
func CheckCodexCLIAuth(ctx context.Context) error {
	command, err := resolveCodexCLICommand(runtime.GOOS, runtime.GOARCH, codexLookPath, fileExists)
	if err != nil {
		return err
	}

	args := append(append([]string(nil), command.PrefixArgs...),
		"login", "status", "-c", codexCLILoginConfigOverride,
	)
	cmd := codexCommandContext(ctx, command.Path, args...)
	cmd.Env = buildCodexCLIEnv(cmd.Environ(), command.Path)
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
	if !isCodexCLIChatGPTLoginStatus(detail) {
		if detail == "" {
			detail = "unknown login type"
		}
		return fmt.Errorf(
			"Codex CLI is not logged in with a ChatGPT subscription (status: %s); run codex logout, then codex login and choose ChatGPT",
			RedactAIUpstreamLogText(detail),
		)
	}
	return nil
}

func isCodexCLIChatGPTLoginStatus(status string) bool {
	normalized := strings.ToLower(strings.TrimSpace(status))
	return strings.Contains(normalized, "logged in using chatgpt")
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
	if err := codexCLIChatGPTAuthCheck(ctx); err != nil {
		return codexCLIResult{}, err
	}

	command, err := resolveCodexCLICommand(runtime.GOOS, runtime.GOARCH, codexLookPath, fileExists)
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
	args := append(append([]string(nil), command.PrefixArgs...), buildCodexCLIArgs(p.config)...)
	cmd := codexCommandContext(ctx, command.Path, args...)
	cmd.Dir = workDir
	cmd.Stdin = strings.NewReader(prompt)
	cmd.Env = buildCodexCLIEnv(cmd.Environ(), command.Path)

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
		onChunk(ai.StreamChunk{Done: true})
	}
	return result, nil
}

func buildCodexCLIArgs(config ai.ProviderConfig) []string {
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
		"--color", "never",
		"--json",
	}
	for _, feature := range codexCLIDisabledFeatures {
		args = append(args, "--disable", feature)
	}
	if model := strings.TrimSpace(config.Model); model != "" {
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

func buildCodexCLIEnv(baseEnv []string, commandPath string) []string {
	return EnrichCLICommandPATH(removeEnvKeys(baseEnv, "CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"), commandPath)
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
		result.Usage = ai.TokenUsage{
			PromptTokens: event.Usage.InputTokens,
			// Codex reports reasoning_output_tokens as a breakdown of output_tokens,
			// not an additional token bucket.
			CompletionTokens: event.Usage.OutputTokens,
			TotalTokens:      event.Usage.InputTokens + event.Usage.OutputTokens,
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
		"args":          append([]string(nil), args...),
		"prompt":        prompt,
		"model":         strings.TrimSpace(config.Model),
		"auth_mode":     strings.TrimSpace(config.AuthMode),
		"message_count": len(req.Messages),
		"tool_count":    len(req.Tools),
		"tool_names":    claudeCLIToolNamesForLog(req.Tools),
	}
}
