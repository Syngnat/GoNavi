package runharness

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

func hashString(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func (h *AgentRunHarness) appendEventOwned(ctx context.Context, run RunSnapshot, kind EventKind, state RunState, payload any, execution *runExecution) (RunEvent, error) {
	owner := ""
	if execution != nil {
		owner = execution.ownerToken()
	}
	event, err := h.ledger.AppendEvent(ctx, AppendEventRequest{RunID: run.ID, ExpectedRevision: run.Revision, Kind: kind, ResultingState: state, Payload: payload, OwnerToken: owner})
	if err == nil {
		h.publish(event)
	}
	return event, err
}

func (h *AgentRunHarness) addActiveDuration(ctx context.Context, runID string, duration time.Duration, ownerToken string) {
	if duration <= 0 {
		return
	}
	_ = h.ledger.AddActiveDuration(ctx, runID, duration, ownerToken)
}

// reserveModelTurn records an in-flight provider call. When MaxTokens is known
// it is used as the conservative reservation amount; otherwise a zero-sized
// reservation still supplies the idempotency marker and the actual provider
// usage is checked against the remaining cap during CommitModelTurn.
func (h *AgentRunHarness) reserveModelTurn(ctx context.Context, run RunSnapshot, execution *runExecution) (TokenReservation, error) {
	amount := 0
	if run.Policy.MaxTotalTokens > 0 {
		remaining := run.Policy.MaxTotalTokens - run.TotalTokens - run.ReservedTokens
		if remaining <= 0 {
			return TokenReservation{}, ErrTokenBudgetExceeded
		}
		if run.MaxTokens != nil && *run.MaxTokens > 0 {
			amount = *run.MaxTokens
			if amount > remaining {
				amount = remaining
			}
		}
	}
	owner := ""
	if execution != nil {
		owner = execution.ownerToken()
	}
	return h.ledger.ReserveTokens(ctx, ReserveTokensRequest{RunID: run.ID, Tokens: amount, ExpectedRevision: run.Revision, OwnerToken: owner})
}

func (h *AgentRunHarness) releaseModelReservation(ctx context.Context, runID string, reservationID string, ownerToken string) error {
	if strings.TrimSpace(reservationID) == "" {
		return nil
	}
	_, err := h.ledger.ReconcileTokens(ctx, ReconcileTokensRequest{RunID: runID, ReservationID: reservationID, OwnerToken: ownerToken})
	return err
}

func (h *AgentRunHarness) ReadRun(ctx context.Context, request RunReadRequest) (RunReadResult, error) {
	if err := h.ensureOpen(); err != nil {
		return RunReadResult{}, err
	}
	if ctx == nil {
		ctx = h.root
	}
	return h.ledger.ReadRun(ctx, request)
}

func (h *AgentRunHarness) ListSessions(ctx context.Context, request SessionListRequest) (SessionListResult, error) {
	if err := h.ensureOpen(); err != nil {
		return SessionListResult{}, err
	}
	if ctx == nil {
		ctx = h.root
	}
	return h.ledger.ListSessions(ctx, request)
}

func (h *AgentRunHarness) ReadSession(ctx context.Context, request SessionReadRequest) (SessionProjection, error) {
	if err := h.ensureOpen(); err != nil {
		return SessionProjection{}, err
	}
	if ctx == nil {
		ctx = h.root
	}
	projection, err := h.ledger.GetSession(ctx, request.SessionID, true)
	if err != nil {
		return SessionProjection{}, err
	}
	if request.AfterSequence > 0 {
		filtered := projection.Messages[:0]
		for _, message := range projection.Messages {
			if message.Sequence > request.AfterSequence {
				filtered = append(filtered, message)
			}
		}
		projection.Messages = filtered
	}
	if request.Limit > 0 && len(projection.Messages) > request.Limit {
		projection.Messages = projection.Messages[:request.Limit]
	}
	return projection, nil
}

func (h *AgentRunHarness) MutateSession(ctx context.Context, request SessionMutationRequest) (SessionProjection, error) {
	if err := h.ensureOpen(); err != nil {
		return SessionProjection{}, err
	}
	if request.ExpectedRevision <= 0 {
		return SessionProjection{}, fmt.Errorf("%w: expectedRevision must be positive", ErrRevisionConflict)
	}
	if ctx == nil {
		ctx = h.root
	}
	return h.ledger.MutateSession(ctx, request)
}

func (h *AgentRunHarness) PutWorkspaceSnapshot(ctx context.Context, snapshot WorkspaceSnapshot) (SnapshotAck, error) {
	if err := h.ensureOpen(); err != nil {
		return SnapshotAck{}, err
	}
	if ctx == nil {
		ctx = h.root
	}
	stored, err := h.ledger.PutWorkspaceSnapshotWithLeaseDuration(ctx, snapshot, h.workspaceSnapshotLeaseDuration())
	if err != nil {
		return SnapshotAck{}, err
	}
	// Wake workers waiting on this source immediately; otherwise they would
	// sleep until the polling interval even though the source has published a
	// newer complete snapshot. Waking unrelated workers is avoided by checking
	// their durable run binding before signalling.
	h.mu.Lock()
	workers := make([]*runExecution, 0, len(h.runs))
	for runID, execution := range h.runs {
		run, getErr := h.ledger.GetRun(ctx, runID)
		if getErr == nil && run.ContextSourceID == stored.SourceID && run.ContextSourceInstanceID == stored.SourceInstanceID {
			workers = append(workers, execution)
		}
	}
	h.mu.Unlock()
	for _, execution := range workers {
		execution.wakeWorker()
	}
	return SnapshotAck{SourceID: stored.SourceID, SourceInstanceID: stored.SourceInstanceID, Revision: stored.Revision, ContentHash: stored.ContentHash, Accepted: true}, nil
}

// Start begins recovery scanning and starts queued runs persisted by an older
// process. It is safe to call more than once during application startup.
func (h *AgentRunHarness) Start(ctx context.Context) error {
	if err := h.ensureOpen(); err != nil {
		return err
	}
	if ctx == nil {
		ctx = h.root
	}
	if _, err := h.ledger.RecoverRuns(ctx); err != nil {
		return err
	}
	sessions, err := h.ledger.ListSessions(ctx, SessionListRequest{ActiveOnly: true, Limit: 500})
	if err != nil {
		return err
	}
	for _, session := range sessions.Sessions {
		for _, run := range session.Runs {
			if run.State == RunStateQueued {
				h.startWorker(run)
				continue
			}
			if run.State == RunStateAwaitingApproval {
				// Pending approvals intentionally survive a process boundary. Only
				// start a worker when a decision is already durable; a pending one
				// would race a separate approve command and needlessly hold a lease.
				approval, approvalErr := h.ledger.LatestApprovalForRun(ctx, run.ID)
				if approvalErr == nil && approval.Status != "pending" {
					h.startWorker(run)
				}
			}
		}
	}
	return nil
}

// Close stops accepting new inputs, cancels owner workers and waits for their
// terminal events. It does not close the caller-owned ledger.
func (h *AgentRunHarness) Close() error {
	if h == nil {
		return nil
	}
	if h.closed.Swap(true) {
		return nil
	}
	h.mu.Lock()
	workers := make([]*runExecution, 0, len(h.runs))
	for _, execution := range h.runs {
		workers = append(workers, execution)
		execution.shutdownRequested.Store(true)
		execution.cancelRequested.Store(true)
		// A side-effect call has crossed the external boundary. Give it a
		// bounded grace period to return a definitive result; forcing its
		// context immediately would lose the distinction between failed and
		// unknown outcomes.
		if !execution.sideEffect.Load() {
			execution.cancelStep()
			execution.cancel()
		}
		execution.wakeWorker()
	}
	h.mu.Unlock()
	done := make(chan struct{})
	go func() {
		h.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		// Cancel the root only after workers have persisted their final state.
		// This keeps a side-effect executor alive long enough to classify its
		// outcome and prevents a shutdown context from racing the ledger write.
		h.cancel()
		return nil
	case <-time.After(h.shutdownGrace):
		// The external call did not settle in time. Cancellation is now
		// intentional; executeTool converts the resulting context error to an
		// unknown side-effect outcome and fences the run in recovery_required.
		h.cancel()
		for _, execution := range workers {
			execution.cancelStep()
			execution.cancel()
			execution.wakeWorker()
		}
		<-done
	}
	return nil
}

func (h *AgentRunHarness) Shutdown() error { return h.Close() }
