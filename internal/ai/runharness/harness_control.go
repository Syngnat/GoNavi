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

// ControlRun persists control commands for cross-process consumers and applies
// same-process actions immediately when a worker is present.
func (h *AgentRunHarness) ControlRun(ctx context.Context, request RunControlRequest) (RunSnapshot, error) {
	if err := h.ensureOpen(); err != nil {
		return RunSnapshot{}, err
	}
	if strings.TrimSpace(request.RunID) == "" {
		return RunSnapshot{}, errors.New("runId is required")
	}
	if request.Action == "" {
		return RunSnapshot{}, errors.New("action is required")
	}
	// Every externally initiated state mutation is guarded by the caller's
	// observed run revision. Without this, a delayed cancel or steer can target
	// a later model/tool step after the UI has already moved on.
	if request.ExpectedRevision <= 0 {
		return RunSnapshot{}, fmt.Errorf("%w: expectedRevision must be positive", ErrRevisionConflict)
	}
	if ctx == nil {
		ctx = h.root
	}
	run, err := h.ledger.GetRun(ctx, request.RunID)
	if err != nil {
		return RunSnapshot{}, err
	}
	// Cancellation is idempotent after a run is terminal. Do not enqueue a
	// command that no worker can consume, but still require the caller to have
	// observed this exact terminal projection.
	if request.Action == ControlCancel && run.State.Terminal() && run.Revision == request.ExpectedRevision {
		return run, nil
	}
	switch request.Action {
	case ControlApprove, ControlDeny:
		decision := "approved"
		if request.Action == ControlDeny {
			decision = "denied"
		}
		if request.ApprovalID == "" {
			return RunSnapshot{}, errors.New("approvalId is required")
		}
		if strings.TrimSpace(request.CallID) == "" {
			return RunSnapshot{}, errors.New("callId is required")
		}
		if strings.TrimSpace(request.ArgsHash) == "" {
			return RunSnapshot{}, errors.New("argsHash is required")
		}
		if request.ExpectedRevision <= 0 {
			return RunSnapshot{}, fmt.Errorf("%w: expectedRevision must be positive", ErrRevisionConflict)
		}
		if _, err := h.ledger.DecideApproval(ctx, DecideApprovalRequest{
			ApprovalID: request.ApprovalID, Decision: decision,
			ExpectedRunRevision: request.ExpectedRevision,
			ExpectedRunID:       request.RunID, ExpectedCallID: request.CallID,
			ExpectedArgsHash: request.ArgsHash,
		}); err != nil {
			return RunSnapshot{}, err
		}
		// An approval may be decided by a different process after the original
		// non-interactive worker has exited. Wake a local worker when present;
		// otherwise start one so the decision is consumed and the tool is either
		// executed or recorded as denied exactly once.
		if !h.signalRun(request.RunID) {
			latest, latestErr := h.ledger.GetRun(ctx, request.RunID)
			if latestErr != nil {
				return RunSnapshot{}, latestErr
			}
			h.startWorker(latest)
		}
	case ControlCancel:
		commandID := strings.TrimSpace(request.RequestID)
		if commandID == "" {
			commandID = uuid.NewString()
		}
		payload, _ := json.Marshal(map[string]any{"expectedRevision": request.ExpectedRevision})
		_, err = h.ledger.EnqueueCommand(ctx, ControlCommand{ID: commandID, RunID: request.RunID, Action: ControlCancel, Payload: payload, ExpectedRevision: request.ExpectedRevision})
		if err != nil {
			return RunSnapshot{}, err
		}
		if run.State == RunStateQueued {
			// A queued, unleased run has not started a model or tool step. Finish it
			// synchronously instead of launching a worker whose context is already
			// canceled. If another process acquired the lease between the read and
			// this attempt, the owner fence rejects the write and its durable cancel
			// command remains available for that owner to consume.
			if strings.TrimSpace(run.ownerToken) == "" {
				if _, cancelErr := h.applyUnownedQueuedCancel(h.durableContext(), run.ID, commandID); cancelErr != nil &&
					!errors.Is(cancelErr, ErrControlCommandClaimLost) && !errors.Is(cancelErr, ErrLeaseLost) &&
					!errors.Is(cancelErr, ErrRevisionConflict) {
					return RunSnapshot{}, cancelErr
				}
				latest, latestErr := h.ledger.GetRun(ctx, request.RunID)
				if latestErr != nil {
					return RunSnapshot{}, latestErr
				}
				if latest.State.Terminal() {
					return latest, nil
				}
				run = latest
			}
			// A queued run may be held by another process after a hand-off. A local
			// worker can wait for the lease and consume the durable command when it
			// becomes the owner; the fencing token prevents concurrent execution.
			h.startWorker(run)
		}
	case ControlSteer:
		payload, _ := json.Marshal(map[string]any{"content": request.Content, "expectedRevision": request.ExpectedRevision})
		commandID := strings.TrimSpace(request.RequestID)
		if commandID == "" {
			commandID = uuid.NewString()
		}
		_, err = h.ledger.EnqueueCommand(ctx, ControlCommand{ID: commandID, RunID: request.RunID, Action: ControlSteer, Payload: payload, ExpectedRevision: request.ExpectedRevision})
		if err != nil {
			return RunSnapshot{}, err
		}
		h.signalSteer(request.RunID)
	case ControlResume, ControlRecover, ControlMarkCompleted, ControlAbortRecovery:
		// Include the targeted call in the encrypted idempotency payload. A
		// recovery request that reuses a request ID for a different unknown call
		// must be rejected before the run transition is applied.
		payload, _ := json.Marshal(map[string]any{"callId": request.CallID, "content": request.Content, "expectedRevision": request.ExpectedRevision})
		commandID := strings.TrimSpace(request.RequestID)
		if commandID == "" {
			commandID = uuid.NewString()
		}
		transition, transitionErr := h.ledger.ApplyRecoveryAction(ctx, RecoveryActionRequest{
			RunID: request.RunID, CallID: request.CallID, Action: request.Action,
			ExpectedRevision: request.ExpectedRevision,
			CommandID:        commandID, CommandPayload: payload,
		})
		if transitionErr != nil {
			return RunSnapshot{}, transitionErr
		}
		for _, event := range transition.Events {
			h.publish(event)
		}
		if runCanStartWorker(transition.Run) {
			h.startWorker(transition.Run)
		}
		// Return the transaction's resulting projection. A worker may advance the
		// live run immediately after startWorker; returning a fresh read here would
		// make a transport retry appear non-idempotent even though the original
		// recovery command has an immutable receipt in the Ledger.
		return transition.Run, nil
	case ControlUseStaleWorkspace:
		payload, _ := json.Marshal(map[string]any{"content": request.Content, "expectedRevision": request.ExpectedRevision})
		commandID := strings.TrimSpace(request.RequestID)
		if commandID == "" {
			commandID = uuid.NewString()
		}
		_, err = h.ledger.EnqueueCommand(ctx, ControlCommand{ID: commandID, RunID: request.RunID, Action: request.Action, Payload: payload, ExpectedRevision: request.ExpectedRevision})
		if err != nil {
			return RunSnapshot{}, err
		}
		// The worker will consume this marker while waiting for a source. It is
		// intentionally not interpreted as an implicit approval for any
		// side-effecting tool.
		if !h.signalRun(request.RunID) {
			// A non-interactive owner may have released its worker while waiting
			// for the source. Start a local observer/worker so the durable marker is
			// consumed and the stale opt-in can take effect after the lease is
			// acquired. The lease fence still prevents concurrent execution.
			latest, latestErr := h.ledger.GetRun(ctx, request.RunID)
			if latestErr != nil {
				return RunSnapshot{}, latestErr
			}
			if latest.State == RunStateAwaitingWorkspace || latest.State == RunStateInterrupted {
				h.startWorker(latest)
			}
		}
	default:
		return RunSnapshot{}, fmt.Errorf("unsupported control action %q", request.Action)
	}
	return h.ledger.GetRun(ctx, request.RunID)
}

