package provider

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"GoNavi-Wails/internal/ai"
)

const (
	defaultAnthropicBaseURL = "https://api.anthropic.com"
	anthropicAPIVersion     = "2023-06-01"
)

func normalizeAnthropicMessagesURL(baseURL string) string {
	url := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if url == "" {
		url = defaultAnthropicBaseURL
	}
	url = normalizeDeepSeekAnthropicBaseURL(url)
	if strings.HasSuffix(url, "/messages") {
		return url
	}
	if strings.HasSuffix(url, "/v1") {
		return url + "/messages"
	}
	return url + "/v1/messages"
}

// normalizeDeepSeekAnthropicBaseURL 将 DeepSeek 自定义端点纠正为官方 Anthropic 兼容 base。
// 用户常填 https://api.deepseek.com（OpenAI 路径），Anthropic 格式必须使用 .../anthropic。
func normalizeDeepSeekAnthropicBaseURL(baseURL string) string {
	raw := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if raw == "" {
		return raw
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return raw
	}
	host := strings.ToLower(parsed.Hostname())
	if host != "api.deepseek.com" && !strings.HasSuffix(host, ".deepseek.com") {
		return raw
	}
	path := strings.TrimRight(parsed.Path, "/")
	lowerPath := strings.ToLower(path)
	if strings.Contains(lowerPath, "/anthropic") {
		return raw
	}
	// OpenAI 兼容路径 /v1 不能直接拼 Anthropic messages
	if lowerPath == "/v1" || strings.HasSuffix(lowerPath, "/v1") {
		parsed.Path = "/anthropic"
	} else if path == "" || path == "/" {
		parsed.Path = "/anthropic"
	} else {
		parsed.Path = path + "/anthropic"
	}
	return strings.TrimRight(parsed.String(), "/")
}

func isDeepSeekHost(baseURL string) bool {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return strings.Contains(strings.ToLower(baseURL), "deepseek")
	}
	host := strings.ToLower(parsed.Hostname())
	return host == "api.deepseek.com" || strings.HasSuffix(host, ".deepseek.com") || strings.Contains(host, "deepseek")
}

func IsDashScopeAnthropicCompatibleBaseURL(baseURL string) bool {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	return host == "dashscope.aliyuncs.com" || host == "coding.dashscope.aliyuncs.com"
}

func ApplyAnthropicAuthHeaders(headers http.Header, baseURL string, apiKey string) {
	headers.Set("x-api-key", apiKey)
	if IsDashScopeAnthropicCompatibleBaseURL(baseURL) {
		headers.Set("Authorization", "Bearer "+apiKey)
		headers.Del("anthropic-version")
		return
	}
	headers.Set("anthropic-version", anthropicAPIVersion)
}

// AnthropicProvider 实现 Anthropic Claude API 的 Provider
type AnthropicProvider struct {
	config  ai.ProviderConfig
	baseURL string
	client  *http.Client
}

// NewAnthropicProvider 创建 Anthropic Provider 实例
func NewAnthropicProvider(config ai.ProviderConfig) (Provider, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(config.BaseURL), "/")
	if baseURL == "" {
		baseURL = defaultAnthropicBaseURL
	}
	baseURL = normalizeDeepSeekAnthropicBaseURL(baseURL)
	model := strings.TrimSpace(config.Model)
	if model == "" {
		return nil, fmt.Errorf("model ID is required; select or enter a model in Settings")
	}
	maxTokens := config.MaxTokens
	if maxTokens <= 0 {
		maxTokens = defaultOpenAIMaxTokens
	}
	temperature := config.Temperature
	if temperature <= 0 {
		temperature = defaultOpenAITemperature
	}

	normalized := config
	normalized.BaseURL = baseURL
	normalized.Model = model
	normalized.MaxTokens = maxTokens
	normalized.Temperature = temperature
	profile := ResolveThinkingProfile(config.Type, config.APIFormat, baseURL, model)
	normalized.ThinkingIntensity = string(clampThinkingIntensityToProfile(config.ThinkingIntensity, profile))

	return &AnthropicProvider{
		config:  normalized,
		baseURL: baseURL,
		client:  &http.Client{Timeout: openAIHTTPTimeout},
	}, nil
}

func (p *AnthropicProvider) Name() string {
	if strings.TrimSpace(p.config.Name) != "" {
		return p.config.Name
	}
	return "Anthropic"
}

