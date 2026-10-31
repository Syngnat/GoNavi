package plugin

// AIProvider declares a host-managed text/tool provider and its static model catalog.
// It requires ai.providers permission, a backend and an exact declared command.
// Capability flags are always serialized; SupportsImages must be false in version one.
// Icon optionally names a package-relative raster image shown by the host settings UI.
type AIProvider struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	Command        string    `json:"command"`
	Icon           string    `json:"icon,omitempty"`
	// DefaultBaseURL is a presentation default the host may prefill into the provider form.
	DefaultBaseURL string    `json:"defaultBaseUrl,omitempty"`
	Models         []AIModel `json:"models"`
	SupportsTools  bool      `json:"supportsTools"`
	SupportsImages bool      `json:"supportsImages"`
}

// AIModel declares an exact case-sensitive model ID and bounded context/output token limits.
type AIModel struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	ContextWindow   int    `json:"contextWindow"`
	MaxOutputTokens int    `json:"maxOutputTokens"`
}
