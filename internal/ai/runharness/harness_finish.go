package runharness

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

func (h *AgentRunHarness) appendState(ctx context.Context, run RunSnapshot, kind EventKind, state RunState, payload any, execution *runExecution, terminalReason string) (RunSnapshot, error) {
	if execution != nil && execution.terminal.Load() {
		return run, ErrTerminalRun
	}
	owner := ""
	if execution != nil {
		owner = execution.ownerToken()
	}
	event, err := h.ledger.AppendEvent(ctx, AppendEventRequest{RunID: run.ID, ExpectedRevision: run.Revision, Kind: kind, ResultingState: state, Payload: payload, TerminalReason: terminalReason, OwnerToken: owner})
	if err != nil {
		return run, err
	}
	h.publish(event)
	return h.ledger.GetRun(ctx, run.ID)
}

func (h *AgentRunHarness) publish(event RunEvent) {
	if h.events == nil {
		return
	}
	defer func() { _ = recover() }()
	h.events(event)
}

func (h *AgentRunHarness) refreshRun(ctx context.Context, runID string) (RunSnapshot, error) {
	return h.ledger.GetRun(ctx, runID)
}

func (h *AgentRunHarness) emitError(ctx context.Context, run RunSnapshot, code, message string, execution *runExecution) {
	if execution != nil && execution.terminal.Load() {
		return
	}
	owner := ""
	if execution != nil {
		owner = execution.ownerToken()
	}
	event, err := h.ledger.AppendEvent(ctx, AppendEventRequest{RunID: run.ID, Kind: EventRunError, ResultingState: run.State, Payload: RunErrorEvent{Code: code, Message: message, Retryable: retryableModelErrorCode(code)}, TerminalReason: "", OwnerToken: owner})
	if err == nil {
		h.publish(event)
	}
}

func (h *AgentRunHarness) failRun(ctx context.Context, run RunSnapshot, code string, cause error, execution *runExecution) {
	if execution != nil && execution.terminal.Load() {
		return
	}
	message := "agent run failed"
	if cause != nil {
		message = cause.Error()
	}
	h.emitError(ctx, run, code, message, execution)
	// Persist the provider's full error in the terminal snapshot so a client
	// that missed the separate run_error event can still render the cause.
	_, _ = h.finishTerminal(ctx, run.ID, RunStateFailed, message, code, execution)
}

func (h *AgentRunHarness) finishExhausted(ctx context.Context, run RunSnapshot, execution *runExecution, reason string) {
	if execution != nil && execution.terminal.Swap(true) {
		return
	}
	_, _ = h.finishTerminal(ctx, run.ID, RunStateExhausted, reason, reason, execution)
}

func (h *AgentRunHarness) finishCanceled(ctx context.Context, runID, reason string, executions ...*runExecution) {
	h.finishCanceledForControlCommand(ctx, runID, reason, "", executions...)
}

func (h *AgentRunHarness) finishCanceledForControlCommand(ctx context.Context, runID, reason, commandID string, executions ...*runExecution) {
	h.mu.Lock()
	execution := h.runs[runID]
	h.mu.Unlock()
	if len(executions) > 0 && executions[0] != nil {
		execution = executions[0]
	}
	if execution != nil && execution.terminal.Swap(true) {
		return
	}
	_, _ = h.finishTerminalForControlCommand(ctx, runID, RunStateCanceled, reason, reason, commandID, execution)
}

func (h *AgentRunHarness) finishTerminal(ctx context.Context, runID string, state RunState, reason, errorCode string, executions ...*runExecution) (RunSnapshot, error) {
	return h.finishTerminalForControlCommand(ctx, runID, state, reason, errorCode, "", executions...)
}

func (h *AgentRunHarness) finishTerminalForControlCommand(ctx context.Context, runID string, state RunState, reason, errorCode, commandID string, executions ...*runExecution) (RunSnapshot, error) {
	run, err := h.ledger.GetRun(ctx, runID)
	if err != nil {
		return RunSnapshot{}, err
	}
	if run.State.Terminal() {
		return run, nil
	}
	payload := TerminalEvent{Reason: reason, ErrorCode: errorCode}
	owner := ""
	if len(executions) > 0 && executions[0] != nil {
		owner = executions[0].ownerToken()
	}
	// Cancellation is a two-step transition for every non-terminal state. This
	// preserves the invariant that a terminal event is never emitted directly
	// from queued/running/approval/tool states.
	if state == RunStateCanceled && run.State != RunStateCanceling {
		intermediate, transitionErr := h.ledger.AppendEvent(ctx, AppendEventRequest{RunID: runID, ExpectedRevision: run.Revision, Kind: EventCheckpoint, ResultingState: RunStateCanceling, Payload: CheckpointEvent{Sequence: run.NextSequence - 1}, OwnerToken: owner})
		if transitionErr != nil {
			if errors.Is(transitionErr, ErrTerminalRun) || errors.Is(transitionErr, ErrRevisionConflict) {
				return h.ledger.GetRun(ctx, runID)
			}
			return RunSnapshot{}, transitionErr
		}
		h.publish(intermediate)
		run, err = h.ledger.GetRun(ctx, runID)
		if err != nil {
			return RunSnapshot{}, err
		}
	}
	event, err := h.ledger.AppendEvent(ctx, AppendEventRequest{RunID: runID, ExpectedRevision: run.Revision, Kind: EventTerminal, ResultingState: state, Payload: payload, TerminalReason: reason, OwnerToken: owner, AppliedControlCommandID: commandID})
	if err != nil {
		if errors.Is(err, ErrTerminalRun) || errors.Is(err, ErrRevisionConflict) {
			return h.ledger.GetRun(ctx, runID)
		}
		return RunSnapshot{}, err
	}
	h.publish(event)
	return h.ledger.GetRun(ctx, runID)
}

