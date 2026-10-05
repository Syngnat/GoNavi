package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"GoNavi-Wails/internal/ai/runharness"
)

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
