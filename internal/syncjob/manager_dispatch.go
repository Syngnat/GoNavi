package syncjob

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
)

func (m *Manager) dispatchLoop() {
	defer m.wg.Done()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-m.wake:
		case <-ticker.C:
		}
		m.dispatchQueued()
	}
}

func (m *Manager) schedulerLoop() {
	defer m.wg.Done()
	ticker := time.NewTicker(m.options.SchedulerInterval)
	defer ticker.Stop()
	for {
		m.runSchedulerCycle()
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (m *Manager) runSchedulerCycle() {
	if m.ctx.Err() != nil {
		return
	}
	now := m.options.Now()
	acquired, err := m.store.AcquireSchedulerLease(m.ctx, "data-sync-scheduler", m.options.LeaseOwner, now, m.options.LeaseTTL)
	if err != nil || !acquired {
		return
	}
	if m.lastRecoveryAt.IsZero() || now.Sub(m.lastRecoveryAt) >= m.options.RecoveryInterval {
		if err := m.recoverInterrupted(m.ctx); err != nil {
			return
		}
		m.lastRecoveryAt = now
	}
	dueJobs, err := m.store.ListDueJobs(m.ctx, now.UnixMilli())
	if err != nil {
		return
	}
	for _, definition := range dueJobs {
		if m.ctx.Err() != nil {
			return
		}
		if definition.Schedule.Kind == ScheduleContinuous {
			notBefore, _, err := m.continuousFailureNotBefore(m.ctx, definition)
			if err != nil {
				continue
			}
			if notBefore > now.UnixMilli() {
				_, _ = m.store.DelayScheduleIfDue(m.ctx, definition.ID, definition.NextRunAt, notBefore)
				continue
			}
		}
		m.enqueueScheduled(definition, now)
	}
}

func (m *Manager) enqueueScheduled(definition JobDefinition, now time.Time) {
	scheduledAt := definition.NextRunAt
	if scheduledAt <= 0 {
		return
	}
	runID := scheduledRunID(definition.ID, scheduledAt)
	run, err := m.createRunWithID(m.ctx, definition, RunTriggerSchedule, "", 1, runID)
	if err != nil {
		if errors.Is(err, ErrRunAlreadyActive) {
			_, _ = m.store.AdvanceScheduleIfDue(m.ctx, definition.ID, scheduledAt, now)
			return
		}
		existing, getErr := m.store.GetRun(m.ctx, runID)
		if getErr != nil {
			return
		}
		run = existing
	}
	advanced, err := m.store.AdvanceScheduleIfDue(m.ctx, definition.ID, scheduledAt, now)
	if err != nil {
		return
	}
	if advanced || run.Status == RunStatusQueued {
		m.signalWake()
	}
}

func scheduledRunID(jobID string, scheduledAt int64) string {
	value := fmt.Sprintf("%s\x00%d", jobID, scheduledAt)
	return "sync-run-scheduled-" + uuid.NewSHA1(uuid.NameSpaceOID, []byte(value)).String()
}

func (m *Manager) dispatchQueued() {
	if !m.hasDispatchCapacity() {
		return
	}
	runs, err := m.store.ListQueuedRuns(m.ctx, 200)
	if err != nil {
		return
	}
	for _, queued := range runs {
		if m.ctx.Err() != nil {
			return
		}
		if !m.hasDispatchCapacity() {
			return
		}
		run, claimed, err := m.store.ClaimRun(m.ctx, queued.ID, m.nowMillis())
		if err != nil || !claimed {
			continue
		}
		if !m.launch(run) {
			m.finish(run, RunStatusInterrupted, ExecutionOutcome{Resumable: true}, "manager stopped before execution")
			return
		}
	}
}

func (m *Manager) hasDispatchCapacity() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return !m.closing && len(m.active) < m.options.MaxConcurrentRuns
}

func (m *Manager) launch(run RunRecord) bool {
	runCtx, cancel := context.WithCancelCause(m.ctx)
	m.mu.Lock()
	if m.closing || len(m.active) >= m.options.MaxConcurrentRuns {
		m.mu.Unlock()
		cancel(errManagerShutdown)
		return false
	}
	m.active[run.ID] = activeExecution{jobID: run.JobID, ownerToken: run.OwnerToken, cancel: cancel}
	m.wg.Add(1)
	m.mu.Unlock()
	current, err := m.store.GetRun(context.Background(), run.ID)
	publishStarted := true
	switch {
	case err != nil:
		cancel(err)
		publishStarted = false
	case current.OwnerToken != run.OwnerToken:
		cancel(ErrRunOwnershipLost)
		publishStarted = false
	case current.Status == RunStatusCancelling:
		cancel(errRunCanceled)
		publishStarted = false
	case current.Status != RunStatusRunning:
		cancel(ErrRunOwnershipLost)
		publishStarted = false
	}
	if publishStarted {
		if _, err := m.appendEvent(context.Background(), run, RunEventStarted, "started", nil); err != nil {
			cancel(err)
		}
	}
	go m.execute(runCtx, run)
	return true
}

func (m *Manager) execute(ctx context.Context, run RunRecord) {
	defer m.wg.Done()
	defer func() {
		m.mu.Lock()
		delete(m.active, run.ID)
		m.mu.Unlock()
		m.signalWake()
	}()

	definition, err := decodeRunDefinition(run)
	if err != nil {
		m.finish(run, RunStatusFailed, ExecutionOutcome{}, err.Error())
		return
	}
	if m.finishBeforeExecutionForCause(run, context.Cause(ctx)) {
		return
	}
	var checkpoint *Checkpoint
	if persisted, checkpointErr := m.store.GetCheckpoint(ctx, run.JobID); checkpointErr == nil {
		checkpoint = &persisted
	} else if !errors.Is(checkpointErr, ErrNotFound) {
		if m.finishBeforeExecutionForCause(run, context.Cause(ctx)) {
			return
		}
		m.finish(run, RunStatusFailed, ExecutionOutcome{}, checkpointErr.Error())
		return
	}
	if err := m.store.TouchRunOwned(ctx, run.ID, run.OwnerToken, m.nowMillis()); err != nil {
		m.cancelLocalRun(run.ID, err)
		if m.finishBeforeExecutionForCause(run, context.Cause(ctx)) {
			return
		}
		m.finish(run, RunStatusFailed, ExecutionOutcome{}, err.Error())
		return
	}
	reporter := &managerReporter{manager: m, ctx: ctx, run: run}
	stopHeartbeat := make(chan struct{})
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		m.heartbeat(ctx, run.ID, run.OwnerToken, stopHeartbeat)
	}()
	var outcome ExecutionOutcome
	var executeErr error
	if cause := context.Cause(ctx); cause != nil {
		executeErr = cause
	} else {
		outcome, executeErr = m.callExecutor(ctx, ExecutionRequest{Run: run, Definition: definition, Checkpoint: checkpoint}, reporter)
	}
	close(stopHeartbeat)
	<-heartbeatDone
	if executeErr == nil && context.Cause(ctx) == nil && outcome.RowsFailed == 0 && definition.IncrementalMode == IncrementalSnapshot {
		if deleteErr := m.store.DeleteCheckpointOwned(context.Background(), run.JobID, run.ID, run.OwnerToken); deleteErr != nil {
			executeErr = fmt.Errorf("clear completed snapshot checkpoint: %w", deleteErr)
			outcome.Resumable = true
		}
	}

	status := RunStatusSucceeded
	message := outcome.Message
	if cause := context.Cause(ctx); cause != nil {
		switch {
		case errors.Is(cause, errManagerShutdown):
			status = RunStatusInterrupted
			outcome.Resumable = true
			message = "manager stopped during execution"
		case errors.Is(cause, errRunCanceled):
			status = RunStatusCanceled
			message = "canceled"
		default:
			status = RunStatusFailed
			message = cause.Error()
		}
	} else if executeErr != nil {
		status = RunStatusFailed
		message = executeErr.Error()
	} else if outcome.RowsFailed > 0 {
		status = RunStatusPartial
	}
	completed := m.finish(run, status, outcome, message)
	var permanentFailure *PermanentExecutionError
	if completed && status == RunStatusFailed && executeErr != nil && errors.As(executeErr, &permanentFailure) {
		_, _ = m.PauseJob(context.Background(), run.JobID)
	}
}

