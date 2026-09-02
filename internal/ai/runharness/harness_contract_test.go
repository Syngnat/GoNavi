package runharness

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

type contractModel struct {
	mu     sync.Mutex
	calls  int
	tool   ToolIntent
	second ModelTurnResult
}

func (m *contractModel) Execute(context.Context, ModelTurnRequest, ModelDeltaSink) (ModelTurnResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls++
	if m.calls == 1 {
		return ModelTurnResult{ToolCalls: []ToolIntent{m.tool}, Completed: true}, nil
	}
	return m.second, nil
}

func (m *contractModel) callCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.calls
}

type contractToolExecutor struct {
	mu       sync.Mutex
	requests []ToolExecutionRequest
	result   ToolExecutionResult
	err      error
}

func (e *contractToolExecutor) Execute(_ context.Context, request ToolExecutionRequest) (ToolExecutionResult, error) {
	e.mu.Lock()
	e.requests = append(e.requests, request)
	e.mu.Unlock()
	return e.result, e.err
}

func (e *contractToolExecutor) lastRequest() (ToolExecutionRequest, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.requests) == 0 {
		return ToolExecutionRequest{}, false
	}
	return e.requests[len(e.requests)-1], true
}

type contractToolCatalog struct {
	descriptor ToolDescriptor
	executor   ToolExecutor
	effect     ToolEffect
}

func (c *contractToolCatalog) List(context.Context) ([]ToolDescriptor, error) {
	return []ToolDescriptor{c.descriptor}, nil
}

func (c *contractToolCatalog) Resolve(_ context.Context, name string) (ToolDescriptor, ToolExecutor, error) {
	if name != c.descriptor.Name {
		return ToolDescriptor{}, nil, ErrToolNotFound
	}
	return c.descriptor, c.executor, nil
}

func (c *contractToolCatalog) ResolveEffect(context.Context, string, json.RawMessage) (ToolEffect, error) {
	return c.effect, nil
}

type contractApprovalHandler struct {
	mu       sync.Mutex
	requests []ApprovalRequest
}

func (h *contractApprovalHandler) Request(_ context.Context, request ApprovalRequest) (ApprovalDecision, error) {
	h.mu.Lock()
	h.requests = append(h.requests, request)
	h.mu.Unlock()
	return ApprovalDecision{ApprovalID: request.ApprovalID, Decision: "approved"}, nil
}

func (h *contractApprovalHandler) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.requests)
}

func newContractHarness(t *testing.T, model ModelTurnAdapter, tools ToolCatalog, approvals ApprovalHandler) (*AgentRunHarness, *Ledger) {
	t.Helper()
	ledger, err := OpenWithKey(":memory:", bytes.Repeat([]byte{0x42}, 32))
	if err != nil {
		t.Fatalf("open ledger: %v", err)
	}
	harness, err := NewAgentRunHarness(HarnessConfig{
		Ledger: ledger, Model: model, Tools: tools, Approvals: approvals,
		RootContext: context.Background(), OwnerID: "contract-test-owner",
		LeaseDuration: time.Second, PollInterval: 5 * time.Millisecond,
	})
	if err != nil {
		_ = ledger.Close()
		t.Fatalf("new harness: %v", err)
	}
	t.Cleanup(func() {
		_ = harness.Close()
		_ = ledger.Close()
	})
	return harness, ledger
}

func waitContractRun(t *testing.T, harness *AgentRunHarness, runID string, accept func(RunSnapshot) bool) RunReadResult {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		read, err := harness.ReadRun(context.Background(), RunReadRequest{RunID: runID, Limit: 200})
		if err != nil {
			t.Fatalf("read run: %v", err)
		}
		if accept(read.Run) {
			return read
		}
		time.Sleep(5 * time.Millisecond)
	}
	read, err := harness.ReadRun(context.Background(), RunReadRequest{RunID: runID, Limit: 200})
	if err != nil {
		t.Fatalf("read run after timeout: %v", err)
	}
	t.Fatalf("run did not reach expected state: state=%s revision=%d events=%d", read.Run.State, read.Run.Revision, len(read.Events))
	return RunReadResult{}
}