func (h *AgentRunHarness) signalRun(runID string) bool {
	h.mu.Lock()
	execution := h.runs[runID]
	h.mu.Unlock()
	if execution != nil {
		execution.wakeWorker()
		return true
	}
	return false
}

func runCanStartWorker(run RunSnapshot) bool {
	switch run.State {
	case RunStateQueued, RunStateRunningModel, RunStateRunningTool,
		RunStateAwaitingWorkspace:
		return true
	case RunStateAwaitingApproval:
		// A pending approval should remain ownerless so a CLI/desktop decision
		// can be made without a worker holding the lease. Start is still safe for
		// an already-decided approval; callers that need this distinction inspect
		// the approval record before invoking startWorker.
		return false
	default:
		return false
	}
}

func (h *AgentRunHarness) cancelRun(runID string) {
	h.mu.Lock()
	execution := h.runs[runID]
	h.mu.Unlock()
	if execution != nil {
		execution.cancelRequested.Store(true)
		// A side-effecting call has already crossed the external seam. Let it
		// settle and record success/failure/unknown before ending the run; a
		// read-only/model step can be canceled immediately.
		if execution.sideEffect.Load() {
			execution.wakeWorker()
			return
		}
		execution.cancel()
		execution.cancelStep()
		execution.wakeWorker()
	}
}

