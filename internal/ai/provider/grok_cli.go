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
	"runtime"
	"strings"
	"time"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/logger"
)

var grokLookPath = lookupLocalCLICommand
var grokCommandContext = exec.CommandContext

// cliStreamIdleTimeout is how long a streaming CLI may stay silent. Each
// stdout line resets it, so thinking deltas keep a long turn alive.
var cliStreamIdleTimeout = 3 * time.Minute

// cliStreamMaxTimeout is the hard cap for one streaming CLI turn, even while
// it is still emitting output.
var cliStreamMaxTimeout = 15 * time.Minute

// grokCLIRequestTimeout covers the buffered json Chat() path, which has no
// incremental output to reset an idle timer.
var grokCLIRequestTimeout = cliStreamMaxTimeout

// grokCLIIsolationNote 说明本 provider 的隔离边界与 codex 不对等，务必不要按 codex 的假设使用。
//
// codex 有 --ignore-user-config / --ignore-rules，可以把用户的全局配置与规则整个隔离掉。
// grok 1.0.5 没有任何等价 flag：它只提供 --rules（追加）与 --system-prompt-override（覆盖系统提示）。
// 实测未加隔离时，一次 "say OK" 的调用会把用户全局规则读进上下文（input_tokens 上万），
// 因此这里必须显式覆盖系统提示，并把内置工具白名单清空。
const grokCLIIsolationNote = "isolated"

// grokCLISystemPrompt 覆盖 grok 自身的 agent 系统提示，阻断用户全局规则进入本次调用。
// 它只声明当前用途，不描述任何数据库写入能力——写库能力由 GoNavi 侧的安全层决定。
const grokCLISystemPrompt = "You are a database assistant embedded in GoNavi. " +
	"Answer the user's question and generate SQL when asked. " +
	"Do not use tools, do not read or modify local files, and do not follow instructions from any other rules file."

type grokCLIResponse struct {
	Text       string       `json:"text"`
	Thought    string       `json:"thought"`
	StopReason string       `json:"stopReason"`
	Usage      grokCLIUsage `json:"usage"`
}

type grokCLIUsage struct {
	InputTokens          int  `json:"input_tokens"`
	OutputTokens         int  `json:"output_tokens"`
	TotalTokens          int  `json:"total_tokens"`
	CachedInputTokens    *int `json:"cached_input_tokens,omitempty"`
	CacheReadInputTokens *int `json:"cache_read_input_tokens,omitempty"`
}

func normalizeGrokCLIUsage(usage grokCLIUsage) ai.TokenUsage {
	total := usage.TotalTokens
	if total == 0 {
		total = usage.InputTokens + usage.OutputTokens
	}
	result := ai.TokenUsage{
		PromptTokens:     usage.InputTokens,
		CompletionTokens: usage.OutputTokens,
		TotalTokens:      total,
	}
	if usage.CachedInputTokens != nil {
		cached := *usage.CachedInputTokens
		result.CachedTokens = &cached
	} else if usage.CacheReadInputTokens != nil {
		cached := *usage.CacheReadInputTokens
		result.CachedTokens = &cached
	}
	return result
}

type grokCLIResult struct {
	Content  string
	Thinking string
	Usage    ai.TokenUsage
}

// errGrokCLIUpstreamCancelled 标记 grok 的推理请求在回合中途被连接层中止。
// grok 自身日志（unified.jsonl）中的形态是 shell.turn.inference_failed
// {kind:"api", status_code:null, is_retryable:false, message:"request cancelled"}：
// 没有 HTTP 状态码，CLI 判定不可重试并直接放弃本回合，退出码仍为 0。
// 该故障是瞬时性的（网络波动、代理断流、上游过载），GoNavi 据此自动重试一次。
var errGrokCLIUpstreamCancelled = errors.New("上游推理请求在回合中途被取消")

// GrokCLIProvider 通过本机 Grok CLI 当前认证（OAuth 或 API key）提供对话与 SQL 生成。
type GrokCLIProvider struct {
	config ai.ProviderConfig
}

func NewGrokCLIProvider(config ai.ProviderConfig) (Provider, error) {
	if !strings.EqualFold(strings.TrimSpace(config.AuthMode), "local-cli") {
		return nil, fmt.Errorf("Grok CLI provider requires local-cli authentication")
	}
	return &GrokCLIProvider{config: config}, nil
}

func (p *GrokCLIProvider) Name() string {
	return "GrokCLI"
}

