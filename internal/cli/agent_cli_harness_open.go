package cli

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/ai/runharness"
	aiservice "GoNavi-Wails/internal/ai/service"
	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/mcpserver"

	"github.com/google/uuid"
)

func defaultAgentHarnessFactory(ctx context.Context, options AgentHarnessOptions) (AgentHarnessRuntime, error) {
	if ctx == nil {
		return nil, runharness.ErrRootContextRequired
	}
	root := strings.TrimSpace(options.DataRoot)
	var err error
	if root == "" {
		root, err = appdata.ResolveActiveRoot()
	} else {
		root, err = appdata.ResolveRoot(root)
	}
	if err != nil {
		return nil, err
	}
	agentDataRoot, err := appdata.ResolveAgentDataDirectory(root)
	if err != nil {
		return nil, err
	}
	runtimeConfig := options.Runtime.Normalize()
	if err := runtimeConfig.Validate(); err != nil {
		return nil, fmt.Errorf("validate agent runtime configuration: %w", err)
	}
	ledgerPath := strings.TrimSpace(options.LedgerPath)
	if ledgerPath == "" {
		ledgerPath = filepath.Join(agentDataRoot, "agent_runs.sqlite")
	} else if ledgerPath != ":memory:" && !strings.HasPrefix(ledgerPath, "file:") && !filepath.IsAbs(ledgerPath) {
		// CLI invocations share the active data root. Resolve a relative
		// --ledger path there so desktop and CLI callers do not accidentally
		// create separate ledgers based on their current working directory.
		ledgerPath = filepath.Join(agentDataRoot, ledgerPath)
	}
	ledgerOptions, err := agentLedgerOptions(agentDataRoot, options.KeyFile, nil)
	if err != nil {
		return nil, err
	}
	ledgerOptions = append(ledgerOptions, runharness.WithWorkspaceSnapshotLeaseDuration(runtimeConfig.WorkspaceSnapshotLeaseDuration))
	ledger, err := runharness.Open(ledgerPath, ledgerOptions...)
	if err != nil {
		return nil, err
	}
	backend, err := mcpserver.NewAppBackendWithDataRoot(ctx, root)
	if err != nil {
		_ = closeAgentRuntimeResources(ctx, agentRuntimeResources{closeLedger: ledger.Close})
		return nil, fmt.Errorf("initialize agent database backend: %w", err)
	}
	mcpService, err := aiservice.NewMCPService(ctx, root)
	if err != nil {
		_ = closeAgentRuntimeResources(ctx, agentRuntimeResources{
			closeBackend: backend.Close,
			closeLedger:  ledger.Close,
		})
		return nil, fmt.Errorf("initialize agent MCP tools: %w", err)
	}
	providerResolver := newCLIProviderResolverState(root)
	model := runharness.NewProviderModelTurnAdapter(providerResolver.resolve)
	config := runharness.HarnessConfig{
		Ledger: ledger,
		Model:  model,
		InputBinder: func(_ context.Context, request *runharness.AgentInputRequest) error {
			return providerResolver.bindInput(request)
		},
		Tools:                          newCLIAgentToolCatalog(backend, mcpService),
		Approvals:                      newCLIAgentApprovalHandler(),
		RootContext:                    ctx,
		OwnerID:                        "gonavi-cli-" + uuid.NewString(),
		PollInterval:                   runtimeConfig.ControlPollInterval,
		WorkspaceSnapshotLeaseDuration: runtimeConfig.WorkspaceSnapshotLeaseDuration,
		WorkspaceSnapshotRenewInterval: runtimeConfig.WorkspaceSnapshotRenewInterval,
	}
	harness, err := runharness.NewAgentRunHarness(config)
	if err != nil {
		_ = closeAgentRuntimeResources(ctx, agentRuntimeResources{
			shutdownMCP:  func(ctx context.Context) { aiservice.ShutdownWithContext(mcpService, ctx) },
			closeBackend: backend.Close,
			closeLedger:  ledger.Close,
		})
		return nil, err
	}
	if policy := options.Policy.Normalize(); policy != (runharness.RunPolicy{}) {
		if err := harness.SetDefaultPolicy(policy); err != nil {
			_ = closeAgentRuntimeResources(ctx, agentRuntimeResources{
				closeHarness: harness.Close,
				shutdownMCP:  func(ctx context.Context) { aiservice.ShutdownWithContext(mcpService, ctx) },
				closeBackend: backend.Close,
				closeLedger:  ledger.Close,
			})
			return nil, err
		}
	}
	if options.StartWorkers {
		if err := harness.Start(ctx); err != nil {
			_ = closeAgentRuntimeResources(ctx, agentRuntimeResources{
				closeHarness: harness.Close,
				shutdownMCP:  func(ctx context.Context) { aiservice.ShutdownWithContext(mcpService, ctx) },
				closeBackend: backend.Close,
				closeLedger:  ledger.Close,
			})
			return nil, err
		}
	}
	return &ledgerHarnessRuntime{harness: harness, ledger: ledger, backend: backend, mcp: mcpService, providerResolver: providerResolver, lifecycle: ctx}, nil
}