func (m *Manager) finishBeforeExecutionForCause(run RunRecord, cause error) bool {
	if cause == nil {
		return false
	}
	status := RunStatusFailed
	message := cause.Error()
	outcome := ExecutionOutcome{}
	switch {
	case errors.Is(cause, errManagerShutdown):
		status = RunStatusInterrupted
		message = "manager stopped before execution"
		outcome.Resumable = true
	case errors.Is(cause, errRunCanceled):
		status = RunStatusCanceled
		message = "canceled"
	}
	m.finish(run, status, outcome, message)
	return true
}

func (m *Manager) callExecutor(ctx context.Context, request ExecutionRequest, reporter RunReporter) (outcome ExecutionOutcome, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("data sync executor panic: %v", recovered)
		}
	}()
	return m.executor.Execute(ctx, request, reporter)
}

func (m *Manager) finish(run RunRecord, status RunStatus, outcome ExecutionOutcome, message string) bool {
	_, event, err := m.store.CompleteRunOwnedWithTerminalEvent(context.Background(), run.ID, run.OwnerToken, status, outcome, message, m.nowMillis())
	if err != nil {
		return false
	}
	m.notifyRunEvent(event)
	return true
}

func (m *Manager) heartbeat(ctx context.Context, runID, ownerToken string, stop <-chan struct{}) {
	ticker := time.NewTicker(m.options.HeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-stop:
			return
		case <-ticker.C:
			run, err := m.store.GetRun(context.Background(), runID)
			if err != nil {
				m.cancelLocalRun(runID, err)
				return
			}
			if run.OwnerToken != ownerToken {
				m.cancelLocalRun(runID, ErrRunOwnershipLost)
				return
			}
			if run.Status == RunStatusCancelling {
				m.cancelLocalRun(runID, errRunCanceled)
				return
			}
			if err := m.store.TouchRunOwned(context.Background(), runID, ownerToken, m.nowMillis()); err != nil {
				m.cancelLocalRun(runID, err)
				return
			}
		}
	}
}

