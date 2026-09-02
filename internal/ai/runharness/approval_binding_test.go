package runharness

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestApprovalDecisionBindsRunCallArgumentsAndRevisionBeforeMutation(t *testing.T) {
	ledger := testLedger(t)
	ctx := context.Background()
	runA, err := ledger.CreateRun(ctx, CreateRunRequest{SessionID: "approval-a", Policy: DefaultRunPolicy()})
	if err != nil {
		t.Fatal(err)
	}
	runB, err := ledger.CreateRun(ctx, CreateRunRequest{SessionID: "approval-b", Policy: DefaultRunPolicy()})
	if err != nil {
		t.Fatal(err)
	}
	approval, err := ledger.CreateApproval(ctx, PutApprovalRequest{
		RunID: runA.ID, CallID: "call-a", ToolName: "write",
		Effect: ToolEffectSideEffect, Arguments: json.RawMessage(`{"value":1}`),
		RunRevision: runA.Revision,
	})
	if err != nil {
		t.Fatal(err)
	}

	harness, err := NewAgentRunHarness(HarnessConfig{Ledger: ledger, RootContext: context.Background()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = harness.Close() })
	valid := RunControlRequest{
		RunID: runA.ID, Action: ControlApprove, ApprovalID: approval.ApprovalID,
		CallID: approval.CallID, ArgsHash: approval.ArgsHash, ExpectedRevision: approval.RunRevision,
	}
	if _, err := harness.ControlRun(ctx, RunControlRequest{
		RunID: runB.ID, Action: ControlApprove, ApprovalID: approval.ApprovalID,
		CallID: approval.CallID, ArgsHash: approval.ArgsHash, ExpectedRevision: approval.RunRevision,
	}); !errors.Is(err, ErrApprovalConflict) {
		t.Fatalf("cross-run approval error = %v", err)
	}
	if _, err := harness.ControlRun(ctx, RunControlRequest{
		RunID: runA.ID, CallID: "call-b", Action: ControlDeny,
		ApprovalID: approval.ApprovalID, ArgsHash: approval.ArgsHash, ExpectedRevision: approval.RunRevision,
	}); !errors.Is(err, ErrApprovalConflict) {
		t.Fatalf("wrong-call approval error = %v", err)
	}
	if _, err := harness.ControlRun(ctx, RunControlRequest{
		RunID: runA.ID, CallID: approval.CallID, Action: ControlDeny,
		ApprovalID: approval.ApprovalID, ArgsHash: "wrong-hash", ExpectedRevision: approval.RunRevision,
	}); !errors.Is(err, ErrApprovalConflict) {
		t.Fatalf("wrong-arguments approval error = %v", err)
	}
	for _, testCase := range []struct {
		name    string
		request RunControlRequest
	}{
		{name: "missing call", request: RunControlRequest{RunID: runA.ID, Action: ControlApprove, ApprovalID: approval.ApprovalID, ArgsHash: approval.ArgsHash, ExpectedRevision: approval.RunRevision}},
		{name: "missing hash", request: RunControlRequest{RunID: runA.ID, Action: ControlApprove, ApprovalID: approval.ApprovalID, CallID: approval.CallID, ExpectedRevision: approval.RunRevision}},
		{name: "missing revision", request: RunControlRequest{RunID: runA.ID, Action: ControlApprove, ApprovalID: approval.ApprovalID, CallID: approval.CallID, ArgsHash: approval.ArgsHash}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := harness.ControlRun(ctx, testCase.request); err == nil {
				t.Fatal("missing approval binding was accepted")
			}
		})
	}
	pending, err := ledger.GetApproval(ctx, approval.ApprovalID)
	if err != nil {
		t.Fatal(err)
	}
	if pending.Status != "pending" || !pending.DecidedAt.IsZero() {
		t.Fatalf("mismatched decision mutated approval: %#v", pending)
	}

	decided, err := ledger.DecideApproval(ctx, DecideApprovalRequest{
		ApprovalID:          valid.ApprovalID,
		Decision:            "approved",
		ExpectedRunID:       valid.RunID,
		ExpectedCallID:      valid.CallID,
		ExpectedArgsHash:    valid.ArgsHash,
		ExpectedRunRevision: valid.ExpectedRevision,
	})
	if err != nil {
		t.Fatal(err)
	}
	if decided.Status != "approved" || decided.CallID != approval.CallID {
		t.Fatalf("decided approval = %#v", decided)
	}
	if _, err := ledger.DecideApproval(ctx, DecideApprovalRequest{
		ApprovalID: approval.ApprovalID, Decision: "approved",
		ExpectedRunID: runA.ID, ExpectedCallID: approval.CallID,
		ExpectedArgsHash: approval.ArgsHash, ExpectedRunRevision: approval.RunRevision,
	}); !errors.Is(err, ErrApprovalConflict) {
		t.Fatalf("duplicate decision error = %v", err)
	}
}

