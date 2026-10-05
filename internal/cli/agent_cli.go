package cli

// The agent CLI is deliberately an adapter around runharness.Harness.  It
// owns argument parsing and presentation only; scheduling, tool execution,
// approvals, cancellation and persistence stay in the harness package.

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"GoNavi-Wails/internal/ai/runharness"
	aiservice "GoNavi-Wails/internal/ai/service"
	"GoNavi-Wails/internal/mcpserver"
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
	fs.StringVar(&common.keyFile, "ledger-key-file", "", "private file containing the ledger encryption key")
	fs.StringVar(&common.keyFile, "key-file", "", "alias for --ledger-key-file")
	fs.StringVar(&common.ledger, "ledger", "", "agent ledger SQLite path")
	fs.BoolVar(&common.jsonFlag, "json", false, "emit one JSON result")
	fs.BoolVar(&common.jsonlFlag, "jsonl", false, "emit JSONL events")
	fs.BoolVar(&common.humanFlag, "human", false, "emit human-readable output")
}
