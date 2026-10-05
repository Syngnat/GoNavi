package runharness

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
)

var (
	ErrHarnessClosed        = errors.New("agent run harness is closed")
	ErrRootContextRequired  = errors.New("agent run harness root context is required")
	ErrMalformedToolCall    = errors.New("malformed agent tool call")
	ErrToolCallsDisabled    = errors.New("agent tool calls are disabled for this run")
	ErrToolNotFound         = errors.New("agent tool is not registered")
	ErrToolSchema           = errors.New("agent tool arguments do not match schema")
	ErrWorkspaceUnavailable = errors.New("workspace snapshot is unavailable")
	ErrRunExhausted         = errors.New("agent run budget exhausted")
	ErrRunSteered           = errors.New("agent run was steered")
)

const (
	defaultLeaseDuration = DefaultWorkspaceSnapshotLeaseDuration
	defaultShutdownGrace = 10 * time.Second
	maxEventDeltaBytes   = 4 << 10
	maxEventDeltaAge     = 80 * time.Millisecond
)

// AgentRunHarness is the durable orchestration module shared by desktop and
// CLI adapters. It is deliberately independent of Wails and owns one worker
// per queued run; the ledger remains the source of truth across processes.
type AgentRunHarness struct {
	ledger         *Ledger
	model          ModelTurnAdapter
	inputBinder    AgentInputBinder
	contextBuilder ContextBuilder
	tools          ToolCatalog
	instructions   InstructionsResolver
	approvals      ApprovalHandler
	autoApproval   AutoApprovalPolicy
	events         EventSink
	root           context.Context
	cancel         context.CancelFunc
	ownerID        string
	leaseTTL       time.Duration
	shutdownGrace  time.Duration
	defaultPolicy  RunPolicy

	mu        sync.Mutex
	runtimeMu sync.RWMutex
	runtime   RunRuntimeConfig
	runs      map[string]*runExecution
	closed    atomic.Bool
	wg        sync.WaitGroup
}

type runExecution struct {
	runID               string
	sessionID           string
	ctx                 context.Context
	cancel              context.CancelFunc
	stepMu              sync.Mutex
	stepCancel          context.CancelFunc
	leaseMu             sync.RWMutex
	lease               Lease
	wake                chan struct{}
	sideEffect          atomic.Bool
	cancelRequested     atomic.Bool
	steerPending        atomic.Bool
	shutdownRequested   atomic.Bool
	leaseLost           atomic.Bool
	allowStaleWorkspace atomic.Bool
	terminal            atomic.Bool
	started             atomic.Bool
	done                chan struct{}
	steerMu             sync.Mutex
	steers              []steerRequest
	// controlClaims prevents a polling worker from applying the same leased
	// command repeatedly while its durable action is waiting for the next run
	// phase (notably steer and side-effect cancellation). The claim itself
	// remains durable and can be reclaimed after a process crash.
	controlMu     sync.Mutex
	controlClaims map[string]struct{}
	// staleWorkspaceCommands are explicit use-stale approvals that have been
	// claimed but cannot be acknowledged until the worker has successfully
	// crossed the workspace recovery boundary. Keeping the IDs durable in the
	// command table and pending here closes the crash window between that
	// boundary and the acknowledgement write.
	staleWorkspaceCommands map[string]struct{}
	// toolCatalog is loaded once after the durable run boundary is acquired.
	// The worker keeps this immutable projection for every model/tool turn;
	// Resolve may still consult the live catalog for an executor, but never for
	// the contract used to validate or execute a call.
	toolCatalogMu     sync.RWMutex
	toolCatalog       []ToolDescriptor
	toolCatalogLoaded bool
}

// steerRequest keeps the durable control-command id alongside the text.  The
// id is propagated to the atomic Ledger boundary so a consumed command can be
// replayed safely after an owner crash without appending a second user input.
type steerRequest struct {
	requestID        string
	content          string
	expectedRevision int64
	// prevalidated is set only after the claimed control command has passed
	// its exact expectedRevision check under this run owner. A read-only/model
	// step can then be canceled as part of that same steer; its resulting
	// durable event is an owned, serial consequence rather than a reason to
	// reinterpret a delayed command against a newer run revision.
	prevalidated bool
}

func (s steerRequest) transitionExpectedRevision() int64 {
	if s.prevalidated {
		return 0
	}
	return s.expectedRevision
}

