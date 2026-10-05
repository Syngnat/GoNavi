package runharness

import (
	"context"
	"errors"
	"strings"
	"time"
)

func requiresWorkspaceSnapshot(descriptor ToolDescriptor) bool {
	for _, capability := range descriptor.Capabilities {
		switch strings.ToLower(strings.TrimSpace(capability)) {
		case "workspace", "editor", "current_tab", "sql_activity", "draft":
			return true
		}
	}
	return false
}

// workspaceForModel applies the stricter model-turn binding rule: when a run
// names a workspace source, both source identifiers must be present and the
// newest live snapshot must be available before the provider is called. Runs
// without a bound source intentionally receive no synthetic workspace message.
func (h *AgentRunHarness) workspaceForModel(ctx context.Context, run RunSnapshot, execution *runExecution) (WorkspaceSnapshot, RunSnapshot, error) {
	sourceID := strings.TrimSpace(run.ContextSourceID)
	instanceID := strings.TrimSpace(run.ContextSourceInstanceID)
	if sourceID == "" && instanceID == "" {
		return WorkspaceSnapshot{}, run, nil
	}
	if sourceID == "" || instanceID == "" {
		return WorkspaceSnapshot{}, run, ErrWorkspaceUnavailable
	}
	return h.workspaceForPhase(ctx, run, execution, RunStateRunningModel)
}

// workspaceForTool waits for a live source lease instead of silently reading
// stale desktop state. The user can explicitly opt into the encrypted last
// snapshot with ControlUseStaleWorkspace.
func (h *AgentRunHarness) workspaceForTool(ctx context.Context, run RunSnapshot, execution *runExecution) (WorkspaceSnapshot, RunSnapshot, error) {
	return h.workspaceForPhase(ctx, run, execution, RunStateRunningTool)
}

// workspaceForPhase restores the state that was active before a workspace
// source became unavailable. A model turn and a tool invocation have distinct
// execution semantics, so they cannot share a hard-coded resume state.
func (h *AgentRunHarness) workspaceForPhase(ctx context.Context, run RunSnapshot, execution *runExecution, resumeState RunState) (WorkspaceSnapshot, RunSnapshot, error) {
	for {
		if ctx.Err() != nil {
			return WorkspaceSnapshot{}, run, ctx.Err()
		}
		snapshot, snapshotErr := h.ledger.LatestWorkspaceSnapshot(ctx, run.ContextSourceID, run.ContextSourceInstanceID)
		if snapshotErr == nil {
			if run.State == RunStateAwaitingWorkspace {
				latest, transitionErr := h.appendState(ctx, run, EventCheckpoint, resumeState, CheckpointEvent{Sequence: run.NextSequence - 1}, execution, "")
				if transitionErr != nil {
					return WorkspaceSnapshot{}, run, transitionErr
				}
				run = latest
			}
			// A live snapshot also satisfies an explicit stale-workspace
			// approval. Ack only after the optional resume transition commits.
			h.ackStaleWorkspaceCommands(execution)
			return snapshot, run, nil
		}
		if errors.Is(snapshotErr, ErrSnapshotExpired) && execution.allowStaleWorkspace.Load() {
			stale, _, staleErr := h.ledger.LatestWorkspaceSnapshotAllowExpired(ctx, run.ContextSourceID, run.ContextSourceInstanceID)
			if staleErr == nil {
				if run.State == RunStateAwaitingWorkspace {
					latest, transitionErr := h.appendState(ctx, run, EventCheckpoint, resumeState, CheckpointEvent{Sequence: run.NextSequence - 1}, execution, "")
					if transitionErr != nil {
						return WorkspaceSnapshot{}, run, transitionErr
					}
					run = latest
				}
				// The stale snapshot is now the actual workspace input for this
				// phase. The durable state transition above is the acknowledgement
				// boundary for the control command.
				h.ackStaleWorkspaceCommands(execution)
				return stale, run, nil
			}
			snapshotErr = staleErr
		}
		if !errors.Is(snapshotErr, ErrNotFound) && !errors.Is(snapshotErr, ErrSnapshotExpired) {
			return WorkspaceSnapshot{}, run, snapshotErr
		}
		if run.State != RunStateAwaitingWorkspace {
			latest, transitionErr := h.appendState(ctx, run, EventCheckpoint, RunStateAwaitingWorkspace, CheckpointEvent{Sequence: run.NextSequence - 1}, execution, "")
			if transitionErr != nil {
				return WorkspaceSnapshot{}, run, transitionErr
			}
			run = latest
		}
		h.consumeControlCommands(ctx, execution)
		if execution.cancelRequested.Load() {
			return WorkspaceSnapshot{}, run, context.Canceled
		}
		timer := time.NewTimer(h.pollInterval())
		select {
		case <-ctx.Done():
			timer.Stop()
			return WorkspaceSnapshot{}, run, ctx.Err()
		case <-execution.wake:
			timer.Stop()
		case <-timer.C:
		}
		latest, refreshErr := h.refreshRun(ctx, run.ID)
		if refreshErr != nil {
			return WorkspaceSnapshot{}, run, refreshErr
		}
		run = latest
	}
}

