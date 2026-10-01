package provider

import (
	"strings"

	"GoNavi-Wails/internal/ai"
)

// openAIResponsesRequestMaxOutputTokens resolves the per-turn output budget.
//
// The policy is "no limit by default" (see output_token_budget.go): an explicit
// positive request/config value is sent as-is, otherwise nothing is sent and
// the model uses its own maximum. Native DeepSeek endpoints are the exception:
// omitting the field there means only 8K/64K, so the documented maximum is
// sent explicitly. A cap learned from an earlier rejection takes precedence
// over that default.
func openAIResponsesRequestMaxOutputTokens(model, baseURL string, requestMaxTokens, configuredMaxTokens int) int {
	if explicit, ok := explicitOutputTokens(requestMaxTokens, configuredMaxTokens); ok {
		return explicit
	}
	if learned, ok := learnedOutputTokenCap(baseURL, model); ok {
		return learned
	}
	if isDeepSeekResponsesBaseURL(baseURL) {
		return deepSeekMaxOutputTokens
	}
	return 0
}

// openAIResponsesRequestReasoning maps the persisted thinking preference to a
// Responses reasoning object. DeepSeek-compatible endpoints enable thinking
// when the field is omitted, so an explicit off selection must be represented
// as effort=none even when a gateway hides the DeepSeek hostname.
func openAIResponsesRequestReasoning(model, baseURL, rawIntensity string) *openAIResponsesReasoning {
	intensity := NormalizeThinkingIntensity(rawIntensity)
	if intensity == "" {
		return nil
	}

	effort := openAIReasoningEffort(intensity)
	if effort == "" && intensity == ai.ThinkingIntensityOff &&
		(isDeepSeekResponsesBaseURL(baseURL) || openAIResponsesReasoningModel(model)) {
		effort = "none"
	}
	if effort == "" {
		return nil
	}

	reasoning := &openAIResponsesReasoning{Effort: effort}
	if !isDeepSeekResponsesBaseURL(baseURL) && !strings.Contains(strings.ToLower(model), "deepseek") {
		// Ask for the detailed summary so each reasoning node comes with its own
		// explanation; a gateway that rejects it is retried with "auto".
		reasoning.Summary = reasoningSummaryDetailed
	}
	return reasoning
}
