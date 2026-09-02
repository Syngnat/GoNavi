package cli

// The agent CLI is deliberately an adapter around runharness.Harness.  It
// owns argument parsing and presentation only; scheduling, tool execution,
// approvals, cancellation and persistence stay in the harness package.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"GoNavi-Wails/internal/ai/runharness"
	aiservice "GoNavi-Wails/internal/ai/service"
	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/mcpserver"

	"github.com/google/uuid"
)

// AgentHarness is the only run-facing interface used by this adapter.  Keep
// the embedding explicit so a desktop and a CLI adapter can share the exact
// same implementation without reintroducing a second agent loop.
type AgentHarness interface {
	runharness.Harness
}

var errAgentPolicyOverride = errors.New("invalid agent run policy override")

// AgentHarnessRuntime adds lifecycle ownership to AgentHarness.  The default
// factory owns the ledger it opens; injected test/desktop factories may choose
// a different ownership model as long as Close is idempotent.
type AgentHarnessRuntime interface {
	AgentHarness
	Close() error
}

// agentRuntimeLifetime keeps command-level waiting separate from the owner
// lifetime managed by the harness. A CLI command may return while a durable
// run is still queued or executing (for example with --no-wait or a short
// --timeout). Calling AgentHarnessRuntime.Close in that case would cancel all
// local owner workers and turn a successful durable acceptance into a
// cancellation. Detached runtimes are instead left alive until the caller's
// lifecycle context ends; a one-shot CLI process naturally releases them when
// it exits, and a long-lived embedding can still shut them down explicitly.
type agentRuntimeLifetime struct {
	runtime AgentHarnessRuntime
	parent  context.Context

	detached      atomic.Bool
	detachStarted atomic.Bool
	closed        atomic.Bool
}

func newAgentRuntimeLifetime(runtime AgentHarnessRuntime, parent context.Context) *agentRuntimeLifetime {
	return &agentRuntimeLifetime{runtime: runtime, parent: parent}
}

// Detach prevents the command return path from invoking Close. It is
// idempotent so callers can mark every non-terminal outcome conservatively.
func (lifetime *agentRuntimeLifetime) Detach() {
	if lifetime == nil || lifetime.parent == nil || lifetime.detached.Swap(true) {
		return
	}
	// Keep a detached runtime tied to the application/CLI lifecycle. A nil
	// parent is deliberately not replaced with a rootless context: callers
	// must give Agent runs a real owner lifecycle, and the default factory
	// rejects a missing root context before it can construct a runtime.
	if done := lifetime.parent.Done(); done != nil && lifetime.detachStarted.CompareAndSwap(false, true) {
		go func() {
			<-done
			lifetime.closeUnderlying()
		}()
	}
}

func (lifetime *agentRuntimeLifetime) closeUnderlying() {
	if lifetime == nil || lifetime.runtime == nil || lifetime.closed.Swap(true) {
		return
	}
	_ = lifetime.runtime.Close()
}

// Close is used by a command defer. Detached runtimes deliberately do not
// close here; their parent lifecycle callback (or process exit) owns cleanup.
func (lifetime *agentRuntimeLifetime) Close() {
	if lifetime == nil || lifetime.detached.Load() {
		return
	}
	lifetime.closeUnderlying()
}

func detachAgentRuntimeIfActive(lifetime *agentRuntimeLifetime, state runharness.RunState) {
	if lifetime == nil || state.Terminal() {
		return
	}
	lifetime.Detach()
}

// detachAgentRuntimeIfStillActive prefers the durable state observed while
// waiting, but falls back to the submission/control receipt when a timeout or
// transport failure occurs before the first ReadRun projection. In that case
// closing the local runtime is unsafe: the accepted run may still be active
// even though this particular CLI invocation could not observe it.
func detachAgentRuntimeIfStillActive(lifetime *agentRuntimeLifetime, observed, fallback runharness.RunState) {
	if observed == "" {
		observed = fallback
	}
	detachAgentRuntimeIfActive(lifetime, observed)
}

// detachAgentCommandResources keeps a command-scoped adapter from shutting
// down a durable owner when the command cannot prove that no work was
// accepted.  This is intentionally conservative: an EOF, scanner failure, or
// post-commit transport error may happen after another queued run has already
// been recovered by the same harness instance.  The parent lifecycle still
// owns eventual cleanup through agentRuntimeLifetime.Detach.
func detachAgentCommandResources(lifetime *agentRuntimeLifetime, renewal *agentWorkspaceSnapshotRenewal) {
	if lifetime != nil {
		lifetime.Detach()
	}
	if renewal != nil {
		renewal.Detach()
	}
}

func detachAgentWorkspaceSnapshotRenewalIfActive(renewal *agentWorkspaceSnapshotRenewal, state runharness.RunState) {
	if renewal == nil || state.Terminal() {
		return
	}
	renewal.Detach()
}

func detachAgentWorkspaceSnapshotRenewalIfStillActive(renewal *agentWorkspaceSnapshotRenewal, observed, fallback runharness.RunState) {
	if observed == "" {
		observed = fallback
	}
	detachAgentWorkspaceSnapshotRenewalIfActive(renewal, observed)
}

// AgentHarnessOptions are intentionally limited to adapter concerns.  Model,
// tool and approval wiring belongs to the harness owner and can be supplied by
// a registered factory.
type AgentHarnessOptions struct {
	DataRoot     string
	LedgerPath   string
	KeyFile      string
	Policy       runharness.RunPolicy
	Runtime      runharness.RunRuntimeConfig
	StartWorkers bool
}

// AgentHarnessFactory permits the desktop application to register its shared
// harness while keeping the standalone CLI usable in headless mode.  The
// returned restore function is useful for tests and process-local embedding.
type AgentHarnessFactory func(context.Context, AgentHarnessOptions) (AgentHarnessRuntime, error)

type agentLedgerKeyringStore interface {
	Put(string, []byte) error
	Get(string) ([]byte, error)
	Delete(string) error
	HealthCheck() error
}

var (
	newAgentHarness AgentHarnessFactory = defaultAgentHarnessFactory

	// agentStdin is a variable rather than a direct os.Stdin reference so CLI
	// tests and embedders can provide an interactive stream without a process
	// global replacement.
	agentStdin   io.Reader = os.Stdin
	agentStdinMu sync.RWMutex
)

// SetAgentHarnessFactory installs the shared harness factory for this process.
// Passing nil restores the encrypted-Ledger default factory.
func SetAgentHarnessFactory(factory AgentHarnessFactory) func() {
	previous := newAgentHarness
	if factory == nil {
		newAgentHarness = defaultAgentHarnessFactory
	} else {
		newAgentHarness = factory
	}
	return func() { newAgentHarness = previous }
}

// SetAgentCLIInput replaces the reader used by agent chat.  It is primarily
// intended for embedders and tests; the returned function restores the prior
// reader.
func SetAgentCLIInput(reader io.Reader) func() {
	agentStdinMu.Lock()
	previous := agentStdin
	if reader == nil {
		agentStdin = os.Stdin
	} else {
		agentStdin = reader
	}
	agentStdinMu.Unlock()
	return func() {
		agentStdinMu.Lock()
		agentStdin = previous
		agentStdinMu.Unlock()
	}
}

func currentAgentStdin() io.Reader {
	agentStdinMu.RLock()
	defer agentStdinMu.RUnlock()
	return agentStdin
}

type ledgerHarnessRuntime struct {
	harness          *runharness.AgentRunHarness
	ledger           *runharness.Ledger
	backend          *mcpserver.AppBackend
	mcp              *aiservice.Service
	providerResolver *cliProviderResolver
	lifecycle        context.Context
	once             sync.Once
	err              error
}

const agentRuntimeShutdownTimeout = 10 * time.Second

type agentRuntimeResources struct {
	closeHarness func() error
	shutdownMCP  func(context.Context)
	closeBackend func(context.Context) error
	closeLedger  func() error
}

// agentRuntimeShutdownContext preserves lifecycle values but deliberately
// ignores cancellation long enough for shutdown to finish its durable
// checkpoint/ledger sequence. A missing lifecycle is a programming error; do
// not silently manufacture a detached context for an Agent run.
func agentRuntimeShutdownContext(lifecycle context.Context) (context.Context, context.CancelFunc) {
	if lifecycle == nil {
		return nil, func() {}
	}
	return context.WithTimeout(context.WithoutCancel(lifecycle), agentRuntimeShutdownTimeout)
}

// closeAgentRuntimeResources has one authoritative shutdown order for both
// normal runtime close and every factory rollback. The ledger remains open
// until owner workers, MCP, and the headless database backend have stopped.
func closeAgentRuntimeResources(lifecycle context.Context, resources agentRuntimeResources) error {
	var result error
	if resources.closeHarness != nil {
		result = errors.Join(result, resources.closeHarness())
	}

	shutdownCtx, cancel := agentRuntimeShutdownContext(lifecycle)
	defer cancel()
	if resources.shutdownMCP != nil {
		resources.shutdownMCP(shutdownCtx)
	}
	if resources.closeBackend != nil {
		result = errors.Join(result, resources.closeBackend(shutdownCtx))
	}
	if resources.closeLedger != nil {
		result = errors.Join(result, resources.closeLedger())
	}
	return result
}

func (r *ledgerHarnessRuntime) Close() error {
	if r == nil {
		return nil
	}
	r.once.Do(func() {
		resources := agentRuntimeResources{}
		if r.harness != nil {
			resources.closeHarness = r.harness.Close
		}
		if r.mcp != nil {
			resources.shutdownMCP = func(ctx context.Context) { aiservice.ShutdownWithContext(r.mcp, ctx) }
		}
		if r.backend != nil {
			resources.closeBackend = r.backend.Close
		}
		if r.ledger != nil {
			resources.closeLedger = r.ledger.Close
		}
		r.err = closeAgentRuntimeResources(r.lifecycle, resources)
	})
	return r.err
}