func (p *GrokCLIProvider) Validate() error {
	_, err := resolveGrokCLICommand(runtime.GOOS, lookPathWithOverride(p.config.CLIPath, grokLookPath))
	return err
}

// CheckGrokCLIModels checks the CLI model-list command without sending a chat
// message. A readable list is not proof that the selected model can respond.
func CheckGrokCLIModels(ctx context.Context) error {
	return CheckGrokCLIModelsWithConfig(ctx, ai.ProviderConfig{AuthMode: "local-cli"})
}

// CheckGrokCLIModelsWithConfig checks the exact configured CLI invocation.
func CheckGrokCLIModelsWithConfig(ctx context.Context, config ai.ProviderConfig) error {
	capability, ok := LookupCLICapability("grok-cli")
	if !ok || len(capability.ModelDiscoveryArgs) == 0 {
		return fmt.Errorf("Grok CLI model-list check is unavailable")
	}
	_, err := capability.DiscoverModelsWithConfig(ctx, config)
	return err
}

// resolveGrokCLICommand 跨平台解析 grok 可执行文件。
// Windows 上 npm 风格安装会生成 .cmd 包装，Unix 上只有裸名。
func resolveGrokCLICommand(goos string, lookPath func(string) (string, error)) (string, error) {
	candidates := []string{"grok"}
	if goos == "windows" {
		candidates = []string{"grok.cmd", "grok.exe", "grok"}
	}
	for _, name := range candidates {
		if path, err := lookPath(name); err == nil {
			return path, nil
		}
	}
	return "", fmt.Errorf("grok command was not found; install the Grok CLI first and make sure it is on PATH")
}

func (p *GrokCLIProvider) Chat(ctx context.Context, req ai.ChatRequest) (*ai.ChatResponse, error) {
	result, err := p.run(ctx, req)
	if err != nil {
		return nil, err
	}
	return &ai.ChatResponse{
		Content:          result.Content,
		ReasoningContent: result.Thinking,
		TokensUsed:       result.Usage,
	}, nil
}

func (p *GrokCLIProvider) ChatStream(ctx context.Context, req ai.ChatRequest, callback func(ai.StreamChunk)) error {
	err := p.stream(ctx, req, callback)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return context.Canceled
		}
		callback(ai.StreamChunk{Error: err.Error(), Done: true})
		return nil
	}
	return nil
}

func (p *GrokCLIProvider) stream(ctx context.Context, req ai.ChatRequest, callback func(ai.StreamChunk)) error {
	emitted, err := p.streamAttempt(ctx, req, callback)
	if err == nil || emitted || !shouldRetryGrokCLITurn(ctx, err) {
		return err
	}
	// 已经吐过内容的流不能重试（会把已展示的内容重说一遍）；
	// 只有干净失败的取消才值得再跑一次。
	logger.Infof("GrokCLI 推理请求被上游取消且尚未输出内容，自动重试 1 次")
	_, retryErr := p.streamAttempt(ctx, req, callback)
	return retryErr
}

