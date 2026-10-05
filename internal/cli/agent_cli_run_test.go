package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/ai/runharness"
)

func TestRunAgentHelpDoesNotStartHarness(t *testing.T) {
	started := false
	previous := newAgentHarness
	newAgentHarness = func(context.Context, AgentHarnessOptions) (AgentHarnessRuntime, error) {
		started = true
		return nil, errors.New("factory must not run for help")
	}
	t.Cleanup(func() { newAgentHarness = previous })

	var stdout, stderr bytes.Buffer
	if code := runAgentRun(context.Background(), []string{"--help"}, &stdout, &stderr); code != ExitSuccess {
		t.Fatalf("help exit = %d, stderr=%s", code, stderr.String())
	}
	if started {
		t.Fatal("agent harness started while showing help")
	}
}

func TestRunAgentRejectsMultiplePromptSourcesBeforeHarness(t *testing.T) {
	started := false
	previous := newAgentHarness
	newAgentHarness = func(context.Context, AgentHarnessOptions) (AgentHarnessRuntime, error) {
		started = true
		return nil, errors.New("factory must not run for invalid prompt")
	}
	t.Cleanup(func() { newAgentHarness = previous })

	var stdout, stderr bytes.Buffer
	code := runAgentRun(context.Background(), []string{"--prompt", "one", "two"}, &stdout, &stderr)
	if code != ExitUsage || started || !strings.Contains(stderr.String(), `"code":"usage"`) {
		t.Fatalf("exit=%d started=%t stdout=%q stderr=%q", code, started, stdout.String(), stderr.String())
	}
}

func TestRunAgentForwardsInputOverridesAndContext(t *testing.T) {
	runtime := &fakeAgentRuntime{submitReceipts: []runharness.AgentInputReceipt{{
		RequestID: "req-1", SessionID: "session-1", RunID: "run-1", Disposition: "started", State: runharness.RunStateQueued,
	}}}
	capture := installFakeAgentRuntime(t, runtime)

	snapshotPath := filepath.Join(t.TempDir(), "workspace.json")
	snapshot := runharness.WorkspaceSnapshot{
		SourceKind:       runharness.WorkspaceCLI,
		SourceID:         "cli-source",
		SourceInstanceID: "instance-1",
		Revision:         4,
		CLIContext:       &runharness.CLIWorkspaceContext{CWD: "/tmp/project"},
	}
	data, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(snapshotPath, data, 0o600); err != nil {
		t.Fatal(err)
	}

	var stdout, stderr bytes.Buffer
	code := runAgentRun(context.Background(), []string{
		"--session", "session-1", "--request-id", "req-1", "--expected-revision", "9",
		"--prompt", "inspect", "--provider", "custom", "--model", "glm-4", "--thinking", "high",
		"--temperature", "0.35", "--max-tokens", "2048", "--dispatch", "queue",
		"--context-file", snapshotPath, "--policy", "max-tool-rounds=20,default-tool-timeout=2s", "--no-wait", "--json",
	}, &stdout, &stderr)
	if code != ExitActionRequired {
		t.Fatalf("exit = %d, stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.submitRequests) != 1 {
		t.Fatalf("submit requests = %#v", runtime.submitRequests)
	}
	request := runtime.submitRequests[0]
	if request.RequestID != "req-1" || request.SessionID != "session-1" || request.Content != "inspect" || request.ContextSourceID != "cli-source" || request.ContextSourceInstanceID != "instance-1" || request.ExpectedRevision != 9 {
		t.Fatalf("request = %#v", request)
	}
	if request.Provider != "custom" || request.Model != "glm-4" || request.Thinking != "high" || request.DispatchMode != runharness.DispatchQueue {
		t.Fatalf("provider/model overrides = %#v", request)
	}
	if request.Temperature == nil || *request.Temperature != 0.35 || request.MaxTokens == nil || *request.MaxTokens != 2048 {
		t.Fatalf("numeric overrides = %#v", request)
	}
	if len(runtime.snapshots) != 1 || runtime.snapshots[0].SourceID != "cli-source" || runtime.snapshots[0].SourceInstanceID != "instance-1" || runtime.snapshots[0].ContentHash == "" {
		t.Fatalf("snapshots = %#v", runtime.snapshots)
	}
	if capture.Options.Policy.MaxToolRounds != 20 || capture.Options.Policy.DefaultToolTimeout != 2*time.Second {
		t.Fatalf("policy = %#v", capture.Options.Policy)
	}
	if capture.Options.Policy.DefaultDispatchMode != runharness.DispatchQueue {
		t.Fatalf("policy dispatch = %q", capture.Options.Policy.DefaultDispatchMode)
	}
	if !capture.Options.StartWorkers {
		t.Fatal("agent run must start harness workers")
	}
	if runtime.closeCalls != 0 {
		t.Fatalf("--no-wait closed the runtime %d times", runtime.closeCalls)
	}
	var receipt runharness.AgentInputReceipt
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &receipt); err != nil {
		t.Fatalf("JSON receipt: %v; output=%s", err, stdout.String())
	}
	if receipt.RunID != "run-1" {
		t.Fatalf("receipt = %#v", receipt)
	}
}

