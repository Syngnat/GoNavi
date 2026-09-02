package aiservice

// This file is the desktop adapter for the Go-owned agent run harness.  It
// deliberately contains no tool implementation: the app package can provide
// a ToolCatalog/ApprovalHandler through ConfigureAgentHarnessDependencies
// without introducing an import cycle back into this package.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/provider"
	"GoNavi-Wails/internal/ai/runharness"
	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/secretstore"
	"GoNavi-Wails/internal/uievents"

	"github.com/google/uuid"
)

const agentRunPolicyFileName = "agent_run_policy.json"

// ErrAgentLifecycleUnavailable is returned when a desktop binding is called
// before Wails has supplied the application lifecycle context.  The Harness
// must never create a durable run from an unowned background context: doing so
// would let a run outlive the application process that owns it.
var ErrAgentLifecycleUnavailable = errors.New("agent run lifecycle is unavailable")

// AgentHarnessDependencies are the optional adapters owned by the host
// application.  Keeping this type in the Service package gives the desktop
// and CLI hosts a stable seam while avoiding a dependency from Service to the
// database application package.
type AgentHarnessDependencies struct {
	Tools     runharness.ToolCatalog
	Approvals runharness.ApprovalHandler
}

// ConfigureAgentHarnessDependencies installs host-owned tool and approval
// adapters before the Service lifecycle starts.  It is a package function (as
// opposed to a Wails method) so interface-valued dependencies are never part
// of generated bindings.
func ConfigureAgentHarnessDependencies(service *Service, dependencies AgentHarnessDependencies) error {
	if service == nil {
		return errors.New("AI Service is nil")
	}
	service.agentMu.Lock()
	defer service.agentMu.Unlock()
	if service.agentHarnessInitialized {
		return errors.New("agent harness dependencies must be configured before startup")
	}
	if service.agentHarnessShutdown {
		return runharness.ErrHarnessClosed
	}
	service.agentToolCatalog = dependencies.Tools
	service.agentApprovalHandler = dependencies.Approvals
	return nil
}

// AISubmitAgentInput durably accepts an input and returns its queue/steer
// disposition.  The harness owns all scheduling and provider/tool work.
func (s *Service) AISubmitAgentInput(request runharness.AgentInputRequest) (runharness.AgentInputReceipt, error) {
	if s == nil {
		return runharness.AgentInputReceipt{}, errors.New("AI Service is nil")
	}
	// Policy writes update the live Harness and its durable defaults as one
	// operation. Serializing input acceptance with that mutation prevents a
	// local run from observing the old default in the small file/live-update
	// window. The run itself still freezes the effective policy in the Ledger.
	s.agentPolicyMu.Lock()
	defer s.agentPolicyMu.Unlock()
	harness, ctx, err := s.agentHarnessForCall()
	if err != nil {
		return runharness.AgentInputReceipt{}, err
	}
	return harness.SubmitInput(ctx, request)
}

