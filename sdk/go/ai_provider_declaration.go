package plugin

import (
	"errors"
	"regexp"
	"strings"
)

var aiDeclarationID = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,63}$`)
var aiDeclarationModelID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,127}$`)
var aiDeclarationIcon = regexp.MustCompile(`(?i)\.(png|jpe?g|webp|gif)$`)

func validAIDeclarationIcon(value string) bool {
	if value == "" || len(value) > 256 || !aiDeclarationIcon.MatchString(value) || strings.HasPrefix(value, "/") || strings.ContainsAny(value, "\\\x00") {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

// ValidateAIProvider checks a public text-provider declaration. It does not grant image input
// or prove that the command is declared on a backend.
func ValidateAIProvider(provider AIProvider) error {
	if !aiDeclarationID.MatchString(provider.ID) || strings.TrimSpace(provider.Name) == "" || len(provider.Name) > 256 || strings.ContainsRune(provider.Name, 0) || provider.Command == "" {
		return errors.New("invalid ai provider identity")
	}
	if provider.Icon != "" && !validAIDeclarationIcon(provider.Icon) {
		return errors.New("invalid ai provider icon")
	}
	if provider.SupportsImages {
		return errors.New("ai provider images are unsupported")
	}
	if len(provider.Models) < 1 || len(provider.Models) > 32 {
		return errors.New("ai provider must declare one to 32 models")
	}
	seen := make(map[string]bool, len(provider.Models))
	for _, model := range provider.Models {
		if !aiDeclarationModelID.MatchString(model.ID) || seen[model.ID] || strings.TrimSpace(model.Name) == "" || len(model.Name) > 256 || strings.ContainsRune(model.Name, 0) {
			return errors.New("invalid ai model")
		}
		if model.ContextWindow < 1024 || model.ContextWindow > 262144 || model.MaxOutputTokens < 1 || model.MaxOutputTokens > 65536 || model.MaxOutputTokens > model.ContextWindow {
			return errors.New("invalid ai model token limits")
		}
		seen[model.ID] = true
	}
	return nil
}