// Forward the public harness interface to the concrete implementation.  A
// small wrapper keeps Close ownership separate from the shared interface.
func (r *ledgerHarnessRuntime) SubmitInput(ctx context.Context, request runharness.AgentInputRequest) (runharness.AgentInputReceipt, error) {
	if r == nil || r.harness == nil {
		return runharness.AgentInputReceipt{}, errors.New("agent runtime is unavailable")
	}
	return r.harness.SubmitInput(ctx, request)
}
func (r *ledgerHarnessRuntime) ControlRun(ctx context.Context, request runharness.RunControlRequest) (runharness.RunSnapshot, error) {
	return r.harness.ControlRun(ctx, request)
}
func (r *ledgerHarnessRuntime) ReadRun(ctx context.Context, request runharness.RunReadRequest) (runharness.RunReadResult, error) {
	return r.harness.ReadRun(ctx, request)
}
func (r *ledgerHarnessRuntime) ListSessions(ctx context.Context, request runharness.SessionListRequest) (runharness.SessionListResult, error) {
	return r.harness.ListSessions(ctx, request)
}
func (r *ledgerHarnessRuntime) ReadSession(ctx context.Context, request runharness.SessionReadRequest) (runharness.SessionProjection, error) {
	return r.harness.ReadSession(ctx, request)
}
func (r *ledgerHarnessRuntime) MutateSession(ctx context.Context, request runharness.SessionMutationRequest) (runharness.SessionProjection, error) {
	return r.harness.MutateSession(ctx, request)
}
func (r *ledgerHarnessRuntime) PutWorkspaceSnapshot(ctx context.Context, snapshot runharness.WorkspaceSnapshot) (runharness.SnapshotAck, error) {
	return r.harness.PutWorkspaceSnapshot(ctx, snapshot)
}

var _ AgentHarnessRuntime = (*ledgerHarnessRuntime)(nil)

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
	runtimeConfig := options.Runtime.Normalize()
	if err := runtimeConfig.Validate(); err != nil {
		return nil, fmt.Errorf("validate agent runtime configuration: %w", err)
	}
	ledgerPath := strings.TrimSpace(options.LedgerPath)
	if ledgerPath == "" {
		ledgerPath = filepath.Join(root, "agent_runs.sqlite")
	} else if ledgerPath != ":memory:" && !strings.HasPrefix(ledgerPath, "file:") && !filepath.IsAbs(ledgerPath) {
		// CLI invocations share the active data root. Resolve a relative
		// --ledger path there so desktop and CLI callers do not accidentally
		// create separate ledgers based on their current working directory.
		ledgerPath = filepath.Join(root, ledgerPath)
	}
	ledgerOptions, err := agentLedgerOptions(root, options.KeyFile, nil)
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

// agentLedgerOptions keeps standalone CLI invocations on the exact same
// data-root-scoped keyring entry as the desktop Service. A supplied key file is
// an explicit portable-key override and therefore intentionally bypasses the
// OS keyring.
func agentLedgerOptions(dataRoot, keyFile string, store agentLedgerKeyringStore) ([]runharness.LedgerOption, error) {
	if keyFile = strings.TrimSpace(keyFile); keyFile != "" {
		return []runharness.LedgerOption{runharness.WithKeyFile(keyFile)}, nil
	}
	keyRef, err := aiservice.AgentLedgerKeyRef(dataRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve agent ledger key: %w", err)
	}
	return []runharness.LedgerOption{runharness.WithKeyring(keyRef, store)}, nil
}

type agentOutputMode uint8

const (
	agentOutputAuto agentOutputMode = iota
	agentOutputHuman
	agentOutputJSON
	agentOutputJSONL
)

func (m agentOutputMode) jsonl(stdout io.Writer) bool {
	if m == agentOutputJSONL || m == agentOutputJSON {
		return true
	}
	if m == agentOutputHuman {
		return false
	}
	return !writerIsTTY(stdout)
}

func writerIsTTY(writer io.Writer) bool {
	file, ok := writer.(*os.File)
	if !ok || file == nil {
		return false
	}
	info, err := file.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

func parseAgentOutputMode(fs *flag.FlagSet, stdout io.Writer, jsonFlag, jsonlFlag, humanFlag bool) (agentOutputMode, error) {
	selected := 0
	if jsonFlag {
		selected++
	}
	if jsonlFlag {
		selected++
	}
	if humanFlag {
		selected++
	}
	if selected > 1 {
		return agentOutputAuto, errors.New("use only one of --json, --jsonl, or --human")
	}
	switch {
	case jsonlFlag:
		return agentOutputJSONL, nil
	case jsonFlag:
		return agentOutputJSON, nil
	case humanFlag:
		return agentOutputHuman, nil
	default:
		if writerIsTTY(stdout) {
			return agentOutputHuman, nil
		}
		return agentOutputJSONL, nil
	}
}

func runAgent(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer) int {
	if len(args) == 0 {
		writeAgentUsage(stdout)
		return ExitSuccess
	}
	subcommand := strings.ToLower(strings.TrimSpace(args[0]))
	subargs := args[1:]
	switch subcommand {
	case "run":
		return runAgentRun(ctx, subargs, stdout, stderr)
	case "chat":
		return runAgentChat(ctx, subargs, stdout, stderr)
	case "list":
		return runAgentList(ctx, subargs, stdout, stderr)
	case "show":
		return runAgentShow(ctx, subargs, stdout, stderr)
	case "resume", "cancel":
		return runAgentControl(ctx, subcommand, subargs, stdout, stderr)
	case "approve", "deny":
		return runAgentApproval(ctx, subcommand, subargs, stdout, stderr)
	case "recover":
		return runAgentRecover(ctx, subargs, stdout, stderr)
	case "config":
		return runAgentConfig(ctx, subargs, stdout, stderr)
	case "snapshot", "workspace":
		return runAgentSnapshot(ctx, subargs, stdout, stderr)
	case "help", "--help", "-h":
		writeAgentUsage(stdout)
		return ExitSuccess
	default:
		return fail(stderr, ExitUsage, "usage", fmt.Errorf("unknown agent command %q", args[0]))
	}
}

type agentCommonFlags struct {
	keyFile   string
	ledger    string
	output    agentOutputMode
	jsonFlag  bool
	jsonlFlag bool
	humanFlag bool
}

func bindAgentCommonFlags(fs *flag.FlagSet, common *agentCommonFlags) {
	fs.StringVar(&common.keyFile, "ledger-key-file", "", "0600 file containing the ledger encryption key")
	fs.StringVar(&common.keyFile, "key-file", "", "alias for --ledger-key-file")
	fs.StringVar(&common.ledger, "ledger", "", "agent ledger SQLite path")
	fs.BoolVar(&common.jsonFlag, "json", false, "emit one JSON result")
	fs.BoolVar(&common.jsonlFlag, "jsonl", false, "emit JSONL events")
	fs.BoolVar(&common.humanFlag, "human", false, "emit human-readable output")
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

func requestID() string { return uuid.NewString() }

func normalizedAgentRequestID(value string) string {
	if value = strings.TrimSpace(value); value != "" {
		return value
	}
	return requestID()
}

// parseAgentFlags keeps the standard flag package while accepting the usual
// CLI form where a positional RUN_ID or prompt appears before options. Go's
// flag parser stops at the first positional argument, so move positional
// values behind the flags before parsing. Values belonging to non-boolean
// flags are kept with their flag and are never mistaken for positionals.
func parseAgentFlags(fs *flag.FlagSet, args []string) error {
	if fs == nil {
		return errors.New("agent flag set is nil")
	}
	flags := make([]string, 0, len(args))
	positionals := make([]string, 0, len(args))
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if arg == "--" {
			positionals = append(positionals, args[index+1:]...)
			break
		}
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			positionals = append(positionals, arg)
			continue
		}
		flags = append(flags, arg)
		if strings.Contains(arg, "=") {
			continue
		}
		name := strings.TrimLeft(arg, "-")
		definition := fs.Lookup(name)
		if definition == nil {
			continue
		}
		if boolean, ok := definition.Value.(interface{ IsBoolFlag() bool }); ok && boolean.IsBoolFlag() {
			continue
		}
		if index+1 < len(args) {
			index++
			flags = append(flags, args[index])
		}
	}
	ordered := append(flags, positionals...)
	return fs.Parse(ordered)
}

// agentPollInterval resolves the wait-loop cadence from the command flag and
// then the shared runtime configuration. A positive explicit value wins; a
// zero value is the sentinel used by CLI flags whose default comes from
// agent_run_policy.json.
func agentPollInterval(fs *flag.FlagSet, explicit time.Duration, runtimeConfig runharness.RunRuntimeConfig) time.Duration {
	if explicit > 0 && (fs == nil || visitedFlags(fs)["poll"]) {
		return explicit
	}
	return runtimeConfig.Normalize().ControlPollInterval
}

func agentPollFlagInvalid(fs *flag.FlagSet, explicit time.Duration) bool {
	return visitedFlags(fs)["poll"] && explicit <= 0
}

