package runharness

import (
	"errors"
	"fmt"
	"strings"
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
