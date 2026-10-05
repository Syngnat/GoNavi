package runharness

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
)

func (h *AgentRunHarness) run(execution *runExecution) {
	ctx := execution.ctx
	run, err := h.ledger.GetRun(ctx, execution.runID)
	if err != nil {
		return
	}
	// FIFO is persisted in the ledger, so a second process cannot bypass an
	// earlier queued run for the same session.
	if !h.waitForFIFO(ctx, execution, run) {
		if ctx.Err() != nil {
			h.finishCanceled(h.durableContext(), run.ID, "harness_shutdown", execution)
		}
		return
	}
	lease, err := h.acquireLease(ctx, execution, run)
	if err != nil {
		return
	}
	execution.setLease(lease)
	leaseCtx, stopLease := context.WithCancel(ctx)
	defer stopLease()
	defer func() { _ = h.ledger.ReleaseLease(h.durableContext(), lease) }()
	go h.leaseHeartbeat(leaseCtx, execution)
	execution.started.Store(true)
	if execution.shutdownRequested.Load() || execution.leaseLost.Load() {
		h.finishCanceled(h.durableContext(), run.ID, "harness_shutdown", execution)
		return
	}
	// Acquiring a lease increments the revision; always re-read before the
	// first CAS transition.
	run, err = h.refreshRun(ctx, run.ID)
	if err != nil {
		return
	}
	if run.State == RunStateQueued {
		run, err = h.appendState(ctx, run, EventInput, RunStateRunningModel, InputEvent{RequestID: run.RequestID, DispatchMode: DispatchQueue}, execution, "")
		if err != nil {
			return
		}
	}
	messages, err := h.messagesForRun(ctx, run)
	if err != nil {
		h.failRun(h.durableContext(), run, "ledger", err, execution)
		return
	}
	// Read the complete durable boundary after the lease is acquired. This
	// single transaction chooses the executable checkpoint and any in-flight
	// tool/approval record, so a process restart cannot accidentally regenerate a
	// provider turn that already emitted a tool intent.
	resume, resumeErr := h.ledger.LoadRunResumeContext(ctx, run.ID)
	if resumeErr != nil {
		h.failRun(h.durableContext(), run, "ledger", resumeErr, execution)
		return
	}
	run = resume.Run
	policy := run.Policy.Normalize()
	// Load the immutable tool projection once for this worker. Every model turn
	// and recovery path below reuses this snapshot; only the executable lookup
	// is allowed to touch the live catalog, and it is fenced against drift.
	frozenToolDescriptors, toolsErr := h.toolDescriptorsForRun(ctx, run)
	if toolsErr != nil {
		h.failRun(h.durableContext(), run, "tool_catalog", toolsErr, execution)
		return
	}
	execution.setToolCatalog(frozenToolDescriptors)
	toolRounds, failedToolRounds := h.resumeToolCounters(ctx, run.ID)
	modelRetries, malformedRetries, outputContinuations := 0, 0, 0
	providerState := json.RawMessage(nil)
	conversationCursor := ""
	if resume.Checkpoint != nil {
		providerState = cloneRaw(resume.Checkpoint.ProviderState)
		conversationCursor = resume.Checkpoint.ConversationCursor
	}
	if run.State == RunStateAwaitingWorkspace {
		run, err = h.waitForWorkspaceSource(ctx, run, execution)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				h.finishCanceled(h.durableContext(), run.ID, "canceled", execution)
			} else {
				h.failRun(h.durableContext(), run, "workspace", err, execution)
			}
			return
		}
	}
	// A non-interactive adapter may have intentionally released its worker while
	// an approval remained pending. When another process decides that approval,
	// restart from the durable approval record instead of asking the provider to
	// regenerate the same tool call (which could duplicate a side effect or
	// produce an invalid assistant/tool pairing).
	if resume.PendingApproval != nil || run.State == RunStateAwaitingApproval {
		resumed, approvalResumeErr := h.resumeAwaitingApproval(ctx, &run, &messages, execution)
		if approvalResumeErr != nil {
			h.failRun(h.durableContext(), run, "approval", approvalResumeErr, execution)
			return
		}
		if !resumed {
			// No durable decision exists yet. This can occur when Start is called
			// by an observer process; leave the run waiting without holding a lease.
			return
		}
	}
	// Finish a tool whose StartTool record was committed before the process
	// stopped. Safe effects may be replayed with the same attempt/idempotency
	// key; unknown side effects are fenced until the user chooses recovery.
	pendingTool := resume.PendingTool
	if pendingTool == nil && resume.PendingUnknownTool != nil && run.State == RunStateRunningModel && resume.PendingUnknownTool.Attempt < run.Attempt {
		// ControlRecover advances the run attempt but deliberately leaves the old
		// unknown record in place. Use that record as the retry intent.
		pendingTool = resume.PendingUnknownTool
	}
	if pendingTool != nil && (pendingTool.Status == "started" || pendingTool.Status == "unknown") {
		pending := pendingTool
		if toolHasUnknownSideEffect(*pending) {
			if run.State == RunStateRunningModel && pending.Attempt < run.Attempt {
				// ControlRecover explicitly advanced the run attempt. Retry the
				// exact old intent under the new attempt while retaining its audit row.
				intent := toolIntentFromRecord(*pending)
				execution.sideEffect.Store(true)
				toolResult, toolErr := h.executeToolWithRecord(ctx, run, intent, execution, execution.ownerToken(), pending, true)
				execution.sideEffect.Store(false)
				if toolErr != nil && isToolCatalogContractError(toolErr) {
					h.failRun(h.durableContext(), run, toolCatalogErrorCode(toolErr), toolErr, execution)
					return
				}
				if toolResult.Message != nil {
					messages = append(messages, *toolResult.Message)
				} else if !toolResult.MessagePersisted {
					if appendErr := h.appendToolResultMessage(&run, &messages, intent.CallID, toolResult, toolErr); appendErr != nil {
						h.failRun(h.durableContext(), run, "ledger", appendErr, execution)
						return
					}
				}
				if toolResult.UnknownOutcome {
					return
				}
			} else {
				// A live worker can discover an unknown started call before the
				// recovery scanner. Persist the fence immediately so observers get a
				// stable recovery_required state.
				if run.State != RunStateRecoveryRequired && !run.State.Terminal() {
					if fenced, fenceErr := h.appendState(h.durableContext(), run, EventCheckpoint, RunStateRecoveryRequired, CheckpointEvent{Sequence: run.NextSequence - 1}, execution, ""); fenceErr == nil {
						run = fenced
					}
				}
				return
			}
		} else if run.State != RunStateRecoveryRequired {
			if run.State != RunStateRunningTool {
				transitioned, transitionErr := h.appendState(ctx, run, EventCheckpoint, RunStateRunningTool, CheckpointEvent{Sequence: run.NextSequence - 1}, execution, "")
				if transitionErr != nil {
					h.failRun(h.durableContext(), run, "recovery", transitionErr, execution)
					return
				}
				run = transitioned
			}
			intent := toolIntentFromRecord(*pending)
			toolResult, toolErr := h.executeToolWithRecord(ctx, run, intent, execution, execution.ownerToken(), pending, false)
			if toolErr != nil && isToolCatalogContractError(toolErr) {
				h.failRun(h.durableContext(), run, toolCatalogErrorCode(toolErr), toolErr, execution)
				return
			}
			if toolResult.Message != nil {
				messages = append(messages, *toolResult.Message)
			} else if !toolResult.MessagePersisted {
				if appendErr := h.appendToolResultMessage(&run, &messages, intent.CallID, toolResult, toolErr); appendErr != nil {
					h.failRun(h.durableContext(), run, "ledger", appendErr, execution)
					return
				}
			}
			// The next model turn must observe the durable tool result. Any
			// executor error is represented in that result and does not cause a
			// second invocation of the same attempt.
		}
	}
	for {
		if execution.leaseLost.Load() {
			// The lease fence, rather than this worker, now owns the recovery
			// decision. Any started side effect is picked up by RecoverRuns.
			return
		}
		if ctx.Err() != nil {
			h.finishCanceled(h.durableContext(), run.ID, "canceled", execution)
			return
		}
		if h.consumeControlCommands(ctx, execution) {
			if ctx.Err() != nil {
				h.finishCanceled(h.durableContext(), run.ID, "canceled", execution)
				return
			}
		}
		if steer := execution.takeSteerRequest(); steer.content != "" {
			if err := h.supersedeAndSteer(ctx, &run, &messages, nil, steer.content, steer.requestID, steer.transitionExpectedRevision(), execution); err != nil {
				h.failRun(h.durableContext(), run, "steer", err, execution)
				return
			}
			continue
		}
		if execution.cancelRequested.Load() && !execution.sideEffect.Load() {
			h.finishCanceled(h.durableContext(), run.ID, "canceled", execution)
			return
		}
		if execution.shutdownRequested.Load() {
			h.finishCanceled(h.durableContext(), run.ID, "harness_shutdown", execution)
			return
		}
		run, err = h.refreshRun(ctx, run.ID)
		if err != nil {
			return
		}
		if policy.MaxToolRounds > 0 && toolRounds >= policy.MaxToolRounds {
			h.finishExhausted(ctx, run, execution, "max_tool_rounds")
			return
		}
		if policy.MaxActiveDuration > 0 && time.Duration(run.ActiveDurationMS)*time.Millisecond >= policy.MaxActiveDuration {
			h.finishExhausted(ctx, run, execution, "max_active_duration")
			return
		}
		// Re-read the durable transcript for every model turn. The in-memory slice
		// is only a convenience for approval/recovery paths; the Ledger remains the
		// complete source of truth across workers and processes.
		messages, err = h.messagesForRun(ctx, run)
		if err != nil {
			h.failRun(h.durableContext(), run, "ledger", err, execution)
			return
		}
		descriptors := frozenToolDescriptors
		// A bound workspace source is required for every model turn, even when the
		// selected tool set happens not to need workspace capabilities. This keeps
		// the model projection tied to the same live desktop/CLI context as tools.
		var workspaceSnapshot *WorkspaceSnapshot
		var workspaceReference *WorkspaceSnapshotReference
		if strings.TrimSpace(run.ContextSourceID) != "" || strings.TrimSpace(run.ContextSourceInstanceID) != "" {
			snapshot, latestRun, workspaceErr := h.workspaceForModel(ctx, run, execution)
			if workspaceErr != nil {
				if errors.Is(workspaceErr, context.Canceled) || errors.Is(workspaceErr, context.DeadlineExceeded) {
					h.finishCanceled(h.durableContext(), run.ID, "canceled", execution)
				} else {
					h.failRun(h.durableContext(), run, "workspace", workspaceErr, execution)
				}
				return
			}
			run = latestRun
			workspaceSnapshot = &snapshot
			workspaceReference = workspaceSnapshotReference(snapshot)
			if workspaceReference == nil {
				h.failRun(h.durableContext(), run, "workspace", ErrWorkspaceUnavailable, execution)
				return
			}
		}

		built, providerBinding, ok := h.buildModelContext(ctx, run, execution, modelContextInput{
			Messages: messages, Tools: descriptors,
			WorkspaceSnapshot: workspaceSnapshot, WorkspaceReference: workspaceReference,
			ConversationCursor: conversationCursor, ProviderState: providerState,
		})
		if !ok {
			return
		}
		request := built.Request
		request.ProviderBinding = providerBinding
		// Compression intentionally disables tools for this turn. A compressed
		// projection may omit an earlier assistant/tool pairing, so allowing a
		// fresh tool intent would violate provider protocol invariants.
		allowToolsForTurn := run.AllowTools && !built.Compression.Applied
		if !allowToolsForTurn {
			request.Tools = nil
		}
		reservation, reservationErr := h.reserveModelTurn(ctx, run, execution)
		if reservationErr != nil {
			if errors.Is(reservationErr, ErrTokenBudgetExceeded) {
				h.finishExhausted(h.durableContext(), run, execution, "max_total_tokens")
			} else {
				h.failRun(h.durableContext(), run, "token_budget", reservationErr, execution)
			}
			return
		}
		// ReserveTokens advances the run revision; use its revision for the
		// provider-turn CAS and refresh the remaining projection fields.
		run, err = h.refreshRun(ctx, run.ID)
		if err != nil {
			_ = h.releaseModelReservation(h.durableContext(), run.ID, reservation.ID, execution.ownerToken())
			return
		}
		stepCtx, stepCancel := context.WithCancel(ctx)
		execution.setStepCancel(stepCancel)
		startedAt := time.Now()
		result, modelErr := h.executeModel(stepCtx, request, run, execution)
		execution.clearStepCancel(stepCancel)
		h.addActiveDuration(h.durableContext(), run.ID, time.Since(startedAt), execution.ownerToken())
		if modelErr != nil {
			// No successful model turn will consume this reservation. Reconcile
			// with zero usage before retrying or terminating so reserved capacity
			// cannot leak across attempts.
			_ = h.releaseModelReservation(h.durableContext(), run.ID, reservation.ID, execution.ownerToken())
			if execution.leaseLost.Load() {
				return
			}
			if ctx.Err() != nil || execution.cancelRequested.Load() {
				h.finishCanceled(h.durableContext(), run.ID, "canceled", execution)
				return
			}
			if execution.hasSteer() {
				_ = h.consumeControlCommands(ctx, execution)
				continue
			}
			// Only retry errors that are known to be transient. Once this run has
			// committed a tool intent/result, replaying the model request can
			// duplicate a side effect or send an invalid assistant/tool pairing.
			if modelRetries < policy.MaxModelRetriesPerTurn &&
				IsRetryableModelError(modelErr) && !hasCommittedTool(messages, run.ID) {
				modelRetries++
				continue
			}
			h.failRun(h.durableContext(), run, classifyError(modelErr), modelErr, execution)
			return
		}
		modelRetries = 0
		// 被输出长度上限截断的一轮：工具调用参数可能只写了一半，不可信，直接丢弃；
		// 已生成的文本照常提交，稍后追加一条提示让模型接着写。
		droppedToolCall := false
		if result.Truncated && len(result.ToolCalls) > 0 {
			droppedToolCall = true
			result.ToolCalls = nil
		}
		if malformed := validateRunToolIntents(result.ToolCalls, descriptors, allowToolsForTurn); malformed != nil {
			_ = h.releaseModelReservation(h.durableContext(), run.ID, reservation.ID, execution.ownerToken())
			h.emitError(h.durableContext(), run, "malformed_tool_call", malformed.Error(), execution)
			if malformedRetries < 1 {
				malformedRetries++
				// Keep the repair signal outside the tool-call transcript. A
				// synthetic tool message/call ID can itself poison providers that
				// validate tool-call pairing. The text names the concrete reason:
				// a bare error code tells the model nothing about what to fix.
				repair := Message{ID: uuid.NewString(), SessionID: run.SessionID, RunID: run.ID, Role: "system", Content: malformedToolCallRepairPrompt(malformed), Metadata: json.RawMessage(`{"code":"malformed_tool_call"}`), CreatedAt: time.Now().UTC()}
				if appended, appendErr := h.ledger.AppendMessage(h.durableContext(), repair); appendErr == nil {
					messages = append(messages, appended)
				}
				continue
			}
			h.failRun(h.durableContext(), run, "malformed_tool_call", malformed, execution)
			return
		}
		malformedRetries = 0
		// Provider adapters intentionally leave effect unset: the catalog, rather
		// than model output, is the authority for side-effect classification. Fill
		// the baseline into every intent before the model completion is committed
		// so an immediate steer can durably supersede a whole batch without first
		// visiting each intent's normal execution path.
		normalizeToolIntentEffects(result.ToolCalls, descriptors)
		providerState = cloneRaw(result.ProviderState)
		run, err = h.refreshRun(ctx, run.ID)
		if err != nil {
			_ = h.releaseModelReservation(h.durableContext(), run.ID, reservation.ID, execution.ownerToken())
			return
		}
		var assistant *Message
		if result.Text != "" || result.Reasoning != "" || len(result.ToolCalls) > 0 {
			message := Message{ID: uuid.NewString(), SessionID: run.SessionID, RunID: run.ID, Role: "assistant", Content: result.Text, Reasoning: result.Reasoning, CreatedAt: time.Now().UTC()}
			if metadata, marshalErr := json.Marshal(struct {
				Usage Usage `json:"usage"`
			}{Usage: result.Usage}); marshalErr == nil {
				message.Metadata = metadata
			}
			if len(result.ToolCalls) > 0 {
				calls, _ := json.Marshal(result.ToolCalls)
				message.ToolCalls = calls
			}
			assistant = &message
		}
		compression := built.Compression
		if compression.Workspace == nil {
			compression.Workspace = cloneWorkspaceSnapshotReference(workspaceReference)
		}
		modelCompleted := ModelCompletedEvent{
			Text: result.Text, Reasoning: result.Reasoning, ToolCalls: result.ToolCalls, Usage: result.Usage,
			WorkspaceSnapshot: cloneWorkspaceSnapshotReference(workspaceReference), Compression: compression,
		}
		committed, commitErr := h.ledger.CommitModelTurn(ctx, CommitModelTurnRequest{
			RunID: run.ID, ExpectedRevision: run.Revision, OwnerToken: execution.ownerToken(),
			AssistantMessage: assistant,
			ModelCompleted:   modelCompleted,
			Usage:            result.Usage, ConversationCursor: conversationCursor, ProviderState: providerState, ResultingState: RunStateRunningModel,
			ReservationID: reservation.ID, WorkspaceSnapshot: cloneWorkspaceSnapshotReference(workspaceReference),
		})
		if commitErr != nil {
			_ = h.releaseModelReservation(h.durableContext(), run.ID, reservation.ID, execution.ownerToken())
			if errors.Is(commitErr, ErrTokenBudgetExceeded) {
				h.finishExhausted(h.durableContext(), run, execution, "max_total_tokens")
			} else {
				h.failRun(h.durableContext(), run, "ledger", commitErr, execution)
			}
			return
		}
		run = committed.Run
		if committed.Message != nil {
			messages = append(messages, *committed.Message)
		}
		for _, event := range committed.Events {
			h.publish(event)
		}
		// Advance the provider cursor only after the model turn has crossed the
		// atomic ledger boundary.
		conversationCursor = committed.Checkpoint.ConversationCursor
		if result.Truncated {
			// 截断不是失败：保留已生成的部分，提示模型从中断处继续，而不是让整个对话中断。
			// 连续多次仍被截断说明单次输出确实过长，才放弃并给出明确的错误类别。
			if outputContinuations >= maxOutputContinuations {
				h.failRun(h.durableContext(), run, ModelErrorOutputLimit, errOutputContinuationsExhausted, execution)
				return
			}
			outputContinuations++
			nudge := Message{ID: uuid.NewString(), SessionID: run.SessionID, RunID: run.ID, Role: "system", Content: outputContinuationPrompt(droppedToolCall), Metadata: json.RawMessage(`{"code":"output_truncated"}`), CreatedAt: time.Now().UTC()}
			appended, appendErr := h.ledger.AppendMessage(h.durableContext(), nudge)
			if appendErr != nil {
				h.failRun(h.durableContext(), run, "ledger", appendErr, execution)
				return
			}
			messages = append(messages, appended)
			continue
		}
		outputContinuations = 0
		if len(result.ToolCalls) == 0 {
			h.finishTerminal(h.durableContext(), run.ID, RunStateCompleted, "completed", "", execution)
			return
		}
		toolRounds++
		allToolsOK := true
		steeredBatch := false
		for intentIndex, intent := range result.ToolCalls {
			if execution.leaseLost.Load() {
				return
			}
			if execution.shutdownRequested.Load() && !execution.sideEffect.Load() {
				h.finishCanceled(h.durableContext(), run.ID, "harness_shutdown", execution)
				return
			}
			if ctx.Err() != nil {
				h.finishCanceled(h.durableContext(), run.ID, "canceled", execution)
				return
			}
			h.consumeControlCommands(ctx, execution)
			if execution.hasSteer() {
				if steer := execution.takeSteerRequest(); steer.content != "" {
					if steerErr := h.supersedeAndSteer(ctx, &run, &messages, result.ToolCalls[intentIndex:], steer.content, steer.requestID, steer.transitionExpectedRevision(), execution); steerErr != nil {
						h.failRun(h.durableContext(), run, "steer", steerErr, execution)
						return
					}
					steeredBatch = true
					break
				}
				continue
			}
			if execution.cancelRequested.Load() {
				h.finishCanceled(h.durableContext(), run.ID, "canceled", execution)
				return
			}
			if execution.shutdownRequested.Load() {
				h.finishCanceled(h.durableContext(), run.ID, "harness_shutdown", execution)
				return
			}
			run, err = h.refreshRun(ctx, run.ID)
			if err != nil {
				return
			}
			// Validate the live executable contract against the immutable binding
			// before deriving an approval effect. This keeps an approval tied to
			// the same schema/effect that was presented to the model at run start.
			var frozenDescriptor ToolDescriptor
			if run.AllowTools {
				var toolErr error
				frozenDescriptor, toolErr = h.validateToolForRunWithDescriptors(ctx, run, frozenToolDescriptors, intent.ToolName)
				if toolErr != nil {
					// Report a contract failure as a tool result so the model can recover
					// or choose another tool. The live implementation is never invoked
					// when its descriptor has drifted from the frozen binding.
					allToolsOK = false
					h.emitError(h.durableContext(), run, toolCatalogErrorCode(toolErr), toolErr.Error(), execution)
					failure := ToolExecutionResult{Status: "failed", ErrorCode: toolCatalogErrorCode(toolErr)}
					if appendErr := h.appendToolResultMessage(&run, &messages, intent.CallID, failure, toolErr); appendErr != nil {
						h.failRun(h.durableContext(), run, "ledger", appendErr, execution)
						return
					}
					continue
				}
				// The model cannot override the catalog's static effect. Dynamic
				// resolution below may refine a conservative descriptor (for example
				// execute_sql SELECT versus INSERT), but an intent-provided effect is
				// never trusted as an approval bypass.
				intent.Effect = frozenDescriptor.Effect
			}
			if resolver, ok := h.tools.(ToolEffectResolver); ok {
				if resolvedEffect, resolveErr := resolver.ResolveEffect(ctx, intent.ToolName, intent.Arguments); resolveErr != nil {
					allToolsOK = false
					h.emitError(h.durableContext(), run, "tool_effect", resolveErr.Error(), execution)
					failure := ToolExecutionResult{Status: "failed", ErrorCode: "tool_effect"}
					if appendErr := h.appendToolResultMessage(&run, &messages, intent.CallID, failure, resolveErr); appendErr != nil {
						h.failRun(h.durableContext(), run, "ledger", appendErr, execution)
						return
					}
					continue
				} else if resolvedEffect.Valid() {
					intent.Effect = refineToolEffect(intent.Effect, resolvedEffect)
				}
			}
			if intent.Effect == ToolEffectSideEffect || intent.Effect == ToolEffectSideEffectUnknown {
				approved, approvalErr := h.awaitApproval(ctx, run, intent, execution)
				if approvalErr != nil {
					if errors.Is(approvalErr, ErrApprovalPending) {
						// Non-interactive adapters deliberately leave the durable
						// approval pending and return control to their caller. A later
						// approve command starts a fresh owner worker.
						return
					}
					if errors.Is(approvalErr, ErrRunSteered) || execution.hasSteer() {
						if steer := execution.takeSteerRequest(); steer.content != "" {
							if steerErr := h.supersedeAndSteer(ctx, &run, &messages, result.ToolCalls[intentIndex:], steer.content, steer.requestID, steer.transitionExpectedRevision(), execution); steerErr != nil {
								h.failRun(h.durableContext(), run, "steer", steerErr, execution)
								return
							}
							steeredBatch = true
							break
						}
						continue
					}
					h.failRun(h.durableContext(), run, "approval", approvalErr, execution)
					return
				}
				if !approved {
					allToolsOK = false
					denied := Message{ID: uuid.NewString(), SessionID: run.SessionID, RunID: run.ID, Role: "tool", ToolCallID: intent.CallID, Content: `{"error":"approval_denied"}`, CreatedAt: time.Now().UTC()}
					if appended, appendErr := h.ledger.AppendMessage(ctx, denied); appendErr == nil {
						messages = append(messages, appended)
					}
					continue
				}
				// A steer/cancel may have arrived after the approval decision but
				// before this invocation crosses its durable start fence. Re-check
				// here so an approved, stale call cannot issue an external effect.
				h.consumeControlCommands(ctx, execution)
				if execution.hasSteer() {
					if steer := execution.takeSteerRequest(); steer.content != "" {
						if steerErr := h.supersedeAndSteer(ctx, &run, &messages, result.ToolCalls[intentIndex:], steer.content, steer.requestID, steer.transitionExpectedRevision(), execution); steerErr != nil {
							h.failRun(h.durableContext(), run, "steer", steerErr, execution)
							return
						}
						steeredBatch = true
						break
					}
					continue
				}
				if execution.cancelRequested.Load() {
					h.finishCanceled(h.durableContext(), run.ID, "canceled", execution)
					return
				}
				if execution.shutdownRequested.Load() {
					h.finishCanceled(h.durableContext(), run.ID, "harness_shutdown", execution)
					return
				}
			}
			execution.sideEffect.Store(intent.Effect == ToolEffectSideEffect || intent.Effect == ToolEffectSideEffectUnknown)
			toolStartedAt := time.Now()
			toolResult, toolErr := h.executeTool(ctx, run, intent, execution, execution.ownerToken())
			execution.sideEffect.Store(false)
			if execution.leaseLost.Load() {
				return
			}
			h.addActiveDuration(h.durableContext(), run.ID, time.Since(toolStartedAt), execution.ownerToken())
			// A steer may cancel a read-only/pure invocation while the executor is
			// returning, or may be observed immediately before its start fence. In
			// either case the remaining intents from this provider response must be
			// superseded as one batch; never fall through to the next intent.
			if errors.Is(toolErr, ErrRunSteered) || execution.hasSteer() {
				steer := execution.takeSteerRequest()
				if steer.content != "" {
					remaining := result.ToolCalls[intentIndex+1:]
					if toolResult.Message == nil && !toolResult.MessagePersisted {
						// No durable completion crossed the boundary, so include the
						// current intent as well and let the Ledger create its canceled
						// record/message. A completed tool is never relabeled here.
						remaining = result.ToolCalls[intentIndex:]
					}
					if steerErr := h.supersedeAndSteer(ctx, &run, &messages, remaining, steer.content, steer.requestID, steer.transitionExpectedRevision(), execution); steerErr != nil {
						h.failRun(h.durableContext(), run, "steer", steerErr, execution)
						return
					}
					if toolResult.Message != nil {
						messages = append(messages, *toolResult.Message)
					}
					steeredBatch = true
					break
				}
			}
			if toolErr != nil {
				allToolsOK = false
				if isToolCatalogContractError(toolErr) {
					// A live catalog may reload between model projection and execution.
					// Keep the run alive and expose a structured tool failure to the next
					// model turn, but never execute the drifted implementation.
					h.emitError(h.durableContext(), run, toolCatalogErrorCode(toolErr), toolErr.Error(), execution)
				}
			}
			if toolResult.Message != nil {
				// FinishToolAndEvent already appended this message in the same
				// transaction as the tool record/event/checkpoint.
				messages = append(messages, *toolResult.Message)
			} else if !toolResult.MessagePersisted {
				content := marshalToolResult(toolResult, toolErr)
				toolMessage := Message{ID: uuid.NewString(), SessionID: run.SessionID, RunID: run.ID, Role: "tool", ToolCallID: intent.CallID, Content: content, CreatedAt: time.Now().UTC()}
				if appended, appendErr := h.ledger.AppendMessage(h.durableContext(), toolMessage); appendErr != nil {
					h.failRun(h.durableContext(), run, "ledger", appendErr, execution)
					return
				} else {
					messages = append(messages, appended)
				}
			}
			// A side-effecting call whose outcome is unknown must stop the run at
			// the recovery seam. Continuing with another model turn could repeat
			// an operation that may already have reached the database.
			if toolResult.UnknownOutcome && (intent.Effect == ToolEffectSideEffect || intent.Effect == ToolEffectSideEffectUnknown) {
				return
			}
		}
		if steeredBatch {
			continue
		}
		if !allToolsOK {
			failedToolRounds++
			if policy.MaxConsecutiveFailedToolRounds > 0 && failedToolRounds >= policy.MaxConsecutiveFailedToolRounds {
				h.finishExhausted(ctx, run, execution, "failed_tool_rounds")
				return
			}
		} else {
			failedToolRounds = 0
		}
	}
}
