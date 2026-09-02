package runharness

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

// Workspace snapshot sources are expected to renew their lease frequently
// enough that a short disconnect is distinguishable from an active source.
// Keep these values in one place so adapters and the Ledger do not drift into
// subtly different liveness windows.
const (
	DefaultWorkspaceSnapshotLeaseDuration = 15 * time.Second
	DefaultWorkspaceSnapshotRenewInterval = 5 * time.Second
)

// Harness is the only interface adapters should use to control an agent run.
// Implementations own persistence, scheduling, cancellation and event order.
type Harness interface {
	SubmitInput(context.Context, AgentInputRequest) (AgentInputReceipt, error)
	ControlRun(context.Context, RunControlRequest) (RunSnapshot, error)
	ReadRun(context.Context, RunReadRequest) (RunReadResult, error)
	ListSessions(context.Context, SessionListRequest) (SessionListResult, error)
	ReadSession(context.Context, SessionReadRequest) (SessionProjection, error)
	MutateSession(context.Context, SessionMutationRequest) (SessionProjection, error)
	PutWorkspaceSnapshot(context.Context, WorkspaceSnapshot) (SnapshotAck, error)
}

// WorkspaceSnapshotLeaseConfig describes the source heartbeat contract. The
// renewal interval is advisory for adapters; the lease duration is enforced
// by the Ledger when snapshots are accepted.
type WorkspaceSnapshotLeaseConfig struct {
	LeaseDuration time.Duration `json:"leaseDuration"`
	RenewInterval time.Duration `json:"renewInterval"`
}

func DefaultWorkspaceSnapshotLeaseConfig() WorkspaceSnapshotLeaseConfig {
	return WorkspaceSnapshotLeaseConfig{
		LeaseDuration: DefaultWorkspaceSnapshotLeaseDuration,
		RenewInterval: DefaultWorkspaceSnapshotRenewInterval,
	}
}

func (c WorkspaceSnapshotLeaseConfig) Normalize() WorkspaceSnapshotLeaseConfig {
	if c.LeaseDuration == 0 {
		c.LeaseDuration = DefaultWorkspaceSnapshotLeaseDuration
	}
	if c.RenewInterval == 0 {
		c.RenewInterval = DefaultWorkspaceSnapshotRenewInterval
	}
	return c
}

func (c WorkspaceSnapshotLeaseConfig) Validate() error {
	if c.LeaseDuration < 0 || c.RenewInterval < 0 {
		return ErrSnapshotLeaseConfig
	}
	c = c.Normalize()
	if c.LeaseDuration <= 0 || c.RenewInterval <= 0 {
		return ErrSnapshotLeaseConfig
	}
	if c.RenewInterval >= c.LeaseDuration {
		return errors.New("workspace snapshot renew interval must be shorter than lease duration")
	}
	return nil
}

// ModelTurnAdapter isolates provider-specific streaming protocols from the run
// state machine. The adapter never emits terminal run state.
type ModelTurnAdapter interface {
	Execute(context.Context, ModelTurnRequest, ModelDeltaSink) (ModelTurnResult, error)
}

// AgentInputBinder resolves host-owned, mutable input settings into the
// immutable execution contract persisted for a newly accepted run.
// SubmitInput calls it only after the request-id idempotency lookup misses.
type AgentInputBinder func(context.Context, *AgentInputRequest) error

// ModelDeltaSink receives provider deltas.  It is a function type rather than
// an interface so adapters can pass a plain callback without a wrapper; the
// method keeps it usable anywhere an interface-style sink is expected.
type ModelDeltaSink func(context.Context, ModelDelta) error

func (f ModelDeltaSink) Delta(ctx context.Context, delta ModelDelta) error {
	if f == nil {
		return nil
	}
	return f(ctx, delta)
}

type ModelDelta struct {
	Text      string
	Reasoning string
	ToolCalls []ToolIntent
}

type ModelTurnResult struct {
	Text          string
	Reasoning     string
	ToolCalls     []ToolIntent
	Usage         Usage
	ProviderState json.RawMessage
	Completed     bool
}

// ToolCatalog is the single source of tool definitions and execution rules.
type ToolCatalog interface {
	List(context.Context) ([]ToolDescriptor, error)
	Resolve(context.Context, string) (ToolDescriptor, ToolExecutor, error)
}

// ToolEffectResolver is an optional refinement seam for tools whose effect is
// determined by validated arguments (for example execute_sql SELECT versus
// INSERT). Catalogs that do not implement it retain their descriptor effect.
type ToolEffectResolver interface {
	ResolveEffect(context.Context, string, json.RawMessage) (ToolEffect, error)
}

type ToolExecutor interface {
	Execute(context.Context, ToolExecutionRequest) (ToolExecutionResult, error)
}

type ToolExecutionRequest struct {
	RunID  string
	CallID string
	// Attempt identifies the durable invocation of a tool call. A recovered
	// read-only/idempotent call keeps the original attempt so its executor can
	// reuse the same idempotency key; an explicit recovery retry receives a new
	// attempt. Leaving this zero preserves compatibility for low-level callers
	// that do not participate in the ledger.
	Attempt     int
	ToolName    string
	Effect      ToolEffect
	Arguments   json.RawMessage
	Context     WorkspaceSnapshot
	Idempotency string
}

