package runharness

import (
	"context"
	"encoding/json"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func crossProcessTestKey() []byte {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 31)
	}
	return key
}

func openCrossProcessHarness(t *testing.T, path, ownerID string, model ModelTurnAdapter, catalog ToolCatalog, approvals ApprovalHandler, start bool) (*AgentRunHarness, *Ledger) {
	t.Helper()
	ledger, err := Open(path, WithKey(crossProcessTestKey()))
	if err != nil {
		t.Fatal(err)
	}
	harness, err := NewAgentRunHarness(HarnessConfig{
		Ledger:       ledger,
		Model:        model,
		Tools:        catalog,
		Approvals:    approvals,
		RootContext:  context.Background(),
		OwnerID:      ownerID,
		PollInterval: time.Millisecond,
	})
	if err != nil {
		_ = ledger.Close()
		t.Fatal(err)
	}
	if start {
		if err := harness.Start(context.Background()); err != nil {
			_ = harness.Close()
			_ = ledger.Close()
			t.Fatal(err)
		}
	}
	return harness, ledger
}

func waitForRun(t *testing.T, ledger *Ledger, runID string, predicate func(RunSnapshot) bool) RunSnapshot {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		run, err := ledger.GetRun(context.Background(), runID)
		if err != nil {
			t.Fatal(err)
		}
		if predicate(run) {
			return run
		}
		time.Sleep(time.Millisecond)
	}
	run, err := ledger.GetRun(context.Background(), runID)
	if err != nil {
		t.Fatal(err)
	}
	t.Fatalf("run %s did not reach expected state: %#v", runID, run)
	return RunSnapshot{}
}

func waitForApproval(t *testing.T, ledger *Ledger, runID string) ApprovalRecord {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		approval, err := ledger.LatestApprovalForRun(context.Background(), runID)
		if err == nil && approval.Status == "pending" {
			return approval
		}
		time.Sleep(time.Millisecond)
	}
	approval, err := ledger.LatestApprovalForRun(context.Background(), runID)
	if err != nil {
		t.Fatal(err)
	}
	t.Fatalf("pending approval for run %s = %#v", runID, approval)
	return ApprovalRecord{}
}

type blockingApprovalCatalog struct {
	executions atomic.Int32
	started    chan ToolExecutionRequest
	release    <-chan struct{}
}

func (c *blockingApprovalCatalog) List(context.Context) ([]ToolDescriptor, error) {
	return []ToolDescriptor{{
		Name:        "write",
		Effect:      ToolEffectSideEffect,
		InputSchema: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`),
	}}, nil
}

func (c *blockingApprovalCatalog) Resolve(context.Context, string) (ToolDescriptor, ToolExecutor, error) {
	return ToolDescriptor{
		Name:        "write",
		Effect:      ToolEffectSideEffect,
		InputSchema: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`),
	}, blockingApprovalExecutor{catalog: c}, nil
}

type blockingApprovalExecutor struct{ catalog *blockingApprovalCatalog }

func (e blockingApprovalExecutor) Execute(ctx context.Context, request ToolExecutionRequest) (ToolExecutionResult, error) {
	e.catalog.executions.Add(1)
	select {
	case e.catalog.started <- request:
	case <-ctx.Done():
		return ToolExecutionResult{Status: "failed"}, ctx.Err()
	}
	select {
	case <-e.catalog.release:
		return ToolExecutionResult{Status: "completed", Value: map[string]any{"ok": true}}, nil
	case <-ctx.Done():
		return ToolExecutionResult{Status: "failed"}, ctx.Err()
	}
}

