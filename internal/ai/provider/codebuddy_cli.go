package provider

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"runtime"
	"strings"
	"time"

	ai "GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/logger"
)

var codebuddyLookPath = lookupLocalCLICommand
var codebuddyCommandContext = exec.CommandContext
var codebuddyCLIRequestTimeout = 90 * time.Second

// codebuddyCLIStdinPromptThreshold 决定 prompt 走 argv 还是 stdin。
// Windows 上 npm/pnpm 安装的 codebuddy.cmd 包装器会经 cmd.exe 转发参数，
// 单条命令行上限约 8191 字符，超长会被以「命令行太长」拒绝（issue #1469）。
// 超过阈值时 argv 只保留 -p 开关，prompt 改写入 stdin：CodeBuddy CLI 的
// -p 模式本身不带 prompt 值，支持从 stdin 读取输入（官方 CLI 文档的
// cat file | codebuddy -p 管道示例）。阈值取 6000，为 cmd.exe 前缀、
// 其余 flag 与参数转义留足余量。
const codebuddyCLIStdinPromptThreshold = 6000

// buildCodeBuddyCLIArgs 组装 CodeBuddy CLI 参数；streamOutput 为 true 时
// 使用 stream-json 输出格式，否则使用单次 json 输出。
func buildCodeBuddyCLIArgs(streamOutput bool, prompt string, model string, resumeSessionID string) []string {
	args := []string{"-p"}
	if len(prompt) < codebuddyCLIStdinPromptThreshold {
		args = append(args, prompt)
	}
	if streamOutput {
		args = append(args, "--output-format", "stream-json", "--verbose", "--include-partial-messages")
	} else {
		args = append(args, "--output-format", "json")
	}
	if strings.TrimSpace(model) != "" {
		args = append(args, "--model", strings.TrimSpace(model))
	}
	if strings.TrimSpace(resumeSessionID) != "" {
		args = append(args, "--resume", strings.TrimSpace(resumeSessionID))
	}
	return args
}

// codebuddyCLIStdinPrompt 在 prompt 超过 argv 阈值时返回 stdin 内容，
// 否则返回 nil：短 prompt 走 argv，且不继承父进程 stdin，避免 CLI 挂起等待输入。
func codebuddyCLIStdinPrompt(prompt string) io.Reader {
	if len(prompt) < codebuddyCLIStdinPromptThreshold {
		return nil
	}
	return strings.NewReader(prompt)
}

// CodeBuddyCLIProvider 通过 CodeBuddy CLI 发送聊天请求。
type CodeBuddyCLIProvider struct {
	config ai.ProviderConfig
}

type codebuddySessionState struct {
	SessionID string `json:"sessionId,omitempty"`
}

// NewCodeBuddyCLIProvider 创建 CodeBuddyCLIProvider 实例。
func NewCodeBuddyCLIProvider(config ai.ProviderConfig) (Provider, error) {
	return &CodeBuddyCLIProvider{config: config}, nil
}

func (p *CodeBuddyCLIProvider) Name() string {
	return "CodeBuddyCLI"
}

func (p *CodeBuddyCLIProvider) Validate() error {
	_, err := resolveCodeBuddyCLICommand(lookPathWithOverride(p.config.CLIPath, codebuddyLookPath))
	if err != nil {
		return err
	}
	capability, _ := LookupCLICapability("codebuddy-cli")
	_, err = capability.NormalizeEffort(p.config.Effort)
	return err
}

func (p *CodeBuddyCLIProvider) Chat(ctx context.Context, req ai.ChatRequest) (*ai.ChatResponse, error) {
	resp, _, err := p.ChatWithState(ctx, nil, req)
	return resp, err
}

