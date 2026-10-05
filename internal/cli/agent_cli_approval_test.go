package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/ai/runharness"
)

func TestRunAgentApprovalRejectsNegativeRevision(t *testing.T) {
	started := false
	previous := newAgentHarness
	newAgentHarness = func(context.Context, AgentHarnessOptions) (AgentHarnessRuntime, error) {
		started = true
		return nil, errors.New("factory must not run for invalid revision")
	}
	t.Cleanup(func() { newAgentHarness = previous })
	var stdout, stderr bytes.Buffer
	code := runAgentApproval(context.Background(), "approve", []string{"r", "--approval-id", "a", "--call-id", "call-1", "--args-hash", "hash-1", "--expected-revision", "-1"}, &stdout, &stderr)
	if code != ExitUsage || started || !strings.Contains(stderr.String(), `"code":"usage"`) {
		t.Fatalf("exit=%d started=%t stdout=%q stderr=%q", code, started, stdout.String(), stderr.String())
	}
}

func TestCLIAgentApprovalNonTTYReturnsPendingWithoutReadingTTY(t *testing.T) {
	opened := false
	var output bytes.Buffer
	handler := &cliAgentApprovalHandler{
		stdin: func() io.Reader { return strings.NewReader("piped input") },
		tty:   readerIsTTY,
		openTTY: func() (io.ReadWriteCloser, error) {
			opened = true
			return nil, errors.New("must not open tty for piped input")
		},
		stderr: &output,
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	decision, err := handler.Request(ctx, runharness.ApprovalRequest{
		ApprovalID: "approval-1", RunID: "run-1", CallID: "call-1", ToolName: "execute_sql",
	})
	if !errors.Is(err, runharness.ErrApprovalPending) {
		t.Fatalf("error = %v, want ErrApprovalPending", err)
	}
	if opened || decision != (runharness.ApprovalDecision{}) {
		t.Fatalf("non-TTY approval = %#v opened=%t", decision, opened)
	}
}

func TestCLIAgentApprovalNonTTYPropagatesCancellation(t *testing.T) {
	handler := &cliAgentApprovalHandler{
		stdin: func() io.Reader { return strings.NewReader("piped input") },
		tty:   readerIsTTY,
		openTTY: func() (io.ReadWriteCloser, error) {
			t.Fatalf("must not open tty after cancellation")
			return nil, nil
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	decision, err := handler.Request(ctx, runharness.ApprovalRequest{ApprovalID: "approval-1"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
	if decision != (runharness.ApprovalDecision{}) {
		t.Fatalf("decision = %#v", decision)
	}
}

func TestRunAgentApprovalWaitsForWorkerAndReturnsTerminalResult(t *testing.T) {
	runtime := &fakeAgentRuntime{
		controlSnapshot: runharness.RunSnapshot{ID: "run-approval", State: runharness.RunStateAwaitingApproval},
		readResults: []runharness.RunReadResult{{
			Run: runharness.RunSnapshot{ID: "run-approval", State: runharness.RunStateCompleted},
			Events: []runharness.RunEvent{{
				RunID: "run-approval", Sequence: 1, Kind: runharness.EventTerminal,
				ResultingState: runharness.RunStateCompleted,
			}},
		}},
	}
	installFakeAgentRuntime(t, runtime)
	var stdout, stderr bytes.Buffer
	code := runAgentApproval(context.Background(), "approve", []string{
		"run-approval", "--approval-id", "approval-1", "--call-id", "call-1", "--args-hash", "hash-1", "--expected-revision", "1", "--json", "--poll", "1ms",
	}, &stdout, &stderr)
	if code != ExitSuccess {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	var result runharness.RunReadResult
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &result); err != nil {
		t.Fatalf("decode terminal result: %v; output=%q", err, stdout.String())
	}
	if result.Run.State != runharness.RunStateCompleted {
		t.Fatalf("result = %#v", result.Run)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.controlRequests) != 1 || runtime.controlRequests[0].Action != runharness.ControlApprove {
		t.Fatalf("control requests = %#v", runtime.controlRequests)
	}
	if runtime.closeCalls != 1 {
		t.Fatalf("close calls = %d", runtime.closeCalls)
	}
}

func TestWaitForAgentRunJSONLReportsApprovalIdentifiersOnce(t *testing.T) {
	runtime := &fakeAgentRuntime{
		readResults: []runharness.RunReadResult{{
			Run: runharness.RunSnapshot{ID: "run-approval", State: runharness.RunStateAwaitingApproval},
			Events: []runharness.RunEvent{{
				RunID: "run-approval", Sequence: 1, Kind: runharness.EventApproval,
				ResultingState: runharness.RunStateAwaitingApproval,
				Payload:        mustJSON(runharness.ApprovalEvent{ApprovalID: "approval-1", CallID: "call-1", ArgsHash: "hash-1", Decision: "pending"}),
			}},
		}},
	}
	var stdout, stderr bytes.Buffer
	code := waitForAgentRun(context.Background(), runtime, "run-approval", agentOutputJSONL, time.Millisecond, &stdout, &stderr)
	if code != ExitActionRequired {
		t.Fatalf("exit = %d", code)
	}
	if got := strings.Count(stderr.String(), "approvalId=approval-1"); got != 1 || !strings.Contains(stderr.String(), "argsHash=hash-1") {
		t.Fatalf("approval notice count = %d, stderr=%q", got, stderr.String())
	}
	lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("JSONL lines = %d, output=%q", len(lines), stdout.String())
	}
	var event runharness.RunEvent
	if err := json.Unmarshal([]byte(lines[0]), &event); err != nil || event.Kind != runharness.EventApproval {
		t.Fatalf("JSONL event = %#v err=%v", event, err)
	}
	var payload runharness.ApprovalEvent
	if err := json.Unmarshal(event.Payload, &payload); err != nil || payload.ArgsHash != "hash-1" {
		t.Fatalf("JSONL approval payload = %#v err=%v", payload, err)
	}
	if strings.Contains(stdout.String(), "approval required") {
		t.Fatalf("JSONL stdout contains human approval notice: %q", stdout.String())
	}
}

func TestWriteAgentEventApprovalDisplaysOnlyBoundIdentifiers(t *testing.T) {
	event := runharness.RunEvent{
		Sequence:       9,
		Kind:           runharness.EventApproval,
		ResultingState: runharness.RunStateAwaitingApproval,
		Payload: mustJSON(map[string]any{
			"approvalId": "approval-1",
			"callId":     "call-1",
			"argsHash":   "hash-1",
			"decision":   "pending",
			"arguments":  map[string]any{"sql": "SELECT secret_value"},
			"text":       "SELECT secret_value",
		}),
	}
	var output bytes.Buffer
	writeAgentEvent(&output, event)
	got := output.String()
	if !strings.Contains(got, "approval=approval-1 call=call-1 args-hash=hash-1 decision=pending") {
		t.Fatalf("approval event output=%q", got)
	}
	if strings.Contains(got, "secret_value") {
		t.Fatalf("approval event exposed tool arguments: %q", got)
	}
}

func TestFailAgentErrorMapsFollowUpStatesToActionRequired(t *testing.T) {
	cases := []struct {
		name string
		err  error
		code string
	}{
		{name: "recovery", err: runharness.ErrRecoveryUnavailable, code: "recovery_unavailable"},
		{name: "snapshot expired", err: runharness.ErrSnapshotExpired, code: "snapshot_expired"},
		{name: "snapshot conflict", err: runharness.ErrSnapshotConflict, code: "snapshot_conflict"},
		{name: "workspace unavailable", err: runharness.ErrWorkspaceUnavailable, code: "workspace_unavailable"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var stderr bytes.Buffer
			if got := failAgentError(&stderr, tc.err); got != ExitActionRequired {
				t.Fatalf("exit=%d stderr=%q", got, stderr.String())
			}
			if !strings.Contains(stderr.String(), `"code":"`+tc.code+`"`) {
				t.Fatalf("missing code %q in stderr=%q", tc.code, stderr.String())
			}
		})
	}
}
