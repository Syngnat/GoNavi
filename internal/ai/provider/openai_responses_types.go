package provider

import (
	"encoding/json"
	"strings"
)

type openAIResponsesRequest struct {
	Model           string            `json:"model"`
	Input           []json.RawMessage `json:"input"`
	Temperature     float64           `json:"temperature,omitempty"`
	MaxOutputTokens int               `json:"max_output_tokens,omitempty"`
	// implicitMaxOutputTokens 标记 MaxOutputTokens 是默认值而非用户显式给的；
	// 只有默认值被上游拒绝时才允许自动调整，显式值从不改写。
	implicitMaxOutputTokens bool
	Stream                  bool                      `json:"stream"`
	Store                   *bool                     `json:"store,omitempty"`
	Include                 []string                  `json:"include,omitempty"`
	Tools                   []openAIResponsesTool     `json:"tools,omitempty"`
	Reasoning               *openAIResponsesReasoning `json:"reasoning,omitempty"`
}

type openAIResponsesSessionState struct {
	Input               []json.RawMessage `json:"input"`
	MessageFingerprints []string          `json:"message_fingerprints,omitempty"`
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
	ID                string                `json:"id"`
	Status            string                `json:"status,omitempty"`
	Output            []json.RawMessage     `json:"output"`
	Usage             *openAIResponsesUsage `json:"usage,omitempty"`
	Error             *openAIResponsesError `json:"error,omitempty"`
	IncompleteDetails *struct {
		Reason string `json:"reason,omitempty"`
	} `json:"incomplete_details,omitempty"`
}

type openAIResponsesUsage struct {
	InputTokens       int `json:"input_tokens"`
	OutputTokens      int `json:"output_tokens"`
	TotalTokens       int `json:"total_tokens"`
	InputTokenDetails *struct {
		CachedTokens int `json:"cached_tokens"`
	} `json:"input_tokens_details,omitempty"`
}

type openAIResponsesStreamEvent struct {
	Type         string                    `json:"type"`
	Code         string                    `json:"code,omitempty"`
	Message      string                    `json:"message,omitempty"`
	Delta        string                    `json:"delta,omitempty"`
	Arguments    string                    `json:"arguments,omitempty"`
	Name         string                    `json:"name,omitempty"`
	OutputIndex  int                       `json:"output_index,omitempty"`
	SummaryIndex int                       `json:"summary_index,omitempty"`
	Item         openAIResponsesOutputItem `json:"item,omitempty"`
	Response     openAIResponsesResponse   `json:"response,omitempty"`
	Error        json.RawMessage           `json:"error,omitempty"`
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