// bindAgentProviderInput resolves the current desktop provider configuration
// exactly once, before the Ledger accepts a new run. The resulting binding is
// encrypted with the run and is the sole provider source for later attempts or
// process recovery. A providerless request is rejected before the Ledger sees
// it: every accepted run must have an immutable provider execution contract.
func (s *Service) bindAgentProviderInput(request *runharness.AgentInputRequest) error {
	if s == nil {
		return errors.New("AI Service is nil")
	}
	if request == nil {
		return errors.New("agent input is required")
	}

	requestedID := strings.TrimSpace(request.Provider)
	s.mu.RLock()
	activeID := strings.TrimSpace(s.activeProvider)
	if activeID == "" && len(s.providers) > 0 {
		activeID = strings.TrimSpace(s.providers[0].ID)
	}
	var selected ai.ProviderConfig
	for _, candidate := range s.providers {
		candidateID := strings.TrimSpace(candidate.ID)
		if requestedID != "" {
			if candidateID != requestedID && !strings.EqualFold(candidateID, requestedID) && !strings.EqualFold(strings.TrimSpace(candidate.Name), requestedID) {
				continue
			}
		} else if candidateID != activeID {
			continue
		}
		selected = cloneAgentProviderConfig(candidate)
		break
	}
	localizer := s.serviceLocalizerForLanguageLocked()
	s.mu.RUnlock()

	if strings.TrimSpace(selected.ID) == "" {
		if requestedID == "" {
			return serviceErrorFromLocalizer(
				localizer,
				"ai_service.backend.error.provider_not_configured",
				nil,
				errors.New("provider is not configured"),
			)
		}
		return fmt.Errorf("agent provider %q is not configured", requestedID)
	}
	resolved, err := s.resolveProviderConfigSecrets(selected)
	if err != nil {
		return err
	}
	options := ai.ChatSendOptions{Model: request.Model, ThinkingIntensity: request.Thinking}
	resolved = normalizeProviderConfig(applyChatSendOptionsToProviderConfig(resolved, options))
	if request.Temperature != nil {
		resolved.Temperature = *request.Temperature
	}
	if request.MaxTokens != nil {
		resolved.MaxTokens = *request.MaxTokens
	}
	resolved = cloneAgentProviderConfig(resolved)
	binding, err := runharness.NewProviderBinding(resolved.ID, resolved)
	if err != nil {
		return fmt.Errorf("bind agent provider: %w", err)
	}
	if strings.TrimSpace(binding.ProviderID) == "" {
		return serviceErrorFromLocalizer(
			localizer,
			"ai_service.backend.error.provider_not_configured",
			nil,
			errors.New("provider is not configured"),
		)
	}
	if err := request.SetProviderBinding(binding); err != nil {
		return fmt.Errorf("attach agent provider binding: %w", err)
	}
	return nil
}

// AIControlAgentRun applies a durable cancel, steer, approval, resume or
// recovery command to a run.
func (s *Service) AIControlAgentRun(request runharness.RunControlRequest) (runharness.RunSnapshot, error) {
	harness, ctx, err := s.agentHarnessForCall()
	if err != nil {
		return runharness.RunSnapshot{}, err
	}
	return harness.ControlRun(ctx, request)
}

// AIReadAgentRun reads the run projection and any events after a sequence.
func (s *Service) AIReadAgentRun(request runharness.RunReadRequest) (runharness.RunReadResult, error) {
	harness, ctx, err := s.agentHarnessForCall()
	if err != nil {
		return runharness.RunReadResult{}, err
	}
	return harness.ReadRun(ctx, request)
}

// AIListAgentSessions returns durable session projections without message
// bodies unless the caller explicitly reads one session.
func (s *Service) AIListAgentSessions(request runharness.SessionListRequest) (runharness.SessionListResult, error) {
	harness, ctx, err := s.agentHarnessForCall()
	if err != nil {
		return runharness.SessionListResult{}, err
	}
	return harness.ListSessions(ctx, request)
}

// AIReadAgentSession reads one durable session and its encrypted messages.
func (s *Service) AIReadAgentSession(request runharness.SessionReadRequest) (runharness.SessionProjection, error) {
	harness, ctx, err := s.agentHarnessForCall()
	if err != nil {
		return runharness.SessionProjection{}, err
	}
	return harness.ReadSession(ctx, request)
}

// AIMutateAgentSession changes session metadata using the supplied revision
// as a compare-and-swap guard.
func (s *Service) AIMutateAgentSession(request runharness.SessionMutationRequest) (runharness.SessionProjection, error) {
	harness, ctx, err := s.agentHarnessForCall()
	if err != nil {
		return runharness.SessionProjection{}, err
	}
	return harness.MutateSession(ctx, request)
}

