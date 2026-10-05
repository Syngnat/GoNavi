package cli

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai/runharness"
)

func TestRunAgentChatReusesCreatedSessionAcrossLines(t *testing.T) {
	runtime := &fakeAgentRuntime{submitReceipts: []runharness.AgentInputReceipt{
		{RequestID: "one", SessionID: "created-session", RunID: "run-1", State: runharness.RunStateCompleted},
		{RequestID: "two", SessionID: "created-session", RunID: "run-2", State: runharness.RunStateCompleted},
	}, readSessionResults: []runharness.SessionProjection{{ID: "created-session", Revision: 17}}}
	installFakeAgentRuntime(t, runtime)
	restoreInput := SetAgentCLIInput(strings.NewReader("one\ntwo\n"))
	defer restoreInput()
	var stdout, stderr bytes.Buffer
	if code := runAgentChat(context.Background(), []string{"--jsonl", "--poll", "1ms"}, &stdout, &stderr); code != ExitSuccess {
		t.Fatalf("exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.submitRequests) != 2 {
		t.Fatalf("requests = %#v", runtime.submitRequests)
	}
	if runtime.submitRequests[0].SessionID != "" || runtime.submitRequests[1].SessionID != "created-session" {
		t.Fatalf("session propagation = %#v", runtime.submitRequests)
	}
	if runtime.submitRequests[0].ExpectedRevision != 0 || runtime.submitRequests[1].ExpectedRevision != 17 {
		t.Fatalf("expected revisions = %#v", runtime.submitRequests)
	}
	if len(runtime.readSessionRequests) != 1 || runtime.readSessionRequests[0].SessionID != "created-session" {
		t.Fatalf("session reads = %#v", runtime.readSessionRequests)
	}
}

func TestRunAgentChatStopsBeforeSubmittingWhenSessionRevisionReadFails(t *testing.T) {
	runtime := &fakeAgentRuntime{
		submitReceipts: []runharness.AgentInputReceipt{{
			RequestID: "one", SessionID: "created-session", RunID: "run-1", State: runharness.RunStateCompleted,
		}},
		readSessionErr: errors.New("ledger unavailable"),
	}
	installFakeAgentRuntime(t, runtime)
	restoreInput := SetAgentCLIInput(strings.NewReader("one\ntwo\n"))
	defer restoreInput()

	var stdout, stderr bytes.Buffer
	if code := runAgentChat(context.Background(), []string{"--jsonl", "--poll", "1ms"}, &stdout, &stderr); code != ExitExecution {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if !strings.Contains(stderr.String(), "read session revision") {
		t.Fatalf("stderr=%q, want session revision read failure", stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.submitRequests) != 1 {
		t.Fatalf("submit requests = %#v, want only first input", runtime.submitRequests)
	}
	if len(runtime.readSessionRequests) != 1 || runtime.readSessionRequests[0].SessionID != "created-session" {
		t.Fatalf("session reads = %#v", runtime.readSessionRequests)
	}
}

func TestRunAgentChatSteerDoesNotUseSessionRevisionAsRunRevision(t *testing.T) {
	runtime := &fakeAgentRuntime{
		submitReceipts: []runharness.AgentInputReceipt{
			{RequestID: "one", SessionID: "created-session", RunID: "run-1", State: runharness.RunStateCompleted},
			{RequestID: "two", SessionID: "created-session", RunID: "run-2", State: runharness.RunStateCompleted},
		},
		readSessionErr: errors.New("must not read session revision for steer"),
	}
	installFakeAgentRuntime(t, runtime)
	restoreInput := SetAgentCLIInput(strings.NewReader("one\ntwo\n"))
	defer restoreInput()

	var stdout, stderr bytes.Buffer
	if code := runAgentChat(context.Background(), []string{"--dispatch", "steer", "--jsonl", "--poll", "1ms"}, &stdout, &stderr); code != ExitSuccess {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.submitRequests) != 2 || runtime.submitRequests[1].ExpectedRevision != 0 {
		t.Fatalf("steer requests = %#v", runtime.submitRequests)
	}
	if len(runtime.readSessionRequests) != 0 {
		t.Fatalf("steer read session projection = %#v", runtime.readSessionRequests)
	}
}

type agentCLIErrorReader struct{ err error }

func (r agentCLIErrorReader) Read([]byte) (int, error) { return 0, r.err }

func TestRunAgentChatEOFDetachesDurableRuntime(t *testing.T) {
	runtime := &fakeAgentRuntime{}
	installFakeAgentRuntime(t, runtime)
	restoreInput := SetAgentCLIInput(strings.NewReader(""))
	defer restoreInput()

	var stdout, stderr bytes.Buffer
	if code := runAgentChat(context.Background(), []string{"--jsonl", "--poll", "1ms"}, &stdout, &stderr); code != ExitSuccess {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.closeCalls != 0 {
		t.Fatalf("EOF closed durable runtime %d times", runtime.closeCalls)
	}
}

func TestRunAgentChatScannerErrorDetachesDurableRuntime(t *testing.T) {
	scanErr := errors.New("stdin read failed")
	runtime := &fakeAgentRuntime{}
	installFakeAgentRuntime(t, runtime)
	restoreInput := SetAgentCLIInput(agentCLIErrorReader{err: scanErr})
	defer restoreInput()

	var stdout, stderr bytes.Buffer
	if code := runAgentChat(context.Background(), []string{"--jsonl", "--poll", "1ms"}, &stdout, &stderr); code != ExitExecution {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if !strings.Contains(stderr.String(), "input_failed") {
		t.Fatalf("stderr=%q, want input_failed", stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.closeCalls != 0 {
		t.Fatalf("scanner error closed durable runtime %d times", runtime.closeCalls)
	}
}

func TestRunAgentSubmitErrorDetachesDurableRuntime(t *testing.T) {
	submitErr := errors.New("submit response lost")
	runtime := &fakeAgentRuntime{submitErr: submitErr}
	installFakeAgentRuntime(t, runtime)

	var stdout, stderr bytes.Buffer
	if code := runAgentRun(context.Background(), []string{"--prompt", "hello", "--json"}, &stdout, &stderr); code != ExitExecution {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.closeCalls != 0 {
		t.Fatalf("ambiguous submit error closed durable runtime %d times", runtime.closeCalls)
	}
}

func TestRunAgentControlErrorsDetachDurableRuntime(t *testing.T) {
	for _, tc := range []struct {
		name string
		call func(*bytes.Buffer, *bytes.Buffer) int
	}{
		{
			name: "control",
			call: func(stdout, stderr *bytes.Buffer) int {
				return runAgentControl(context.Background(), "resume", []string{"run-1", "--expected-revision", "1", "--json"}, stdout, stderr)
			},
		},
		{
			name: "approval",
			call: func(stdout, stderr *bytes.Buffer) int {
				return runAgentApproval(context.Background(), "approve", []string{"run-1", "--approval-id", "a", "--call-id", "c", "--args-hash", "hash-1", "--expected-revision", "1", "--json"}, stdout, stderr)
			},
		},
		{
			name: "recovery",
			call: func(stdout, stderr *bytes.Buffer) int {
				return runAgentRecover(context.Background(), []string{"run-1", "--action", "retry", "--expected-revision", "1", "--json"}, stdout, stderr)
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			runtime := &fakeAgentRuntime{controlErr: errors.New("control response lost")}
			installFakeAgentRuntime(t, runtime)
			var stdout, stderr bytes.Buffer
			if code := tc.call(&stdout, &stderr); code != ExitExecution {
				t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
			}
			runtime.mu.Lock()
			defer runtime.mu.Unlock()
			if runtime.closeCalls != 0 {
				t.Fatalf("control error closed durable runtime %d times", runtime.closeCalls)
			}
		})
	}
}

func TestRunAgentWaitTimeoutDoesNotCancelRun(t *testing.T) {
	runtime := &fakeAgentRuntime{
		submitReceipts: []runharness.AgentInputReceipt{{RequestID: "req", SessionID: "s", RunID: "r", State: runharness.RunStateRunningModel}},
		readResults:    []runharness.RunReadResult{{Run: runharness.RunSnapshot{ID: "r", State: runharness.RunStateRunningModel}}},
	}
	capture := installFakeAgentRuntime(t, runtime)
	var stdout, stderr bytes.Buffer
	code := runAgentRun(context.Background(), []string{"--prompt", "slow", "--timeout", "5ms", "--poll", "100ms", "--json"}, &stdout, &stderr)
	if code != ExitActionRequired {
		t.Fatalf("exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	if _, hasDeadline := capture.Context.Deadline(); hasDeadline {
		t.Fatal("harness factory received command timeout context")
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.controlRequests) != 0 {
		t.Fatalf("timeout unexpectedly sent controls = %#v", runtime.controlRequests)
	}
	if len(runtime.submitContexts) != 1 {
		t.Fatalf("submit contexts = %d, want 1", len(runtime.submitContexts))
	}
	if _, hasDeadline := runtime.submitContexts[0].Deadline(); hasDeadline {
		t.Fatal("harness SubmitInput received command timeout context")
	}
	if !capture.Options.StartWorkers {
		t.Fatal("agent run must start harness workers")
	}
	if runtime.closeCalls != 0 {
		t.Fatalf("timeout closed the active runtime %d times", runtime.closeCalls)
	}
}

func TestRunAgentApprovalTimeoutDoesNotCancelDurableDecision(t *testing.T) {
	runtime := &fakeAgentRuntime{
		controlSnapshot: runharness.RunSnapshot{ID: "r", State: runharness.RunStateRunningModel},
		readResults: []runharness.RunReadResult{{
			Run: runharness.RunSnapshot{ID: "r", State: runharness.RunStateRunningModel},
		}},
	}
	capture := installFakeAgentRuntime(t, runtime)
	var stdout, stderr bytes.Buffer
	code := runAgentApproval(context.Background(), "approve", []string{
		"r", "--approval-id", "a", "--call-id", "call-1", "--args-hash", "hash-1", "--expected-revision", "1", "--timeout", "5ms", "--poll", "100ms", "--json",
	}, &stdout, &stderr)
	if code != ExitActionRequired {
		t.Fatalf("exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.controlContexts) != 1 {
		t.Fatalf("control contexts = %d, want 1", len(runtime.controlContexts))
	}
	if _, hasDeadline := runtime.controlContexts[0].Deadline(); hasDeadline {
		t.Fatal("harness ControlRun received command timeout context")
	}
	if capture.Options.StartWorkers {
		t.Fatal("approval command must not start unrelated harness workers")
	}
	if runtime.closeCalls != 0 {
		t.Fatalf("approval timeout closed the active runtime %d times", runtime.closeCalls)
	}
}

func TestRunAgentApprovalNoWaitDoesNotCloseActiveRuntime(t *testing.T) {
	runtime := &fakeAgentRuntime{controlSnapshot: runharness.RunSnapshot{ID: "r", State: runharness.RunStateRunningModel}}
	capture := installFakeAgentRuntime(t, runtime)
	var stdout, stderr bytes.Buffer
	code := runAgentApproval(context.Background(), "approve", []string{
		"r", "--approval-id", "a", "--call-id", "call-1", "--args-hash", "hash-1", "--expected-revision", "1", "--no-wait", "--json",
	}, &stdout, &stderr)
	if code != ExitActionRequired {
		t.Fatalf("exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if capture.Options.StartWorkers {
		t.Fatal("approval command must not start unrelated harness workers")
	}
	if runtime.closeCalls != 0 {
		t.Fatalf("approval --no-wait closed the active runtime %d times", runtime.closeCalls)
	}
}

func TestRunAgentTimeoutBeforeFirstProjectionDoesNotCloseRun(t *testing.T) {
	blocked := make(chan struct{})
	runtime := &fakeAgentRuntime{
		submitReceipts: []runharness.AgentInputReceipt{{RequestID: "req", SessionID: "s", RunID: "r", State: runharness.RunStateRunningModel}},
		readBlock:      blocked,
	}
	installFakeAgentRuntime(t, runtime)
	var stdout, stderr bytes.Buffer
	code := runAgentRun(context.Background(), []string{"--prompt", "slow", "--timeout", "5ms", "--poll", "1ms", "--json"}, &stdout, &stderr)
	if code != ExitActionRequired {
		t.Fatalf("exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.closeCalls != 0 {
		t.Fatalf("timeout before first projection closed the active runtime %d times", runtime.closeCalls)
	}
}

func TestRunAgentChatRecoveryRequiredDoesNotCloseRuntime(t *testing.T) {
	runtime := &fakeAgentRuntime{
		submitReceipts: []runharness.AgentInputReceipt{{RequestID: "req", SessionID: "s", RunID: "r", State: runharness.RunStateRunningModel}},
		readResults:    []runharness.RunReadResult{{Run: runharness.RunSnapshot{ID: "r", State: runharness.RunStateRecoveryRequired}}},
	}
	installFakeAgentRuntime(t, runtime)
	var stdout, stderr bytes.Buffer
	code := runAgentChat(context.Background(), []string{"--prompt", "continue", "--json", "--poll", "1ms"}, &stdout, &stderr)
	if code != ExitUnknownOutcome {
		t.Fatalf("exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.closeCalls != 0 {
		t.Fatalf("recovery-required chat closed the runtime %d times", runtime.closeCalls)
	}
}