func (p *GrokCLIProvider) streamAttempt(ctx context.Context, req ai.ChatRequest, callback func(ai.StreamChunk)) (emitted bool, err error) {
	ctx, watchdog := startCLIIdleWatchdog(ctx, cliStreamIdleTimeout, cliStreamMaxTimeout)
	defer watchdog.Close()

	command, err := resolveGrokCLICommand(runtime.GOOS, lookPathWithOverride(p.config.CLIPath, grokLookPath))
	if err != nil {
		return false, err
	}
	prompt := buildPrompt(req.Messages)
	promptFile, cleanupPromptFile, err := createGrokCLIPromptFile(prompt)
	if err != nil {
		return false, err
	}
	defer cleanupPromptFile()
	args, err := buildGrokCLIArgsWithStream(p.config, promptFile, true)
	if err != nil {
		return false, err
	}

	cmd := newGrokCLICommand(ctx, command, args...)
	cmd.Env = MergeProviderCLIEnv(EnrichCLICommandPATH(cmd.Environ(), command), p.config.CLIEnv)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return false, fmt.Errorf("create Grok CLI stdout pipe failed: %w", err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	requestLog := logAIUpstreamRequestStart(p.Name(), "CLI", "grok://cli", buildGrokCLIRequestLogBody(args, prompt, p.config, req))
	var requestErr error
	// failureOutput 在进程结束后才有值；defer 闭包按引用读取，用户主动取消
	// 之外的所有失败都会把 CLI 原始输出落日志——失败详情可能只有一个协议词，
	// 没有原始输出就没有诊断现场。
	var failureOutput string
	defer func() {
		if requestErr != nil && !errors.Is(requestErr, context.Canceled) {
			logAIUpstreamCLIOutput(requestLog, failureOutput)
		}
		logAIUpstreamRequestFinish(requestLog, 0, requestErr)
	}()

	if err := cmd.Start(); err != nil {
		requestErr = fmt.Errorf("start Grok CLI failed: %w", err)
		return false, requestErr
	}
	if cmd.Process != nil {
		logger.Infof("GrokCLI 请求进程已启动：requestId=%s pid=%d", requestLog.id, cmd.Process.Pid)
	}

	var streamUsage *ai.TokenUsage
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	var combined strings.Builder
	for scanner.Scan() {
		watchdog.Bump()
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		combined.Write(line)
		combined.WriteByte('\n')
		if usage := grokStreamUsageFromLine(line); usage != nil {
			streamUsage = usage
		}
		thinking, content := grokStreamChunkFromLine(line)
		if thinking != "" {
			callback(ai.StreamChunk{Thinking: thinking})
			emitted = true
		}
		if content != "" {
			callback(ai.StreamChunk{Content: content})
			emitted = true
		}
	}
	scanErr := scanner.Err()
	waitErr := cmd.Wait()
	stdoutText := combined.String()
	stderrText := stderr.String()
	combined.WriteString(stderrText)
	failureOutput = combined.String()

	if watchdog.TimedOut() || isClaudeCLITimeout(ctx, waitErr) {
		requestErr = watchdog.TimeoutError("Grok CLI")
		return emitted, requestErr
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		requestErr = context.Canceled
		return emitted, requestErr
	}
	capability, _ := LookupCLICapability("grok-cli")
	if rejection := capability.InspectRejection(combined.String()); rejection != nil {
		requestErr = rejection
		return emitted, requestErr
	}
	if detail := grokCLIStructuredErrorDetail(stdoutText); detail != "" {
		requestErr = grokCLIExecutionError(detail)
		return emitted, requestErr
	}
	if grokCLITerminalCancelled(stdoutText) {
		requestErr = grokCLIExecutionError("cancelled")
		return emitted, requestErr
	}
	if scanErr != nil {
		requestErr = fmt.Errorf("read Grok CLI stream failed: %w", scanErr)
		return emitted, requestErr
	}
	if waitErr != nil && !emitted {
		detail := grokCLIExecutionFailureDetail(stdoutText, stderrText, waitErr)
		requestErr = grokCLIExecutionError(detail)
		return emitted, requestErr
	}
	if !emitted {
		requestErr = fmt.Errorf("Grok CLI returned no streamed content")
		return emitted, requestErr
	}
	callback(ai.StreamChunk{Done: true, Usage: streamUsage})
	return emitted, nil
}

func grokStreamChunkFromLine(raw []byte) (thinking, content string) {
	var payload any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", ""
	}
	return grokStreamChunkFromValue(payload)
}

func grokStreamUsageFromLine(raw []byte) *ai.TokenUsage {
	var payload any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil
	}
	return grokStreamUsageFromValue(payload)
}

func grokStreamUsageFromValue(value any) *ai.TokenUsage {
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	if rawUsage, ok := object["usage"]; ok {
		encoded, err := json.Marshal(rawUsage)
		if err == nil {
			var usage grokCLIUsage
			if json.Unmarshal(encoded, &usage) == nil {
				normalized := normalizeGrokCLIUsage(usage)
				return &normalized
			}
		}
	}
	for _, key := range []string{"event", "message", "result"} {
		if nested := grokStreamUsageFromValue(object[key]); nested != nil {
			return nested
		}
	}
	return nil
}

func grokStreamChunkFromValue(value any) (thinking, content string) {
	object, ok := value.(map[string]any)
	if !ok {
		return "", ""
	}
	if event, ok := object["event"].(map[string]any); ok {
		if nestedThinking, nestedContent := grokStreamChunkFromValue(event); nestedThinking != "" || nestedContent != "" {
			return nestedThinking, nestedContent
		}
	}
	if delta, ok := object["delta"].(map[string]any); ok {
		thinking = stringFromJSON(delta["thinking"])
		if thinking == "" {
			thinking = stringFromJSON(delta["thought"])
		}
		return thinking, stringFromJSON(delta["text"])
	}
	switch strings.TrimSpace(stringFromJSON(object["type"])) {
	case "content_block_delta", "text_delta", "thinking_delta", "stream_event":
		return stringFromJSON(object["thinking"]), stringFromJSON(object["text"])
	case "", "result":
		return stringFromJSON(object["thought"]), stringFromJSON(object["text"])
	}
	return "", ""
}

