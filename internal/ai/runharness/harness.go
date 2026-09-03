package runharness

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
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
	approvals      ApprovalHandler
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
		approvals: config.Approvals, events: config.Events, root: root,
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

// SubmitInput durably accepts a user input and starts or queues exactly one
// run. A requestId is idempotent even when the worker is already running.
func (h *AgentRunHarness) SubmitInput(ctx context.Context, request AgentInputRequest) (AgentInputReceipt, error) {
	if err := h.ensureOpen(); err != nil {
		return AgentInputReceipt{}, err
	}
	if err := request.Validate(); err != nil {
		return AgentInputReceipt{}, err
	}
	if ctx == nil {
		ctx = h.root
	}
	// requestId is the idempotency boundary. Resolve an already durable run
	// before consulting mutable catalogs or provider configuration so a retry
	// remains successful even if the host is temporarily reconfiguring tools.
	if existing, existingErr := h.ledger.GetRunByRequestID(ctx, request.RequestID); existingErr == nil {
		if !existing.State.Terminal() {
			h.startWorker(existing)
		}
		disposition := "started"
		if existing.State != RunStateQueued {
			disposition = "queued"
		}
		return AgentInputReceipt{RequestID: request.RequestID, SessionID: existing.SessionID, RunID: existing.ID, Disposition: disposition, Revision: existing.Revision, State: existing.State}, nil
	} else if !errors.Is(existingErr, ErrNotFound) {
		return AgentInputReceipt{}, existingErr
	}
	if receipt, replayed, replayErr := h.replayExistingSteer(ctx, request); replayed || replayErr != nil {
		return receipt, replayErr
	}
	originalRequest := request
	if h.inputBinder != nil {
		if err := h.inputBinder(ctx, &request); err != nil {
			// A second supervisor can accept the same steer while this host is
			// resolving mutable provider settings. Recheck its durable command
			// before surfacing a stale configuration failure to a retry.
			if receipt, replayed, replayErr := h.replayExistingSteer(ctx, originalRequest); replayed || replayErr != nil {
				return receipt, replayErr
			}
			return AgentInputReceipt{}, err
		}
	}
	policy := h.DefaultPolicy()
	mode := request.DispatchMode
	if mode == "" {
		mode = policy.DefaultDispatchMode
	}
	if !mode.Valid() {
		return AgentInputReceipt{}, fmt.Errorf("invalid dispatchMode %q", mode)
	}
	sessionID := strings.TrimSpace(request.SessionID)
	implicitSession := sessionID == ""
	branchFromMessageID := strings.TrimSpace(request.BranchFromMessageID)
	branched := branchFromMessageID != ""
	// An explicit session is an update to an existing conversation projection.
	// Keep the idempotency lookup above this guard so a transport retry can
	// still return its original receipt after that projection has advanced.
	if !implicitSession && request.ExpectedRevision <= 0 {
		return AgentInputReceipt{}, fmt.Errorf("%w: expectedRevision must be positive for a session-bound input", ErrRevisionConflict)
	}
	if branched {
		// A branch is always a new queued/run-able conversation. In particular it
		// must never steer an active run in the source session: doing that would
		// mutate the original transcript instead of preserving it for audit.
		branchSessionID := deterministicBranchSessionID(request.RequestID)
		branch, err := h.ledger.CreateSessionBranch(ctx, CreateSessionBranchRequest{
			SessionID:              branchSessionID,
			SourceSessionID:        sessionID,
			BranchFromMessageID:    branchFromMessageID,
			ExpectedSourceRevision: request.ExpectedRevision,
			Title:                  firstLine(request.Content),
		})
		if err != nil {
			return AgentInputReceipt{}, err
		}
		sessionID = branch.ID
		mode = DispatchQueue
	} else if sessionID == "" {
		// Keep the implicit conversation identity stable across transport
		// retries.  Creating a random session before CreateRun used to leave an
		// orphan session whenever two submissions raced (or a retry arrived
		// after the first run had already been persisted).  CreateRun now creates
		// this deterministic session in the same SQLite transaction as the run.
		sessionID = deterministicInputSessionID(request.RequestID)
	}
	active, err := h.findActiveRun(ctx, sessionID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return AgentInputReceipt{}, err
	}
	// Do not persist a steer until the message/catalog envelope is ready. The
	// final decision (steer versus queued fallback) is made atomically by the
	// Ledger after that envelope is built, closing the terminal-race window.
	steerTarget := active

	var expectedSessionRevision int64
	if request.ExpectedRevision > 0 && !branched && steerTarget.ID == "" {
		expectedSessionRevision = request.ExpectedRevision
		if implicitSession {
			// CreateRun performs this check after it has provisionally created the
			// implicit session, inside the same transaction. A failed CAS therefore
			// rolls the session back instead of returning a stray empty session.
			goto revisionGuardDone
		}
		// SubmitInput's revision guard applies to the session projection when a
		// new queued run is created. The active-run guard for a steer is evaluated
		// atomically with command insertion below.
		projection, projectionErr := h.ledger.GetSession(ctx, sessionID, false)
		if errors.Is(projectionErr, ErrNotFound) {
			// The caller binds the input to a conversation this ledger no longer
			// contains — UI state can outlive the ledger when the data root or
			// the ledger file is replaced. Failing the send would strand the
			// panel on an unfixable error, so fall back to a fresh implicit
			// conversation; the receipt's SessionID lets the adapter rebuild its
			// projection, mirroring the implicit path above.
			sessionID = deterministicInputSessionID(request.RequestID)
			expectedSessionRevision = 0
			goto revisionGuardDone
		}
		if projectionErr != nil {
			return AgentInputReceipt{}, projectionErr
		}
		if projection.Revision != expectedSessionRevision {
			return AgentInputReceipt{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, expectedSessionRevision, projection.Revision)
		}
	}

revisionGuardDone:
	var toolCatalogBinding *ToolCatalogBinding
	allowTools := true
	if request.AllowTools != nil {
		allowTools = *request.AllowTools
	}
	if allowTools && h.tools != nil {
		binding, bindingErr := FreezeToolCatalog(ctx, h.tools)
		if bindingErr != nil {
			return AgentInputReceipt{}, fmt.Errorf("freeze tool catalog: %w", bindingErr)
		}
		toolCatalogBinding = &binding
	}
	message := &Message{ID: uuid.NewString(), SessionID: sessionID, Role: "user", Content: request.Content, Attachments: append([]Attachment(nil), request.Attachments...), CreatedAt: time.Now().UTC()}
	createRequest := CreateRunRequest{
		SessionID: sessionID, RequestID: request.RequestID, InitialMessage: message,
		Policy: policy, Provider: request.Provider, Model: request.Model,
		ContextSourceID: request.ContextSourceID, ContextSourceInstanceID: request.ContextSourceInstanceID,
		Thinking: request.Thinking, Temperature: request.Temperature, MaxTokens: request.MaxTokens,
		TaskKind: request.TaskKind, AllowTools: request.AllowTools,
		ProviderBinding:         request.providerBindingCopy(),
		ToolCatalogBinding:      toolCatalogBinding,
		ExpectedSessionRevision: expectedSessionRevision,
	}
	if mode == DispatchSteer && steerTarget.ID != "" {
		payload, payloadErr := marshalSteerInputPayload(request)
		if payloadErr != nil {
			return AgentInputReceipt{}, payloadErr
		}
		atomicResult, atomicErr := h.ledger.EnqueueSteerOrCreateRun(ctx, SteerOrQueueRequest{
			Command:   ControlCommand{ID: request.RequestID, RunID: steerTarget.ID, Action: ControlSteer, Payload: payload, ExpectedRevision: request.ExpectedRevision},
			CreateRun: createRequest,
		})
		if atomicErr != nil {
			return AgentInputReceipt{}, atomicErr
		}
		run := atomicResult.Run
		if atomicResult.Disposition == "steered" {
			h.signalSteer(run.ID)
		} else if !run.State.Terminal() {
			h.startWorker(run)
		}
		return AgentInputReceipt{RequestID: request.RequestID, SessionID: run.SessionID, RunID: run.ID,
			Disposition: atomicResult.Disposition, Revision: run.Revision, State: run.State}, nil
	}
	run, err := h.ledger.CreateRun(ctx, createRequest)
	if err != nil {
		// Two supervisors can pass the initial request lookup concurrently. The
		// unique request_id constraint is the durable winner; recover its run and
		// return the same receipt instead of surfacing a spurious database error.
		if isUniqueConstraint(err) {
			if existing, lookupErr := h.ledger.GetRunByRequestID(ctx, request.RequestID); lookupErr == nil {
				if !existing.State.Terminal() {
					h.startWorker(existing)
				}
				disposition := "started"
				if existing.State == RunStateQueued {
					disposition = "queued"
				}
				return AgentInputReceipt{RequestID: request.RequestID, SessionID: existing.SessionID, RunID: existing.ID,
					Disposition: disposition, Revision: existing.Revision, State: existing.State}, nil
			}
		}
		return AgentInputReceipt{}, err
	}
	// CreateRun is the idempotency boundary.  In particular, a retry may have
	// supplied a stale/different session hint; always return the durable run's
	// session so adapters can rebuild the correct projection.
	sessionID = run.SessionID
	disposition := "started"
	if active.ID != "" {
		disposition = "queued"
	}
	h.startWorker(run)
	return AgentInputReceipt{RequestID: request.RequestID, SessionID: sessionID, RunID: run.ID, Disposition: disposition, Revision: run.Revision, State: run.State}, nil
}

