package provider

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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
	_, err := resolveCodeBuddyCLICommand(codebuddyLookPath)
	if err != nil {
		return err
	}
	return nil
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

	commandName, err := resolveCodeBuddyCLICommand(codebuddyLookPath)
	if err != nil {
		return nil, nil, err
	}

	sessionState, err := parseCodeBuddySessionState(state)
	if err != nil {
		return nil, nil, err
	}
	prompt := buildPrompt(req.Messages)
	args := []string{"-p", prompt, "--output-format", "json"}
	if strings.TrimSpace(p.config.Model) != "" {
		args = append(args, "--model", strings.TrimSpace(p.config.Model))
	}
	if strings.TrimSpace(sessionState.SessionID) != "" {
		args = append(args, "--resume", strings.TrimSpace(sessionState.SessionID))
	}

	cmd := codebuddyCommandContext(ctx, commandName, args...)
	if err := p.setEnv(cmd); err != nil {
		return nil, nil, err
	}

	requestLog := logAIUpstreamRequestStart(
		p.Name(),
		"CLI",
		codebuddyCLIEndpointForLog(p.config),
		buildCodeBuddyCLIRequestLogBody("json", commandName, args, prompt, p.config, req),
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
		exitErr, exited := err.(*exec.ExitError)
		if !exited && len(output) == 0 {
			requestErr = fmt.Errorf("CodeBuddy CLI execution failed: %w", err)
			return nil, nil, requestErr
		}
		details := make([]string, 0, 3)
		if exited {
			if stderr := strings.TrimSpace(string(exitErr.Stderr)); stderr != "" {
				details = append(details, "stderr: "+stderr)
			}
		}
		if len(output) > 0 {
			details = append(details, fmt.Sprintf("stdout: %d bytes omitted", len(output)))
		}
		details = append(details, "error: "+err.Error())
		requestErr = fmt.Errorf("CodeBuddy CLI execution failed: %s", strings.Join(details, "; "))
		return nil, nil, requestErr
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

	commandName, err := resolveCodeBuddyCLICommand(codebuddyLookPath)
	if err != nil {
		return "", err
	}

	prompt := buildPrompt(req.Messages)
	args := []string{"-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages"}
	if strings.TrimSpace(p.config.Model) != "" {
		args = append(args, "--model", strings.TrimSpace(p.config.Model))
	}
	if strings.TrimSpace(resumeSessionID) != "" {
		args = append(args, "--resume", strings.TrimSpace(resumeSessionID))
	}

	cmd := codebuddyCommandContext(ctx, commandName, args...)
	if err := p.setEnv(cmd); err != nil {
		return "", err
	}

	requestLog := logAIUpstreamRequestStart(
		p.Name(),
		"CLI",
		codebuddyCLIEndpointForLog(p.config),
		buildCodeBuddyCLIRequestLogBody("stream-json", commandName, args, prompt, p.config, req),
	)
	var requestErr error
	defer func() {
		logAIUpstreamRequestFinish(requestLog, 0, requestErr)
	}()

	cmd.Stdin = nil

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
			callback(ai.StreamChunk{Done: true})
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

func buildCodeBuddyCLIRequestLogBody(outputFormat string, commandName string, args []string, prompt string, config ai.ProviderConfig, req ai.ChatRequest) map[string]any {
	return map[string]any{
		"command":       commandName,
		"args":          claudeCLIArgsForLog(args),
		"prompt":        prompt,
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
		for _, block := range event.Message.Content {
			if block.Type == "text" && strings.TrimSpace(block.Text) != "" {
				parts = append(parts, block.Text)
			}
		}
	}

	if resultText != "" {
		return &ai.ChatResponse{Content: resultText}, sessionID, nil
	}
	if len(parts) > 0 {
		return &ai.ChatResponse{Content: strings.Join(parts, "")}, sessionID, nil
	}
	return &ai.ChatResponse{}, sessionID, nil
}

func (p *CodeBuddyCLIProvider) setEnv(cmd *exec.Cmd) error {
	env, err := buildCodeBuddyCLIEnv(p.config, cmd.Environ(), runtime.GOOS, codebuddyLookPath, fileExists)
	if err != nil {
		return err
	}
	cmd.Env = EnrichCLICommandPATH(env, cmd.Path)
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
