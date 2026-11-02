package aiservice

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"GoNavi-Wails/internal/ai"
)

// checkLegacyProviderHealth preserves existing endpoint and CLI verification.
func (s *Service) checkLegacyProviderHealth(config ai.ProviderConfig) (string, error) {
	providerType := normalizedProviderType(config)
	client := &http.Client{Timeout: 10 * time.Second}
	var err error
	checkKind := "none"

	switch providerType {
	case "openai", "anthropic", "gemini", "cursor-agent":
		checkKind = "endpoint"
		req, reqErr := newProviderHealthCheckRequest(config)
		if reqErr != nil {
			err = s.localizeProviderHealthCheckRequestError(reqErr)
			break
		}
		resp, reqErr := client.Do(req)
		if reqErr != nil {
			err = reqErr
		} else {
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
				err = fmt.Errorf("%s", s.serviceText("ai_service.backend.error.provider_auth_failed", map[string]any{
					"status": resp.StatusCode,
					"body":   "",
				}))
			} else if providerType == "gemini" && resp.StatusCode == http.StatusBadRequest {
				body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
				err = fmt.Errorf("%s", s.serviceText("ai_service.backend.error.provider_auth_failed", map[string]any{
					"status": resp.StatusCode,
					"body":   formatProviderHTTPBody(body),
				}))
			} else if resp.StatusCode >= 500 {
				body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
				err = fmt.Errorf("%s", s.serviceText("ai_service.backend.error.provider_http_server_error", map[string]any{
					"status": resp.StatusCode,
					"body":   formatProviderHTTPBody(body),
				}))
			} else if resp.StatusCode >= 400 {
				body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
				err = fmt.Errorf("%s", s.serviceText("ai_service.backend.error.provider_http_status_failed", map[string]any{
					"status": resp.StatusCode,
					"body":   formatProviderHTTPBody(body),
				}))
			}
		}
	case "claude-cli":
		if isLocalCLIAuthProvider(config) {
			checkKind = "local-auth"
			err = claudeCLILocalAuthCheckFunc(config)
		} else {
			checkKind = "model-response"
			testConfig := config
			if strings.TrimSpace(testConfig.Model) == "" && isDashScopeCodingPlanProvider(testConfig) && len(dashScopeCodingPlanModels) > 0 {
				testConfig.Model = dashScopeCodingPlanModels[0]
			}
			err = claudeCLIHealthCheckFunc(testConfig)
		}
	case "codex-cli":
		checkKind = "local-auth"
		if authErr := validateLocalCLIProviderAuthMode(config); authErr != nil {
			err = authErr
		} else {
			err = codexCLIHealthCheckFunc(config)
		}
	case "codebuddy-cli":
		checkKind = "model-response"
		err = s.localizeCodeBuddyCLIHealthError(codebuddyCLIHealthCheckFunc(config))
	case "grok-cli":
		checkKind = "model-list"
		if authErr := validateLocalCLIProviderAuthMode(config); authErr != nil {
			err = authErr
		} else {
			err = grokCLIHealthCheckFunc(config)
		}
	case "cursor-cli":
		checkKind = "local-auth"
		if authErr := validateLocalCLIProviderAuthMode(config); authErr != nil {
			err = authErr
		} else {
			err = cursorCLIHealthCheckFunc(config)
		}
	default:
		err = s.serviceError("ai_service.backend.error.provider_test_unsupported", map[string]any{"protocol": providerType}, errors.New("unsupported protocol"))
	}

	return checkKind, err
}