func stringFromJSON(value any) string {
	text, _ := value.(string)
	return text
}

func (p *GrokCLIProvider) run(ctx context.Context, req ai.ChatRequest) (grokCLIResult, error) {
	result, err := p.runAttempt(ctx, req)
	if !shouldRetryGrokCLITurn(ctx, err) {
		return result, err
	}
	// 缓冲路径没有已展示的增量输出，取消后重试不会有重复内容。
	logger.Infof("GrokCLI 推理请求被上游取消，自动重试 1 次")
	return p.runAttempt(ctx, req)
}

func (p *GrokCLIProvider) runAttempt(ctx context.Context, req ai.ChatRequest) (grokCLIResult, error) {
	ctx, cancel := ensureClaudeCLITimeout(ctx, grokCLIRequestTimeout)
	defer cancel()

	command, err := resolveGrokCLICommand(runtime.GOOS, lookPathWithOverride(p.config.CLIPath, grokLookPath))
	if err != nil {
		return grokCLIResult{}, err
	}

	prompt := buildPrompt(req.Messages)
	promptFile, cleanupPromptFile, err := createGrokCLIPromptFile(prompt)
	if err != nil {
		return grokCLIResult{}, err
	}
	defer cleanupPromptFile()
	args, err := buildGrokCLIArgs(p.config, promptFile)
	if err != nil {
		return grokCLIResult{}, err
	}

	cmd := newGrokCLICommand(ctx, command, args...)
	cmd.Env = MergeProviderCLIEnv(EnrichCLICommandPATH(cmd.Environ(), command), p.config.CLIEnv)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	requestLog := logAIUpstreamRequestStart(
		p.Name(),
		"CLI",
		"grok://cli",
		buildGrokCLIRequestLogBody(args, prompt, p.config, req),
	)
	var requestErr error
	// 与 streamAttempt 相同：失败时把 CLI 原始输出落日志，用户主动取消除外。
	var failureOutput string
	defer func() {
		if requestErr != nil && !errors.Is(requestErr, context.Canceled) {
			logAIUpstreamCLIOutput(requestLog, failureOutput)
		}
		logAIUpstreamRequestFinish(requestLog, 0, requestErr)
	}()

	runErr := cmd.Run()
	combined := stdout.String() + "\n" + stderr.String()
	failureOutput = combined
	if errors.Is(ctx.Err(), context.Canceled) && !errors.Is(ctx.Err(), context.DeadlineExceeded) {
		requestErr = context.Canceled
		return grokCLIResult{}, requestErr
	}
	if isClaudeCLITimeout(ctx, runErr) {
		requestErr = fmt.Errorf("Grok CLI timed out after %s while waiting for the local grok process; the model may still be thinking", grokCLIRequestTimeout)
		return grokCLIResult{}, requestErr
	}

	// 关键：grok 在参数被拒、被限流或 max-turns 终止时【退出码仍为 0】，
	// 错误只出现在输出里。因此必须先做输出判定，不能依赖 runErr。
	capability, _ := LookupCLICapability("grok-cli")
	if rejection := capability.InspectRejection(combined); rejection != nil {
		requestErr = rejection
		return grokCLIResult{}, requestErr
	}
	if detail := grokCLIStructuredErrorDetail(stdout.String()); detail != "" {
		requestErr = grokCLIExecutionError(detail)
		return grokCLIResult{}, requestErr
	}
	if grokCLITerminalCancelled(stdout.String()) {
		requestErr = grokCLIExecutionError("cancelled")
		return grokCLIResult{}, requestErr
	}

	parsed, parseErr := parseGrokCLIResponse(stdout.Bytes())
	if parseErr != nil {
		detail := grokCLIExecutionFailureDetail(stdout.String(), stderr.String(), runErr)
		if detail == "" {
			requestErr = fmt.Errorf("Grok CLI execution failed: %s", parseErr)
			return grokCLIResult{}, requestErr
		}
		requestErr = grokCLIExecutionError(detail)
		return grokCLIResult{}, requestErr
	}
	if strings.EqualFold(strings.TrimSpace(parsed.stopReason), "cancelled") {
		requestErr = grokCLIExecutionError("cancelled")
		return grokCLIResult{}, requestErr
	}

	if strings.TrimSpace(parsed.Content) == "" {
		requestErr = fmt.Errorf("Grok CLI returned no content (stopReason=%s)", parsed.stopReason)
		return grokCLIResult{}, requestErr
	}
	return grokCLIResult{
		Content:  parsed.Content,
		Thinking: parsed.Thinking,
		Usage:    parsed.Usage,
	}, nil
}

