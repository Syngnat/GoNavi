package cli

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"GoNavi-Wails/internal/ai/runharness"

	"github.com/google/uuid"
)

func readAgentWorkspaceSnapshot(path string) (runharness.WorkspaceSnapshot, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return runharness.WorkspaceSnapshot{}, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return runharness.WorkspaceSnapshot{}, err
	}
	var snapshot runharness.WorkspaceSnapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return runharness.WorkspaceSnapshot{}, fmt.Errorf("decode workspace snapshot: %w", err)
	}
	if err := snapshot.Normalize(); err != nil {
		return runharness.WorkspaceSnapshot{}, err
	}
	return snapshot, nil
}

// agentWorkspaceSnapshotBinding is the immutable source identity attached to
// every input accepted by one CLI invocation. Keeping the original normalized
// snapshot lets renewal extend the lease without changing its content hash.
type agentWorkspaceSnapshotBinding struct {
	SourceID         string
	SourceInstanceID string
	Snapshot         runharness.WorkspaceSnapshot
}

func (binding agentWorkspaceSnapshotBinding) Publish(ctx context.Context, runtime AgentHarnessRuntime) error {
	if runtime == nil {
		return errors.New("agent harness runtime is nil")
	}
	_, err := runtime.PutWorkspaceSnapshot(ctx, binding.Snapshot)
	return err
}

// agentWorkspaceSnapshotRenewal owns a source heartbeat independently of a
// command's wait timeout. Detached commands retain it until their lifecycle
// context ends, matching the durable run owner lifetime.
type agentWorkspaceSnapshotRenewal struct {
	cancel   context.CancelFunc
	done     chan struct{}
	detached atomic.Bool
	stopOnce sync.Once
}

// agentWorkspaceSnapshotRenewInterval is retained as a package-level test
// seam and legacy default. New call sites should pass the effective runtime
// value explicitly; omitting it keeps older embedders/tests source-compatible.
var agentWorkspaceSnapshotRenewInterval = runharness.DefaultRunRuntimeConfig().WorkspaceSnapshotRenewInterval

func startAgentWorkspaceSnapshotRenewal(ctx context.Context, runtime AgentHarnessRuntime, binding agentWorkspaceSnapshotBinding, configured ...time.Duration) *agentWorkspaceSnapshotRenewal {
	if ctx == nil {
		// A workspace heartbeat without an owner lifecycle could keep an expired
		// snapshot source alive indefinitely. Agent entry points reject nil root
		// contexts; this guard keeps direct helper callers from creating one.
		return nil
	}
	renewCtx, cancel := context.WithCancel(ctx)
	renewal := &agentWorkspaceSnapshotRenewal{cancel: cancel, done: make(chan struct{})}
	interval := agentWorkspaceSnapshotRenewInterval
	if len(configured) > 0 {
		interval = configured[0]
	}
	if interval <= 0 {
		interval = runharness.DefaultRunRuntimeConfig().WorkspaceSnapshotRenewInterval
	}
	go func() {
		defer close(renewal.done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-renewCtx.Done():
				return
			case <-ticker.C:
				// Re-publishing the identical normalized snapshot is the Ledger's
				// source heartbeat. A transient write failure is not terminal here:
				// the next interval can recover, while an expired lease makes the
				// run visibly await workspace rather than silently using stale data.
				if err := binding.Publish(renewCtx, runtime); err != nil && renewCtx.Err() != nil {
					return
				}
			}
		}
	}()
	return renewal
}

func (renewal *agentWorkspaceSnapshotRenewal) Detach() {
	if renewal != nil {
		renewal.detached.Store(true)
	}
}

func (renewal *agentWorkspaceSnapshotRenewal) Close() {
	if renewal == nil || renewal.detached.Load() {
		return
	}
	renewal.stopOnce.Do(func() {
		renewal.cancel()
		<-renewal.done
	})
}

func defaultAgentWorkspaceSourceID(cwd string) string {
	sum := sha256.Sum256([]byte(cwd))
	// source IDs remain plaintext indexes in the Ledger, so do not expose the
	// local directory itself. The full CWD stays inside the encrypted snapshot.
	return fmt.Sprintf("cli-%x", sum[:12])
}