// AIUpdateWorkspaceSnapshot stores a complete, source-owned workspace view.
// Publishing workspace context is deliberately lightweight: the desktop sends
// its first snapshot during startup, while opening the encrypted Agent ledger
// should wait until an Agent feature is actually used. The latest snapshot is
// therefore kept in memory until agentHarnessForCall initializes the ledger.
func (s *Service) AIUpdateWorkspaceSnapshot(snapshot runharness.WorkspaceSnapshot) (runharness.SnapshotAck, error) {
	if s == nil {
		return runharness.SnapshotAck{}, errors.New("AI Service is nil")
	}
	ctx, err := s.agentRunLifecycleContext()
	if err != nil {
		return runharness.SnapshotAck{}, err
	}
	if err := snapshot.Normalize(); err != nil {
		return runharness.SnapshotAck{}, err
	}
	return s.cacheOrPersistWorkspaceSnapshot(ctx, snapshot)
}

func workspaceSnapshotCacheKey(snapshot runharness.WorkspaceSnapshot) string {
	return string(snapshot.SourceKind) + "\x00" + snapshot.SourceID + "\x00" + snapshot.SourceInstanceID
}

func (s *Service) cacheOrPersistWorkspaceSnapshot(ctx context.Context, snapshot runharness.WorkspaceSnapshot) (runharness.SnapshotAck, error) {
	s.agentMu.Lock()
	if s.agentHarnessShutdown {
		s.agentMu.Unlock()
		return runharness.SnapshotAck{}, runharness.ErrHarnessClosed
	}
	if harness := s.agentHarness; harness != nil {
		s.agentMu.Unlock()
		return harness.PutWorkspaceSnapshot(ctx, snapshot)
	}
	if s.agentPendingWorkspaceSnapshots == nil {
		s.agentPendingWorkspaceSnapshots = make(map[string]runharness.WorkspaceSnapshot)
	}
	key := workspaceSnapshotCacheKey(snapshot)
	if previous, ok := s.agentPendingWorkspaceSnapshots[key]; ok {
		if snapshot.Revision < previous.Revision ||
			(snapshot.Revision == previous.Revision && snapshot.ContentHash != previous.ContentHash) {
			s.agentMu.Unlock()
			return runharness.SnapshotAck{}, runharness.ErrSnapshotConflict
		}
	}
	s.agentPendingWorkspaceSnapshots[key] = snapshot
	s.agentMu.Unlock()
	return runharness.SnapshotAck{
		SourceID:         snapshot.SourceID,
		SourceInstanceID: snapshot.SourceInstanceID,
		Revision:         snapshot.Revision,
		ContentHash:      snapshot.ContentHash,
		Accepted:         true,
	}, nil
}

// flushPendingWorkspaceSnapshots transfers startup snapshots to the durable
// ledger after the Harness has been initialized. A failed transfer is put back
// in the cache so a later heartbeat can retry with the same revision.
func (s *Service) flushPendingWorkspaceSnapshots(ctx context.Context) error {
	s.agentMu.Lock()
	harness := s.agentHarness
	if harness == nil || len(s.agentPendingWorkspaceSnapshots) == 0 {
		s.agentMu.Unlock()
		return nil
	}
	pending := make([]runharness.WorkspaceSnapshot, 0, len(s.agentPendingWorkspaceSnapshots))
	for _, snapshot := range s.agentPendingWorkspaceSnapshots {
		pending = append(pending, snapshot)
	}
	s.agentPendingWorkspaceSnapshots = nil
	s.agentMu.Unlock()

	for _, snapshot := range pending {
		if _, err := harness.PutWorkspaceSnapshot(ctx, snapshot); err != nil {
			s.agentMu.Lock()
			if s.agentPendingWorkspaceSnapshots == nil {
				s.agentPendingWorkspaceSnapshots = make(map[string]runharness.WorkspaceSnapshot)
			}
			key := workspaceSnapshotCacheKey(snapshot)
			if previous, ok := s.agentPendingWorkspaceSnapshots[key]; !ok || snapshot.Revision > previous.Revision {
				s.agentPendingWorkspaceSnapshots[key] = snapshot
			}
			s.agentMu.Unlock()
			return fmt.Errorf("flush workspace snapshot: %w", err)
		}
	}
	return nil
}