func TestApprovalAndRunControlJSONDoNotExposeFencingTokensOrArguments(t *testing.T) {
	secret := `INSERT INTO private_table VALUES ('secret')`
	approval := ApprovalRecord{ApprovalID: "approval-1", ArgsHash: "args-hash", Arguments: json.RawMessage(`{"sql":"` + secret + `"}`)}
	approvalJSON, err := json.Marshal(approval)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(approvalJSON, []byte("arguments")) || bytes.Contains(approvalJSON, []byte(secret)) {
		t.Fatalf("approval JSON leaked raw arguments: %s", approvalJSON)
	}

	runJSON, err := json.Marshal(RunSnapshot{ID: "run-1", ownerToken: "fencing-token"})
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(runJSON, []byte("ownerToken")) || bytes.Contains(runJSON, []byte("fencing-token")) {
		t.Fatalf("run JSON leaked fencing token: %s", runJSON)
	}

	controlJSON, err := json.Marshal(RunControlRequest{RunID: "run-1", Action: ControlApprove, ArgsHash: "args-hash"})
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(controlJSON, []byte("ownerToken")) {
		t.Fatalf("run control JSON exposed owner token field: %s", controlJSON)
	}
	if !bytes.Contains(controlJSON, []byte(`"argsHash":"args-hash"`)) {
		t.Fatalf("run control JSON omitted args hash: %s", controlJSON)
	}

	requestJSON, err := json.Marshal(ApprovalRequest{ApprovalID: "approval-1", Arguments: approval.Arguments})
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(requestJSON, []byte("Arguments")) || bytes.Contains(requestJSON, []byte(secret)) {
		t.Fatalf("approval request JSON leaked raw arguments: %s", requestJSON)
	}
}

func TestInternalLedgerRequestsDoNotMarshalFencingTokens(t *testing.T) {
	const fencingToken = "fencing-token"
	cases := []struct {
		name  string
		value any
	}{
		{name: "reserve tokens", value: ReserveTokensRequest{OwnerToken: fencingToken}},
		{name: "reconcile tokens", value: ReconcileTokensRequest{OwnerToken: fencingToken}},
		{name: "commit model turn", value: CommitModelTurnRequest{OwnerToken: fencingToken}},
		{name: "append event", value: AppendEventRequest{OwnerToken: fencingToken}},
		{name: "save checkpoint", value: SaveCheckpointRequest{OwnerToken: fencingToken}},
		{name: "start tool", value: StartToolRequest{OwnerToken: fencingToken}},
		{name: "finish tool", value: FinishToolRequest{OwnerToken: fencingToken}},
		{name: "put approval", value: PutApprovalRequest{OwnerToken: fencingToken}},
		{name: "lease", value: Lease{Token: fencingToken}},
		{name: "recovery action", value: RecoveryActionRequest{OwnerToken: fencingToken}},
		{name: "supersede tools", value: SupersedeToolIntentsRequest{OwnerToken: fencingToken}},
		{name: "control command claim", value: ControlCommand{ClaimedBy: fencingToken}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			encoded, err := json.Marshal(testCase.value)
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Contains(encoded, []byte(fencingToken)) || bytes.Contains(encoded, []byte("ownerToken")) ||
				bytes.Contains(encoded, []byte(`"token"`)) || bytes.Contains(encoded, []byte("claimedBy")) {
				t.Fatalf("internal request leaked fencing data: %s", encoded)
			}
		})
	}
}

