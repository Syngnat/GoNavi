package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"

	"GoNavi-Wails/internal/ai/runharness"
)

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
