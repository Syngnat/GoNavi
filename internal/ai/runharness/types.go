// Package runharness contains the durable, provider-independent primitives used
// by the GoNavi agent runner.  The package deliberately has no dependency on
// Wails or on a particular model provider so that the desktop and CLI adapters
// can share the same run ledger.
package runharness

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	// CurrentSchemaVersion is the wire/schema version emitted by this package.
	CurrentSchemaVersion = 1
	// EventName is the single event name adapters should subscribe to.
	EventName = "ai:run:event"
)

// RunState is the durable state of an agent run.
type RunState string

const (
	RunStateQueued            RunState = "queued"
	RunStateRunningModel      RunState = "running_model"
	RunStateAwaitingApproval  RunState = "awaiting_approval"
	RunStateRunningTool       RunState = "running_tool"
	RunStateAwaitingWorkspace RunState = "awaiting_workspace"
	RunStateInterrupted       RunState = "interrupted"
	RunStateRecoveryRequired  RunState = "recovery_required"
	RunStateCanceling         RunState = "canceling"
	RunStateCompleted         RunState = "completed"
	RunStateFailed            RunState = "failed"
	RunStateCanceled          RunState = "canceled"
	RunStateExhausted         RunState = "exhausted"
)

// Terminal reports whether no more events or transitions are accepted.
func (s RunState) Terminal() bool {
	switch s {
	case RunStateCompleted, RunStateFailed, RunStateCanceled, RunStateExhausted:
		return true
	default:
		return false
	}
}

// Valid reports whether s is one of the known states.
func (s RunState) Valid() bool {
	switch s {
	case RunStateQueued, RunStateRunningModel, RunStateAwaitingApproval,
		RunStateRunningTool, RunStateAwaitingWorkspace, RunStateInterrupted,
		RunStateRecoveryRequired, RunStateCanceling, RunStateCompleted,
		RunStateFailed, RunStateCanceled, RunStateExhausted:
		return true
	default:
		return false
	}
}

var ErrInvalidTransition = errors.New("invalid agent run state transition")

// CanTransition defines the state machine.  A transition to the same state is
// intentionally rejected; callers should use a revision update for metadata.
func CanTransition(from, to RunState) bool {
	if !from.Valid() || !to.Valid() || from == to || from.Terminal() {
		return false
	}
	switch from {
	case RunStateQueued:
		return to == RunStateRunningModel || to == RunStateCanceling ||
			to == RunStateInterrupted || to == RunStateRecoveryRequired
	case RunStateRunningModel:
		return to == RunStateAwaitingApproval || to == RunStateRunningTool || to == RunStateAwaitingWorkspace ||
			to == RunStateCompleted || to == RunStateFailed || to == RunStateExhausted ||
			to == RunStateCanceling || to == RunStateInterrupted || to == RunStateRecoveryRequired
	case RunStateAwaitingApproval:
		return to == RunStateRunningTool || to == RunStateRunningModel ||
			to == RunStateCanceling || to == RunStateInterrupted || to == RunStateRecoveryRequired
	case RunStateRunningTool:
		return to == RunStateRunningModel || to == RunStateAwaitingWorkspace ||
			to == RunStateCompleted || to == RunStateFailed || to == RunStateExhausted ||
			to == RunStateCanceling || to == RunStateInterrupted || to == RunStateRecoveryRequired
	case RunStateAwaitingWorkspace:
		return to == RunStateRunningModel || to == RunStateRunningTool || to == RunStateCanceling ||
			to == RunStateInterrupted || to == RunStateRecoveryRequired
	case RunStateInterrupted:
		return to == RunStateRunningModel || to == RunStateRunningTool ||
			to == RunStateAwaitingApproval || to == RunStateAwaitingWorkspace ||
			to == RunStateCompleted || to == RunStateFailed ||
			to == RunStateRecoveryRequired || to == RunStateCanceling
	case RunStateRecoveryRequired:
		return to == RunStateRunningModel || to == RunStateRunningTool ||
			to == RunStateAwaitingApproval || to == RunStateAwaitingWorkspace ||
			to == RunStateCompleted || to == RunStateFailed || to == RunStateCanceling
	case RunStateCanceling:
		return to == RunStateCanceled || to == RunStateFailed ||
			to == RunStateInterrupted || to == RunStateRecoveryRequired
	default:
		return false
	}
}

// ValidateTransition returns ErrInvalidTransition for an illegal edge.
func ValidateTransition(from, to RunState) error {
	if !CanTransition(from, to) {
		return fmt.Errorf("%w: %s -> %s", ErrInvalidTransition, from, to)
	}
	return nil
}

// DispatchMode controls how input is delivered to a currently active run.
type DispatchMode string

const (
	DispatchQueue DispatchMode = "queue"
	DispatchSteer DispatchMode = "steer"
)

func (m DispatchMode) Valid() bool { return m == DispatchQueue || m == DispatchSteer }

// AgentTaskKind identifies the product surface that created a run. It is
// durable so recovery and cross-process controls retain the same capability
// boundary as the original submission.
type AgentTaskKind string

const (
	AgentTaskKindChat                  AgentTaskKind = "chat"
	AgentTaskKindQueryEditorGeneration AgentTaskKind = "query_editor_generation"
)

func (k AgentTaskKind) Normalize() AgentTaskKind {
	if strings.TrimSpace(string(k)) == "" {
		return AgentTaskKindChat
	}
	return k
}

func (k AgentTaskKind) Valid() bool {
	switch k.Normalize() {
	case AgentTaskKindChat, AgentTaskKindQueryEditorGeneration:
		return true
	default:
		return false
	}
}

// ToolEffect describes the side-effect contract of a tool.
type ToolEffect string

const (
	ToolEffectPure              ToolEffect = "pure"
	ToolEffectReadOnly          ToolEffect = "read_only"
	ToolEffectIdempotent        ToolEffect = "idempotent"
	ToolEffectSideEffect        ToolEffect = "side_effect"
	ToolEffectSideEffectUnknown ToolEffect = "side_effect_unknown"
)

func (e ToolEffect) Valid() bool {
	switch e {
	case ToolEffectPure, ToolEffectReadOnly, ToolEffectIdempotent,
		ToolEffectSideEffect, ToolEffectSideEffectUnknown:
		return true
	default:
		return false
	}
}

// EventKind identifies the typed payload carried by RunEvent.
type EventKind string

const (
	EventInput          EventKind = "input"
	EventModelDelta     EventKind = "model_delta"
	EventModelCompleted EventKind = "model_completed"
	EventTool           EventKind = "tool"
	EventApproval       EventKind = "approval"
	EventUsage          EventKind = "usage"
	EventCheckpoint     EventKind = "checkpoint"
	EventRunError       EventKind = "run_error"
	EventTerminal       EventKind = "terminal"
)

