package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/ai/runharness"
	"GoNavi-Wails/internal/appdata"
)

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