// workspaceForPendingTool restores the exact snapshot captured when a
// started tool crossed the execution boundary. A newer live snapshot proves
// that the source is connected, but it is never substituted for the recorded
// payload; this keeps retries deterministic and auditable.
func (h *AgentRunHarness) workspaceForPendingTool(ctx context.Context, run RunSnapshot, reference WorkspaceSnapshotReference, execution *runExecution) (WorkspaceSnapshot, RunSnapshot, error) {
	if h == nil || h.ledger == nil || !reference.valid() {
		return WorkspaceSnapshot{}, run, ErrWorkspaceUnavailable
	}
	for {
		if ctx.Err() != nil {
			return WorkspaceSnapshot{}, run, ctx.Err()
		}
		snapshot, expired, snapshotErr := h.ledger.WorkspaceSnapshotByReference(ctx, reference)
		if snapshotErr != nil {
			// A missing exact payload is a ledger integrity failure, not a reason to
			// execute against an unrelated latest snapshot.
			if errors.Is(snapshotErr, ErrNotFound) || errors.Is(snapshotErr, ErrSnapshotConflict) {
				return WorkspaceSnapshot{}, run, snapshotErr
			}
			return WorkspaceSnapshot{}, run, snapshotErr
		}
		live := !expired
		if expired {
			// The exact revision can have an old lease while the source has
			// reconnected and published a newer revision. Check liveness separately;
			// the executor still receives the exact stored payload.
			_, latestErr := h.ledger.LatestWorkspaceSnapshot(ctx, reference.SourceID, reference.SourceInstanceID)
			live = latestErr == nil
		}
		if live || (execution != nil && execution.allowStaleWorkspace.Load()) {
			if run.State != RunStateRunningTool {
				latest, transitionErr := h.appendState(ctx, run, EventCheckpoint, RunStateRunningTool, CheckpointEvent{Sequence: run.NextSequence - 1, WorkspaceSnapshot: &reference}, execution, "")
				if transitionErr != nil {
					return WorkspaceSnapshot{}, run, transitionErr
				}
				run = latest
			}
			h.ackStaleWorkspaceCommands(execution)
			return snapshot, run, nil
		}
		if run.State != RunStateAwaitingWorkspace {
			latest, transitionErr := h.appendState(ctx, run, EventCheckpoint, RunStateAwaitingWorkspace, CheckpointEvent{Sequence: run.NextSequence - 1, WorkspaceSnapshot: &reference}, execution, "")
			if transitionErr != nil {
				return WorkspaceSnapshot{}, run, transitionErr
			}
			run = latest
		}
		h.consumeControlCommands(ctx, execution)
		if execution != nil && execution.cancelRequested.Load() {
			return WorkspaceSnapshot{}, run, context.Canceled
		}
		timer := time.NewTimer(h.pollInterval())
		var wake <-chan struct{}
		if execution != nil {
			wake = execution.wake
		}
		select {
		case <-ctx.Done():
			timer.Stop()
			return WorkspaceSnapshot{}, run, ctx.Err()
		case <-timer.C:
		case <-wake:
			timer.Stop()
		}
		latest, refreshErr := h.refreshRun(ctx, run.ID)
		if refreshErr != nil {
			return WorkspaceSnapshot{}, run, refreshErr
		}
		run = latest
	}
}

// waitForWorkspaceSource is the startup counterpart of workspaceForTool. It
// keeps an interrupted/awaiting-workspace run from issuing a model request
// while its bound source is offline, and transitions back to running_model only
// after a live (or explicitly stale-approved) snapshot is available.
func (h *AgentRunHarness) waitForWorkspaceSource(ctx context.Context, run RunSnapshot, execution *runExecution) (RunSnapshot, error) {
	if strings.TrimSpace(run.ContextSourceID) == "" || strings.TrimSpace(run.ContextSourceInstanceID) == "" {
		return run, ErrWorkspaceUnavailable
	}
	for {
		if ctx.Err() != nil {
			return run, ctx.Err()
		}
		_, snapshotErr := h.ledger.LatestWorkspaceSnapshot(ctx, run.ContextSourceID, run.ContextSourceInstanceID)
		available := snapshotErr == nil
		if !available && errors.Is(snapshotErr, ErrSnapshotExpired) && execution != nil && execution.allowStaleWorkspace.Load() {
			_, _, snapshotErr = h.ledger.LatestWorkspaceSnapshotAllowExpired(ctx, run.ContextSourceID, run.ContextSourceInstanceID)
			available = snapshotErr == nil
		}
		if available {
			if run.State == RunStateAwaitingWorkspace {
				latest, transitionErr := h.appendState(ctx, run, EventCheckpoint, RunStateRunningModel, CheckpointEvent{Sequence: run.NextSequence - 1}, execution, "")
				if transitionErr != nil {
					return run, transitionErr
				}
				run = latest
			}
			h.ackStaleWorkspaceCommands(execution)
			return run, nil
		}
		if !errors.Is(snapshotErr, ErrNotFound) && !errors.Is(snapshotErr, ErrSnapshotExpired) {
			return run, snapshotErr
		}
		h.consumeControlCommands(ctx, execution)
		if execution != nil && execution.cancelRequested.Load() {
			return run, context.Canceled
		}
		var wake <-chan struct{}
		if execution != nil {
			wake = execution.wake
		}
		timer := time.NewTimer(h.pollInterval())
		select {
		case <-ctx.Done():
			timer.Stop()
			return run, ctx.Err()
		case <-timer.C:
		case <-wake:
			timer.Stop()
		}
		latest, refreshErr := h.refreshRun(ctx, run.ID)
		if refreshErr != nil {
			return run, refreshErr
		}
		run = latest
		if run.State.Terminal() {
			return run, ErrTerminalRun
		}
	}
}
