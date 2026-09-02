package aiservice

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/ai"
)

// Model preferences filter suggestions. They are not an account entitlement or
// an execution policy and do not rewrite existing conversation model overrides.
func selectableProviderModels(config ai.ProviderConfig, models []string) []string {
	if len(config.DisabledModels) == 0 && len(config.CustomModels) == 0 {
		return append([]string(nil), models...)
	}
	disabled := make(map[string]bool, len(config.DisabledModels))
	for _, model := range config.DisabledModels {
		disabled[strings.TrimSpace(model)] = true
	}
	result := make([]string, 0, len(models)+len(config.CustomModels))
	seen := make(map[string]bool)
	for _, group := range [][]string{models, config.CustomModels} {
		for _, value := range group {
			model := strings.TrimSpace(value)
			if model != "" && !disabled[model] && !seen[model] {
				seen[model] = true
				result = append(result, model)
			}
		}
	}
	return result
}

func disabledRequiredProviderModel(config ai.ProviderConfig) string {
	for _, disabled := range config.DisabledModels {
		model := strings.TrimSpace(disabled)
		if model != "" && (model == strings.TrimSpace(config.Model) || model == strings.TrimSpace(config.InlineCompletionModel)) {
			return model
		}
	}
	return ""
}

func (s *Service) validateProviderModelPreferencesLocked(config ai.ProviderConfig) error {
	if model := disabledRequiredProviderModel(config); model != "" {
		return s.serviceErrorLocked("ai_service.backend.error.required_model_disabled", map[string]any{"model": model}, fmt.Errorf("required model is disabled"))
	}
	return nil
}
