package aiservice

import (
	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/shared/i18n"
)

// AIListModels 获取当前活跃 Provider 的可用模型列表
func (s *Service) AIListModels() map[string]interface{} {
	s.mu.RLock()
	var config ai.ProviderConfig
	found := false
	localizer := s.serviceLocalizerForLanguageLocked()
	for _, p := range s.providers {
		if p.ID == s.activeProvider {
			config = p
			found = true
			break
		}
	}
	s.mu.RUnlock()

	if !found {
		return map[string]interface{}{
			"success": false,
			"models":  []string{},
			"error":   serviceTextFromLocalizer(localizer, "ai_service.backend.error.active_provider_not_found", nil),
		}
	}

	if isBuiltinAIProviderConfig(config) {
		return builtinAIModelList()
	}
	return listProviderModels(normalizeProviderConfig(config), localizer, true)
}

// AIListProviderModels refreshes model choices for an unsaved provider draft.
// It never writes the draft or changes the active provider; saved credentials
// are resolved by ID when the editor intentionally retains its existing secret.
func (s *Service) AIListProviderModels(config ai.ProviderConfig) map[string]interface{} {
	if isBuiltinAIProviderConfig(config) {
		return builtinAIModelList()
	}
	localizer := s.serviceLocalizerForLanguage()
	resolved, err := s.resolveProviderConfigSecrets(config)
	if err != nil {
		return map[string]interface{}{"success": false, "models": []string{}, "error": err.Error()}
	}
	return listProviderModels(normalizeProviderConfig(resolved), localizer, false)
}

func listProviderModels(config ai.ProviderConfig, localizer *i18n.Localizer, allowConfiguredFallback bool) map[string]interface{} {
	if isLocalCLIAuthProvider(config) || normalizedProviderType(config) == "codebuddy-cli" {
		return map[string]interface{}{
			"success": true,
			"models":  selectableProviderModels(config, config.Models),
			"source":  "static",
		}
	}
	if staticModels := defaultStaticModelsForProvider(config); len(staticModels) > 0 {
		return map[string]interface{}{"success": true, "models": selectableProviderModels(config, staticModels), "source": "static"}
	}

	models, err := fetchModelsFunc(config, localizer)
	if err != nil {
		// 回退到配置中的静态模型列表
		if allowConfiguredFallback && (len(config.Models) > 0 || len(config.CustomModels) > 0) {
			return map[string]interface{}{"success": true, "models": selectableProviderModels(config, config.Models), "source": "static"}
		}
		return map[string]interface{}{"success": false, "models": []string{}, "error": err.Error()}
	}

	models, err = filterFetchedModelsForProvider(config, models, localizer)
	if err != nil {
		return map[string]interface{}{"success": false, "models": []string{}, "error": err.Error()}
	}

	return map[string]interface{}{"success": true, "models": selectableProviderModels(config, models), "source": "api"}
}