func runAgentRun(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer) int {
	fs := newFlagSet("agent run")
	var common agentCommonFlags
	bindAgentCommonFlags(fs, &common)
	sessionID := fs.String("session", "", "session ID")
	requestIDFlag := fs.String("request-id", "", "idempotency key")
	expectedRevision := fs.Int64("expected-revision", 0, "expected session revision")
	prompt := fs.String("prompt", "", "prompt text")
	promptFile := fs.String("prompt-file", "", "read prompt from a file")
	useStdin := fs.Bool("stdin", false, "read prompt from stdin")
	provider := fs.String("provider", "", "provider override")
	model := fs.String("model", "", "model override")
	thinking := fs.String("thinking", "", "thinking level override")
	temperature := fs.Float64("temperature", 0, "temperature override")
	maxTokens := fs.Int("max-tokens", 0, "maximum output tokens override")
	dispatch := fs.String("dispatch", "", "queue or steer")
	fs.StringVar(dispatch, "dispatch-mode", "", "alias for --dispatch")
	contextSource := fs.String("context-source", "", "workspace snapshot source ID")
	contextFile := fs.String("context-file", "", "complete WorkspaceSnapshot JSON file")
	policyFile := fs.String("policy-file", "", "RunPolicy JSON file for this run")
	policyOverrides := fs.String("policy", "", "comma-separated RunPolicy key=value overrides for this run")
	fs.StringVar(policyOverrides, "run-policy", "", "alias for --policy")
	wait := fs.Bool("wait", true, "wait for the run to reach a terminal/action-required state")
	noWait := fs.Bool("no-wait", false, "return after durable acceptance")
	timeout := fs.Duration("timeout", 0, "maximum command wait duration")
	poll := fs.Duration("poll", 0, "run event polling interval (defaults to runtime configuration)")
	help := fs.Bool("help", false, "show help")
	if err := parseAgentFlags(fs, args); err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	if *help {
		writeAgentRunUsage(stdout)
		return ExitSuccess
	}
	if *noWait {
		*wait = false
	}
	if agentPollFlagInvalid(fs, *poll) {
		return fail(stderr, ExitUsage, "usage", errors.New("--poll must be positive"))
	}
	if *timeout < 0 {
		return fail(stderr, ExitUsage, "usage", errors.New("--timeout must not be negative"))
	}
	if *expectedRevision < 0 {
		return fail(stderr, ExitUsage, "usage", errors.New("--expected-revision must not be negative"))
	}
	if *temperature < 0 {
		return fail(stderr, ExitUsage, "usage", errors.New("--temperature must not be negative"))
	}
	if *maxTokens < 0 {
		return fail(stderr, ExitUsage, "usage", errors.New("--max-tokens must not be negative"))
	}
	mode, err := parseAgentOutputMode(fs, stdout, common.jsonFlag, common.jsonlFlag, common.humanFlag)
	if err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	content, err := resolveAgentPrompt(*prompt, *promptFile, *useStdin, fs.Args())
	if err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	dispatchMode, err := parseDispatchMode(*dispatch)
	if err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	policy, err := loadAgentCommandPolicy(*policyFile, *policyOverrides)
	if err != nil {
		return failAgentError(stderr, err)
	}
	// A queue submission targeting an existing session must carry the current
	// session projection revision.  Resolve it here when the caller did not
	// provide one; the harness then performs the actual atomic CAS alongside
	// run creation.  Steer revisions belong to the active run, so never reuse a
	// session revision for that distinct control path.
	effectiveDispatchMode := dispatchMode
	if effectiveDispatchMode == "" {
		effectiveDispatchMode = policy.Normalize().DefaultDispatchMode
	}
	commandCtx, cancel, err := agentCommandContext(ctx, *timeout)
	if err != nil {
		return failAgentError(stderr, err)
	}
	defer cancel()
	// The command context bounds this invocation's wait only. The harness
	// receives the parent lifecycle context so a short --timeout cannot cancel
	// a durable queued/working run.
	runtime, runtimeConfig, err := openAgentHarnessWithRuntime(ctx, common, policy, true)
	if err != nil {
		return failAgentError(stderr, err)
	}
	lifetime := newAgentRuntimeLifetime(runtime, ctx)
	defer lifetime.Close()
	// A command timeout only bounds how long this invocation waits for a
	// projection. Durable writes must use the parent lifecycle context so an
	// expiry cannot leave a partially accepted input or snapshot behind.
	binding, err := putAgentWorkspaceSnapshot(ctx, runtime, *contextFile, *contextSource, "gonavi agent run")
	if err != nil {
		// The runtime may already have recovered another durable run while the
		// requested snapshot was being decoded/published. Do not close it on an
		// error whose effect cannot be established from this adapter call.
		lifetime.Detach()
		return fail(stderr, ExitUsage, "context_invalid", err)
	}
	if strings.TrimSpace(*sessionID) != "" && effectiveDispatchMode == runharness.DispatchQueue && *expectedRevision == 0 {
		projection, readErr := runtime.ReadSession(ctx, runharness.SessionReadRequest{SessionID: strings.TrimSpace(*sessionID)})
		if readErr != nil {
			// The runtime may already own/recover another durable run. A failed
			// projection read does not establish that those workers are idle, so
			// preserve the owner instead of closing it from this command's defer.
			lifetime.Detach()
			return failAgentError(stderr, fmt.Errorf("read session revision: %w", readErr))
		}
		if projection.Revision <= 0 {
			lifetime.Detach()
			return failAgentError(stderr, fmt.Errorf("read session revision: invalid revision %d for session %q", projection.Revision, projection.ID))
		}
		*expectedRevision = projection.Revision
	}
	renewal := startAgentWorkspaceSnapshotRenewal(ctx, runtime, binding, runtimeConfig.WorkspaceSnapshotRenewInterval)
	defer renewal.Close()
	request := runharness.AgentInputRequest{
		RequestID: normalizedAgentRequestID(*requestIDFlag), SessionID: strings.TrimSpace(*sessionID), Content: content,
		DispatchMode: dispatchMode, ContextSourceID: binding.SourceID, ContextSourceInstanceID: binding.SourceInstanceID,
		Provider: strings.TrimSpace(*provider), Model: strings.TrimSpace(*model), Thinking: strings.TrimSpace(*thinking),
		ExpectedRevision: *expectedRevision,
	}
	visited := visitedFlags(fs)
	if visited["temperature"] {
		request.Temperature = temperature
	}
	if visited["max-tokens"] {
		request.MaxTokens = maxTokens
	}
	receipt, err := runtime.SubmitInput(ctx, request)
	if err != nil {
		// SubmitInput is a durable idempotent boundary. A transport/database
		// error can be returned after the run has been committed, so closing the
		// owner here could cancel an accepted run. Keep it alive until the parent
		// lifecycle ends; callers can inspect the request ID to reconcile it.
		detachAgentCommandResources(lifetime, renewal)
		return failAgentError(stderr, err)
	}
	if mode == agentOutputJSON {
		// Aggregate JSON is emitted once the run has been read to a stable
		// state.  For --no-wait the receipt is the only available projection.
		if !*wait {
			if code := emitOutput(stdout, stderr, receipt); code != ExitSuccess {
				return code
			}
		}
	} else if mode == agentOutputHuman {
		writeAgentReceipt(stdout, receipt)
	}
	if !*wait {
		detachAgentRuntimeIfActive(lifetime, receipt.State)
		detachAgentWorkspaceSnapshotRenewalIfActive(renewal, receipt.State)
		return exitCodeForRunState(receipt.State)
	}
	code, state := waitForAgentRunOptionsState(commandCtx, runtime, receipt.RunID, mode, agentPollInterval(fs, *poll, runtimeConfig), stdout, stderr, false)
	detachAgentRuntimeIfStillActive(lifetime, state, receipt.State)
	detachAgentWorkspaceSnapshotRenewalIfStillActive(renewal, state, receipt.State)
	return code
}