// AgentInputRequest is the durable input submission envelope.
type AgentInputRequest struct {
	RequestID string `json:"requestId"`
	SessionID string `json:"sessionId,omitempty"`
	// BranchFromMessageID creates a new conversation branch from a durable
	// user-message cursor in SessionID. The original session is never edited or
	// truncated; messages before the cursor are copied into the new branch and
	// this input becomes its next user message.
	BranchFromMessageID     string        `json:"branchFromMessageId,omitempty"`
	Content                 string        `json:"content"`
	Attachments             []Attachment  `json:"attachments,omitempty"`
	DispatchMode            DispatchMode  `json:"dispatchMode,omitempty"`
	ContextSourceID         string        `json:"contextSourceId,omitempty"`
	ContextSourceInstanceID string        `json:"contextSourceInstanceId,omitempty"`
	Provider                string        `json:"provider,omitempty"`
	Model                   string        `json:"model,omitempty"`
	Thinking                string        `json:"thinking,omitempty"`
	Temperature             *float64      `json:"temperature,omitempty"`
	MaxTokens               *int          `json:"maxTokens,omitempty"`
	TaskKind                AgentTaskKind `json:"taskKind,omitempty"`
	// AllowTools is a hard run capability boundary. Nil preserves the default
	// (tools enabled); false is persisted and enforced by the harness.
	AllowTools       *bool `json:"allowTools,omitempty"`
	ExpectedRevision int64 `json:"expectedRevision,omitempty"`

	// providerBinding is intentionally unexported. Wails discovers exported Go
	// fields even when they have json:"-", so an exported secret-bearing field
	// would still create a browser-visible DTO. Host adapters attach this only
	// after resolving local provider settings; the Ledger encrypts it at rest.
	providerBinding *ProviderBinding
}

func (r AgentInputRequest) Validate() error {
	if strings.TrimSpace(r.RequestID) == "" {
		return errors.New("requestId is required")
	}
	if strings.TrimSpace(r.Content) == "" && len(r.Attachments) == 0 {
		return errors.New("content or attachment is required")
	}
	if r.DispatchMode != "" && !r.DispatchMode.Valid() {
		return fmt.Errorf("invalid dispatchMode %q", r.DispatchMode)
	}
	if !r.TaskKind.Valid() {
		return fmt.Errorf("invalid taskKind %q", r.TaskKind)
	}
	if strings.TrimSpace(r.BranchFromMessageID) != "" && strings.TrimSpace(r.SessionID) == "" {
		return errors.New("sessionId is required when branching from a message")
	}
	return nil
}

// SetProviderBinding freezes a host-resolved provider configuration on an
// input before the Harness persists a run. It is deliberately a method rather
// than an exported DTO field so browser-originated Wails payloads cannot set or
// discover provider credentials and custom headers.
func (r *AgentInputRequest) SetProviderBinding(binding ProviderBinding) error {
	if r == nil {
		return errors.New("agent input is required")
	}
	validated, err := binding.Validate()
	if err != nil {
		return fmt.Errorf("validate provider binding: %w", err)
	}
	r.Provider = validated.ProviderID
	r.providerBinding = cloneProviderBinding(&validated)
	return nil
}

// HasProviderBinding reports whether a host adapter has supplied the
// immutable provider contract. It intentionally does not expose its secret
// payload to Wails or other serialized callers.
func (r AgentInputRequest) HasProviderBinding() bool {
	return r.providerBinding != nil
}

// ProviderBindingForHost returns a detached binding for desktop/CLI host
// adapters that need to construct a model turn in tests or host-only code.
// It is not a field of the Wails DTO and cannot be populated by browser input.
func (r AgentInputRequest) ProviderBindingForHost() (ProviderBinding, bool) {
	binding := cloneProviderBinding(r.providerBinding)
	if binding == nil {
		return ProviderBinding{}, false
	}
	return *binding, true
}

func (r AgentInputRequest) providerBindingCopy() *ProviderBinding {
	return cloneProviderBinding(r.providerBinding)
}

type Attachment struct {
	Name      string `json:"name,omitempty"`
	MediaType string `json:"mediaType,omitempty"`
	Data      string `json:"data,omitempty"`
}

// AgentInputReceipt is returned after an input is durably accepted.
type AgentInputReceipt struct {
	RequestID   string   `json:"requestId"`
	SessionID   string   `json:"sessionId"`
	RunID       string   `json:"runId"`
	Disposition string   `json:"disposition"` // started | queued | steered
	Revision    int64    `json:"revision"`
	State       RunState `json:"state"`
}

type RunControlAction string

const (
	ControlCancel        RunControlAction = "cancel"
	ControlSteer         RunControlAction = "steer"
	ControlApprove       RunControlAction = "approve"
	ControlDeny          RunControlAction = "deny"
	ControlResume        RunControlAction = "resume"
	ControlRecover       RunControlAction = "recover"
	ControlMarkCompleted RunControlAction = "mark_completed"
	ControlAbortRecovery RunControlAction = "abort_recovery"
	// ControlUseStaleWorkspace explicitly allows a run waiting for a lost
	// workspace source to continue with its encrypted last snapshot.
	ControlUseStaleWorkspace RunControlAction = "use_stale_workspace"
)

type RunControlRequest struct {
	RequestID        string           `json:"requestId"`
	RunID            string           `json:"runId"`
	SessionID        string           `json:"sessionId,omitempty"`
	Action           RunControlAction `json:"action"`
	CallID           string           `json:"callId,omitempty"`
	ApprovalID       string           `json:"approvalId,omitempty"`
	ArgsHash         string           `json:"argsHash,omitempty"`
	Content          string           `json:"content,omitempty"`
	ExpectedRevision int64            `json:"expectedRevision,omitempty"`
}

type RunReadRequest struct {
	RunID         string `json:"runId"`
	AfterSequence int64  `json:"afterSequence,omitempty"`
	Limit         int    `json:"limit,omitempty"`
}

type SessionListRequest struct {
	Limit      int  `json:"limit,omitempty"`
	Offset     int  `json:"offset,omitempty"`
	ActiveOnly bool `json:"activeOnly,omitempty"`
}

type SessionReadRequest struct {
	SessionID     string `json:"sessionId"`
	AfterSequence int64  `json:"afterSequence,omitempty"`
	Limit         int    `json:"limit,omitempty"`
}

type SessionMutationRequest struct {
	SessionID        string  `json:"sessionId"`
	ExpectedRevision int64   `json:"expectedRevision,omitempty"`
	Title            *string `json:"title,omitempty"`
	Archived         *bool   `json:"archived,omitempty"`
}

