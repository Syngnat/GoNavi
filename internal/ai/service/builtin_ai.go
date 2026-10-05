package aiservice

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/dailysecret"
)

const (
	builtinAIProviderID     = "gonavi-ai"
	builtinAIProviderName   = "GoNavi AI"
	builtinAIDefaultGateway = "https://ai.syngnat.top"
	builtinAIDefaultModel   = "gonavi-sql"
	builtinAIClientID       = "gonavi-desktop"
	builtinAIDeviceCodePath = "/oauth/device/code"
	builtinAITokenPath      = "/oauth/token"
	builtinAIRevokePath     = "/oauth/revoke"
	builtinAIQuotaPath      = "/v1/quota"
	builtinAILoginPath      = "/device"
)

type builtinAIConfig struct {
	gatewayURL string
	loginURL   string
	model      string
	clientID   string
	deviceURL  string
	tokenURL   string
	revokeURL  string
	quotaURL   string
}

type builtinAIDeviceCodeResponse struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

type builtinAITokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
}

type builtinAIOAuthError struct {
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

func loadBuiltinAIConfig() (builtinAIConfig, error) {
	rawGatewayURL := strings.TrimSpace(os.Getenv("GONAVI_AI_GATEWAY_URL"))
	if rawGatewayURL == "" {
		rawGatewayURL = builtinAIDefaultGateway
	}
	parsed, err := url.Parse(rawGatewayURL)
	if err != nil || parsed.Host == "" || parsed.User != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return builtinAIConfig{}, fmt.Errorf("invalid GONAVI_AI_GATEWAY_URL")
	}
	// Credentials are sent to this origin: plain http is only for local testing.
	if parsed.Scheme == "http" && !isBuiltinAILocalHost(parsed.Hostname()) {
		return builtinAIConfig{}, fmt.Errorf("GONAVI_AI_GATEWAY_URL must use https")
	}

	base := strings.TrimRight(parsed.String(), "/")
	base = strings.TrimRight(strings.TrimSuffix(base, "/v1"), "/")
	model := strings.TrimSpace(os.Getenv("GONAVI_AI_MODEL"))
	if model == "" {
		model = builtinAIDefaultModel
	}
	clientID := strings.TrimSpace(os.Getenv("GONAVI_AI_CLIENT_ID"))
	if clientID == "" {
		clientID = builtinAIClientID
	}
	loginURL := strings.TrimSpace(os.Getenv("GONAVI_AI_LOGIN_URL"))
	if loginURL == "" {
		loginURL = base + builtinAILoginPath
	}
	return builtinAIConfig{
		gatewayURL: base,
		loginURL:   loginURL,
		model:      model,
		clientID:   clientID,
		deviceURL:  base + builtinAIDeviceCodePath,
		tokenURL:   base + builtinAITokenPath,
		revokeURL:  base + builtinAIRevokePath,
		quotaURL:   base + builtinAIQuotaPath,
	}, nil
}

func isBuiltinAILocalHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".test") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (c builtinAIConfig) enabled() bool {
	return strings.TrimSpace(c.gatewayURL) != ""
}

// AIGetBuiltinAIProvider returns the fixed, non-editable provider contract. The
// public Gateway is the default; GONAVI_AI_GATEWAY_URL overrides it for staging.
// It reads local state only, so it is safe to call on every render.
func (s *Service) AIGetBuiltinAIProvider() (ai.ProviderConfig, error) {
	if _, err := loadBuiltinAIConfig(); err != nil {
		return ai.ProviderConfig{}, err
	}
	provider := completeBuiltinAIProvider(ai.ProviderConfig{})
	provider.HasSecret = s.builtinAIHasLocalToken()
	return provider, nil
}

// AIGetBuiltinAIStatus returns login, connectivity and quota state without
// returning tokens. It never fails for transport reasons: those are reported
// through State so the UI can offer a retry instead of a login prompt.
func (s *Service) AIGetBuiltinAIStatus() (ai.BuiltinAIStatus, error) {
	config, err := loadBuiltinAIConfig()
	if err != nil {
		return ai.BuiltinAIStatus{State: ai.BuiltinAIStateNotConfigured, Message: s.builtinAIMessage(err)}, nil
	}
	status := ai.BuiltinAIStatus{Enabled: true, GatewayURL: config.gatewayURL, LoginURL: config.loginURL, Model: config.model}
	bundle, err := s.ensureBuiltinAIAccessToken(config, false)
	if err != nil {
		return s.builtinAIStatusFromError(status, err), nil
	}
	quota, err := fetchBuiltinAIQuota(config, bundle.APIKey)
	if errors.Is(err, errBuiltinAIUnauthorized) {
		// Rejected while locally valid (revoked server-side, clock skew): one
		// forced refresh decides whether the login is really gone.
		if bundle, err = s.ensureBuiltinAIAccessToken(config, true); err != nil {
			return s.builtinAIStatusFromError(status, err), nil
		}
		quota, err = fetchBuiltinAIQuota(config, bundle.APIKey)
	}
	if err != nil {
		return s.builtinAIStatusFromError(status, err), nil
	}
	status.Authenticated = true
	status.Quota = &quota
	status.State = ai.BuiltinAIStateReady
	if quota.ServiceAvailable != nil && !*quota.ServiceAvailable {
		status.State = ai.BuiltinAIStateServiceUnavailable
		status.Message = s.builtinAIMessage(errBuiltinAIServiceUnavailable)
	}
	return status, nil
}