func (h *AgentRunHarness) awaitApproval(ctx context.Context, run RunSnapshot, intent ToolIntent, execution *runExecution) (bool, error) {
	if execution == nil {
		return false, errors.New("approval requires a run owner")
	}
	// Move the run to awaiting_approval first. The approval is bound to the
	// resulting revision; creating it before this transition made every later
	// decision stale immediately.
	current := run
	approvalID := uuid.NewString()
	approvalArgs := intent.Arguments
	if len(approvalArgs) == 0 {
		approvalArgs = json.RawMessage(`{}`)
	}
	argsHash := ArgsHash(approvalArgs)
	var err error
	if current.State != RunStateAwaitingApproval {
		_, err = h.appendState(ctx, current, EventApproval, RunStateAwaitingApproval, newApprovalEvent(approvalID, intent.CallID, intent.ToolName, intent.Effect, argsHash, h.initialApprovalDecision(ctx, run, intent)), execution, "")
		if err != nil {
			return false, err
		}
		current, err = h.refreshRun(ctx, run.ID)
		if err != nil {
			return false, err
		}
	}
	approval, err := h.ledger.CreateApproval(ctx, PutApprovalRequest{ApprovalID: approvalID, RunID: run.ID, CallID: intent.CallID, ToolName: intent.ToolName, Effect: intent.Effect, Arguments: approvalArgs, RunRevision: current.Revision, OwnerToken: execution.ownerToken()})
	if err != nil {
		return false, err
	}
	if h.approvals != nil {
		decision, handlerErr := h.approvals.Request(ctx, ApprovalRequest{ApprovalID: approval.ApprovalID, RunID: run.ID, CallID: intent.CallID, ToolName: intent.ToolName, Effect: intent.Effect, Arguments: intent.Arguments, ArgsHash: approval.ArgsHash, RunRevision: current.Revision})
		if handlerErr == nil {
			decisionValue := strings.ToLower(strings.TrimSpace(decision.Decision))
			if decisionValue != "approved" && decisionValue != "denied" {
				return false, fmt.Errorf("invalid approval decision %q", decision.Decision)
			}
			_, handlerErr = h.ledger.DecideApproval(ctx, DecideApprovalRequest{
				ApprovalID: approval.ApprovalID, Decision: decisionValue,
				ExpectedRunRevision: current.Revision,
				ExpectedRunID:       run.ID, ExpectedCallID: intent.CallID,
				ExpectedArgsHash: approval.ArgsHash,
			})
			if handlerErr != nil {
				return false, handlerErr
			}
		} else if errors.Is(handlerErr, ErrApprovalPending) {
			// Non-interactive adapters use this signal to hand control back to
			// their caller after the approval has been durably recorded. Waiting
			// here would make a piped CLI invocation hang indefinitely and would
			// also keep a lease unnecessarily long.
			return false, ErrApprovalPending
		} else {
			return false, handlerErr
		}
	}
	for {
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
		if execution.hasSteer() {
			// Invalidate the exact approval before applying the new instruction.
			_, _ = h.ledger.DecideApproval(h.durableContext(), DecideApprovalRequest{
				ApprovalID: approval.ApprovalID, Decision: "expired",
				ExpectedRunRevision: current.Revision,
				ExpectedRunID:       run.ID, ExpectedCallID: intent.CallID,
				ExpectedArgsHash: approval.ArgsHash,
			})
			return false, ErrRunSteered
		}
		h.settleAutoApproval(ctx, run, intent, approval, current.Revision)
		// Commands can arrive from a different desktop/CLI process while the
		// approval card is open.
		h.consumeControlCommands(ctx, execution)
		decision, decisionErr := h.ledger.GetApproval(ctx, approval.ApprovalID)
		if decisionErr != nil {
			return false, decisionErr
		}
		if decision.Status == "approved" || decision.Status == "denied" || decision.Status == "expired" {
			latest, latestErr := h.refreshRun(ctx, run.ID)
			if latestErr != nil {
				return false, latestErr
			}
			nextState := RunStateRunningTool
			if decision.Status != "approved" {
				nextState = RunStateRunningModel
			}
			_, transitionErr := h.appendState(ctx, latest, EventApproval, nextState, newApprovalEvent(approval.ApprovalID, approval.CallID, approval.ToolName, approval.Effect, approval.ArgsHash, decision.Status), execution, "")
			if transitionErr != nil && !errors.Is(transitionErr, ErrTerminalRun) {
				return false, transitionErr
			}
			return decision.Status == "approved", nil
		}
		timer := time.NewTimer(h.pollInterval())
		select {
		case <-ctx.Done():
			timer.Stop()
			return false, ctx.Err()
		case <-execution.wake:
			timer.Stop()
		case <-timer.C:
		}
	}
}
