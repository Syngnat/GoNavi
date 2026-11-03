package aiservice

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/provider"
	"GoNavi-Wails/internal/ai/runharness"
)

// bindAgentProviderInput resolves a provider once before the Ledger accepts a
// run. Only its encrypted execution binding is used by later model attempts.
func (s *Service) bindAgentProviderInput(ctx context.Context, request *runharness.AgentInputRequest) error {
	if ctx == nil {
		return runharness.ErrRootContextRequired
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if s == nil {
		return errors.New("AI Service is nil")
	}
	if request == nil {
		return errors.New("agent input is required")
	}

	requestedID := strings.TrimSpace(request.Provider)
	selected, localizer, _ := s.selectAgentProvider(requestedID)

	if strings.TrimSpace(selected.ID) == "" {
		if requestedID == "" {
			return serviceErrorFromLocalizer(
				localizer,
				"ai_service.backend.error.provider_not_configured",
				nil,
				errors.New("provider is not configured"),
			)
		}
		return fmt.Errorf("agent provider %q is not configured", requestedID)
	}
	if isPluginProviderConfig(selected) {
		return s.bindPluginAgentInput(ctx, request, selected)
	}
	var resolved ai.ProviderConfig
	var err error
	builtin := isBuiltinAIProviderConfig(selected)
	if builtin {
		resolved, err = s.resolveBuiltinAIProvider(selected, localizer)
	} else {
		resolved, err = s.resolveProviderConfigSecrets(selected)
	}
	if err != nil {
		return err
	}
	resolved = finishAgentProviderConfig(resolved, *request, builtin)
	binding, err := runharness.NewProviderBinding(resolved.ID, resolved)
	if err != nil {
		return fmt.Errorf("bind agent provider: %w", err)
	}
	if strings.TrimSpace(binding.ProviderID) == "" {
		return serviceErrorFromLocalizer(
			localizer,
			"ai_service.backend.error.provider_not_configured",
			nil,
			errors.New("provider is not configured"),
		)
	}
	if err := request.SetProviderBinding(binding); err != nil {
		return fmt.Errorf("attach agent provider binding: %w", err)
	}
	return nil
}

func (s *Service) resolveAgentProvider(ctx context.Context, request runharness.ModelTurnRequest) (provider.Provider, error) {
	if ctx == nil {
		return nil, ErrAgentLifecycleUnavailable
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if request.ProviderBinding == nil {
		return nil, runharness.ErrProviderBindingUnbound
	}
	binding, err := request.ProviderBinding.Validate()
	if err != nil {
		return nil, fmt.Errorf("%w: %v", runharness.ErrProviderBindingCorrupt, err)
	}
	if requestedID := strings.TrimSpace(request.Provider); requestedID == "" || !strings.EqualFold(requestedID, binding.ProviderID) {
		return nil, fmt.Errorf("%w: model request provider %q does not match binding %q", runharness.ErrProviderBindingCorrupt, request.Provider, binding.ProviderID)
	}
	var resolved ai.ProviderConfig
	if err := json.Unmarshal(binding.Config, &resolved); err != nil {
		return nil, fmt.Errorf("%w: decode provider config: %v", runharness.ErrProviderBindingCorrupt, err)
	}
	resolved.ID = strings.TrimSpace(resolved.ID)
	if resolved.ID == "" || resolved.ID != binding.ProviderID {
		return nil, fmt.Errorf("%w: provider config ID %q does not match binding %q", runharness.ErrProviderBindingCorrupt, resolved.ID, binding.ProviderID)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if isPluginProviderBinding(resolved, binding.Config) {
		return s.resolvePluginAgentProvider(ctx, binding.Config, resolved)
	}
	agentProvider, err := provider.NewProvider(cloneAgentProviderConfig(resolved))
	if err != nil {
		return nil, err
	}
	if resolved.ID == builtinAIProviderID {
		// The hosted small model gets its context as plain text, a short list of read-only
		// tools, and its queries checked before they run (see builtin_ai_prompt.go).
		localizer := s.serviceLocalizerForLanguage()
		notice := serviceTextFromLocalizer(localizer, "ai_service.backend.builtin.readonly_sql_refused", nil)
		heading := func(shown, total int) string {
			return serviceTextFromLocalizer(localizer, "ai_service.backend.builtin.result_preview", map[string]any{"shown": shown, "total": total})
		}
		return builtinAIPromptProvider{Provider: agentProvider, readOnlyNotice: notice, lookup: s.builtinAIContextFor, columns: s.builtinAIColumnsFor, resultHeading: heading}, nil
	}
	return s.withCodeBuddyCLILocalization(agentProvider, resolved), nil
}
