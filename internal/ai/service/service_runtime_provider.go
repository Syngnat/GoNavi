package aiservice

import (
	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/provider"
)

func (s *Service) getActiveProviderRuntime() (provider.Provider, ai.ProviderConfig, error) {
	return s.getActiveProviderRuntimeWithOptions(ai.ChatSendOptions{})
}

func (s *Service) getActiveProviderRuntimeWithOptions(options ai.ChatSendOptions) (provider.Provider, ai.ProviderConfig, error) {
	s.mu.Lock()
	localizer := s.serviceLocalizerForLanguageLocked()
	if s.activeProvider == "" && len(s.providers) > 0 {
		s.activeProvider = s.providers[0].ID
	}
	var normalized ai.ProviderConfig
	found := false
	for _, cfg := range s.providers {
		if cfg.ID == s.activeProvider {
			normalized, found = normalizeProviderConfig(applyChatSendOptionsToProviderConfig(cfg, options)), true
			break
		}
	}
	s.mu.Unlock()
	if !found {
		return nil, ai.ProviderConfig{}, localizedAIServiceError{
			key:     "ai_service.backend.error.provider_not_configured",
			message: serviceTextFromLocalizer(localizer, "ai_service.backend.error.provider_not_configured", nil),
		}
	}
	// The built-in token refresh is a network call: resolve it outside s.mu so
	// a slow Gateway cannot block every other AI settings/read call.
	if isBuiltinAIProviderConfig(normalized) {
		resolved, err := s.resolveBuiltinAIProvider(normalized, localizer)
		if err != nil {
			return nil, normalized, err
		}
		normalized = resolved
	}
	p, err := provider.NewProvider(normalized)
	return p, normalized, err
}