func TestRunAgentReadsExistingSessionRevisionForQueue(t *testing.T) {
	runtime := &fakeAgentRuntime{
		submitReceipts: []runharness.AgentInputReceipt{{
			RequestID: "req-existing", SessionID: "existing-session", RunID: "run-existing",
			Disposition: "queued", State: runharness.RunStateQueued,
		}},
		readSessionResults: []runharness.SessionProjection{{ID: "existing-session", Revision: 23}},
	}
	installFakeAgentRuntime(t, runtime)

	var stdout, stderr bytes.Buffer
	code := runAgentRun(context.Background(), []string{
		"--session", "existing-session", "--request-id", "req-existing", "--prompt", "continue", "--no-wait", "--json",
	}, &stdout, &stderr)
	if code != ExitActionRequired {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.readSessionRequests) != 1 || runtime.readSessionRequests[0].SessionID != "existing-session" {
		t.Fatalf("session reads=%#v, want one existing-session read", runtime.readSessionRequests)
	}
	if len(runtime.submitRequests) != 1 || runtime.submitRequests[0].ExpectedRevision != 23 {
		t.Fatalf("submit requests=%#v, want revision 23", runtime.submitRequests)
	}
}

func TestRunAgentStopsBeforeSubmittingWhenExistingSessionRevisionReadFails(t *testing.T) {
	runtime := &fakeAgentRuntime{readSessionErr: errors.New("ledger unavailable")}
	installFakeAgentRuntime(t, runtime)

	var stdout, stderr bytes.Buffer
	code := runAgentRun(context.Background(), []string{
		"--session", "existing-session", "--prompt", "continue", "--no-wait", "--json",
	}, &stdout, &stderr)
	if code != ExitExecution {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if !strings.Contains(stderr.String(), "read session revision") {
		t.Fatalf("stderr=%q, want session revision read failure", stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.readSessionRequests) != 1 || len(runtime.submitRequests) != 0 {
		t.Fatalf("session reads=%#v submits=%#v, want read and no submit", runtime.readSessionRequests, runtime.submitRequests)
	}
	if runtime.closeCalls != 0 {
		t.Fatalf("revision read failure closed runtime %d times", runtime.closeCalls)
	}
}

func TestRunAgentSteerDoesNotReadExistingSessionRevision(t *testing.T) {
	runtime := &fakeAgentRuntime{
		submitReceipts: []runharness.AgentInputReceipt{{
			RequestID: "req-steer", SessionID: "existing-session", RunID: "run-steer",
			Disposition: "started", State: runharness.RunStateQueued,
		}},
		readSessionErr: errors.New("must not read session revision for steer"),
	}
	installFakeAgentRuntime(t, runtime)

	var stdout, stderr bytes.Buffer
	code := runAgentRun(context.Background(), []string{
		"--session", "existing-session", "--request-id", "req-steer", "--prompt", "redirect", "--dispatch", "steer", "--no-wait", "--json",
	}, &stdout, &stderr)
	if code != ExitActionRequired {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.readSessionRequests) != 0 {
		t.Fatalf("session reads=%#v, want none for steer", runtime.readSessionRequests)
	}
	if len(runtime.submitRequests) != 1 || runtime.submitRequests[0].ExpectedRevision != 0 {
		t.Fatalf("submit requests=%#v, want steer revision unchanged", runtime.submitRequests)
	}
}

func TestRunAgentBuildsCLISnapshotWhenContextFileIsOmitted(t *testing.T) {
	runtime := &fakeAgentRuntime{submitReceipts: []runharness.AgentInputReceipt{{
		RequestID: "req-native", SessionID: "session-native", RunID: "run-native", Disposition: "started", State: runharness.RunStateCompleted,
	}}}
	installFakeAgentRuntime(t, runtime)

	var stdout, stderr bytes.Buffer
	if code := runAgentRun(context.Background(), []string{
		"--request-id", "req-native", "--prompt", "inspect", "--no-wait", "--json",
	}, &stdout, &stderr); code != ExitSuccess {
		t.Fatalf("exit = %d, stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}

	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.snapshots) != 1 {
		t.Fatalf("snapshots = %#v", runtime.snapshots)
	}
	snapshot := runtime.snapshots[0]
	if snapshot.SourceKind != runharness.WorkspaceCLI || snapshot.SourceID == "" || snapshot.SourceInstanceID == "" || snapshot.ContentHash == "" {
		t.Fatalf("native snapshot = %#v", snapshot)
	}
	if !strings.HasPrefix(snapshot.SourceID, "cli-") {
		t.Fatalf("native source ID = %q, want hashed cli prefix", snapshot.SourceID)
	}
	if snapshot.CLIContext == nil || snapshot.CLIContext.CWD == "" || snapshot.CLIContext.Command != "gonavi agent run" {
		t.Fatalf("native CLI context = %#v", snapshot.CLIContext)
	}
	if len(runtime.submitRequests) != 1 {
		t.Fatalf("submit requests = %#v", runtime.submitRequests)
	}
	request := runtime.submitRequests[0]
	if request.ContextSourceID != snapshot.SourceID || request.ContextSourceInstanceID != snapshot.SourceInstanceID {
		t.Fatalf("input source binding = %#v, snapshot = %#v", request, snapshot)
	}
}

func TestRunAgentRejectsNonCLISnapshotContextFile(t *testing.T) {
	runtime := &fakeAgentRuntime{}
	installFakeAgentRuntime(t, runtime)

	path := filepath.Join(t.TempDir(), "desktop-workspace.json")
	data, err := json.Marshal(runharness.WorkspaceSnapshot{
		SourceKind:       runharness.WorkspaceDesktop,
		SourceID:         "desktop-source",
		SourceInstanceID: "desktop-instance",
		Revision:         1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}

	var stdout, stderr bytes.Buffer
	if code := runAgentRun(context.Background(), []string{
		"--prompt", "inspect", "--context-file", path,
	}, &stdout, &stderr); code != ExitUsage {
		t.Fatalf("exit = %d, stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	if !strings.Contains(stderr.String(), "context_invalid") || !strings.Contains(stderr.String(), "sourceKind") {
		t.Fatalf("error = %q", stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.submitRequests) != 0 || len(runtime.snapshots) != 0 {
		t.Fatalf("non-CLI snapshot reached harness: requests=%#v snapshots=%#v", runtime.submitRequests, runtime.snapshots)
	}
}

func TestRunAgentSnapshotRejectsNonCLISnapshotBeforeHarness(t *testing.T) {
	path := filepath.Join(t.TempDir(), "desktop-workspace.json")
	data, err := json.Marshal(runharness.WorkspaceSnapshot{
		SourceKind:       runharness.WorkspaceDesktop,
		SourceID:         "desktop-source",
		SourceInstanceID: "desktop-instance",
		Revision:         1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}

	started := false
	previous := newAgentHarness
	newAgentHarness = func(context.Context, AgentHarnessOptions) (AgentHarnessRuntime, error) {
		started = true
		return nil, errors.New("harness must not start for a desktop snapshot")
	}
	t.Cleanup(func() { newAgentHarness = previous })

	var stdout, stderr bytes.Buffer
	if code := runAgentSnapshot(context.Background(), []string{"--file", path}, &stdout, &stderr); code != ExitUsage {
		t.Fatalf("exit = %d, stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	if started {
		t.Fatal("desktop snapshot opened the harness")
	}
	if !strings.Contains(stderr.String(), "snapshot_invalid") || !strings.Contains(stderr.String(), "sourceKind") {
		t.Fatalf("error = %q", stderr.String())
	}
}

func TestAgentWorkspaceSnapshotRenewalRepublishesSameBinding(t *testing.T) {
	runtime := &fakeAgentRuntime{}
	snapshot, err := newAgentCLIWorkspaceSnapshot("renew-source", "gonavi agent run")
	if err != nil {
		t.Fatal(err)
	}
	binding := agentWorkspaceSnapshotBinding{
		SourceID:         snapshot.SourceID,
		SourceInstanceID: snapshot.SourceInstanceID,
		Snapshot:         snapshot,
	}
	if err := binding.Publish(context.Background(), runtime); err != nil {
		t.Fatal(err)
	}

	previous := agentWorkspaceSnapshotRenewInterval
	agentWorkspaceSnapshotRenewInterval = time.Millisecond
	t.Cleanup(func() { agentWorkspaceSnapshotRenewInterval = previous })
	renewal := startAgentWorkspaceSnapshotRenewal(context.Background(), runtime, binding)
	t.Cleanup(renewal.Close)

	deadline := time.Now().Add(time.Second)
	for {
		runtime.mu.Lock()
		count := len(runtime.snapshots)
		runtime.mu.Unlock()
		if count >= 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("snapshot renewal did not publish again; snapshots=%#v", runtime.snapshots)
		}
		time.Sleep(time.Millisecond)
	}

	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	for _, renewed := range runtime.snapshots[1:] {
		if renewed.SourceID != snapshot.SourceID || renewed.SourceInstanceID != snapshot.SourceInstanceID || renewed.Revision != snapshot.Revision || renewed.ContentHash != snapshot.ContentHash {
			t.Fatalf("renewed snapshot changed identity/content: %#v, want %#v", renewed, snapshot)
		}
	}
}

func TestRunAgentJSONEmitsOnlyStableRunProjection(t *testing.T) {
	runtime := &fakeAgentRuntime{
		submitReceipts: []runharness.AgentInputReceipt{{RequestID: "req", SessionID: "s", RunID: "r", State: runharness.RunStateRunningModel}},
		readResults:    []runharness.RunReadResult{{Run: runharness.RunSnapshot{ID: "r", State: runharness.RunStateCompleted}, NextSequence: 1}},
	}
	installFakeAgentRuntime(t, runtime)
	var stdout, stderr bytes.Buffer
	if code := runAgentRun(context.Background(), []string{"--prompt", "hello", "--json", "--poll", "1ms"}, &stdout, &stderr); code != ExitSuccess {
		t.Fatalf("exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	var result runharness.RunReadResult
	decoder := json.NewDecoder(bytes.NewReader(stdout.Bytes()))
	if err := decoder.Decode(&result); err != nil {
		t.Fatalf("decode result: %v; output=%s", err, stdout.String())
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		t.Fatalf("expected one JSON result, extra=%#v err=%v output=%s", extra, err, stdout.String())
	}
	if result.Run.State != runharness.RunStateCompleted {
		t.Fatalf("result = %#v", result)
	}
}

func TestRunAgentWaitsPastInitialQueuedState(t *testing.T) {
	runtime := &fakeAgentRuntime{
		submitReceipts: []runharness.AgentInputReceipt{{
			RequestID: "queued-wait", SessionID: "queued-session", RunID: "queued-run", State: runharness.RunStateQueued,
		}},
		readResults: []runharness.RunReadResult{
			{Run: runharness.RunSnapshot{ID: "queued-run", State: runharness.RunStateQueued}},
			{Run: runharness.RunSnapshot{ID: "queued-run", State: runharness.RunStateCompleted}, NextSequence: 1},
		},
		advanceReadResults: true,
	}
	installFakeAgentRuntime(t, runtime)

	var stdout, stderr bytes.Buffer
	if code := runAgentRun(context.Background(), []string{"--prompt", "hello", "--json", "--poll", "1ms"}, &stdout, &stderr); code != ExitSuccess {
		t.Fatalf("exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	var result runharness.RunReadResult
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &result); err != nil {
		t.Fatalf("decode result: %v; output=%s", err, stdout.String())
	}
	if result.Run.State != runharness.RunStateCompleted {
		t.Fatalf("result state = %s, want completed", result.Run.State)
	}
}

func TestRunAgentJSONLContainsOnlyTypedRunEvents(t *testing.T) {
	events := []runharness.RunEvent{
		{
			SchemaVersion: 1, RunID: "run-jsonl", SessionID: "session-jsonl", Sequence: 1,
			Kind: runharness.EventInput, ResultingState: runharness.RunStateRunningModel,
			Payload: mustJSON(runharness.InputEvent{RequestID: "request-jsonl"}),
		},
		{
			SchemaVersion: 1, RunID: "run-jsonl", SessionID: "session-jsonl", Sequence: 2,
			Kind: runharness.EventTerminal, ResultingState: runharness.RunStateCompleted,
			Payload: mustJSON(runharness.TerminalEvent{Reason: "completed"}),
		},
	}
	runtime := &fakeAgentRuntime{
		submitReceipts: []runharness.AgentInputReceipt{{
			RequestID: "request-jsonl", SessionID: "session-jsonl", RunID: "run-jsonl",
			Disposition: "started", State: runharness.RunStateRunningModel,
		}},
		readResults: []runharness.RunReadResult{{
			Run:    runharness.RunSnapshot{ID: "run-jsonl", State: runharness.RunStateCompleted},
			Events: events,
		}},
	}
	installFakeAgentRuntime(t, runtime)

	var stdout, stderr bytes.Buffer
	if code := runAgentRun(context.Background(), []string{
		"--prompt", "hello", "--jsonl", "--poll", "1ms",
	}, &stdout, &stderr); code != ExitSuccess {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	got := decodeAgentJSONLEvents(t, stdout.Bytes())
	if len(got) != len(events) {
		t.Fatalf("JSONL event count=%d, want %d; output=%q", len(got), len(events), stdout.String())
	}
	for index, event := range got {
		if event.RunID != "run-jsonl" || event.Sequence != events[index].Sequence || event.Kind != events[index].Kind {
			t.Fatalf("event[%d]=%+v, want %+v", index, event, events[index])
		}
	}
	if strings.Contains(stdout.String(), `"disposition"`) {
		t.Fatalf("JSONL output leaked AgentInputReceipt: %q", stdout.String())
	}
}

func TestRunAgentChatJSONLContainsOnlyTypedRunEvents(t *testing.T) {
	events := []runharness.RunEvent{
		{
			SchemaVersion: 1, RunID: "chat-jsonl", SessionID: "chat-session", Sequence: 1,
			Kind: runharness.EventModelCompleted, ResultingState: runharness.RunStateCompleted,
			Payload: mustJSON(runharness.ModelCompletedEvent{Text: "done"}),
		},
	}
	runtime := &fakeAgentRuntime{
		submitReceipts: []runharness.AgentInputReceipt{{
			RequestID: "chat-request", SessionID: "chat-session", RunID: "chat-jsonl",
			Disposition: "started", State: runharness.RunStateRunningModel,
		}},
		readResults: []runharness.RunReadResult{{
			Run:    runharness.RunSnapshot{ID: "chat-jsonl", State: runharness.RunStateCompleted},
			Events: events,
		}},
	}
	installFakeAgentRuntime(t, runtime)

	var stdout, stderr bytes.Buffer
	if code := runAgentChat(context.Background(), []string{
		"--prompt", "hello", "--jsonl", "--poll", "1ms",
	}, &stdout, &stderr); code != ExitSuccess {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	got := decodeAgentJSONLEvents(t, stdout.Bytes())
	if len(got) != 1 || got[0].RunID != "chat-jsonl" || got[0].Kind != runharness.EventModelCompleted {
		t.Fatalf("JSONL events=%+v, output=%q", got, stdout.String())
	}
	if strings.Contains(stdout.String(), `"disposition"`) {
		t.Fatalf("JSONL output leaked AgentInputReceipt: %q", stdout.String())
	}
}

func TestRunAgentNoWaitJSONLDoesNotEmitReceipt(t *testing.T) {
	runtime := &fakeAgentRuntime{submitReceipts: []runharness.AgentInputReceipt{{
		RequestID: "no-wait", SessionID: "session-no-wait", RunID: "run-no-wait",
		Disposition: "queued", State: runharness.RunStateQueued,
	}}}
	installFakeAgentRuntime(t, runtime)

	var stdout, stderr bytes.Buffer
	code := runAgentRun(context.Background(), []string{
		"--prompt", "hello", "--jsonl", "--no-wait",
	}, &stdout, &stderr)
	if code != ExitActionRequired {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if stdout.Len() != 0 {
		t.Fatalf("--no-wait --jsonl emitted non-event output: %q", stdout.String())
	}
}
