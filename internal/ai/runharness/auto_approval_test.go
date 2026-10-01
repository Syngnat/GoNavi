package runharness

import (
	"bytes"
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"
)

type togglePolicy struct {
	allow    atomic.Bool
	requests atomic.Int32
	last     atomic.Value // AutoApprovalRequest
}

func (p *togglePolicy) AutoApprove(_ context.Context, request AutoApprovalRequest) bool {
	p.requests.Add(1)
	p.last.Store(request)
	return p.allow.Load()
}

func newAutoApprovalHarness(t *testing.T, policy AutoApprovalPolicy) (*AgentRunHarness, *approvalResumeCatalog) {
	t.Helper()
	catalog := &approvalResumeCatalog{}
	ledger, err := OpenWithKey(":memory:", bytes.Repeat([]byte{0x42}, 32))
	if err != nil {
		t.Fatal(err)
	}
	harness, err := NewAgentRunHarness(HarnessConfig{
		Ledger: ledger, Model: &approvalResumeModel{}, Tools: catalog,
		RootContext: context.Background(), OwnerID: "auto-approval-owner",
		PollInterval: time.Millisecond,
	}, WithAutoApprovalPolicy(policy))
	if err != nil {
		_ = ledger.Close()
		t.Fatal(err)
	}
	if err := harness.Start(context.Background()); err != nil {
		_ = harness.Close()
		_ = ledger.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = harness.Close()
		_ = ledger.Close()
	})
	return harness, catalog
}

func approvalEvents(t *testing.T, read RunReadResult) []ApprovalEvent {
	t.Helper()
	var result []ApprovalEvent
	for _, event := range read.Events {
		if event.Kind != EventApproval {
			continue
		}
		var payload ApprovalEvent
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			t.Fatalf("decode approval event: %v", err)
		}
		result = append(result, payload)
	}
	return result
}

func TestAutoApprovalRunsSideEffectToolWithoutPromptingForADecision(t *testing.T) {
	policy := &togglePolicy{}
	policy.allow.Store(true)
	harness, catalog := newAutoApprovalHarness(t, policy)

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{RequestID: "auto-approve", Content: "write"})
	if err != nil {
		t.Fatal(err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })

	if read.Run.State != RunStateCompleted {
		t.Fatalf("run state = %s, want completed", read.Run.State)
	}
	if catalog.executions.Load() != 1 {
		t.Fatalf("tool executions = %d, want 1", catalog.executions.Load())
	}
	for _, event := range approvalEvents(t, read) {
		if event.Decision == "pending" {
			t.Fatalf("auto-approved call must never surface a pending approval card: %+v", event)
		}
	}
	last, _ := policy.last.Load().(AutoApprovalRequest)
	if last.SessionID != read.Run.SessionID || last.ToolName != "write" || last.Effect != ToolEffectSideEffect {
		t.Fatalf("policy saw %+v", last)
	}
}

func TestWithoutAutoApprovalTheRunWaitsForAHumanDecision(t *testing.T) {
	policy := &togglePolicy{}
	harness, catalog := newAutoApprovalHarness(t, policy)

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{RequestID: "no-auto-approve", Content: "write"})
	if err != nil {
		t.Fatal(err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State == RunStateAwaitingApproval })

	if catalog.executions.Load() != 0 {
		t.Fatalf("tool ran without approval: %d", catalog.executions.Load())
	}
	events := approvalEvents(t, read)
	if len(events) != 1 || events[0].Decision != "pending" {
		t.Fatalf("approval events = %+v, want a single pending card", events)
	}
}

func TestEnablingAutoApprovalReleasesARunAlreadyWaitingForApproval(t *testing.T) {
	policy := &togglePolicy{}
	harness, catalog := newAutoApprovalHarness(t, policy)

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{RequestID: "release-waiting", Content: "write"})
	if err != nil {
		t.Fatal(err)
	}
	waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State == RunStateAwaitingApproval })

	policy.allow.Store(true)
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })

	if read.Run.State != RunStateCompleted || catalog.executions.Load() != 1 {
		t.Fatalf("state=%s executions=%d, want completed with one execution", read.Run.State, catalog.executions.Load())
	}
}
