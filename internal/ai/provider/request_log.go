package provider

import (
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/logger"
)

const (
	aiUpstreamStringPreviewLimit = 4096
	aiUpstreamBodyPreviewLimit   = 24000
	// aiUpstreamCLIOutputLogLimit 限制失败日志保留的 CLI 原始输出长度。
	aiUpstreamCLIOutputLogLimit = 4096
)

var (
	secretLikeValuePatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)bearer\s+[a-z0-9._~+/=-]{8,}`),
		regexp.MustCompile(`(?i)\bsk-[a-z0-9._-]{8,}`),
		regexp.MustCompile(`(?i)\bgh[pousr]_[a-z0-9_]{8,}`),
		regexp.MustCompile(`(?i)\b(xox[baprs]-[a-z0-9-]{8,})`),
	}
	dataURIValuePattern = regexp.MustCompile(`^data:([^;,]+);base64,`)
)

type aiUpstreamRequestLogHandle struct {
	id       string
	provider string
	started  time.Time
	endpoint string
}

func newAIUpstreamRequestLogID(providerName string) string {
	normalized := strings.ToLower(strings.TrimSpace(providerName))
	normalized = regexp.MustCompile(`[^a-z0-9]+`).ReplaceAllString(normalized, "-")
	normalized = strings.Trim(normalized, "-")
	if normalized == "" {
		normalized = "provider"
	}
	return fmt.Sprintf("%s-%d", normalized, time.Now().UnixNano())
}

func logAIUpstreamRequestStart(providerName string, method string, endpoint string, body any) aiUpstreamRequestLogHandle {
	handle := aiUpstreamRequestLogHandle{
		id:       newAIUpstreamRequestLogID(providerName),
		provider: strings.TrimSpace(providerName),
		started:  time.Now(),
		endpoint: sanitizeAIUpstreamURL(endpoint),
	}
	logger.Infof(
		"AI 上游请求开始：requestId=%s provider=%s method=%s endpoint=%s body=%s",
		handle.id,
		handle.provider,
		strings.TrimSpace(method),
		handle.endpoint,
		formatAIUpstreamRequestLogBody(body),
	)
	return handle
}

func logAIUpstreamRequestFinish(handle aiUpstreamRequestLogHandle, statusCode int, err error) {
	duration := time.Since(handle.started).Round(time.Millisecond)
	if err != nil {
		logger.Warnf(
			"AI 上游请求失败：requestId=%s provider=%s endpoint=%s duration=%s err=%v",
			handle.id,
			handle.provider,
			handle.endpoint,
			duration,
			RedactAIUpstreamLogText(err.Error()),
		)
		return
	}
	if statusCode > 0 {
		logger.Infof(
			"AI 上游请求完成：requestId=%s provider=%s endpoint=%s status=%d duration=%s",
			handle.id,
			handle.provider,
			handle.endpoint,
			statusCode,
			duration,
		)
		return
	}
	logger.Infof(
		"AI 上游请求完成：requestId=%s provider=%s endpoint=%s duration=%s",
		handle.id,
		handle.provider,
		handle.endpoint,
		duration,
	)
}

// logAIUpstreamCLIOutput 在本地 CLI 调用失败时保留其原始输出。
// 失败详情可能只是一个协议词（例如 stopReason 枚举 "cancelled"），
// 没有原始输出就没有诊断现场，因此失败日志必须带走完整输出（截断+脱敏）。
func logAIUpstreamCLIOutput(handle aiUpstreamRequestLogHandle, output string) {
	if formatted := formatAIUpstreamCLIOutputLog(output); formatted != "" {
		logger.Warnf("AI 上游 CLI 原始输出：requestId=%s output=%s", handle.id, formatted)
	}
}

// formatAIUpstreamCLIOutputLog 截断并脱敏 CLI 原始输出；空输出返回空串，
// 由调用方跳过日志。先截断再脱敏：RedactAIUpstreamLogText 内部对超过
// aiUpstreamStringPreviewLimit 的文本还会再截一次并追加自己的标记，
// 把超长文本压回阈值内可避免两条截断标记叠加。
func formatAIUpstreamCLIOutputLog(output string) string {
	trimmed := strings.TrimSpace(output)
	if trimmed == "" {
		return ""
	}
	truncatedChars := 0
	text := trimmed
	if len(text) > aiUpstreamCLIOutputLogLimit {
		text = text[:aiUpstreamCLIOutputLogLimit]
		truncatedChars = len(trimmed) - aiUpstreamCLIOutputLogLimit
	}
	text = RedactAIUpstreamLogText(text)
	if truncatedChars > 0 {
		text += fmt.Sprintf("...[truncated %d chars]", truncatedChars)
	}
	return text
}

func formatAIUpstreamRequestLogBody(body any) string {
	sanitized := sanitizeAIUpstreamLogValue(body)
	bytes, err := json.Marshal(sanitized)
	if err != nil {
		return fmt.Sprintf(`{"marshalError":%q}`, err.Error())
	}
	text := string(bytes)
	if len(text) <= aiUpstreamBodyPreviewLimit {
		return text
	}
	return fmt.Sprintf("%s...[truncated %d chars]", text[:aiUpstreamBodyPreviewLimit], len(text)-aiUpstreamBodyPreviewLimit)
}

func RedactAIUpstreamLogText(value string) string {
	return sanitizeAIUpstreamString(value)
}

func sanitizeAIUpstreamURL(rawURL string) string {
	text := strings.TrimSpace(rawURL)
	if text == "" {
		return ""
	}
	parsed, err := url.Parse(text)
	if err != nil {
		return redactSecretLikeString(text)
	}
	query := parsed.Query()
	for key := range query {
		if isSensitiveFieldName(key) {
			query.Set(key, "[REDACTED]")
		}
	}
	parsed.RawQuery = query.Encode()
	return redactSecretLikeString(parsed.String())
}

func sanitizeAIUpstreamLogValue(value any) any {
	switch typed := value.(type) {
	case nil:
		return nil
	case bool, float32, float64,
		int, int8, int16, int32, int64,
		uint, uint8, uint16, uint32, uint64:
		return typed
	case json.Number:
		return typed
	case json.RawMessage:
		var decoded any
		if err := json.Unmarshal(typed, &decoded); err == nil {
			return sanitizeAIUpstreamLogValue(decoded)
		}
		return sanitizeAIUpstreamString(string(typed))
	case []byte:
		return sanitizeAIUpstreamString(string(typed))
	case string:
		return sanitizeAIUpstreamString(typed)
	case map[string]any:
		return sanitizeAIUpstreamMap(typed)
	case []any:
		result := make([]any, 0, len(typed))
		for _, item := range typed {
			result = append(result, sanitizeAIUpstreamLogValue(item))
		}
		return result
	}

	bytes, err := json.Marshal(value)
	if err != nil {
		return sanitizeAIUpstreamString(fmt.Sprint(value))
	}
	var decoded any
	if err := json.Unmarshal(bytes, &decoded); err != nil {
		return sanitizeAIUpstreamString(string(bytes))
	}
	return sanitizeAIUpstreamLogValue(decoded)
}

func sanitizeAIUpstreamMap(input map[string]any) map[string]any {
	result := make(map[string]any, len(input))
	keys := make([]string, 0, len(input))
	for key := range input {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if isSensitiveFieldName(key) {
			result[key] = "[REDACTED]"
			continue
		}
		result[key] = sanitizeAIUpstreamLogValue(input[key])
	}
	return result
}

func isSensitiveFieldName(key string) bool {
	normalized := strings.ToLower(strings.TrimSpace(key))
	normalized = strings.NewReplacer("-", "", "_", "", ".", "").Replace(normalized)
	if normalized == "" {
		return false
	}
	if normalized == "key" || normalized == "apikey" || normalized == "xapikey" {
		return true
	}
	return strings.Contains(normalized, "authorization") ||
		strings.Contains(normalized, "token") ||
		strings.Contains(normalized, "secret") ||
		strings.Contains(normalized, "password") ||
		strings.Contains(normalized, "passwd") ||
		strings.Contains(normalized, "credential") ||
		strings.Contains(normalized, "cookie")
}

func sanitizeAIUpstreamString(value string) string {
	text := redactSecretLikeString(value)
	if matches := dataURIValuePattern.FindStringSubmatch(text); len(matches) == 2 {
		return fmt.Sprintf("data:%s;base64,[REDACTED %d chars]", matches[1], len(text))
	}
	if len(text) <= aiUpstreamStringPreviewLimit {
		return text
	}
	return fmt.Sprintf("%s...[truncated %d chars]", text[:aiUpstreamStringPreviewLimit], len(text)-aiUpstreamStringPreviewLimit)
}

func redactSecretLikeString(value string) string {
	result := value
	for _, pattern := range secretLikeValuePatterns {
		result = pattern.ReplaceAllString(result, "[REDACTED]")
	}
	return result
}