func runAgentChat(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer) int {
	fs := newFlagSet("agent chat")
	var common agentCommonFlags
	bindAgentCommonFlags(fs, &common)
	sessionID := fs.String("session", "", "session ID")
	requestIDFlag := fs.String("request-id", "", "idempotency key for the first input")
	expectedRevision := fs.Int64("expected-revision", 0, "expected session revision for the first input")
	prompt := fs.String("prompt", "", "send one prompt instead of reading lines")
	provider := fs.String("provider", "", "provider override")
	model := fs.String("model", "", "model override")
	thinking := fs.String("thinking", "", "thinking level override")
	temperature := fs.Float64("temperature", 0, "temperature override")
	maxTokens := fs.Int("max-tokens", 0, "maximum output tokens override")
	dispatch := fs.String("dispatch", "", "queue or steer")
	fs.StringVar(dispatch, "dispatch-mode", "", "alias for --dispatch")
	contextSource := fs.String("context-source", "", "workspace snapshot source ID")
	contextFile := fs.String("context-file", "", "complete WorkspaceSnapshot JSON file")
	policyFile := fs.String("policy-file", "", "RunPolicy JSON file for this command")
	policyOverrides := fs.String("policy", "", "comma-separated RunPolicy key=value overrides for this command")
	fs.StringVar(policyOverrides, "run-policy", "", "alias for --policy")
	timeout := fs.Duration("timeout", 0, "maximum command duration")
	poll := fs.Duration("poll", 0, "run event polling interval (defaults to runtime configuration)")
	help := fs.Bool("help", false, "show help")
	if err := parseAgentFlags(fs, args); err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	if *help {
		writeAgentChatUsage(stdout)
		return ExitSuccess
	}
	if fs.NArg() > 1 || (*prompt == "" && fs.NArg() == 1) {
		if *prompt == "" && fs.NArg() == 1 {
			*prompt = fs.Arg(0)
		} else {
			return fail(stderr, ExitUsage, "usage", errors.New("agent chat accepts at most one positional prompt"))
		}
	}
	if agentPollFlagInvalid(fs, *poll) {
		return fail(stderr, ExitUsage, "usage", errors.New("--poll must be positive"))
	}
	if *timeout < 0 {
		return fail(stderr, ExitUsage, "usage", errors.New("--timeout must not be negative"))
	}
	if *expectedRevision < 0 {
		return fail(stderr, ExitUsage, "usage", errors.New("--expected-revision must not be negative"))
	}
	if *temperature < 0 {
		return fail(stderr, ExitUsage, "usage", errors.New("--temperature must not be negative"))
	}
	if *maxTokens < 0 {
		return fail(stderr, ExitUsage, "usage", errors.New("--max-tokens must not be negative"))
	}
	mode, err := parseAgentOutputMode(fs, stdout, common.jsonFlag, common.jsonlFlag, common.humanFlag)
	if err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	dispatchMode, err := parseDispatchMode(*dispatch)
	if err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	policy, err := loadAgentCommandPolicy(*policyFile, *policyOverrides)
	if err != nil {
		return failAgentError(stderr, err)
	}
	effectiveDispatchMode := dispatchMode
	if effectiveDispatchMode == "" {
		effectiveDispatchMode = policy.Normalize().DefaultDispatchMode
	}
	commandCtx, cancel, err := agentCommandContext(ctx, *timeout)
	if err != nil {
		return failAgentError(stderr, err)
	}
	defer cancel()
	runtime, runtimeConfig, err := openAgentHarnessWithRuntime(ctx, common, policy, true)
	if err != nil {
		return failAgentError(stderr, err)
	}
	lifetime := newAgentRuntimeLifetime(runtime, ctx)
	defer lifetime.Close()
	effectivePoll := agentPollInterval(fs, *poll, runtimeConfig)
	binding, err := putAgentWorkspaceSnapshot(ctx, runtime, *contextFile, *contextSource, "gonavi agent chat")
	if err != nil {
		lifetime.Detach()
		return fail(stderr, ExitUsage, "context_invalid", err)
	}
	renewal := startAgentWorkspaceSnapshotRenewal(ctx, runtime, binding, runtimeConfig.WorkspaceSnapshotRenewInterval)
	defer renewal.Close()
	firstRequestID := strings.TrimSpace(*requestIDFlag)
	firstRevision := *expectedRevision
	submittedInput := false
	nextRequestID := func() string {
		id := firstRequestID
		firstRequestID = ""
		if id == "" {
			return requestID()
		}
		return id
	}
	nextRevision := func() int64 {
		revision := firstRevision
		firstRevision = 0
		return revision
	}
	nextExpectedRevision := func() (int64, error) {
		revision := nextRevision()
		// An explicit revision belongs to the first input.  Once this
		// interactive chat has created or joined a session, queue submissions
		// must read the latest session projection before they mutate it.  A
		// steer uses the active run's revision instead, so do not accidentally
		// send a session revision down that distinct CAS path.
		if !submittedInput || revision > 0 || effectiveDispatchMode != runharness.DispatchQueue || strings.TrimSpace(*sessionID) == "" {
			return revision, nil
		}
		projection, err := runtime.ReadSession(ctx, runharness.SessionReadRequest{SessionID: strings.TrimSpace(*sessionID)})
		if err != nil {
			return 0, fmt.Errorf("read session revision: %w", err)
		}
		if projection.Revision <= 0 {
			return 0, fmt.Errorf("read session revision: invalid revision %d for session %q", projection.Revision, projection.ID)
		}
		return projection.Revision, nil
	}
	if strings.TrimSpace(*prompt) != "" {
		if err := binding.Publish(ctx, runtime); err != nil {
			detachAgentCommandResources(lifetime, renewal)
			return failAgentError(stderr, err)
		}
		revision, err := nextExpectedRevision()
		if err != nil {
			detachAgentCommandResources(lifetime, renewal)
			return failAgentError(stderr, err)
		}
		request := runharness.AgentInputRequest{
			RequestID: nextRequestID(), SessionID: strings.TrimSpace(*sessionID), Content: *prompt,
			DispatchMode: dispatchMode, ContextSourceID: binding.SourceID, ContextSourceInstanceID: binding.SourceInstanceID,
			Provider: strings.TrimSpace(*provider), Model: strings.TrimSpace(*model), Thinking: strings.TrimSpace(*thinking),
			ExpectedRevision: revision,
		}
		visited := visitedFlags(fs)
		if visited["temperature"] {
			request.Temperature = temperature
		}
		if visited["max-tokens"] {
			request.MaxTokens = maxTokens
		}
		code, receipt, state := submitAndWaitAgentPromptWithContextsState(ctx, commandCtx, runtime, request, mode, effectivePoll, stdout, stderr)
		if code != ExitSuccess {
			// This includes an ambiguous SubmitInput error (where no receipt is
			// available) as well as a wait timeout. Preserve any durable work.
			detachAgentCommandResources(lifetime, renewal)
		} else {
			detachAgentRuntimeIfStillActive(lifetime, state, receipt.State)
			detachAgentWorkspaceSnapshotRenewalIfStillActive(renewal, state, receipt.State)
		}
		return code
	}
	scanner := bufio.NewScanner(currentAgentStdin())
	for {
		line, ok, scanErr := nextAgentChatLine(commandCtx, scanner)
		if scanErr != nil {
			// Scanner failures are unrelated to the durable run state. In
			// particular, EOF/error can occur while Start recovered another queued
			// run in this owner. Never let the command defer cancel that work.
			detachAgentCommandResources(lifetime, renewal)
			if errors.Is(scanErr, context.Canceled) {
				return fail(stderr, ExitCancelled, "cancelled", scanErr)
			}
			if errors.Is(scanErr, context.DeadlineExceeded) {
				return fail(stderr, ExitActionRequired, "wait_timeout", scanErr)
			}
			return fail(stderr, ExitExecution, "input_failed", scanErr)
		}
		if !ok {
			// EOF ends the interactive front-end, not the durable owner. A
			// separate command/process may still observe and control queued work.
			detachAgentCommandResources(lifetime, renewal)
			break
		}
		content := strings.TrimSpace(line)
		if content == "" {
			continue
		}
		if err := binding.Publish(ctx, runtime); err != nil {
			detachAgentCommandResources(lifetime, renewal)
			return failAgentError(stderr, err)
		}
		revision, err := nextExpectedRevision()
		if err != nil {
			detachAgentCommandResources(lifetime, renewal)
			return failAgentError(stderr, err)
		}
		request := runharness.AgentInputRequest{
			RequestID: nextRequestID(), SessionID: strings.TrimSpace(*sessionID), Content: content,
			DispatchMode: dispatchMode, ContextSourceID: binding.SourceID, ContextSourceInstanceID: binding.SourceInstanceID,
			Provider: strings.TrimSpace(*provider), Model: strings.TrimSpace(*model), Thinking: strings.TrimSpace(*thinking),
			ExpectedRevision: revision,
		}
		visited := visitedFlags(fs)
		if visited["temperature"] {
			request.Temperature = temperature
		}
		if visited["max-tokens"] {
			request.MaxTokens = maxTokens
		}
		code, receipt, state := submitAndWaitAgentPromptWithContextsState(ctx, commandCtx, runtime, request, mode, effectivePoll, stdout, stderr)
		if receipt.SessionID != "" {
			// A chat without --session creates its session on the first input;
			// subsequent lines must stay on that same durable conversation.
			*sessionID = receipt.SessionID
		}
		submittedInput = true
		if code != ExitSuccess {
			detachAgentCommandResources(lifetime, renewal)
			return code
		}
		detachAgentRuntimeIfStillActive(lifetime, state, receipt.State)
		detachAgentWorkspaceSnapshotRenewalIfStillActive(renewal, state, receipt.State)
	}
	return ExitSuccess
}

type agentChatLineResult struct {
	line string
	ok   bool
	err  error
}

// nextAgentChatLine keeps an interactive chat responsive to the CLI lifecycle
// context. signal.NotifyContext consumes SIGINT instead of letting the process
// terminate immediately, so a direct Scanner.Scan call would otherwise remain
// blocked on a terminal read after Ctrl-C. Scanner itself has no context-aware
// API; the single buffered result lets the blocked reader finish later without
// retaining the command goroutine or blocking its result delivery.
func nextAgentChatLine(ctx context.Context, scanner *bufio.Scanner) (string, bool, error) {
	if scanner == nil {
		return "", false, errors.New("agent chat input scanner is nil")
	}
	if ctx == nil {
		return "", false, runharness.ErrRootContextRequired
	}
	if err := ctx.Err(); err != nil {
		return "", false, err
	}
	result := make(chan agentChatLineResult, 1)
	go func() {
		if scanner.Scan() {
			result <- agentChatLineResult{line: scanner.Text(), ok: true}
			return
		}
		result <- agentChatLineResult{err: scanner.Err()}
	}()
	select {
	case item := <-result:
		return item.line, item.ok, item.err
	case <-ctx.Done():
		return "", false, ctx.Err()
	}
}

func submitAndWaitAgentPrompt(ctx context.Context, runtime AgentHarnessRuntime, request runharness.AgentInputRequest, mode agentOutputMode, poll time.Duration, stdout io.Writer, stderr io.Writer) (int, runharness.AgentInputReceipt) {
	return submitAndWaitAgentPromptWithContexts(ctx, ctx, runtime, request, mode, poll, stdout, stderr)
}

// submitAndWaitAgentPromptWithContexts separates the lifecycle context used
// for durable acceptance from the command context used only for polling. This
// is important for --timeout: timing out a CLI wait must not cancel the run
// that was already accepted by the harness.
func submitAndWaitAgentPromptWithContexts(lifecycleCtx, waitCtx context.Context, runtime AgentHarnessRuntime, request runharness.AgentInputRequest, mode agentOutputMode, poll time.Duration, stdout io.Writer, stderr io.Writer) (int, runharness.AgentInputReceipt) {
	code, receipt, _ := submitAndWaitAgentPromptWithContextsState(lifecycleCtx, waitCtx, runtime, request, mode, poll, stdout, stderr)
	return code, receipt
}

// submitAndWaitAgentPromptWithContextsState also returns the last durable run
// state observed by the polling path. CLI commands use it to decide whether a
// command-scoped runtime can be closed without canceling a durable run.
func submitAndWaitAgentPromptWithContextsState(lifecycleCtx, waitCtx context.Context, runtime AgentHarnessRuntime, request runharness.AgentInputRequest, mode agentOutputMode, poll time.Duration, stdout io.Writer, stderr io.Writer) (int, runharness.AgentInputReceipt, runharness.RunState) {
	if lifecycleCtx == nil {
		return failAgentError(stderr, runharness.ErrRootContextRequired), runharness.AgentInputReceipt{}, ""
	}
	if waitCtx == nil {
		waitCtx = lifecycleCtx
	}
	receipt, err := runtime.SubmitInput(lifecycleCtx, request)
	if err != nil {
		// Preserve a partial receipt/state if an implementation can provide one;
		// callers still detach conservatively because the durable write may have
		// succeeded before the error crossed the adapter boundary.
		return failAgentError(stderr, err), receipt, receipt.State
	}
	if mode == agentOutputHuman {
		writeAgentReceipt(stdout, receipt)
	}
	code, state := waitForAgentRunOptionsState(waitCtx, runtime, receipt.RunID, mode, poll, stdout, stderr, false)
	return code, receipt, state
}

func runAgentList(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer) int {
	fs := newFlagSet("agent list")
	var common agentCommonFlags
	bindAgentCommonFlags(fs, &common)
	limit := fs.Int("limit", 100, "maximum sessions")
	offset := fs.Int("offset", 0, "number of sessions to skip")
	activeOnly := fs.Bool("active-only", false, "only sessions with non-terminal runs")
	help := fs.Bool("help", false, "show help")
	if err := parseAgentFlags(fs, args); err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	if *help {
		writeAgentListUsage(stdout)
		return ExitSuccess
	}
	if fs.NArg() != 0 || *limit < 0 || *offset < 0 {
		return fail(stderr, ExitUsage, "usage", errors.New("invalid agent list arguments"))
	}
	mode, err := parseAgentOutputMode(fs, stdout, common.jsonFlag, common.jsonlFlag, common.humanFlag)
	if err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	runtime, err := openAgentHarnessReadOnly(ctx, common)
	if err != nil {
		return failAgentError(stderr, err)
	}
	lifetime := newAgentRuntimeLifetime(runtime, ctx)
	defer lifetime.Close()
	result, err := runtime.ListSessions(ctx, runharness.SessionListRequest{Limit: *limit, Offset: *offset, ActiveOnly: *activeOnly})
	if err != nil {
		return failAgentError(stderr, err)
	}
	if mode == agentOutputHuman {
		writeAgentSessionList(stdout, result)
		return ExitSuccess
	}
	return emitOutput(stdout, stderr, result)
}