func (m *Manager) appendEvent(ctx context.Context, run RunRecord, eventType RunEventType, message string, payload json.RawMessage) (RunEvent, error) {
	event, err := m.store.AppendRunEvent(ctx, RunEvent{
		RunID:     run.ID,
		JobID:     run.JobID,
		Type:      eventType,
		Status:    run.Status,
		Current:   run.Current,
		Total:     run.Total,
		Table:     run.Table,
		Stage:     run.Stage,
		Message:   message,
		Payload:   payload,
		CreatedAt: m.nowMillis(),
	})
	if err != nil {
		return RunEvent{}, err
	}
	m.notifyRunEvent(event)
	return event, nil
}

func (m *Manager) notifyRunEvent(event RunEvent) {
	hook := m.options.Hooks.OnRunEvent
	if hook == nil {
		return
	}
	defer func() { _ = recover() }()
	hook(event)
}

func (m *Manager) signalWake() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

func (m *Manager) cancelLocalRun(runID string, cause error) {
	m.mu.Lock()
	execution, ok := m.active[runID]
	m.mu.Unlock()
	if ok && execution.cancel != nil {
		execution.cancel(cause)
	}
}

func (m *Manager) cancelLocalJobRuns(jobID string, cause error) {
	m.mu.Lock()
	cancellations := make([]context.CancelCauseFunc, 0)
	for _, execution := range m.active {
		if execution.jobID == jobID && execution.cancel != nil {
			cancellations = append(cancellations, execution.cancel)
		}
	}
	m.mu.Unlock()
	for _, cancel := range cancellations {
		cancel(cause)
	}
}

func (m *Manager) ensureOpen() error {
	if m == nil {
		return ErrManagerClosed
	}
	m.mu.Lock()
	closing := m.closing
	m.mu.Unlock()
	if closing {
		return ErrManagerClosed
	}
	return nil
}

func (m *Manager) nowMillis() int64 {
	return m.options.Now().UnixMilli()
}

func (m *Manager) Shutdown(ctx context.Context) error {
	if m == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	m.shutdownOnce.Do(func() {
		m.mu.Lock()
		m.closing = true
		m.cancel(errManagerShutdown)
		m.mu.Unlock()
		_ = m.store.ReleaseSchedulerLease(context.Background(), "data-sync-scheduler", m.options.LeaseOwner)
		go func() {
			m.wg.Wait()
			close(m.done)
		}()
	})
	select {
	case <-m.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