func (p *CodeBuddyCLIProvider) ChatWithState(ctx context.Context, state json.RawMessage, req ai.ChatRequest) (*ai.ChatResponse, json.RawMessage, error) {
	if err := p.Validate(); err != nil {
		return nil, nil, err
	}

	ctx, cancel := ensureClaudeCLITimeout(ctx, codebuddyCLIRequestTimeout)
	defer cancel()

	commandName, err := resolveCodeBuddyCLICommand(lookPathWithOverride(p.config.CLIPath, codebuddyLookPath))
	if err != nil {
		return nil, nil, err
	}

	sessionState, err := parseCodeBuddySessionState(state)
	if err != nil {
		return nil, nil, err
	}
	prompt := buildPrompt(req.Messages)
	args := buildCodeBuddyCLIArgs(false, prompt, p.config.Model, sessionState.SessionID)
	stdinPrompt := codebuddyCLIStdinPrompt(prompt)

	cmd := newLocalCLICommand(codebuddyCommandContext, ctx, commandName, args...)
	if err := p.setEnv(cmd); err != nil {
		return nil, nil, err
	}
	if stdinPrompt != nil {
		cmd.Stdin = stdinPrompt
	}
	// 独立捕获 stderr：CodeBuddy CLI 认证失败时只往 stderr 写错误，stdout 为空、
	// 退出码仍是 0，这种情况下 Output() 不会把 stderr 带出来。
	var stderrBuf bytes.Buffer
	cmd.Stderr = &stderrBuf

	requestLog := logAIUpstreamRequestStart(
		p.Name(),
		"CLI",
		codebuddyCLIEndpointForLog(p.config),
		buildCodeBuddyCLIRequestLogBody("json", commandName, args, prompt, p.config, req, stdinPrompt != nil),
	)
	var requestErr error
	defer func() {
		logAIUpstreamRequestFinish(requestLog, 0, requestErr)
	}()

	output, err := cmd.Output()
	if err != nil {
		if isClaudeCLITimeout(ctx, err) {
			requestErr = fmt.Errorf("CodeBuddy CLI timed out (%s); the current login session, Base URL, or API Key may not be returning a valid response", codebuddyCLIRequestTimeout)
			return nil, nil, requestErr
		}
		_, exited := err.(*exec.ExitError)
		if !exited && len(output) == 0 {
			requestErr = fmt.Errorf("CodeBuddy CLI execution failed: %w", err)
			return nil, nil, requestErr
		}
		details := make([]string, 0, 3)
		if stderr := codebuddyCLIStderrDetail(&stderrBuf); stderr != "" {
			details = append(details, "stderr: "+stderr)
		}
		if len(output) > 0 {
			details = append(details, fmt.Sprintf("stdout: %d bytes omitted", len(output)))
		}
		details = append(details, "error: "+err.Error())
		requestErr = fmt.Errorf("CodeBuddy CLI execution failed: %s", strings.Join(details, "; "))
		return nil, nil, requestErr
	}
	// 退出码 0 但没有 stdout：CLI 把失败原因写在了 stderr（实测未登录时返回
	// 「401 Authentication required」而退出码为 0）。不在这里读 stderr，上层只会
	// 拿到空响应并报「CLI 没有返回模型响应」，把「需要登录」误导成模型问题。
	if len(bytes.TrimSpace(output)) == 0 {
		if detail := codebuddyCLIStderrDetail(&stderrBuf); detail != "" {
			// 未登录/凭证被拒是可预期状态：返回哨兵错误交给 service 层本地化，
			// 不把 CLI 原文（含 trace id、target 等诊断信息）直接抛给界面。
			if isCodeBuddyCLIAuthFailure(detail) {
				requestErr = ErrCodeBuddyCLIAuthRequired
				return nil, nil, requestErr
			}
			requestErr = fmt.Errorf("CodeBuddy CLI returned no output (exit code 0); stderr: %s", detail)
			return nil, nil, requestErr
		}
	}

	resp, nextSessionID, parseErr := parseCodeBuddyCLIChatOutput(output)
	if parseErr != nil {
		requestErr = parseErr
		return nil, nil, requestErr
	}
	if strings.TrimSpace(nextSessionID) == "" {
		nextSessionID = strings.TrimSpace(sessionState.SessionID)
	}
	nextState, err := marshalCodeBuddySessionState(nextSessionID)
	if err != nil {
		return nil, nil, err
	}
	return resp, nextState, nil
}

