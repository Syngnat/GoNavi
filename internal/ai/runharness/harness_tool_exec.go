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

func (h *AgentRunHarness) executeTool(ctx context.Context, run RunSnapshot, intent ToolIntent, execution *runExecution, ownerToken string) (ToolExecutionResult, error) {
	return h.executeToolWithRecord(ctx, run, intent, execution, ownerToken, nil, false)
}

// executeToolWithRecord executes a new tool invocation or resumes a durable
// started invocation. A safe recovery (pure/read-only/idempotent) passes the
// existing record and retry=false, which skips StartTool and keeps its attempt;
// an explicit recovery retry passes retry=true, creating a fresh attempt while
// retaining the old unknown-side-effect row for audit.
func (h *AgentRunHarness) executeToolWithRecord(ctx context.Context, run RunSnapshot, intent ToolIntent, execution *runExecution, ownerToken string, pending *ToolCallRecord, retry bool) (ToolExecutionResult, error) {
	if !run.AllowTools {
		return ToolExecutionResult{Status: "failed", ErrorCode: "tool_calls_disabled"}, ErrToolCallsDisabled
	}
	if h.tools == nil {
		return ToolExecutionResult{Status: "failed", ErrorCode: "tool_catalog_unavailable"}, ErrToolNotFound
	}
	if pending != nil {
		if strings.TrimSpace(pending.RunID) != "" && pending.RunID != run.ID {
			return ToolExecutionResult{Status: "failed", ErrorCode: "tool_conflict"}, fmt.Errorf("%w: pending tool belongs to another run", ErrToolConflict)
		}
		if strings.TrimSpace(pending.CallID) != "" && pending.CallID != intent.CallID {
			return ToolExecutionResult{Status: "failed", ErrorCode: "tool_conflict"}, fmt.Errorf("%w: pending call ID mismatch", ErrToolConflict)
		}
		if strings.TrimSpace(pending.ToolName) != "" && pending.ToolName != intent.ToolName {
			return ToolExecutionResult{Status: "failed", ErrorCode: "tool_conflict"}, fmt.Errorf("%w: pending tool name mismatch", ErrToolConflict)
		}
		if len(intent.Arguments) == 0 {
			intent.Arguments = append(json.RawMessage(nil), pending.Arguments...)
		}
		if len(pending.Arguments) > 0 && !jsonEqualRaw(intent.Arguments, pending.Arguments) {
			return ToolExecutionResult{Status: "failed", ErrorCode: "tool_conflict"}, fmt.Errorf("%w: pending tool arguments changed", ErrToolConflict)
		}
		if !retry && pending.Status != "started" {
			// A completion may race a recovery worker. Return the durable result
			// without invoking the executor again; the caller will use the persisted
			// message projection on its next read.
			return ToolExecutionResult{Status: pending.Status, ResultJSON: append(json.RawMessage(nil), pending.Result...), ErrorCode: pending.ErrorCode, UnknownOutcome: pending.UnknownOutcome, Truncated: pending.Truncated, OriginalBytes: pending.OriginalBytes, MessagePersisted: true}, nil
		}
		if !retry && pending.Effect != "" && intent.Effect.Valid() && pending.Effect != intent.Effect {
			return ToolExecutionResult{Status: "failed", ErrorCode: "tool_conflict"}, fmt.Errorf("%w: pending tool effect changed", ErrToolConflict)
		}
	}
	var (
		descriptor    ToolDescriptor
		executor      ToolExecutor
		catalogErr    error
		err           error
		frozenCatalog []ToolDescriptor
		catalogLoaded bool
	)
	if execution != nil {
		frozenCatalog, catalogLoaded = execution.frozenToolCatalog()
	}
	if catalogLoaded {
		descriptor, executor, catalogErr = h.resolveToolForRunWithDescriptors(ctx, run, frozenCatalog, intent.ToolName)
	} else {
		descriptor, executor, catalogErr = h.resolveToolForRun(ctx, run, intent.ToolName)
	}
	err = catalogErr
	if err != nil || executor == nil {
		if err == nil {
			err = ErrToolNotFound
		}
		return ToolExecutionResult{Status: "failed", ErrorCode: toolCatalogErrorCode(err)}, err
	}
	if err := validateToolArguments(descriptor.InputSchema, intent.Arguments); err != nil {
		return ToolExecutionResult{Status: "failed", ErrorCode: "malformed_tool_call"}, err
	}
	resolvedEffect := ToolEffect("")
	if resolver, ok := h.tools.(ToolEffectResolver); ok {
		if effect, resolveErr := resolver.ResolveEffect(ctx, intent.ToolName, intent.Arguments); resolveErr != nil {
			return ToolExecutionResult{Status: "failed", ErrorCode: "tool_effect"}, resolveErr
		} else if effect.Valid() {
			resolvedEffect = effect
			intent.Effect = refineToolEffect(descriptor.Effect, effect)
		}
	}
	// The immutable descriptor is authoritative for the baseline effect. The
	// model-provided intent effect is untrusted and must not downgrade a call;
	// ResolveEffect may refine the conservative baseline for argument-dependent
	// tools such as execute_sql.
	effectiveEffect := descriptor.Effect
	if resolvedEffect.Valid() {
		effectiveEffect = refineToolEffect(descriptor.Effect, resolvedEffect)
	}
	if pending != nil && pending.Effect.Valid() {
		// The durable effect is authoritative for a resumed invocation. Dynamic
		// effect resolution may be unavailable after a restart, but it must never
		// silently downgrade a side-effecting record to read-only.
		if !retry {
			effectiveEffect = pending.Effect
		} else if pending.Effect != effectiveEffect && (pending.Effect == ToolEffectSideEffect || pending.Effect == ToolEffectSideEffectUnknown) {
			return ToolExecutionResult{Status: "failed", ErrorCode: "tool_conflict"}, fmt.Errorf("%w: retry effect changed", ErrToolConflict)
		}
	}
	run, err = h.ledger.GetRun(ctx, run.ID)
	if err != nil {
		return ToolExecutionResult{Status: "failed", ErrorCode: "ledger"}, err
	}
	snapshot := WorkspaceSnapshot{}
	var workspaceReference *WorkspaceSnapshotReference
	if pending != nil && pending.WorkspaceSnapshot != nil {
		workspaceReference = cloneWorkspaceSnapshotReference(pending.WorkspaceSnapshot)
		snapshot, run, err = h.workspaceForPendingTool(ctx, run, *pending.WorkspaceSnapshot, execution)
		if err != nil {
			return ToolExecutionResult{Status: "failed", ErrorCode: "workspace"}, err
		}
	} else if requiresWorkspaceSnapshot(descriptor) {
		if run.ContextSourceID == "" || run.ContextSourceInstanceID == "" {
			return ToolExecutionResult{Status: "failed", ErrorCode: "workspace_unavailable"}, ErrWorkspaceUnavailable
		}
		snapshot, run, err = h.workspaceForTool(ctx, run, execution)
		if err != nil {
			return ToolExecutionResult{Status: "failed", ErrorCode: "workspace"}, err
		}
		// Bind the exact live (or explicitly user-approved stale) snapshot to
		// the durable tool start. The same reference is copied into the tool
		// outcome event and checkpoint, making the executor's context auditable.
		workspaceReference = workspaceSnapshotReference(snapshot)
	}
	if execution != nil {
		if execution.shutdownRequested.Load() {
			return ToolExecutionResult{Status: "canceled", ErrorCode: "harness_shutdown"}, context.Canceled
		}
		if execution.cancelRequested.Load() {
			return ToolExecutionResult{Status: "canceled", ErrorCode: "canceled"}, context.Canceled
		}
		if execution.hasSteer() {
			return ToolExecutionResult{Status: "canceled", ErrorCode: "steered"}, ErrRunSteered
		}
	}
	attempt := run.Attempt
	if attempt < 1 {
		attempt = 1
	}
	if pending != nil && !retry {
		attempt = pending.Attempt
		if attempt < 1 {
			return ToolExecutionResult{Status: "failed", ErrorCode: "tool_conflict"}, fmt.Errorf("%w: pending tool has no attempt", ErrToolConflict)
		}
	} else if pending != nil && retry {
		if pending.Attempt > 0 && attempt <= pending.Attempt {
			return ToolExecutionResult{Status: "failed", ErrorCode: "tool_conflict"}, fmt.Errorf("%w: retry attempt %d is not newer than %d", ErrToolConflict, attempt, pending.Attempt)
		}
	}
	if pending == nil || retry {
		// The start record is the external-operation fence. Check control state
		// immediately before it so a steer that arrived while validation or a
		// workspace lookup was in progress cannot launch an obsolete call.
		if execution != nil {
			h.consumeControlCommands(ctx, execution)
			if execution.shutdownRequested.Load() {
				return ToolExecutionResult{Status: "canceled", ErrorCode: "harness_shutdown"}, context.Canceled
			}
			if execution.cancelRequested.Load() {
				return ToolExecutionResult{Status: "canceled", ErrorCode: "canceled"}, context.Canceled
			}
			if execution.hasSteer() {
				return ToolExecutionResult{Status: "canceled", ErrorCode: "steered"}, ErrRunSteered
			}
		}
		started, err := h.ledger.StartToolAndEvent(ctx, StartToolAndEventRequest{
			StartToolRequest: StartToolRequest{RunID: run.ID, CallID: intent.CallID, Attempt: attempt, ToolName: intent.ToolName, Effect: effectiveEffect, Arguments: intent.Arguments, WorkspaceSnapshot: workspaceReference, ExpectedRevision: run.Revision, OwnerToken: ownerToken},
			ToolEvent:        ToolEvent{CallID: intent.CallID, ToolName: intent.ToolName, Effect: effectiveEffect, Status: "started"},
		})
		if err != nil {
			return ToolExecutionResult{Status: "failed", ErrorCode: "tool_start"}, err
		}
		// The ledger commit is the executor's start fence. Publish only after
		// it succeeds so event consumers never observe an un-recoverable tool.
		if !started.AlreadyStarted && started.Event.Sequence > 0 {
			h.publish(started.Event)
		}
	}
	toolCtx, stepCancel := context.WithCancel(ctx)
	if execution != nil {
		execution.setStepCancel(stepCancel)
	}
	defer func() {
		if execution != nil {
			execution.clearStepCancel(stepCancel)
			return
		}
		stepCancel()
	}()
	toolTimeout := descriptor.DefaultTimeout
	if toolTimeout <= 0 {
		toolTimeout = run.Policy.DefaultToolTimeout
	}
	if toolTimeout > 0 {
		var cancel context.CancelFunc
		toolCtx, cancel = context.WithTimeout(toolCtx, toolTimeout)
		defer cancel()
	}
	result, execErr := executor.Execute(toolCtx, ToolExecutionRequest{RunID: run.ID, CallID: intent.CallID, Attempt: attempt, ToolName: intent.ToolName, Effect: effectiveEffect, Arguments: intent.Arguments, Context: snapshot, Idempotency: fmt.Sprintf("%s:%s:%d", run.ID, intent.CallID, attempt)})
	status := result.Status
	if status == "" {
		status = "completed"
		if execErr != nil {
			status = "failed"
		}
	}
	if effectiveEffect == ToolEffectSideEffect || effectiveEffect == ToolEffectSideEffectUnknown {
		// Unknown means the external operation may have committed even when
		// an executor returned nil (for example, a driver reports the result
		// through a side channel). Treat the marker as authoritative.
		if result.UnknownOutcome || (execErr != nil && (errors.Is(execErr, context.Canceled) || errors.Is(execErr, context.DeadlineExceeded))) {
			result.UnknownOutcome = true
			status = "unknown"
			if result.ErrorCode == "" {
				result.ErrorCode = "outcome_unknown"
			}
		}
	}
	// Encode the outcome exactly once before it enters the durable boundary.
	// The smaller positive cap declared by the tool and frozen in the run policy
	// wins; a zero descriptor cap means that only the policy cap applies.
	encodedResult := encodeToolResult(result, execErr, effectiveToolResultBytes(run.Policy, descriptor))
	result.ResultJSON = append(json.RawMessage(nil), encodedResult.JSON...)
	result.OriginalBytes = encodedResult.OriginalBytes
	result.Truncated = encodedResult.Truncated
	finishCtx := ctx
	if finishCtx == nil || finishCtx.Err() != nil {
		finishCtx = h.durableContext()
	}
	latest, latestErr := h.ledger.GetRun(finishCtx, run.ID)
	if latestErr != nil {
		// Do not expose a successful executor result before its durable tool
		// completion has been committed. The outer loop must not append a
		// message for a result that has no corresponding tool/checkpoint/event.
		return result, latestErr
	}
	if latestErr == nil {
		toolMessage := &Message{ID: uuid.NewString(), SessionID: run.SessionID, RunID: run.ID, Role: "tool", ToolCallID: intent.CallID, Content: string(encodedResult.JSON), CreatedAt: time.Now().UTC()}
		finished, finishErr := h.ledger.FinishToolAndEvent(finishCtx, FinishToolAndEventRequest{
			FinishToolRequest: FinishToolRequest{RunID: run.ID, CallID: intent.CallID, Attempt: attempt, Status: status, Result: result.Value, ResultJSON: encodedResult.JSON, ErrorCode: result.ErrorCode, UnknownOutcome: result.UnknownOutcome, Truncated: encodedResult.Truncated, OriginalBytes: encodedResult.OriginalBytes, MaxResultBytes: effectiveToolResultBytes(run.Policy, descriptor), ExpectedRevision: latest.Revision, OwnerToken: ownerToken},
			WorkspaceSnapshot: workspaceReference,
			ResultingState: func() RunState {
				if status == "unknown" {
					return RunStateRecoveryRequired
				}
				return RunStateRunningModel
			}(),
			ToolEvent:   ToolEvent{CallID: intent.CallID, ToolName: intent.ToolName, Effect: effectiveEffect, Status: status, ErrorCode: result.ErrorCode, Result: encodedResult.JSON, Truncated: encodedResult.Truncated, OriginalBytes: encodedResult.OriginalBytes},
			ToolMessage: toolMessage,
		})
		if finishErr != nil {
			return result, finishErr
		}
		if finished.Event.Sequence > 0 {
			h.publish(finished.Event)
		}
		if finished.AlreadyFinished {
			// The durable message was appended by the earlier completion. The
			// caller's in-memory projection already contains it (or will reload it
			// from the ledger after a process boundary), so suppress the fallback
			// append that would otherwise duplicate the tool message.
			result.MessagePersisted = true
		} else if finished.Message.ID != "" {
			result.Message = &finished.Message
		}
	}
	if execErr != nil {
		return result, execErr
	}
	return result, nil
}