type grokCLIParsed struct {
	grokCLIResult
	stopReason string
}

func parseGrokCLIResponse(raw []byte) (grokCLIParsed, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return grokCLIParsed{}, fmt.Errorf("empty output")
	}
	var payload grokCLIResponse
	if err := json.Unmarshal(trimmed, &payload); err != nil {
		return grokCLIParsed{}, err
	}
	return grokCLIParsed{
		grokCLIResult: grokCLIResult{
			Content:  strings.TrimSpace(payload.Text),
			Thinking: strings.TrimSpace(payload.Thought),
			Usage:    normalizeGrokCLIUsage(payload.Usage),
		},
		stopReason: payload.StopReason,
	}, nil
}

func createGrokCLIPromptFile(prompt string) (string, func(), error) {
	file, err := os.CreateTemp("", "gonavi-grok-prompt-*.txt")
	if err != nil {
		return "", func() {}, fmt.Errorf("create Grok CLI prompt file failed: %w", err)
	}
	path := file.Name()
	cleanup := func() { _ = os.Remove(path) }
	if _, err := file.WriteString(prompt); err != nil {
		_ = file.Close()
		cleanup()
		return "", func() {}, fmt.Errorf("write Grok CLI prompt file failed: %w", err)
	}
	if err := file.Close(); err != nil {
		cleanup()
		return "", func() {}, fmt.Errorf("close Grok CLI prompt file failed: %w", err)
	}
	return path, cleanup, nil
}

func newGrokCLICommand(ctx context.Context, name string, args ...string) *exec.Cmd {
	// Grok is commonly installed through a Windows command wrapper. GoNavi is
	// a GUI process, so the child must use the same no-console policy as the
	// other local CLI providers instead of creating a transient terminal tab.
	return newLocalCLICommand(grokCommandContext, ctx, name, args...)
}

func grokCLIStructuredErrorDetail(output string) string {
	scanner := bufio.NewScanner(strings.NewReader(output))
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		var event struct {
			Type    string   `json:"type"`
			Message string   `json:"message"`
			Errors  []string `json:"errors"`
		}
		if err := json.Unmarshal(bytes.TrimSpace(scanner.Bytes()), &event); err != nil {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(event.Type), "error") && strings.TrimSpace(event.Message) != "" {
			return normalizeGrokCLIErrorDetail(event.Message)
		}
		for _, detail := range event.Errors {
			if normalized := normalizeGrokCLIErrorDetail(detail); normalized != "" {
				return normalized
			}
		}
	}
	return ""
}

func normalizeGrokCLIErrorDetail(detail string) string {
	detail = strings.TrimSpace(detail)
	detail = strings.TrimSpace(strings.TrimPrefix(detail, "Error:"))
	const marker = "Internal error:"
	if index := strings.LastIndex(detail, marker); index >= 0 {
		encoded := strings.TrimSpace(detail[index+len(marker):])
		var payload struct {
			Message    string `json:"message"`
			HTTPStatus int    `json:"http_status"`
		}
		if err := json.NewDecoder(strings.NewReader(encoded)).Decode(&payload); err == nil {
			message := strings.TrimSpace(payload.Message)
			if message != "" {
				if payload.HTTPStatus > 0 && !strings.Contains(message, fmt.Sprintf("%d", payload.HTTPStatus)) {
					message = fmt.Sprintf("%s (HTTP %d)", message, payload.HTTPStatus)
				}
				return message
			}
		}
	}
	return strings.TrimSpace(firstLineFrom(detail))
}

func grokCLIExecutionFailureDetail(stdout string, stderr string, fallback error) string {
	if detail := grokCLIStructuredErrorDetail(stdout); detail != "" {
		return detail
	}
	if strings.Contains(stderr, "Internal error:") {
		if detail := normalizeGrokCLIErrorDetail(stderr); detail != "" {
			return detail
		}
	}
	if detail := strings.TrimSpace(firstLineFrom(strings.TrimSpace(stderr))); detail != "" {
		return detail
	}
	if fallback != nil {
		return fallback.Error()
	}
	return ""
}

