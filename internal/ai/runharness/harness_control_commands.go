package runharness

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
)

func (e *runExecution) hasSteer() bool {
	if e == nil {
		return false
	}
	if e.steerPending.Load() {
		return true
	}
	e.steerMu.Lock()
	defer e.steerMu.Unlock()
	return len(e.steers) > 0
}

func (e *runExecution) takeSteerRequest() steerRequest {
	if e == nil {
		return steerRequest{}
	}
	e.steerMu.Lock()
	defer e.steerMu.Unlock()
	if len(e.steers) == 0 {
		return steerRequest{}
	}
	value := e.steers[0]
	e.steers = e.steers[1:]
	if len(e.steers) == 0 {
		e.steerPending.Store(false)
	}
	return value
}

// takeSteer is retained as a small compatibility helper for low-level tests
// and callers that only need the text. Harness execution uses
// takeSteerRequest so the idempotency key is never discarded.
func (e *runExecution) takeSteer() string {
	return e.takeSteerRequest().content
}

func (e *runExecution) markControlClaim(id string) bool {
	if e == nil || strings.TrimSpace(id) == "" {
		return false
	}
	e.controlMu.Lock()
	defer e.controlMu.Unlock()
	if e.controlClaims == nil {
		e.controlClaims = make(map[string]struct{})
	}
	if _, exists := e.controlClaims[id]; exists {
		return false
	}
	e.controlClaims[id] = struct{}{}
	return true
}

func (e *runExecution) clearControlClaim(id string) {
	if e == nil || strings.TrimSpace(id) == "" {
		return
	}
	e.controlMu.Lock()
	delete(e.controlClaims, id)
	e.controlMu.Unlock()
}

func (e *runExecution) markStaleWorkspaceCommand(id string) {
	if e == nil || strings.TrimSpace(id) == "" {
		return
	}
	e.controlMu.Lock()
	if e.staleWorkspaceCommands == nil {
		e.staleWorkspaceCommands = make(map[string]struct{})
	}
	e.staleWorkspaceCommands[id] = struct{}{}
	e.controlMu.Unlock()
}

func (e *runExecution) staleWorkspaceCommandIDs() []string {
	if e == nil {
		return nil
	}
	e.controlMu.Lock()
	defer e.controlMu.Unlock()
	if len(e.staleWorkspaceCommands) == 0 {
		return nil
	}
	ids := make([]string, 0, len(e.staleWorkspaceCommands))
	for id := range e.staleWorkspaceCommands {
		ids = append(ids, id)
	}
	return ids
}

func (e *runExecution) clearStaleWorkspaceCommand(id string) {
	if e == nil || strings.TrimSpace(id) == "" {
		return
	}
	e.controlMu.Lock()
	delete(e.staleWorkspaceCommands, id)
	e.controlMu.Unlock()
}

func (h *AgentRunHarness) controlOwnerToken(execution *runExecution) string {
	if execution != nil {
		if token := strings.TrimSpace(execution.ownerToken()); token != "" {
			return token
		}
	}
	// Low-level tests and unleased runs do not have a fencing token. A stable
	// Harness owner still gives their command claims a durable identity; leased
	// workers always take the stronger run lease token above.
	return strings.TrimSpace(h.ownerID)
}

func (h *AgentRunHarness) ackControlCommand(execution *runExecution, commandID string) error {
	err := h.ledger.AckCommand(h.durableContext(), commandID, h.controlOwnerToken(execution))
	if err == nil || errors.Is(err, ErrNotFound) || errors.Is(err, ErrControlCommandClaimLost) {
		if execution != nil {
			execution.clearControlClaim(commandID)
		}
	}
	return err
}

func (h *AgentRunHarness) tombstoneControlCommand(execution *runExecution, commandID string) error {
	err := h.ledger.TombstoneCommand(h.durableContext(), commandID, h.controlOwnerToken(execution))
	if err == nil || errors.Is(err, ErrNotFound) || errors.Is(err, ErrControlCommandClaimLost) {
		if execution != nil {
			execution.clearControlClaim(commandID)
		}
	}
	return err
}

// ackStaleWorkspaceCommands completes explicit stale-snapshot approvals only
// after the worker has committed the state transition that makes the snapshot
// usable. A transient ledger failure leaves the IDs pending so the next poll
// can retry; a claim loss is safe to forget because another owner can reclaim
// the durable command.
func (h *AgentRunHarness) ackStaleWorkspaceCommands(execution *runExecution) {
	if h == nil || execution == nil {
		return
	}
	for _, commandID := range execution.staleWorkspaceCommandIDs() {
		err := h.ackControlCommand(execution, commandID)
		if err == nil || errors.Is(err, ErrNotFound) || errors.Is(err, ErrControlCommandClaimLost) {
			execution.clearStaleWorkspaceCommand(commandID)
		}
	}
}

