package runharness

import (
	"encoding/json"
	"time"
)

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
	StartedAt         time.Time                   `json:"startedAt,omitempty" ts_type:"string"`
	CompletedAt       time.Time                   `json:"completedAt,omitempty" ts_type:"string"`
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
	CreatedAt   time.Time       `json:"createdAt" ts_type:"string"`
	DecidedAt   time.Time       `json:"decidedAt,omitempty" ts_type:"string"`
}

type Checkpoint struct {
	ID                 string                      `json:"checkpointId"`
	RunID              string                      `json:"runId"`
	Sequence           int64                       `json:"sequence"`
	State              RunState                    `json:"state"`
	ConversationCursor string                      `json:"conversationCursor,omitempty"`
	ProviderState      json.RawMessage             `json:"providerState,omitempty"`
	WorkspaceSnapshot  *WorkspaceSnapshotReference `json:"workspaceSnapshot,omitempty"`
	CreatedAt          time.Time                   `json:"createdAt" ts_type:"string"`
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
	ExpiresAt time.Time `json:"expiresAt" ts_type:"string"`
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
	CreatedAt        time.Time        `json:"createdAt" ts_type:"string"`
	ConsumedAt       time.Time        `json:"consumedAt,omitempty" ts_type:"string"`
	// Claim fields describe the crash-recoverable hand-off between a
	// supervisor and the durable command queue. A claim is not an acknowledgement
	// and therefore must never make a command disappear from a later owner.
	ClaimedBy      string    `json:"-"`
	ClaimedAt      time.Time `json:"claimedAt,omitempty" ts_type:"string"`
	ClaimExpiresAt time.Time `json:"claimExpiresAt,omitempty" ts_type:"string"`
	AppliedAt      time.Time `json:"appliedAt,omitempty" ts_type:"string"`
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