func TestHarnessUnknownSideEffectOutcomeRequiresRecovery(t *testing.T) {
	arguments := json.RawMessage(`{"connectionId":"conn-1","sql":"INSERT INTO audit_log(id) VALUES (1)"}`)
	model := &contractModel{
		tool:   ToolIntent{CallID: "call-write", ToolName: "execute_sql", Arguments: arguments},
		second: ModelTurnResult{Text: "must not run", Completed: true},
	}
	executor := &contractToolExecutor{
		result: ToolExecutionResult{Status: "failed", Value: map[string]any{"queryId": "q-1"}, ErrorCode: "transport", UnknownOutcome: true},
		err:    errors.New("database response was lost"),
	}
	catalog := &contractToolCatalog{
		descriptor: ToolDescriptor{
			Name: "execute_sql", Effect: ToolEffectSideEffectUnknown,
			InputSchema: json.RawMessage(`{"type":"object","required":["connectionId","sql"],"properties":{"connectionId":{"type":"string"},"sql":{"type":"string"}},"additionalProperties":false}`),
		},
		executor: executor,
		effect:   ToolEffectSideEffect,
	}
	approvals := &contractApprovalHandler{}
	harness, ledger := newContractHarness(t, model, catalog, approvals)

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{RequestID: "unknown-outcome-request", Content: "insert one row"})
	if err != nil {
		t.Fatalf("submit input: %v", err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool {
		return run.State == RunStateRecoveryRequired || run.State.Terminal()
	})
	if read.Run.State != RunStateRecoveryRequired {
		t.Fatalf("unknown side-effect outcome state = %s, want %s", read.Run.State, RunStateRecoveryRequired)
	}
	if got := model.callCount(); got != 1 {
		t.Fatalf("model calls after unknown side-effect outcome = %d, want 1", got)
	}
	if approvals.count() != 1 {
		t.Fatalf("approval count = %d, want 1", approvals.count())
	}
	request, ok := executor.lastRequest()
	if !ok || request.Effect != ToolEffectSideEffect {
		t.Fatalf("executor effect = %q (called=%v), want %q", request.Effect, ok, ToolEffectSideEffect)
	}

	var startedEvents, outcomeEvents int
	var toolEvent ToolEvent
	for _, event := range read.Events {
		if event.Kind != EventTool {
			continue
		}
		if err := json.Unmarshal(event.Payload, &toolEvent); err != nil {
			t.Fatalf("decode tool event: %v", err)
		}
		switch toolEvent.Status {
		case "started":
			startedEvents++
			if event.ResultingState != RunStateRunningTool {
				t.Fatalf("started tool event state = %s, want %s", event.ResultingState, RunStateRunningTool)
			}
			continue
		case "unknown":
			outcomeEvents++
		default:
			t.Fatalf("unexpected tool event status = %q", toolEvent.Status)
		}
		if event.ResultingState != RunStateRecoveryRequired {
			t.Fatalf("tool event state = %s, want %s", event.ResultingState, RunStateRecoveryRequired)
		}
	}
	if startedEvents != 1 || outcomeEvents != 1 {
		t.Fatalf("tool event boundaries = started %d unknown %d", startedEvents, outcomeEvents)
	}
	if toolEvent.Status != "unknown" || toolEvent.Effect != ToolEffectSideEffect || toolEvent.ArgsHash == "" || toolEvent.ResultHash == "" {
		t.Fatalf("unexpected recovery tool event: %+v", toolEvent)
	}
	var status string
	var unknown int
	if err := ledger.db.QueryRow(`SELECT status, unknown_outcome FROM tool_calls WHERE run_id=? AND call_id=?`, receipt.RunID, "call-write").Scan(&status, &unknown); err != nil {
		t.Fatalf("read tool call: %v", err)
	}
	if status != "unknown" || unknown != 1 {
		t.Fatalf("persisted tool outcome = status %q unknown %d", status, unknown)
	}
}