// RunSnapshot is the non-sensitive run projection returned to adapters.
type RunSnapshot struct {
	ID                string   `json:"runId"`
	SessionID         string   `json:"sessionId"`
	RequestID         string   `json:"requestId,omitempty"`
	SessionGeneration int64    `json:"sessionGeneration"`
	State             RunState `json:"state"`
	Revision          int64    `json:"revision"`
	Attempt           int      `json:"attempt"`
	NextSequence      int64    `json:"nextSequence"`
	// ownerToken is the local fencing token held by an active supervisor. It
	// must never be returned through a Wails or CLI projection.
	ownerToken              string        `json:"-"`
	OwnerExpiresAt          time.Time     `json:"ownerExpiresAt,omitempty"`
	CheckpointID            string        `json:"checkpointId,omitempty"`
	TerminalReason          string        `json:"terminalReason,omitempty"`
	CreatedAt               time.Time     `json:"createdAt"`
	UpdatedAt               time.Time     `json:"updatedAt"`
	ActiveDurationMS        int64         `json:"activeDurationMs"`
	Policy                  RunPolicy     `json:"policy"`
	Provider                string        `json:"provider,omitempty"`
	Model                   string        `json:"model,omitempty"`
	Thinking                string        `json:"thinking,omitempty"`
	Temperature             *float64      `json:"temperature,omitempty"`
	MaxTokens               *int          `json:"maxTokens,omitempty"`
	TaskKind                AgentTaskKind `json:"taskKind"`
	AllowTools              bool          `json:"allowTools"`
	ContextSourceID         string        `json:"contextSourceId,omitempty"`
	ContextSourceInstanceID string        `json:"contextSourceInstanceId,omitempty"`
	// ToolCatalogHash and ToolCatalogRevision identify the immutable tool
	// contract captured when this run was accepted.  The descriptor payload is
	// encrypted in the Ledger and is intentionally never exposed in snapshots.
	ToolCatalogHash     string `json:"toolCatalogHash,omitempty"`
	ToolCatalogRevision int64  `json:"toolCatalogRevision,omitempty"`
	// Token counters are durable run metadata. ReservedTokens is the amount
	// currently held by in-flight model turns; the other counters are
	// reconciled usage and survive process recovery.
	PromptTokens     int `json:"promptTokens"`
	CompletionTokens int `json:"completionTokens"`
	TotalTokens      int `json:"totalTokens"`
	ReservedTokens   int `json:"reservedTokens"`
}

type RunReadResult struct {
	Run          RunSnapshot `json:"run"`
	Events       []RunEvent  `json:"events"`
	NextSequence int64       `json:"nextSequence"`
	HasMore      bool        `json:"hasMore"`
}

type SessionProjection struct {
	ID                  string        `json:"sessionId"`
	Title               string        `json:"title,omitempty"`
	Revision            int64         `json:"revision"`
	Generation          int64         `json:"generation"`
	ParentSessionID     string        `json:"parentSessionId,omitempty"`
	BranchFromMessageID string        `json:"branchFromMessageId,omitempty"`
	BranchFromSequence  int64         `json:"branchFromSequence,omitempty"`
	Archived            bool          `json:"archived"`
	CreatedAt           time.Time     `json:"createdAt"`
	UpdatedAt           time.Time     `json:"updatedAt"`
	Runs                []RunSnapshot `json:"runs,omitempty"`
	Messages            []Message     `json:"messages,omitempty"`
}

type SessionListResult struct {
	Sessions []SessionProjection `json:"sessions"`
	Total    int                 `json:"total"`
}

// Message is the encrypted conversation ledger entry. Content and metadata
// are encrypted at rest; role and sequence remain indexable.
type Message struct {
	ID          string          `json:"id"`
	SessionID   string          `json:"sessionId"`
	RunID       string          `json:"runId,omitempty"`
	Sequence    int64           `json:"sequence"`
	Role        string          `json:"role"`
	Content     string          `json:"content"`
	Images      []string        `json:"images,omitempty"`
	Attachments []Attachment    `json:"attachments,omitempty"`
	Reasoning   string          `json:"reasoning,omitempty"`
	ToolCallID  string          `json:"toolCallId,omitempty"`
	ToolCalls   json.RawMessage `json:"toolCalls,omitempty"`
	Metadata    json.RawMessage `json:"metadata,omitempty"`
	CreatedAt   time.Time       `json:"createdAt"`
}

// RunEvent is persisted before it is emitted. Payload is JSON for transport,
// but each Kind has a corresponding typed payload below.
type RunEvent struct {
	SchemaVersion     int             `json:"schemaVersion"`
	RunID             string          `json:"runId"`
	SessionID         string          `json:"sessionId"`
	SessionGeneration int64           `json:"sessionGeneration"`
	Sequence          int64           `json:"sequence"`
	RunRevision       int64           `json:"runRevision"`
	Attempt           int             `json:"attempt"`
	Timestamp         time.Time       `json:"timestamp"`
	Kind              EventKind       `json:"kind"`
	ResultingState    RunState        `json:"resultingState"`
	Payload           json.RawMessage `json:"payload,omitempty"`
}

// NewRunEvent creates a typed event payload and validates the event kind.
func NewRunEvent(run RunSnapshot, kind EventKind, resultingState RunState, payload any, now time.Time) (RunEvent, error) {
	if !validEventKind(kind) {
		return RunEvent{}, fmt.Errorf("unknown event kind %q", kind)
	}
	if !resultingState.Valid() {
		return RunEvent{}, fmt.Errorf("unknown resulting state %q", resultingState)
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return RunEvent{}, fmt.Errorf("marshal event payload: %w", err)
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	return RunEvent{SchemaVersion: CurrentSchemaVersion, RunID: run.ID,
		SessionID: run.SessionID, SessionGeneration: run.SessionGeneration,
		RunRevision: run.Revision, Attempt: run.Attempt, Timestamp: now.UTC(),
		Kind: kind, ResultingState: resultingState, Payload: encoded}, nil
}

func validEventKind(k EventKind) bool {
	switch k {
	case EventInput, EventModelDelta, EventModelCompleted, EventTool,
		EventApproval, EventUsage, EventCheckpoint, EventRunError, EventTerminal:
		return true
	default:
		return false
	}
}

// DecodeEventPayload decodes the mutually-typed payload of an event. Keeping
// this helper next to RunEvent makes adapters validate the payload shape at
// the boundary instead of passing untyped maps through the UI/CLI layers.
func DecodeEventPayload[T any](event RunEvent) (T, error) {
	var payload T
	if !validEventKind(event.Kind) {
		return payload, fmt.Errorf("unknown event kind %q", event.Kind)
	}
	if len(event.Payload) == 0 {
		return payload, errors.New("event payload is empty")
	}
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		return payload, fmt.Errorf("decode %s event payload: %w", event.Kind, err)
	}
	return payload, nil
}

type InputEvent struct {
	RequestID    string       `json:"requestId"`
	ContentHash  string       `json:"contentHash,omitempty"`
	DispatchMode DispatchMode `json:"dispatchMode,omitempty"`
}

type ModelDeltaEvent struct {
	Text      string       `json:"text,omitempty"`
	Reasoning string       `json:"reasoning,omitempty"`
	CallID    string       `json:"callId,omitempty"`
	ToolCalls []ToolIntent `json:"toolCalls,omitempty"`
}

// WorkspaceSnapshotReference identifies the exact workspace view used by a
// tool or checkpoint.  Keeping the source identity, monotonic revision, and
// content hash together lets a replay/audit consumer prove which snapshot was
// in effect without exposing the encrypted snapshot payload itself.
type WorkspaceSnapshotReference struct {
	SourceID         string `json:"sourceId"`
	SourceInstanceID string `json:"sourceInstanceId"`
	Revision         int64  `json:"revision"`
	ContentHash      string `json:"contentHash"`
}

