package syncjob

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

var (
	ErrManagerClosed   = errors.New("data sync job manager is closed")
	ErrJobDisabled     = errors.New("data sync job is disabled")
	ErrRunNotResumable = errors.New("data sync run is not resumable")
	ErrRunNotRetryable = errors.New("data sync run is not retryable")
	errManagerShutdown = errors.New("data sync job manager is shutting down")
	errRunCanceled     = errors.New("data sync run cancellation requested")
)

const (
	errorRowRetryLeaseTTL      = 30 * time.Second
	errorRowRetryRenewInterval = 10 * time.Second
	errorRowRetryFinalizeTTL   = 5 * time.Second
)

type ExecutionRequest struct {
	Run        RunRecord     `json:"run"`
	Definition JobDefinition `json:"definition"`
	Checkpoint *Checkpoint   `json:"checkpoint,omitempty"`
}

type RunReporter interface {
	ReportProgress(RunProgress) error
	SaveCheckpoint(Checkpoint) error
	AppendErrorRow(ErrorRow) error
	Emit(RunEventType, string, json.RawMessage) error
}

type Executor interface {
	Execute(context.Context, ExecutionRequest, RunReporter) (ExecutionOutcome, error)
}

type ExecutorFunc func(context.Context, ExecutionRequest, RunReporter) (ExecutionOutcome, error)

func (execute ExecutorFunc) Execute(ctx context.Context, request ExecutionRequest, reporter RunReporter) (ExecutionOutcome, error) {
	return execute(ctx, request, reporter)
}

type ManagerHooks struct {
	OnRunEvent func(RunEvent)
}

type ManagerOptions struct {
	SchedulerInterval  time.Duration
	LeaseTTL           time.Duration
	HeartbeatInterval  time.Duration
	RecoveryStaleAfter time.Duration
	RecoveryInterval   time.Duration
	MaxConcurrentRuns  int
	LeaseOwner         string
	Hooks              ManagerHooks
	Now                func() time.Time
}

type Manager struct {
	store    *Store
	executor Executor
	options  ManagerOptions

	ctx    context.Context
	cancel context.CancelCauseFunc
	wake   chan struct{}

	mu      sync.Mutex
	closing bool
	active  map[string]activeExecution
	wg      sync.WaitGroup

	lastRecoveryAt time.Time

	shutdownOnce sync.Once
	done         chan struct{}
}

type activeExecution struct {
	jobID      string
	ownerToken string
	cancel     context.CancelCauseFunc
}

func NewManager(ctx context.Context, store *Store, executor Executor, options ManagerOptions) (*Manager, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if store == nil {
		return nil, errors.New("data sync job store is required")
	}
	if err := store.ensureOpen(); err != nil {
		return nil, err
	}
	if executor == nil {
		return nil, errors.New("data sync job executor is required")
	}
	options = normalizeManagerOptions(options)
	managerCtx, cancel := context.WithCancelCause(ctx)
	manager := &Manager{
		store:    store,
		executor: executor,
		options:  options,
		ctx:      managerCtx,
		cancel:   cancel,
		wake:     make(chan struct{}, 1),
		active:   make(map[string]activeExecution),
		done:     make(chan struct{}),
	}
	now := options.Now()
	acquired, err := store.AcquireSchedulerLease(ctx, "data-sync-scheduler", options.LeaseOwner, now, options.LeaseTTL)
	if err != nil {
		cancel(err)
		return nil, err
	}
	if acquired {
		if err := manager.recoverInterrupted(ctx); err != nil {
			_ = store.ReleaseSchedulerLease(context.Background(), "data-sync-scheduler", options.LeaseOwner)
			cancel(err)
			return nil, err
		}
		manager.lastRecoveryAt = now
	}
	manager.wg.Add(2)
	go manager.dispatchLoop()
	go manager.schedulerLoop()
	manager.signalWake()
	return manager, nil
}

func (m *Manager) recoverInterrupted(ctx context.Context) error {
	now := m.options.Now()
	if _, err := m.store.RecoverExpiredErrorRowRetries(ctx, now.UnixMilli()); err != nil {
		return err
	}
	recovered, err := m.store.InterruptStaleRuns(ctx, now.Add(-m.options.RecoveryStaleAfter).UnixMilli(), now.UnixMilli())
	if err != nil {
		return err
	}
	for _, run := range recovered {
		if run.Status == RunStatusCanceled {
			if _, err := m.appendEvent(ctx, run, RunEventCanceled, "canceled after manager restart", nil); err != nil {
				return err
			}
			continue
		}
		if _, err := m.appendEvent(ctx, run, RunEventInterrupted, "interrupted after manager restart", nil); err != nil {
			return err
		}
		definition, decodeErr := decodeRunDefinition(run)
		if decodeErr != nil || definition.ResumePolicy != "auto" {
			continue
		}
		if _, resumeErr := m.ResumeRun(ctx, run.ID); resumeErr != nil {
			payload, _ := json.Marshal(map[string]string{"error": resumeErr.Error()})
			_, _ = m.appendEvent(ctx, run, RunEventLog, "automatic resume was not queued", payload)
		}
	}
	return nil
}