func (e *runExecution) cancelStep() {
	if e == nil {
		return
	}
	e.stepMu.Lock()
	cancel := e.stepCancel
	e.stepMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (e *runExecution) setStepCancel(cancel context.CancelFunc) {
	if e == nil {
		return
	}
	e.stepMu.Lock()
	e.stepCancel = cancel
	e.stepMu.Unlock()
}

func (e *runExecution) clearStepCancel(cancel context.CancelFunc) {
	if e == nil {
		return
	}
	e.stepMu.Lock()
	// Function values are not comparable. Clearing unconditionally is safe:
	// only one model/tool step is active for a run.
	e.stepCancel = nil
	e.stepMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (e *runExecution) wakeWorker() {
	if e == nil || e.wake == nil {
		return
	}
	select {
	case e.wake <- struct{}{}:
	default:
	}
}

func (e *runExecution) setLease(lease Lease) {
	e.leaseMu.Lock()
	e.lease = lease
	e.leaseMu.Unlock()
}

func (e *runExecution) ownerToken() string {
	e.leaseMu.RLock()
	defer e.leaseMu.RUnlock()
	return e.lease.Token
}

func (e *runExecution) setToolCatalog(descriptors []ToolDescriptor) {
	if e == nil {
		return
	}
	e.toolCatalogMu.Lock()
	e.toolCatalog = cloneToolDescriptors(descriptors)
	e.toolCatalogLoaded = true
	e.toolCatalogMu.Unlock()
}

func (e *runExecution) frozenToolCatalog() ([]ToolDescriptor, bool) {
	if e == nil {
		return nil, false
	}
	e.toolCatalogMu.RLock()
	defer e.toolCatalogMu.RUnlock()
	if !e.toolCatalogLoaded {
		return nil, false
	}
	return cloneToolDescriptors(e.toolCatalog), true
}

// durableContext is used for the final ledger write after a step has been
// canceled. It preserves the harness lifetime values while intentionally
// detaching from the canceled model/tool context; a short deadline prevents a
// shutdown from hanging on a locked SQLite database.
func (h *AgentRunHarness) durableContext() context.Context {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(h.root), 10*time.Second)
	// There is intentionally no caller-facing cancel handle for this helper;
	// arrange for the timer's cancellation function to be released when the
	// deadline fires so repeated durable writes do not retain timer resources.
	context.AfterFunc(ctx, cancel)
	return ctx
}

func (h *AgentRunHarness) leaseHeartbeat(ctx context.Context, execution *runExecution) {
	interval := h.leaseTTL / 3
	if interval < 100*time.Millisecond {
		interval = 100 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			execution.leaseMu.RLock()
			lease := execution.lease
			execution.leaseMu.RUnlock()
			if lease.Token == "" {
				continue
			}
			renewed, err := h.ledger.RenewLease(ctx, lease, h.leaseTTL)
			if err != nil {
				// A fenced owner must never publish a terminal result after another
				// supervisor takes the lease. The recovery scanner will classify any
				// in-flight side effect from the started tool record.
				execution.leaseLost.Store(true)
				execution.cancelStep()
				execution.cancel()
				execution.wakeWorker()
				return
			}
			execution.setLease(renewed)
		}
	}
}