// agentLedgerOptions keeps standalone CLI invocations on the exact same local
// data-root-scoped key file as the desktop Service. A supplied key file is an
// explicit portable-key override.
func agentLedgerOptions(dataRoot, keyFile string, store agentLedgerKeyringStore) ([]runharness.LedgerOption, error) {
	if keyFile = strings.TrimSpace(keyFile); keyFile != "" {
		return []runharness.LedgerOption{runharness.WithKeyFile(keyFile)}, nil
	}
	keyPath, err := aiservice.AgentLedgerKeyFilePath(dataRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve agent ledger key: %w", err)
	}
	return []runharness.LedgerOption{runharness.WithKeyFile(keyPath)}, nil
}

func openAgentHarness(ctx context.Context, common agentCommonFlags, policy runharness.RunPolicy) (AgentHarnessRuntime, error) {
	runtime, _, err := openAgentHarnessWithRuntime(ctx, common, policy, true)
	return runtime, err
}

// openAgentHarnessReadOnly opens the ledger without claiming queued runs.
// Read-only inspection, workspace publication, and control-plane commands
// must not briefly become an owner and then start or cancel unrelated work
// when the command exits.
func openAgentHarnessReadOnly(ctx context.Context, common agentCommonFlags) (AgentHarnessRuntime, error) {
	runtime, _, err := openAgentHarnessWithRuntime(ctx, common, runharness.RunPolicy{}, false)
	return runtime, err
}

// openAgentHarnessWithRuntime loads the durable process-coordination settings
// alongside the policy. Per-run policy overrides intentionally do not alter
// these process settings: an invocation must not silently change another
// desktop or CLI owner's cadence by passing --policy.
func openAgentHarnessWithRuntime(ctx context.Context, common agentCommonFlags, policy runharness.RunPolicy, startWorkers bool) (AgentHarnessRuntime, runharness.RunRuntimeConfig, error) {
	// Every Agent operation, including read-only/control commands, is owned by
	// the caller's application or CLI lifecycle.  Check this before resolving
	// files or invoking an injected factory so an embedding cannot accidentally
	// construct a harness whose workers outlive the process that requested it.
	if ctx == nil {
		return nil, runharness.RunRuntimeConfig{}, runharness.ErrRootContextRequired
	}
	root, err := appdata.ResolveActiveRoot()
	if err != nil {
		return nil, runharness.RunRuntimeConfig{}, err
	}
	snapshot, loadErr := loadAgentPolicy(filepath.Join(root, "agent_run_policy.json"))
	if loadErr != nil {
		return nil, runharness.RunRuntimeConfig{}, loadErr
	}
	if policy == (runharness.RunPolicy{}) {
		policy = snapshot.Policy
	}
	runtimeConfig := snapshot.Runtime.Normalize()
	if err := runtimeConfig.Validate(); err != nil {
		return nil, runharness.RunRuntimeConfig{}, err
	}
	options := AgentHarnessOptions{
		DataRoot: root, LedgerPath: common.ledger, KeyFile: common.keyFile,
		Policy: policy, Runtime: runtimeConfig, StartWorkers: startWorkers,
	}
	runtime, err := newAgentHarness(ctx, options)
	if err != nil {
		return nil, runharness.RunRuntimeConfig{}, err
	}
	return runtime, runtimeConfig, nil
}

// loadAgentCommandPolicy resolves an optional policy file and applies
// per-invocation overrides without mutating the persisted default. A zero
// result intentionally means "use the harness owner's default policy".
func loadAgentCommandPolicy(policyFile, overrides string) (runharness.RunPolicy, error) {
	policyFile = strings.TrimSpace(policyFile)
	overrides = strings.TrimSpace(overrides)
	if policyFile == "" && overrides == "" {
		return runharness.RunPolicy{}, nil
	}
	root, err := appdata.ResolveActiveRoot()
	if err != nil {
		return runharness.RunPolicy{}, err
	}
	if policyFile == "" {
		policyFile = filepath.Join(root, "agent_run_policy.json")
	}
	snapshot, err := loadAgentPolicy(policyFile)
	if err != nil {
		return runharness.RunPolicy{}, err
	}
	policy := snapshot.Policy
	if overrides != "" {
		if err := applyAgentPolicyOverrides(&policy, overrides); err != nil {
			return runharness.RunPolicy{}, err
		}
	}
	return policy, nil
}