// AIGetRunPolicy reads the shared policy file.  Reading the policy does not
// require opening the encrypted ledger, which lets the settings page explain
// a missing key without creating a second failure.
func (s *Service) AIGetRunPolicy() (runharness.RunPolicySnapshot, error) {
	s.agentPolicyMu.Lock()
	defer s.agentPolicyMu.Unlock()
	return loadServiceRunPolicy(s.agentPolicyPath())
}

// AIGetAgentLedgerStatus returns a deliberately non-sensitive status for the
// settings UI. It never opens a Ledger just to answer this call, and it never
// returns a data-root path, key reference, or raw keyring/SQLite error.
func (s *Service) AIGetAgentLedgerStatus() runharness.LedgerStatus {
	if s == nil {
		return runharness.LedgerStatus{State: runharness.LedgerStatusUnavailable}
	}

	s.agentMu.RLock()
	initialized := s.agentHarnessInitialized
	initializationErr := s.agentHarnessInitialization
	shutdown := s.agentHarnessShutdown
	harness := s.agentHarness
	ledger := s.agentLedger
	s.agentMu.RUnlock()

	if shutdown {
		return runharness.LedgerStatus{State: runharness.LedgerStatusUnavailable}
	}
	if initialized && initializationErr == nil && harness != nil && ledger != nil {
		return runharness.LedgerStatus{State: runharness.LedgerStatusReady}
	}
	if isAgentLedgerLocked(initializationErr) {
		return runharness.LedgerStatus{State: runharness.LedgerStatusLocked}
	}
	return runharness.LedgerStatus{State: runharness.LedgerStatusUnavailable}
}

func isAgentLedgerLocked(err error) bool {
	return errors.Is(err, runharness.ErrLedgerLocked) ||
		errors.Is(err, runharness.ErrKeyUnavailable) ||
		secretstore.IsUnavailable(err)
}

// AISaveRunPolicy validates and atomically persists the shared policy, then
// updates the default used by future runs in an already-running Harness.
func (s *Service) AISaveRunPolicy(request runharness.RunPolicyMutationRequest) (runharness.RunPolicySnapshot, error) {
	if s == nil {
		return runharness.RunPolicySnapshot{}, errors.New("AI Service is nil")
	}
	if request.ExpectedRevision < 1 {
		return runharness.RunPolicySnapshot{}, fmt.Errorf("revision_conflict: %w: expectedRevision must be positive", runharness.ErrRevisionConflict)
	}
	policy := request.Policy.Normalize()
	if err := policy.Validate(); err != nil {
		return runharness.RunPolicySnapshot{}, err
	}
	runtime := request.Runtime.Normalize()
	if err := runtime.Validate(); err != nil {
		return runharness.RunPolicySnapshot{}, err
	}
	var next runharness.RunPolicySnapshot
	var mutationErr error
	// Keep the in-process lock held for the complete load/CAS/write/live-update
	// sequence. The file lock extends the same critical section to CLI or other
	// desktop processes sharing this data root.
	func() {
		s.agentPolicyMu.Lock()
		defer s.agentPolicyMu.Unlock()

		path := s.agentPolicyPath()
		// The policy is shared by desktop and standalone CLI processes. The
		// revision check and atomic replacement must therefore be one critical
		// section across processes, not merely within this Service instance.
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			mutationErr = err
			return
		}
		policyLock, err := appdata.AcquireFileLock(path + ".lock")
		if err != nil {
			mutationErr = err
			return
		}
		defer policyLock.Close()
		current, err := loadServiceRunPolicy(path)
		if err != nil {
			mutationErr = err
			return
		}
		if current.Revision != request.ExpectedRevision {
			mutationErr = fmt.Errorf("revision_conflict: %w: expected %d, got %d", runharness.ErrRevisionConflict, request.ExpectedRevision, current.Revision)
			return
		}
		next = current
		next.Revision++
		next.Policy = policy
		next.Runtime = runtime

		// Fence shutdown while the durable file and live Harness are being
		// updated. detachAgentHarness waits for this read lock, so a successful
		// update cannot race a close and leave a half-applied runtime config.
		s.agentMu.RLock()
		harness := s.agentHarness
		shutdown := s.agentHarnessShutdown
		var previousPolicy runharness.RunPolicy
		var previousRuntime runharness.RunRuntimeConfig
		if harness != nil {
			previousPolicy = harness.DefaultPolicy()
			previousRuntime = harness.RuntimeConfig()
		}
		if shutdown {
			s.agentMu.RUnlock()
			mutationErr = runharness.ErrHarnessClosed
			return
		}

		if err := saveServiceRunPolicy(path, next); err != nil {
			s.agentMu.RUnlock()
			mutationErr = err
			return
		}
		if harness != nil {
			// SetRuntimeConfig checks the Harness lifecycle and therefore acts as
			// the first live-update fence. Apply it before the in-memory default so
			// a closed Harness cannot retain a partially changed policy.
			if err := harness.SetRuntimeConfig(runtime); err != nil {
				rollbackErr := saveServiceRunPolicy(path, current)
				s.agentMu.RUnlock()
				mutationErr = errors.Join(err, rollbackErr)
				return
			}
			if err := harness.SetDefaultPolicy(policy); err != nil {
				rollbackPolicyErr := harness.SetDefaultPolicy(previousPolicy)
				rollbackRuntimeErr := harness.SetRuntimeConfig(previousRuntime)
				rollbackFileErr := saveServiceRunPolicy(path, current)
				s.agentMu.RUnlock()
				mutationErr = errors.Join(err, rollbackPolicyErr, rollbackRuntimeErr, rollbackFileErr)
				return
			}
		}
		s.agentMu.RUnlock()
	}()
	if mutationErr != nil {
		return runharness.RunPolicySnapshot{}, mutationErr
	}
	if s.configChanged != nil {
		s.configChanged()
	}
	return next, nil
}

