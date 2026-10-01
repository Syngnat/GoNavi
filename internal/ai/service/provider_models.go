package aiservice

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/ai"
)

// Model preferences filter suggestions. They are not an account entitlement or
// an execution policy and do not rewrite existing conversation model overrides.
func selectableProviderModels(config ai.ProviderConfig, models []string) []string {
	if len(config.DisabledModels) == 0 && len(config.CustomModels) == 0 && len(config.RemovedModels) == 0 {
		return append([]string(nil), models...)
	}
	disabled := make(map[string]bool, len(config.DisabledModels)+len(config.RemovedModels))
	for _, model := range config.DisabledModels {
		disabled[strings.TrimSpace(model)] = true
	}
	// 删除过的模型不再出现在列表里，包括上游同步与内置预设带来的同名项。
	for _, model := range config.RemovedModels {
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
	for _, disabled := range append(append([]string(nil), config.DisabledModels...), config.RemovedModels...) {
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

// normalizeProviderModelList 统一整理用户维护的模型名单：去空白、去空项、去重并保持顺序。
func normalizeProviderModelList(models []string) []string {
	if len(models) == 0 {
		return nil
	}
	result := make([]string, 0, len(models))
	seen := make(map[string]bool, len(models))
	for _, value := range models {
		model := strings.TrimSpace(value)
		if model == "" || seen[model] {
			continue
		}
		seen[model] = true
		result = append(result, model)
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

// normalizeProviderModelPreferences 收敛三个互斥的模型名单：
// 删除优先于停用（同一个模型不会既在 RemovedModels 又在 DisabledModels），
// 删除过的模型也不再保留在 CustomModels 里。
func normalizeProviderModelPreferences(config ai.ProviderConfig) ai.ProviderConfig {
	removed := normalizeProviderModelList(config.RemovedModels)
	if len(removed) == 0 {
		config.RemovedModels = nil
		config.DisabledModels = normalizeProviderModelList(config.DisabledModels)
		config.CustomModels = normalizeProviderModelList(config.CustomModels)
		return config
	}
	removedSet := make(map[string]bool, len(removed))
	for _, model := range removed {
		removedSet[model] = true
	}
	config.RemovedModels = removed
	config.DisabledModels = pruneProviderModels(normalizeProviderModelList(config.DisabledModels), removedSet)
	config.CustomModels = pruneProviderModels(normalizeProviderModelList(config.CustomModels), removedSet)
	return config
}

func pruneProviderModels(models []string, drop map[string]bool) []string {
	if len(models) == 0 {
		return nil
	}
	result := make([]string, 0, len(models))
	for _, model := range models {
		if drop[model] {
			continue
		}
		result = append(result, model)
	}
	if len(result) == 0 {
		return nil
	}
	return result
}