func (s *Service) builtinAIStatusFromError(status ai.BuiltinAIStatus, err error) ai.BuiltinAIStatus {
	status.Message = s.builtinAIMessage(err)
	var statusErr builtinAIHTTPStatusError
	switch {
	case errors.Is(err, errBuiltinAILoginRequired):
		status.State = ai.BuiltinAIStateLoginRequired
	case errors.Is(err, errBuiltinAIUnauthorized):
		status.State = ai.BuiltinAIStateLoginExpired
	case errors.Is(err, errBuiltinAINetwork):
		status.Authenticated, status.State = true, ai.BuiltinAIStateNetworkError
	case errors.As(err, &statusErr):
		status.Authenticated, status.State = true, ai.BuiltinAIStateQuotaUnavailable
	default:
		status.Authenticated, status.State = true, ai.BuiltinAIStateServiceUnavailable
	}
	return status
}

// AIStartBuiltinAILogin starts OAuth device authorization. The UI opens the
// returned verification URI and polls AIPollBuiltinAILogin.
func (s *Service) AIStartBuiltinAILogin() (ai.BuiltinAIDeviceCode, error) {
	config, err := loadBuiltinAIConfig()
	if err != nil {
		return ai.BuiltinAIDeviceCode{}, err
	}
	runBuiltinAILoginStartHook()
	request := map[string]string{"client_id": config.clientID, "scope": "gonavi.ai"}
	if hostname, hostErr := os.Hostname(); hostErr == nil && strings.TrimSpace(hostname) != "" {
		request["device_name"] = hostname
	}
	body, err := json.Marshal(request)
	if err != nil {
		return ai.BuiltinAIDeviceCode{}, err
	}
	response, err := doBuiltinAIJSONRequest(http.MethodPost, config.deviceURL, "", body)
	if err != nil {
		return ai.BuiltinAIDeviceCode{}, fmt.Errorf("%w: %v", errBuiltinAINetwork, err)
	}
	if response.statusCode != http.StatusOK {
		return ai.BuiltinAIDeviceCode{}, builtinAIHTTPStatusError{endpoint: "device login endpoint", statusCode: response.statusCode}
	}
	var payload builtinAIDeviceCodeResponse
	if err := json.Unmarshal(response.body, &payload); err != nil {
		return ai.BuiltinAIDeviceCode{}, fmt.Errorf("parse GoNavi AI device login response: %w", err)
	}
	if strings.TrimSpace(payload.DeviceCode) == "" || strings.TrimSpace(payload.UserCode) == "" || strings.TrimSpace(payload.VerificationURI) == "" {
		return ai.BuiltinAIDeviceCode{}, errors.New("GoNavi AI device login response is incomplete")
	}
	verificationURI, err := validateBuiltinAIVerificationURL(payload.VerificationURI, config)
	if err != nil {
		return ai.BuiltinAIDeviceCode{}, err
	}
	verificationURIComplete, err := validateBuiltinAIVerificationURL(payload.VerificationURIComplete, config)
	if err != nil {
		return ai.BuiltinAIDeviceCode{}, err
	}
	interval := payload.Interval
	if interval < 1 {
		interval = 5
	}
	return ai.BuiltinAIDeviceCode{
		DeviceCode:              payload.DeviceCode,
		UserCode:                payload.UserCode,
		VerificationURI:         verificationURI,
		VerificationURIComplete: verificationURIComplete,
		ExpiresInSeconds:        payload.ExpiresIn,
		IntervalSeconds:         interval,
	}, nil
}