// initializeAgentHarness opens the encrypted ledger and starts recovery using
// the application lifecycle context.  A failed initialization is remembered;
// callers receive the same error instead of repeatedly creating keyring or
// SQLite resources on every Wails call.
func (s *Service) initializeAgentHarness(ctx context.Context) error {
	if s == nil {
		return errors.New("AI Service is nil")
	}
	if ctx == nil {
		return ErrAgentLifecycleUnavailable
	}

	s.agentMu.Lock()
	defer s.agentMu.Unlock()
	if s.agentHarnessShutdown {
		return runharness.ErrHarnessClosed
	}
	if s.agentHarnessInitialized {
		return s.agentHarnessInitialization
	}
	s.agentHarnessInitialized = true
	if s.configDir == "" {
		s.configDir = resolveConfigDir()
	}
	configDir := s.configDir
	if s.agentContext == nil {
		s.agentContext = ctx
	}

	policySnapshot, err := loadServiceRunPolicy(filepath.Join(configDir, agentRunPolicyFileName))
	if err != nil {
		s.agentHarnessInitialization = fmt.Errorf("load agent run policy: %w", err)
		return s.agentHarnessInitialization
	}
	keyRef, err := agentLedgerKeyRef(configDir)
	if err != nil {
		s.agentHarnessInitialization = fmt.Errorf("resolve agent ledger key: %w", err)
		return s.agentHarnessInitialization
	}
	ledgerPath := filepath.Join(configDir, "agent_runs.sqlite")
	ledger, err := runharness.Open(ledgerPath, runharness.WithKeyring(keyRef, s.secretStore))
	if err != nil {
		s.agentHarnessInitialization = err
		return err
	}

	adapter := runharness.NewProviderModelTurnAdapter(s.resolveAgentProvider, s.resolveAgentImagePrompts)
	config := runharness.HarnessConfig{
		Ledger: ledger,
		Model:  adapter,
		InputBinder: func(_ context.Context, request *runharness.AgentInputRequest) error {
			return s.bindAgentProviderInput(request)
		},
		Tools:       s.agentToolCatalog,
		Approvals:   s.agentApprovalHandler,
		Runtime:     policySnapshot.Runtime,
		RootContext: ctx,
		OwnerID:     "gonavi-desktop-" + uuid.NewString(),
		Events: func(event runharness.RunEvent) {
			// The harness invokes this only after the Ledger transaction commits.
			s.emitAgentRunEvent(event)
		},
	}
	harness, err := runharness.NewAgentRunHarness(config)
	if err == nil {
		err = harness.SetDefaultPolicy(policySnapshot.Policy)
	}
	if err == nil {
		err = harness.SetRuntimeConfig(policySnapshot.Runtime)
	}
	if err == nil {
		err = harness.Start(ctx)
	}
	if err != nil {
		_ = ledger.Close()
		s.agentHarnessInitialization = err
		return err
	}
	s.agentLedger = ledger
	s.agentHarness = harness
	// Keep an already-running desktop owner synchronized when the standalone
	// CLI (or another process) edits the shared policy file.
	s.startAgentRunPolicyWatcher(ctx, filepath.Join(configDir, agentRunPolicyFileName), policySnapshot.Revision, policySnapshot.Runtime.PolicyWatchInterval)
	return nil
}