func (r WorkspaceSnapshotReference) valid() bool {
	return strings.TrimSpace(r.SourceID) != "" &&
		strings.TrimSpace(r.SourceInstanceID) != "" &&
		r.Revision > 0 && strings.TrimSpace(r.ContentHash) != ""
}

func cloneWorkspaceSnapshotReference(ref *WorkspaceSnapshotReference) *WorkspaceSnapshotReference {
	if ref == nil {
		return nil
	}
	copy := *ref
	return &copy
}

func workspaceSnapshotReference(snapshot WorkspaceSnapshot) *WorkspaceSnapshotReference {
	ref := &WorkspaceSnapshotReference{
		SourceID:         snapshot.SourceID,
		SourceInstanceID: snapshot.SourceInstanceID,
		Revision:         snapshot.Revision,
		ContentHash:      snapshot.ContentHash,
	}
	if !ref.valid() {
		return nil
	}
	return ref
}

func sameWorkspaceSnapshotReference(left, right *WorkspaceSnapshotReference) bool {
	if left == nil || right == nil {
		return left == right
	}
	return left.SourceID == right.SourceID &&
		left.SourceInstanceID == right.SourceInstanceID &&
		left.Revision == right.Revision &&
		left.ContentHash == right.ContentHash
}

type ModelCompletedEvent struct {
	Text              string                      `json:"text,omitempty"`
	Reasoning         string                      `json:"reasoning,omitempty"`
	ToolCalls         []ToolIntent                `json:"toolCalls,omitempty"`
	Usage             Usage                       `json:"usage,omitempty"`
	WorkspaceSnapshot *WorkspaceSnapshotReference `json:"workspaceSnapshot,omitempty"`
	// Compression describes the provider projection for this turn. It is
	// durable audit metadata; it never replaces or truncates Ledger messages.
	Compression ContextCompressionMetadata `json:"compression,omitempty"`
}

type ToolIntent struct {
	CallID    string          `json:"callId"`
	ToolName  string          `json:"toolName"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
	Effect    ToolEffect      `json:"effect"`
	ArgsHash  string          `json:"argsHash,omitempty"`
}

type ToolEvent struct {
	CallID   string     `json:"callId"`
	ToolName string     `json:"toolName"`
	Effect   ToolEffect `json:"effect"`
	Status   string     `json:"status"`
	ArgsHash string     `json:"argsHash,omitempty"`
	// Result is the exact normalized JSON sent to the model as the tool
	// message.  It is kept in the typed event so replay consumers do not have
	// to reconstruct it from a separately encoded value.
	Result        json.RawMessage `json:"result,omitempty"`
	ResultHash    string          `json:"resultHash,omitempty"`
	ErrorCode     string          `json:"errorCode,omitempty"`
	Truncated     bool            `json:"truncated,omitempty"`
	OriginalBytes int64           `json:"originalBytes,omitempty"`
	// WorkspaceSnapshot is omitted for tools that do not require workspace
	// context. When present it is the exact snapshot read immediately before
	// the tool was started.
	WorkspaceSnapshot *WorkspaceSnapshotReference `json:"workspaceSnapshot,omitempty"`
}

type ApprovalEvent struct {
	ApprovalID string     `json:"approvalId"`
	CallID     string     `json:"callId"`
	ToolName   string     `json:"toolName"`
	Effect     ToolEffect `json:"effect"`
	ArgsHash   string     `json:"argsHash"`
	Decision   string     `json:"decision"`
	// Summary is a server-generated, redacted display string. It must never
	// include raw tool arguments, SQL, or any other user-provided value.
	Summary string `json:"summary,omitempty"`
}

type Usage struct {
	PromptTokens     int `json:"promptTokens,omitempty"`
	CompletionTokens int `json:"completionTokens,omitempty"`
	TotalTokens      int `json:"totalTokens,omitempty"`
}

// TokenReservation is an encrypted-ledger-independent accounting record for
// one model turn. Token counts themselves are non-sensitive metadata; the
// reservation ID makes retries and crash recovery idempotent.
type TokenReservation struct {
	ID                string    `json:"reservationId"`
	RunID             string    `json:"runId"`
	RunRevision       int64     `json:"runRevision,omitempty"`
	ReservedTokens    int       `json:"reservedTokens"`
	PromptTokens      int       `json:"promptTokens,omitempty"`
	CompletionTokens  int       `json:"completionTokens,omitempty"`
	TotalTokens       int       `json:"totalTokens,omitempty"`
	Status            string    `json:"status"` // reserved | reconciled
	CommittedSequence int64     `json:"committedSequence,omitempty"`
	CommittedRevision int64     `json:"committedRevision,omitempty"`
	CreatedAt         time.Time `json:"createdAt"`
	ReconciledAt      time.Time `json:"reconciledAt,omitempty"`
}

type ReserveTokensRequest struct {
	RunID            string `json:"runId"`
	ReservationID    string `json:"reservationId,omitempty"`
	Tokens           int    `json:"tokens"`
	ExpectedRevision int64  `json:"expectedRevision,omitempty"`
	OwnerToken       string `json:"-"`
}

type ReconcileTokensRequest struct {
	RunID            string `json:"runId"`
	ReservationID    string `json:"reservationId"`
	Usage            Usage  `json:"usage"`
	ExpectedRevision int64  `json:"expectedRevision,omitempty"`
	OwnerToken       string `json:"-"`
}

type UsageEvent struct {
	Usage Usage `json:"usage"`
}

// CommitModelTurnRequest is the durable boundary for a completed provider
// turn. All supplied messages, model/usage/checkpoint events, provider state,
// token reconciliation and the run CAS are committed together.
type CommitModelTurnRequest struct {
	RunID              string              `json:"runId"`
	ExpectedRevision   int64               `json:"expectedRevision,omitempty"`
	OwnerToken         string              `json:"-"`
	AssistantMessage   *Message            `json:"assistantMessage,omitempty"`
	ModelCompleted     ModelCompletedEvent `json:"modelCompleted"`
	Usage              Usage               `json:"usage,omitempty"`
	ConversationCursor string              `json:"conversationCursor,omitempty"`
	ProviderState      json.RawMessage     `json:"providerState,omitempty"`
	ResultingState     RunState            `json:"resultingState,omitempty"`
	ReservationID      string              `json:"reservationId,omitempty"`
	// WorkspaceSnapshot carries forward the context used to build this model
	// turn when the adapter has one. If omitted, the previous checkpoint's
	// reference is inherited.
	WorkspaceSnapshot *WorkspaceSnapshotReference `json:"workspaceSnapshot,omitempty"`
}

// CommitModelTurnResult contains the committed projection and events. Events
// are returned in sequence order and must be published only after the Ledger
// method succeeds.
type CommitModelTurnResult struct {
	Run              RunSnapshot `json:"run"`
	Events           []RunEvent  `json:"events"`
	Checkpoint       Checkpoint  `json:"checkpoint"`
	Message          *Message    `json:"message,omitempty"`
	AlreadyCommitted bool        `json:"alreadyCommitted,omitempty"`
}

type CheckpointEvent struct {
	CheckpointID string `json:"checkpointId"`
	Sequence     int64  `json:"sequence"`
	// RecoveryAction records why a checkpoint was created while resolving an
	// interrupted or unknown-outcome run. It is optional so older events remain
	// decodable without a migration.
	RecoveryAction    RunControlAction            `json:"recoveryAction,omitempty"`
	WorkspaceSnapshot *WorkspaceSnapshotReference `json:"workspaceSnapshot,omitempty"`
}

type RunErrorEvent struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable,omitempty"`
}

