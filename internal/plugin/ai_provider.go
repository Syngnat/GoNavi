package plugin

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

const maxAIProviders = 8
const maxAIModels = 32
const maxAIProviderTypeBytes = len("plugin:") + 128 + 1 + 64

var aiProviderIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,63}$`)
var aiModelIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,127}$`)
var packageIconPattern = regexp.MustCompile(`(?i)\.(png|jpe?g|webp|gif)$`)

const maxPackageIconPathBytes = 256

// maxPackageIconBytes bounds one declared logo before the host turns it into a data URL.
// Raster logos are shown at card and list sizes, so a high-resolution brand image is
// legitimate; the read still happens without starting the plugin and stays bounded.
const maxPackageIconBytes = 5 << 20

// validPackageIcon accepts only a package-relative raster image path. SVG is rejected
// because the host renders the icon through the main window; the file itself is read with
// a byte limit and content sniffed before it becomes a data URL. Both manifest icons and
// declared AI provider icons share this rule.
func validPackageIcon(value string) bool {
	return len(value) <= maxPackageIconPathBytes && packageIconPattern.MatchString(value) && safePackagePath(value) == nil
}

// validAIProviderBaseURL accepts only an absolute http(s) endpoint without userinfo or fragment.
func validAIProviderBaseURL(raw string) bool {
	if len(raw) > 2048 || strings.TrimSpace(raw) != raw {
		return false
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" || parsed.RawQuery != "" {
		return false
	}
	return parsed.Scheme == "http" || parsed.Scheme == "https"
}

// AIProvider declares a native, host-managed text/tool/image model transport with static models.
// Both capability booleans must be explicit in JSON; supportsImages is an opt-in claim that the
// plugin accepts bounded image content parts on its start request. Icon is an optional
// package-relative raster path; the host reads it as bounded metadata, not executable content.
type AIProvider struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	Command        string    `json:"command"`
	Icon           string    `json:"icon,omitempty"`
	// DefaultBaseURL prefills the provider form when the user has not typed an endpoint.
	// It is a presentation default: the plugin still owns its fallback when the field is empty.
	DefaultBaseURL string    `json:"defaultBaseUrl,omitempty"`
	Models         []AIModel `json:"models"`
	SupportsTools  bool      `json:"supportsTools"`
	SupportsImages bool      `json:"supportsImages"`
}

// AIModel declares one exact upstream model identifier and its immutable token limits.
type AIModel struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	ContextWindow   int    `json:"contextWindow"`
	MaxOutputTokens int    `json:"maxOutputTokens"`
}

// AIProviderType returns a canonical identity, not execution authority or model availability.
// Invalid plugin/provider identities return an empty string without normalization.
func AIProviderType(pluginID string, declaration AIProvider) string {
	if !validPluginID(pluginID) || !aiProviderIDPattern.MatchString(declaration.ID) {
		return ""
	}
	return "plugin:" + pluginID + ":" + declaration.ID
}

// ParseAIProviderType parses exact identities before trimming or case folding.
func ParseAIProviderType(value string) (pluginID, providerID string, ok bool) {
	if len(value) > maxAIProviderTypeBytes || !strings.HasPrefix(value, "plugin:") {
		return "", "", false
	}
	parts := strings.Split(value, ":")
	if len(parts) != 3 || !validPluginID(parts[1]) || !aiProviderIDPattern.MatchString(parts[2]) {
		return "", "", false
	}
	return parts[1], parts[2], true
}

// IsAIProviderNamespace protects plugin-like values from ordinary-provider fallback.
// It recognizes case/whitespace mistakes and bare plugin, but never validates or normalizes them.
func IsAIProviderNamespace(value string) bool {
	head, _, _ := strings.Cut(strings.TrimSpace(value), ":")
	return strings.EqualFold(strings.TrimSpace(head), "plugin")
}

func validAIProviderText(value string) bool {
	return utf8.ValidString(value) && len(value) <= 256 && strings.TrimSpace(value) != "" && !strings.ContainsRune(value, 0)
}

func validateAIProviders(manifest Manifest, commands map[string]bool) error {
	if len(manifest.Contributes.AIProviders) == 0 {
		return nil
	}
	if len(manifest.Contributes.AIProviders) > maxAIProviders {
		return fmt.Errorf("too many ai provider contributions")
	}
	if !hasAIProviderPermission(manifest) || manifest.Backend == nil {
		return fmt.Errorf("ai providers require ai.providers permission and a backend")
	}
	ids := make(map[string]bool, len(manifest.Contributes.AIProviders))
	for _, declaration := range manifest.Contributes.AIProviders {
		if AIProviderType(manifest.ID, declaration) == "" || ids[declaration.ID] {
			return fmt.Errorf("invalid or duplicate ai provider identity")
		}
		if !validAIProviderText(declaration.Name) || !commands[declaration.Command] {
			return fmt.Errorf("invalid ai provider name or undeclared command")
		}
		if declaration.Icon != "" && !validPackageIcon(declaration.Icon) {
			return fmt.Errorf("invalid ai provider icon")
		}
		if declaration.DefaultBaseURL != "" && !validAIProviderBaseURL(declaration.DefaultBaseURL) {
			return fmt.Errorf("invalid ai provider default base url")
		}
		if err := validateAIModels(declaration.Models); err != nil {
			return err
		}
		ids[declaration.ID] = true
	}
	return nil
}

func validateAIModels(models []AIModel) error {
	if len(models) < 1 || len(models) > maxAIModels {
		return fmt.Errorf("ai provider must declare one to 32 models")
	}
	ids := make(map[string]bool, len(models))
	for _, model := range models {
		if !aiModelIDPattern.MatchString(model.ID) || ids[model.ID] || !validAIProviderText(model.Name) {
			return fmt.Errorf("invalid or duplicate ai model")
		}
		if model.ContextWindow < 1024 || model.ContextWindow > 262144 || model.MaxOutputTokens < 1 || model.MaxOutputTokens > 65536 || model.MaxOutputTokens > model.ContextWindow {
			return fmt.Errorf("invalid ai model token limits")
		}
		ids[model.ID] = true
	}
	return nil
}

func hasAIProviderPermission(manifest Manifest) bool {
	for _, permission := range manifest.Permissions {
		if permission == "ai.providers" {
			return true
		}
	}
	return false
}