func (s *Service) agentHarnessForCall() (runharness.Harness, context.Context, error) {
	if s == nil {
		return nil, nil, errors.New("AI Service is nil")
	}
	ctx, err := s.agentRunLifecycleContext()
	if err != nil {
		return nil, nil, err
	}
	s.agentMu.RLock()
	harness := s.agentHarness
	initialized := s.agentHarnessInitialized
	initializationErr := s.agentHarnessInitialization
	shutdown := s.agentHarnessShutdown
	s.agentMu.RUnlock()
	if shutdown {
		return nil, nil, runharness.ErrHarnessClosed
	}
	if !initialized {
		if err := s.initializeAgentHarness(ctx); err != nil {
			return nil, nil, err
		}
		s.agentMu.RLock()
		harness = s.agentHarness
		initializationErr = s.agentHarnessInitialization
		shutdown = s.agentHarnessShutdown
		s.agentMu.RUnlock()
	}
	if shutdown {
		return nil, nil, runharness.ErrHarnessClosed
	}
	if initializationErr != nil {
		return nil, nil, initializationErr
	}
	if harness == nil {
		return nil, nil, errors.New("agent harness is unavailable")
	}
	if err := s.flushPendingWorkspaceSnapshots(ctx); err != nil {
		return nil, nil, err
	}
	return harness, ctx, nil
}

// agentRunLifecycleContext is intentionally narrower than
// agentLifecycleContext.  The latter remains a compatibility helper for the
// existing MCP extension methods, while every Agent Run Harness operation
// requires an application/CLI-owned lifecycle context.
func (s *Service) agentRunLifecycleContext() (context.Context, error) {
	if s == nil {
		return nil, errors.New("AI Service is nil")
	}
	s.agentMu.RLock()
	ctx := s.agentContext
	shutdown := s.agentHarnessShutdown
	s.agentMu.RUnlock()
	if shutdown {
		return nil, runharness.ErrHarnessClosed
	}
	if ctx == nil {
		return nil, ErrAgentLifecycleUnavailable
	}
	return ctx, nil
}

func (s *Service) agentLifecycleContext() context.Context {
	if s == nil {
		return context.Background()
	}
	s.agentMu.RLock()
	ctx := s.agentContext
	s.agentMu.RUnlock()
	if ctx == nil {
		return context.Background()
	}
	return ctx
}

func (s *Service) emitAgentRunEvent(event runharness.RunEvent) {
	ctx, err := s.agentRunLifecycleContext()
	if err != nil {
		return
	}
	uievents.Emit(ctx, runharness.EventName, event)
}

