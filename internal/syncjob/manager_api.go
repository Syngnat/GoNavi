package syncjob

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

func (m *Manager) PutJob(ctx context.Context, definition JobDefinition) (JobDefinition, error) {
	if err := m.ensureOpen(); err != nil {
		return JobDefinition{}, err
	}
	saved, err := m.store.PutJob(ctx, definition)
	if err != nil {
		return JobDefinition{}, err
	}
	if saved.Lifecycle == JobLifecyclePaused || saved.Lifecycle == JobLifecycleArchived {
		m.cancelLocalJobRuns(saved.ID, errRunCanceled)
		m.signalWake()
	}
	return saved, nil
}

func (m *Manager) PauseJob(ctx context.Context, id string) (JobDefinition, error) {
	if err := m.ensureOpen(); err != nil {
		return JobDefinition{}, err
	}
	paused, err := m.store.PauseJob(ctx, strings.TrimSpace(id))
	if err != nil {
		return JobDefinition{}, err
	}
	m.cancelLocalJobRuns(paused.ID, errRunCanceled)
	m.signalWake()
	return paused, nil
}

func (m *Manager) GetJob(ctx context.Context, id string) (JobDefinition, error) {
	if err := m.ensureOpen(); err != nil {
		return JobDefinition{}, err
	}
	return m.store.GetJob(ctx, id)
}

func (m *Manager) ListJobs(ctx context.Context) ([]JobDefinition, error) {
	if err := m.ensureOpen(); err != nil {
		return nil, err
	}
	return m.store.ListJobs(ctx)
}

func (m *Manager) DeleteJob(ctx context.Context, id string) error {
	if err := m.ensureOpen(); err != nil {
		return err
	}
	id = strings.TrimSpace(id)
	transitions, err := m.store.archiveJobAndCancelRuns(ctx, id, m.nowMillis())
	if err != nil {
		return err
	}
	for _, transition := range transitions {
		eventType := RunEventCancelling
		message := "cancellation requested because task was archived"
		if transition.Run.Status == RunStatusCanceled {
			eventType = RunEventCanceled
			message = "canceled because task was archived"
		}
		_, _ = m.appendEvent(ctx, transition.Run, eventType, message, nil)
	}
	m.cancelLocalJobRuns(id, errRunCanceled)
	m.signalWake()
	return nil
}

// PurgeJob permanently deletes an inactive task together with its history.
// A task with an active run must be canceled and allowed to reach a terminal
// state first; this keeps a lease owner in another Manager from writing after
// the run record has been removed.
func (m *Manager) PurgeJob(ctx context.Context, id string) error {
	if err := m.ensureOpen(); err != nil {
		return err
	}
	id = strings.TrimSpace(id)
	err := m.store.PurgeJob(ctx, id)
	m.signalWake()
	return err
}

func (m *Manager) GetRun(ctx context.Context, id string) (RunRecord, error) {
	return m.store.GetRun(ctx, id)
}

func (m *Manager) ListRuns(ctx context.Context, jobID string, limit int) ([]RunRecord, error) {
	return m.store.ListRuns(ctx, jobID, limit)
}

func (m *Manager) ListRunsPage(ctx context.Context, jobID string, cursor *RunCursor, limit int) (RunPage, error) {
	return m.store.ListRunsPage(ctx, jobID, cursor, limit)
}

func (m *Manager) DeleteRun(ctx context.Context, runID string) error {
	if err := m.ensureOpen(); err != nil {
		return err
	}
	return m.store.DeleteRun(ctx, runID)
}

func (m *Manager) ClearTerminalRuns(ctx context.Context, jobID string) (int, error) {
	if err := m.ensureOpen(); err != nil {
		return 0, err
	}
	return m.store.ClearTerminalRuns(ctx, jobID)
}

func (m *Manager) ListRunEvents(ctx context.Context, runID string, afterSequence int64, limit int) ([]RunEvent, error) {
	return m.store.ListRunEvents(ctx, runID, afterSequence, limit)
}

func (m *Manager) ListErrorRows(ctx context.Context, runID string, status ErrorRowStatus, limit int) ([]ErrorRow, error) {
	return m.store.ListErrorRows(ctx, runID, status, limit)
}

func (m *Manager) GetErrorRow(ctx context.Context, id string) (ErrorRow, error) {
	if err := m.ensureOpen(); err != nil {
		return ErrorRow{}, err
	}
	return m.store.GetErrorRow(ctx, id)
}