func newAgentCLIWorkspaceSnapshot(sourceID, command string) (runharness.WorkspaceSnapshot, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return runharness.WorkspaceSnapshot{}, fmt.Errorf("resolve CLI working directory: %w", err)
	}
	if sourceID = strings.TrimSpace(sourceID); sourceID == "" {
		sourceID = defaultAgentWorkspaceSourceID(cwd)
	}
	snapshot := runharness.WorkspaceSnapshot{
		SourceKind:       runharness.WorkspaceCLI,
		SourceID:         sourceID,
		SourceInstanceID: uuid.NewString(),
		Revision:         1,
		ActiveContext: map[string]any{
			"source":  "cli",
			"command": command,
			"cwd":     cwd,
		},
		CLIContext: &runharness.CLIWorkspaceContext{CWD: cwd, Command: command},
		Capabilities: map[string]bool{
			"active_context":           true,
			"cli_context":              true,
			"tabs":                     false,
			"active_tab":               false,
			"editor_draft":             false,
			"sql_activity":             false,
			"saved_queries":            false,
			"snippets":                 false,
			"external_sql_directories": false,
			"shortcuts":                false,
			"transaction_state":        false,
			"frontend_diagnostics":     false,
		},
		Availability: map[string]string{
			"tabs":                   "unsupported_by_cli",
			"activeTab":              "unsupported_by_cli",
			"editorDraft":            "unsupported_by_cli",
			"sqlActivity":            "unsupported_by_cli",
			"savedQueries":           "unsupported_by_cli",
			"snippets":               "unsupported_by_cli",
			"externalSQLDirectories": "unsupported_by_cli",
			"shortcuts":              "unsupported_by_cli",
			"transactionState":       "unsupported_by_cli",
			"frontendDiagnostics":    "unsupported_by_cli",
		},
	}
	if err := snapshot.Normalize(); err != nil {
		return runharness.WorkspaceSnapshot{}, err
	}
	return snapshot, nil
}

// putAgentWorkspaceSnapshot binds a complete CLI-native snapshot before an
// input is submitted. Inputs must carry both source identifiers so the
// Harness never falls back to a desktop source with the same logical ID.
func putAgentWorkspaceSnapshot(ctx context.Context, runtime AgentHarnessRuntime, path, sourceID, command string) (agentWorkspaceSnapshotBinding, error) {
	snapshot, err := readAgentWorkspaceSnapshot(path)
	if err != nil {
		return agentWorkspaceSnapshotBinding{}, err
	}
	if strings.TrimSpace(path) == "" {
		snapshot, err = newAgentCLIWorkspaceSnapshot(sourceID, command)
		if err != nil {
			return agentWorkspaceSnapshotBinding{}, err
		}
	} else if snapshot.SourceKind != runharness.WorkspaceCLI {
		return agentWorkspaceSnapshotBinding{}, fmt.Errorf("--context-file sourceKind must be %q, got %q", runharness.WorkspaceCLI, snapshot.SourceKind)
	}
	if sourceID = strings.TrimSpace(sourceID); sourceID != "" && sourceID != snapshot.SourceID {
		return agentWorkspaceSnapshotBinding{}, fmt.Errorf("--context-source %q does not match snapshot sourceId %q", sourceID, snapshot.SourceID)
	}
	// readAgentWorkspaceSnapshot and the native constructor both normalize, but
	// normalize again here to make the invariant local to the durable boundary.
	if err := snapshot.Normalize(); err != nil {
		return agentWorkspaceSnapshotBinding{}, err
	}
	binding := agentWorkspaceSnapshotBinding{
		SourceID:         snapshot.SourceID,
		SourceInstanceID: snapshot.SourceInstanceID,
		Snapshot:         snapshot,
	}
	if err := binding.Publish(ctx, runtime); err != nil {
		return agentWorkspaceSnapshotBinding{}, err
	}
	return binding, nil
}