func normalizeManagerOptions(options ManagerOptions) ManagerOptions {
	if options.SchedulerInterval <= 0 {
		options.SchedulerInterval = time.Second
	}
	if options.LeaseTTL <= 0 {
		options.LeaseTTL = 10 * time.Second
	}
	if options.HeartbeatInterval <= 0 {
		options.HeartbeatInterval = 5 * time.Second
	}
	if options.RecoveryStaleAfter <= 0 {
		options.RecoveryStaleAfter = 3 * options.HeartbeatInterval
	}
	if options.RecoveryInterval <= 0 {
		options.RecoveryInterval = options.RecoveryStaleAfter
	}
	if options.MaxConcurrentRuns <= 0 {
		options.MaxConcurrentRuns = 4
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if strings.TrimSpace(options.LeaseOwner) == "" {
		options.LeaseOwner = "sync-scheduler-" + uuid.NewString()
	}
	return options
}

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

func (m *Manager) StartRun(ctx context.Context, jobID string) (RunRecord, error) {
	if err := m.ensureOpen(); err != nil {
		return RunRecord{}, err
	}
	definition, err := m.store.GetJob(ctx, strings.TrimSpace(jobID))
	if err != nil {
		return RunRecord{}, err
	}
	if definition.Lifecycle != JobLifecycleReady && definition.Lifecycle != JobLifecycleEnabled {
		return RunRecord{}, ErrJobDisabled
	}
	if err := ValidateDefinition(definition); err != nil {
		return RunRecord{}, err
	}
	run, err := m.createRun(ctx, definition, RunTriggerManual, "", 1)
	if err != nil {
		return RunRecord{}, err
	}
	m.signalWake()
	return run, nil
}

func (m *Manager) CancelRun(ctx context.Context, runID string) error {
	if err := m.ensureOpen(); err != nil {
		return err
	}
	run, err := m.store.RequestCancelRun(ctx, strings.TrimSpace(runID), m.nowMillis())
	if err != nil {
		return err
	}
	eventType := RunEventCancelling
	message := "cancellation requested"
	if run.Status == RunStatusCanceled {
		eventType = RunEventCanceled
		message = "canceled before execution"
	}
	_, eventErr := m.appendEvent(ctx, run, eventType, message, nil)
	if run.Status == RunStatusCancelling {
		m.cancelLocalRun(run.ID, errRunCanceled)
	}
	return eventErr
}

func (m *Manager) ResumeRun(ctx context.Context, runID string) (RunRecord, error) {
	if err := m.ensureOpen(); err != nil {
		return RunRecord{}, err
	}
	parent, err := m.store.GetRun(ctx, strings.TrimSpace(runID))
	if err != nil {
		return RunRecord{}, err
	}
	switch parent.Status {
	case RunStatusFailed, RunStatusCanceled, RunStatusInterrupted, RunStatusPartial, RunStatusPaused:
	default:
		return RunRecord{}, ErrRunNotResumable
	}
	if !parent.Resumable {
		return RunRecord{}, ErrRunNotResumable
	}
	definition, err := decodeRunDefinition(parent)
	if err != nil {
		return RunRecord{}, err
	}
	current, err := m.requireCurrentRunnableDefinition(ctx, parent, definition)
	if err != nil {
		return RunRecord{}, err
	}
	if current.ResumePolicy == "never" {
		return RunRecord{}, ErrRunNotResumable
	}
	if current.Options.SyncMode == "insert_only" {
		return RunRecord{}, ErrRunNotResumable
	}
	checkpoint, err := m.store.GetCheckpoint(ctx, parent.JobID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return RunRecord{}, ErrRunNotResumable
		}
		return RunRecord{}, err
	}
	inLineage, err := m.checkpointBelongsToRunLineage(ctx, parent, checkpoint, current)
	if err != nil {
		return RunRecord{}, err
	}
	if !inLineage {
		return RunRecord{}, ErrRunNotResumable
	}
	resumed, err := m.createRun(ctx, current, RunTriggerResume, parent.ID, parent.Attempt+1)
	if err != nil {
		return RunRecord{}, err
	}
	m.signalWake()
	return resumed, nil
}