// AIPollBuiltinAILogin polls the device token endpoint. On success it stores the
// account credentials and makes sure a complete provider record exists, so the
// first login works even when no provider was ever saved. Transient network
// failures are reported as "pending": one dropped poll must not abort a login
// the user is still completing in the browser.
func (s *Service) AIPollBuiltinAILogin(deviceCode string) (ai.BuiltinAILoginResult, error) {
	deviceCode = strings.TrimSpace(deviceCode)
	if deviceCode == "" {
		return ai.BuiltinAILoginResult{}, errors.New("device code is required")
	}
	config, err := loadBuiltinAIConfig()
	if err != nil {
		return ai.BuiltinAILoginResult{}, err
	}
	body, err := json.Marshal(map[string]string{
		"client_id":   config.clientID,
		"device_code": deviceCode,
		"grant_type":  "urn:ietf:params:oauth:grant-type:device_code",
	})
	if err != nil {
		return ai.BuiltinAILoginResult{}, err
	}
	response, err := doBuiltinAIJSONRequest(http.MethodPost, config.tokenURL, "", body)
	if err != nil {
		return ai.BuiltinAILoginResult{Status: "pending", Message: s.builtinAIMessage(fmt.Errorf("%w: %v", errBuiltinAINetwork, err)), RetryAfterSeconds: 5}, nil
	}
	if response.statusCode == http.StatusBadRequest || response.statusCode == http.StatusUnauthorized {
		return s.builtinAIPollRefusal(response), nil
	}
	if response.statusCode != http.StatusOK {
		return ai.BuiltinAILoginResult{}, builtinAIHTTPStatusError{endpoint: "token endpoint", statusCode: response.statusCode}
	}
	var token builtinAITokenResponse
	if err := json.Unmarshal(response.body, &token); err != nil {
		return ai.BuiltinAILoginResult{}, fmt.Errorf("parse GoNavi AI token response: %w", err)
	}
	if strings.TrimSpace(token.AccessToken) == "" {
		return ai.BuiltinAILoginResult{}, errors.New("GoNavi AI token response has no access token")
	}
	builtinAIRefreshMu.Lock()
	storeErr := s.saveBuiltinAIToken(builtinAIBundleFromToken(token, ""))
	builtinAIRefreshMu.Unlock()
	if storeErr != nil {
		return ai.BuiltinAILoginResult{}, fmt.Errorf("store GoNavi AI token: %w", storeErr)
	}
	if err := s.ensureBuiltinAIProviderRecord(); err != nil {
		return ai.BuiltinAILoginResult{}, fmt.Errorf("save GoNavi AI provider: %w", err)
	}
	return ai.BuiltinAILoginResult{Status: "authorized", Authenticated: true, Message: s.serviceText("ai_service.backend.builtin.login_success", nil)}, nil
}

func (s *Service) builtinAIPollRefusal(response builtinAIHTTPResponse) ai.BuiltinAILoginResult {
	var oauthErr builtinAIOAuthError
	if err := json.Unmarshal(response.body, &oauthErr); err != nil {
		return ai.BuiltinAILoginResult{Status: "error", Message: s.builtinAIMessage(builtinAIHTTPStatusError{endpoint: "token endpoint", statusCode: response.statusCode})}
	}
	switch oauthErr.Error {
	case "authorization_pending":
		return ai.BuiltinAILoginResult{Status: "pending", RetryAfterSeconds: 5}
	case "slow_down":
		return ai.BuiltinAILoginResult{Status: "pending", RetryAfterSeconds: 10}
	case "expired_token", "access_denied":
		return ai.BuiltinAILoginResult{Status: "expired", Message: s.serviceText("ai_service.backend.builtin.device_code_expired", nil)}
	default:
		return ai.BuiltinAILoginResult{Status: "error", Message: oauthErr.ErrorDescription}
	}
}

// AILogoutBuiltinAI revokes this device's session at the Gateway (best effort)
// and always clears the local credentials, so the runtime is immediately signed
// out even when the Gateway is unreachable. Other devices stay signed in.
func (s *Service) AILogoutBuiltinAI() error {
	builtinAIRefreshMu.Lock()
	defer builtinAIRefreshMu.Unlock()
	if config, err := loadBuiltinAIConfig(); err == nil {
		if bundle, ok, readErr := s.builtinAIToken(); readErr == nil && ok {
			s.revokeBuiltinAIToken(config, bundle)
		}
	}
	return s.clearBuiltinAIToken()
}

func (s *Service) revokeBuiltinAIToken(config builtinAIConfig, bundle dailysecret.ProviderBundle) {
	token := strings.TrimSpace(bundle.SensitiveHeaders[builtinAIRefreshTokenKey])
	if token == "" {
		token = bundle.APIKey
	}
	body, err := json.Marshal(map[string]string{"client_id": config.clientID, "token": token})
	if err != nil {
		return
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = doBuiltinAIJSONRequest(http.MethodPost, config.revokeURL, bundle.APIKey, body)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
}
