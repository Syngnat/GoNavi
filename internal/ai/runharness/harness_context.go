package runharness

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
)

// modelContextInput is everything one model turn's context is built from.
type modelContextInput struct {
	Messages           []Message
	Tools              []ToolDescriptor
	WorkspaceSnapshot  *WorkspaceSnapshot
	WorkspaceReference *WorkspaceSnapshotReference
	ConversationCursor string
	ProviderState      json.RawMessage
}

// buildModelContext projects the durable transcript and the workspace into the
// request for one model turn. It runs only after the newest durable transcript
// and workspace snapshot are available. A context-limit failure is handled before
// any token reservation or provider call, so failed builds cannot leak budget.
//
// The provider configuration is accepted as an encrypted, immutable run contract.
// It is loaded before the projection so provider-specific limits come from the
// same frozen configuration that executes the model turn.
//
// On any failure the run is ended here (failed or canceled) and ok is false.
func (h *AgentRunHarness) buildModelContext(ctx context.Context, run RunSnapshot, execution *runExecution, in modelContextInput) (built ContextBuildResult, binding *ProviderBinding, ok bool) {
	contextWindowTokens, reservedOutputTokens, omitImages := 0, 0, false
	if strings.TrimSpace(run.Provider) != "" {
		stored, bindingErr := h.ledger.GetProviderBinding(ctx, run.ID)
		if bindingErr != nil {
			h.failRun(h.durableContext(), run, "provider_binding", bindingErr, execution)
			return ContextBuildResult{}, nil, false
		}
		contextWindowTokens, reservedOutputTokens, bindingErr = providerContextLimits(stored)
		if bindingErr != nil {
			h.failRun(h.durableContext(), run, "provider_binding", bindingErr, execution)
			return ContextBuildResult{}, nil, false
		}
		omitImages = providerOmitsImages(stored)
		binding = cloneProviderBinding(&stored)
	}
	instructions := h.instructionsFor(ctx, InstructionsRequest{TaskKind: run.TaskKind, Provider: run.Provider, Workspace: in.WorkspaceSnapshot})
	built, buildErr := h.contextBuilder.Build(ctx, ContextBuildRequest{
		Instructions:         instructions,
		Run:                  run,
		Messages:             in.Messages,
		Tools:                in.Tools,
		WorkspaceSnapshot:    in.WorkspaceSnapshot,
		WorkspaceReference:   in.WorkspaceReference,
		ConversationCursor:   in.ConversationCursor,
		ProviderState:        in.ProviderState,
		ContextWindowTokens:  contextWindowTokens,
		ReservedOutputTokens: reservedOutputTokens,
		OmitImages:           omitImages,
	})
	if buildErr != nil {
		if errors.Is(buildErr, ErrContextLimit) {
			h.failRun(h.durableContext(), run, "context_limit", buildErr, execution)
		} else if errors.Is(buildErr, context.Canceled) || errors.Is(buildErr, context.DeadlineExceeded) {
			h.finishCanceled(h.durableContext(), run.ID, "canceled", execution)
		} else {
			h.failRun(h.durableContext(), run, "context", buildErr, execution)
		}
		return ContextBuildResult{}, nil, false
	}
	return built, binding, true
}

// providerOmitsImages reports whether the bound provider declares that its model
// cannot take images ("supportsImages": false). Without the declaration images are
// sent, and each provider adapter keeps its own fallback for an endpoint that
// refuses them.
func providerOmitsImages(binding ProviderBinding) bool {
	validated, err := binding.Validate()
	if err != nil {
		return false
	}
	var flags struct {
		SupportsImages *bool `json:"supportsImages"`
	}
	if json.Unmarshal(validated.Config, &flags) != nil {
		return false
	}
	return flags.SupportsImages != nil && !*flags.SupportsImages
}
