package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai/runharness"
)

func TestAgentControlCommandsForwardTypedControlRequests(t *testing.T) {
	cases := []struct {
		name         string
		invoke       func(*fakeAgentRuntime, *bytes.Buffer, *bytes.Buffer) int
		wantAction   runharness.RunControlAction
		wantApproval string
		wantCall     string
		wantArgsHash string
	}{
		{
			name: "cancel",
			invoke: func(_ *fakeAgentRuntime, stdout, stderr *bytes.Buffer) int {
				return runAgentControl(context.Background(), "cancel", []string{
					"run-1", "--request-id", "req-cancel", "--expected-revision", "7", "--json",
				}, stdout, stderr)
			},
			wantAction: runharness.ControlCancel,
		},
		{
			name: "resume",
			invoke: func(_ *fakeAgentRuntime, stdout, stderr *bytes.Buffer) int {
				return runAgentControl(context.Background(), "resume", []string{
					"run-1", "--request-id", "req-resume", "--expected-revision", "7", "--json",
				}, stdout, stderr)
			},
			wantAction: runharness.ControlResume,
		},
		{
			name: "approve",
			invoke: func(_ *fakeAgentRuntime, stdout, stderr *bytes.Buffer) int {
				return runAgentApproval(context.Background(), "approve", []string{
					"run-1", "--approval-id", "approval-1", "--call-id", "call-1",
					"--args-hash", "hash-approve", "--request-id", "req-approve", "--expected-revision", "7", "--no-wait", "--json",
				}, stdout, stderr)
			},
			wantAction: runharness.ControlApprove, wantApproval: "approval-1", wantCall: "call-1", wantArgsHash: "hash-approve",
		},
		{
			name: "deny",
			invoke: func(_ *fakeAgentRuntime, stdout, stderr *bytes.Buffer) int {
				return runAgentApproval(context.Background(), "deny", []string{
					"run-1", "--approval-id", "approval-2", "--call-id", "call-2",
					"--args-hash", "hash-deny", "--request-id", "req-deny", "--expected-revision", "7", "--no-wait", "--json",
				}, stdout, stderr)
			},
			wantAction: runharness.ControlDeny, wantApproval: "approval-2", wantCall: "call-2", wantArgsHash: "hash-deny",
		},
		{
			name: "recover retry",
			invoke: func(_ *fakeAgentRuntime, stdout, stderr *bytes.Buffer) int {
				return runAgentRecover(context.Background(), []string{
					"run-1", "--action", "retry", "--call-id", "call-retry",
					"--request-id", "req-retry", "--expected-revision", "7", "--json",
				}, stdout, stderr)
			},
			wantAction: runharness.ControlRecover, wantCall: "call-retry",
		},
		{
			name: "recover abort",
			invoke: func(_ *fakeAgentRuntime, stdout, stderr *bytes.Buffer) int {
				return runAgentRecover(context.Background(), []string{
					"run-1", "--action", "abort", "--request-id", "req-abort",
					"--expected-revision", "7", "--json",
				}, stdout, stderr)
			},
			wantAction: runharness.ControlAbortRecovery,
		},
		{
			name: "recover mark completed",
			invoke: func(_ *fakeAgentRuntime, stdout, stderr *bytes.Buffer) int {
				return runAgentRecover(context.Background(), []string{
					"run-1", "--action", "mark-completed", "--call-id", "call-complete",
					"--request-id", "req-complete", "--expected-revision", "7", "--json",
				}, stdout, stderr)
			},
			wantAction: runharness.ControlMarkCompleted, wantCall: "call-complete",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			runtime := &fakeAgentRuntime{controlSnapshot: runharness.RunSnapshot{ID: "run-1", State: runharness.RunStateRunningModel}}
			capture := installFakeAgentRuntime(t, runtime)
			var stdout, stderr bytes.Buffer
			if code := tc.invoke(runtime, &stdout, &stderr); code != ExitActionRequired {
				t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
			}
			runtime.mu.Lock()
			defer runtime.mu.Unlock()
			if len(runtime.controlRequests) != 1 {
				t.Fatalf("control requests=%#v", runtime.controlRequests)
			}
			request := runtime.controlRequests[0]
			if request.Action != tc.wantAction || request.RunID != "run-1" || request.ExpectedRevision != 7 {
				t.Fatalf("request=%+v, want action=%s run=run-1 revision=7", request, tc.wantAction)
			}
			if request.RequestID == "" {
				t.Fatalf("request has no idempotency key: %+v", request)
			}
			if request.ApprovalID != tc.wantApproval || request.CallID != tc.wantCall || request.ArgsHash != tc.wantArgsHash {
				t.Fatalf("approval/call/args-hash fields=%q/%q/%q, want %q/%q/%q", request.ApprovalID, request.CallID, request.ArgsHash, tc.wantApproval, tc.wantCall, tc.wantArgsHash)
			}
			if capture.Options.StartWorkers {
				t.Fatal("control command started unrelated harness workers")
			}
		})
	}
}

