package provider

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/ai"
)

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

func openAIResponsesMessageFingerprint(message ai.Message) string {
	encoded, err := json.Marshal(message)
	if err != nil {
		encoded = []byte(fmt.Sprintf("%s\x00%s\x00%s", message.Role, message.ToolCallID, message.Content))
	}
	return fmt.Sprintf("%x", sha256.Sum256(encoded))
}

func openAIResponsesMessageFingerprints(messages []ai.Message) []string {
	if len(messages) == 0 {
		return nil
	}
	fingerprints := make([]string, 0, len(messages))
	for _, message := range messages {
		fingerprints = append(fingerprints, openAIResponsesMessageFingerprint(message))
	}
	return fingerprints
}

func filterOpenAIResponsesUnrepresentedMessages(messages []ai.Message, represented []string) []ai.Message {
	if len(messages) == 0 || len(represented) == 0 {
		return messages
	}
	remaining := make(map[string]int, len(represented))
	for _, fingerprint := range represented {
		remaining[fingerprint]++
	}
	result := make([]ai.Message, 0, len(messages))
	for _, message := range messages {
		fingerprint := openAIResponsesMessageFingerprint(message)
		if remaining[fingerprint] > 0 {
			remaining[fingerprint]--
			continue
		}
		result = append(result, message)
	}
	return result
}

func appendOpenAIResponsesAssistantMessage(messages []ai.Message, response *ai.ChatResponse) []ai.Message {
	result := append([]ai.Message(nil), messages...)
	if response == nil || (response.Content == "" && response.ReasoningContent == "" && len(response.ToolCalls) == 0) {
		return result
	}
	result = append(result, ai.Message{
		Role:             "assistant",
		Content:          response.Content,
		ReasoningContent: response.ReasoningContent,
		ToolCalls:        append([]ai.ToolCall(nil), response.ToolCalls...),
	})
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
	decoded.MessageFingerprints = append([]string(nil), decoded.MessageFingerprints...)
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

func responsesSessionToolOutputIDs(items []json.RawMessage) map[string]struct{} {
	ids := make(map[string]struct{})
	for _, rawItem := range items {
		var item struct {
			Type   string `json:"type"`
			CallID string `json:"call_id"`
		}
		if err := json.Unmarshal(rawItem, &item); err != nil || item.Type != "function_call_output" {
			continue
		}
		if id := strings.TrimSpace(item.CallID); id != "" {
			ids[id] = struct{}{}
		}
	}
	return ids
}

// mergeOpenAIResponsesSessionInput appends only the transcript delta that is
// not already represented by the opaque Responses state. The tool-item guard
// also repairs legacy states created before message fingerprints were stored:
// when a completed tool result is present, it is moved directly after the
// outstanding function-call items and duplicate calls/results are discarded.
func mergeOpenAIResponsesSessionInput(previousInput []json.RawMessage, messages []ai.Message, baseURL string, represented []string) []json.RawMessage {
	previous := canonicalizeOpenAIResponsesFunctionCallsForInput(previousInput)
	toolCallIDs := responsesSessionToolCallIDs(previous)
	toolOutputIDs := responsesSessionToolOutputIDs(previous)
	deltaMessages := filterOpenAIResponsesUnrepresentedMessages(messages, represented)
	delta := marshalOpenAIResponsesInput(buildOpenAIResponsesInputWithToolCallIDs(deltaMessages, baseURL, toolCallIDs))

	firstOutstandingOutput := -1
	for index, rawItem := range delta {
		var item struct {
			Type   string `json:"type"`
			CallID string `json:"call_id"`
		}
		if json.Unmarshal(rawItem, &item) != nil || item.Type != "function_call_output" {
			continue
		}
		callID := strings.TrimSpace(item.CallID)
		_, knownCall := toolCallIDs[callID]
		_, alreadyCompleted := toolOutputIDs[callID]
		if knownCall && !alreadyCompleted {
			firstOutstandingOutput = index
			break
		}
	}
	if firstOutstandingOutput >= 0 {
		delta = delta[firstOutstandingOutput:]
	}

	filtered := make([]json.RawMessage, 0, len(delta))
	for _, rawItem := range delta {
		var item struct {
			Type   string `json:"type"`
			CallID string `json:"call_id"`
		}
		if json.Unmarshal(rawItem, &item) == nil {
			callID := strings.TrimSpace(item.CallID)
			if item.Type == "function_call" {
				if _, exists := toolCallIDs[callID]; exists {
					continue
				}
			}
			if item.Type == "function_call_output" {
				if _, exists := toolOutputIDs[callID]; exists {
					continue
				}
			}
		}
		filtered = append(filtered, append(json.RawMessage(nil), rawItem...))
	}

	return append(previous, filtered...)
}

func encodeOpenAIResponsesSessionState(input []json.RawMessage, output []json.RawMessage, representedMessages []ai.Message) (json.RawMessage, error) {
	combined := make([]json.RawMessage, 0, len(input)+len(output))
	combined = append(combined, cloneOpenAIResponsesRawItems(input)...)
	combined = append(combined, cloneOpenAIResponsesRawItems(output)...)
	combined = canonicalizeOpenAIResponsesFunctionCallsForInput(combined)
	encoded, err := json.Marshal(openAIResponsesSessionState{
		Input:               combined,
		MessageFingerprints: openAIResponsesMessageFingerprints(representedMessages),
	})
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
	body := openAIResponsesRequest{
		Model:           p.config.Model,
		Input:           marshalOpenAIResponsesInput(buildOpenAIResponsesInput(requestMessages, p.baseURL)),
		Temperature:     temperature,
		MaxOutputTokens: openAIResponsesRequestMaxOutputTokens(p.config.Model, p.baseURL, req.MaxTokens, p.config.MaxTokens),
		Stream:          stream,
		Tools:           buildOpenAIResponsesTools(req.Tools),
		Reasoning:       openAIResponsesRequestReasoning(p.config.Model, p.baseURL, p.config.ThinkingIntensity),
	}
	_, explicit := explicitOutputTokens(req.MaxTokens, p.config.MaxTokens)
	body.implicitMaxOutputTokens = !explicit && body.MaxOutputTokens > 0
	if !isDeepSeekResponsesBaseURL(p.baseURL) {
		body.Store = boolPointer(false)
	}
	if !isDeepSeekResponsesBaseURL(p.baseURL) {
		body.Include = []string{"reasoning.encrypted_content"}
	}
	return body
}
