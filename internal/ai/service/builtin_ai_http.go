package aiservice

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"GoNavi-Wails/internal/ai"
)

var builtinAIHTTPDo = func(req *http.Request) (*http.Response, error) {
	return (&http.Client{Timeout: 20 * time.Second}).Do(req)
}

type builtinAIHTTPResponse struct {
	statusCode int
	body       []byte
}

type builtinAIQuotaResponse struct {
	DailyTokensUsed     int64  `json:"dailyTokensUsed"`
	DailyTokenLimit     int64  `json:"dailyTokenLimit"`
	Rolling5HTokensUsed int64  `json:"rolling5hTokensUsed"`
	Rolling5HTokenLimit int64  `json:"rolling5hTokenLimit"`
	DailyResetAt        string `json:"dailyResetAt"`
	Rolling5HResetAt    string `json:"rolling5hResetAt"`
	ServiceAvailable    *bool  `json:"serviceAvailable"`
	// The Gateway's per-request limits; the operator can change them.
	ContextWindow   int `json:"contextWindow"`
	MaxOutputTokens int `json:"maxOutputTokens"`
}

// builtinAIHTTPStatusError carries the Gateway status so callers can map 403 and
// 404 to specific, actionable text instead of a generic failure.
type builtinAIHTTPStatusError struct {
	endpoint   string
	statusCode int
}

func (e builtinAIHTTPStatusError) Error() string {
	return fmt.Sprintf("GoNavi AI %s returned HTTP %d", e.endpoint, e.statusCode)
}

func doBuiltinAIJSONRequest(method, endpoint, accessToken string, body []byte) (builtinAIHTTPResponse, error) {
	request, err := http.NewRequestWithContext(context.Background(), method, endpoint, bytes.NewReader(body))
	if err != nil {
		return builtinAIHTTPResponse{}, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", builtinAIUserAgent())
	if strings.TrimSpace(accessToken) != "" {
		request.Header.Set("Authorization", "Bearer "+accessToken)
	}
	response, err := builtinAIHTTPDo(request)
	if err != nil {
		return builtinAIHTTPResponse{}, fmt.Errorf("request GoNavi AI Gateway: %w", err)
	}
	defer response.Body.Close()
	responseBody, readErr := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if readErr != nil {
		return builtinAIHTTPResponse{}, fmt.Errorf("read GoNavi AI Gateway response: %w", readErr)
	}
	return builtinAIHTTPResponse{statusCode: response.StatusCode, body: responseBody}, nil
}

func fetchBuiltinAIQuota(config builtinAIConfig, accessToken string) (ai.BuiltinAIQuota, error) {
	response, err := doBuiltinAIJSONRequest(http.MethodGet, config.quotaURL, accessToken, nil)
	if err != nil {
		return ai.BuiltinAIQuota{}, fmt.Errorf("%w: %v", errBuiltinAINetwork, err)
	}
	if response.statusCode == http.StatusUnauthorized {
		return ai.BuiltinAIQuota{}, errBuiltinAIUnauthorized
	}
	if response.statusCode != http.StatusOK {
		return ai.BuiltinAIQuota{}, builtinAIHTTPStatusError{endpoint: "quota endpoint", statusCode: response.statusCode}
	}
	var payload builtinAIQuotaResponse
	if err := json.Unmarshal(response.body, &payload); err != nil {
		return ai.BuiltinAIQuota{}, fmt.Errorf("parse GoNavi AI quota response: %w", err)
	}
	ai.SetHostedModelLimits(payload.ContextWindow, payload.MaxOutputTokens)
	return ai.BuiltinAIQuota{
		DailyTokensUsed:     payload.DailyTokensUsed,
		DailyTokenLimit:     payload.DailyTokenLimit,
		Rolling5HTokensUsed: payload.Rolling5HTokensUsed,
		Rolling5HTokenLimit: payload.Rolling5HTokenLimit,
		DailyResetAt:        payload.DailyResetAt,
		Rolling5HResetAt:    payload.Rolling5HResetAt,
		ServiceAvailable:    payload.ServiceAvailable,
	}, nil
}

// validateBuiltinAIVerificationURL refuses anything the desktop must not open in
// a browser: non-web schemes and embedded credentials. A Gateway reached over
// https that advertises its own page as http (a TLS-terminating proxy without
// GONAVI_AI_PUBLIC_URL) is upgraded to https, since the password is typed there;
// pointing an https Gateway's user at a plain-http page on another host is refused.
func validateBuiltinAIVerificationURL(raw string, config builtinAIConfig) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.User != nil {
		return "", fmt.Errorf("GoNavi AI verification URL is invalid")
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return "", fmt.Errorf("GoNavi AI verification URL must use http or https")
	}
	if gateway, gatewayErr := url.Parse(config.gatewayURL); gatewayErr == nil && gateway.Scheme == "https" && parsed.Scheme != "https" {
		if !strings.EqualFold(parsed.Host, gateway.Host) {
			return "", fmt.Errorf("GoNavi AI verification URL must use https")
		}
		parsed.Scheme = "https"
	}
	return parsed.String(), nil
}