func runAgentShow(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer) int {
	fs := newFlagSet("agent show")
	var common agentCommonFlags
	bindAgentCommonFlags(fs, &common)
	after := fs.Int64("after-sequence", 0, "return events after this sequence")
	limit := fs.Int("limit", 0, "maximum events")
	help := fs.Bool("help", false, "show help")
	if err := parseAgentFlags(fs, args); err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	if *help {
		writeAgentShowUsage(stdout)
		return ExitSuccess
	}
	if fs.NArg() != 1 || *after < 0 || *limit < 0 {
		return fail(stderr, ExitUsage, "usage", errors.New("agent show requires RUN_ID"))
	}
	mode, err := parseAgentOutputMode(fs, stdout, common.jsonFlag, common.jsonlFlag, common.humanFlag)
	if err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	runtime, err := openAgentHarnessReadOnly(ctx, common)
	if err != nil {
		return failAgentError(stderr, err)
	}
	lifetime := newAgentRuntimeLifetime(runtime, ctx)
	defer lifetime.Close()
	result, err := runtime.ReadRun(ctx, runharness.RunReadRequest{RunID: fs.Arg(0), AfterSequence: *after, Limit: *limit})
	if err != nil {
		return failAgentError(stderr, err)
	}
	if mode == agentOutputHuman {
		writeAgentRunRead(stdout, result)
		return exitCodeForRunState(result.Run.State)
	}
	if mode == agentOutputJSON {
		return emitOutput(stdout, stderr, result)
	}
	for _, event := range result.Events {
		if code := emitOutput(stdout, stderr, event); code != ExitSuccess {
			return code
		}
	}
	return exitCodeForRunState(result.Run.State)
}

func runAgentControl(ctx context.Context, action string, args []string, stdout io.Writer, stderr io.Writer) int {
	fs := newFlagSet("agent " + action)
	var common agentCommonFlags
	bindAgentCommonFlags(fs, &common)
	expected := fs.Int64("expected-revision", 0, "expected run revision")
	request := fs.String("request-id", "", "idempotency key")
	help := fs.Bool("help", false, "show help")
	if err := parseAgentFlags(fs, args); err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	if *help {
		writeAgentControlUsage(stdout, action)
		return ExitSuccess
	}
	if fs.NArg() != 1 || *expected <= 0 {
		return fail(stderr, ExitUsage, "usage", errors.New("command requires RUN_ID and a positive --expected-revision"))
	}
	mode, err := parseAgentOutputMode(fs, stdout, common.jsonFlag, common.jsonlFlag, common.humanFlag)
	if err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	// Control commands are durable cross-process operations. Open the ledger
	// without claiming unrelated queued runs; the harness starts only the
	// addressed run when the control action requires it.
	runtime, err := openAgentHarnessReadOnly(ctx, common)
	if err != nil {
		return failAgentError(stderr, err)
	}
	lifetime := newAgentRuntimeLifetime(runtime, ctx)
	defer lifetime.Close()
	controlAction := runharness.ControlResume
	if action == "cancel" {
		controlAction = runharness.ControlCancel
	}
	run, err := runtime.ControlRun(ctx, runharness.RunControlRequest{RequestID: normalizedAgentRequestID(*request), RunID: fs.Arg(0), Action: controlAction, ExpectedRevision: *expected})
	if err != nil {
		// ControlRun is a durable boundary. The ledger may have accepted the
		// command before a later read/transport error was returned; closing this
		// command-scoped harness could then cancel a worker started for that run.
		lifetime.Detach()
		return failAgentError(stderr, err)
	}
	detachAgentRuntimeIfActive(lifetime, run.State)
	return emitAgentSnapshot(stdout, stderr, mode, run)
}

func runAgentApproval(ctx context.Context, action string, args []string, stdout io.Writer, stderr io.Writer) int {
	fs := newFlagSet("agent " + action)
	var common agentCommonFlags
	bindAgentCommonFlags(fs, &common)
	approvalID := fs.String("approval-id", "", "approval ID")
	callID := fs.String("call-id", "", "tool call ID")
	argsHash := fs.String("args-hash", "", "SHA-256 hash of the approved tool arguments")
	expected := fs.Int64("expected-revision", 0, "expected run revision")
	request := fs.String("request-id", "", "idempotency key")
	wait := fs.Bool("wait", true, "wait for the approval decision to be consumed")
	noWait := fs.Bool("no-wait", false, "return after recording the decision")
	timeout := fs.Duration("timeout", 0, "maximum command wait duration")
	poll := fs.Duration("poll", 0, "run event polling interval (defaults to runtime configuration)")
	help := fs.Bool("help", false, "show help")
	if err := parseAgentFlags(fs, args); err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	if *help {
		writeAgentApprovalUsage(stdout, action)
		return ExitSuccess
	}
	if fs.NArg() != 1 || *expected <= 0 || strings.TrimSpace(*approvalID) == "" || strings.TrimSpace(*callID) == "" || strings.TrimSpace(*argsHash) == "" {
		return fail(stderr, ExitUsage, "usage", errors.New("approval command requires RUN_ID, --approval-id, --call-id, --args-hash, and a positive --expected-revision"))
	}
	if *noWait {
		*wait = false
	}
	if agentPollFlagInvalid(fs, *poll) || *timeout < 0 {
		return fail(stderr, ExitUsage, "usage", errors.New("invalid --poll or --timeout"))
	}
	mode, err := parseAgentOutputMode(fs, stdout, common.jsonFlag, common.jsonlFlag, common.humanFlag)
	if err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	// The harness receives the caller lifecycle context so a short command
	// timeout only bounds this invocation's wait and never cancels the durable
	// worker that consumes the approval.
	commandCtx, cancel, err := agentCommandContext(ctx, *timeout)
	if err != nil {
		return failAgentError(stderr, err)
	}
	defer cancel()
	// Approval is a control-plane operation. Do not become a worker owner just
	// to record a decision or wait for another owner's projection.
	runtime, runtimeConfig, err := openAgentHarnessWithRuntime(ctx, common, runharness.RunPolicy{}, false)
	if err != nil {
		return failAgentError(stderr, err)
	}
	lifetime := newAgentRuntimeLifetime(runtime, ctx)
	defer lifetime.Close()
	effectivePoll := agentPollInterval(fs, *poll, runtimeConfig)
	controlAction := runharness.ControlApprove
	if action == "deny" {
		controlAction = runharness.ControlDeny
	}
	// Recording an approval/denial is a durable control operation. Only the
	// subsequent wait is bounded by --timeout; an expired command must not
	// discard a decision that was already submitted.
	run, err := runtime.ControlRun(ctx, runharness.RunControlRequest{RequestID: normalizedAgentRequestID(*request), RunID: fs.Arg(0), Action: controlAction, ApprovalID: strings.TrimSpace(*approvalID), CallID: strings.TrimSpace(*callID), ArgsHash: strings.TrimSpace(*argsHash), ExpectedRevision: *expected})
	if err != nil {
		// The approval decision can be committed even when the response cannot be
		// read back. Preserve the owner/worker so another invocation can observe
		// and finish the durable decision.
		lifetime.Detach()
		return failAgentError(stderr, err)
	}
	if !*wait {
		detachAgentRuntimeIfActive(lifetime, run.State)
		return emitAgentSnapshot(stdout, stderr, mode, run)
	}
	// A decision is durable before ControlRun returns, but another owner may
	// need a scheduling turn before it can transition awaiting_approval. Keep
	// polling that state for this command instead of reporting action-required
	// prematurely; timeout/SIGINT still exits with the normal CLI semantics.
	code, state := waitForAgentRunOptionsState(commandCtx, runtime, run.ID, mode, effectivePoll, stdout, stderr, true)
	detachAgentRuntimeIfStillActive(lifetime, state, run.State)
	return code
}

func runAgentRecover(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer) int {
	fs := newFlagSet("agent recover")
	var common agentCommonFlags
	bindAgentCommonFlags(fs, &common)
	// Recovery can replay an unknown side effect. Requiring an explicit action
	// prevents a bare command from silently choosing the potentially
	// duplicating retry path.
	action := fs.String("action", "", "mark-completed, retry, or abort (required)")
	callID := fs.String("call-id", "", "unknown side-effect tool call ID (for mark-completed)")
	expected := fs.Int64("expected-revision", 0, "expected run revision")
	request := fs.String("request-id", "", "idempotency key")
	help := fs.Bool("help", false, "show help")
	if err := parseAgentFlags(fs, args); err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	if *help {
		writeAgentRecoverUsage(stdout)
		return ExitSuccess
	}
	if fs.NArg() != 1 || *expected <= 0 || strings.TrimSpace(*action) == "" {
		return fail(stderr, ExitUsage, "usage", errors.New("agent recover requires RUN_ID, --action, and a positive --expected-revision"))
	}
	controlAction, err := parseRecoveryAction(*action)
	if err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	mode, err := parseAgentOutputMode(fs, stdout, common.jsonFlag, common.jsonlFlag, common.humanFlag)
	if err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	// Recovery decisions must be durable without starting unrelated queued
	// runs. The harness may launch only the target run after applying the action.
	runtime, err := openAgentHarnessReadOnly(ctx, common)
	if err != nil {
		return failAgentError(stderr, err)
	}
	lifetime := newAgentRuntimeLifetime(runtime, ctx)
	defer lifetime.Close()
	run, err := runtime.ControlRun(ctx, runharness.RunControlRequest{RequestID: normalizedAgentRequestID(*request), RunID: fs.Arg(0), Action: controlAction, CallID: strings.TrimSpace(*callID), ExpectedRevision: *expected})
	if err != nil {
		// Recovery actions mutate durable state before returning the resulting
		// snapshot. If that final read fails, never let defer Close cancel a worker
		// that may already be processing the accepted recovery command.
		lifetime.Detach()
		return failAgentError(stderr, err)
	}
	detachAgentRuntimeIfActive(lifetime, run.State)
	return emitAgentSnapshot(stdout, stderr, mode, run)
}