func TestRunAgentApprovalRequiresCompleteBindingBeforeStartingHarness(t *testing.T) {
	cases := []struct {
		name      string
		action    string
		args      []string
		wantError string
	}{
		{
			name: "missing call ID", action: "approve",
			args:      []string{"run-1", "--approval-id", "approval-1", "--args-hash", "hash-1", "--expected-revision", "1", "--json"},
			wantError: "--call-id",
		},
		{
			name: "missing args hash", action: "deny",
			args:      []string{"run-1", "--approval-id", "approval-1", "--call-id", "call-1", "--expected-revision", "1", "--json"},
			wantError: "--args-hash",
		},
		{
			name: "zero revision", action: "approve",
			args:      []string{"run-1", "--approval-id", "approval-1", "--call-id", "call-1", "--args-hash", "hash-1", "--expected-revision", "0", "--json"},
			wantError: "positive --expected-revision",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			started := false
			previous := newAgentHarness
			newAgentHarness = func(context.Context, AgentHarnessOptions) (AgentHarnessRuntime, error) {
				started = true
				return nil, errors.New("harness must not start for incomplete approval")
			}
			t.Cleanup(func() { newAgentHarness = previous })
			var stdout, stderr bytes.Buffer
			code := runAgentApproval(context.Background(), tc.action, tc.args, &stdout, &stderr)
			if code != ExitUsage || started || !strings.Contains(stderr.String(), tc.wantError) {
				t.Fatalf("exit=%d started=%t stdout=%q stderr=%q", code, started, stdout.String(), stderr.String())
			}
		})
	}
}

func TestRunAgentControlCommandsRequirePositiveRevisionBeforeStartingHarness(t *testing.T) {
	cases := []struct {
		name string
		call func(*bytes.Buffer, *bytes.Buffer) int
	}{
		{
			name: "cancel",
			call: func(stdout, stderr *bytes.Buffer) int {
				return runAgentControl(context.Background(), "cancel", []string{"run-1", "--expected-revision", "0", "--json"}, stdout, stderr)
			},
		},
		{
			name: "resume",
			call: func(stdout, stderr *bytes.Buffer) int {
				return runAgentControl(context.Background(), "resume", []string{"run-1", "--expected-revision", "0", "--json"}, stdout, stderr)
			},
		},
		{
			name: "recover",
			call: func(stdout, stderr *bytes.Buffer) int {
				return runAgentRecover(context.Background(), []string{"run-1", "--action", "retry", "--expected-revision", "0", "--json"}, stdout, stderr)
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			started := false
			previous := newAgentHarness
			newAgentHarness = func(context.Context, AgentHarnessOptions) (AgentHarnessRuntime, error) {
				started = true
				return nil, errors.New("harness must not start for zero revision")
			}
			t.Cleanup(func() { newAgentHarness = previous })
			var stdout, stderr bytes.Buffer
			if code := tc.call(&stdout, &stderr); code != ExitUsage || started || !strings.Contains(stderr.String(), "positive --expected-revision") {
				t.Fatalf("exit=%d started=%t stdout=%q stderr=%q", code, started, stdout.String(), stderr.String())
			}
		})
	}
}

func TestExitCodeForRunStateCoversEveryState(t *testing.T) {
	cases := []struct {
		state runharness.RunState
		want  int
	}{
		{runharness.RunStateQueued, ExitActionRequired},
		{runharness.RunStateRunningModel, ExitActionRequired},
		{runharness.RunStateAwaitingApproval, ExitActionRequired},
		{runharness.RunStateRunningTool, ExitActionRequired},
		{runharness.RunStateAwaitingWorkspace, ExitActionRequired},
		{runharness.RunStateInterrupted, ExitActionRequired},
		{runharness.RunStateRecoveryRequired, ExitUnknownOutcome},
		{runharness.RunStateCanceling, ExitActionRequired},
		{runharness.RunStateCompleted, ExitSuccess},
		{runharness.RunStateFailed, ExitExecution},
		{runharness.RunStateCanceled, ExitCancelled},
		{runharness.RunStateExhausted, ExitExecution},
	}
	for _, tc := range cases {
		t.Run(string(tc.state), func(t *testing.T) {
			if got := exitCodeForRunState(tc.state); got != tc.want {
				t.Fatalf("exitCodeForRunState(%s)=%d, want %d", tc.state, got, tc.want)
			}
		})
	}
}

