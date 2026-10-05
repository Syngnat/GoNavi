package ai

// BuiltinAIState is the machine-readable login/connectivity state of the
// GoNavi-hosted AI service. The UI maps it to localized copy; Message is only a
// readable fallback.
const (
	BuiltinAIStateReady              = "ready"
	BuiltinAIStateLoginRequired      = "login_required"
	BuiltinAIStateLoginExpired       = "login_expired"
	BuiltinAIStateNetworkError       = "network_error"
	BuiltinAIStateQuotaUnavailable   = "quota_unavailable"
	BuiltinAIStateServiceUnavailable = "service_unavailable"
	BuiltinAIStateNotConfigured      = "not_configured"
)

// BuiltinAIStatus is the non-sensitive status projection for the GoNavi-hosted
// AI service. Access and refresh tokens are deliberately excluded.
type BuiltinAIStatus struct {
	Enabled bool `json:"enabled"`
	// Authenticated is true while this device holds credentials the Gateway has
	// not rejected. A network error keeps it true: the user is still signed in.
	Authenticated bool            `json:"authenticated"`
	State         string          `json:"state"`
	GatewayURL    string          `json:"gatewayUrl,omitempty"`
	LoginURL      string          `json:"loginUrl,omitempty"`
	Model         string          `json:"model,omitempty"`
	Quota         *BuiltinAIQuota `json:"quota,omitempty"`
	Message       string          `json:"message,omitempty"`
}

// BuiltinAIQuota reports server-side token accounting for the signed-in user.
type BuiltinAIQuota struct {
	DailyTokensUsed     int64 `json:"dailyTokensUsed"`
	DailyTokenLimit     int64 `json:"dailyTokenLimit"`
	Rolling5HTokensUsed int64 `json:"rolling5hTokensUsed"`
	Rolling5HTokenLimit int64 `json:"rolling5hTokenLimit"`
	// Reset times are RFC3339 and empty when the Gateway does not report them.
	DailyResetAt     string `json:"dailyResetAt,omitempty"`
	Rolling5HResetAt string `json:"rolling5hResetAt,omitempty"`
	// ServiceAvailable is nil for Gateways that predate the field; false means
	// no model node is currently healthy.
	ServiceAvailable *bool `json:"serviceAvailable,omitempty"`
}

// BuiltinAIDeviceCode is the OAuth device authorization response. The device
// code is short-lived and is only used to poll the token endpoint.
type BuiltinAIDeviceCode struct {
	DeviceCode              string `json:"deviceCode"`
	UserCode                string `json:"userCode"`
	VerificationURI         string `json:"verificationUri"`
	VerificationURIComplete string `json:"verificationUriComplete,omitempty"`
	ExpiresInSeconds        int    `json:"expiresInSeconds"`
	IntervalSeconds         int    `json:"intervalSeconds"`
}

// BuiltinAILoginResult is returned by each device-code poll.
type BuiltinAILoginResult struct {
	Status            string `json:"status"` // pending | authorized | expired | error
	Authenticated     bool   `json:"authenticated"`
	Message           string `json:"message,omitempty"`
	RetryAfterSeconds int    `json:"retryAfterSeconds,omitempty"`
}