// ackUnownedControlCommand is used for a queued run that is canceled before a
// worker can acquire a lease. Claiming and acknowledging in two durable steps
// preserves the same crash-recovery semantics as the normal worker path while
// avoiding a permanently replayable command on a terminal run.
func (h *AgentRunHarness) ackUnownedControlCommand(runID, commandID string) {
	if h == nil || h.ledger == nil || strings.TrimSpace(runID) == "" || strings.TrimSpace(commandID) == "" {
		return
	}
	ctx := h.durableContext()
	owner := h.controlOwnerToken(nil)
	commands, err := h.ledger.ClaimCommands(ctx, runID, owner, 32, h.leaseTTL)
	if err != nil {
		return
	}
	for _, command := range commands {
		if command.ID != commandID {
			continue
		}
		_ = h.ledger.AckCommand(ctx, commandID, owner)
		return
	}
}

// applyUnownedQueuedCancel handles the narrow window before a queued run has
// acquired a worker lease. The command is still claimed and revision-checked
// through the same Ledger boundary as an owned worker, so a stale queued
// cancel cannot terminally transition work that has already moved on.
func (h *AgentRunHarness) applyUnownedQueuedCancel(ctx context.Context, runID, commandID string) (RunSnapshot, error) {
	if h == nil || h.ledger == nil {
		return RunSnapshot{}, errors.New("agent harness ledger is required")
	}
	owner := h.controlOwnerToken(nil)
	commands, err := h.ledger.ClaimCommands(ctx, runID, owner, 1, h.leaseTTL)
	if err != nil {
		return RunSnapshot{}, err
	}
	claimed := false
	for _, command := range commands {
		if command.ID == commandID {
			claimed = true
			break
		}
	}
	if !claimed {
		return h.ledger.GetRun(ctx, runID)
	}

	result, err := h.ledger.ApplyCancelControlCommand(ctx, commandID, owner)
	if err != nil {
		return RunSnapshot{}, err
	}
	if result.Event != nil {
		h.publish(*result.Event)
	}
	if result.Stale || !result.Applied {
		return h.ledger.GetRun(ctx, runID)
	}
	return h.finishTerminal(ctx, runID, RunStateCanceled, "canceled", "canceled")
}

// consumeControlCommands applies commands submitted by another process. A
// command is first claimed with a short lease and acknowledged only after the
// durable action boundary succeeds. This keeps a crash between dequeue and
// application recoverable.
func (h *AgentRunHarness) consumeControlCommands(ctx context.Context, execution *runExecution) bool {
	if execution == nil {
		return false
	}
	commands, err := h.ledger.ClaimCommands(ctx, execution.runID, h.controlOwnerToken(execution), 32, h.leaseTTL)
	if err != nil {
		return false
	}
	for _, command := range commands {
		if !execution.markControlClaim(command.ID) {
			// The previous poll is still applying this command. ClaimCommands
			// renews its lease, but the in-memory action must remain single-shot.
			continue
		}

		// expectedRevision is a command fence, not only an enqueue-time check.
		// A callback may advance the run between enqueue and this poll, so every
		// claimed command is revalidated in a transaction before it can alter
		// in-memory cancellation, steering, or workspace state.
		conflictEvent, stale, validationErr := h.ledger.RejectStaleControlCommand(h.durableContext(), command.ID, h.controlOwnerToken(execution))
		if validationErr != nil {
			execution.clearControlClaim(command.ID)
			continue
		}
		if stale {
			if conflictEvent.RunID != "" {
				h.publish(conflictEvent)
			}
			execution.clearControlClaim(command.ID)
			continue
		}

		applied := false
		retryLater := false
		switch command.Action {
		case ControlCancel:
			if execution.sideEffect.Load() {
				// The external operation has crossed its start fence. Leave the
				// command unapplied until it settles; otherwise a crash here could
				// lose the cancellation request.
				execution.wakeWorker()
				execution.clearControlClaim(command.ID)
				continue
			}
			result, cancelErr := h.ledger.ApplyCancelControlCommand(h.durableContext(), command.ID, h.controlOwnerToken(execution))
			if cancelErr != nil {
				retryLater = true
			} else {
				if result.Event != nil {
					h.publish(*result.Event)
				}
				if result.Stale {
					execution.clearControlClaim(command.ID)
					continue
				}
				if result.Applied {
					// The persistent canceling checkpoint and applied command are now
					// one transaction behind us; only now may we interrupt local work.
					applied = true
					execution.cancelRequested.Store(true)
					execution.cancel()
					execution.cancelStep()
				}
			}
		case ControlSteer:
			var payload struct {
				Content string `json:"content"`
			}
			if json.Unmarshal(command.Payload, &payload) == nil && strings.TrimSpace(payload.Content) != "" {
				execution.steerPending.Store(true)
				execution.steerMu.Lock()
				execution.steers = append(execution.steers, steerRequest{requestID: command.ID, content: payload.Content, expectedRevision: command.ExpectedRevision, prevalidated: true})
				execution.steerMu.Unlock()
				if !execution.sideEffect.Load() {
					execution.cancelStep()
				}
				// supersedeAndSteer acknowledges this command only after it has
				// committed the interrupted checkpoint and new user message.
				continue
			}
			// A malformed control payload cannot be executed. Emit a typed error
			// and ack it so an invalid command does not spin forever.
			if run, runErr := h.ledger.GetRun(h.durableContext(), execution.runID); runErr == nil {
				h.emitError(h.durableContext(), run, "malformed_control_command", "steer content is required", execution)
			}
			applied = true
		case ControlResume, ControlRecover:
			// The public control method starts a worker for an interrupted run;
			// this command is retained for audit and is otherwise already handled.
			applied = true
		case ControlAbortRecovery:
			execution.cancel()
			applied = true
		case ControlUseStaleWorkspace:
			// Wake a worker blocked on a source lease. Keep the command claimed
			// until workspace waiting code has actually selected the encrypted
			// snapshot and committed the resume transition. If the process dies
			// before that point, a new owner can reclaim and reapply the command.
			execution.allowStaleWorkspace.Store(true)
			execution.markStaleWorkspaceCommand(command.ID)
			execution.wakeWorker()
			continue
		}
		if retryLater {
			execution.clearControlClaim(command.ID)
			continue
		}
		if applied && command.Action != ControlCancel {
			_ = h.ackControlCommand(execution, command.ID)
		}
	}
	return len(commands) > 0
}