func TestResumeToolCountersDoesNotCountDurableStartAsFailure(t *testing.T) {
	ledger, run, lease := newAtomicToolRun(t)
	ctx := context.Background()
	intent := ToolIntent{CallID: "resume-read", ToolName: "read", Arguments: json.RawMessage(`{}`)}
	if _, err := ledger.AppendEvent(ctx, AppendEventRequest{
		RunID: run.ID, ExpectedRevision: run.Revision,
		Kind: EventModelCompleted, ResultingState: RunStateRunningModel,
		Payload: ModelCompletedEvent{ToolCalls: []ToolIntent{intent}}, OwnerToken: lease.Token,
	}); err != nil {
		t.Fatalf("append model completed: %v", err)
	}
	run, err := ledger.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.StartToolAndEvent(ctx, StartToolAndEventRequest{StartToolRequest: StartToolRequest{
		RunID: run.ID, CallID: intent.CallID, Attempt: run.Attempt,
		ToolName: intent.ToolName, Effect: ToolEffectReadOnly, Arguments: intent.Arguments,
		ExpectedRevision: run.Revision, OwnerToken: lease.Token,
	}}); err != nil {
		t.Fatalf("start durable tool boundary: %v", err)
	}

	harness, err := NewAgentRunHarness(HarnessConfig{Ledger: ledger, RootContext: context.Background()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = harness.Close() })
	if rounds, failed := harness.resumeToolCounters(ctx, run.ID); rounds != 1 || failed != 0 {
		t.Fatalf("resumed counters = rounds:%d failed:%d, want rounds:1 failed:0", rounds, failed)
	}
}

