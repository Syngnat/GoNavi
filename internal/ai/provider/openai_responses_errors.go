package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode"
)

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