func (m *Manager) RetryRun(ctx context.Context, runID string) (RunRecord, error) {
	if err := m.ensureOpen(); err != nil {
		return RunRecord{}, err
	}
	parent, err := m.store.GetRun(ctx, strings.TrimSpace(runID))
	if err != nil {
		return RunRecord{}, err
	}
	switch parent.Status {
	case RunStatusFailed, RunStatusPartial, RunStatusCanceled, RunStatusInterrupted:
	default:
		return RunRecord{}, ErrRunNotRetryable
	}
	definition, err := decodeRunDefinition(parent)
	if err != nil {
		return RunRecord{}, err
	}
	current, err := m.requireCurrentRunnableDefinition(ctx, parent, definition)
	if err != nil {
		return RunRecord{}, err
	}
	if current.Options.SyncMode == "insert_only" {
		return RunRecord{}, ErrRunNotRetryable
	}
	retried, err := m.createRun(ctx, current, RunTriggerRetry, parent.ID, parent.Attempt+1)
	if err != nil {
		return RunRecord{}, err
	}
	m.signalWake()
	return retried, nil
}

func (m *Manager) checkpointBelongsToRunLineage(ctx context.Context, parent RunRecord, checkpoint Checkpoint, definition JobDefinition) (bool, error) {
	if checkpoint.JobID != parent.JobID || strings.TrimSpace(checkpoint.RunID) == "" {
		return false, nil
	}
	expectedPlanHash, err := ExecutionPlanHash(definition)
	if err != nil {
		return false, err
	}
	visited := make(map[string]struct{})
	candidate := parent
	for {
		if candidate.JobID != parent.JobID {
			return false, nil
		}
		if _, repeated := visited[candidate.ID]; repeated {
			return false, nil
		}
		visited[candidate.ID] = struct{}{}
		if candidate.ID == checkpoint.RunID {
			if checkpoint.DefinitionRevision != 0 && checkpoint.DefinitionRevision != candidate.JobRevision {
				return false, nil
			}
			candidateDefinition, err := decodeRunDefinition(candidate)
			if err != nil {
				return false, err
			}
			candidatePlanHash, err := ExecutionPlanHash(candidateDefinition)
			if err != nil {
				return false, err
			}
			return candidatePlanHash == expectedPlanHash, nil
		}
		if strings.TrimSpace(candidate.ParentRunID) == "" {
			return false, nil
		}
		candidate, err = m.store.GetRun(ctx, candidate.ParentRunID)
		if err != nil {
			return false, err
		}
	}
}

func (m *Manager) requireCurrentRunnableDefinition(ctx context.Context, run RunRecord, snapshot JobDefinition) (JobDefinition, error) {
	current, err := m.store.GetJob(ctx, run.JobID)
	if err != nil {
		return JobDefinition{}, err
	}
	if current.Lifecycle != JobLifecycleReady && current.Lifecycle != JobLifecycleEnabled {
		return JobDefinition{}, ErrJobDisabled
	}
	snapshotHash, err := ExecutionPlanHash(snapshot)
	if err != nil {
		return JobDefinition{}, err
	}
	currentHash, err := ExecutionPlanHash(current)
	if err != nil {
		return JobDefinition{}, err
	}
	if snapshot.ID != run.JobID || snapshot.Revision != run.JobRevision || snapshotHash != currentHash {
		return JobDefinition{}, fmt.Errorf("%w: the task execution plan changed after run %s", ErrRevisionConflict, run.ID)
	}
	return current, nil
}

func (m *Manager) createRun(ctx context.Context, definition JobDefinition, trigger RunTrigger, parentRunID string, attempt int) (RunRecord, error) {
	return m.createRunWithID(ctx, definition, trigger, parentRunID, attempt, "")
}

func (m *Manager) createRunWithID(ctx context.Context, definition JobDefinition, trigger RunTrigger, parentRunID string, attempt int, runID string) (RunRecord, error) {
	snapshot, err := json.Marshal(definition)
	if err != nil {
		return RunRecord{}, fmt.Errorf("encode data sync job run snapshot: %w", err)
	}
	run, event, err := m.store.CreateRunWithPolicyAndQueuedEvent(ctx, RunRecord{
		ID:                 runID,
		JobID:              definition.ID,
		JobRevision:        definition.Revision,
		Trigger:            trigger,
		Status:             RunStatusQueued,
		ParentRunID:        parentRunID,
		Attempt:            attempt,
		DefinitionSnapshot: snapshot,
		SourceFingerprint:  definition.Source.Fingerprint,
		TargetFingerprint:  definition.Target.Fingerprint,
	}, definition.ConcurrencyPolicy, m.nowMillis())
	if err != nil {
		return RunRecord{}, err
	}
	m.notifyRunEvent(event)
	return run, nil
}

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

