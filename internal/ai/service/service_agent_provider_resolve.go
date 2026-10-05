package aiservice

import (
	"strings"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/runharness"
	"GoNavi-Wails/shared/i18n"
)

// selectAgentProvider finds the provider an agent input is for: the one it names
// (by id or name), or the active one. The returned config is a private copy.
func (s *Service) selectAgentProvider(requestedID string) (ai.ProviderConfig, *i18n.Localizer, bool) {
	requestedID = strings.TrimSpace(requestedID)
	s.mu.RLock()
	defer s.mu.RUnlock()
	activeID := strings.TrimSpace(s.activeProvider)
	if activeID == "" && len(s.providers) > 0 {
		activeID = strings.TrimSpace(s.providers[0].ID)
	}
	localizer := s.serviceLocalizerForLanguageLocked()
	for _, candidate := range s.providers {
		candidateID := strings.TrimSpace(candidate.ID)
		if requestedID != "" {
			if candidateID != requestedID && !strings.EqualFold(candidateID, requestedID) && !strings.EqualFold(strings.TrimSpace(candidate.Name), requestedID) {
				continue
			}
		} else if candidateID != activeID {
			continue
		}
		return cloneAgentProviderConfig(candidate), localizer, true
	}
	return ai.ProviderConfig{}, localizer, false
}

// finishAgentProviderConfig applies what an input asks for (model, thinking level,
// temperature, output cap) to a resolved provider and keeps it inside the limits
// its model and, for the built-in one, the Gateway allow. A run is frozen with the
// result, and the context preview measures against the same one.
func finishAgentProviderConfig(resolved ai.ProviderConfig, request runharness.AgentInputRequest, builtin bool) ai.ProviderConfig {
	options := ai.ChatSendOptions{Model: request.Model, ThinkingIntensity: request.Thinking}
	resolved = normalizeProviderConfig(applyChatSendOptionsToProviderConfig(resolved, options))
	// 上下文档位是按模型选的：请求临时换了模型时，旧模型的档位不再适用。
	resolved.ContextWindow = ai.ResolveModelContextProfile(resolved.Model).NormalizeWindow(resolved.ContextWindow)
	if request.Temperature != nil {
		resolved.Temperature = *request.Temperature
	}
	if request.MaxTokens != nil {
		resolved.MaxTokens = *request.MaxTokens
	}
	if builtin {
		resolved = pinBuiltinAIContextLimits(resolved)
	}
	return cloneAgentProviderConfig(resolved)
}