type TerminalEvent struct {
	Reason    string `json:"reason"`
	ErrorCode string `json:"errorCode,omitempty"`
}

// HashJSON returns a stable SHA-256 hash for a JSON value. It is used for
// workspace revisions, tool argument binding, and approval invalidation.
func HashJSON(value any) (string, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

// WorkspaceSnapshot is a complete, source-owned view of UI/CLI context.
// Flexible maps preserve forward compatibility while the stable fields remain
// easy for adapters to populate.
type WorkspaceSourceKind string

const (
	WorkspaceDesktop WorkspaceSourceKind = "desktop"
	WorkspaceCLI     WorkspaceSourceKind = "cli"
)

type WorkspaceSnapshot struct {
	SchemaVersion          int                    `json:"schemaVersion"`
	SourceKind             WorkspaceSourceKind    `json:"sourceKind"`
	SourceID               string                 `json:"sourceId"`
	SourceInstanceID       string                 `json:"sourceInstanceId"`
	Revision               int64                  `json:"revision"`
	CapturedAt             time.Time              `json:"capturedAt"`
	ContentHash            string                 `json:"contentHash"`
	ActiveContext          map[string]any         `json:"activeContext,omitempty"`
	Tabs                   []WorkspaceTab         `json:"tabs,omitempty"`
	ActiveTabID            string                 `json:"activeTabId,omitempty"`
	SQLActivity            []WorkspaceSQLActivity `json:"sqlActivity,omitempty"`
	SavedQueries           []WorkspaceQuery       `json:"savedQueries,omitempty"`
	Snippets               []WorkspaceQuery       `json:"snippets,omitempty"`
	ExternalSQLDirectories []string               `json:"externalSqlDirectories,omitempty"`
	Shortcuts              map[string]string      `json:"shortcuts,omitempty"`
	TransactionState       map[string]any         `json:"transactionState,omitempty"`
	Diagnostics            map[string]any         `json:"diagnostics,omitempty"`
	CLIContext             *CLIWorkspaceContext   `json:"cliContext,omitempty"`
	Capabilities           map[string]bool        `json:"capabilities,omitempty"`
	Availability           map[string]string      `json:"availability,omitempty"`
}

type WorkspaceTab struct {
	ID           string `json:"id"`
	Title        string `json:"title,omitempty"`
	Kind         string `json:"kind,omitempty"`
	ConnectionID string `json:"connectionId,omitempty"`
	Database     string `json:"database,omitempty"`
	Object       string `json:"object,omitempty"`
	Draft        string `json:"draft,omitempty"`
}

type WorkspaceSQLActivity struct {
	ID        string    `json:"id,omitempty"`
	Statement string    `json:"statement,omitempty"`
	Status    string    `json:"status,omitempty"`
	CreatedAt time.Time `json:"createdAt,omitempty"`
}

type WorkspaceQuery struct {
	ID      string `json:"id,omitempty"`
	Name    string `json:"name,omitempty"`
	Content string `json:"content,omitempty"`
}

type CLIWorkspaceContext struct {
	CWD          string   `json:"cwd,omitempty"`
	ContextFiles []string `json:"contextFiles,omitempty"`
	ConnectionID string   `json:"connectionId,omitempty"`
	Database     string   `json:"database,omitempty"`
	Command      string   `json:"command,omitempty"`
}

// Normalize fills deterministic defaults and computes ContentHash. The hash
// excludes itself, so callers can safely invoke Normalize repeatedly.
func (s *WorkspaceSnapshot) Normalize() error {
	if s == nil {
		return errors.New("workspace snapshot is nil")
	}
	if s.SchemaVersion == 0 {
		s.SchemaVersion = CurrentSchemaVersion
	}
	if s.SourceKind != WorkspaceDesktop && s.SourceKind != WorkspaceCLI {
		return fmt.Errorf("invalid workspace source kind %q", s.SourceKind)
	}
	s.SourceID = strings.TrimSpace(s.SourceID)
	s.SourceInstanceID = strings.TrimSpace(s.SourceInstanceID)
	if s.SourceID == "" || s.SourceInstanceID == "" {
		return errors.New("workspace sourceId and sourceInstanceId are required")
	}
	if s.Revision < 1 {
		return errors.New("workspace revision must be positive")
	}
	if s.CapturedAt.IsZero() {
		s.CapturedAt = time.Now().UTC()
	} else {
		s.CapturedAt = s.CapturedAt.UTC()
	}
	previous := s.ContentHash
	s.ContentHash = ""
	hash, err := HashJSON(s)
	if err != nil {
		s.ContentHash = previous
		return err
	}
	s.ContentHash = hash
	return nil
}

// RunPolicy controls budgets and timeout behavior. Durations are encoded as
// nanoseconds by encoding/json, matching Go's standard time.Duration contract.
type RunPolicy struct {
	DefaultDispatchMode            DispatchMode  `json:"defaultDispatchMode"`
	SoftToolRoundLimit             int           `json:"softToolRoundLimit"`
	MaxToolRounds                  int           `json:"maxToolRounds"`
	MaxConsecutiveFailedToolRounds int           `json:"maxConsecutiveFailedToolRounds"`
	MaxToolNudges                  int           `json:"maxToolNudges"`
	MaxModelRetriesPerTurn         int           `json:"maxModelRetriesPerTurn"`
	MaxActiveDuration              time.Duration `json:"maxActiveDuration"`
	ModelTurnTimeout               time.Duration `json:"modelTurnTimeout"`
	ModelIdleTimeout               time.Duration `json:"modelIdleTimeout"`
	DefaultToolTimeout             time.Duration `json:"defaultToolTimeout"`
	MaxTotalTokens                 int           `json:"maxTotalTokens"`
	MaxToolResultBytes             int64         `json:"maxToolResultBytes"`
}

// RunRuntimeConfig controls the live coordination loops around a run. Unlike
// RunPolicy, these values are read by an already-running Harness and may be
// changed without recreating workers. Durations use Go's standard
// time.Duration JSON representation (nanoseconds), which is also the shape
// emitted by Wails bindings.
type RunRuntimeConfig struct {
	ControlPollInterval            time.Duration `json:"controlPollInterval"`
	WorkspaceSnapshotRenewInterval time.Duration `json:"workspaceSnapshotRenewInterval"`
	WorkspaceSnapshotLeaseDuration time.Duration `json:"workspaceSnapshotLeaseDuration"`
	// PolicyWatchInterval controls how often the desktop adapter checks the
	// shared policy file for a newer revision.  It lives in the shared runtime
	// projection so CLI edits and a running desktop owner use the same cadence.
	PolicyWatchInterval time.Duration `json:"policyWatchInterval"`
}

const (
	DefaultControlPollInterval       = 200 * time.Millisecond
	DefaultRunWorkspaceRenewInterval = 5 * time.Second
	DefaultRunWorkspaceLeaseDuration = 15 * time.Second
	DefaultRunPolicyWatchInterval    = 500 * time.Millisecond
)

func DefaultRunRuntimeConfig() RunRuntimeConfig {
	return RunRuntimeConfig{
		ControlPollInterval:            DefaultControlPollInterval,
		WorkspaceSnapshotRenewInterval: DefaultRunWorkspaceRenewInterval,
		WorkspaceSnapshotLeaseDuration: DefaultRunWorkspaceLeaseDuration,
		PolicyWatchInterval:            DefaultRunPolicyWatchInterval,
	}
}

func (c RunRuntimeConfig) Normalize() RunRuntimeConfig {
	if c.ControlPollInterval == 0 {
		c.ControlPollInterval = DefaultControlPollInterval
	}
	if c.WorkspaceSnapshotRenewInterval == 0 {
		c.WorkspaceSnapshotRenewInterval = DefaultRunWorkspaceRenewInterval
	}
	if c.WorkspaceSnapshotLeaseDuration == 0 {
		c.WorkspaceSnapshotLeaseDuration = DefaultRunWorkspaceLeaseDuration
	}
	if c.PolicyWatchInterval == 0 {
		c.PolicyWatchInterval = DefaultRunPolicyWatchInterval
	}
	return c
}

func (c RunRuntimeConfig) Validate() error {
	c = c.Normalize()
	if c.ControlPollInterval <= 0 || c.WorkspaceSnapshotRenewInterval <= 0 || c.WorkspaceSnapshotLeaseDuration <= 0 || c.PolicyWatchInterval <= 0 {
		return errors.New("run runtime durations must be positive")
	}
	if c.WorkspaceSnapshotRenewInterval >= c.WorkspaceSnapshotLeaseDuration {
		return errors.New("workspace snapshot renew interval must be shorter than lease duration")
	}
	return nil
}

// RunPolicySnapshot is the versioned shared default-policy projection.  It is
// deliberately separate from the policy embedded in a RunSnapshot: this
// revision protects settings writes, while a run freezes its effective policy
// when it is created.
type RunPolicySnapshot struct {
	SchemaVersion int              `json:"schemaVersion"`
	Revision      int64            `json:"revision"`
	Policy        RunPolicy        `json:"policy"`
	Runtime       RunRuntimeConfig `json:"runtime"`
}

// RunPolicyMutationRequest changes the shared default policy.  Callers must
// echo the revision returned by AIGetRunPolicy so a stale settings window can
// never overwrite a newer policy silently.
type RunPolicyMutationRequest struct {
	ExpectedRevision int64            `json:"expectedRevision"`
	Policy           RunPolicy        `json:"policy"`
	Runtime          RunRuntimeConfig `json:"runtime"`
}

// LedgerStatus is a non-sensitive health projection for settings surfaces.
// It intentionally never exposes the ledger key, encrypted payloads, or a
// filesystem path. Callers can use it to distinguish a ready ledger from a
// locked/missing-key state without attempting a run.
type LedgerStatus struct {
	State   string `json:"state"`
	Message string `json:"message,omitempty"`
}

const (
	LedgerStatusReady       = "ready"
	LedgerStatusLocked      = "locked"
	LedgerStatusUnavailable = "unavailable"
)

func DefaultRunPolicySnapshot() RunPolicySnapshot {
	// Revision one also applies to a not-yet-materialized defaults file.  This
	// makes an omitted expectedRevision (which Wails decodes as zero) a stable
	// conflict rather than an unguarded first write.
	return RunPolicySnapshot{
		SchemaVersion: CurrentSchemaVersion,
		Revision:      1,
		Policy:        DefaultRunPolicy(),
		Runtime:       DefaultRunRuntimeConfig(),
	}
}

func (s RunPolicySnapshot) Normalize() RunPolicySnapshot {
	if s.SchemaVersion == 0 {
		s.SchemaVersion = CurrentSchemaVersion
	}
	if s.Revision == 0 {
		s.Revision = 1
	}
	s.Policy = s.Policy.Normalize()
	s.Runtime = s.Runtime.Normalize()
	return s
}

func (s RunPolicySnapshot) Validate() error {
	s = s.Normalize()
	if s.SchemaVersion != CurrentSchemaVersion {
		return fmt.Errorf("unsupported run policy schema version %d", s.SchemaVersion)
	}
	if s.Revision < 1 {
		return errors.New("run policy revision must be positive")
	}
	if err := s.Policy.Validate(); err != nil {
		return err
	}
	return s.Runtime.Validate()
}

func DefaultRunPolicy() RunPolicy {
	return RunPolicy{DefaultDispatchMode: DispatchQueue, SoftToolRoundLimit: 10,
		MaxToolRounds: 15, MaxConsecutiveFailedToolRounds: 3, MaxToolNudges: 2,
		MaxModelRetriesPerTurn: 1, MaxActiveDuration: 30 * time.Minute,
		MaxToolResultBytes: 1 << 20}
}

func (p RunPolicy) Normalize() RunPolicy {
	if p.DefaultDispatchMode == "" {
		p.DefaultDispatchMode = DispatchQueue
	}
	if p.SoftToolRoundLimit == 0 {
		p.SoftToolRoundLimit = 10
	}
	if p.MaxToolRounds == 0 {
		p.MaxToolRounds = 15
	}
	if p.MaxConsecutiveFailedToolRounds == 0 {
		p.MaxConsecutiveFailedToolRounds = 3
	}
	if p.MaxToolNudges == 0 {
		p.MaxToolNudges = 2
	}
	if p.MaxModelRetriesPerTurn == 0 {
		p.MaxModelRetriesPerTurn = 1
	}
	if p.MaxActiveDuration == 0 {
		p.MaxActiveDuration = 30 * time.Minute
	}
	if p.MaxToolResultBytes == 0 {
		p.MaxToolResultBytes = 1 << 20
	}
	return p
}

func (p RunPolicy) Validate() error {
	p = p.Normalize()
	if !p.DefaultDispatchMode.Valid() {
		return fmt.Errorf("invalid default dispatch mode %q", p.DefaultDispatchMode)
	}
	if p.SoftToolRoundLimit < 0 || p.MaxToolRounds < 0 || p.MaxConsecutiveFailedToolRounds < 0 || p.MaxToolNudges < 0 || p.MaxModelRetriesPerTurn < 0 || p.MaxTotalTokens < 0 || p.MaxToolResultBytes < 0 {
		return errors.New("run policy limits cannot be negative")
	}
	if p.MaxToolRounds > 0 && p.SoftToolRoundLimit > p.MaxToolRounds {
		return errors.New("soft tool round limit cannot exceed max tool rounds")
	}
	if p.MaxActiveDuration < 0 || p.ModelTurnTimeout < 0 || p.ModelIdleTimeout < 0 || p.DefaultToolTimeout < 0 {
		return errors.New("run policy durations cannot be negative")
	}
	return nil
}

type ModelTurnRequest struct {
	RunID     string           `json:"runId"`
	SessionID string           `json:"sessionId"`
	Messages  []Message        `json:"messages"`
	Tools     []ToolDescriptor `json:"tools,omitempty"`
	// ConversationCursor is the provider-facing cursor from the last durable
	// checkpoint. Adapters may use it to continue a provider conversation; it is
	// never inferred from an in-memory stream after a process boundary.
	ConversationCursor string           `json:"conversationCursor,omitempty"`
	Provider           string           `json:"provider,omitempty"`
	ProviderBinding    *ProviderBinding `json:"-"`
	Model              string           `json:"model,omitempty"`
	Thinking           string           `json:"thinking,omitempty"`
	Temperature        *float64         `json:"temperature,omitempty"`
	MaxTokens          *int             `json:"maxTokens,omitempty"`
	ProviderState      json.RawMessage  `json:"providerState,omitempty"`
	Policy             RunPolicy        `json:"policy"`
}

type ToolDescriptor struct {
	Name           string          `json:"name"`
	Description    string          `json:"description,omitempty"`
	InputSchema    json.RawMessage `json:"inputSchema,omitempty"`
	Effect         ToolEffect      `json:"effect"`
	Capabilities   []string        `json:"capabilities,omitempty"`
	DefaultTimeout time.Duration   `json:"defaultTimeout,omitempty"`
	MaxResultBytes int64           `json:"maxResultBytes,omitempty"`
}

// ToolCatalogBinding is the immutable tool contract attached to a run.  The
// descriptor list is canonicalized before hashing and persisted encrypted;
// adapters only receive the hash/revision through RunSnapshot.
type ToolCatalogBinding struct {
	SchemaVersion int              `json:"schemaVersion"`
	Revision      int64            `json:"revision"`
	Hash          string           `json:"hash"`
	Descriptors   []ToolDescriptor `json:"descriptors"`
}

type ToolCallRecord struct {
	RunID             string                      `json:"runId"`
	CallID            string                      `json:"callId"`
	Attempt           int                         `json:"attempt"`
	ToolName          string                      `json:"toolName"`
	Effect            ToolEffect                  `json:"effect"`
	Status            string                      `json:"status"`
	ArgsHash          string                      `json:"argsHash"`
	Arguments         json.RawMessage             `json:"arguments,omitempty"`
	Result            json.RawMessage             `json:"result,omitempty"`
	ResultHash        string                      `json:"resultHash,omitempty"`
	Truncated         bool                        `json:"truncated,omitempty"`
	OriginalBytes     int64                       `json:"originalBytes,omitempty"`
	StartedAt         time.Time                   `json:"startedAt,omitempty"`
	CompletedAt       time.Time                   `json:"completedAt,omitempty"`
	ErrorCode         string                      `json:"errorCode,omitempty"`
	UnknownOutcome    bool                        `json:"unknownOutcome,omitempty"`
	WorkspaceSnapshot *WorkspaceSnapshotReference `json:"workspaceSnapshot,omitempty"`
}

type ApprovalRecord struct {
	ApprovalID  string          `json:"approvalId"`
	RunID       string          `json:"runId"`
	CallID      string          `json:"callId"`
	ToolName    string          `json:"toolName"`
	Effect      ToolEffect      `json:"effect"`
	ArgsHash    string          `json:"argsHash"`
	Arguments   json.RawMessage `json:"-"`
	Status      string          `json:"status"`
	RunRevision int64           `json:"runRevision"`
	CreatedAt   time.Time       `json:"createdAt"`
	DecidedAt   time.Time       `json:"decidedAt,omitempty"`
}

type Checkpoint struct {
	ID                 string                      `json:"checkpointId"`
	RunID              string                      `json:"runId"`
	Sequence           int64                       `json:"sequence"`
	State              RunState                    `json:"state"`
	ConversationCursor string                      `json:"conversationCursor,omitempty"`
	ProviderState      json.RawMessage             `json:"providerState,omitempty"`
	WorkspaceSnapshot  *WorkspaceSnapshotReference `json:"workspaceSnapshot,omitempty"`
	CreatedAt          time.Time                   `json:"createdAt"`
}

// RunResumeContext is the durable execution boundary used after a process
// interruption.  Checkpoint contains the last executable provider cursor;
// PendingTool/ PendingApproval identify work that was already persisted but
// had not reached its completion boundary.  Optional records are nil when the
// corresponding operation is not waiting for recovery.
type RunResumeContext struct {
	Run         RunSnapshot     `json:"run"`
	Checkpoint  *Checkpoint     `json:"checkpoint,omitempty"`
	PendingTool *ToolCallRecord `json:"pendingTool,omitempty"`
	// PendingUnknownTool is retained even after an explicit recovery retry has
	// advanced the run attempt. It lets the owner create a new attempt while
	// preserving the old unknown side-effect record for audit.
	PendingUnknownTool *ToolCallRecord `json:"pendingUnknownTool,omitempty"`
	PendingApproval    *ApprovalRecord `json:"pendingApproval,omitempty"`
	ResumeState        RunState        `json:"resumeState"`
}

type Lease struct {
	RunID     string    `json:"runId"`
	OwnerID   string    `json:"ownerId"`
	Token     string    `json:"-"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type CreateSessionRequest struct {
	SessionID string `json:"sessionId,omitempty"`
	Title     string `json:"title,omitempty"`
}

// CreateSessionBranchRequest creates an immutable transcript branch. The
// source cursor must be a user message because tool/assistant messages can
// represent completed side effects and are not safe edit/retry boundaries.
// ExpectedSourceRevision protects the source projection from a stale UI edit.
type CreateSessionBranchRequest struct {
	SessionID              string `json:"sessionId"`
	SourceSessionID        string `json:"sourceSessionId"`
	BranchFromMessageID    string `json:"branchFromMessageId"`
	ExpectedSourceRevision int64  `json:"expectedSourceRevision,omitempty"`
	Title                  string `json:"title,omitempty"`
}

type CreateRunRequest struct {
	RunID          string    `json:"runId,omitempty"`
	SessionID      string    `json:"sessionId"`
	RequestID      string    `json:"requestId,omitempty"`
	InitialMessage *Message  `json:"initialMessage,omitempty"`
	Policy         RunPolicy `json:"policy"`
	Provider       string    `json:"provider,omitempty"`
	// ProviderBinding is internal-only and is encrypted by the Ledger. It must
	// never cross Wails/CLI serialization boundaries.
	ProviderBinding         *ProviderBinding `json:"-"`
	Model                   string           `json:"model,omitempty"`
	ContextSourceID         string           `json:"contextSourceId,omitempty"`
	ContextSourceInstanceID string           `json:"contextSourceInstanceId,omitempty"`
	Thinking                string           `json:"thinking,omitempty"`
	Temperature             *float64         `json:"temperature,omitempty"`
	MaxTokens               *int             `json:"maxTokens,omitempty"`
	TaskKind                AgentTaskKind    `json:"taskKind,omitempty"`
	AllowTools              *bool            `json:"allowTools,omitempty"`
	// ExpectedSessionRevision is the CAS guard used when an input submission
	// creates a new run. Zero means the caller intentionally does not provide a
	// guard (used by internal recovery paths).
	ExpectedSessionRevision int64 `json:"expectedSessionRevision,omitempty"`
	// ToolCatalogBinding is an internal persistence input. It is deliberately
	// excluded from the Wails/CLI JSON surface because descriptors may contain
	// sensitive implementation details and are encrypted by the Ledger.
	ToolCatalogBinding *ToolCatalogBinding `json:"-"`
}

type AppendEventRequest struct {
	RunID            string          `json:"runId"`
	ExpectedSequence int64           `json:"expectedSequence,omitempty"`
	ExpectedRevision int64           `json:"expectedRevision,omitempty"`
	Kind             EventKind       `json:"kind"`
	ResultingState   RunState        `json:"resultingState"`
	Payload          any             `json:"payload,omitempty"`
	PayloadJSON      json.RawMessage `json:"-"`
	Attempt          int             `json:"attempt,omitempty"`
	OwnerToken       string          `json:"-"`
	TerminalReason   string          `json:"terminalReason,omitempty"`
	// AppliedControlCommandID records the one command whose action is known to
	// have produced this terminal transition. It is an internal ledger input,
	// never part of the external event contract.
	AppliedControlCommandID string `json:"-"`
}

type SaveCheckpointRequest struct {
	RunID              string                      `json:"runId"`
	State              RunState                    `json:"state"`
	Sequence           int64                       `json:"sequence"`
	ConversationCursor string                      `json:"conversationCursor,omitempty"`
	ProviderState      json.RawMessage             `json:"providerState,omitempty"`
	ExpectedRevision   int64                       `json:"expectedRevision,omitempty"`
	OwnerToken         string                      `json:"-"`
	WorkspaceSnapshot  *WorkspaceSnapshotReference `json:"workspaceSnapshot,omitempty"`
}

type StartToolRequest struct {
	RunID             string                      `json:"runId"`
	CallID            string                      `json:"callId"`
	Attempt           int                         `json:"attempt,omitempty"`
	ToolName          string                      `json:"toolName"`
	Effect            ToolEffect                  `json:"effect"`
	Arguments         json.RawMessage             `json:"arguments"`
	ExpectedRevision  int64                       `json:"expectedRevision,omitempty"`
	OwnerToken        string                      `json:"-"`
	WorkspaceSnapshot *WorkspaceSnapshotReference `json:"workspaceSnapshot,omitempty"`
}

type FinishToolRequest struct {
	RunID  string `json:"runId"`
	CallID string `json:"callId"`
	// Attempt binds completion to one exact persisted invocation. Zero keeps the
	// historical "newest attempt" behavior for external low-level callers;
	// harness recovery always supplies the durable attempt explicitly.
	Attempt int    `json:"attempt,omitempty"`
	Status  string `json:"status"`
	Result  any    `json:"result,omitempty"`
	// ResultJSON may be supplied by the harness when it has already performed
	// canonical encoding/truncation.  Ledger methods use it verbatim (after a
	// validity check) so all durable projections share identical bytes.
	ResultJSON       json.RawMessage `json:"resultJson,omitempty"`
	ErrorCode        string          `json:"errorCode,omitempty"`
	UnknownOutcome   bool            `json:"unknownOutcome,omitempty"`
	Truncated        bool            `json:"truncated,omitempty"`
	OriginalBytes    int64           `json:"originalBytes,omitempty"`
	MaxResultBytes   int64           `json:"maxResultBytes,omitempty"`
	ExpectedRevision int64           `json:"expectedRevision,omitempty"`
	OwnerToken       string          `json:"-"`
}

type PutApprovalRequest struct {
	ApprovalID  string          `json:"approvalId,omitempty"`
	RunID       string          `json:"runId"`
	CallID      string          `json:"callId"`
	ToolName    string          `json:"toolName"`
	Effect      ToolEffect      `json:"effect"`
	Arguments   json.RawMessage `json:"-"`
	RunRevision int64           `json:"runRevision"`
	OwnerToken  string          `json:"-"`
}

type DecideApprovalRequest struct {
	ApprovalID          string `json:"approvalId"`
	Decision            string `json:"decision"`
	ExpectedRunRevision int64  `json:"expectedRunRevision,omitempty"`
	// The full tuple binds a decision to the exact approval card rendered by
	// an adapter. Missing or mismatched values must fail before the approval is
	// expired or otherwise mutated.
	ExpectedRunID    string `json:"expectedRunId,omitempty"`
	ExpectedCallID   string `json:"expectedCallId,omitempty"`
	ExpectedArgsHash string `json:"expectedArgsHash,omitempty"`
}

type QueueInputRequest struct {
	RequestID               string       `json:"requestId"`
	RunID                   string       `json:"runId"`
	SessionID               string       `json:"sessionId"`
	Content                 string       `json:"content"`
	DispatchMode            DispatchMode `json:"dispatchMode"`
	ContextSourceID         string       `json:"contextSourceId,omitempty"`
	ContextSourceInstanceID string       `json:"contextSourceInstanceId,omitempty"`
}

type ControlCommand struct {
	ID               string           `json:"commandId"`
	RunID            string           `json:"runId"`
	Action           RunControlAction `json:"action"`
	Payload          json.RawMessage  `json:"payload,omitempty"`
	ExpectedRevision int64            `json:"expectedRevision,omitempty"`
	CreatedAt        time.Time        `json:"createdAt"`
	ConsumedAt       time.Time        `json:"consumedAt,omitempty"`
	// Claim fields describe the crash-recoverable hand-off between a
	// supervisor and the durable command queue. A claim is not an acknowledgement
	// and therefore must never make a command disappear from a later owner.
	ClaimedBy      string    `json:"-"`
	ClaimedAt      time.Time `json:"claimedAt,omitempty"`
	ClaimExpiresAt time.Time `json:"claimExpiresAt,omitempty"`
	AppliedAt      time.Time `json:"appliedAt,omitempty"`
}

// SteerOrQueueRequest is the atomic submission envelope used when a caller
// asks to steer the currently active run. The Ledger decides in one SQLite
// transaction whether the target is still steerable; if it reached a terminal
// state meanwhile, the embedded CreateRun request is persisted instead.
type SteerOrQueueRequest struct {
	Command   ControlCommand
	CreateRun CreateRunRequest
}

type SteerOrQueueResult struct {
	Run         RunSnapshot
	Disposition string // steered | queued
}