func decodeRunDefinition(run RunRecord) (JobDefinition, error) {
	var definition JobDefinition
	if err := json.Unmarshal(run.DefinitionSnapshot, &definition); err != nil {
		return JobDefinition{}, fmt.Errorf("decode data sync job run snapshot: %w", err)
	}
	definition = NormalizeDefinition(definition)
	if err := ValidateDefinition(definition); err != nil {
		return JobDefinition{}, fmt.Errorf("validate data sync job run snapshot: %w", err)
	}
	if definition.ID != run.JobID || definition.Revision != run.JobRevision {
		return JobDefinition{}, fmt.Errorf("data sync job run snapshot identity does not match run %s", run.ID)
	}
	if definition.Source.Fingerprint != run.SourceFingerprint || definition.Target.Fingerprint != run.TargetFingerprint {
		return JobDefinition{}, fmt.Errorf("data sync job run snapshot endpoint fingerprints do not match run %s", run.ID)
	}
	return definition, nil
}

type managerReporter struct {
	manager *Manager
	ctx     context.Context
	run     RunRecord
	mu      sync.Mutex
}

func (r *managerReporter) ReportProgress(progress RunProgress) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	run, err := r.manager.store.UpdateRunProgressOwned(r.ctx, r.run.ID, r.run.OwnerToken, progress, r.manager.nowMillis())
	if err != nil {
		return err
	}
	r.run = run
	payload, _ := json.Marshal(progress)
	_, err = r.manager.appendEvent(r.ctx, run, RunEventProgress, progress.Message, payload)
	return err
}

func (r *managerReporter) SaveCheckpoint(checkpoint Checkpoint) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	checkpoint.JobID = r.run.JobID
	checkpoint.RunID = r.run.ID
	checkpoint.DefinitionRevision = r.run.JobRevision
	persisted, err := r.manager.store.PutCheckpointOwned(r.ctx, checkpoint, r.run.OwnerToken)
	if err != nil {
		return err
	}
	publicCheckpoint := persisted
	publicCheckpoint.SchemaHash = ""
	payload, _ := json.Marshal(publicCheckpoint)
	_, err = r.manager.appendEvent(r.ctx, r.run, RunEventCheckpoint, "checkpoint saved", payload)
	return err
}

func (r *managerReporter) AppendErrorRow(row ErrorRow) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	row.RunID = r.run.ID
	row.JobID = r.run.JobID
	persisted, err := r.manager.store.AppendErrorRow(r.ctx, row)
	if err != nil {
		return err
	}
	// Error events are notification metadata only. Source keys and captured row
	// payloads stay in the explicit error-row store and are never broadcast.
	payload, _ := json.Marshal(struct {
		ID            string         `json:"id"`
		SourceTable   string         `json:"sourceTable,omitempty"`
		TargetTable   string         `json:"targetTable,omitempty"`
		Operation     string         `json:"operation,omitempty"`
		PayloadPolicy string         `json:"payloadPolicy,omitempty"`
		PayloadHash   string         `json:"payloadHash,omitempty"`
		PayloadSize   int64          `json:"payloadSize,omitempty"`
		ErrorCode     string         `json:"errorCode,omitempty"`
		ErrorClass    string         `json:"errorClass,omitempty"`
		Status        ErrorRowStatus `json:"status"`
	}{
		ID:            persisted.ID,
		SourceTable:   persisted.SourceTable,
		TargetTable:   persisted.TargetTable,
		Operation:     persisted.Operation,
		PayloadPolicy: persisted.PayloadPolicy,
		PayloadHash:   persisted.PayloadHash,
		PayloadSize:   persisted.PayloadSize,
		ErrorCode:     persisted.ErrorCode,
		ErrorClass:    persisted.ErrorClass,
		Status:        persisted.Status,
	})
	_, err = r.manager.appendEvent(r.ctx, r.run, RunEventErrorRow, persisted.Error, payload)
	return err
}

func (r *managerReporter) Emit(eventType RunEventType, message string, payload json.RawMessage) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if eventType == "" {
		eventType = RunEventLog
	}
	_, err := r.manager.appendEvent(r.ctx, r.run, eventType, message, payload)
	return err
}