func runAgentSnapshot(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer) int {
	fs := newFlagSet("agent snapshot")
	var common agentCommonFlags
	bindAgentCommonFlags(fs, &common)
	file := fs.String("file", "", "complete WorkspaceSnapshot JSON file")
	help := fs.Bool("help", false, "show help")
	if err := parseAgentFlags(fs, args); err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	if *help {
		writeAgentSnapshotUsage(stdout)
		return ExitSuccess
	}
	if fs.NArg() != 0 || strings.TrimSpace(*file) == "" {
		return fail(stderr, ExitUsage, "usage", errors.New("agent snapshot requires --file"))
	}
	data, err := os.ReadFile(*file)
	if err != nil {
		return fail(stderr, ExitUsage, "snapshot_unavailable", err)
	}
	var snapshot runharness.WorkspaceSnapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return fail(stderr, ExitUsage, "snapshot_invalid", err)
	}
	if err := snapshot.Normalize(); err != nil {
		return fail(stderr, ExitUsage, "snapshot_invalid", err)
	}
	if snapshot.SourceKind != runharness.WorkspaceCLI {
		return fail(stderr, ExitUsage, "snapshot_invalid", fmt.Errorf("--file sourceKind must be %q, got %q", runharness.WorkspaceCLI, snapshot.SourceKind))
	}
	runtime, err := openAgentHarnessReadOnly(ctx, common)
	if err != nil {
		return failAgentError(stderr, err)
	}
	lifetime := newAgentRuntimeLifetime(runtime, ctx)
	defer lifetime.Close()
	ack, err := runtime.PutWorkspaceSnapshot(ctx, snapshot)
	if err != nil {
		return failAgentError(stderr, err)
	}
	return emitOutput(stdout, stderr, ack)
}

func runAgentConfig(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer) int {
	if len(args) == 0 {
		writeAgentConfigUsage(stdout)
		return ExitUsage
	}
	if strings.EqualFold(args[0], "help") || args[0] == "--help" || args[0] == "-h" {
		writeAgentConfigUsage(stdout)
		return ExitSuccess
	}
	common := agentCommonFlags{}
	fs := newFlagSet("agent config " + args[0])
	bindAgentCommonFlags(fs, &common)
	policyFile := fs.String("file", "", "RunPolicy JSON file to load/save")
	setValues := fs.String("set", "", "comma-separated key=value policy overrides")
	expectedRevision := fs.Int64("expected-revision", 0, "expected RunPolicy revision for config set")
	fs.Int64Var(expectedRevision, "revision", 0, "alias for --expected-revision")
	help := fs.Bool("help", false, "show help")
	if err := parseAgentFlags(fs, args[1:]); err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	if *help {
		writeAgentConfigUsage(stdout)
		return ExitSuccess
	}
	root, err := appdata.ResolveActiveRoot()
	if err != nil {
		return failAgentError(stderr, err)
	}
	path := strings.TrimSpace(*policyFile)
	if path == "" {
		path = filepath.Join(root, "agent_run_policy.json")
	}
	switch strings.ToLower(strings.TrimSpace(args[0])) {
	case "show":
		snapshot, loadErr := loadAgentPolicy(path)
		if loadErr != nil {
			return failAgentError(stderr, loadErr)
		}
		return emitOutput(stdout, stderr, snapshot)
	case "set":
		if strings.TrimSpace(*setValues) == "" && fs.NArg() > 0 {
			*setValues = strings.Join(fs.Args(), ",")
		}
		if strings.TrimSpace(*setValues) == "" {
			return fail(stderr, ExitUsage, "usage", errors.New("config set requires --set key=value"))
		}
		if *expectedRevision < 1 {
			return failAgentError(stderr, fmt.Errorf("revision_conflict: %w: expectedRevision must be positive", runharness.ErrRevisionConflict))
		}
		snapshot, mutateErr := mutateAgentPolicy(path, *expectedRevision, *setValues)
		if mutateErr != nil {
			if errors.Is(mutateErr, runharness.ErrRevisionConflict) {
				return failAgentError(stderr, mutateErr)
			}
			if errors.Is(mutateErr, errAgentPolicyOverride) {
				return fail(stderr, ExitUsage, "usage", mutateErr)
			}
			return failAgentError(stderr, mutateErr)
		}
		return emitOutput(stdout, stderr, snapshot)
	default:
		return fail(stderr, ExitUsage, "usage", fmt.Errorf("unknown agent config command %q", args[0]))
	}
}

// loadAgentPolicy accepts the old bare-policy document as a read-only
// migration format, but always returns the versioned projection used by the
// desktop settings API. A bare document therefore has the stable initial
// revision rather than silently bypassing CAS on its first CLI update.
func loadAgentPolicy(path string) (runharness.RunPolicySnapshot, error) {
	snapshot := runharness.DefaultRunPolicySnapshot()
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return snapshot, nil
	}
	if err != nil {
		return runharness.RunPolicySnapshot{}, err
	}
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
				return runharness.RunPolicySnapshot{}, fmt.Errorf("decode run runtime: %w", err)
			}
		}
	} else if err := json.Unmarshal(data, &snapshot.Policy); err != nil {
		return runharness.RunPolicySnapshot{}, fmt.Errorf("decode run policy: %w", err)
	}
	// A bare policy is also accepted. Looking for the wrapper key explicitly is
	// important because json.Unmarshal would otherwise silently ignore a
	// malformed `policy` field while decoding the outer object.
	snapshot = snapshot.Normalize()
	if err := snapshot.Validate(); err != nil {
		return runharness.RunPolicySnapshot{}, err
	}
	return snapshot, nil
}

func validateAgentPolicy(policy runharness.RunPolicy) (runharness.RunPolicy, error) {
	policy = policy.Normalize()
	if err := policy.Validate(); err != nil {
		return runharness.RunPolicy{}, err
	}
	return policy, nil
}

func saveAgentPolicy(path string, snapshot runharness.RunPolicySnapshot) error {
	snapshot = snapshot.Normalize()
	if err := snapshot.Validate(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".agent-policy-*.tmp")
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

// mutateAgentPolicy serializes the load/revision-check/write sequence across
// desktop and CLI processes. Keeping the reload inside the lock is essential:
// an optimistic check before acquiring it would still allow two writers to
// accept the same revision and overwrite each other.
func mutateAgentPolicy(path string, expectedRevision int64, overrides string) (runharness.RunPolicySnapshot, error) {
	if expectedRevision < 1 {
		return runharness.RunPolicySnapshot{}, fmt.Errorf("revision_conflict: %w: expectedRevision must be positive", runharness.ErrRevisionConflict)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return runharness.RunPolicySnapshot{}, err
	}
	policyLock, err := appdata.AcquireFileLock(path + ".lock")
	if err != nil {
		return runharness.RunPolicySnapshot{}, err
	}
	defer policyLock.Close()

	current, err := loadAgentPolicy(path)
	if err != nil {
		return runharness.RunPolicySnapshot{}, err
	}
	if current.Revision != expectedRevision {
		return runharness.RunPolicySnapshot{}, fmt.Errorf("revision_conflict: %w: expected %d, got %d", runharness.ErrRevisionConflict, expectedRevision, current.Revision)
	}
	next := current
	if err := applyAgentPolicySnapshotOverrides(&next, overrides); err != nil {
		return runharness.RunPolicySnapshot{}, fmt.Errorf("%w: %v", errAgentPolicyOverride, err)
	}
	next.Revision++
	if err := saveAgentPolicy(path, next); err != nil {
		return runharness.RunPolicySnapshot{}, err
	}
	return next, nil
}

func applyAgentPolicyOverrides(policy *runharness.RunPolicy, values string) error {
	if policy == nil {
		return errors.New("run policy is nil")
	}
	err := forEachAgentPolicyOverride(values, func(rawKey, value string) error {
		key := normalizeAgentPolicyKey(rawKey)
		if isAgentRuntimePolicyKey(key) {
			return fmt.Errorf("unknown run policy field %q", rawKey)
		}
		return applyAgentRunPolicyField(policy, key, value, rawKey)
	})
	if err != nil {
		return err
	}
	_, validationErr := validateAgentPolicy(*policy)
	return validationErr
}

// applyAgentPolicySnapshotOverrides is used by the persistent config command.
// Runtime coordination values live beside RunPolicy in the shared snapshot,
// so they must be parsed in one pass and validated together (in particular,
// renew interval must remain shorter than the lease duration).
func applyAgentPolicySnapshotOverrides(snapshot *runharness.RunPolicySnapshot, values string) error {
	if snapshot == nil {
		return errors.New("run policy snapshot is nil")
	}
	*snapshot = snapshot.Normalize()
	err := forEachAgentPolicyOverride(values, func(rawKey, value string) error {
		key := normalizeAgentPolicyKey(rawKey)
		switch key {
		case "controlpollinterval":
			return setRuntimeDuration(&snapshot.Runtime.ControlPollInterval, value, rawKey)
		case "workspacesnapshotrenewinterval":
			return setRuntimeDuration(&snapshot.Runtime.WorkspaceSnapshotRenewInterval, value, rawKey)
		case "workspacesnapshotleaseduration":
			return setRuntimeDuration(&snapshot.Runtime.WorkspaceSnapshotLeaseDuration, value, rawKey)
		case "policywatchinterval":
			return setRuntimeDuration(&snapshot.Runtime.PolicyWatchInterval, value, rawKey)
		default:
			return applyAgentRunPolicyField(&snapshot.Policy, key, value, rawKey)
		}
	})
	if err != nil {
		return err
	}
	*snapshot = snapshot.Normalize()
	return snapshot.Validate()
}

func forEachAgentPolicyOverride(values string, apply func(rawKey, value string) error) error {
	if apply == nil {
		return errors.New("policy override handler is nil")
	}
	for _, item := range strings.Split(values, ",") {
		parts := strings.SplitN(strings.TrimSpace(item), "=", 2)
		if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" {
			return fmt.Errorf("policy override must be key=value: %q", item)
		}
		if err := apply(strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])); err != nil {
			return err
		}
	}
	return nil
}

func normalizeAgentPolicyKey(key string) string {
	key = strings.ToLower(strings.TrimSpace(key))
	key = strings.NewReplacer("-", "", "_", "").Replace(key)
	return key
}

func isAgentRuntimePolicyKey(key string) bool {
	switch key {
	case "controlpollinterval", "workspacesnapshotrenewinterval", "workspacesnapshotleaseduration", "policywatchinterval":
		return true
	default:
		return false
	}
}

func setRuntimeDuration(target *time.Duration, value, rawKey string) error {
	if target == nil {
		return errors.New("runtime duration target is nil")
	}
	duration, err := time.ParseDuration(value)
	if err != nil {
		return fmt.Errorf("%s: %w", rawKey, err)
	}
	*target = duration
	return nil
}