func decodeAgentJSONLEvents(t *testing.T, data []byte) []runharness.RunEvent {
	t.Helper()
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return nil
	}
	lines := bytes.Split(trimmed, []byte{'\n'})
	events := make([]runharness.RunEvent, 0, len(lines))
	for index, line := range lines {
		var event runharness.RunEvent
		if err := json.Unmarshal(line, &event); err != nil {
			t.Fatalf("decode JSONL line %d: %v; line=%q", index, err, line)
		}
		events = append(events, event)
	}
	return events
}

func TestRunAgentCancellationPersistsControlCommand(t *testing.T) {
	runtime := &fakeAgentRuntime{
		submitReceipts: []runharness.AgentInputReceipt{{RequestID: "req", SessionID: "s", RunID: "r", State: runharness.RunStateRunningModel}},
		readResults:    []runharness.RunReadResult{{Run: runharness.RunSnapshot{ID: "r", State: runharness.RunStateRunningModel, Revision: 7}}},
	}
	installFakeAgentRuntime(t, runtime)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var stdout, stderr bytes.Buffer
	code := runAgentRun(ctx, []string{"--prompt", "cancel", "--json"}, &stdout, &stderr)
	if code != ExitCancelled {
		t.Fatalf("exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.controlRequests) != 1 || runtime.controlRequests[0].Action != runharness.ControlCancel || runtime.controlRequests[0].RunID != "r" {
		t.Fatalf("controls = %#v", runtime.controlRequests)
	}
	if runtime.controlRequests[0].RequestID == "" {
		t.Fatal("cancel control has no idempotency key")
	}
	if runtime.controlRequests[0].ExpectedRevision != 7 {
		t.Fatalf("cancel expected revision = %d, want 7", runtime.controlRequests[0].ExpectedRevision)
	}
}

func TestCancelAgentRunDoesNotMutateWhenCurrentRunCannotBeRead(t *testing.T) {
	runtime := &fakeAgentRuntime{readErr: errors.New("ledger unavailable")}
	terminal, state := cancelAgentRun(context.Background(), runtime, "run-1")
	if terminal || state != "" {
		t.Fatalf("result = terminal:%t state:%q", terminal, state)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.controlRequests) != 0 {
		t.Fatalf("controls = %#v, want none after failed read", runtime.controlRequests)
	}
}

func TestCancelAgentRunDoesNotMutateAnAlreadyTerminalRun(t *testing.T) {
	runtime := &fakeAgentRuntime{readResults: []runharness.RunReadResult{{
		Run: runharness.RunSnapshot{ID: "run-1", State: runharness.RunStateCompleted, Revision: 4},
	}}}
	terminal, state := cancelAgentRun(context.Background(), runtime, "run-1")
	if !terminal || state != runharness.RunStateCompleted {
		t.Fatalf("result = terminal:%t state:%q", terminal, state)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.controlRequests) != 0 {
		t.Fatalf("controls = %#v, want none for terminal run", runtime.controlRequests)
	}
}

func TestCancelAgentRunSurfacesRevisionConflictInsteadOfClaimingCanceled(t *testing.T) {
	runtime := &fakeAgentRuntime{
		controlErr: runharness.ErrRevisionConflict,
		readResults: []runharness.RunReadResult{{
			Run: runharness.RunSnapshot{ID: "run-1", State: runharness.RunStateRunningModel, Revision: 4},
		}},
	}
	terminal, state, err := cancelAgentRunWithError(context.Background(), runtime, "run-1")
	if terminal || state != "" {
		t.Fatalf("result = terminal:%t state:%q", terminal, state)
	}
	if !errors.Is(err, runharness.ErrRevisionConflict) {
		t.Fatalf("error = %v, want revision conflict", err)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.controlRequests) != 2 {
		t.Fatalf("control requests = %d, want one refresh retry", len(runtime.controlRequests))
	}
	if runtime.controlRequests[0].ExpectedRevision != 4 || runtime.controlRequests[1].ExpectedRevision != 4 {
		t.Fatalf("control revisions = %#v", runtime.controlRequests)
	}
}

func TestRunAgentControlGeneratesRequestIDWhenOmitted(t *testing.T) {
	runtime := &fakeAgentRuntime{controlSnapshot: runharness.RunSnapshot{ID: "r", State: runharness.RunStateInterrupted}}
	capture := installFakeAgentRuntime(t, runtime)
	var stdout, stderr bytes.Buffer
	if code := runAgentControl(context.Background(), "resume", []string{"r", "--expected-revision", "1", "--json"}, &stdout, &stderr); code != ExitActionRequired {
		t.Fatalf("exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.controlRequests) != 1 {
		t.Fatalf("controls = %#v", runtime.controlRequests)
	}
	control := runtime.controlRequests[0]
	if control.Action != runharness.ControlResume || control.RunID != "r" || control.RequestID == "" {
		t.Fatalf("control = %#v", control)
	}
	if capture.Options.StartWorkers {
		t.Fatal("resume command must not start unrelated harness workers")
	}
	if runtime.closeCalls != 0 {
		t.Fatalf("non-terminal resume closed the runtime %d times", runtime.closeCalls)
	}
}

func TestRunAgentRecoverRequiresExplicitAction(t *testing.T) {
	started := false
	previous := newAgentHarness
	newAgentHarness = func(context.Context, AgentHarnessOptions) (AgentHarnessRuntime, error) {
		started = true
		return nil, errors.New("factory must not run without a recovery action")
	}
	t.Cleanup(func() { newAgentHarness = previous })
	var stdout, stderr bytes.Buffer
	code := runAgentRecover(context.Background(), []string{"run-1"}, &stdout, &stderr)
	if code != ExitUsage || started || !strings.Contains(stderr.String(), `"code":"usage"`) {
		t.Fatalf("exit=%d started=%t stdout=%q stderr=%q", code, started, stdout.String(), stderr.String())
	}
}

func TestRunAgentRecoverForwardsUnknownToolCallID(t *testing.T) {
	runtime := &fakeAgentRuntime{controlSnapshot: runharness.RunSnapshot{ID: "run-1", State: runharness.RunStateRunningModel}}
	capture := installFakeAgentRuntime(t, runtime)
	var stdout, stderr bytes.Buffer
	code := runAgentRecover(context.Background(), []string{
		"run-1", "--action", "mark-completed", "--call-id", "call-7", "--expected-revision", "1", "--json",
	}, &stdout, &stderr)
	if code != ExitActionRequired {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.controlRequests) != 1 || runtime.controlRequests[0].CallID != "call-7" || runtime.controlRequests[0].Action != runharness.ControlMarkCompleted {
		t.Fatalf("control requests = %#v", runtime.controlRequests)
	}
	if capture.Options.StartWorkers {
		t.Fatal("recovery command must not start unrelated harness workers")
	}
	if runtime.closeCalls != 0 {
		t.Fatalf("non-terminal recovery closed the runtime %d times", runtime.closeCalls)
	}
}

func TestReadOnlyAgentCommandsDoNotStartWorkers(t *testing.T) {
	t.Run("list", func(t *testing.T) {
		runtime := &fakeAgentRuntime{}
		capture := installFakeAgentRuntime(t, runtime)
		var stdout, stderr bytes.Buffer
		if code := runAgentList(context.Background(), []string{"--json"}, &stdout, &stderr); code != ExitSuccess {
			t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
		}
		if capture.Options.StartWorkers {
			t.Fatal("list command started workers")
		}
		if runtime.closeCalls != 1 {
			t.Fatalf("list close calls=%d, want 1", runtime.closeCalls)
		}
	})

	t.Run("show", func(t *testing.T) {
		runtime := &fakeAgentRuntime{readResults: []runharness.RunReadResult{{Run: runharness.RunSnapshot{ID: "r", State: runharness.RunStateCompleted}}}}
		capture := installFakeAgentRuntime(t, runtime)
		var stdout, stderr bytes.Buffer
		if code := runAgentShow(context.Background(), []string{"r", "--json"}, &stdout, &stderr); code != ExitSuccess {
			t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
		}
		if capture.Options.StartWorkers {
			t.Fatal("show command started workers")
		}
		if runtime.closeCalls != 1 {
			t.Fatalf("show close calls=%d, want 1", runtime.closeCalls)
		}
	})

	t.Run("snapshot", func(t *testing.T) {
		runtime := &fakeAgentRuntime{}
		capture := installFakeAgentRuntime(t, runtime)
		path := filepath.Join(t.TempDir(), "workspace.json")
		data, err := json.Marshal(runharness.WorkspaceSnapshot{
			SourceKind:       runharness.WorkspaceCLI,
			SourceID:         "cli-source",
			SourceInstanceID: "instance",
			Revision:         1,
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		var stdout, stderr bytes.Buffer
		if code := runAgentSnapshot(context.Background(), []string{"--file", path, "--json"}, &stdout, &stderr); code != ExitSuccess {
			t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
		}
		if capture.Options.StartWorkers {
			t.Fatal("snapshot command started workers")
		}
		if runtime.closeCalls != 1 {
			t.Fatalf("snapshot close calls=%d, want 1", runtime.closeCalls)
		}
	})
}