func TestApprovalEventIncludesBindingMetadataWithoutToolArguments(t *testing.T) {
	secret := `DELETE FROM private_table WHERE token = 'secret'`
	event := newApprovalEvent(
		"approval-1",
		"call-1",
		"execute_sql",
		ToolEffectSideEffect,
		"args-hash",
		"pending",
	)
	if event.ApprovalID != "approval-1" || event.CallID != "call-1" ||
		event.ToolName != "execute_sql" || event.Effect != ToolEffectSideEffect ||
		event.ArgsHash != "args-hash" || event.Decision != "pending" {
		t.Fatalf("approval event binding = %#v", event)
	}
	if event.Summary != "This tool can change data or external state." {
		t.Fatalf("approval event summary = %q", event.Summary)
	}

	eventJSON, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{
		`"toolName":"execute_sql"`,
		`"effect":"side_effect"`,
		`"argsHash":"args-hash"`,
	} {
		if !bytes.Contains(eventJSON, []byte(field)) {
			t.Fatalf("approval event JSON omitted %s: %s", field, eventJSON)
		}
	}
	if bytes.Contains(eventJSON, []byte(secret)) || bytes.Contains(eventJSON, []byte("arguments")) || bytes.Contains(eventJSON, []byte(`"sql"`)) {
		t.Fatalf("approval event JSON leaked tool arguments: %s", eventJSON)
	}
}