// deterministicBranchSessionID gives an edit/retry submission a stable
// session identifier. A transport retry can therefore replay CreateSession-
// Branch and CreateRun safely without creating duplicate audit branches.
func deterministicBranchSessionID(requestID string) string {
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte("gonavi-agent-branch:"+requestID)).String()
}

// deterministicInputSessionID gives an input without an explicit session a
// stable conversation identity.  It is intentionally distinct from branch
// IDs so a request key cannot accidentally collide with an edit/retry branch.
func deterministicInputSessionID(requestID string) string {
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte("gonavi-agent-session:"+requestID)).String()
}

func firstLine(content string) string {
	line := strings.TrimSpace(strings.SplitN(strings.ReplaceAll(content, "\r\n", "\n"), "\n", 2)[0])
	if len(line) > 80 {
		line = line[:80]
	}
	if line == "" {
		return "New agent session"
	}
	return line
}

func isUniqueConstraint(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "unique") || strings.Contains(message, "constraint")
}

// replayExistingSteer resolves the second durable representation of an input
// idempotency key. Steers live in control_commands rather than runs, so they
// must be replayed before consulting host-owned mutable provider settings.
func (h *AgentRunHarness) replayExistingSteer(ctx context.Context, request AgentInputRequest) (AgentInputReceipt, bool, error) {
	command, err := h.ledger.GetControlCommand(ctx, request.RequestID)
	if errors.Is(err, ErrNotFound) {
		return AgentInputReceipt{}, false, nil
	}
	if err != nil {
		return AgentInputReceipt{}, false, err
	}
	if command.Action != ControlSteer {
		return AgentInputReceipt{}, true, fmt.Errorf("%w: id %q is already bound to action %q", ErrControlCommandConflict, command.ID, command.Action)
	}
	if request.DispatchMode != "" && request.DispatchMode != DispatchSteer {
		return AgentInputReceipt{}, true, fmt.Errorf("%w: id %q is already bound to a steer", ErrControlCommandConflict, command.ID)
	}
	if strings.TrimSpace(request.BranchFromMessageID) != "" {
		return AgentInputReceipt{}, true, fmt.Errorf("%w: id %q is already bound to a steer and cannot create a branch", ErrControlCommandConflict, command.ID)
	}
	run, err := h.ledger.GetRun(ctx, command.RunID)
	if err != nil {
		return AgentInputReceipt{}, true, err
	}
	if sessionID := strings.TrimSpace(request.SessionID); sessionID != "" && sessionID != run.SessionID {
		return AgentInputReceipt{}, true, fmt.Errorf("%w: id %q is already bound to session %q", ErrControlCommandConflict, command.ID, run.SessionID)
	}
	if request.ExpectedRevision != command.ExpectedRevision {
		return AgentInputReceipt{}, true, fmt.Errorf("%w: id %q is already bound to revision %d", ErrControlCommandConflict, command.ID, command.ExpectedRevision)
	}
	payload, err := marshalSteerInputPayload(request)
	if err != nil {
		return AgentInputReceipt{}, true, err
	}
	if !bytes.Equal(bytes.TrimSpace(command.Payload), bytes.TrimSpace(payload)) {
		return AgentInputReceipt{}, true, fmt.Errorf("%w: id %q is already bound to another steer", ErrControlCommandConflict, command.ID)
	}
	h.signalSteer(run.ID)
	return AgentInputReceipt{
		RequestID: request.RequestID, SessionID: run.SessionID, RunID: run.ID,
		Disposition: "steered", Revision: run.Revision, State: run.State,
	}, true, nil
}

func marshalSteerInputPayload(request AgentInputRequest) (json.RawMessage, error) {
	payload, err := json.Marshal(map[string]any{
		"content":                 request.Content,
		"contextSourceId":         request.ContextSourceID,
		"contextSourceInstanceId": request.ContextSourceInstanceID,
	})
	if err != nil {
		return nil, err
	}
	return payload, nil
}

func (h *AgentRunHarness) findActiveRun(ctx context.Context, sessionID string) (RunSnapshot, error) {
	projection, err := h.ledger.GetSession(ctx, sessionID, false)
	if err != nil {
		return RunSnapshot{}, err
	}
	var candidate RunSnapshot
	for _, run := range projection.Runs {
		if run.State.Terminal() {
			continue
		}
		if candidate.ID == "" || run.CreatedAt.Before(candidate.CreatedAt) {
			candidate = run
		}
	}
	if candidate.ID == "" {
		return RunSnapshot{}, ErrNotFound
	}
	return candidate, nil
}

