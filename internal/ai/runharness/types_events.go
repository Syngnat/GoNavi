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
	Timestamp         time.Time       `json:"timestamp" ts_type:"string"`
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
	PromptTokens     int  `json:"promptTokens,omitempty"`
	CompletionTokens int  `json:"completionTokens,omitempty"`
	TotalTokens      int  `json:"totalTokens,omitempty"`
	CachedTokens     *int `json:"cachedTokens,omitempty"`
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
	CreatedAt         time.Time `json:"createdAt" ts_type:"string"`
	ReconciledAt      time.Time `json:"reconciledAt,omitempty" ts_type:"string"`
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
