package provider

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"GoNavi-Wails/internal/ai"
)

// OpenAIResponsesProvider 实现 OpenAI Responses API，并将 Items/SSE 事件
// 适配为 GoNavi 内部统一的消息、工具调用和流式片段。
type OpenAIResponsesProvider struct {
	config  ai.ProviderConfig
	baseURL string
	client  *http.Client
}

func NewOpenAIResponsesProvider(config ai.ProviderConfig) (Provider, error) {
	baseURL := normalizeOpenAIResponsesBaseURL(config.BaseURL)
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

	return &OpenAIResponsesProvider{
		config:  normalized,
		baseURL: baseURL,
		client: &http.Client{
			Timeout: openAIHTTPTimeout,
		},
	}, nil
}

func normalizeOpenAIResponsesBaseURL(raw string) string {
	baseURL := NormalizeOpenAICompatibleBaseURL(raw)
	if isDeepSeekHost(baseURL) {
		baseURL = strings.TrimSuffix(baseURL, "/v1")
	}
	return strings.TrimRight(baseURL, "/")
}

func boolPointer(value bool) *bool {
	return &value
}

func isDeepSeekResponsesBaseURL(baseURL string) bool {
	return isDeepSeekHost(baseURL)
}

func (p *OpenAIResponsesProvider) Name() string {
	if strings.TrimSpace(p.config.Name) != "" {
		return p.config.Name
	}
	return "OpenAI Responses"
}

func (p *OpenAIResponsesProvider) Validate() error {
	if strings.TrimSpace(p.config.APIKey) == "" {
		return fmt.Errorf("API key is required")
	}
	return nil
}

type openAIResponsesRequest struct {
	Model           string                    `json:"model"`
	Input           []json.RawMessage         `json:"input"`
	Temperature     float64                   `json:"temperature,omitempty"`
	MaxOutputTokens int                       `json:"max_output_tokens,omitempty"`
	Stream          bool                      `json:"stream"`
	Store           *bool                     `json:"store,omitempty"`
	Include         []string                  `json:"include,omitempty"`
	Tools           []openAIResponsesTool     `json:"tools,omitempty"`
	Reasoning       *openAIResponsesReasoning `json:"reasoning,omitempty"`
}

type openAIResponsesSessionState struct {
	Input []json.RawMessage `json:"input"`
}

type openAIResponsesReasoning struct {
	Effort  string `json:"effort,omitempty"`
	Summary string `json:"summary,omitempty"`
}

type openAIResponsesInputItem struct {
	Type      string `json:"type,omitempty"`
	Role      string `json:"role,omitempty"`
	Content   any    `json:"content,omitempty"`
	CallID    string `json:"call_id,omitempty"`
	Name      string `json:"name,omitempty"`
	Arguments string `json:"arguments,omitempty"`
	Output    string `json:"output,omitempty"`
}

type openAIResponsesContentPart struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	ImageURL string `json:"image_url,omitempty"`
}

