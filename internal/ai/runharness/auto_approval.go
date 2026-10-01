package runharness

import (
	"context"
	"strings"
)

// AutoApprovalRequest describes a side-effecting tool call that would
// otherwise wait for a human decision.
type AutoApprovalRequest struct {
	SessionID string
	RunID     string
	CallID    string
	ToolName  string
	Effect    ToolEffect
}

// AutoApprovalPolicy lets a host approve tool calls without asking, for
// example when the user chose "always approve" for a session or globally. It is
// consulted while a call is waiting, so turning a policy on also releases runs
// that are already parked on an approval card.
type AutoApprovalPolicy interface {
	AutoApprove(context.Context, AutoApprovalRequest) bool
}

// WithAutoApprovalPolicy installs the host's auto-approval policy.
func WithAutoApprovalPolicy(policy AutoApprovalPolicy) HarnessOption {
	return func(c *HarnessConfig) { c.AutoApproval = policy }
}

func (h *AgentRunHarness) autoApproves(ctx context.Context, run RunSnapshot, intent ToolIntent) bool {
	if h.autoApproval == nil {
		return false
	}
	return h.autoApproval.AutoApprove(ctx, AutoApprovalRequest{
		SessionID: run.SessionID, RunID: run.ID, CallID: intent.CallID, ToolName: intent.ToolName, Effect: intent.Effect,
	})
}

// initialApprovalDecision is the decision carried by the first approval event.
// An auto-approved call is announced as already approved, so adapters never
// render a card that would vanish a moment later.
func (h *AgentRunHarness) initialApprovalDecision(ctx context.Context, run RunSnapshot, intent ToolIntent) string {
	if h.autoApproves(ctx, run, intent) {
		return "approved"
	}
	return "pending"
}

// settleAutoApproval records an approval when the policy allows the waiting
// call. A failure (for example a human decided first) is left to the caller's
// next poll, which reads the durable decision.
func (h *AgentRunHarness) settleAutoApproval(ctx context.Context, run RunSnapshot, intent ToolIntent, approval ApprovalRecord, runRevision int64) {
	if !h.autoApproves(ctx, run, intent) || strings.TrimSpace(approval.ApprovalID) == "" {
		return
	}
	_, _ = h.ledger.DecideApproval(ctx, DecideApprovalRequest{
		ApprovalID: approval.ApprovalID, Decision: "approved",
		ExpectedRunRevision: runRevision,
		ExpectedRunID:       run.ID, ExpectedCallID: intent.CallID,
		ExpectedArgsHash: approval.ArgsHash,
	})
}

// newApprovalEvent keeps the adapter-facing approval projection deliberately
// separate from encrypted approval arguments. Its summary only communicates
// the effect class, so a SQL statement or any other tool parameter cannot
// cross the Wails/CLI event boundary by accident.
func newApprovalEvent(approvalID, callID, toolName string, effect ToolEffect, argsHash, decision string) ApprovalEvent {
	return ApprovalEvent{
		ApprovalID: approvalID,
		CallID:     callID,
		ToolName:   toolName,
		Effect:     effect,
		ArgsHash:   argsHash,
		Decision:   decision,
		Summary:    approvalDisplaySummary(effect),
	}
}

func approvalDisplaySummary(effect ToolEffect) string {
	switch effect {
	case ToolEffectSideEffect:
		return "This tool can change data or external state."
	case ToolEffectSideEffectUnknown:
		return "This tool may change data or external state."
	default:
		return "This tool requires approval before it can run."
	}
}