// A pending desktop approval deliberately releases its owner lease. A CLI
// process that approves it must become the sole owner for the resumed tool;
// the live desktop Harness must not also execute that side effect.
func TestApprovalCanTransferFromLiveDesktopToCLIOwner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent_runs.sqlite")
	desktopModel := &approvalResumeModel{}
	desktopCatalog := &approvalResumeCatalog{}
	desktop, desktopLedger := openCrossProcessHarness(t, path, "desktop-owner", desktopModel, desktopCatalog, pendingApprovalHandler{}, true)
	t.Cleanup(func() {
		_ = desktop.Close()
		_ = desktopLedger.Close()
	})

	receipt, err := desktop.SubmitInput(context.Background(), AgentInputRequest{RequestID: "desktop-request", Content: "write"})
	if err != nil {
		t.Fatal(err)
	}
	waitForRun(t, desktopLedger, receipt.RunID, func(run RunSnapshot) bool {
		return run.State == RunStateAwaitingApproval
	})
	approval := waitForApproval(t, desktopLedger, receipt.RunID)
	// The original worker must have returned before a separate process can
	// assume ownership. The desktop harness itself remains open throughout.
	waitForRun(t, desktopLedger, receipt.RunID, func(run RunSnapshot) bool {
		return run.State == RunStateAwaitingApproval && run.ownerToken == ""
	})

	release := make(chan struct{})
	cliCatalog := &blockingApprovalCatalog{
		started: make(chan ToolExecutionRequest, 1),
		release: release,
	}
	cli, cliLedger := openCrossProcessHarness(t, path, "cli-owner", &approvalResumeModel{}, cliCatalog, nil, false)
	t.Cleanup(func() {
		_ = cli.Close()
		_ = cliLedger.Close()
	})
	if _, err := cli.ControlRun(context.Background(), RunControlRequest{
		RunID: receipt.RunID, Action: ControlApprove, ApprovalID: approval.ApprovalID,
		CallID: approval.CallID, ArgsHash: approval.ArgsHash, ExpectedRevision: approval.RunRevision,
	}); err != nil {
		t.Fatalf("CLI approve: %v", err)
	}

	select {
	case request := <-cliCatalog.started:
		if request.RunID != receipt.RunID || request.CallID != "call-1" {
			t.Fatalf("CLI tool request = %#v", request)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("CLI did not begin the approved tool")
	}
	var ownerID string
	if err := cliLedger.db.QueryRowContext(context.Background(), `SELECT COALESCE(owner_id, '') FROM runs WHERE id=?`, receipt.RunID).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	if ownerID != "cli-owner" {
		t.Fatalf("active owner = %q, want cli-owner", ownerID)
	}
	if desktopCatalog.executions.Load() != 0 {
		t.Fatalf("desktop executed approved tool %d times", desktopCatalog.executions.Load())
	}
	if cliCatalog.executions.Load() != 1 {
		t.Fatalf("CLI tool executions = %d, want 1", cliCatalog.executions.Load())
	}

	close(release)
	completed := waitForRun(t, cliLedger, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if completed.State != RunStateCompleted {
		t.Fatalf("completed state = %s", completed.State)
	}
	if desktopCatalog.executions.Load() != 0 || cliCatalog.executions.Load() != 1 {
		t.Fatalf("tool executions desktop=%d cli=%d", desktopCatalog.executions.Load(), cliCatalog.executions.Load())
	}
}

type blockingObserverModel struct {
	calls   atomic.Int32
	started chan struct{}
	release <-chan struct{}
}

func (m *blockingObserverModel) Execute(ctx context.Context, _ ModelTurnRequest, _ ModelDeltaSink) (ModelTurnResult, error) {
	m.calls.Add(1)
	select {
	case m.started <- struct{}{}:
	case <-ctx.Done():
		return ModelTurnResult{}, ctx.Err()
	}
	select {
	case <-m.release:
		return ModelTurnResult{Text: "completed", Completed: true}, nil
	case <-ctx.Done():
		return ModelTurnResult{}, ctx.Err()
	}
}

// The CLI opens a read-only Harness with StartWorkers=false for inspect/list
// commands. Creating and using that observer must not recover, lease, or run
// an active desktop task.
func TestReadOnlyObserverDoesNotMutateActiveDesktopRun(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent_runs.sqlite")
	release := make(chan struct{})
	desktopModel := &blockingObserverModel{started: make(chan struct{}, 1), release: release}
	desktop, desktopLedger := openCrossProcessHarness(t, path, "desktop-owner", desktopModel, nil, nil, true)
	t.Cleanup(func() {
		_ = desktop.Close()
		_ = desktopLedger.Close()
	})

	receipt, err := desktop.SubmitInput(context.Background(), AgentInputRequest{RequestID: "desktop-running-request", Content: "answer"})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-desktopModel.started:
	case <-time.After(3 * time.Second):
		t.Fatal("desktop model did not start")
	}
	before := waitForRun(t, desktopLedger, receipt.RunID, func(run RunSnapshot) bool {
		return run.State == RunStateRunningModel && run.ownerToken != ""
	})

	observerModel := &blockingObserverModel{started: make(chan struct{}, 1), release: make(chan struct{})}
	observer, observerLedger := openCrossProcessHarness(t, path, "cli-observer", observerModel, nil, nil, false)
	t.Cleanup(func() {
		_ = observer.Close()
		_ = observerLedger.Close()
	})
	if _, err := observer.ReadRun(context.Background(), RunReadRequest{RunID: receipt.RunID}); err != nil {
		t.Fatalf("read run: %v", err)
	}
	if _, err := observer.ListSessions(context.Background(), SessionListRequest{ActiveOnly: true, Limit: 20}); err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	if _, err := observer.ReadSession(context.Background(), SessionReadRequest{SessionID: receipt.SessionID}); err != nil {
		t.Fatalf("read session: %v", err)
	}
	after, err := desktopLedger.GetRun(context.Background(), receipt.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if after.State != before.State || after.Revision != before.Revision || after.ownerToken != before.ownerToken {
		t.Fatalf("observer mutated run: before=%#v after=%#v", before, after)
	}
	if desktopModel.calls.Load() != 1 || observerModel.calls.Load() != 0 {
		t.Fatalf("model calls desktop=%d observer=%d", desktopModel.calls.Load(), observerModel.calls.Load())
	}

	close(release)
	completed := waitForRun(t, desktopLedger, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if completed.State != RunStateCompleted {
		t.Fatalf("completed state = %s", completed.State)
	}
}
