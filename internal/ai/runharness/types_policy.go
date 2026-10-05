package runharness

import (
	"errors"
	"fmt"
	"time"
)

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