func (p *AnthropicProvider) Validate() error {
	if strings.TrimSpace(p.config.APIKey) == "" {
		return fmt.Errorf("API key is required")
	}
	return nil
}

// --- 请求体类型 ---

type anthropicRequest struct {
	Model        string                  `json:"model"`
	Messages     []anthropicMessage      `json:"messages"`
	System       string                  `json:"system,omitempty"`
	MaxTokens    int                     `json:"max_tokens"`
	Temperature  float64                 `json:"temperature,omitempty"`
	Stream       bool                    `json:"stream,omitempty"`
	Tools        []anthropicTool         `json:"tools,omitempty"`
	Thinking     *anthropicThinking      `json:"thinking,omitempty"`
	OutputConfig *anthropicOutputConfig  `json:"output_config,omitempty"`
}

// anthropicThinking Anthropic / DeepSeek Anthropic 兼容思考开关。
// DeepSeek 会忽略 budget_tokens，但仍需 type=enabled。
type anthropicThinking struct {
	Type         string `json:"type"`
	BudgetTokens int    `json:"budget_tokens,omitempty"`
}

// anthropicOutputConfig DeepSeek Anthropic 兼容 effort 控制。
type anthropicOutputConfig struct {
	Effort string `json:"effort,omitempty"`
}

// anthropicTool Anthropic 格式的工具定义
type anthropicTool struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	InputSchema any    `json:"input_schema"`
}

type anthropicMessage struct {
	Role    string      `json:"role"`
	Content interface{} `json:"content"`
}

// convertToolsToAnthropic 将 OpenAI 格式的 tools 转换为 Anthropic 格式
func convertToolsToAnthropic(tools []ai.Tool) []anthropicTool {
	if len(tools) == 0 {
		return nil
	}
	result := make([]anthropicTool, 0, len(tools))
	for _, t := range tools {
		result = append(result, anthropicTool{
			Name:        t.Function.Name,
			Description: t.Function.Description,
			InputSchema: t.Function.Parameters,
		})
	}
	return result
}

func buildAnthropicMessages(reqMessages []ai.Message) []anthropicMessage {
	return buildAnthropicMessagesWithOptions(reqMessages, false)
}

func buildAnthropicMessagesWithOptions(reqMessages []ai.Message, includeThinkingBlocks bool) []anthropicMessage {
	messages := make([]anthropicMessage, 0, len(reqMessages))
	for _, m := range reqMessages {
		// tool result 消息：转换为 Anthropic 的 tool_result content block
		if m.Role == "tool" {
			messages = append(messages, anthropicMessage{
				Role: "user",
				Content: []map[string]interface{}{
					{
						"type":        "tool_result",
						"tool_use_id": m.ToolCallID,
						"content":     m.Content,
					},
				},
			})
			continue
		}

		// assistant 带 tool_calls：转换为 Anthropic 的 tool_use content block
		if m.Role == "assistant" && len(m.ToolCalls) > 0 {
			var contentParts []map[string]interface{}
			// DeepSeek Anthropic 思考模式下，后续轮次必须回传 thinking 块，否则 400。
			if includeThinkingBlocks && strings.TrimSpace(m.ReasoningContent) != "" {
				contentParts = append(contentParts, map[string]interface{}{
					"type":     "thinking",
					"thinking": m.ReasoningContent,
				})
			}
			if m.Content != "" {
				contentParts = append(contentParts, map[string]interface{}{
					"type": "text",
					"text": m.Content,
				})
			}
			for _, tc := range m.ToolCalls {
				var input interface{}
				if err := json.Unmarshal([]byte(tc.Function.Arguments), &input); err != nil {
					input = map[string]interface{}{}
				}
				contentParts = append(contentParts, map[string]interface{}{
					"type":  "tool_use",
					"id":    tc.ID,
					"name":  tc.Function.Name,
					"input": input,
				})
			}
			messages = append(messages, anthropicMessage{Role: "assistant", Content: contentParts})
			continue
		}

		// assistant 纯文本但带思考内容（多轮回传）
		if m.Role == "assistant" && includeThinkingBlocks && strings.TrimSpace(m.ReasoningContent) != "" {
			var contentParts []map[string]interface{}
			contentParts = append(contentParts, map[string]interface{}{
				"type":     "thinking",
				"thinking": m.ReasoningContent,
			})
			if m.Content != "" {
				contentParts = append(contentParts, map[string]interface{}{
					"type": "text",
					"text": m.Content,
				})
			}
			messages = append(messages, anthropicMessage{Role: "assistant", Content: contentParts})
			continue
		}

		// 图片消息
		if len(m.Images) > 0 {
			var contentParts []map[string]interface{}
			for _, img := range m.Images {
				mimeType, rawBase64, err := ParseDataURI(img)
				if err == nil {
					contentParts = append(contentParts, map[string]interface{}{
						"type": "image",
						"source": map[string]interface{}{
							"type":       "base64",
							"media_type": mimeType,
							"data":       rawBase64,
						},
					})
				}
			}
			text := m.Content
			if text == "" {
				text = providerImageFallbackPrompt("")
			}
			contentParts = append(contentParts, map[string]interface{}{
				"type": "text",
				"text": text,
			})
			messages = append(messages, anthropicMessage{Role: m.Role, Content: contentParts})
		} else {
			messages = append(messages, anthropicMessage{Role: m.Role, Content: m.Content})
		}
	}
	return messages
}