func (p *CodeBuddyCLIProvider) ChatStream(ctx context.Context, req ai.ChatRequest, callback func(ai.StreamChunk)) error {
	_, err := p.ChatStreamWithState(ctx, nil, req, callback)
	return err
}

func (p *CodeBuddyCLIProvider) ChatStreamWithState(ctx context.Context, state json.RawMessage, req ai.ChatRequest, callback func(ai.StreamChunk)) (json.RawMessage, error) {
	sessionState, err := parseCodeBuddySessionState(state)
	if err != nil {
		return nil, err
	}

	sessionID, err := p.chatStreamWithSession(ctx, strings.TrimSpace(sessionState.SessionID), req, callback)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(sessionID) == "" {
		sessionID = strings.TrimSpace(sessionState.SessionID)
	}
	return marshalCodeBuddySessionState(sessionID)
}

func (p *CodeBuddyCLIProvider) chatStreamWithSession(ctx context.Context, resumeSessionID string, req ai.ChatRequest, callback func(ai.StreamChunk)) (string, error) {
	if err := p.Validate(); err != nil {
		return "", err
	}

	ctx, cancel := ensureClaudeCLITimeout(ctx, codebuddyCLIRequestTimeout)
	defer cancel()

	commandName, err := resolveCodeBuddyCLICommand(lookPathWithOverride(p.config.CLIPath, codebuddyLookPath))
	if err != nil {
		return "", err
	}

	prompt := buildPrompt(req.Messages)
	args := buildCodeBuddyCLIArgs(true, prompt, p.config.Model, resumeSessionID)

	cmd := newLocalCLICommand(codebuddyCommandContext, ctx, commandName, args...)
	if err := p.setEnv(cmd); err != nil {
		return "", err
	}

	requestLog := logAIUpstreamRequestStart(
		p.Name(),
		"CLI",
		codebuddyCLIEndpointForLog(p.config),
		buildCodeBuddyCLIRequestLogBody("stream-json", commandName, args, prompt, p.config, req, len(prompt) >= codebuddyCLIStdinPromptThreshold),
	)
	var requestErr error
	defer func() {
		logAIUpstreamRequestFinish(requestLog, 0, requestErr)
	}()

	cmd.Stdin = codebuddyCLIStdinPrompt(prompt)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		requestErr = fmt.Errorf("create stdout pipe failed: %w", err)
		return "", requestErr
	}

	var stderrBuf bytes.Buffer
	cmd.Stderr = &stderrBuf

	if err := cmd.Start(); err != nil {
		requestErr = fmt.Errorf("start CodeBuddy CLI failed: %w", err)
		return "", requestErr
	}

	if cmd.Process != nil {
		logger.Infof("CodeBuddyCLI 请求进程已启动：requestId=%s pid=%d", requestLog.id, cmd.Process.Pid)
	}

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	currentSessionID := strings.TrimSpace(resumeSessionID)

	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}

		var event cliStreamEvent
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			logger.Warnf("CodeBuddyCLI 忽略非 JSON 输出：requestId=%s line=%s", requestLog.id, RedactAIUpstreamLogText(line))
			continue
		}
		if strings.TrimSpace(event.SessionID) != "" {
			currentSessionID = strings.TrimSpace(event.SessionID)
		}

		switch event.Type {
		case "system":
			if isCodeBuddyCLISystemRetryEvent(event) {
				if errMsg, hasError := extractCodeBuddyCLISystemRetryError(event); hasError {
					callback(ai.StreamChunk{Error: errMsg, Done: true})
					requestErr = fmt.Errorf("CodeBuddy CLI authentication failed: %s", errMsg)
					if cmd.Process != nil {
						_ = cmd.Process.Kill()
					}
					_ = cmd.Wait()
					return "", nil
				}
			}
		case "assistant":
			if errMsg, hasError := extractCodeBuddyCLIEventError(event); hasError {
				callback(ai.StreamChunk{Error: errMsg, Done: true})
				requestErr = fmt.Errorf("CodeBuddy CLI returned an error: %s", errMsg)
				_ = cmd.Wait()
				return "", nil
			}
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
			if event.Delta.Type == "thinking_delta" && event.Delta.Thinking != "" {
				callback(ai.StreamChunk{Thinking: event.Delta.Thinking})
			} else if event.Delta.Text != "" {
				callback(ai.StreamChunk{Content: event.Delta.Text})
			}
		case "result":
			if errMsg, hasError := extractCodeBuddyCLIEventError(event); hasError {
				callback(ai.StreamChunk{Error: errMsg, Done: true})
				requestErr = fmt.Errorf("CodeBuddy CLI returned an error: %s", errMsg)
				_ = cmd.Wait()
				return "", nil
			}
			var usage *ai.TokenUsage
			if event.Usage != nil {
				normalized := normalizeClaudeCLIUsage(event.Usage)
				usage = &normalized
			}
			callback(ai.StreamChunk{Done: true, Usage: usage})
			_ = cmd.Wait()
			return currentSessionID, nil
		case "error":
			errMsg, _ := extractCodeBuddyCLIEventError(event)
			callback(ai.StreamChunk{Error: errMsg, Done: true})
			requestErr = fmt.Errorf("CodeBuddy CLI returned an error: %s", errMsg)
			_ = cmd.Wait()
			return "", nil
		}
	}

	waitErr := cmd.Wait()
	stderrStr := strings.TrimSpace(stderrBuf.String())

	if isClaudeCLITimeout(ctx, waitErr) {
		requestErr = fmt.Errorf("CodeBuddy CLI timed out (%s); the current login session, Base URL, or API Key may not be returning a valid response", codebuddyCLIRequestTimeout)
		callback(ai.StreamChunk{
			Error: requestErr.Error(),
			Done:  true,
		})
		return "", nil
	}

	if waitErr != nil {
		errMsg := fmt.Sprintf("CodeBuddy CLI exited unexpectedly: %v", waitErr)
		if stderrStr != "" {
			errMsg = fmt.Sprintf("CodeBuddy CLI exited unexpectedly: %s", stderrStr)
		}
		requestErr = fmt.Errorf("%s", errMsg)
		callback(ai.StreamChunk{Error: errMsg, Done: true})
		return "", nil
	}

	callback(ai.StreamChunk{Done: true})
	return currentSessionID, nil
}