func applyAgentRunPolicyField(policy *runharness.RunPolicy, key, value, rawKey string) error {
	if policy == nil {
		return errors.New("run policy is nil")
	}
	switch key {
	case "defaultdispatchmode", "dispatch":
		mode, err := parseDispatchMode(value)
		if err != nil {
			return err
		}
		policy.DefaultDispatchMode = mode
	case "softtoolroundlimit":
		if err := setPolicyInt(&policy.SoftToolRoundLimit, value); err != nil {
			return fmt.Errorf("%s: %w", rawKey, err)
		}
	case "maxtoolrounds":
		if err := setPolicyInt(&policy.MaxToolRounds, value); err != nil {
			return fmt.Errorf("%s: %w", rawKey, err)
		}
	case "maxconsecutivefailedtoolrounds":
		if err := setPolicyInt(&policy.MaxConsecutiveFailedToolRounds, value); err != nil {
			return fmt.Errorf("%s: %w", rawKey, err)
		}
	case "maxtoolnudges":
		if err := setPolicyInt(&policy.MaxToolNudges, value); err != nil {
			return fmt.Errorf("%s: %w", rawKey, err)
		}
	case "maxmodelretriesperturn":
		if err := setPolicyInt(&policy.MaxModelRetriesPerTurn, value); err != nil {
			return fmt.Errorf("%s: %w", rawKey, err)
		}
	case "maxtotaltokens":
		if err := setPolicyInt(&policy.MaxTotalTokens, value); err != nil {
			return fmt.Errorf("%s: %w", rawKey, err)
		}
	case "maxactiveduration":
		duration, err := time.ParseDuration(value)
		if err != nil {
			return fmt.Errorf("%s: %w", rawKey, err)
		}
		policy.MaxActiveDuration = duration
	case "modelturntimeout":
		duration, err := time.ParseDuration(value)
		if err != nil {
			return fmt.Errorf("%s: %w", rawKey, err)
		}
		policy.ModelTurnTimeout = duration
	case "modelidletimeout":
		duration, err := time.ParseDuration(value)
		if err != nil {
			return fmt.Errorf("%s: %w", rawKey, err)
		}
		policy.ModelIdleTimeout = duration
	case "defaulttooltimeout":
		duration, err := time.ParseDuration(value)
		if err != nil {
			return fmt.Errorf("%s: %w", rawKey, err)
		}
		policy.DefaultToolTimeout = duration
	case "maxtoolresultbytes":
		if err := setPolicyInt64(&policy.MaxToolResultBytes, value); err != nil {
			return fmt.Errorf("%s: %w", rawKey, err)
		}
	default:
		return fmt.Errorf("unknown run policy field %q", rawKey)
	}
	return nil
}

func setPolicyInt(target *int, value string) error {
	number, err := strconv.Atoi(value)
	if err != nil {
		return err
	}
	*target = number
	return nil
}

func setPolicyInt64(target *int64, value string) error {
	number, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return err
	}
	*target = number
	return nil
}

func resolveAgentPrompt(prompt, promptFile string, useStdin bool, positional []string) (string, error) {
	provided := 0
	if strings.TrimSpace(prompt) != "" {
		provided++
	}
	if strings.TrimSpace(promptFile) != "" {
		provided++
	}
	if useStdin {
		provided++
	}
	if len(positional) > 0 {
		provided++
	}
	if provided != 1 {
		return "", errors.New("provide a prompt with one of --prompt, --prompt-file, --stdin, or one positional argument")
	}
	if strings.TrimSpace(prompt) != "" {
		return prompt, nil
	}
	if strings.TrimSpace(promptFile) != "" {
		data, err := os.ReadFile(promptFile)
		if err != nil {
			return "", err
		}
		if len(data) == 0 {
			return "", errors.New("prompt file is empty")
		}
		return string(data), nil
	}
	if useStdin {
		data, err := io.ReadAll(currentAgentStdin())
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(string(data)) == "" {
			return "", errors.New("stdin prompt is empty")
		}
		return string(data), nil
	}
	if len(positional) != 1 || strings.TrimSpace(positional[0]) == "" {
		return "", errors.New("prompt must be non-empty")
	}
	return positional[0], nil
}

func parseDispatchMode(value string) (runharness.DispatchMode, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return "", nil
	}
	mode := runharness.DispatchMode(value)
	if !mode.Valid() {
		return "", fmt.Errorf("invalid dispatch mode %q (use queue or steer)", value)
	}
	return mode, nil
}

func parseRecoveryAction(value string) (runharness.RunControlAction, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "mark-completed", "mark_completed", "completed":
		return runharness.ControlMarkCompleted, nil
	case "retry":
		return runharness.ControlRecover, nil
	case "abort", "abort-recovery", "abort_recovery":
		return runharness.ControlAbortRecovery, nil
	default:
		return "", fmt.Errorf("invalid recovery action %q (use mark-completed, retry, or abort)", value)
	}
}

func agentCommandContext(parent context.Context, timeout time.Duration) (context.Context, context.CancelFunc, error) {
	if parent == nil {
		return nil, nil, runharness.ErrRootContextRequired
	}
	if timeout > 0 {
		ctx, cancel := context.WithTimeout(parent, timeout)
		return ctx, cancel, nil
	}
	ctx, cancel := context.WithCancel(parent)
	return ctx, cancel, nil
}

func waitForAgentRun(ctx context.Context, runtime AgentHarnessRuntime, runID string, mode agentOutputMode, poll time.Duration, stdout io.Writer, stderr io.Writer) int {
	return waitForAgentRunOptions(ctx, runtime, runID, mode, poll, stdout, stderr, false)
}

// waitForAgentRunOptions waits for a run projection while preserving the
// sequence cursor across polls. ignoreAwaitingApproval is used only after an
// approve/deny command has just changed the durable decision; the initial
// submission path must still return ExitActionRequired immediately for a
// pending non-interactive approval.
func waitForAgentRunOptions(ctx context.Context, runtime AgentHarnessRuntime, runID string, mode agentOutputMode, poll time.Duration, stdout io.Writer, stderr io.Writer, ignoreAwaitingApproval bool) int {
	code, _ := waitForAgentRunOptionsState(ctx, runtime, runID, mode, poll, stdout, stderr, ignoreAwaitingApproval)
	return code
}

// waitForAgentRunOptionsState is the same polling loop as
// waitForAgentRunOptions, but also returns the last durable state observed.
// Callers use that state to decide whether closing the adapter would cancel a
// still-live owner. The public/internal helper above keeps the existing
// integer-only API for tests and other adapters.
func waitForAgentRunOptionsState(ctx context.Context, runtime AgentHarnessRuntime, runID string, mode agentOutputMode, poll time.Duration, stdout io.Writer, stderr io.Writer, ignoreAwaitingApproval bool) (int, runharness.RunState) {
	if strings.TrimSpace(runID) == "" {
		return fail(stderr, ExitExecution, "run_missing", errors.New("harness returned an empty run ID")), ""
	}
	if ctx == nil {
		return failAgentError(stderr, runharness.ErrRootContextRequired), ""
	}
	after := int64(0)
	lastState := runharness.RunState("")
	for {
		result, err := runtime.ReadRun(ctx, runharness.RunReadRequest{RunID: runID, AfterSequence: after})
		if err != nil {
			if ctx != nil && errors.Is(ctx.Err(), context.Canceled) {
				if terminal, terminalState, cancelErr := cancelAgentRunWithError(ctx, runtime, runID); terminal {
					lastState = terminalState
					return exitCodeForRunState(terminalState), lastState
				} else if cancelErr != nil {
					return failAgentError(stderr, cancelErr), lastState
				}
				return fail(stderr, ExitCancelled, "cancelled", ctx.Err()), lastState
			}
			if ctx != nil && errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return fail(stderr, ExitActionRequired, "wait_timeout", ctx.Err()), lastState
			}
			return failAgentError(stderr, err), lastState
		}
		lastState = result.Run.State
		for _, event := range result.Events {
			if event.Sequence > after {
				after = event.Sequence
			}
			emitAgentActionNotice(stderr, event)
			if mode == agentOutputHuman {
				writeAgentEvent(stdout, event)
			} else if mode == agentOutputJSONL {
				if code := emitOutput(stdout, stderr, event); code != ExitSuccess {
					return code, lastState
				}
			}
		}
		if result.Run.State.Terminal() || (isAgentWaitActionRequired(result.Run.State) && !(ignoreAwaitingApproval && result.Run.State == runharness.RunStateAwaitingApproval)) {
			if mode == agentOutputJSON {
				if code := emitOutput(stdout, stderr, result); code != ExitSuccess {
					return code, lastState
				}
			}
			return exitCodeForRunState(result.Run.State), lastState
		}
		timer := time.NewTimer(poll)
		select {
		case <-ctx.Done():
			timer.Stop()
			if errors.Is(ctx.Err(), context.Canceled) {
				if terminal, terminalState, cancelErr := cancelAgentRunWithError(ctx, runtime, runID); terminal {
					lastState = terminalState
					return exitCodeForRunState(terminalState), lastState
				} else if cancelErr != nil {
					return failAgentError(stderr, cancelErr), lastState
				}
				return fail(stderr, ExitCancelled, "cancelled", ctx.Err()), lastState
			}
			return fail(stderr, ExitActionRequired, "wait_timeout", ctx.Err()), lastState
		case <-timer.C:
		}
	}
}

// emitAgentActionNotice keeps the identifiers needed for a follow-up CLI
// command visible even when stdout is JSON (where human text would corrupt the
// machine-readable result). It is emitted once because the caller advances the
// sequence cursor after each event.
func emitAgentActionNotice(stderr io.Writer, event runharness.RunEvent) {
	if stderr == nil || event.Kind != runharness.EventApproval || len(event.Payload) == 0 {
		return
	}
	var payload runharness.ApprovalEvent
	if err := json.Unmarshal(event.Payload, &payload); err != nil || payload.Decision != "pending" {
		return
	}
	_, _ = fmt.Fprintf(stderr, "approval required: runId=%s callId=%s approvalId=%s argsHash=%s\n", event.RunID, payload.CallID, payload.ApprovalID, payload.ArgsHash)
}

// cancelAgentRun persists cancellation with a short context detached from the
// canceled wait context, then reports a terminal state when the harness can
// settle one promptly. The detached context retains lifecycle values instead
// of constructing a second root context, while its timeout keeps SIGINT from
// leaving the CLI process stuck behind an uncooperative external tool.
func cancelAgentRun(parent context.Context, runtime AgentHarnessRuntime, runID string) (bool, runharness.RunState) {
	terminal, state, _ := cancelAgentRunWithError(parent, runtime, runID)
	return terminal, state
}