type openAIResponsesTool struct {
	Type        string `json:"type"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Parameters  any    `json:"parameters,omitempty"`
	Strict      bool   `json:"strict"`
}

type openAIResponsesError struct {
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

type openAIResponsesOutputItem struct {
	ID        string `json:"id,omitempty"`
	Type      string `json:"type"`
	Role      string `json:"role,omitempty"`
	Status    string `json:"status,omitempty"`
	CallID    string `json:"call_id,omitempty"`
	Name      string `json:"name,omitempty"`
	Arguments string `json:"arguments,omitempty"`
	Content   []struct {
		Type    string `json:"type"`
		Text    string `json:"text,omitempty"`
		Refusal string `json:"refusal,omitempty"`
	} `json:"content,omitempty"`
	Summary []struct {
		Type string `json:"type"`
		Text string `json:"text,omitempty"`
	} `json:"summary,omitempty"`
}

type openAIResponsesResponse struct {
	ID     string            `json:"id"`
	Status string            `json:"status,omitempty"`
	Output []json.RawMessage `json:"output"`
	Usage  struct {
		InputTokens  int `json:"input_tokens"`
		OutputTokens int `json:"output_tokens"`
		TotalTokens  int `json:"total_tokens"`
	} `json:"usage"`
	Error             *openAIResponsesError `json:"error,omitempty"`
	IncompleteDetails *struct {
		Reason string `json:"reason,omitempty"`
	} `json:"incomplete_details,omitempty"`
}

type openAIResponsesStreamEvent struct {
	Type        string                    `json:"type"`
	Code        string                    `json:"code,omitempty"`
	Message     string                    `json:"message,omitempty"`
	Delta       string                    `json:"delta,omitempty"`
	Arguments   string                    `json:"arguments,omitempty"`
	Name        string                    `json:"name,omitempty"`
	OutputIndex int                       `json:"output_index,omitempty"`
	Item        openAIResponsesOutputItem `json:"item,omitempty"`
	Response    openAIResponsesResponse   `json:"response,omitempty"`
	Error       *openAIResponsesError     `json:"error,omitempty"`
}

func buildOpenAIResponsesTools(tools []ai.Tool) []openAIResponsesTool {
	if len(tools) == 0 {
		return nil
	}
	result := make([]openAIResponsesTool, 0, len(tools))
	for _, tool := range tools {
		result = append(result, openAIResponsesTool{
			Type:        "function",
			Name:        tool.Function.Name,
			Description: tool.Function.Description,
			Parameters:  tool.Function.Parameters,
			// Chat Completions 中现有工具默认是非严格模式，迁移时显式保持该语义。
			Strict: false,
		})
	}
	return result
}

func buildOpenAIResponsesInput(messages []ai.Message, baseURL string) []openAIResponsesInputItem {
	return buildOpenAIResponsesInputWithToolCallIDs(messages, baseURL, nil)
}

func buildOpenAIResponsesInputWithToolCallIDs(messages []ai.Message, baseURL string, toolCallIDs map[string]struct{}) []openAIResponsesInputItem {
	if toolCallIDs == nil {
		messages = normalizeToolCallHistoryForResponses(messages)
	} else {
		messages = normalizeToolCallHistoryForResponsesWithSession(messages, toolCallIDs)
	}
	items := make([]openAIResponsesInputItem, 0, len(messages))
	for _, message := range messages {
		if message.Role == "tool" {
			items = append(items, openAIResponsesInputItem{
				Type:   "function_call_output",
				CallID: message.ToolCallID,
				Output: message.Content,
			})
			continue
		}

		if message.Content != "" || len(message.Images) > 0 || len(message.ToolCalls) == 0 {
			content := any(message.Content)
			if len(message.Images) > 0 {
				text := message.Content
				if text == "" {
					text = providerImageFallbackPrompt("")
				}
				parts := []openAIResponsesContentPart{{Type: "input_text", Text: text}}
				for _, image := range message.Images {
					imageURL := image
					if strings.Contains(strings.ToLower(baseURL), "bigmodel") {
						if _, raw, err := ParseDataURI(image); err == nil {
							imageURL = raw
						}
					}
					parts = append(parts, openAIResponsesContentPart{Type: "input_image", ImageURL: imageURL})
				}
				content = parts
			}
			items = append(items, openAIResponsesInputItem{
				Type:    "message",
				Role:    message.Role,
				Content: content,
			})
		}

		for _, toolCall := range message.ToolCalls {
			items = append(items, openAIResponsesInputItem{
				Type:      "function_call",
				CallID:    toolCall.ID,
				Name:      toolCall.Function.Name,
				Arguments: toolCall.Function.Arguments,
			})
		}
	}
	return items
}

func marshalOpenAIResponsesInput(items []openAIResponsesInputItem) []json.RawMessage {
	if len(items) == 0 {
		return nil
	}
	result := make([]json.RawMessage, 0, len(items))
	for _, item := range items {
		encoded, err := json.Marshal(item)
		if err == nil {
			result = append(result, json.RawMessage(encoded))
		}
	}
	return result
}

func cloneOpenAIResponsesRawItems(items []json.RawMessage) []json.RawMessage {
	if len(items) == 0 {
		return nil
	}
	result := make([]json.RawMessage, len(items))
	for index, item := range items {
		result[index] = append(json.RawMessage(nil), item...)
	}
	return result
}

func decodeOpenAIResponsesSessionState(state json.RawMessage) (openAIResponsesSessionState, bool) {
	if len(state) == 0 {
		return openAIResponsesSessionState{}, false
	}
	var decoded openAIResponsesSessionState
	if err := json.Unmarshal(state, &decoded); err != nil || len(decoded.Input) == 0 {
		return openAIResponsesSessionState{}, false
	}
	decoded.Input = cloneOpenAIResponsesRawItems(decoded.Input)
	return decoded, true
}

func responsesSessionToolCallIDs(items []json.RawMessage) map[string]struct{} {
	ids := make(map[string]struct{})
	for _, rawItem := range items {
		var item struct {
			Type   string `json:"type"`
			CallID string `json:"call_id"`
		}
		if err := json.Unmarshal(rawItem, &item); err != nil || item.Type != "function_call" {
			continue
		}
		if id := strings.TrimSpace(item.CallID); id != "" {
			ids[id] = struct{}{}
		}
	}
	return ids
}

func encodeOpenAIResponsesSessionState(input []json.RawMessage, output []json.RawMessage) (json.RawMessage, error) {
	combined := make([]json.RawMessage, 0, len(input)+len(output))
	combined = append(combined, cloneOpenAIResponsesRawItems(input)...)
	combined = append(combined, cloneOpenAIResponsesRawItems(output)...)
	encoded, err := json.Marshal(openAIResponsesSessionState{Input: combined})
	if err != nil {
		return nil, fmt.Errorf("serialize OpenAI Responses session state failed: %w", err)
	}
	return json.RawMessage(encoded), nil
}

func (p *OpenAIResponsesProvider) buildRequest(req ai.ChatRequest, stream bool) openAIResponsesRequest {
	requestMessages := prepareOpenAIRequestMessagesForRequest(
		req.Messages,
		p.config.Model,
		p.baseURL,
		req.ImageFallbackPrompt,
		req.ImageOmittedNotice,
	)
	temperature := req.Temperature
	if temperature <= 0 {
		temperature = p.config.Temperature
	}
	maxOutputTokens := req.MaxTokens
	if maxOutputTokens <= 0 {
		maxOutputTokens = p.config.MaxTokens
	}
	body := openAIResponsesRequest{
		Model:           p.config.Model,
		Input:           marshalOpenAIResponsesInput(buildOpenAIResponsesInput(requestMessages, p.baseURL)),
		Temperature:     temperature,
		MaxOutputTokens: maxOutputTokens,
		Stream:          stream,
		Tools:           buildOpenAIResponsesTools(req.Tools),
	}
	if !isDeepSeekResponsesBaseURL(p.baseURL) {
		body.Store = boolPointer(false)
	}
	if !isDeepSeekResponsesBaseURL(p.baseURL) {
		body.Include = []string{"reasoning.encrypted_content"}
	}
	if intensity := NormalizeThinkingIntensity(p.config.ThinkingIntensity); intensity != "" {
		if effort := openAIReasoningEffort(intensity); effort != "" {
			body.Reasoning = &openAIResponsesReasoning{Effort: effort}
			if !isDeepSeekResponsesBaseURL(p.baseURL) {
				body.Reasoning.Summary = "auto"
			}
		}
	}
	return body
}

func parseOpenAIResponsesOutput(result openAIResponsesResponse) *ai.ChatResponse {
	var content strings.Builder
	var reasoning strings.Builder
	toolCalls := make([]ai.ToolCall, 0)
	for _, rawItem := range result.Output {
		var item openAIResponsesOutputItem
		if err := json.Unmarshal(rawItem, &item); err != nil {
			continue
		}
		switch item.Type {
		case "message":
			for _, part := range item.Content {
				if part.Type == "output_text" && part.Text != "" {
					content.WriteString(part.Text)
				}
				if part.Type == "refusal" && part.Refusal != "" {
					content.WriteString(part.Refusal)
				}
			}
		case "reasoning":
			for _, part := range item.Summary {
				if part.Text != "" {
					reasoning.WriteString(part.Text)
				}
			}
			for _, part := range item.Content {
				if part.Text != "" {
					reasoning.WriteString(part.Text)
				}
			}
		case "function_call":
			toolCalls = append(toolCalls, ai.ToolCall{
				ID:   item.CallID,
				Type: "function",
				Function: ai.ToolCallFunction{
					Name:      item.Name,
					Arguments: item.Arguments,
				},
			})
		}
	}

	return &ai.ChatResponse{
		Content:          content.String(),
		ReasoningContent: reasoning.String(),
		ToolCalls:        toolCalls,
		TokensUsed: ai.TokenUsage{
			PromptTokens:     result.Usage.InputTokens,
			CompletionTokens: result.Usage.OutputTokens,
			TotalTokens:      result.Usage.TotalTokens,
		},
	}
}

func openAIResponsesIncompleteError(result openAIResponsesResponse) error {
	if result.Status != "incomplete" && result.IncompleteDetails == nil {
		return nil
	}
	reason := ""
	if result.IncompleteDetails != nil {
		reason = strings.TrimSpace(result.IncompleteDetails.Reason)
	}
	if reason == "" {
		return fmt.Errorf("OpenAI Responses response incomplete")
	}
	return fmt.Errorf("OpenAI Responses response incomplete: %s", reason)
}

func (p *OpenAIResponsesProvider) Chat(ctx context.Context, req ai.ChatRequest) (*ai.ChatResponse, error) {
	response, _, err := p.ChatWithState(ctx, nil, req)
	return response, err
}

func (p *OpenAIResponsesProvider) ChatWithState(
	ctx context.Context,
	state json.RawMessage,
	req ai.ChatRequest,
) (*ai.ChatResponse, json.RawMessage, error) {
	if err := p.Validate(); err != nil {
		return nil, state, err
	}

	body := p.buildRequest(req, false)
	if len(state) > 0 {
		previous, ok := decodeOpenAIResponsesSessionState(state)
		if !ok {
			return nil, state, fmt.Errorf("parse OpenAI Responses session state failed")
		}
		requestMessages := prepareOpenAIRequestMessagesForRequest(
			req.Messages,
			p.config.Model,
			p.baseURL,
			req.ImageFallbackPrompt,
			req.ImageOmittedNotice,
		)
		body.Input = append(
			cloneOpenAIResponsesRawItems(previous.Input),
			marshalOpenAIResponsesInput(buildOpenAIResponsesInputWithToolCallIDs(requestMessages, p.baseURL, responsesSessionToolCallIDs(previous.Input)))...,
		)
	}
	respBody, err := p.doRequest(ctx, body)
	if err != nil {
		respBody, body, err = p.retryClientRejectedRequest(ctx, req, body, err)
		if err != nil {
			return nil, state, err
		}
	}
	defer respBody.Close()

	var result openAIResponsesResponse
	if err := json.NewDecoder(respBody).Decode(&result); err != nil {
		return nil, state, fmt.Errorf("parse OpenAI Responses response failed: %w", err)
	}
	if result.Error != nil && result.Error.Message != "" {
		return nil, state, fmt.Errorf("OpenAI Responses API error: %s", result.Error.Message)
	}
	if err := openAIResponsesIncompleteError(result); err != nil {
		return nil, state, err
	}
	response := parseOpenAIResponsesOutput(result)
	if response.Content == "" && response.ReasoningContent == "" && len(response.ToolCalls) == 0 {
		return nil, state, fmt.Errorf("OpenAI Responses returned empty response")
	}
	nextState, err := encodeOpenAIResponsesSessionState(body.Input, result.Output)
	if err != nil {
		return nil, state, err
	}
	return response, nextState, nil
}

func (p *OpenAIResponsesProvider) ChatStream(ctx context.Context, req ai.ChatRequest, callback func(ai.StreamChunk)) error {
	_, err := p.ChatStreamWithState(ctx, nil, req, callback)
	return err
}

func (p *OpenAIResponsesProvider) ChatStreamWithState(
	ctx context.Context,
	state json.RawMessage,
	req ai.ChatRequest,
	callback func(ai.StreamChunk),
) (json.RawMessage, error) {
	if err := p.Validate(); err != nil {
		return state, err
	}

	body := p.buildRequest(req, true)
	if len(state) > 0 {
		previous, ok := decodeOpenAIResponsesSessionState(state)
		if !ok {
			return state, fmt.Errorf("parse OpenAI Responses session state failed")
		}
		requestMessages := prepareOpenAIRequestMessagesForRequest(
			req.Messages,
			p.config.Model,
			p.baseURL,
			req.ImageFallbackPrompt,
			req.ImageOmittedNotice,
		)
		body.Input = append(
			cloneOpenAIResponsesRawItems(previous.Input),
			marshalOpenAIResponsesInput(buildOpenAIResponsesInputWithToolCallIDs(requestMessages, p.baseURL, responsesSessionToolCallIDs(previous.Input)))...,
		)
	}
	respBody, err := p.doRequest(ctx, body)
	if err != nil {
		respBody, body, err = p.retryClientRejectedRequest(ctx, req, body, err)
		if err != nil {
			return state, err
		}
	}
	defer respBody.Close()

	receivedText := false
	receivedReasoning := false
	receivedToolCall := false
	toolCalls := make([]ai.ToolCall, 0)
	toolCallIndexes := make(map[int]int)

	upsertToolCall := func(outputIndex int, item openAIResponsesOutputItem, argumentsDelta string) {
		toolIndex, ok := toolCallIndexes[outputIndex]
		if !ok {
			toolIndex = len(toolCalls)
			toolCallIndexes[outputIndex] = toolIndex
			toolCalls = append(toolCalls, ai.ToolCall{Type: "function"})
		}
		toolCall := &toolCalls[toolIndex]
		if item.CallID != "" {
			toolCall.ID = item.CallID
		}
		if item.Name != "" {
			toolCall.Function.Name = item.Name
		}
		if item.Arguments != "" {
			toolCall.Function.Arguments = item.Arguments
		} else if argumentsDelta != "" {
			toolCall.Function.Arguments += argumentsDelta
		}
		receivedToolCall = true
		callback(ai.StreamChunk{ToolCalls: append([]ai.ToolCall(nil), toolCalls...)})
	}

	scanner := bufio.NewScanner(respBody)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" {
			continue
		}
		if data == "[DONE]" {
			return state, fmt.Errorf("OpenAI Responses stream ended before response.completed")
		}

		var event openAIResponsesStreamEvent
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			continue
		}
		switch event.Type {
		case "response.output_text.delta", "response.refusal.delta":
			if event.Delta != "" {
				receivedText = true
				callback(ai.StreamChunk{Content: event.Delta})
			}
		case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
			if event.Delta != "" {
				receivedReasoning = true
				callback(ai.StreamChunk{Thinking: event.Delta, ReasoningContent: event.Delta})
			}
		case "response.output_item.added", "response.output_item.done":
			if event.Item.Type == "function_call" {
				upsertToolCall(event.OutputIndex, event.Item, "")
			}
		case "response.function_call_arguments.delta":
			upsertToolCall(event.OutputIndex, openAIResponsesOutputItem{}, event.Delta)
		case "response.function_call_arguments.done":
			item := event.Item
			if item.Arguments == "" {
				item.Arguments = event.Arguments
			}
			if item.Name == "" {
				item.Name = event.Name
			}
			upsertToolCall(event.OutputIndex, item, "")
		case "response.completed":
			completed := parseOpenAIResponsesOutput(event.Response)
			if !receivedText && completed.Content != "" {
				receivedText = true
				callback(ai.StreamChunk{Content: completed.Content})
			}
			if !receivedReasoning && completed.ReasoningContent != "" {
				receivedReasoning = true
				callback(ai.StreamChunk{Thinking: completed.ReasoningContent, ReasoningContent: completed.ReasoningContent})
			}
			if len(completed.ToolCalls) > 0 {
				receivedToolCall = true
				toolCalls = completed.ToolCalls
				callback(ai.StreamChunk{ToolCalls: append([]ai.ToolCall(nil), toolCalls...)})
			}
			if !receivedText && !receivedReasoning && !receivedToolCall {
				return state, fmt.Errorf("OpenAI Responses returned empty response")
			}
			if len(event.Response.Output) == 0 {
				callback(ai.StreamChunk{Done: true})
				return nil, nil
			}
			nextState, err := encodeOpenAIResponsesSessionState(body.Input, event.Response.Output)
			if err != nil {
				return state, err
			}
			callback(ai.StreamChunk{Done: true})
			return nextState, nil
		case "response.failed":
			message := "OpenAI Responses request failed"
			if event.Response.Error != nil && event.Response.Error.Message != "" {
				message = event.Response.Error.Message
			}
			return state, fmt.Errorf("%s", message)
		case "response.incomplete":
			if incompleteErr := openAIResponsesIncompleteError(event.Response); incompleteErr != nil {
				return state, incompleteErr
			}
			return state, fmt.Errorf("OpenAI Responses response incomplete")
		case "error":
			message := "OpenAI Responses streaming error"
			if event.Error != nil && event.Error.Message != "" {
				message = event.Error.Message
			} else if event.Message != "" {
				message = event.Message
			}
			return state, fmt.Errorf("%s", message)
		}
	}

	if err := scanner.Err(); err != nil {
		return state, fmt.Errorf("read OpenAI Responses streaming response failed: %w", err)
	}
	return state, fmt.Errorf("OpenAI Responses stream ended before response.completed")
}

func (p *OpenAIResponsesProvider) retryClientRejectedRequest(
	ctx context.Context,
	req ai.ChatRequest,
	body openAIResponsesRequest,
	err error,
) (io.ReadCloser, openAIResponsesRequest, error) {
	if !isHTTP400Error(err) {
		return nil, body, err
	}

	if len(body.Include) > 0 {
		originalInclude := append([]string(nil), body.Include...)
		body.Include = nil
		respBody, retryErr := p.doRequest(ctx, body)
		if retryErr == nil {
			fmt.Println("[OpenAI Responses] 上游不支持 include，自动降级为不请求加密推理内容")
			return respBody, body, nil
		}
		if !isHTTP400Error(retryErr) {
			return nil, body, retryErr
		}
		// include 不是失败原因时恢复它，后续 tools/images 降级仍保留加密推理回放能力。
		body.Include = originalInclude
		err = retryErr
	}

	if len(body.Tools) > 0 {
		fmt.Println("[OpenAI Responses] 模型不支持 Function Calling，自动降级为纯文本模式")
		body.Tools = nil
		respBody, retryErr := p.doRequest(ctx, body)
		if retryErr == nil {
			return respBody, body, nil
		}
		if !isHTTP400Error(retryErr) {
			return nil, body, retryErr
		}
		err = retryErr
	}

	if requestMessagesContainImages(req.Messages) {
		fmt.Println("[OpenAI Responses] 模型不支持图片输入，自动移除图片后重试")
		stripped := stripImagesFromRequestMessagesWithNotice(req.Messages, req.ImageOmittedNotice)
		requestInputCount := len(p.buildRequest(req, body.Stream).Input)
		prefixCount := len(body.Input) - requestInputCount
		if prefixCount < 0 {
			prefixCount = 0
		}
		strippedInput := marshalOpenAIResponsesInput(buildOpenAIResponsesInput(stripped, p.baseURL))
		body.Input = append(cloneOpenAIResponsesRawItems(body.Input[:prefixCount]), strippedInput...)
		body.Tools = nil
		respBody, retryErr := p.doRequest(ctx, body)
		if retryErr == nil {
			return respBody, body, nil
		}
		if !isHTTP400Error(retryErr) {
			return nil, body, retryErr
		}
		err = retryErr
	}

	if len(body.Include) > 0 {
		body.Include = nil
		respBody, retryErr := p.doRequest(ctx, body)
		if retryErr == nil {
			fmt.Println("[OpenAI Responses] 上游不支持 include，自动降级为不请求加密推理内容")
			return respBody, body, nil
		}
		return nil, body, retryErr
	}

	return nil, body, err
}

func (p *OpenAIResponsesProvider) doRequest(ctx context.Context, body openAIResponsesRequest) (io.ReadCloser, error) {
	jsonBody, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("serialize request failed: %w", err)
	}

	endpoint := ResolveOpenAICompatibleEndpoint(p.baseURL, "responses")
	if isDeepSeekResponsesBaseURL(p.baseURL) {
		endpoint = strings.TrimRight(p.baseURL, "/") + "/responses"
	}
	requestLog := logAIUpstreamRequestStart(p.Name(), http.MethodPost, endpoint, body)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(jsonBody))
	if err != nil {
		logAIUpstreamRequestFinish(requestLog, 0, err)
		return nil, fmt.Errorf("create HTTP request failed: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+p.config.APIKey)
	if body.Stream {
		httpReq.Header.Set("Accept", "text/event-stream")
		httpReq.Header.Set("Cache-Control", "no-cache")
		httpReq.Header.Set("Connection", "keep-alive")
	}
	for key, value := range p.config.Headers {
		httpReq.Header.Set(key, value)
	}

	resp, err := p.client.Do(httpReq)
	if err != nil {
		logAIUpstreamRequestFinish(requestLog, 0, err)
		return nil, fmt.Errorf("request to %s failed: %w", endpoint, err)
	}
	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		statusErr := fmt.Errorf("OpenAI Responses API returned error (HTTP %d): %s", resp.StatusCode, readProviderErrorBody(resp.Body, resp.ContentLength))
		logAIUpstreamRequestFinish(requestLog, resp.StatusCode, statusErr)
		return nil, statusErr
	}

	logAIUpstreamRequestFinish(requestLog, resp.StatusCode, nil)
	return resp.Body, nil
}