func parseCodeBuddySessionState(state json.RawMessage) (codebuddySessionState, error) {
	trimmed := bytes.TrimSpace(state)
	if len(trimmed) == 0 {
		return codebuddySessionState{}, nil
	}

	var sessionState codebuddySessionState
	if err := json.Unmarshal(trimmed, &sessionState); err != nil {
		return codebuddySessionState{}, fmt.Errorf("parse CodeBuddy session state failed: %w", err)
	}
	sessionState.SessionID = strings.TrimSpace(sessionState.SessionID)
	return sessionState, nil
}

func marshalCodeBuddySessionState(sessionID string) (json.RawMessage, error) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil, nil
	}

	payload, err := json.Marshal(codebuddySessionState{SessionID: sessionID})
	if err != nil {
		return nil, fmt.Errorf("serialize CodeBuddy session state failed: %w", err)
	}
	return json.RawMessage(payload), nil
}

func resolveCodeBuddyCLICommand(lookPath func(string) (string, error)) (string, error) {
	for _, command := range []string{"codebuddy", "cbc"} {
		if resolved, err := lookPath(command); err == nil {
			return resolved, nil
		}
	}
	return "", fmt.Errorf("CodeBuddy CLI command not found. Install it first: npm install -g @tencent-ai/codebuddy-code")
}

func codebuddyCLIEndpointForLog(config ai.ProviderConfig) string {
	baseURL := strings.TrimRight(strings.TrimSpace(config.BaseURL), "/")
	if baseURL != "" {
		return sanitizeAIUpstreamURL(baseURL)
	}
	return "codebuddy://cli"
}

