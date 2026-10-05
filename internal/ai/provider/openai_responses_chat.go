package provider

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"GoNavi-Wails/internal/ai"
)

func (p *OpenAIResponsesProvider) Chat(ctx context.Context, req ai.ChatRequest) (*ai.ChatResponse, error) {
	response, _, err := p.ChatWithState(ctx, nil, req)
	return response, err
}

func (p *OpenAIResponsesProvider) ChatWithState(
	ctx context.Context,
	state json.RawMessage,
	req ai.ChatRequest,
) (*ai.ChatResponse, json.RawMessage, error) {
	response, next, err := p.chatWithState(ctx, state, req)
	return response, next, outputLimitErrorForRequest(err, req)
}

func (p *OpenAIResponsesProvider) chatWithState(
	ctx context.Context,
	state json.RawMessage,
	req ai.ChatRequest,
) (*ai.ChatResponse, json.RawMessage, error) {
	if err := p.Validate(); err != nil {
		return nil, state, err
	}

	requestMessages := prepareOpenAIRequestMessagesForRequest(
		req.Messages,
		p.config.Model,
		p.baseURL,
		req.ImageFallbackPrompt,
		req.ImageOmittedNotice,
	)
	body := p.buildRequest(req, false)
	if len(state) > 0 {
		previous, ok := decodeOpenAIResponsesSessionState(state)
		if !ok {
			return nil, state, fmt.Errorf("parse OpenAI Responses session state failed")
		}
		requestMessages = normalizeToolCallHistoryForResponsesWithSession(requestMessages, responsesSessionToolCallIDs(previous.Input))
		body.Input = mergeOpenAIResponsesSessionInput(previous.Input, requestMessages, p.baseURL, previous.MessageFingerprints)
	} else {
		requestMessages = normalizeToolCallHistoryForResponses(requestMessages)
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
	representedMessages := appendOpenAIResponsesAssistantMessage(requestMessages, response)
	nextState, err := encodeOpenAIResponsesSessionState(body.Input, result.Output, representedMessages)
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
	next, err := p.chatStreamWithState(ctx, state, req, callback)
	return next, outputLimitErrorForRequest(err, req)
}

// outputLimitErrorForRequest keeps the typed truncation error only for callers
// that asked for it (agent runs that can continue). Everyone else keeps the
// plain error text they always got.
func outputLimitErrorForRequest(err error, req ai.ChatRequest) error {
	var limit *ai.OutputLimitError
	if err != nil && !req.ReportOutputLimit && errors.As(err, &limit) {
		return errors.New(limit.Message)
	}
	return err
}

func (p *OpenAIResponsesProvider) chatStreamWithState(
	ctx context.Context,
	state json.RawMessage,
	req ai.ChatRequest,
	callback func(ai.StreamChunk),
) (json.RawMessage, error) {
	if err := p.Validate(); err != nil {
		return state, err
	}

	requestMessages := prepareOpenAIRequestMessagesForRequest(
		req.Messages,
		p.config.Model,
		p.baseURL,
		req.ImageFallbackPrompt,
		req.ImageOmittedNotice,
	)
	body := p.buildRequest(req, true)
	if len(state) > 0 {
		previous, ok := decodeOpenAIResponsesSessionState(state)
		if !ok {
			return state, fmt.Errorf("parse OpenAI Responses session state failed")
		}
		requestMessages = normalizeToolCallHistoryForResponsesWithSession(requestMessages, responsesSessionToolCallIDs(previous.Input))
		body.Input = mergeOpenAIResponsesSessionInput(previous.Input, requestMessages, p.baseURL, previous.MessageFingerprints)
	} else {
		requestMessages = normalizeToolCallHistoryForResponses(requestMessages)
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
	var streamedContent strings.Builder
	var streamedReasoning strings.Builder
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
				streamedContent.WriteString(event.Delta)
				callback(ai.StreamChunk{Content: event.Delta})
			}
		case "response.reasoning_summary_part.added":
			// Parts of one summary are separate nodes; keep a blank line between them.
			if event.SummaryIndex > 0 && streamedReasoning.Len() > 0 {
				streamedReasoning.WriteString(reasoningSummaryPartSeparator)
				callback(ai.StreamChunk{Thinking: reasoningSummaryPartSeparator, ReasoningContent: reasoningSummaryPartSeparator})
			}
		case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
			if event.Delta != "" {
				receivedReasoning = true
				streamedReasoning.WriteString(event.Delta)
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
				streamedContent.WriteString(completed.Content)
				callback(ai.StreamChunk{Content: completed.Content})
			}
			if !receivedReasoning && completed.ReasoningContent != "" {
				receivedReasoning = true
				streamedReasoning.WriteString(completed.ReasoningContent)
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
			var streamUsage *ai.TokenUsage
			if event.Response.Usage != nil {
				usage := completed.TokensUsed
				streamUsage = &usage
			}
			if len(event.Response.Output) == 0 {
				callback(ai.StreamChunk{Done: true, Usage: streamUsage})
				return nil, nil
			}
			representedMessages := appendOpenAIResponsesAssistantMessage(requestMessages, &ai.ChatResponse{
				Content:          streamedContent.String(),
				ReasoningContent: streamedReasoning.String(),
				ToolCalls:        toolCalls,
			})
			nextState, err := encodeOpenAIResponsesSessionState(body.Input, event.Response.Output, representedMessages)
			if err != nil {
				return state, err
			}
			callback(ai.StreamChunk{Done: true, Usage: streamUsage})
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
		case body.implicitMaxOutputTokens && body.MaxOutputTokens > 0 && isOutputTokenLimitRejection(err):
			// 默认填的上限超过了该模型的能力：用上游报错里给出的上限重试；
			// 报错里没有可用数字就不再发送上限，交给上游自己的默认值。
			capValue, _ := outputTokenCapFromRejection(err, body.MaxOutputTokens)
			rememberOutputTokenCap(p.baseURL, p.config.Model, capValue)
			body.MaxOutputTokens = capValue
			body.implicitMaxOutputTokens = false
			fmt.Printf("[OpenAI Responses] 默认输出上限被上游拒绝，改用 %d 重试（0 表示不发送上限）\n", capValue)
		case downgradeUnsupportedReasoningSummary(&body, err):
			fmt.Println("[OpenAI Responses] 上游不支持 detailed 推理摘要，自动降级为 auto")
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
