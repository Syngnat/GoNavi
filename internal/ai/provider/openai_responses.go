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
	"time"
	"unicode"

	"GoNavi-Wails/internal/ai"
)

// OpenAIResponsesProvider 实现 OpenAI Responses API，并将 Items/SSE 事件
// 适配为 GoNavi 内部统一的消息、工具调用和流式片段。
type OpenAIResponsesProvider struct {
	config  ai.ProviderConfig
	baseURL string
	client  *http.Client
}

var openAIResponsesHTTPTransport = func() http.RoundTripper {
	transport, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return http.DefaultTransport
	}
	transport = transport.Clone()
	// 流式请求不能用 Client.Timeout 限制整个响应体，但仍需限制等待响应头。
	transport.ResponseHeaderTimeout = openAIHTTPTimeout
	return transport
}()

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
		client:  newOpenAIResponsesHTTPClient(),
	}, nil
}

func newOpenAIResponsesHTTPClient() *http.Client {
	return &http.Client{
		Timeout:   openAIHTTPTimeout,
		Transport: openAIResponsesHTTPTransport,
	}
}

func openAIResponsesHTTPClientForRequest(client *http.Client, stream bool) *http.Client {
	if !stream || client == nil || client.Timeout == 0 {
		return client
	}

	// http.Client.Timeout 会一直计时到响应体读取完成，长时间正常输出的 SSE
	// 也会被截断。浅拷贝保留 Transport、重定向和 Cookie 配置，仅让本次
	// 流式请求由 request context 控制生命周期。
	streamClient := *client
	streamClient.Timeout = 0
	return &streamClient
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

func (detail *openAIResponsesError) UnmarshalJSON(data []byte) error {
	type errorObject openAIResponsesError
	var object errorObject
	if err := json.Unmarshal(data, &object); err == nil {
		*detail = openAIResponsesError(object)
		return nil
	}

	var message string
	if err := json.Unmarshal(data, &message); err == nil {
		detail.Message = message
		return nil
	}

	// Keep the enclosing stream event readable even when a compatibility
	// endpoint returns an unknown error shape; the normal fallback still
	// provides a deterministic user-visible error.
	*detail = openAIResponsesError{}
	return nil
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
	Error       json.RawMessage           `json:"error,omitempty"`
}

func decodeOpenAIResponsesStreamError(raw json.RawMessage) openAIResponsesError {
	var detail openAIResponsesError
	if len(raw) == 0 {
		return detail
	}
	if err := json.Unmarshal(raw, &detail); err == nil {
		return detail
	}

	var message string
	if err := json.Unmarshal(raw, &message); err == nil {
		detail.Message = message
	}
	return detail
}

func firstOpenAIResponsesErrorDetail(values ...string) string {
	for _, value := range values {
		if detail := strings.TrimSpace(value); detail != "" {
			return detail
		}
	}
	return ""
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

// canonicalizeOpenAIResponsesFunctionCallsForInput removes response-only
// fields before a function call is sent back as a later Responses input item.
// Several OpenAI-compatible endpoints emit an `id` and `status` in response
// output but reject those fields for the corresponding input variant.
func canonicalizeOpenAIResponsesFunctionCallsForInput(items []json.RawMessage) []json.RawMessage {
	if len(items) == 0 {
		return nil
	}

	result := make([]json.RawMessage, 0, len(items))
	for _, rawItem := range items {
		var item struct {
			Type      string `json:"type"`
			CallID    string `json:"call_id"`
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
		}
		if err := json.Unmarshal(rawItem, &item); err != nil || item.Type != "function_call" {
			result = append(result, append(json.RawMessage(nil), rawItem...))
			continue
		}

		arguments, validArguments := normalizeOpenAIToolCallArguments(item.Arguments)
		if strings.TrimSpace(item.CallID) == "" || strings.TrimSpace(item.Name) == "" || !validArguments {
			// A malformed function call cannot be paired with a safe tool result.
			// Drop it rather than preserving a request that compatible endpoints
			// will reject as invalid input.
			continue
		}
		encoded, err := json.Marshal(openAIResponsesInputItem{
			Type:      "function_call",
			CallID:    item.CallID,
			Name:      item.Name,
			Arguments: arguments,
		})
		if err != nil {
			continue
		}
		result = append(result, json.RawMessage(encoded))
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
	combined = canonicalizeOpenAIResponsesFunctionCallsForInput(combined)
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

func normalizeOpenAIResponsesOutputToolCallArguments(output []json.RawMessage) ([]json.RawMessage, error) {
	normalized := cloneOpenAIResponsesRawItems(output)
	for index, rawItem := range normalized {
		var envelope struct {
			Type      string          `json:"type"`
			CallID    string          `json:"call_id"`
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(rawItem, &envelope); err != nil || envelope.Type != "function_call" {
			continue
		}
		if len(envelope.Arguments) > 0 {
			var rawArguments any
			if err := json.Unmarshal(envelope.Arguments, &rawArguments); err != nil {
				return nil, openAIResponsesInvalidToolArgumentsError(envelope.Name, envelope.CallID)
			}
			if _, isString := rawArguments.(string); !isString {
				return nil, openAIResponsesInvalidToolArgumentsError(envelope.Name, envelope.CallID)
			}
		}

		var item openAIResponsesOutputItem
		if err := json.Unmarshal(rawItem, &item); err != nil {
			return nil, openAIResponsesInvalidToolArgumentsError(envelope.Name, envelope.CallID)
		}

		normalizedArguments, valid := normalizeOpenAIToolCallArguments(item.Arguments)
		if !valid {
			return nil, openAIResponsesInvalidToolArgumentsError(item.Name, item.CallID)
		}
		if normalizedArguments == item.Arguments {
			continue
		}

		var fields map[string]json.RawMessage
		if err := json.Unmarshal(rawItem, &fields); err != nil {
			return nil, fmt.Errorf("normalize OpenAI Responses function call arguments failed: %w", err)
		}
		encodedArguments, err := json.Marshal(normalizedArguments)
		if err != nil {
			return nil, fmt.Errorf("normalize OpenAI Responses function call arguments failed: %w", err)
		}
		fields["arguments"] = json.RawMessage(encodedArguments)
		encodedItem, err := json.Marshal(fields)
		if err != nil {
			return nil, fmt.Errorf("normalize OpenAI Responses function call arguments failed: %w", err)
		}
		normalized[index] = json.RawMessage(encodedItem)
	}
	return normalized, nil
}

func normalizeOpenAIResponsesToolCallArguments(toolCalls []ai.ToolCall) ([]ai.ToolCall, error) {
	normalized := append([]ai.ToolCall(nil), toolCalls...)
	for index := range normalized {
		arguments, valid := normalizeOpenAIToolCallArguments(normalized[index].Function.Arguments)
		if !valid {
			return nil, openAIResponsesInvalidToolArgumentsError(
				normalized[index].Function.Name,
				normalized[index].ID,
			)
		}
		normalized[index].Function.Arguments = arguments
	}
	return normalized, nil
}

func openAIResponsesInvalidToolArgumentsError(name string, callID string) error {
	return fmt.Errorf(
		"OpenAI Responses function call %q (call_id %q) returned invalid arguments: expected a JSON object",
		name,
		callID,
	)
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

// openAIResponsesTerminalError validates the final response envelope before
// its output can update the conversation cursor. Some OpenAI-compatible
// Responses endpoints emit response.completed even when the embedded response
// itself failed, so the event type alone is not a success signal. Empty status
// remains accepted for compatibility with providers that omit it on a normal
// terminal event.
func openAIResponsesTerminalError(result openAIResponsesResponse) error {
	return openAIResponsesTerminalErrorWithDetails(
		result,
		false,
		responseErrorMessage(result.Error),
		responseErrorCode(result.Error),
	)
}

// openAIResponsesCompletedStreamEventError applies the same terminal status
// validation to a streamed completion event. A few OpenAI-compatible
// providers put the failure detail on the event rather than inside response,
// so accepting response.completed based on its embedded status alone would
// incorrectly advance the provider state.
func openAIResponsesCompletedStreamEventError(event openAIResponsesStreamEvent) error {
	eventError := decodeOpenAIResponsesStreamError(event.Error)
	hasTopLevelError := len(bytes.TrimSpace(event.Error)) > 0 && !bytes.Equal(bytes.TrimSpace(event.Error), []byte("null"))
	hasTopLevelError = hasTopLevelError || strings.TrimSpace(event.Message) != "" || strings.TrimSpace(event.Code) != ""
	return openAIResponsesTerminalErrorWithDetails(
		event.Response,
		hasTopLevelError,
		responseErrorMessage(event.Response.Error),
		eventError.Message,
		event.Message,
		responseErrorCode(event.Response.Error),
		eventError.Code,
		event.Code,
	)
}

func openAIResponsesTerminalErrorWithDetails(
	result openAIResponsesResponse,
	hasTopLevelError bool,
	details ...string,
) error {
	status := strings.ToLower(strings.TrimSpace(result.Status))
	if status == "incomplete" || result.IncompleteDetails != nil {
		return openAIResponsesIncompleteError(result)
	}

	if status == "" || status == "completed" {
		if result.Error == nil && !hasTopLevelError {
			return nil
		}
		if detail := firstOpenAIResponsesErrorDetail(details...); detail != "" {
			return fmt.Errorf("OpenAI Responses API error: %s", detail)
		}
		return fmt.Errorf("OpenAI Responses API error")
	}

	if detail := firstOpenAIResponsesErrorDetail(details...); detail != "" {
		return fmt.Errorf("OpenAI Responses response %s: %s", status, detail)
	}
	return fmt.Errorf("OpenAI Responses response %s", status)
}

func responseErrorMessage(detail *openAIResponsesError) string {
	if detail == nil {
		return ""
	}
	return detail.Message
}

func responseErrorCode(detail *openAIResponsesError) string {
	if detail == nil {
		return ""
	}
	return detail.Code
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
		previousInput := canonicalizeOpenAIResponsesFunctionCallsForInput(previous.Input)
		body.Input = append(
			previousInput,
			marshalOpenAIResponsesInput(buildOpenAIResponsesInputWithToolCallIDs(requestMessages, p.baseURL, responsesSessionToolCallIDs(previousInput)))...,
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
	if err := openAIResponsesTerminalError(result); err != nil {
		return nil, state, err
	}
	normalizedOutput, err := normalizeOpenAIResponsesOutputToolCallArguments(result.Output)
	if err != nil {
		return nil, state, err
	}
	result.Output = normalizedOutput
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
		previousInput := canonicalizeOpenAIResponsesFunctionCallsForInput(previous.Input)
		body.Input = append(
			previousInput,
			marshalOpenAIResponsesInput(buildOpenAIResponsesInputWithToolCallIDs(requestMessages, p.baseURL, responsesSessionToolCallIDs(previousInput)))...,
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
			if err := openAIResponsesCompletedStreamEventError(event); err != nil {
				return state, err
			}
			normalizedOutput, err := normalizeOpenAIResponsesOutputToolCallArguments(event.Response.Output)
			if err != nil {
				return state, err
			}
			event.Response.Output = normalizedOutput
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
			} else if len(toolCalls) > 0 {
				toolCalls, err = normalizeOpenAIResponsesToolCallArguments(toolCalls)
				if err != nil {
					return state, err
				}
				receivedToolCall = true
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
			responseError := openAIResponsesError{}
			if event.Response.Error != nil {
				responseError = *event.Response.Error
			}
			eventError := decodeOpenAIResponsesStreamError(event.Error)
			if detail := firstOpenAIResponsesErrorDetail(
				responseError.Message,
				eventError.Message,
				event.Message,
				responseError.Code,
				eventError.Code,
				event.Code,
			); detail != "" {
				message = detail
			}
			return state, fmt.Errorf("%s", message)
		case "response.incomplete":
			if incompleteErr := openAIResponsesIncompleteError(event.Response); incompleteErr != nil {
				return state, incompleteErr
			}
			return state, fmt.Errorf("OpenAI Responses response incomplete")
		case "error":
			message := "OpenAI Responses streaming error"
			eventError := decodeOpenAIResponsesStreamError(event.Error)
			if detail := firstOpenAIResponsesErrorDetail(
				eventError.Message,
				event.Message,
				eventError.Code,
				event.Code,
			); detail != "" {
				message = detail
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
	imagesStripped := false
	for {
		switch {
		case len(body.Include) > 0 && isOpenAIResponsesUnsupportedIncludeError(err):
			body.Include = nil
			fmt.Println("[OpenAI Responses] 上游不支持 include，自动降级为不请求加密推理内容")
		case len(body.Tools) > 0 && isOpenAIResponsesUnsupportedToolsError(err):
			body.Tools = nil
			fmt.Println("[OpenAI Responses] 模型不支持 Function Calling，自动降级为纯文本模式")
		case !imagesStripped && requestMessagesContainImages(req.Messages) && isOpenAIResponsesUnsupportedImagesError(err):
			stripped := stripImagesFromRequestMessagesWithNotice(req.Messages, req.ImageOmittedNotice)
			requestInputCount := len(p.buildRequest(req, body.Stream).Input)
			prefixCount := len(body.Input) - requestInputCount
			if prefixCount < 0 {
				prefixCount = 0
			}
			strippedInput := marshalOpenAIResponsesInput(buildOpenAIResponsesInput(stripped, p.baseURL))
			body.Input = append(cloneOpenAIResponsesRawItems(body.Input[:prefixCount]), strippedInput...)
			imagesStripped = true
			fmt.Println("[OpenAI Responses] 模型不支持图片输入，自动移除图片后重试")
		default:
			return nil, body, err
		}

		respBody, retryErr := p.doRequest(ctx, body)
		if retryErr == nil {
			return respBody, body, nil
		}
		err = retryErr
	}
}

func isOpenAIResponsesUnsupportedIncludeError(err error) bool {
	return isOpenAIResponsesUnsupportedCapabilityError(err, "include")
}

func isOpenAIResponsesUnsupportedToolsError(err error) bool {
	return isOpenAIResponsesUnsupportedCapabilityError(
		err,
		"tools",
		"functions",
		"function calling",
		"function-calling",
		"tool calling",
		"tool-calling",
		"tool use",
	)
}

func isOpenAIResponsesUnsupportedImagesError(err error) bool {
	return isOpenAIResponsesUnsupportedCapabilityError(
		err,
		"images",
		"image input",
		"input_image",
		"image_url",
		"vision",
	)
}

func isOpenAIResponsesUnsupportedCapabilityError(err error, capabilityTerms ...string) bool {
	if err == nil {
		return false
	}

	message := strings.ToLower(err.Error())
	if !strings.Contains(message, "(http 400)") && !strings.Contains(message, "(http 422)") {
		return false
	}

	for _, term := range capabilityTerms {
		if isExplicitlyUnsupportedCapability(message, term) {
			return true
		}
	}
	return false
}

var unsupportedCapabilityPrefixes = []string{
	"unsupported",
	"unsupported parameter",
	"unsupported field",
	"not supported",
	"does not support",
	"doesn't support",
	"unknown parameter",
	"unknown_parameter",
	"unknown field",
	"unrecognized parameter",
	"unrecognised parameter",
	"unrecognized field",
	"unrecognised field",
	"unexpected parameter",
	"unexpected field",
	"not permitted",
	"not allowed",
	"not available",
	"not enabled",
}

var unsupportedCapabilitySuffixes = []string{
	"unsupported",
	"is unsupported",
	"are unsupported",
	"not supported",
	"is not supported",
	"are not supported",
	"not permitted",
	"is not permitted",
	"are not permitted",
	"not allowed",
	"is not allowed",
	"are not allowed",
	"not available",
	"is not available",
	"are not available",
	"unavailable",
	"is unavailable",
	"are unavailable",
	"not enabled",
	"is not enabled",
	"are not enabled",
}

func isExplicitlyUnsupportedCapability(message, capabilityTerm string) bool {
	term := strings.ToLower(strings.TrimSpace(capabilityTerm))
	if term == "" {
		return false
	}

	for searchFrom := 0; searchFrom < len(message); {
		relativeIndex := strings.Index(message[searchFrom:], term)
		if relativeIndex < 0 {
			return false
		}
		termStart := searchFrom + relativeIndex
		termEnd := termStart + len(term)
		searchFrom = termEnd

		if !isCapabilityTermBoundary(message, termStart, termEnd) || isNestedCapabilityPath(message, termEnd) {
			continue
		}

		prefixWords := normalizedErrorWords(message[:termStart])
		suffixWords := normalizedErrorWords(message[termEnd:])
		if matchesNormalizedSuffix(prefixWords, unsupportedCapabilityPrefixes) ||
			matchesNormalizedPrefix(suffixWords, unsupportedCapabilitySuffixes) {
			return true
		}
	}
	return false
}

func isCapabilityTermBoundary(message string, start, end int) bool {
	if start > 0 {
		previous := rune(message[start-1])
		if unicode.IsLetter(previous) || unicode.IsDigit(previous) || previous == '_' {
			return false
		}
	}
	if end < len(message) {
		next := rune(message[end])
		if unicode.IsLetter(next) || unicode.IsDigit(next) || next == '_' {
			return false
		}
	}
	return true
}

func isNestedCapabilityPath(message string, termEnd int) bool {
	if termEnd >= len(message) {
		return false
	}
	remainder := strings.TrimLeftFunc(message[termEnd:], unicode.IsSpace)
	if remainder == "" {
		return false
	}
	if remainder[0] == '[' {
		return true
	}
	// JSON Pointer paths may identify nested schema fields as tools/0/... or
	// #/tools/0/.... These describe one tool's schema rather than the top-level
	// tools capability and must not trigger a retry with all tools removed.
	if remainder[0] == '/' {
		return true
	}
	return remainder[0] == '.' && len(remainder) > 1 &&
		(unicode.IsLetter(rune(remainder[1])) || unicode.IsDigit(rune(remainder[1])))
}

func normalizedErrorWords(value string) []string {
	return strings.FieldsFunc(strings.ToLower(value), func(char rune) bool {
		return !unicode.IsLetter(char) && !unicode.IsDigit(char)
	})
}

func matchesNormalizedSuffix(words []string, candidates []string) bool {
	for _, candidate := range candidates {
		candidateWords := normalizedErrorWords(candidate)
		if len(candidateWords) > len(words) {
			continue
		}
		if strings.Join(words[len(words)-len(candidateWords):], " ") == strings.Join(candidateWords, " ") {
			return true
		}
	}
	return false
}

func matchesNormalizedPrefix(words []string, candidates []string) bool {
	for _, candidate := range candidates {
		candidateWords := normalizedErrorWords(candidate)
		if len(candidateWords) > len(words) {
			continue
		}
		if strings.Join(words[:len(candidateWords)], " ") == strings.Join(candidateWords, " ") {
			return true
		}
	}
	return false
}

func openAIResponsesErrorBodyReadTimeout(client *http.Client) time.Duration {
	if client != nil && client.Timeout > 0 {
		return client.Timeout
	}
	return openAIHTTPTimeout
}

func readOpenAIResponsesStreamingErrorBody(body io.ReadCloser, contentLength int64, timeout time.Duration) string {
	if timeout <= 0 {
		return readProviderErrorBody(body, contentLength)
	}

	timedOut := make(chan struct{})
	timer := time.AfterFunc(timeout, func() {
		_ = body.Close()
		close(timedOut)
	})
	detail := readProviderErrorBody(body, contentLength)
	if timer.Stop() {
		return detail
	}

	// Stop returning false means the callback is already scheduled. Wait until
	// it marks the timeout before reporting it, so the result is deterministic
	// even when the body finishes at the same instant as the timer.
	<-timedOut
	return fmt.Sprintf("[error response body read timed out after %s]", timeout)
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

	resp, err := openAIResponsesHTTPClientForRequest(p.client, body.Stream).Do(httpReq)
	if err != nil {
		logAIUpstreamRequestFinish(requestLog, 0, err)
		return nil, fmt.Errorf("request to %s failed: %w", endpoint, err)
	}
	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		errorDetail := ""
		if body.Stream {
			errorDetail = readOpenAIResponsesStreamingErrorBody(
				resp.Body,
				resp.ContentLength,
				openAIResponsesErrorBodyReadTimeout(p.client),
			)
		} else {
			errorDetail = readProviderErrorBody(resp.Body, resp.ContentLength)
		}
		statusErr := fmt.Errorf("OpenAI Responses API returned error (HTTP %d): %s", resp.StatusCode, errorDetail)
		logAIUpstreamRequestFinish(requestLog, resp.StatusCode, statusErr)
		return nil, statusErr
	}

	logAIUpstreamRequestFinish(requestLog, resp.StatusCode, nil)
	return resp.Body, nil
}