func buildCodeBuddyCLIRequestLogBody(outputFormat string, commandName string, args []string, prompt string, config ai.ProviderConfig, req ai.ChatRequest, promptViaStdin bool) map[string]any {
	// stdin 模式下 -p 后面紧跟 --output-format，claudeCLIArgsForLog 的
	// 「-p 下一参数即 prompt」假设会误伤后续 flag，此时按原样记录 args。
	loggedArgs := claudeCLIArgsForLog(args)
	if promptViaStdin {
		loggedArgs = append([]string(nil), args...)
	}
	promptVia := "argv"
	if promptViaStdin {
		promptVia = "stdin"
	}
	return map[string]any{
		"command":       commandName,
		"args":          loggedArgs,
		"prompt":        prompt,
		"prompt_via":    promptVia,
		"output_format": outputFormat,
		"model":         strings.TrimSpace(config.Model),
		"base_url":      codebuddyCLIEndpointForLog(config),
		"has_api_key":   strings.TrimSpace(config.APIKey) != "",
		"message_count": len(req.Messages),
		"tool_count":    len(req.Tools),
		"tool_names":    claudeCLIToolNamesForLog(req.Tools),
	}
}

func parseCodeBuddyCLIChatOutput(output []byte) (*ai.ChatResponse, string, error) {
	trimmed := bytes.TrimSpace(output)
	if len(trimmed) == 0 {
		return &ai.ChatResponse{}, "", nil
	}

	var events []cliStreamEvent
	if err := json.Unmarshal(trimmed, &events); err == nil && len(events) > 0 {
		return buildCodeBuddyCLIResponseFromEvents(events)
	}

	var event cliStreamEvent
	if err := json.Unmarshal(trimmed, &event); err == nil {
		return buildCodeBuddyCLIResponseFromEvents([]cliStreamEvent{event})
	}

	return &ai.ChatResponse{Content: strings.TrimSpace(string(output))}, "", nil
}

func buildCodeBuddyCLIResponseFromEvents(events []cliStreamEvent) (*ai.ChatResponse, string, error) {
	parts := make([]string, 0, len(events))
	resultText := ""
	sessionID := ""
	var tokenUsage ai.TokenUsage

	for _, event := range events {
		if errMsg, hasError := extractCodeBuddyCLIEventError(event); hasError {
			return nil, "", fmt.Errorf("CodeBuddy CLI returned an error: %s", errMsg)
		}
		if strings.TrimSpace(event.Result) != "" {
			resultText = strings.TrimSpace(event.Result)
		}
		if strings.TrimSpace(event.SessionID) != "" {
			sessionID = strings.TrimSpace(event.SessionID)
		}
		if event.Usage != nil {
			tokenUsage = normalizeClaudeCLIUsage(event.Usage)
		}
		for _, block := range event.Message.Content {
			if block.Type == "text" && strings.TrimSpace(block.Text) != "" {
				parts = append(parts, block.Text)
			}
		}
	}

	if resultText != "" {
		return &ai.ChatResponse{Content: resultText, TokensUsed: tokenUsage}, sessionID, nil
	}
	if len(parts) > 0 {
		return &ai.ChatResponse{Content: strings.Join(parts, ""), TokensUsed: tokenUsage}, sessionID, nil
	}
	return &ai.ChatResponse{}, sessionID, nil
}

func (p *CodeBuddyCLIProvider) setEnv(cmd *exec.Cmd) error {
	env, err := buildCodeBuddyCLIEnv(p.config, cmd.Environ(), runtime.GOOS, codebuddyLookPath, fileExists)
	if err != nil {
		return err
	}
	cmd.Env = MergeProviderCLIEnv(EnrichCLICommandPATH(env, cmd.Path), p.config.CLIEnv)
	return nil
}

func buildCodeBuddyCLIEnv(config ai.ProviderConfig, baseEnv []string, goos string, lookPath func(string) (string, error), exists func(string) bool) ([]string, error) {
	env := append([]string(nil), baseEnv...)
	if strings.TrimSpace(config.BaseURL) != "" {
		env = upsertEnv(env, "CODEBUDDY_BASE_URL", strings.TrimRight(strings.TrimSpace(config.BaseURL), "/"))
	}
	if strings.TrimSpace(config.APIKey) != "" {
		env = upsertEnv(env, "CODEBUDDY_API_KEY", strings.TrimSpace(config.APIKey))
		env = upsertEnv(env, "CODEBUDDY_AUTH_TOKEN", strings.TrimSpace(config.APIKey))
	}
	if len(config.Headers) > 0 {
		if payload, err := json.Marshal(config.Headers); err == nil {
			env = upsertEnv(env, "CODEBUDDY_CUSTOM_HEADERS", string(payload))
		}
	}

	gitBashPath, err := resolveCodeBuddyGitBashPath(env, goos, lookPath, exists)
	if err != nil {
		return nil, err
	}
	if gitBashPath != "" {
		env = upsertEnv(env, "CODEBUDDY_CODE_GIT_BASH_PATH", gitBashPath)
	}
	return env, nil
}