func TestHarnessDynamicReadOnlyEffectSkipsApproval(t *testing.T) {
	model := &contractModel{
		tool:   ToolIntent{CallID: "call-read", ToolName: "execute_sql", Arguments: json.RawMessage(`{"connectionId":"conn-1","sql":"SELECT 1"}`)},
		second: ModelTurnResult{Text: "done", Completed: true},
	}
	executor := &contractToolExecutor{result: ToolExecutionResult{Status: "completed", Value: map[string]any{"rows": 1}}}
	catalog := &contractToolCatalog{
		descriptor: ToolDescriptor{Name: "execute_sql", Effect: ToolEffectSideEffectUnknown, InputSchema: json.RawMessage(`{"type":"object","required":["connectionId","sql"],"properties":{"connectionId":{"type":"string"},"sql":{"type":"string"}},"additionalProperties":false}`)},
		executor:   executor,
		effect:     ToolEffectReadOnly,
	}
	approvals := &contractApprovalHandler{}
	harness, _ := newContractHarness(t, model, catalog, approvals)
	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{RequestID: "read-only-request", Content: "read one row"})
	if err != nil {
		t.Fatalf("submit input: %v", err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if read.Run.State != RunStateCompleted {
		t.Fatalf("read-only run state = %s, want %s", read.Run.State, RunStateCompleted)
	}
	if approvals.count() != 0 {
		t.Fatalf("read-only approval count = %d, want 0", approvals.count())
	}
	request, ok := executor.lastRequest()
	if !ok || request.Effect != ToolEffectReadOnly {
		t.Fatalf("read-only executor effect = %q (called=%v)", request.Effect, ok)
	}
}

func TestHarnessWorkspaceToolPersistsExactSnapshotReference(t *testing.T) {
	model := &contractModel{
		tool:   ToolIntent{CallID: "workspace-call", ToolName: "read_workspace", Arguments: json.RawMessage(`{}`)},
		second: ModelTurnResult{Text: "done", Completed: true},
	}
	executor := &contractToolExecutor{result: ToolExecutionResult{Status: "completed", Value: map[string]any{"ok": true}}}
	catalog := &contractToolCatalog{
		descriptor: ToolDescriptor{
			Name: "read_workspace", Effect: ToolEffectReadOnly, Capabilities: []string{"workspace"},
			InputSchema: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`),
		},
		executor: executor,
		effect:   ToolEffectReadOnly,
	}
	harness, ledger := newContractHarness(t, model, catalog, nil)
	snapshot, err := ledger.PutWorkspaceSnapshot(context.Background(), WorkspaceSnapshot{
		SourceKind: WorkspaceDesktop, SourceID: "desktop-source", SourceInstanceID: "desktop-instance",
		Revision: 7, ActiveContext: map[string]any{"tab": "orders"},
	})
	if err != nil {
		t.Fatalf("put workspace snapshot: %v", err)
	}
	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{
		RequestID: "workspace-reference-request", Content: "inspect workspace",
		ContextSourceID: snapshot.SourceID, ContextSourceInstanceID: snapshot.SourceInstanceID,
	})
	if err != nil {
		t.Fatalf("submit input: %v", err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if read.Run.State != RunStateCompleted {
		t.Fatalf("run state = %s, want completed", read.Run.State)
	}
	execution, ok := executor.lastRequest()
	if !ok {
		t.Fatal("workspace executor was not called")
	}
	if execution.Context.Revision != snapshot.Revision || execution.Context.ContentHash != snapshot.ContentHash {
		t.Fatalf("executor workspace = %#v, want revision %d hash %q", execution.Context, snapshot.Revision, snapshot.ContentHash)
	}
	want := workspaceSnapshotReference(snapshot)
	var toolEvent ToolEvent
	var checkpointEvent CheckpointEvent
	for _, event := range read.Events {
		switch event.Kind {
		case EventTool:
			if err := json.Unmarshal(event.Payload, &toolEvent); err != nil {
				t.Fatalf("decode tool event: %v", err)
			}
		case EventCheckpoint:
			var candidate CheckpointEvent
			if err := json.Unmarshal(event.Payload, &candidate); err != nil {
				t.Fatalf("decode checkpoint event: %v", err)
			}
			if candidate.WorkspaceSnapshot != nil && candidate.WorkspaceSnapshot.Revision == snapshot.Revision {
				checkpointEvent = candidate
			}
		}
	}
	if !sameWorkspaceSnapshotReference(toolEvent.WorkspaceSnapshot, want) {
		t.Fatalf("tool workspace reference = %#v, want %#v", toolEvent.WorkspaceSnapshot, want)
	}
	if !sameWorkspaceSnapshotReference(checkpointEvent.WorkspaceSnapshot, want) {
		t.Fatalf("checkpoint event workspace reference = %#v, want %#v", checkpointEvent.WorkspaceSnapshot, want)
	}
	checkpoint, err := ledger.LatestCheckpoint(context.Background(), receipt.RunID)
	if err != nil {
		t.Fatalf("latest checkpoint: %v", err)
	}
	if !sameWorkspaceSnapshotReference(checkpoint.WorkspaceSnapshot, want) {
		t.Fatalf("checkpoint workspace reference = %#v, want %#v", checkpoint.WorkspaceSnapshot, want)
	}
}

func TestHarnessExpiredWorkspaceRequiresExplicitStaleControl(t *testing.T) {
	model := &contractModel{
		tool:   ToolIntent{CallID: "expired-workspace-call", ToolName: "read_workspace", Arguments: json.RawMessage(`{}`)},
		second: ModelTurnResult{Text: "done", Completed: true},
	}
	executor := &contractToolExecutor{result: ToolExecutionResult{Status: "completed", Value: map[string]any{"ok": true}}}
	catalog := &contractToolCatalog{
		descriptor: ToolDescriptor{
			Name: "read_workspace", Effect: ToolEffectReadOnly, Capabilities: []string{"workspace"},
			InputSchema: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`),
		},
		executor: executor,
		effect:   ToolEffectReadOnly,
	}
	harness, ledger := newContractHarness(t, model, catalog, nil)
	snapshot, err := ledger.PutWorkspaceSnapshot(context.Background(), WorkspaceSnapshot{
		SourceKind: WorkspaceDesktop, SourceID: "expired-source", SourceInstanceID: "expired-instance",
		Revision: 3, ActiveContext: map[string]any{"draft": "SELECT 1"},
	})
	if err != nil {
		t.Fatalf("put workspace snapshot: %v", err)
	}
	if _, err := ledger.db.Exec(`UPDATE workspace_snapshots SET lease_expires_at=0 WHERE source_id=? AND source_instance_id=? AND revision=?`, snapshot.SourceID, snapshot.SourceInstanceID, snapshot.Revision); err != nil {
		t.Fatalf("expire workspace snapshot: %v", err)
	}
	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{
		RequestID: "expired-workspace-request", Content: "inspect stale workspace",
		ContextSourceID: snapshot.SourceID, ContextSourceInstanceID: snapshot.SourceInstanceID,
	})
	if err != nil {
		t.Fatalf("submit input: %v", err)
	}
	waiting := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State == RunStateAwaitingWorkspace })
	if _, ok := executor.lastRequest(); ok {
		t.Fatal("executor ran before stale workspace was explicitly approved")
	}
	const staleCommandID = "expired-workspace-stale-command"
	if _, err := harness.ControlRun(context.Background(), RunControlRequest{RequestID: staleCommandID, RunID: receipt.RunID, Action: ControlUseStaleWorkspace, ExpectedRevision: waiting.Run.Revision}); err != nil {
		t.Fatalf("allow stale workspace: %v", err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if read.Run.State != RunStateCompleted {
		t.Fatalf("run state after stale approval = %s, want completed", read.Run.State)
	}
	execution, ok := executor.lastRequest()
	if !ok || execution.Context.Revision != snapshot.Revision || execution.Context.ContentHash != snapshot.ContentHash {
		t.Fatalf("executor stale workspace = %#v called=%v", execution.Context, ok)
	}
	want := workspaceSnapshotReference(snapshot)
	var toolEvent ToolEvent
	for _, event := range read.Events {
		if event.Kind == EventTool {
			if err := json.Unmarshal(event.Payload, &toolEvent); err != nil {
				t.Fatalf("decode tool event: %v", err)
			}
		}
	}
	if !sameWorkspaceSnapshotReference(toolEvent.WorkspaceSnapshot, want) {
		t.Fatalf("stale tool workspace reference = %#v, want %#v", toolEvent.WorkspaceSnapshot, want)
	}
	var applied, consumed int64
	if err := ledger.db.QueryRow(`SELECT applied_at,consumed_at FROM control_commands WHERE id=?`, staleCommandID).Scan(&applied, &consumed); err != nil {
		t.Fatal(err)
	}
	if applied == 0 || consumed == 0 {
		t.Fatalf("stale workspace command was acknowledged before/after recovery incorrectly: applied=%d consumed=%d", applied, consumed)
	}
}

func TestValidateToolArgumentsRejectsAdditionalPropertiesAndFractionalInteger(t *testing.T) {
	schema := json.RawMessage(`{"type":"object","required":["limit"],"properties":{"limit":{"type":"integer"}},"additionalProperties":false}`)
	if err := validateToolArguments(schema, json.RawMessage(`{"limit":1}`)); err != nil {
		t.Fatalf("valid integer arguments rejected: %v", err)
	}
	for name, arguments := range map[string]json.RawMessage{
		"additional property": json.RawMessage(`{"limit":1,"unexpected":true}`),
		"fractional integer":  json.RawMessage(`{"limit":1.5}`),
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateToolArguments(schema, arguments); err == nil {
				t.Fatalf("arguments %s unexpectedly passed schema validation", arguments)
			}
		})
	}
}