func (m *Manager) RetryErrorRow(ctx context.Context, id string, replay func(context.Context, ErrorRow) error) (ErrorRow, error) {
	if err := m.ensureOpen(); err != nil {
		return ErrorRow{}, err
	}
	if replay == nil {
		return ErrorRow{}, errors.New("data sync error row retry callback is required")
	}
	claimed, err := m.store.ClaimErrorRowRetry(ctx, strings.TrimSpace(id), m.nowMillis(), errorRowRetryLeaseTTL)
	if err != nil {
		return ErrorRow{}, err
	}

	replayCtx, cancelReplay := context.WithCancelCause(ctx)
	heartbeatDone := make(chan error, 1)
	go func() {
		heartbeatDone <- m.maintainErrorRowRetryLease(replayCtx, cancelReplay, claimed.ID, claimed.RetryOwner)
	}()
	replayErr := callErrorRowRetry(replayCtx, claimed, replay)
	cancelReplay(context.Canceled)
	heartbeatErr := <-heartbeatDone
	if heartbeatErr != nil {
		replayErr = errors.Join(replayErr, heartbeatErr)
	}

	finalizeCtx, cancelFinalize := context.WithTimeout(context.Background(), errorRowRetryFinalizeTTL)
	defer cancelFinalize()
	if replayErr != nil {
		if err := m.store.FailErrorRowRetry(finalizeCtx, claimed.ID, claimed.RetryOwner, m.nowMillis()); err != nil {
			return ErrorRow{}, errors.Join(replayErr, fmt.Errorf("release failed data sync error row retry: %w", err))
		}
		row, readErr := m.store.GetErrorRow(finalizeCtx, claimed.ID)
		if readErr != nil {
			return ErrorRow{}, errors.Join(replayErr, readErr)
		}
		return row, replayErr
	}
	if err := m.store.ResolveErrorRowRetry(finalizeCtx, claimed.ID, claimed.RetryOwner, m.nowMillis()); err != nil {
		return ErrorRow{}, err
	}
	return m.store.GetErrorRow(finalizeCtx, claimed.ID)
}

func (m *Manager) maintainErrorRowRetryLease(ctx context.Context, cancel context.CancelCauseFunc, id, owner string) error {
	ticker := time.NewTicker(errorRowRetryRenewInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-m.ctx.Done():
			cause := context.Cause(m.ctx)
			if cause == nil {
				cause = ErrManagerClosed
			}
			cancel(cause)
			return cause
		case <-ticker.C:
			if err := m.store.RenewErrorRowRetry(context.Background(), id, owner, m.nowMillis(), errorRowRetryLeaseTTL); err != nil {
				cancel(err)
				return err
			}
		}
	}
}

func callErrorRowRetry(ctx context.Context, row ErrorRow, replay func(context.Context, ErrorRow) error) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("data sync error row retry panic: %v", recovered)
		}
	}()
	return replay(ctx, row)
}

func (m *Manager) GetCheckpoint(ctx context.Context, jobID string) (Checkpoint, error) {
	if err := m.ensureOpen(); err != nil {
		return Checkpoint{}, err
	}
	return m.store.GetCheckpoint(ctx, strings.TrimSpace(jobID))
}

func (m *Manager) ResetCheckpoint(ctx context.Context, jobID string) error {
	if err := m.ensureOpen(); err != nil {
		return err
	}
	return m.store.ResetCheckpoint(ctx, strings.TrimSpace(jobID))
}

func (m *Manager) ResolveErrorRow(ctx context.Context, id string, incrementAttempts bool) error {
	if err := m.ensureOpen(); err != nil {
		return err
	}
	return m.store.UpdateErrorRowStatus(ctx, id, ErrorRowResolved, incrementAttempts)
}

func (m *Manager) RecordErrorRowRetryFailure(ctx context.Context, id string) error {
	if err := m.ensureOpen(); err != nil {
		return err
	}
	return m.store.IncrementErrorRowAttempts(ctx, strings.TrimSpace(id))
}

func (m *Manager) DiscardErrorRow(ctx context.Context, id string) error {
	if err := m.ensureOpen(); err != nil {
		return err
	}
	return m.store.UpdateErrorRowStatus(ctx, id, ErrorRowDiscarded, false)
}