func resolveCodeBuddyGitBashPath(env []string, goos string, lookPath func(string) (string, error), exists func(string) bool) (string, error) {
	if goos != "windows" {
		return "", nil
	}

	if configured := strings.TrimSpace(envValue(env, "CODEBUDDY_CODE_GIT_BASH_PATH")); configured != "" {
		if exists(configured) {
			if isWindowsWSLBashLauncher(configured) {
				return "", fmt.Errorf("Configured CODEBUDDY_CODE_GIT_BASH_PATH points to a WSL launcher instead of Git Bash on Windows: %s", configured)
			}
			return configured, nil
		}
		return "", fmt.Errorf("Configured CODEBUDDY_CODE_GIT_BASH_PATH does not exist on Windows: %s", configured)
	}

	if detected := detectWindowsGitBashPath(env, lookPath, exists); detected != "" {
		return detected, nil
	}

	return "", nil
}

func extractCodeBuddyCLIEventError(event cliStreamEvent) (string, bool) {
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

	return "CodeBuddy CLI returned an unknown error", true
}

func isCodeBuddyCLISystemRetryEvent(event cliStreamEvent) bool {
	return event.Type == "system" && event.Subtype == "api_retry"
}

func extractCodeBuddyCLISystemRetryError(event cliStreamEvent) (string, bool) {
	if !isCodeBuddyCLISystemRetryEvent(event) {
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
		return fmt.Sprintf("CodeBuddy CLI authentication failed (HTTP %d): %s", event.ErrorStatus, errText), true
	}
	return fmt.Sprintf("CodeBuddy CLI authentication failed: %s", errText), true
}

// ErrCodeBuddyCLIAuthRequired 表示 CodeBuddy CLI 未登录或凭证被拒。
//
// CLI 把 401 写在 stderr、退出码却是 0，原文里带 trace id 与 target 等诊断信息，
// 不适合直接展示。这里只暴露「需要登录」这一事实，由 service 层渲染成本地化文案。
var ErrCodeBuddyCLIAuthRequired = errors.New("codebuddy cli authentication required")

// codebuddyCLIAuthFailureMarkers 覆盖 CLI 未登录时的各种表述。
var codebuddyCLIAuthFailureMarkers = []string{
	"authentication required",
	"authentication_failed",
	"not logged in",
	"not authenticated",
	"please log in",
	"please login",
	"unauthorized",
	"invalid api key",
	"http 401",
}

// isCodeBuddyCLIAuthFailure 识别 CLI 输出的未认证信号。
func isCodeBuddyCLIAuthFailure(text string) bool {
	lower := strings.ToLower(text)
	for _, marker := range codebuddyCLIAuthFailureMarkers {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

// codebuddyCLIStderrMaxRunes 限制错误信息里回显的 stderr 长度：CLI 失败时可能
// 打印整段诊断（含 trace id），原样拼进提示会撑爆界面。
const codebuddyCLIStderrMaxRunes = 600

// codebuddyCLIStderrDetail 把捕获到的 stderr 收敛成一段可放进错误的摘要。
func codebuddyCLIStderrDetail(buf *bytes.Buffer) string {
	if buf == nil {
		return ""
	}
	text := strings.TrimSpace(buf.String())
	if text == "" {
		return ""
	}
	runes := []rune(text)
	if len(runes) <= codebuddyCLIStderrMaxRunes {
		return text
	}
	return string(runes[:codebuddyCLIStderrMaxRunes]) + "…"
}
