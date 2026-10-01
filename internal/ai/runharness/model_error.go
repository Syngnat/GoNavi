package runharness

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"regexp"
	"strconv"
	"strings"
)

// Model error classes are part of the run event contract. Keep these values
// stable: desktop and CLI clients use them to decide whether a run can be
// retried or needs user action.
const (
	ModelErrorCanceled          = "canceled"
	ModelErrorDeadline          = "deadline"
	ModelErrorTransport         = "transport"
	ModelErrorRateLimit         = "rate_limit"
	ModelErrorProvider          = "provider"
	ModelErrorProtocol          = "protocol"
	ModelErrorMalformedToolCall = "malformed_tool_call"
	// ModelErrorOutputLimit：连续多次被输出长度上限截断，自动续写仍无法完成。
	ModelErrorOutputLimit = "output_limit"
)

var (
	// Provider implementations currently expose HTTP status in their error
	// text. Accept both the canonical "HTTP 503" form and common status/code
	// forms so adapters do not need to import provider-specific error types.
	modelHTTPStatusPattern = regexp.MustCompile(`(?i)(?:\bhttp(?:/\d(?:\.\d+)?)?\s*[\(:= ]|\bstatus(?:[_ ]?code)?\s*["']?\s*[:= ]|\bcode\s*["']?\s*[:= ])\s*([1-5]\d{2})\b`)

	modelDeadlineMarkers = []string{
		"context deadline exceeded",
		"deadline exceeded",
		"client.timeout",
		"client timeout",
		"i/o timeout",
		"timed out",
		"timeout while",
	}

	modelCanceledMarkers = []string{
		"context canceled",
		"context cancelled",
		"request canceled",
		"request cancelled",
	}

	modelProtocolMarkers = []string{
		"stream ended before",
		"stream ended unexpectedly",
		"response incomplete",
		"incomplete response",
		"returned empty response",
		"empty response",
		"parse response failed",
		"parse openai response failed",
		"parse anthropic response failed",
		"parse gemini response failed",
		"malformed response",
		"invalid response",
	}

	modelTransportMarkers = []string{
		"connection reset",
		"connection refused",
		"connection aborted",
		"broken pipe",
		"unexpected eof",
		"network is unreachable",
		"no route to host",
		"no such host",
		"temporary failure in name resolution",
		"tls handshake",
		"transport error",
		"transport failed",
		"stream transport",
		"streaming response failed",
		"stream response failed",
		// Cursor and a few other legacy adapters report a transport failure as
		// "stream request failed". Keep the stream qualifier: a bare
		// "request failed" is also the fallback text for a provider-side
		// response.failed event and must remain non-retryable.
		"stream request failed",
		"streaming request failed",
	}

	modelRateLimitMarkers = []string{
		"rate limit",
		"rate_limit",
		"too many requests",
		"throttl",
		"quota exceeded",
	}
)

// ClassifyModelError exposes the same stable classification used by the
// harness internally. It is useful to non-UI adapters that need to render a
// consistent error code without duplicating provider string parsing.
func ClassifyModelError(err error) string {
	return classifyError(err)
}

// IsRetryableModelError reports whether a failed model turn is safe for the
// harness to retry automatically. A model turn may have emitted deltas before
// failing; callers must still apply their run/tool commit fence separately.
func IsRetryableModelError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	if errors.Is(err, ErrMalformedToolCall) {
		return false
	}

	class := classifyError(err)
	switch class {
	case ModelErrorRateLimit:
		return true
	case ModelErrorTransport:
		status := modelHTTPStatus(err.Error())
		// A 5xx response is not automatically transient. Retry the statuses
		// conventionally used for an overloaded/unavailable upstream only.
		if status != 0 {
			return isTemporaryHTTPStatus(status)
		}
		return true
	default:
		return false
	}
}

func isTemporaryHTTPStatus(status int) bool {
	switch status {
	case 500, 502, 503, 504, 521, 522, 523, 524, 525, 526:
		return true
	default:
		return false
	}
}

func modelHTTPStatus(message string) int {
	match := modelHTTPStatusPattern.FindStringSubmatch(message)
	if len(match) != 2 {
		return 0
	}
	status, err := strconv.Atoi(match[1])
	if err != nil {
		return 0
	}
	return status
}