// shutdownAgentHarness fences the Service owner before waiting for workers.
// Detaching the pointers first prevents a worker's event callback from
// deadlocking on agentMu while shutdown waits for it to finish.
func (s *Service) detachAgentHarness() (*runharness.AgentRunHarness, *runharness.Ledger) {
	if s == nil {
		return nil, nil
	}
	// Stop the policy watcher before fencing the Harness pointer. Otherwise a
	// final poll could obtain the old pointer between detach and Close.
	s.stopAgentRunPolicyWatcher()
	s.agentMu.Lock()
	if s.agentHarnessShutdown {
		s.agentMu.Unlock()
		return nil, nil
	}
	s.agentHarnessShutdown = true
	harness := s.agentHarness
	ledger := s.agentLedger
	s.agentHarness = nil
	s.agentLedger = nil
	s.agentMu.Unlock()
	return harness, ledger
}

// shutdownAgentHarness is retained for narrow callers and tests.  The normal
// Service shutdown path uses detachAgentHarness so it can stop MCP before the
// Ledger is closed.
func (s *Service) shutdownAgentHarness() error {
	harness, ledger := s.detachAgentHarness()
	var result error
	if harness != nil {
		result = errors.Join(result, harness.Close())
	}
	if ledger != nil {
		result = errors.Join(result, ledger.Close())
	}
	return result
}

// cloneAgentProviderConfig keeps mutable slices/maps detached from the Service
// configuration and from provider implementations. In particular, headers
// often contain per-provider auth metadata and must not be shared with a
// settings edit that replaces the map in place.
func cloneAgentProviderConfig(config ai.ProviderConfig) ai.ProviderConfig {
	clone := config
	clone.Models = append([]string(nil), config.Models...)
	clone.DisabledModels = append([]string(nil), config.DisabledModels...)
	clone.CustomModels = append([]string(nil), config.CustomModels...)
	if config.Headers != nil {
		clone.Headers = make(map[string]string, len(config.Headers))
		for key, value := range config.Headers {
			clone.Headers[key] = value
		}
	}
	return clone
}