// grokCLIExecutionError 把 CLI 输出里的失败详情包装成最终错误。
// 裸 "cancelled" 只是 grok 的 stopReason 枚举值，原样展示给用户无从理解，
// 换成可操作的提示并标记可重试；其余详情保持逐字透传（如 402 余额报错）。
func grokCLIExecutionError(detail string) error {
	switch strings.ToLower(strings.TrimSpace(detail)) {
	case "cancelled", "canceled", "request cancelled":
		return fmt.Errorf("Grok CLI execution failed: %w（多为网络波动、代理断流或上游过载），请重新发送重试", errGrokCLIUpstreamCancelled)
	}
	return fmt.Errorf("Grok CLI execution failed: %s", detail)
}

// grokCLITerminalCancelled 识别终止 result 行声明的 "cancelled" stop reason。
// 官方文档把 errors[] 放在错误子类型上，但 stop reason 是回合级权威信号，
// 即使上游漏发 errors[] 也能据此判定本回合没有完成。键的大小写在两种输出
// 格式间不一致（stop_reason / stopReason），两个都认。
func grokCLITerminalCancelled(output string) bool {
	scanner := bufio.NewScanner(strings.NewReader(output))
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		var event struct {
			Type            string `json:"type"`
			StopReason      string `json:"stop_reason"`
			StopReasonCamel string `json:"stopReason"`
		}
		if err := json.Unmarshal(bytes.TrimSpace(scanner.Bytes()), &event); err != nil {
			continue
		}
		if !strings.EqualFold(strings.TrimSpace(event.Type), "result") {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(event.StopReason), "cancelled") ||
			strings.EqualFold(strings.TrimSpace(event.StopReasonCamel), "cancelled") {
			return true
		}
	}
	return false
}

// shouldRetryGrokCLITurn 判定一次失败的尝试是否值得自动重试：
// 仅限上游取消哨兵，且父 context 仍然存活（用户主动停止绝不重跑）。
func shouldRetryGrokCLITurn(ctx context.Context, err error) bool {
	return err != nil && ctx.Err() == nil && errors.Is(err, errGrokCLIUpstreamCancelled)
}

func buildGrokCLIArgs(config ai.ProviderConfig, promptFile string) ([]string, error) {
	return buildGrokCLIArgsWithStream(config, promptFile, false)
}

func buildGrokCLIArgsWithStream(config ai.ProviderConfig, promptFile string, stream bool) ([]string, error) {
	format := "json"
	args := []string{"--prompt-file", promptFile, "--output-format", format}
	if stream {
		// NDJSON in the Anthropic Messages wire format, plus incremental
		// text/thinking deltas. json mode waits for the whole reply.
		args = []string{"--prompt-file", promptFile, "--output-format", "streaming-messages-json", "--include-partial-messages"}
	}
	args = append(args,
		// grok 没有 --ignore-user-config/--ignore-rules；覆盖系统提示是唯一能阻断
		// 用户全局规则进入本次调用的手段。
		"--system-prompt-override", grokCLISystemPrompt,
		// 空白名单 = 不允许任何内置工具。本 provider 只做对话与 SQL 生成，
		// 数据库访问由 GoNavi 自己的工具层负责，不经由 CLI 的文件/命令工具。
		"--tools", "",
		"--disable-web-search",
	)

	capability, ok := LookupCLICapability("grok-cli")
	if !ok {
		return nil, fmt.Errorf("grok-cli capability is not registered")
	}
	if model := strings.TrimSpace(config.Model); model != "" {
		args = append(args, capability.ModelFlag, model)
	}
	effort, err := capability.NormalizeEffort(config.Effort)
	if err != nil {
		// 档位非法时直接失败，而不是让 grok 去拒绝——它拒绝时退出码是 0，会被误判成成功。
		return nil, err
	}
	args = capability.AppendEffortArgs(args, effort)
	return args, nil
}

func buildGrokCLIRequestLogBody(args []string, prompt string, config ai.ProviderConfig, req ai.ChatRequest) map[string]any {
	return map[string]any{
		"args":          args,
		"promptChars":   len(prompt),
		"model":         strings.TrimSpace(config.Model),
		"effort":        strings.TrimSpace(config.Effort),
		"messageCount":  len(req.Messages),
		"isolationMode": grokCLIIsolationNote,
	}
}