func (h *AgentRunHarness) applySteer(ctx context.Context, run *RunSnapshot, messages *[]Message, content string, execution *runExecution) error {
	return h.supersedeAndSteer(ctx, run, messages, nil, content, "", 0, execution)
}

// supersedeAndSteer is the single interruption boundary used by model and
// tool phases. Any intents supplied by the caller have not crossed the durable
// start fence and are therefore recorded as canceled in the same transaction
// as the interrupted checkpoint and the steer input. Keeping this operation
// atomic prevents stale intents from being executed or projected into the next
// provider request.
func (h *AgentRunHarness) supersedeAndSteer(ctx context.Context, run *RunSnapshot, messages *[]Message, intents []ToolIntent, content, requestID string, expectedRevision int64, execution *runExecution) error {
	if h == nil || run == nil {
		return errors.New("steer requires a run")
	}
	ownerToken := ""
	if execution != nil {
		ownerToken = execution.ownerToken()
	}
	// The caller's projection can lag a durable tool completion (executeTool
	// intentionally refreshes its own copy). Refresh immediately before the
	// atomic write so the CAS protects the actual boundary instead of rejecting
	// a valid steer because of a stale in-memory revision.
	durableCtx := h.durableContext()
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		latest, refreshErr := h.ledger.GetRun(durableCtx, run.ID)
		if refreshErr != nil {
			return refreshErr
		}
		*run = latest
		expected := latest.Revision
		if expectedRevision > 0 {
			// A durable control command must keep the revision it was accepted
			// against. Refreshing it here would silently turn a stale steer into
			// a command against a later model/tool boundary.
			expected = expectedRevision
		}
		result, steerErr := h.ledger.SupersedeToolIntentsAndSteer(durableCtx, SupersedeToolIntentsRequest{
			RunID:            run.ID,
			OwnerToken:       ownerToken,
			ExpectedRevision: expected,
			Intents:          intents,
			SteerContent:     content,
			RequestID:        requestID,
		})
		if steerErr == nil {
			*run = result.Run
			if messages != nil {
				*messages = append(*messages, result.Messages...)
			}
			for _, event := range result.Events {
				h.publish(event)
			}
			// The command claim is acknowledged only after the atomic
			// supersede/checkpoint/message transaction has committed. If the ack
			// itself races with a lease hand-off, steer_requests makes a later
			// replay idempotent and the new owner can acknowledge it.
			if requestID != "" {
				_ = h.ackControlCommand(execution, requestID)
			}
			return nil
		}
		lastErr = steerErr
		if !errors.Is(steerErr, ErrRevisionConflict) {
			return steerErr
		}
		if requestID != "" && expectedRevision > 0 {
			conflictEvent, stale, rejectErr := h.ledger.RejectStaleControlCommand(durableCtx, requestID, h.controlOwnerToken(execution))
			if rejectErr != nil {
				if errors.Is(rejectErr, ErrControlCommandClaimLost) || errors.Is(rejectErr, ErrLeaseLost) {
					execution.clearControlClaim(requestID)
					return nil
				}
				return rejectErr
			}
			if stale {
				if conflictEvent.RunID != "" {
					h.publish(conflictEvent)
				}
				execution.clearControlClaim(requestID)
				return nil
			}
			return steerErr
		}
	}
	return lastErr
}