type ToolExecutionResult struct {
	Status string
	Value  any
	// ResultJSON is the single canonical JSON representation produced by the
	// harness for the tool outcome.  Executors normally leave it empty; the
	// runner fills it before the result crosses the durable Ledger boundary.
	// Keeping the encoded form alongside Value prevents messages, events and
	// tool records from independently marshaling a large or lossy value.
	ResultJSON     json.RawMessage `json:"resultJson,omitempty"`
	ErrorCode      string
	UnknownOutcome bool
	Truncated      bool
	OriginalBytes  int64
	// Message is populated by the harness after a completed tool call has been
	// durably appended together with its tool record/event/checkpoint. Executors
	// should leave it nil; it is carried back only to build the next model
	// projection without issuing a second message write.
	Message *Message
	// MessagePersisted is true when an idempotent completion found a durable
	// tool message already written by an earlier attempt. Callers must not use
	// their fallback path to append another message in that case.
	MessagePersisted bool
}

// ApprovalHandler is called for each side-effecting tool call. Returning
// ErrApprovalPending leaves the run durably awaiting approval.
type ApprovalHandler interface {
	Request(context.Context, ApprovalRequest) (ApprovalDecision, error)
}

var ErrApprovalPending = errors.New("agent approval pending")

type ApprovalRequest struct {
	ApprovalID  string
	RunID       string
	CallID      string
	ToolName    string
	Effect      ToolEffect
	Arguments   json.RawMessage `json:"-"`
	ArgsHash    string
	RunRevision int64
}

type ApprovalDecision struct {
	ApprovalID string
	Decision   string
}

// EventSink receives events only after they have been persisted in the ledger.
type EventSink func(RunEvent)

type SnapshotAck struct {
	SourceID         string `json:"sourceId"`
	SourceInstanceID string `json:"sourceInstanceId"`
	Revision         int64  `json:"revision"`
	ContentHash      string `json:"contentHash"`
	Accepted         bool   `json:"accepted"`
}

type HarnessOption func(*HarnessConfig)

type HarnessConfig struct {
	Ledger *Ledger
	Model  ModelTurnAdapter
	// InputBinder resolves mutable host settings, such as the selected provider,
	// before a new run is persisted. It is deliberately skipped for an existing
	// request ID so accepted requests remain retryable during host reconfiguration.
	InputBinder AgentInputBinder
	// ContextBuilder owns the provider-facing projection of the durable
	// transcript. The harness keeps the full transcript in the Ledger and only
	// passes the builder's projection to a provider.
	ContextBuilder ContextBuilder
	Tools          ToolCatalog
	Approvals      ApprovalHandler
	Events         EventSink
	RootContext    context.Context
	OwnerID        string
	LeaseDuration  time.Duration
	PollInterval   time.Duration
	// Runtime contains the live coordination settings. The legacy individual
	// fields below remain accepted for source compatibility with low-level
	// adapters; when Runtime is provided it takes precedence.
	Runtime RunRuntimeConfig
	// WorkspaceSnapshotLeaseDuration controls how long a complete snapshot is
	// considered live after its last publication. Zero uses the shared
	// 15-second default. It is independent from the run-owner lease above.
	WorkspaceSnapshotLeaseDuration time.Duration
	// WorkspaceSnapshotRenewInterval documents the source heartbeat cadence for
	// adapters. The Harness does not synthesize snapshots; desktop/CLI adapters
	// publish a full snapshot on this cadence. Zero uses the shared 5-second
	// default.
	WorkspaceSnapshotRenewInterval time.Duration
	// ShutdownGracePeriod is the maximum time Close waits for an already
	// issued side-effect tool to settle before canceling its context and
	// recording an unknown outcome. Zero uses the harness default.
	ShutdownGracePeriod time.Duration
}

func WithModelAdapter(adapter ModelTurnAdapter) HarnessOption {
	return func(c *HarnessConfig) { c.Model = adapter }
}
func WithInputBinder(binder AgentInputBinder) HarnessOption {
	return func(c *HarnessConfig) { c.InputBinder = binder }
}
func WithContextBuilder(builder ContextBuilder) HarnessOption {
	return func(c *HarnessConfig) { c.ContextBuilder = builder }
}
func WithToolCatalog(catalog ToolCatalog) HarnessOption {
	return func(c *HarnessConfig) { c.Tools = catalog }
}
func WithApprovalHandler(handler ApprovalHandler) HarnessOption {
	return func(c *HarnessConfig) { c.Approvals = handler }
}
func WithEventSink(sink EventSink) HarnessOption { return func(c *HarnessConfig) { c.Events = sink } }
func WithRootContext(ctx context.Context) HarnessOption {
	return func(c *HarnessConfig) { c.RootContext = ctx }
}

func WithRuntimeConfig(config RunRuntimeConfig) HarnessOption {
	return func(c *HarnessConfig) { c.Runtime = config }
}
