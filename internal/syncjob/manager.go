package syncjob

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"
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
	if !options.Passive {
		if err := manager.startRuntime(ctx); err != nil {
			cancel(err)
			return nil, err
		}
	}
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
