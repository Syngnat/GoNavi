package provider

import "strings"

const (
	reasoningSummaryAuto     = "auto"
	reasoningSummaryDetailed = "detailed"
	// reasoningSummaryPartSeparator keeps the parts of one reasoning summary
	// apart, so a UI can show each part as its own node.
	reasoningSummaryPartSeparator = "\n\n"
)

// writeReasoningSummaryPart appends one summary part, separated from the
// previous one by a blank line.
func writeReasoningSummaryPart(builder *strings.Builder, text string) {
	if builder.Len() > 0 {
		builder.WriteString(reasoningSummaryPartSeparator)
	}
	builder.WriteString(text)
}

// downgradeUnsupportedReasoningSummary retries with the plain "auto" summary
// when a gateway rejects the "detailed" one. It reports whether it changed the
// request.
func downgradeUnsupportedReasoningSummary(body *openAIResponsesRequest, err error) bool {
	if body.Reasoning == nil || body.Reasoning.Summary != reasoningSummaryDetailed {
		return false
	}
	if !isOpenAIResponsesUnsupportedCapabilityError(err, "reasoning.summary", "summary") {
		return false
	}
	body.Reasoning.Summary = reasoningSummaryAuto
	return true
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
