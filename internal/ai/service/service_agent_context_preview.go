package aiservice

import (
	"context"
	"errors"
	"strings"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/runharness"
)

// contextPreviewer is what the agent harness offers for measuring an input.
type contextPreviewer interface {
	PreviewContext(context.Context, runharness.ContextPreviewRequest) (runharness.ContextPreview, error)
}

// AIPreviewAgentContext measures what submitting this input would send to the
// model: the same session, the newest workspace, the same builder and the same
// window a run would use, so what the composer shows is not an estimate of an
// estimate. The input is not stored and no provider is called.
func (s *Service) AIPreviewAgentContext(request runharness.AgentInputRequest) (runharness.ContextPreview, error) {
	if s == nil {
		return runharness.ContextPreview{}, errors.New("AI Service is nil")
	}
	harness, ctx, err := s.agentHarnessForCall()
	if err != nil {
		return runharness.ContextPreview{}, err
	}
	previewer, ok := harness.(contextPreviewer)
	if !ok {
		return runharness.ContextPreview{}, errors.New("agent harness cannot preview context")
	}
	provider, ok := s.previewProviderConfig(request)
	if !ok {
		return runharness.ContextPreview{}, errors.New("provider is not configured")
	}
	return previewer.PreviewContext(ctx, runharness.ContextPreviewRequest{
		SessionID:               strings.TrimSpace(request.SessionID),
		Content:                 request.Content,
		Attachments:             request.Attachments,
		ContextSourceID:         request.ContextSourceID,
		ContextSourceInstanceID: request.ContextSourceInstanceID,
		ContextWindowTokens:     provider.ContextWindow,
		ReservedOutputTokens:    provider.MaxTokens,
		OmitImages:              provider.SupportsImages != nil && !*provider.SupportsImages,
		Provider:                provider.ID,
		TaskKind:                request.TaskKind,
	})
}

// previewProviderConfig is the provider as a run for this input would freeze it,
// as far as window, output cap and image support go. Credentials are not needed for
// that and are not resolved, except that the built-in provider is completed the way a
// run completes it, which also brings the Gateway's current limits.
func (s *Service) previewProviderConfig(request runharness.AgentInputRequest) (ai.ProviderConfig, bool) {
	selected, localizer, ok := s.selectAgentProvider(request.Provider)
	if !ok || strings.TrimSpace(selected.ID) == "" {
		return ai.ProviderConfig{}, false
	}
	builtin := isBuiltinAIProviderConfig(selected)
	resolved := selected
	if builtin {
		// Not signed in (or the Gateway is out of reach): the limits last known are used.
		if completed, err := s.resolveBuiltinAIProvider(selected, localizer); err == nil {
			resolved = completed
		}
	}
	return finishAgentProviderConfig(resolved, request, builtin), true
}
