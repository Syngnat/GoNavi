package runharness

import (
	"encoding/json"
	"time"
)

// RunSnapshot is the non-sensitive run projection returned to adapters.
// time.Time fields use ts_type:"string" because the Wails TypeScript generator
// treats time.Time as a named struct, logs "Not found: time.Time", and emits
// `any`. JSON encoding remains RFC3339.
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
	OwnerExpiresAt          time.Time     `json:"ownerExpiresAt,omitempty" ts_type:"string"`
	CheckpointID            string        `json:"checkpointId,omitempty"`
	TerminalReason          string        `json:"terminalReason,omitempty"`
	CreatedAt               time.Time     `json:"createdAt" ts_type:"string"`
	UpdatedAt               time.Time     `json:"updatedAt" ts_type:"string"`
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
	CreatedAt           time.Time     `json:"createdAt" ts_type:"string"`
	UpdatedAt           time.Time     `json:"updatedAt" ts_type:"string"`
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
	CreatedAt   time.Time       `json:"createdAt" ts_type:"string"`
}
