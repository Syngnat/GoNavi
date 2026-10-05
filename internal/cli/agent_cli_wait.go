package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"GoNavi-Wails/internal/ai/runharness"
)

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
