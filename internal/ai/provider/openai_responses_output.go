package provider

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/ai"
)

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
					writeReasoningSummaryPart(&reasoning, part.Text)
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

	usage := ai.TokenUsage{}
	if result.Usage != nil {
		usage = ai.TokenUsage{
			PromptTokens:     result.Usage.InputTokens,
			CompletionTokens: result.Usage.OutputTokens,
			TotalTokens:      result.Usage.TotalTokens,
		}
		if result.Usage.InputTokenDetails != nil {
			cached := result.Usage.InputTokenDetails.CachedTokens
			usage.CachedTokens = &cached
		}
	}
	return &ai.ChatResponse{
		Content:          content.String(),
		ReasoningContent: reasoning.String(),
		ToolCalls:        toolCalls,
		TokensUsed:       usage,
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
	message := fmt.Sprintf("OpenAI Responses response incomplete: %s", reason)
	if strings.EqualFold(reason, "max_output_tokens") {
		return &ai.OutputLimitError{Message: message}
	}
	return errors.New(message)
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