func TestFailedRecoveryControlDoesNotLeaveConsumableCommand(t *testing.T) {
	ledger, run, _ := recoveryRunWithUnknownTool(t)
	ctx := context.Background()
	harness, err := NewAgentRunHarness(HarnessConfig{Ledger: ledger, RootContext: context.Background()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = harness.Close() })

	_, err = harness.ControlRun(ctx, RunControlRequest{
		RequestID: "invalid-recovery-command", RunID: run.ID,
		CallID: "missing-call", Action: ControlMarkCompleted,
		ExpectedRevision: run.Revision,
	})
	if !errors.Is(err, ErrRecoveryUnavailable) {
		t.Fatalf("recovery error = %v", err)
	}
	var commands int
	if err := ledger.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM control_commands WHERE id=? AND consumed_at=0`, "invalid-recovery-command").Scan(&commands); err != nil {
		t.Fatal(err)
	}
	if commands != 0 {
		t.Fatalf("failed recovery left %d consumable commands", commands)
	}
}

func TestRecoveryControlCommandConflictDoesNotApplyTransition(t *testing.T) {
	ledger, run, _ := recoveryRunWithUnknownTool(t)
	ctx := context.Background()
	defer ledger.Close()
	harness, err := NewAgentRunHarness(HarnessConfig{Ledger: ledger, RootContext: context.Background()})
	if err != nil {
		t.Fatal(err)
	}
	defer harness.Close()

	// Occupy the request ID with a different command before the recovery call.
	// The recovery transition must be rejected in the same transaction boundary,
	// leaving both the unknown tool and run revision untouched.
	requestID := "recovery-command-collision"
	if _, err := ledger.EnqueueCommand(ctx, ControlCommand{
		ID: requestID, RunID: run.ID, Action: ControlCancel,
		Payload: json.RawMessage(`{"reason":"other-intent"}`), ExpectedRevision: run.Revision,
	}); err != nil {
		t.Fatal(err)
	}
	_, err = harness.ControlRun(ctx, RunControlRequest{
		RequestID: requestID, RunID: run.ID, CallID: "write-1",
		Action: ControlMarkCompleted, ExpectedRevision: run.Revision,
	})
	if !errors.Is(err, ErrControlCommandConflict) {
		t.Fatalf("recovery command collision error = %v", err)
	}
	latest, err := ledger.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if latest.State != RunStateRecoveryRequired || latest.Revision != run.Revision {
		t.Fatalf("run changed after command collision: before=%#v after=%#v", run, latest)
	}
	var status string
	var unknown int
	if err := ledger.db.QueryRowContext(ctx, `SELECT status,unknown_outcome FROM tool_calls WHERE run_id=? AND call_id=?`, run.ID, "write-1").Scan(&status, &unknown); err != nil {
		t.Fatal(err)
	}
	if status != "unknown" || unknown != 1 {
		t.Fatalf("unknown tool changed after command collision: status=%q unknown=%d", status, unknown)
	}
}

func TestRecoveryControlRetryWithSameRequestIDIsIdempotent(t *testing.T) {
	ledger, run, _ := recoveryRunWithUnknownTool(t)
	ctx := context.Background()
	defer ledger.Close()
	harness, err := NewAgentRunHarness(HarnessConfig{Ledger: ledger, RootContext: context.Background()})
	if err != nil {
		t.Fatal(err)
	}
	defer harness.Close()

	request := RunControlRequest{
		RequestID: "recovery-idempotent-request", RunID: run.ID, CallID: "write-1",
		Action: ControlMarkCompleted, ExpectedRevision: run.Revision,
	}
	first, err := harness.ControlRun(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	// Advance the live projection after the command has committed. A transport
	// retry with the same idempotency key must return the immutable receipt from
	// the first command, rather than observing this later worker transition.
	advanced, err := ledger.TransitionRun(ctx, run.ID, first.State, RunStateAwaitingWorkspace, first.Revision, "")
	if err != nil {
		t.Fatal(err)
	}
	if advanced.Revision <= first.Revision {
		t.Fatalf("live run revision did not advance: first=%d advanced=%d", first.Revision, advanced.Revision)
	}
	var receiptBlob []byte
	if err := ledger.db.QueryRowContext(ctx, `SELECT result_snapshot FROM control_commands WHERE id=?`, request.RequestID).Scan(&receiptBlob); err != nil {
		t.Fatal(err)
	}
	var receipt RunSnapshot
	if err := ledger.openJSON("control_commands", request.RequestID, "result_snapshot", receiptBlob, &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.Revision != first.Revision || receipt.State != first.State {
		t.Fatalf("durable receipt = %#v, want %#v", receipt, first)
	}
	second, err := harness.ControlRun(ctx, request)
	if err != nil {
		t.Fatalf("retrying recovery control: %v", err)
	}
	if second.ID != first.ID {
		t.Fatalf("retry returned a different run: first=%#v second=%#v", first, second)
	}
	// ControlRun starts a worker after recovery. Acquiring its lease may advance
	// the run revision between the two calls, so revision equality is not an
	// idempotency guarantee. The recovery checkpoint and tool settlement are the
	// durable boundaries that must remain exactly-once.
	var recoveryEvents int
	if err := ledger.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM events WHERE run_id=? AND kind=?`, run.ID, EventCheckpoint).Scan(&recoveryEvents); err != nil {
		t.Fatal(err)
	}
	if recoveryEvents != 1 {
		t.Fatalf("recovery retry emitted %d checkpoint events, want 1", recoveryEvents)
	}
	var commandCount int
	var appliedAt, consumedAt int64
	if err := ledger.db.QueryRowContext(ctx, `SELECT COUNT(*),COALESCE(MAX(applied_at),0),COALESCE(MAX(consumed_at),0) FROM control_commands WHERE id=?`, request.RequestID).Scan(&commandCount, &appliedAt, &consumedAt); err != nil {
		t.Fatal(err)
	}
	if commandCount != 1 || appliedAt == 0 || consumedAt == 0 {
		t.Fatalf("recovery command marker = count %d applied %d consumed %d, want one applied marker", commandCount, appliedAt, consumedAt)
	}
	var status string
	var unknown int
	if err := ledger.db.QueryRowContext(ctx, `SELECT status,unknown_outcome FROM tool_calls WHERE run_id=? AND call_id=?`, run.ID, "write-1").Scan(&status, &unknown); err != nil {
		t.Fatal(err)
	}
	if status != "completed" || unknown != 0 {
		t.Fatalf("recovery retry changed tool settlement: status=%q unknown=%d", status, unknown)
	}
}
