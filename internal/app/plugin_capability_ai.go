package app

import (
	"context"
	"net/url"
	"strings"

	aiservice "GoNavi-Wails/internal/ai/service"
)

type pluginCapabilityAIProvider struct {
	ID             string   `json:"id"`
	Type           string   `json:"type"`
	Name           string   `json:"name"`
	AuthMode       string   `json:"authMode,omitempty"`
	BaseURL        string   `json:"baseUrl,omitempty"`
	Model          string   `json:"model,omitempty"`
	Models         []string `json:"models,omitempty"`
	APIFormat      string   `json:"apiFormat,omitempty"`
	SupportsImages *bool    `json:"supportsImages,omitempty"`
	HasSecret      bool     `json:"hasSecret"`
}

type pluginCapabilityAIProvidersResult struct {
	Providers      []pluginCapabilityAIProvider `json:"providers"`
	ActiveProvider string                       `json:"activeProvider,omitempty"`
}

// pluginCapabilityAIProviders returns metadata only. It deliberately uses
// Inspect (not Load) so provider secrets are never resolved, then rebuilds each
// item without API keys, custom headers or CLI environment.
func pluginCapabilityAIProviders(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	if len(request.Arguments) > 0 {
		var arguments map[string]any
		if !decodePluginPageArguments(request.Arguments, &arguments) || len(arguments) > 0 {
			return nil, "invalid_arguments"
		}
	}
	inspection, err := aiservice.NewProviderConfigStore(a.configDir, a.secretStore).Inspect()
	if err != nil {
		return nil, "internal"
	}
	items := make([]pluginCapabilityAIProvider, 0, len(inspection.Snapshot.Providers))
	for _, provider := range inspection.Snapshot.Providers {
		item := pluginCapabilityAIProvider{
			ID:             strings.TrimSpace(provider.ID),
			Type:           strings.TrimSpace(provider.Type),
			Name:           strings.TrimSpace(provider.Name),
			AuthMode:       strings.TrimSpace(provider.AuthMode),
			BaseURL:        pluginCapabilityPublicBaseURL(provider.BaseURL),
			Model:          strings.TrimSpace(provider.Model),
			APIFormat:      strings.TrimSpace(provider.APIFormat),
			SupportsImages: provider.SupportsImages,
			HasSecret:      provider.HasSecret,
		}
		item.Models = append([]string(nil), provider.Models...)
		items = append(items, item)
	}
	return pluginCapabilityAIProvidersResult{
		Providers:      items,
		ActiveProvider: strings.TrimSpace(inspection.Snapshot.ActiveProvider),
	}, ""
}

// pluginCapabilityPublicBaseURL strips credentials and fragments from a stored provider
// endpoint before it is handed to a plugin. The capability promises metadata, not secrets;
// a user who pasted a key into the URL must not have it echoed back to a page.
func pluginCapabilityPublicBaseURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		if strings.Contains(trimmed, "@") {
			return ""
		}
		return trimmed
	}
	if parsed.User == nil && parsed.Fragment == "" {
		return trimmed
	}
	parsed.User = nil
	parsed.Fragment = ""
	return parsed.String()
}