func (h *AgentRunHarness) startWorker(run RunSnapshot) {
	if run.ID == "" || run.State.Terminal() || h.closed.Load() {
		return
	}
	h.mu.Lock()
	if h.closed.Load() {
		h.mu.Unlock()
		return
	}
	if _, exists := h.runs[run.ID]; exists {
		h.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(h.root)
	execution := &runExecution{runID: run.ID, sessionID: run.SessionID, ctx: ctx, cancel: cancel, done: make(chan struct{}), wake: make(chan struct{}, 1), controlClaims: make(map[string]struct{}), staleWorkspaceCommands: make(map[string]struct{})}
	h.runs[run.ID] = execution
	h.wg.Add(1)
	h.mu.Unlock()
	go func() {
		defer h.wg.Done()
		defer close(execution.done)
		defer func() {
			h.mu.Lock()
			delete(h.runs, run.ID)
			h.mu.Unlock()
			cancel()
		}()
		h.run(execution)
	}()
}

func (h *AgentRunHarness) signalSteer(runID string) {
	h.mu.Lock()
	execution := h.runs[runID]
	h.mu.Unlock()
	if execution == nil {
		return
	}
	// Validate and claim the durable command before interrupting a local step.
	// Without this ordering, a canceled read-only tool can commit its result
	// first and make a command that was current at receipt look falsely stale.
	// A remote owner still validates at its own consume boundary; this fast path
	// only exists for the owner that is about to cancel its local context.
	if !execution.sideEffect.Load() {
		h.consumeControlCommands(h.durableContext(), execution)
		if execution.hasSteer() && !execution.sideEffect.Load() {
			execution.cancelStep()
		}
	}
	execution.wakeWorker()
}

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
	modelRetries, malformedRetries := 0, 0
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

		// Build the provider projection only after the newest durable transcript
		// and workspace snapshot are available. ContextLimit is handled before any
		// token reservation or provider call, so failed builds cannot leak budget.
		built, buildErr := h.contextBuilder.Build(ctx, ContextBuildRequest{
			Run:                run,
			Messages:           messages,
			Tools:              descriptors,
			WorkspaceSnapshot:  workspaceSnapshot,
			WorkspaceReference: workspaceReference,
			ConversationCursor: conversationCursor,
			ProviderState:      providerState,
		})
		if buildErr != nil {
			if errors.Is(buildErr, ErrContextLimit) {
				h.failRun(h.durableContext(), run, "context_limit", buildErr, execution)
			} else if errors.Is(buildErr, context.Canceled) || errors.Is(buildErr, context.DeadlineExceeded) {
				h.finishCanceled(h.durableContext(), run.ID, "canceled", execution)
			} else {
				h.failRun(h.durableContext(), run, "context", buildErr, execution)
			}
			return
		}
		request := built.Request
		// Provider configuration is accepted as an encrypted, immutable run
		// contract. Reload it for every attempt so process recovery never falls
		// back to mutable desktop/CLI provider settings.
		if strings.TrimSpace(run.Provider) != "" {
			binding, bindingErr := h.ledger.GetProviderBinding(ctx, run.ID)
			if bindingErr != nil {
				h.failRun(h.durableContext(), run, "provider_binding", bindingErr, execution)
				return
			}
			request.ProviderBinding = cloneProviderBinding(&binding)
		}
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
		if malformed := validateRunToolIntents(result.ToolCalls, descriptors, allowToolsForTurn); malformed != nil {
			_ = h.releaseModelReservation(h.durableContext(), run.ID, reservation.ID, execution.ownerToken())
			h.emitError(h.durableContext(), run, "malformed_tool_call", malformed.Error(), execution)
			if malformedRetries < 1 {
				malformedRetries++
				// Keep the repair signal structured and outside the tool-call
				// transcript. A synthetic tool message/call ID can itself poison
				// providers that validate tool-call pairing.
				repair := Message{ID: uuid.NewString(), SessionID: run.SessionID, RunID: run.ID, Role: "system", Content: `{"error":"malformed_tool_call","action":"repair"}`, Metadata: json.RawMessage(`{"code":"malformed_tool_call"}`), CreatedAt: time.Now().UTC()}
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

// messagesForRun selects the provider transcript boundary for the durable
// task kind. Chat is conversational and keeps the session history; query
// editor generation is a one-shot draft operation and must not inherit other
// editor requests or chat turns from a shared session.
func (h *AgentRunHarness) messagesForRun(ctx context.Context, run RunSnapshot) ([]Message, error) {
	const pageSize = 10000
	messages := make([]Message, 0)
	afterSequence := int64(0)
	for {
		var (
			page []Message
			err  error
		)
		if run.TaskKind.Normalize() == AgentTaskKindQueryEditorGeneration {
			page, err = h.ledger.GetRunMessages(ctx, run.ID, afterSequence, pageSize)
		} else {
			page, err = h.ledger.GetMessages(ctx, run.SessionID, afterSequence, pageSize)
		}
		if err != nil {
			return nil, err
		}
		messages = append(messages, page...)
		if len(page) < pageSize {
			return messages, nil
		}
		lastSequence := page[len(page)-1].Sequence
		if lastSequence <= afterSequence {
			return nil, fmt.Errorf("durable message pagination did not advance past sequence %d", afterSequence)
		}
		afterSequence = lastSequence
	}
}

// resumeAwaitingApproval consumes a decided approval after a process boundary.
// It returns false for a still-pending approval so callers can release their
// lease without changing the durable awaiting_approval state.
func (h *AgentRunHarness) resumeAwaitingApproval(ctx context.Context, run *RunSnapshot, messages *[]Message, execution *runExecution) (bool, error) {
	if h == nil || run == nil || messages == nil || execution == nil {
		return false, errors.New("approval resume requires a run owner")
	}
	approval, err := h.ledger.LatestApprovalForRun(ctx, run.ID)
	if errors.Is(err, ErrNotFound) {
		return false, errors.New("awaiting approval has no durable approval record")
	}
	if err != nil {
		return false, err
	}
	if approval.Status == "pending" {
		return false, nil
	}
	if approval.Status != "approved" && approval.Status != "denied" && approval.Status != "expired" {
		return false, fmt.Errorf("invalid approval status %q", approval.Status)
	}
	current, err := h.ledger.GetRun(ctx, run.ID)
	if err != nil {
		return false, err
	}
	if current.State != RunStateAwaitingApproval {
		*run = current
		return current.State != RunStateAwaitingApproval && !current.State.Terminal(), nil
	}
	decision := strings.ToLower(strings.TrimSpace(approval.Status))
	nextState := RunStateRunningModel
	if decision == "approved" {
		nextState = RunStateRunningTool
	}
	if _, err := h.appendState(ctx, current, EventApproval, nextState, newApprovalEvent(approval.ApprovalID, approval.CallID, approval.ToolName, approval.Effect, approval.ArgsHash, decision), execution, ""); err != nil {
		return false, err
	}
	*run, err = h.refreshRun(ctx, run.ID)
	if err != nil {
		return false, err
	}
	if decision != "approved" {
		denied := Message{ID: uuid.NewString(), SessionID: run.SessionID, RunID: run.ID, Role: "tool", ToolCallID: approval.CallID, Content: `{"error":"approval_denied"}`, CreatedAt: time.Now().UTC()}
		appended, appendErr := h.ledger.AppendMessage(h.durableContext(), denied)
		if appendErr != nil {
			return false, appendErr
		}
		*messages = append(*messages, appended)
		return true, nil
	}
	intent := ToolIntent{CallID: approval.CallID, ToolName: approval.ToolName, Arguments: append(json.RawMessage(nil), approval.Arguments...), Effect: approval.Effect, ArgsHash: approval.ArgsHash}
	execution.sideEffect.Store(intent.Effect == ToolEffectSideEffect || intent.Effect == ToolEffectSideEffectUnknown)
	startedAt := time.Now()
	toolResult, toolErr := h.executeTool(ctx, *run, intent, execution, execution.ownerToken())
	execution.sideEffect.Store(false)
	h.addActiveDuration(h.durableContext(), run.ID, time.Since(startedAt), execution.ownerToken())
	if appendErr := h.appendToolResultMessage(run, messages, intent.CallID, toolResult, toolErr); appendErr != nil {
		return false, appendErr
	}
	return true, nil
}

func (h *AgentRunHarness) appendToolResultMessage(run *RunSnapshot, messages *[]Message, callID string, result ToolExecutionResult, toolErr error) error {
	if h == nil || run == nil || messages == nil {
		return errors.New("tool result message requires a run")
	}
	if result.Message != nil {
		*messages = append(*messages, *result.Message)
		return nil
	}
	if result.MessagePersisted {
		return nil
	}
	content := marshalToolResult(result, toolErr)
	toolMessage := Message{ID: uuid.NewString(), SessionID: run.SessionID, RunID: run.ID, Role: "tool", ToolCallID: callID, Content: content, CreatedAt: time.Now().UTC()}
	appended, err := h.ledger.AppendMessage(h.durableContext(), toolMessage)
	if err != nil {
		return err
	}
	*messages = append(*messages, appended)
	return nil
}

// acquireLease keeps a queued worker alive while another supervisor owns the
// run. A one-shot lease attempt used to strand queued work permanently after a
// desktop/CLI hand-off.
func (h *AgentRunHarness) acquireLease(ctx context.Context, execution *runExecution, run RunSnapshot) (Lease, error) {
	for {
		if ctx.Err() != nil {
			return Lease{}, ctx.Err()
		}
		lease, err := h.ledger.AcquireLease(ctx, run.ID, h.ownerID, h.leaseTTL)
		if err == nil {
			return lease, nil
		}
		if !errors.Is(err, ErrLeaseUnavailable) {
			return Lease{}, err
		}
		latest, refreshErr := h.ledger.GetRun(ctx, run.ID)
		if refreshErr != nil {
			return Lease{}, refreshErr
		}
		if latest.State.Terminal() {
			return Lease{}, ErrTerminalRun
		}
		timer := time.NewTimer(h.pollInterval())
		select {
		case <-ctx.Done():
			timer.Stop()
			return Lease{}, ctx.Err()
		case <-execution.wake:
			timer.Stop()
		case <-timer.C:
		}
	}
}

func (h *AgentRunHarness) waitForFIFO(ctx context.Context, execution *runExecution, target RunSnapshot) bool {
	for {
		if ctx.Err() != nil {
			return false
		}
		projection, err := h.ledger.GetSession(ctx, target.SessionID, false)
		if err != nil {
			return false
		}
		blocked := false
		for _, run := range projection.Runs {
			if run.ID == target.ID || run.State.Terminal() || !runPrecedes(run, target) {
				continue
			}
			blocked = true
			break
		}
		if !blocked {
			return true
		}
		timer := time.NewTimer(h.pollInterval())
		select {
		case <-ctx.Done():
			timer.Stop()
			return false
		case <-execution.wake:
			timer.Stop()
		case <-timer.C:
		}
	}
}

func runPrecedes(left, right RunSnapshot) bool {
	if left.CreatedAt.Before(right.CreatedAt) {
		return true
	}
	if left.CreatedAt.After(right.CreatedAt) {
		return false
	}
	// SQLite timestamps have nanosecond precision, but callers can submit
	// externally constructed runs with identical timestamps. A deterministic ID
	// tie-breaker keeps the FIFO gate mutually exclusive in that case.
	return left.ID < right.ID
}

func (h *AgentRunHarness) listTools(ctx context.Context) ([]ToolDescriptor, error) {
	if h.tools == nil {
		return nil, nil
	}
	items, err := h.tools.List(ctx)
	if err != nil {
		return nil, err
	}
	return items, nil
}

// projectModelDeltaToolIntents keeps intermediate provider fragments out of
// the durable event envelope. A streaming provider may emit `{"query":`
// before completing a tool call; json.RawMessage rejects that fragment during
// event serialization. The original intent remains untouched so final-turn
// validation still returns malformed_tool_call rather than treating it as {}.
func projectModelDeltaToolIntents(intents []ToolIntent) []ToolIntent {
	if len(intents) == 0 {
		return nil
	}
	projected := make([]ToolIntent, len(intents))
	copy(projected, intents)
	for index := range projected {
		if len(projected[index].Arguments) > 0 && !json.Valid(projected[index].Arguments) {
			projected[index].Arguments = nil
		}
	}
	return projected
}

func (h *AgentRunHarness) executeModel(ctx context.Context, request ModelTurnRequest, run RunSnapshot, execution *runExecution) (ModelTurnResult, error) {
	if h.model == nil {
		return ModelTurnResult{}, errors.New("model adapter is unavailable")
	}
	if ctx == nil {
		ctx = h.root
	}
	// RunPolicy owns model timing. Provider adapters must not impose a whole
	// response-body timeout (especially for Responses SSE), while the harness
	// can still enforce an optional turn and idle budget.
	modelCtx, cancelModel := context.WithCancel(ctx)
	defer cancelModel()
	var turnTimedOut atomic.Bool
	if request.Policy.ModelTurnTimeout > 0 {
		go func() {
			timer := time.NewTimer(request.Policy.ModelTurnTimeout)
			defer timer.Stop()
			select {
			case <-timer.C:
				if ctx.Err() == nil {
					turnTimedOut.Store(true)
					cancelModel()
				}
			case <-modelCtx.Done():
			}
		}()
	}
	var idleReset chan struct{}
	var idleTimedOut atomic.Bool
	if request.Policy.ModelIdleTimeout > 0 {
		idleReset = make(chan struct{}, 1)
		go func() {
			timer := time.NewTimer(request.Policy.ModelIdleTimeout)
			defer timer.Stop()
			for {
				select {
				case <-timer.C:
					if ctx.Err() == nil {
						idleTimedOut.Store(true)
					}
					cancelModel()
					return
				case <-idleReset:
					if !timer.Stop() {
						select {
						case <-timer.C:
						default:
						}
					}
					timer.Reset(request.Policy.ModelIdleTimeout)
				case <-modelCtx.Done():
					return
				}
			}
		}()
	}
	var mu sync.Mutex
	accepting := true
	closeSink := func() {
		mu.Lock()
		accepting = false
		mu.Unlock()
	}
	// ModelTurnAdapter is an extension seam. A custom adapter can ignore the
	// supplied context or emit a callback after Execute returns, so close the
	// sink at the cancellation boundary instead of trusting adapter behavior.
	stopCancelGate := context.AfterFunc(modelCtx, closeSink)
	defer stopCancelGate()
	var textBuffer, reasoningBuffer strings.Builder
	var pendingCalls []ToolIntent
	lastFlush := time.Now()
	flushLocked := func(force bool) error {
		if textBuffer.Len() == 0 && reasoningBuffer.Len() == 0 && len(pendingCalls) == 0 {
			return nil
		}
		if !force && textBuffer.Len() < maxEventDeltaBytes && reasoningBuffer.Len() < maxEventDeltaBytes && time.Since(lastFlush) < maxEventDeltaAge {
			return nil
		}
		payload := ModelDeltaEvent{Text: textBuffer.String(), Reasoning: reasoningBuffer.String(), ToolCalls: projectModelDeltaToolIntents(pendingCalls)}
		if len(payload.ToolCalls) > 0 {
			payload.CallID = payload.ToolCalls[0].CallID
		}
		// A canceled model step still needs its already-received delta written
		// before the steer/cancel transition. The durable context preserves the
		// harness lifetime while the owner fence rejects stale callbacks.
		eventCtx := modelCtx
		if eventCtx.Err() != nil {
			eventCtx = h.durableContext()
		}
		ownerToken := ""
		if execution != nil {
			ownerToken = execution.ownerToken()
		}
		event, err := h.ledger.AppendEvent(eventCtx, AppendEventRequest{RunID: run.ID, Kind: EventModelDelta, ResultingState: RunStateRunningModel, Payload: payload, OwnerToken: ownerToken})
		if err != nil {
			return err
		}
		h.publish(event)
		textBuffer.Reset()
		reasoningBuffer.Reset()
		pendingCalls = nil
		lastFlush = time.Now()
		return nil
	}
	flush := func(force bool) error {
		mu.Lock()
		defer mu.Unlock()
		return flushLocked(force)
	}
	// Time-based flushing is independent of provider callback cadence. This
	// prevents a long-thinking provider from leaving all deltas only in memory
	// until the turn completes.
	tickerDone := make(chan struct{})
	tickerStopped := make(chan struct{})
	var stopTickerOnce sync.Once
	stopTicker := func() {
		stopTickerOnce.Do(func() { close(tickerDone) })
		<-tickerStopped
	}
	defer stopTicker()
	go func() {
		ticker := time.NewTicker(maxEventDeltaAge)
		defer ticker.Stop()
		defer close(tickerStopped)
		for {
			select {
			case <-ticker.C:
				if err := flush(false); err != nil {
					// The provider callback will observe the same error on its next
					// delivery; there is no safe way to continue writing events.
				}
			case <-tickerDone:
				return
			}
		}
	}()
	sink := ModelDeltaSink(func(deltaContext context.Context, delta ModelDelta) error {
		if deltaContext != nil && deltaContext.Err() != nil {
			return deltaContext.Err()
		}
		mu.Lock()
		defer mu.Unlock()
		if !accepting {
			return context.Canceled
		}
		if execution != nil && (execution.terminal.Load() || (execution.ctx.Err() != nil && !execution.sideEffect.Load())) {
			return context.Canceled
		}
		if delta.Text != "" {
			textBuffer.WriteString(delta.Text)
		}
		if delta.Reasoning != "" {
			reasoningBuffer.WriteString(delta.Reasoning)
		}
		if len(delta.ToolCalls) > 0 {
			pendingCalls = append(pendingCalls, delta.ToolCalls...)
		}
		if idleReset != nil {
			select {
			case idleReset <- struct{}{}:
			default:
			}
		}
		return flushLocked(false)
	})
	type modelExecutionResult struct {
		result ModelTurnResult
		err    error
	}
	// Do not let an implementation of ModelTurnAdapter that ignores ctx strand
	// the sole worker for this run. The buffered channel permits that adapter to
	// finish later without retaining a sender goroutine, while the closed sink
	// rejects every late delta.
	resultCh := make(chan modelExecutionResult, 1)
	go func() {
		result, err := h.model.Execute(modelCtx, request, sink)
		resultCh <- modelExecutionResult{result: result, err: err}
	}()

	var outcome modelExecutionResult
	select {
	case outcome = <-resultCh:
		closeSink()
	case <-modelCtx.Done():
		closeSink()
		stopTicker()
		// Preserve deltas accepted before cancellation, but never accept them
		// into the following model turn.
		_ = flush(true)
		if idleTimedOut.Load() || turnTimedOut.Load() {
			return ModelTurnResult{}, context.DeadlineExceeded
		}
		return ModelTurnResult{}, context.Canceled
	}
	stopTicker()
	if execution != nil && execution.terminal.Load() {
		_ = flush(true)
		return ModelTurnResult{}, context.Canceled
	}
	if modelCtx.Err() != nil {
		_ = flush(true)
		if idleTimedOut.Load() || turnTimedOut.Load() {
			return ModelTurnResult{}, context.DeadlineExceeded
		}
		return ModelTurnResult{}, context.Canceled
	}
	if outcome.err != nil {
		// Preserve any buffered output before reporting the provider failure.
		_ = flush(true)
		if idleTimedOut.Load() || turnTimedOut.Load() {
			return ModelTurnResult{}, context.DeadlineExceeded
		}
		return ModelTurnResult{}, outcome.err
	}
	if err := flush(true); err != nil {
		return ModelTurnResult{}, err
	}
	return outcome.result, nil
}

func (h *AgentRunHarness) appendState(ctx context.Context, run RunSnapshot, kind EventKind, state RunState, payload any, execution *runExecution, terminalReason string) (RunSnapshot, error) {
	if execution != nil && execution.terminal.Load() {
		return run, ErrTerminalRun
	}
	owner := ""
	if execution != nil {
		owner = execution.ownerToken()
	}
	event, err := h.ledger.AppendEvent(ctx, AppendEventRequest{RunID: run.ID, ExpectedRevision: run.Revision, Kind: kind, ResultingState: state, Payload: payload, TerminalReason: terminalReason, OwnerToken: owner})
	if err != nil {
		return run, err
	}
	h.publish(event)
	return h.ledger.GetRun(ctx, run.ID)
}

func (h *AgentRunHarness) publish(event RunEvent) {
	if h.events == nil {
		return
	}
	defer func() { _ = recover() }()
	h.events(event)
}

func (h *AgentRunHarness) refreshRun(ctx context.Context, runID string) (RunSnapshot, error) {
	return h.ledger.GetRun(ctx, runID)
}

func (h *AgentRunHarness) emitError(ctx context.Context, run RunSnapshot, code, message string, execution *runExecution) {
	if execution != nil && execution.terminal.Load() {
		return
	}
	owner := ""
	if execution != nil {
		owner = execution.ownerToken()
	}
	event, err := h.ledger.AppendEvent(ctx, AppendEventRequest{RunID: run.ID, Kind: EventRunError, ResultingState: run.State, Payload: RunErrorEvent{Code: code, Message: message, Retryable: retryableModelErrorCode(code)}, TerminalReason: "", OwnerToken: owner})
	if err == nil {
		h.publish(event)
	}
}

func (h *AgentRunHarness) failRun(ctx context.Context, run RunSnapshot, code string, cause error, execution *runExecution) {
	if execution != nil && execution.terminal.Load() {
		return
	}
	message := "agent run failed"
	if cause != nil {
		message = cause.Error()
	}
	h.emitError(ctx, run, code, message, execution)
	// Persist the provider's full error in the terminal snapshot so a client
	// that missed the separate run_error event can still render the cause.
	_, _ = h.finishTerminal(ctx, run.ID, RunStateFailed, message, code, execution)
}

func (h *AgentRunHarness) finishExhausted(ctx context.Context, run RunSnapshot, execution *runExecution, reason string) {
	if execution != nil && execution.terminal.Swap(true) {
		return
	}
	_, _ = h.finishTerminal(ctx, run.ID, RunStateExhausted, reason, reason, execution)
}

func (h *AgentRunHarness) finishCanceled(ctx context.Context, runID, reason string, executions ...*runExecution) {
	h.finishCanceledForControlCommand(ctx, runID, reason, "", executions...)
}

func (h *AgentRunHarness) finishCanceledForControlCommand(ctx context.Context, runID, reason, commandID string, executions ...*runExecution) {
	h.mu.Lock()
	execution := h.runs[runID]
	h.mu.Unlock()
	if len(executions) > 0 && executions[0] != nil {
		execution = executions[0]
	}
	if execution != nil && execution.terminal.Swap(true) {
		return
	}
	_, _ = h.finishTerminalForControlCommand(ctx, runID, RunStateCanceled, reason, reason, commandID, execution)
}

func (h *AgentRunHarness) finishTerminal(ctx context.Context, runID string, state RunState, reason, errorCode string, executions ...*runExecution) (RunSnapshot, error) {
	return h.finishTerminalForControlCommand(ctx, runID, state, reason, errorCode, "", executions...)
}

func (h *AgentRunHarness) finishTerminalForControlCommand(ctx context.Context, runID string, state RunState, reason, errorCode, commandID string, executions ...*runExecution) (RunSnapshot, error) {
	run, err := h.ledger.GetRun(ctx, runID)
	if err != nil {
		return RunSnapshot{}, err
	}
	if run.State.Terminal() {
		return run, nil
	}
	payload := TerminalEvent{Reason: reason, ErrorCode: errorCode}
	owner := ""
	if len(executions) > 0 && executions[0] != nil {
		owner = executions[0].ownerToken()
	}
	// Cancellation is a two-step transition for every non-terminal state. This
	// preserves the invariant that a terminal event is never emitted directly
	// from queued/running/approval/tool states.
	if state == RunStateCanceled && run.State != RunStateCanceling {
		intermediate, transitionErr := h.ledger.AppendEvent(ctx, AppendEventRequest{RunID: runID, ExpectedRevision: run.Revision, Kind: EventCheckpoint, ResultingState: RunStateCanceling, Payload: CheckpointEvent{Sequence: run.NextSequence - 1}, OwnerToken: owner})
		if transitionErr != nil {
			if errors.Is(transitionErr, ErrTerminalRun) || errors.Is(transitionErr, ErrRevisionConflict) {
				return h.ledger.GetRun(ctx, runID)
			}
			return RunSnapshot{}, transitionErr
		}
		h.publish(intermediate)
		run, err = h.ledger.GetRun(ctx, runID)
		if err != nil {
			return RunSnapshot{}, err
		}
	}
	event, err := h.ledger.AppendEvent(ctx, AppendEventRequest{RunID: runID, ExpectedRevision: run.Revision, Kind: EventTerminal, ResultingState: state, Payload: payload, TerminalReason: reason, OwnerToken: owner, AppliedControlCommandID: commandID})
	if err != nil {
		if errors.Is(err, ErrTerminalRun) || errors.Is(err, ErrRevisionConflict) {
			return h.ledger.GetRun(ctx, runID)
		}
		return RunSnapshot{}, err
	}
	h.publish(event)
	return h.ledger.GetRun(ctx, runID)
}

func (h *AgentRunHarness) awaitApproval(ctx context.Context, run RunSnapshot, intent ToolIntent, execution *runExecution) (bool, error) {
	if execution == nil {
		return false, errors.New("approval requires a run owner")
	}
	// Move the run to awaiting_approval first. The approval is bound to the
	// resulting revision; creating it before this transition made every later
	// decision stale immediately.
	current := run
	approvalID := uuid.NewString()
	approvalArgs := intent.Arguments
	if len(approvalArgs) == 0 {
		approvalArgs = json.RawMessage(`{}`)
	}
	argsHash := ArgsHash(approvalArgs)
	var err error
	if current.State != RunStateAwaitingApproval {
		_, err = h.appendState(ctx, current, EventApproval, RunStateAwaitingApproval, newApprovalEvent(approvalID, intent.CallID, intent.ToolName, intent.Effect, argsHash, "pending"), execution, "")
		if err != nil {
			return false, err
		}
		current, err = h.refreshRun(ctx, run.ID)
		if err != nil {
			return false, err
		}
	}
	approval, err := h.ledger.CreateApproval(ctx, PutApprovalRequest{ApprovalID: approvalID, RunID: run.ID, CallID: intent.CallID, ToolName: intent.ToolName, Effect: intent.Effect, Arguments: approvalArgs, RunRevision: current.Revision, OwnerToken: execution.ownerToken()})
	if err != nil {
		return false, err
	}
	if h.approvals != nil {
		decision, handlerErr := h.approvals.Request(ctx, ApprovalRequest{ApprovalID: approval.ApprovalID, RunID: run.ID, CallID: intent.CallID, ToolName: intent.ToolName, Effect: intent.Effect, Arguments: intent.Arguments, ArgsHash: approval.ArgsHash, RunRevision: current.Revision})
		if handlerErr == nil {
			decisionValue := strings.ToLower(strings.TrimSpace(decision.Decision))
			if decisionValue != "approved" && decisionValue != "denied" {
				return false, fmt.Errorf("invalid approval decision %q", decision.Decision)
			}
			_, handlerErr = h.ledger.DecideApproval(ctx, DecideApprovalRequest{
				ApprovalID: approval.ApprovalID, Decision: decisionValue,
				ExpectedRunRevision: current.Revision,
				ExpectedRunID:       run.ID, ExpectedCallID: intent.CallID,
				ExpectedArgsHash: approval.ArgsHash,
			})
			if handlerErr != nil {
				return false, handlerErr
			}
		} else if errors.Is(handlerErr, ErrApprovalPending) {
			// Non-interactive adapters use this signal to hand control back to
			// their caller after the approval has been durably recorded. Waiting
			// here would make a piped CLI invocation hang indefinitely and would
			// also keep a lease unnecessarily long.
			return false, ErrApprovalPending
		} else {
			return false, handlerErr
		}
	}
	for {
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
		if execution.hasSteer() {
			// Invalidate the exact approval before applying the new instruction.
			_, _ = h.ledger.DecideApproval(h.durableContext(), DecideApprovalRequest{
				ApprovalID: approval.ApprovalID, Decision: "expired",
				ExpectedRunRevision: current.Revision,
				ExpectedRunID:       run.ID, ExpectedCallID: intent.CallID,
				ExpectedArgsHash: approval.ArgsHash,
			})
			return false, ErrRunSteered
		}
		// Commands can arrive from a different desktop/CLI process while the
		// approval card is open.
		h.consumeControlCommands(ctx, execution)
		decision, decisionErr := h.ledger.GetApproval(ctx, approval.ApprovalID)
		if decisionErr != nil {
			return false, decisionErr
		}
		if decision.Status == "approved" || decision.Status == "denied" || decision.Status == "expired" {
			latest, latestErr := h.refreshRun(ctx, run.ID)
			if latestErr != nil {
				return false, latestErr
			}
			nextState := RunStateRunningTool
			if decision.Status != "approved" {
				nextState = RunStateRunningModel
			}
			_, transitionErr := h.appendState(ctx, latest, EventApproval, nextState, newApprovalEvent(approval.ApprovalID, approval.CallID, approval.ToolName, approval.Effect, approval.ArgsHash, decision.Status), execution, "")
			if transitionErr != nil && !errors.Is(transitionErr, ErrTerminalRun) {
				return false, transitionErr
			}
			return decision.Status == "approved", nil
		}
		timer := time.NewTimer(h.pollInterval())
		select {
		case <-ctx.Done():
			timer.Stop()
			return false, ctx.Err()
		case <-execution.wake:
			timer.Stop()
		case <-timer.C:
		}
	}
}

// newApprovalEvent keeps the adapter-facing approval projection deliberately
// separate from encrypted approval arguments. Its summary only communicates
// the effect class, so a SQL statement or any other tool parameter cannot
// cross the Wails/CLI event boundary by accident.
func newApprovalEvent(approvalID, callID, toolName string, effect ToolEffect, argsHash, decision string) ApprovalEvent {
	return ApprovalEvent{
		ApprovalID: approvalID,
		CallID:     callID,
		ToolName:   toolName,
		Effect:     effect,
		ArgsHash:   argsHash,
		Decision:   decision,
		Summary:    approvalDisplaySummary(effect),
	}
}

func approvalDisplaySummary(effect ToolEffect) string {
	switch effect {
	case ToolEffectSideEffect:
		return "This tool can change data or external state."
	case ToolEffectSideEffectUnknown:
		return "This tool may change data or external state."
	default:
		return "This tool requires approval before it can run."
	}
}

func (h *AgentRunHarness) executeTool(ctx context.Context, run RunSnapshot, intent ToolIntent, execution *runExecution, ownerToken string) (ToolExecutionResult, error) {
	return h.executeToolWithRecord(ctx, run, intent, execution, ownerToken, nil, false)
}

// executeToolWithRecord executes a new tool invocation or resumes a durable
// started invocation. A safe recovery (pure/read-only/idempotent) passes the
// existing record and retry=false, which skips StartTool and keeps its attempt;
// an explicit recovery retry passes retry=true, creating a fresh attempt while
// retaining the old unknown-side-effect row for audit.
func (h *AgentRunHarness) executeToolWithRecord(ctx context.Context, run RunSnapshot, intent ToolIntent, execution *runExecution, ownerToken string, pending *ToolCallRecord, retry bool) (ToolExecutionResult, error) {
	if !run.AllowTools {
		return ToolExecutionResult{Status: "failed", ErrorCode: "tool_calls_disabled"}, ErrToolCallsDisabled
	}
	if h.tools == nil {
		return ToolExecutionResult{Status: "failed", ErrorCode: "tool_catalog_unavailable"}, ErrToolNotFound
	}
	if pending != nil {
		if strings.TrimSpace(pending.RunID) != "" && pending.RunID != run.ID {
			return ToolExecutionResult{Status: "failed", ErrorCode: "tool_conflict"}, fmt.Errorf("%w: pending tool belongs to another run", ErrToolConflict)
		}
		if strings.TrimSpace(pending.CallID) != "" && pending.CallID != intent.CallID {
			return ToolExecutionResult{Status: "failed", ErrorCode: "tool_conflict"}, fmt.Errorf("%w: pending call ID mismatch", ErrToolConflict)
		}
		if strings.TrimSpace(pending.ToolName) != "" && pending.ToolName != intent.ToolName {
			return ToolExecutionResult{Status: "failed", ErrorCode: "tool_conflict"}, fmt.Errorf("%w: pending tool name mismatch", ErrToolConflict)
		}
		if len(intent.Arguments) == 0 {
			intent.Arguments = append(json.RawMessage(nil), pending.Arguments...)
		}
		if len(pending.Arguments) > 0 && !jsonEqualRaw(intent.Arguments, pending.Arguments) {
			return ToolExecutionResult{Status: "failed", ErrorCode: "tool_conflict"}, fmt.Errorf("%w: pending tool arguments changed", ErrToolConflict)
		}
		if !retry && pending.Status != "started" {
			// A completion may race a recovery worker. Return the durable result
			// without invoking the executor again; the caller will use the persisted
			// message projection on its next read.
			return ToolExecutionResult{Status: pending.Status, ResultJSON: append(json.RawMessage(nil), pending.Result...), ErrorCode: pending.ErrorCode, UnknownOutcome: pending.UnknownOutcome, Truncated: pending.Truncated, OriginalBytes: pending.OriginalBytes, MessagePersisted: true}, nil
		}
		if !retry && pending.Effect != "" && intent.Effect.Valid() && pending.Effect != intent.Effect {
			return ToolExecutionResult{Status: "failed", ErrorCode: "tool_conflict"}, fmt.Errorf("%w: pending tool effect changed", ErrToolConflict)
		}
	}
	var (
		descriptor    ToolDescriptor
		executor      ToolExecutor
		catalogErr    error
		err           error
		frozenCatalog []ToolDescriptor
		catalogLoaded bool
	)
	if execution != nil {
		frozenCatalog, catalogLoaded = execution.frozenToolCatalog()
	}
	if catalogLoaded {
		descriptor, executor, catalogErr = h.resolveToolForRunWithDescriptors(ctx, run, frozenCatalog, intent.ToolName)
	} else {
		descriptor, executor, catalogErr = h.resolveToolForRun(ctx, run, intent.ToolName)
	}
	err = catalogErr
	if err != nil || executor == nil {
		if err == nil {
			err = ErrToolNotFound
		}
		return ToolExecutionResult{Status: "failed", ErrorCode: toolCatalogErrorCode(err)}, err
	}
	if err := validateToolArguments(descriptor.InputSchema, intent.Arguments); err != nil {
		return ToolExecutionResult{Status: "failed", ErrorCode: "malformed_tool_call"}, err
	}
	resolvedEffect := ToolEffect("")
	if resolver, ok := h.tools.(ToolEffectResolver); ok {
		if effect, resolveErr := resolver.ResolveEffect(ctx, intent.ToolName, intent.Arguments); resolveErr != nil {
			return ToolExecutionResult{Status: "failed", ErrorCode: "tool_effect"}, resolveErr
		} else if effect.Valid() {
			resolvedEffect = effect
			intent.Effect = refineToolEffect(descriptor.Effect, effect)
		}
	}
	// The immutable descriptor is authoritative for the baseline effect. The
	// model-provided intent effect is untrusted and must not downgrade a call;
	// ResolveEffect may refine the conservative baseline for argument-dependent
	// tools such as execute_sql.
	effectiveEffect := descriptor.Effect
	if resolvedEffect.Valid() {
		effectiveEffect = refineToolEffect(descriptor.Effect, resolvedEffect)
	}
	if pending != nil && pending.Effect.Valid() {
		// The durable effect is authoritative for a resumed invocation. Dynamic
		// effect resolution may be unavailable after a restart, but it must never
		// silently downgrade a side-effecting record to read-only.
		if !retry {
			effectiveEffect = pending.Effect
		} else if pending.Effect != effectiveEffect && (pending.Effect == ToolEffectSideEffect || pending.Effect == ToolEffectSideEffectUnknown) {
			return ToolExecutionResult{Status: "failed", ErrorCode: "tool_conflict"}, fmt.Errorf("%w: retry effect changed", ErrToolConflict)
		}
	}
	run, err = h.ledger.GetRun(ctx, run.ID)
	if err != nil {
		return ToolExecutionResult{Status: "failed", ErrorCode: "ledger"}, err
	}
	snapshot := WorkspaceSnapshot{}
	var workspaceReference *WorkspaceSnapshotReference
	if pending != nil && pending.WorkspaceSnapshot != nil {
		workspaceReference = cloneWorkspaceSnapshotReference(pending.WorkspaceSnapshot)
		snapshot, run, err = h.workspaceForPendingTool(ctx, run, *pending.WorkspaceSnapshot, execution)
		if err != nil {
			return ToolExecutionResult{Status: "failed", ErrorCode: "workspace"}, err
		}
	} else if requiresWorkspaceSnapshot(descriptor) {
		if run.ContextSourceID == "" || run.ContextSourceInstanceID == "" {
			return ToolExecutionResult{Status: "failed", ErrorCode: "workspace_unavailable"}, ErrWorkspaceUnavailable
		}
		snapshot, run, err = h.workspaceForTool(ctx, run, execution)
		if err != nil {
			return ToolExecutionResult{Status: "failed", ErrorCode: "workspace"}, err
		}
		// Bind the exact live (or explicitly user-approved stale) snapshot to
		// the durable tool start. The same reference is copied into the tool
		// outcome event and checkpoint, making the executor's context auditable.
		workspaceReference = workspaceSnapshotReference(snapshot)
	}
	if execution != nil {
		if execution.shutdownRequested.Load() {
			return ToolExecutionResult{Status: "canceled", ErrorCode: "harness_shutdown"}, context.Canceled
		}
		if execution.cancelRequested.Load() {
			return ToolExecutionResult{Status: "canceled", ErrorCode: "canceled"}, context.Canceled
		}
		if execution.hasSteer() {
			return ToolExecutionResult{Status: "canceled", ErrorCode: "steered"}, ErrRunSteered
		}
	}
	attempt := run.Attempt
	if attempt < 1 {
		attempt = 1
	}
	if pending != nil && !retry {
		attempt = pending.Attempt
		if attempt < 1 {
			return ToolExecutionResult{Status: "failed", ErrorCode: "tool_conflict"}, fmt.Errorf("%w: pending tool has no attempt", ErrToolConflict)
		}
	} else if pending != nil && retry {
		if pending.Attempt > 0 && attempt <= pending.Attempt {
			return ToolExecutionResult{Status: "failed", ErrorCode: "tool_conflict"}, fmt.Errorf("%w: retry attempt %d is not newer than %d", ErrToolConflict, attempt, pending.Attempt)
		}
	}
	if pending == nil || retry {
		// The start record is the external-operation fence. Check control state
		// immediately before it so a steer that arrived while validation or a
		// workspace lookup was in progress cannot launch an obsolete call.
		if execution != nil {
			h.consumeControlCommands(ctx, execution)
			if execution.shutdownRequested.Load() {
				return ToolExecutionResult{Status: "canceled", ErrorCode: "harness_shutdown"}, context.Canceled
			}
			if execution.cancelRequested.Load() {
				return ToolExecutionResult{Status: "canceled", ErrorCode: "canceled"}, context.Canceled
			}
			if execution.hasSteer() {
				return ToolExecutionResult{Status: "canceled", ErrorCode: "steered"}, ErrRunSteered
			}
		}
		started, err := h.ledger.StartToolAndEvent(ctx, StartToolAndEventRequest{
			StartToolRequest: StartToolRequest{RunID: run.ID, CallID: intent.CallID, Attempt: attempt, ToolName: intent.ToolName, Effect: effectiveEffect, Arguments: intent.Arguments, WorkspaceSnapshot: workspaceReference, ExpectedRevision: run.Revision, OwnerToken: ownerToken},
			ToolEvent:        ToolEvent{CallID: intent.CallID, ToolName: intent.ToolName, Effect: effectiveEffect, Status: "started"},
		})
		if err != nil {
			return ToolExecutionResult{Status: "failed", ErrorCode: "tool_start"}, err
		}
		// The ledger commit is the executor's start fence. Publish only after
		// it succeeds so event consumers never observe an un-recoverable tool.
		if !started.AlreadyStarted && started.Event.Sequence > 0 {
			h.publish(started.Event)
		}
	}
	toolCtx, stepCancel := context.WithCancel(ctx)
	if execution != nil {
		execution.setStepCancel(stepCancel)
	}
	defer func() {
		if execution != nil {
			execution.clearStepCancel(stepCancel)
			return
		}
		stepCancel()
	}()
	toolTimeout := descriptor.DefaultTimeout
	if toolTimeout <= 0 {
		toolTimeout = run.Policy.DefaultToolTimeout
	}
	if toolTimeout > 0 {
		var cancel context.CancelFunc
		toolCtx, cancel = context.WithTimeout(toolCtx, toolTimeout)
		defer cancel()
	}
	result, execErr := executor.Execute(toolCtx, ToolExecutionRequest{RunID: run.ID, CallID: intent.CallID, Attempt: attempt, ToolName: intent.ToolName, Effect: effectiveEffect, Arguments: intent.Arguments, Context: snapshot, Idempotency: fmt.Sprintf("%s:%s:%d", run.ID, intent.CallID, attempt)})
	status := result.Status
	if status == "" {
		status = "completed"
		if execErr != nil {
			status = "failed"
		}
	}
	if effectiveEffect == ToolEffectSideEffect || effectiveEffect == ToolEffectSideEffectUnknown {
		// Unknown means the external operation may have committed even when
		// an executor returned nil (for example, a driver reports the result
		// through a side channel). Treat the marker as authoritative.
		if result.UnknownOutcome || (execErr != nil && (errors.Is(execErr, context.Canceled) || errors.Is(execErr, context.DeadlineExceeded))) {
			result.UnknownOutcome = true
			status = "unknown"
			if result.ErrorCode == "" {
				result.ErrorCode = "outcome_unknown"
			}
		}
	}
	// Encode the outcome exactly once before it enters the durable boundary.
	// The smaller positive cap declared by the tool and frozen in the run policy
	// wins; a zero descriptor cap means that only the policy cap applies.
	encodedResult := encodeToolResult(result, execErr, effectiveToolResultBytes(run.Policy, descriptor))
	result.ResultJSON = append(json.RawMessage(nil), encodedResult.JSON...)
	result.OriginalBytes = encodedResult.OriginalBytes
	result.Truncated = encodedResult.Truncated
	finishCtx := ctx
	if finishCtx == nil || finishCtx.Err() != nil {
		finishCtx = h.durableContext()
	}
	latest, latestErr := h.ledger.GetRun(finishCtx, run.ID)
	if latestErr != nil {
		// Do not expose a successful executor result before its durable tool
		// completion has been committed. The outer loop must not append a
		// message for a result that has no corresponding tool/checkpoint/event.
		return result, latestErr
	}
	if latestErr == nil {
		toolMessage := &Message{ID: uuid.NewString(), SessionID: run.SessionID, RunID: run.ID, Role: "tool", ToolCallID: intent.CallID, Content: string(encodedResult.JSON), CreatedAt: time.Now().UTC()}
		finished, finishErr := h.ledger.FinishToolAndEvent(finishCtx, FinishToolAndEventRequest{
			FinishToolRequest: FinishToolRequest{RunID: run.ID, CallID: intent.CallID, Attempt: attempt, Status: status, Result: result.Value, ResultJSON: encodedResult.JSON, ErrorCode: result.ErrorCode, UnknownOutcome: result.UnknownOutcome, Truncated: encodedResult.Truncated, OriginalBytes: encodedResult.OriginalBytes, MaxResultBytes: effectiveToolResultBytes(run.Policy, descriptor), ExpectedRevision: latest.Revision, OwnerToken: ownerToken},
			WorkspaceSnapshot: workspaceReference,
			ResultingState: func() RunState {
				if status == "unknown" {
					return RunStateRecoveryRequired
				}
				return RunStateRunningModel
			}(),
			ToolEvent:   ToolEvent{CallID: intent.CallID, ToolName: intent.ToolName, Effect: effectiveEffect, Status: status, ErrorCode: result.ErrorCode, Result: encodedResult.JSON, Truncated: encodedResult.Truncated, OriginalBytes: encodedResult.OriginalBytes},
			ToolMessage: toolMessage,
		})
		if finishErr != nil {
			return result, finishErr
		}
		if finished.Event.Sequence > 0 {
			h.publish(finished.Event)
		}
		if finished.AlreadyFinished {
			// The durable message was appended by the earlier completion. The
			// caller's in-memory projection already contains it (or will reload it
			// from the ledger after a process boundary), so suppress the fallback
			// append that would otherwise duplicate the tool message.
			result.MessagePersisted = true
		} else if finished.Message.ID != "" {
			result.Message = &finished.Message
		}
	}
	if execErr != nil {
		return result, execErr
	}
	return result, nil
}

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

func toolIntentFromRecord(record ToolCallRecord) ToolIntent {
	return ToolIntent{CallID: record.CallID, ToolName: record.ToolName,
		Arguments: append(json.RawMessage(nil), record.Arguments...), Effect: record.Effect,
		ArgsHash: record.ArgsHash}
}

// resumeToolCounters reconstructs the budget counters that are intentionally
// not reset when a process resumes an existing run. Event history is the source
// of truth, so a crash between turns cannot grant extra tool rounds.
func (h *AgentRunHarness) resumeToolCounters(ctx context.Context, runID string) (int, int) {
	if h == nil || h.ledger == nil {
		return 0, 0
	}
	events, err := h.ledger.ListEvents(ctx, runID, 0, 100000)
	if err != nil {
		return 0, 0
	}
	type round struct{ failed bool }
	rounds := make([]round, 0)
	for _, event := range events {
		switch event.Kind {
		case EventModelCompleted:
			var completed ModelCompletedEvent
			if json.Unmarshal(event.Payload, &completed) == nil && len(completed.ToolCalls) > 0 {
				rounds = append(rounds, round{})
			}
		case EventTool:
			if len(rounds) == 0 {
				continue
			}
			var tool ToolEvent
			// A durable started boundary proves that the executor may have begun,
			// but it is not an outcome. Counting it as a failed round would make a
			// resumed run exhaust its failure budget before the tool can settle.
			if json.Unmarshal(event.Payload, &tool) == nil && tool.Status != "started" && tool.Status != "completed" {
				rounds[len(rounds)-1].failed = true
			}
		}
	}
	failed := 0
	for index := len(rounds) - 1; index >= 0 && rounds[index].failed; index-- {
		failed++
	}
	return len(rounds), failed
}

func marshalToolResult(result ToolExecutionResult, err error) string {
	return string(encodeToolResult(result, err, 0).JSON)
}

func effectiveToolResultBytes(policy RunPolicy, descriptor ToolDescriptor) int64 {
	policyLimit := policy.MaxToolResultBytes
	descriptorLimit := descriptor.MaxResultBytes
	if policyLimit <= 0 {
		return descriptorLimit
	}
	if descriptorLimit <= 0 || policyLimit < descriptorLimit {
		return policyLimit
	}
	return descriptorLimit
}

func cloneMessages(messages []Message) []Message {
	if len(messages) == 0 {
		return nil
	}
	result := make([]Message, len(messages))
	copy(result, messages)
	for i := range result {
		result[i].ToolCalls = append(json.RawMessage(nil), result[i].ToolCalls...)
	}
	return result
}

func jsonEqualRaw(left, right json.RawMessage) bool {
	if len(left) == 0 {
		left = json.RawMessage(`{}`)
	}
	if len(right) == 0 {
		right = json.RawMessage(`{}`)
	}
	if !json.Valid(left) || !json.Valid(right) {
		return false
	}
	return ArgsHash(left) == ArgsHash(right)
}

func hasCommittedTool(messages []Message, runIDs ...string) bool {
	runID := ""
	if len(runIDs) > 0 {
		runID = strings.TrimSpace(runIDs[0])
	}
	for _, message := range messages {
		// Session history may contain tool messages from older/completed runs.
		// Restrict the guard to the current run when the caller supplies its ID;
		// retaining the no-argument behavior keeps this helper useful for legacy
		// callers and tests.
		if runID != "" && message.RunID != runID {
			continue
		}
		if message.Role == "tool" {
			return true
		}
		if message.Role != "assistant" {
			continue
		}
		// The assistant tool intent is committed atomically with the model turn,
		// before any executor runs. It is therefore enough to block a blind
		// provider retry even when no tool result message exists yet.
		trimmed := strings.TrimSpace(string(message.ToolCalls))
		if trimmed != "" && trimmed != "null" && trimmed != "[]" {
			return true
		}
	}
	return false
}

func descriptorEffect(descriptors []ToolDescriptor, name string) ToolEffect {
	for _, descriptor := range descriptors {
		if descriptor.Name == name {
			return descriptor.Effect
		}
	}
	return ToolEffectSideEffectUnknown
}

func normalizeToolIntentEffects(intents []ToolIntent, descriptors []ToolDescriptor) {
	for index := range intents {
		if strings.TrimSpace(string(intents[index].Effect)) != "" {
			continue
		}
		intents[index].Effect = descriptorEffect(descriptors, intents[index].ToolName)
	}
}

func validateToolIntents(intents []ToolIntent, descriptors []ToolDescriptor) error {
	seen := make(map[string]struct{}, len(intents))
	for _, intent := range intents {
		callID := strings.TrimSpace(intent.CallID)
		name := strings.TrimSpace(intent.ToolName)
		if callID == "" || name == "" {
			return fmt.Errorf("%w: callId and toolName are required", ErrMalformedToolCall)
		}
		// Providers are allowed to omit effect (the immutable Go catalog fills it
		// in below), but an explicit value must still be a known enum.  Silently
		// accepting an unknown value would let malformed model output cross the
		// approval/start boundary and would make the durable tool contract
		// ambiguous on replay.
		if strings.TrimSpace(string(intent.Effect)) != "" && !intent.Effect.Valid() {
			return fmt.Errorf("%w: invalid effect %q for %s", ErrMalformedToolCall, intent.Effect, name)
		}
		if _, exists := seen[callID]; exists {
			return fmt.Errorf("%w: duplicate callId %q", ErrMalformedToolCall, callID)
		}
		seen[callID] = struct{}{}
		if !json.Valid(intent.Arguments) {
			return fmt.Errorf("%w: arguments for %s are not valid JSON", ErrMalformedToolCall, name)
		}
		found := false
		for _, descriptor := range descriptors {
			if descriptor.Name == name {
				found = true
				if err := validateToolArguments(descriptor.InputSchema, intent.Arguments); err != nil {
					return fmt.Errorf("%w: %s", ErrMalformedToolCall, err)
				}
				break
			}
		}
		if !found {
			return fmt.Errorf("%w: unknown tool %q", ErrMalformedToolCall, name)
		}
	}
	return nil
}

func validateRunToolIntents(intents []ToolIntent, descriptors []ToolDescriptor, allowTools bool) error {
	if !allowTools && len(intents) > 0 {
		return fmt.Errorf("%w: %w", ErrMalformedToolCall, ErrToolCallsDisabled)
	}
	return validateToolIntents(intents, descriptors)
}

// validateToolArguments covers the JSON-schema subset needed by built-in and
// MCP tools. Unknown schema keywords are intentionally ignored; malformed
// JSON and required/type violations are always rejected before execution.
func validateToolArguments(schema, arguments json.RawMessage) error {
	if len(arguments) == 0 {
		arguments = json.RawMessage(`{}`)
	}
	if !json.Valid(arguments) {
		return ErrToolSchema
	}
	if len(schema) == 0 || !json.Valid(schema) {
		return nil
	}
	var schemaValue struct {
		Type                 string   `json:"type"`
		Required             []string `json:"required"`
		AdditionalProperties *bool    `json:"additionalProperties"`
		Properties           map[string]struct {
			Type string `json:"type"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(schema, &schemaValue); err != nil {
		return err
	}
	var value map[string]any
	if err := json.Unmarshal(arguments, &value); err != nil {
		return ErrToolSchema
	}
	if schemaValue.Type == "object" && value == nil {
		return ErrToolSchema
	}
	if schemaValue.Type == "object" && schemaValue.AdditionalProperties != nil && !*schemaValue.AdditionalProperties {
		for name := range value {
			if _, known := schemaValue.Properties[name]; !known {
				return fmt.Errorf("unknown argument %q", name)
			}
		}
	}
	for _, required := range schemaValue.Required {
		if _, ok := value[required]; !ok {
			return fmt.Errorf("missing required argument %q", required)
		}
	}
	for name, property := range schemaValue.Properties {
		item, exists := value[name]
		if !exists || property.Type == "" {
			continue
		}
		if !jsonTypeMatches(item, property.Type) {
			return fmt.Errorf("argument %q must be %s", name, property.Type)
		}
	}
	return nil
}

func jsonTypeMatches(value any, expected string) bool {
	switch expected {
	case "string":
		_, ok := value.(string)
		return ok
	case "number":
		_, ok := value.(float64)
		return ok
	case "integer":
		number, ok := value.(float64)
		return ok && math.Trunc(number) == number
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "array":
		_, ok := value.([]any)
		return ok
	case "object":
		_, ok := value.(map[string]any)
		return ok
	case "null":
		return value == nil
	default:
		return true
	}
}

// ArgsHash is exported for adapters that need to display/compare approval
// bindings without persisting the raw tool arguments themselves.
func ArgsHash(arguments json.RawMessage) string {
	sum := sha256.Sum256(arguments)
	return hex.EncodeToString(sum[:])
}

var _ Harness = (*AgentRunHarness)(nil)