// cancelAgentRunWithError persists cancellation with a compare-and-swap guard
// and reports errors instead of allowing a failed control command to look like
// a successful cancellation. A run can advance between the initial read and
// the command enqueue; in that case we refresh once and retry against the new
// revision. More than one refresh would make SIGINT an unbounded mutating
// operation and could race a legitimate steer/terminal transition.
func cancelAgentRunWithError(parent context.Context, runtime AgentHarnessRuntime, runID string) (bool, runharness.RunState, error) {
	if runtime == nil || strings.TrimSpace(runID) == "" {
		return false, "", errors.New("agent cancellation runtime or run ID is unavailable")
	}
	if parent == nil {
		return false, "", runharness.ErrRootContextRequired
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), 2*time.Second)
	defer cancel()
	// A cancellation is a durable mutation too. Read the current projection
	// under the detached command context first so its CAS guard cannot silently
	// overwrite a newer owner transition after SIGINT has canceled the waiter.
	current, err := runtime.ReadRun(ctx, runharness.RunReadRequest{RunID: runID})
	if err != nil {
		return false, "", fmt.Errorf("read run before cancellation: %w", err)
	}
	if current.Run.State.Terminal() {
		return true, current.Run.State, nil
	}
	if current.Run.Revision <= 0 {
		return false, "", fmt.Errorf("read run before cancellation: invalid revision %d", current.Run.Revision)
	}
	commandID := normalizedAgentRequestID("")
	for attempt := 0; attempt < 2; attempt++ {
		_, err = runtime.ControlRun(ctx, runharness.RunControlRequest{
			RequestID: commandID, RunID: runID, Action: runharness.ControlCancel,
			ExpectedRevision: current.Run.Revision,
		})
		if err == nil {
			break
		}
		if !errors.Is(err, runharness.ErrRevisionConflict) || attempt == 1 {
			return false, "", fmt.Errorf("persist cancellation: %w", err)
		}
		// Refresh the CAS value once. If the concurrent transition already
		// reached a terminal state, report that state rather than claiming the
		// canceled command won the race.
		current, err = runtime.ReadRun(ctx, runharness.RunReadRequest{RunID: runID})
		if err != nil {
			return false, "", fmt.Errorf("refresh run before cancellation retry: %w", err)
		}
		if current.Run.State.Terminal() {
			return true, current.Run.State, nil
		}
		if current.Run.Revision <= 0 {
			return false, "", fmt.Errorf("refresh run before cancellation retry: invalid revision %d", current.Run.Revision)
		}
	}
	deadlineCtx, deadlineCancel := context.WithTimeout(context.WithoutCancel(parent), 2*time.Second)
	defer deadlineCancel()
	for {
		result, err := runtime.ReadRun(deadlineCtx, runharness.RunReadRequest{RunID: runID})
		if err != nil {
			return false, "", fmt.Errorf("read run after cancellation: %w", err)
		}
		if result.Run.State.Terminal() {
			return true, result.Run.State, nil
		}
		timer := time.NewTimer(25 * time.Millisecond)
		select {
		case <-deadlineCtx.Done():
			timer.Stop()
			// The durable cancel command has already been accepted.  Preserve the
			// historical SIGINT contract (the caller exits canceled while the
			// owner finishes settling asynchronously); only failures to persist the
			// command itself are surfaced as action-required errors above.
			return false, "", nil
		case <-timer.C:
		}
	}
}

func emitAgentSnapshot(stdout io.Writer, stderr io.Writer, mode agentOutputMode, run runharness.RunSnapshot) int {
	if mode == agentOutputHuman {
		writeAgentSnapshot(stdout, run)
		return exitCodeForRunState(run.State)
	}
	if code := emitOutput(stdout, stderr, run); code != ExitSuccess {
		return code
	}
	return exitCodeForRunState(run.State)
}

func isAgentActionRequired(state runharness.RunState) bool {
	switch state {
	case runharness.RunStateQueued, runharness.RunStateAwaitingApproval, runharness.RunStateInterrupted, runharness.RunStateRecoveryRequired, runharness.RunStateAwaitingWorkspace:
		return true
	default:
		return false
	}
}

// isAgentWaitActionRequired excludes queued runs. A queue entry is durable
// work, not a prompt for the user: the local worker may be about to acquire
// it, so `agent run --wait` must keep the adapter alive long enough to do so.
// --no-wait intentionally still reports queued as a non-terminal receipt.
func isAgentWaitActionRequired(state runharness.RunState) bool {
	return state != runharness.RunStateQueued && isAgentActionRequired(state)
}

func exitCodeForRunState(state runharness.RunState) int {
	switch state {
	case runharness.RunStateCompleted:
		return ExitSuccess
	case runharness.RunStateCanceled:
		return ExitCancelled
	case runharness.RunStateFailed, runharness.RunStateExhausted:
		return ExitExecution
	case runharness.RunStateRecoveryRequired:
		return ExitUnknownOutcome
	default:
		return ExitActionRequired
	}
}

func failAgentError(writer io.Writer, err error) int {
	if err == nil {
		return fail(writer, ExitExecution, "agent_failed", errors.New("agent operation failed"))
	}
	switch {
	case errors.Is(err, runharness.ErrLedgerLocked):
		return fail(writer, ExitConnection, "ledger_locked", err)
	case errors.Is(err, runharness.ErrRevisionConflict):
		return fail(writer, ExitActionRequired, "revision_conflict", err)
	case errors.Is(err, runharness.ErrRunAlreadyActive), errors.Is(err, runharness.ErrLeaseUnavailable):
		return fail(writer, ExitActionRequired, "run_busy", err)
	case errors.Is(err, runharness.ErrApprovalConflict):
		return fail(writer, ExitActionRequired, "approval_invalid", err)
	case errors.Is(err, runharness.ErrRecoveryUnavailable):
		return fail(writer, ExitActionRequired, "recovery_unavailable", err)
	case errors.Is(err, runharness.ErrSnapshotExpired):
		return fail(writer, ExitActionRequired, "snapshot_expired", err)
	case errors.Is(err, runharness.ErrSnapshotConflict):
		return fail(writer, ExitActionRequired, "snapshot_conflict", err)
	case errors.Is(err, runharness.ErrWorkspaceUnavailable):
		return fail(writer, ExitActionRequired, "workspace_unavailable", err)
	case errors.Is(err, runharness.ErrTerminalRun):
		return fail(writer, ExitExecution, "run_terminal", err)
	case errors.Is(err, context.Canceled):
		return fail(writer, ExitCancelled, "cancelled", err)
	case errors.Is(err, context.DeadlineExceeded):
		return fail(writer, ExitActionRequired, "deadline", err)
	default:
		return fail(writer, ExitExecution, "agent_failed", err)
	}
}

func writeAgentReceipt(writer io.Writer, receipt runharness.AgentInputReceipt) {
	_, _ = fmt.Fprintf(writer, "run %s (%s, %s)\n", receipt.RunID, receipt.Disposition, receipt.State)
}

func writeAgentSnapshot(writer io.Writer, run runharness.RunSnapshot) {
	_, _ = fmt.Fprintf(writer, "run %s state=%s revision=%d attempt=%d\n", run.ID, run.State, run.Revision, run.Attempt)
}

func writeAgentEvent(writer io.Writer, event runharness.RunEvent) {
	_, _ = fmt.Fprintf(writer, "[%d] %s state=%s\n", event.Sequence, event.Kind, event.ResultingState)
	if len(event.Payload) == 0 {
		return
	}
	if event.Kind == runharness.EventApproval {
		var approval runharness.ApprovalEvent
		if json.Unmarshal(event.Payload, &approval) == nil {
			_, _ = fmt.Fprintf(writer, "approval=%s call=%s args-hash=%s decision=%s\n", approval.ApprovalID, approval.CallID, approval.ArgsHash, approval.Decision)
		}
		return
	}
	var payload map[string]any
	if json.Unmarshal(event.Payload, &payload) != nil {
		return
	}
	if text, ok := payload["text"].(string); ok && text != "" {
		_, _ = fmt.Fprint(writer, text)
	}
}

func writeAgentSessionList(writer io.Writer, result runharness.SessionListResult) {
	for _, session := range result.Sessions {
		_, _ = fmt.Fprintf(writer, "%s\t%s\trevision=%d\n", session.ID, session.Title, session.Revision)
	}
}

func writeAgentRunRead(writer io.Writer, result runharness.RunReadResult) {
	writeAgentSnapshot(writer, result.Run)
	for _, event := range result.Events {
		writeAgentEvent(writer, event)
	}
}

func writeAgentUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, `Usage: gonavi agent <chat|run|list|show|resume|cancel|approve|deny|recover|config|snapshot>
`)
}

func writeAgentRunUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi agent run [--session ID] [--request-id ID] (--prompt TEXT|--prompt-file FILE|--stdin|PROMPT) [--dispatch queue|steer] [--context-file FILE] [--policy key=value,...] [--wait|--no-wait]\n")
}

func writeAgentChatUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi agent chat [--session ID] [--request-id ID] [--prompt TEXT] [--dispatch queue|steer] [--context-file FILE] [--policy key=value,...]\n")
}

func writeAgentListUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi agent list [--limit N] [--offset N] [--active-only]\n")
}

func writeAgentShowUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi agent show RUN_ID [--after-sequence N] [--limit N]\n")
}

func writeAgentControlUsage(writer io.Writer, action string) {
	_, _ = fmt.Fprintf(writer, "Usage: gonavi agent %s RUN_ID --expected-revision N\n", action)
}

func writeAgentApprovalUsage(writer io.Writer, action string) {
	_, _ = fmt.Fprintf(writer, "Usage: gonavi agent %s RUN_ID --approval-id APPROVAL_ID --call-id CALL_ID --args-hash SHA256 --expected-revision N [--wait|--no-wait] [--poll DURATION] [--timeout DURATION]\n", action)
}

func writeAgentRecoverUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi agent recover RUN_ID --action mark-completed|retry|abort --expected-revision N [--call-id CALL_ID]\n")
}

func writeAgentConfigUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi agent config <show|set> [--file FILE] [--set key=value,...]\n")
}

func writeAgentSnapshotUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi agent snapshot --file WORKSPACE_SNAPSHOT.json\n")
}
