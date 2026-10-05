// Package runharness contains the durable, provider-independent primitives used
// by the GoNavi agent runner.  The package deliberately has no dependency on
// Wails or on a particular model provider so that the desktop and CLI adapters
// can share the same run ledger.
package runharness

import (
	"errors"
	"fmt"
	"strings"
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