// --- 响应体类型 ---

type anthropicContentBlock struct {
	Type     string          `json:"type"` // "text" | "tool_use" | "thinking"
	Text     string          `json:"text,omitempty"`
	Thinking string          `json:"thinking,omitempty"` // thinking block
	ID       string          `json:"id,omitempty"`       // tool_use
	Name     string          `json:"name,omitempty"`     // tool_use
	Input    json.RawMessage `json:"input,omitempty"`    // tool_use
}

type anthropicResponse struct {
	Content []anthropicContentBlock `json:"content"`
	Usage   struct {
		InputTokens  int `json:"input_tokens"`
		OutputTokens int `json:"output_tokens"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// 流式事件类型
type anthropicStreamEvent struct {
	Type         string                 `json:"type"`
	Index        int                    `json:"index,omitempty"`
	ContentBlock *anthropicContentBlock `json:"content_block,omitempty"`
	Delta        *struct {
		Type        string `json:"type,omitempty"`
		Text        string `json:"text,omitempty"`
		Thinking    string `json:"thinking,omitempty"`
		PartialJSON string `json:"partial_json,omitempty"`
	} `json:"delta,omitempty"`
}

func (p *AnthropicProvider) shouldReplayThinkingBlocks() bool {
	// DeepSeek Anthropic 思考链路要求历史 assistant 消息带回 thinking 块。
	return isDeepSeekHost(p.baseURL) || strings.Contains(strings.ToLower(p.config.Model), "deepseek")
}

func (p *AnthropicProvider) applyThinkingToRequest(body *anthropicRequest) {
	if body == nil {
		return
	}
	profile := ResolveThinkingProfile(p.config.Type, p.config.APIFormat, p.baseURL, p.config.Model)
	intensity := clampThinkingIntensityToProfile(p.config.ThinkingIntensity, profile)
	// 空值：不强制改写请求，保持供应商默认
	if intensity == "" {
		return
	}
	if intensity == ai.ThinkingIntensityOff || intensity == ai.ThinkingIntensity("none") {
		// DeepSeek 支持 disabled；官方 Anthropic 省略 thinking 更稳妥
		if profile == ThinkingProfileDeepSeek {
			body.Thinking = &anthropicThinking{Type: "disabled"}
		} else {
			body.Thinking = nil
		}
		body.OutputConfig = nil
		return
	}
	// DeepSeek Anthropic：type=enabled + effort（budget 会被忽略）
	// 官方 Anthropic：budget_tokens + effort（新模型可用 adaptive/effort）
	body.Thinking = &anthropicThinking{
		Type:         "enabled",
		BudgetTokens: anthropicThinkingBudgetTokens(intensity),
	}
	if effort := anthropicOutputEffort(intensity); effort != "" {
		body.OutputConfig = &anthropicOutputConfig{Effort: effort}
	}
}

// --- Chat 非流式 ---

func (p *AnthropicProvider) Chat(ctx context.Context, req ai.ChatRequest) (*ai.ChatResponse, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}

	systemMsg, messages := extractSystemMessage(req.Messages)
	messages = applyImageFallbackPrompt(messages, req.ImageFallbackPrompt)
	anthropicMsgs := buildAnthropicMessagesWithOptions(messages, p.shouldReplayThinkingBlocks())

	temperature := req.Temperature
	if temperature <= 0 {
		temperature = p.config.Temperature
	}
	maxTokens := req.MaxTokens
	if maxTokens <= 0 {
		maxTokens = p.config.MaxTokens
	}

	body := anthropicRequest{
		Model:       p.config.Model,
		Messages:    anthropicMsgs,
		System:      systemMsg,
		MaxTokens:   maxTokens,
		Temperature: temperature,
		Tools:       convertToolsToAnthropic(req.Tools),
	}
	p.applyThinkingToRequest(&body)

	respBody, err := p.doRequest(ctx, body)
	if err != nil {
		if len(req.Tools) > 0 && isHTTP400Error(err) {
			body.Tools = nil
			respBody, err = p.doRequest(ctx, body)
			if err != nil {
				return nil, err
			}
		} else {
			return nil, err
		}
	}
	defer respBody.Close()

	var result anthropicResponse
	if err := json.NewDecoder(respBody).Decode(&result); err != nil {
		return nil, fmt.Errorf("parse Anthropic response failed: %w", err)
	}
	if result.Error != nil && result.Error.Message != "" {
		return nil, fmt.Errorf("Anthropic API error: %s", result.Error.Message)
	}
	if len(result.Content) == 0 {
		return nil, fmt.Errorf("Anthropic returned empty response")
	}

	// 解析响应中的 text / thinking / tool_use content blocks
	var textContent string
	var reasoningContent string
	var toolCalls []ai.ToolCall
	for _, block := range result.Content {
		switch block.Type {
		case "text":
			textContent += block.Text
		case "thinking":
			reasoningContent += block.Thinking
		case "tool_use":
			argsStr := "{}"
			if len(block.Input) > 0 {
				argsStr = string(block.Input)
			}
			toolCalls = append(toolCalls, ai.ToolCall{
				ID:   block.ID,
				Type: "function",
				Function: ai.ToolCallFunction{
					Name:      block.Name,
					Arguments: argsStr,
				},
			})
		}
	}

	return &ai.ChatResponse{
		Content:          textContent,
		ReasoningContent: reasoningContent,
		ToolCalls:        toolCalls,
		TokensUsed: ai.TokenUsage{
			PromptTokens:     result.Usage.InputTokens,
			CompletionTokens: result.Usage.OutputTokens,
			TotalTokens:      result.Usage.InputTokens + result.Usage.OutputTokens,
		},
	}, nil
}

// --- ChatStream 流式 ---

func (p *AnthropicProvider) ChatStream(ctx context.Context, req ai.ChatRequest, callback func(ai.StreamChunk)) error {
	if err := p.Validate(); err != nil {
		return err
	}

	systemMsg, messages := extractSystemMessage(req.Messages)
	messages = applyImageFallbackPrompt(messages, req.ImageFallbackPrompt)
	anthropicMsgs := buildAnthropicMessagesWithOptions(messages, p.shouldReplayThinkingBlocks())

	temperature := req.Temperature
	if temperature <= 0 {
		temperature = p.config.Temperature
	}
	maxTokens := req.MaxTokens
	if maxTokens <= 0 {
		maxTokens = p.config.MaxTokens
	}

	body := anthropicRequest{
		Model:       p.config.Model,
		Messages:    anthropicMsgs,
		System:      systemMsg,
		MaxTokens:   maxTokens,
		Temperature: temperature,
		Stream:      true,
		Tools:       convertToolsToAnthropic(req.Tools),
	}
	p.applyThinkingToRequest(&body)

	respBody, err := p.doRequest(ctx, body)
	if err != nil {
		if len(req.Tools) > 0 && isHTTP400Error(err) {
			body.Tools = nil
			respBody, err = p.doRequest(ctx, body)
			if err != nil {
				return err
			}
		} else {
			return err
		}
	}
	defer respBody.Close()

	// 跟踪当前活跃的 tool_use blocks
	type activeToolUse struct {
		id       string
		name     string
		argsJSON strings.Builder
	}
	activeBlocks := make(map[int]*activeToolUse) // index -> block

	scanner := bufio.NewScanner(respBody)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimPrefix(line, "data: ")

		var event anthropicStreamEvent
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			continue
		}

		switch event.Type {
		case "content_block_start":
			if event.ContentBlock != nil && event.ContentBlock.Type == "tool_use" {
				activeBlocks[event.Index] = &activeToolUse{
					id:   event.ContentBlock.ID,
					name: event.ContentBlock.Name,
				}
			}

		case "content_block_delta":
			if event.Delta == nil {
				continue
			}
			switch event.Delta.Type {
			case "text_delta":
				if event.Delta.Text != "" {
					callback(ai.StreamChunk{Content: event.Delta.Text})
				}
			case "thinking_delta":
				if event.Delta.Thinking != "" {
					callback(ai.StreamChunk{
						Thinking:         event.Delta.Thinking,
						ReasoningContent: event.Delta.Thinking,
					})
				}
			case "input_json_delta":
				if block, ok := activeBlocks[event.Index]; ok {
					block.argsJSON.WriteString(event.Delta.PartialJSON)
				}
			}

		case "content_block_stop":
			if block, ok := activeBlocks[event.Index]; ok {
				argsStr := block.argsJSON.String()
				if argsStr == "" {
					argsStr = "{}"
				}
				// 产出完整的 tool call
				callback(ai.StreamChunk{
					ToolCalls: []ai.ToolCall{
						{
							ID:   block.id,
							Type: "function",
							Function: ai.ToolCallFunction{
								Name:      block.name,
								Arguments: argsStr,
							},
						},
					},
				})
				delete(activeBlocks, event.Index)
			}

		case "message_stop":
			callback(ai.StreamChunk{Done: true})
			return nil
		}
	}

	if err := scanner.Err(); err != nil {
		return err
	}
	callback(ai.StreamChunk{Done: true})
	return nil
}

// --- HTTP 请求 ---

func (p *AnthropicProvider) doRequest(ctx context.Context, body interface{}) (io.ReadCloser, error) {
	jsonBody, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("serialize request failed: %w", err)
	}

	url := normalizeAnthropicMessagesURL(p.baseURL)
	requestLog := logAIUpstreamRequestStart(p.Name(), http.MethodPost, url, body)

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(jsonBody))
	if err != nil {
		logAIUpstreamRequestFinish(requestLog, 0, err)
		return nil, fmt.Errorf("create HTTP request failed: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	ApplyAnthropicAuthHeaders(httpReq.Header, p.baseURL, p.config.APIKey)

	if strings.Contains(string(jsonBody), `"stream":true`) || strings.Contains(string(jsonBody), `"stream": true`) {
		httpReq.Header.Set("Accept", "text/event-stream")
		httpReq.Header.Set("Cache-Control", "no-cache")
		httpReq.Header.Set("Connection", "keep-alive")
	}

	// 仅官方 API 发 beta 特性头（代理不发，避免触发 Claude Code 验证）
	isOfficialAPI := p.baseURL == defaultAnthropicBaseURL || strings.Contains(p.baseURL, "anthropic.com")
	if isOfficialAPI {
		httpReq.Header.Set("anthropic-beta", "interleaved-thinking-2025-05-14,output-128k-2025-02-19,prompt-caching-2024-07-31")
	}

	// 自定义 headers（用于兼容各类代理服务）
	for k, v := range p.config.Headers {
		httpReq.Header.Set(k, v)
	}

	resp, err := p.client.Do(httpReq)
	if err != nil {
		logAIUpstreamRequestFinish(requestLog, 0, err)
		return nil, fmt.Errorf("request to %s failed: %w", url, err)
	}

	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		bodyBytes, _ := io.ReadAll(resp.Body)
		statusErr := fmt.Errorf("Anthropic API returned error (HTTP %d): %s", resp.StatusCode, string(bodyBytes))
		logAIUpstreamRequestFinish(requestLog, resp.StatusCode, statusErr)
		return nil, statusErr
	}

	logAIUpstreamRequestFinish(requestLog, resp.StatusCode, nil)
	return resp.Body, nil
}

// extractSystemMessage 从消息列表中提取 system 消息（Anthropic 要求 system 作为独立字段）
func extractSystemMessage(messages []ai.Message) (string, []ai.Message) {
	var systemParts []string
	var remaining []ai.Message
	for _, m := range messages {
		if m.Role == "system" {
			systemParts = append(systemParts, m.Content)
		} else {
			remaining = append(remaining, m)
		}
	}
	return strings.Join(systemParts, "\n\n"), remaining
}
