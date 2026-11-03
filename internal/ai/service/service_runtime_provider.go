package aiservice

import (
	"context"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/provider"
)

func (s *Service) getActiveProviderRuntime() (provider.Provider, ai.ProviderConfig, error) {
	return s.getActiveProviderRuntimeWithOptions(ai.ChatSendOptions{})
}

func (s *Service) getActiveProviderRuntimeWithOptions(options ai.ChatSendOptions) (provider.Provider, ai.ProviderConfig, error) {
	return s.getActiveProviderRuntimeWithContext(s.agentLifecycleContext(), options)
}

func (s *Service) getActiveProviderRuntimeWithContext(ctx context.Context, options ai.ChatSendOptions) (provider.Provider, ai.ProviderConfig, error) {
	s.mu.Lock()
	localizer := s.serviceLocalizerForLanguageLocked()
	if s.activeProvider == "" && len(s.providers) > 0 {
		s.activeProvider = s.providers[0].ID
	}
	var selected ai.ProviderConfig
	found := false
	for _, cfg := range s.providers {
		if cfg.ID == s.activeProvider {
			selected = cloneAgentProviderConfig(cfg)
			found = true
			break
		}
	}
	s.mu.Unlock()
	if !found {
		return nil, ai.ProviderConfig{}, localizedAIServiceError{key: "ai_service.backend.error.provider_not_configured", message: serviceTextFromLocalizer(localizer, "ai_service.backend.error.provider_not_configured", nil)}
	}
	if isPluginProviderConfig(selected) {
		if err := validatePluginProviderConfig(selected); err != nil {
			return nil, selected, err
		}
		resolved, err := s.resolveProviderConfigSecrets(selected)
		if err != nil {
			return nil, selected, err
		}
		resolved = pluginProviderSendOptions(resolved, options)
		instance, err := s.newPluginProvider(ctx, resolved)
		return instance, resolved, err
	}
	normalized := normalizeProviderConfig(applyChatSendOptionsToProviderConfig(selected, options))
	// Gateway refresh remains outside the settings lock and unchanged for builtins.
	if isBuiltinAIProviderConfig(normalized) {
		resolved, err := s.resolveBuiltinAIProvider(normalized, localizer)
		if err != nil {
			return nil, normalized, err
		}
		normalized = resolved
	}
	instance, err := provider.NewProvider(normalized)
	return s.withCodeBuddyCLILocalization(instance, normalized), normalized, err
}