// NewAgentRunHarness creates a run harness. A ledger is mandatory; callers
// that omit a model or tool catalog can still use it for durable queue/control
// operations, but queued runs will fail with a typed provider/tool error.
func NewAgentRunHarness(config HarnessConfig, options ...HarnessOption) (*AgentRunHarness, error) {
	for _, option := range options {
		if option != nil {
			option(&config)
		}
	}
	if config.Ledger == nil {
		return nil, errors.New("agent harness ledger is required")
	}
	runtime := config.Runtime
	if runtime == (RunRuntimeConfig{}) {
		// Preserve the old constructor fields for embedded callers while making
		// Runtime the single live source once a Harness exists.
		runtime = RunRuntimeConfig{
			ControlPollInterval:            config.PollInterval,
			WorkspaceSnapshotRenewInterval: config.WorkspaceSnapshotRenewInterval,
			WorkspaceSnapshotLeaseDuration: config.WorkspaceSnapshotLeaseDuration,
		}
	}
	runtime = runtime.Normalize()
	if err := runtime.Validate(); err != nil {
		return nil, err
	}
	root := config.RootContext
	if root == nil {
		return nil, ErrRootContextRequired
	}
	root, cancel := context.WithCancel(root)
	ownerID := strings.TrimSpace(config.OwnerID)
	if ownerID == "" {
		ownerID = uuid.NewString()
	}
	leaseTTL := config.LeaseDuration
	if leaseTTL <= 0 {
		leaseTTL = defaultLeaseDuration
	}
	shutdownGrace := config.ShutdownGracePeriod
	if shutdownGrace <= 0 {
		shutdownGrace = defaultShutdownGrace
	}
	contextBuilder := config.ContextBuilder
	if contextBuilder == nil {
		contextBuilder = NewDeterministicContextBuilder()
	}
	return &AgentRunHarness{
		ledger: config.Ledger, model: config.Model, inputBinder: config.InputBinder, contextBuilder: contextBuilder, tools: config.Tools,
		instructions: config.Instructions,
		approvals:    config.Approvals, autoApproval: config.AutoApproval, events: config.Events, root: root,
		cancel: cancel, ownerID: ownerID, leaseTTL: leaseTTL,
		shutdownGrace: shutdownGrace, defaultPolicy: DefaultRunPolicy(),
		runtime: runtime, runs: make(map[string]*runExecution),
	}, nil
}

// WorkspaceSnapshotLeaseConfig returns the current source liveness contract.
// Adapters use the renewal interval for their source timer while the Ledger
// enforces the lease duration on each publication.
func (h *AgentRunHarness) WorkspaceSnapshotLeaseConfig() WorkspaceSnapshotLeaseConfig {
	if h == nil {
		return DefaultWorkspaceSnapshotLeaseConfig()
	}
	runtime := h.RuntimeConfig()
	return WorkspaceSnapshotLeaseConfig{
		LeaseDuration: runtime.WorkspaceSnapshotLeaseDuration,
		RenewInterval: runtime.WorkspaceSnapshotRenewInterval,
	}
}

// RuntimeConfig returns the live coordination settings used by the Harness.
// It is safe to read while workers are polling or publishing snapshots.
func (h *AgentRunHarness) RuntimeConfig() RunRuntimeConfig {
	if h == nil {
		return DefaultRunRuntimeConfig()
	}
	h.runtimeMu.RLock()
	defer h.runtimeMu.RUnlock()
	return h.runtime
}

// SetRuntimeConfig changes coordination intervals without recreating workers.
// Existing timers are woken so their next wait observes the new configuration
// rather than the previously scheduled deadline.
func (h *AgentRunHarness) SetRuntimeConfig(config RunRuntimeConfig) error {
	if err := h.ensureOpen(); err != nil {
		return err
	}
	config = config.Normalize()
	if err := config.Validate(); err != nil {
		return err
	}
	h.runtimeMu.Lock()
	changed := h.runtime != config
	h.runtime = config
	h.runtimeMu.Unlock()
	if changed {
		h.wakeWorkers()
	}
	return nil
}

func (h *AgentRunHarness) pollInterval() time.Duration {
	return h.RuntimeConfig().ControlPollInterval
}

func (h *AgentRunHarness) workspaceSnapshotLeaseDuration() time.Duration {
	return h.RuntimeConfig().WorkspaceSnapshotLeaseDuration
}

func (h *AgentRunHarness) wakeWorkers() {
	if h == nil {
		return
	}
	h.mu.Lock()
	workers := make([]*runExecution, 0, len(h.runs))
	for _, execution := range h.runs {
		workers = append(workers, execution)
	}
	h.mu.Unlock()
	for _, execution := range workers {
		execution.wakeWorker()
	}
}

// NewHarness is a concise constructor retained for adapters and tests.
func NewHarness(config HarnessConfig, options ...HarnessOption) (*AgentRunHarness, error) {
	return NewAgentRunHarness(config, options...)
}

func (h *AgentRunHarness) ensureOpen() error {
	if h == nil || h.closed.Load() {
		return ErrHarnessClosed
	}
	return nil
}

// SetDefaultPolicy changes the policy used for future runs. Existing runs
// retain their frozen policy in the ledger.
func (h *AgentRunHarness) SetDefaultPolicy(policy RunPolicy) error {
	if err := policy.Validate(); err != nil {
		return err
	}
	h.mu.Lock()
	h.defaultPolicy = policy.Normalize()
	h.mu.Unlock()
	return nil
}

func (h *AgentRunHarness) DefaultPolicy() RunPolicy {
	if h == nil {
		return DefaultRunPolicy()
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.defaultPolicy
}

var _ Harness = (*AgentRunHarness)(nil)