func (s *Service) resolveAgentProvider(ctx context.Context, request runharness.ModelTurnRequest) (provider.Provider, error) {
	if ctx == nil {
		return nil, ErrAgentLifecycleUnavailable
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if request.ProviderBinding == nil {
		return nil, runharness.ErrProviderBindingUnbound
	}
	binding, err := request.ProviderBinding.Validate()
	if err != nil {
		return nil, fmt.Errorf("%w: %v", runharness.ErrProviderBindingCorrupt, err)
	}
	if requestedID := strings.TrimSpace(request.Provider); requestedID == "" || !strings.EqualFold(requestedID, binding.ProviderID) {
		return nil, fmt.Errorf("%w: model request provider %q does not match binding %q", runharness.ErrProviderBindingCorrupt, request.Provider, binding.ProviderID)
	}
	var resolved ai.ProviderConfig
	if err := json.Unmarshal(binding.Config, &resolved); err != nil {
		return nil, fmt.Errorf("%w: decode provider config: %v", runharness.ErrProviderBindingCorrupt, err)
	}
	resolved.ID = strings.TrimSpace(resolved.ID)
	if resolved.ID == "" || resolved.ID != binding.ProviderID {
		return nil, fmt.Errorf("%w: provider config ID %q does not match binding %q", runharness.ErrProviderBindingCorrupt, resolved.ID, binding.ProviderID)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return provider.NewProvider(cloneAgentProviderConfig(resolved))
}

// resolveAgentImagePrompts preserves the localized image fallback behavior of
// the former chat entry points without coupling the shared Harness to Wails or
// the application's localization package. The Adapter invokes this once for
// each model turn, so an already-open session follows a user language change.
func (s *Service) resolveAgentImagePrompts(ctx context.Context, _ runharness.ModelTurnRequest) (runharness.ProviderImagePrompts, error) {
	if ctx == nil {
		return runharness.ProviderImagePrompts{}, ErrAgentLifecycleUnavailable
	}
	if err := ctx.Err(); err != nil {
		return runharness.ProviderImagePrompts{}, err
	}
	localizer := s.serviceLocalizerForLanguage()
	return runharness.ProviderImagePrompts{
		FallbackPrompt: serviceTextFromLocalizer(localizer, providerImageFallbackPromptKey, nil),
		OmittedNotice:  serviceTextFromLocalizer(localizer, providerImageOmittedNoticeKey, nil),
	}, nil
}

func agentLedgerKeyRef(configDir string) (string, error) {
	abs, err := filepath.Abs(strings.TrimSpace(configDir))
	if err != nil {
		return "", err
	}
	if resolved, evalErr := filepath.EvalSymlinks(abs); evalErr == nil {
		abs = resolved
	}
	clean := filepath.Clean(abs)
	digest := sha256.Sum256([]byte(clean))
	return secretstore.BuildRef("ai-ledger", hex.EncodeToString(digest[:]))
}

func (s *Service) agentPolicyPath() string {
	if s == nil {
		return filepath.Join(resolveConfigDir(), agentRunPolicyFileName)
	}
	s.agentMu.RLock()
	configDir := strings.TrimSpace(s.configDir)
	s.agentMu.RUnlock()
	if configDir == "" {
		configDir = resolveConfigDir()
	}
	return filepath.Join(configDir, agentRunPolicyFileName)
}

func loadServiceRunPolicy(path string) (runharness.RunPolicySnapshot, error) {
	snapshot := runharness.DefaultRunPolicySnapshot()
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return snapshot, nil
	}
	if err != nil {
		return runharness.RunPolicySnapshot{}, err
	}
	// Decode the wrapper discriminator explicitly. Falling back to a bare
	// policy after a wrapper decode error would silently ignore a malformed
	// `policy` field (for example, {"policy":"broken"}), causing desktop and
	// CLI callers to apply different defaults to the same file.
	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil || object == nil {
		if err == nil {
			err = errors.New("run policy must be a JSON object")
		}
		return runharness.RunPolicySnapshot{}, fmt.Errorf("decode run policy: %w", err)
	}
	if raw, wrapped := object["policy"]; wrapped {
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return runharness.RunPolicySnapshot{}, errors.New("decode run policy: policy must be an object")
		}
		var wrappedPolicy runharness.RunPolicy
		if err := json.Unmarshal(raw, &wrappedPolicy); err != nil {
			return runharness.RunPolicySnapshot{}, fmt.Errorf("decode run policy: %w", err)
		}
		snapshot.Policy = wrappedPolicy
		if raw, hasSchemaVersion := object["schemaVersion"]; hasSchemaVersion {
			if err := json.Unmarshal(raw, &snapshot.SchemaVersion); err != nil {
				return runharness.RunPolicySnapshot{}, fmt.Errorf("decode run policy schema version: %w", err)
			}
		}
		if raw, hasRevision := object["revision"]; hasRevision {
			if err := json.Unmarshal(raw, &snapshot.Revision); err != nil {
				return runharness.RunPolicySnapshot{}, fmt.Errorf("decode run policy revision: %w", err)
			}
		}
		if raw, hasRuntime := object["runtime"]; hasRuntime {
			if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
				return runharness.RunPolicySnapshot{}, errors.New("decode run policy: runtime must be an object")
			}
			if err := json.Unmarshal(raw, &snapshot.Runtime); err != nil {
				return runharness.RunPolicySnapshot{}, fmt.Errorf("decode run policy runtime: %w", err)
			}
		}
	} else if err := json.Unmarshal(data, &snapshot.Policy); err != nil {
		return runharness.RunPolicySnapshot{}, fmt.Errorf("decode run policy: %w", err)
	}
	snapshot = snapshot.Normalize()
	if err := snapshot.Validate(); err != nil {
		return runharness.RunPolicySnapshot{}, err
	}
	return snapshot, nil
}

func saveServiceRunPolicy(path string, snapshot runharness.RunPolicySnapshot) error {
	snapshot = snapshot.Normalize()
	if err := snapshot.Validate(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return err
	}
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".agent-policy-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	removeTemporary := true
	defer func() {
		if removeTemporary {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	removeTemporary = false
	return nil
}