func containsAnyMarker(message string, markers []string) bool {
	for _, marker := range markers {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}

// classifyError deliberately keeps provider-specific details out of the
// public contract. Errors are inspected from most authoritative to least:
// context/sentinel errors, structured harness errors, HTTP status, then the
// conservative textual fallbacks needed for legacy providers.
func classifyError(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, context.Canceled) {
		return ModelErrorCanceled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return ModelErrorDeadline
	}
	if errors.Is(err, ErrMalformedToolCall) {
		return ModelErrorMalformedToolCall
	}

	message := strings.ToLower(strings.TrimSpace(err.Error()))
	if message == "" {
		return ModelErrorProvider
	}
	if containsAnyMarker(message, modelCanceledMarkers) {
		return ModelErrorCanceled
	}
	if containsAnyMarker(message, modelDeadlineMarkers) {
		return ModelErrorDeadline
	}

	// net.Error is more reliable than matching a localized network message.
	// Timeout errors are classified as deadline because the run policy owns
	// their cancellation and explicitly excludes deadline retries.
	var networkErr net.Error
	if errors.As(err, &networkErr) {
		if networkErr.Timeout() {
			return ModelErrorDeadline
		}
		return ModelErrorTransport
	}

	if status := modelHTTPStatus(message); status != 0 {
		if status == 429 {
			return ModelErrorRateLimit
		}
		if status >= 500 && status <= 599 {
			return ModelErrorTransport
		}
		return ModelErrorProvider
	}
	if containsAnyMarker(message, modelRateLimitMarkers) {
		return ModelErrorRateLimit
	}
	if containsAnyMarker(message, modelProtocolMarkers) {
		return ModelErrorProtocol
	}
	// An unexpected EOF while reading an HTTP/SSE body is a broken transport and
	// is safe for the harness's one-shot retry. A clean EOF without the
	// provider's completed marker is a protocol violation instead.
	if errors.Is(err, io.ErrUnexpectedEOF) {
		return ModelErrorTransport
	}
	if errors.Is(err, io.EOF) {
		return ModelErrorProtocol
	}
	var syntaxErr *json.SyntaxError
	if errors.As(err, &syntaxErr) {
		return ModelErrorProtocol
	}
	if containsAnyMarker(message, modelTransportMarkers) {
		return ModelErrorTransport
	}
	return ModelErrorProvider
}

func retryableModelErrorCode(code string) bool {
	switch strings.TrimSpace(code) {
	case ModelErrorTransport, ModelErrorRateLimit:
		return true
	default:
		return false
	}
}

// maxOutputContinuations 是同一段对话里连续自动续写的最大次数。
const maxOutputContinuations = 3

var errOutputContinuationsExhausted = errors.New("model output was cut off by the output length limit repeatedly; the reply could not be completed")

// outputContinuationPrompt 是截断后追加给模型的提示。用自然语言而不是结构化 JSON：
// 它要真正被模型读懂并照做。droppedToolCall 表示被截断的那一轮里有一次工具调用被丢弃。
func outputContinuationPrompt(droppedToolCall bool) string {
	if droppedToolCall {
		return "Your previous reply was cut off by the output length limit while you were writing a tool call, " +
			"so that call was discarded and NOT executed. Redo the work in smaller pieces " +
			"(split the task into steps and keep each tool call's arguments short), then call the tool again."
	}
	return "Your previous reply was cut off by the output length limit. " +
		"Resume directly where it stopped - no apology and no recap of what was already written."
}

// malformedToolCallRepairPrompt 是工具调用被 harness 拒绝（参数不是合法 JSON、工具不存在等）
// 后追加给模型的提示。带上具体原因，模型才知道该改哪里；机器可读的错误码
// malformed_tool_call 仍放在消息元数据里，事件与外部客户端依赖它。
func malformedToolCallRepairPrompt(reason error) string {
	return "Your previous tool call could not be executed and nothing was run: " + reason.Error() +
		". Send the tool call again using a tool from the provided list and valid JSON arguments that match its input schema."
}
