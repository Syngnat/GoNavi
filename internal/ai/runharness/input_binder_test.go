package runharness

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestSubmitInputReturnsExistingRunBeforeInputBinder(t *testing.T) {
	ctx := context.Background()
	ledger := testLedger(t)
	seeded, err := ledger.CreateRun(ctx, CreateRunRequest{
		SessionID: "input-binder-session", RequestID: "input-binder-retry",
		Policy: DefaultRunPolicy(), InitialMessage: &Message{Role: "user", Content: "first input"},
	})
	if err != nil {
		t.Fatalf("seed durable run: %v", err)
	}
	binderCalls := 0
	harness, err := NewAgentRunHarness(HarnessConfig{
		Ledger: ledger, RootContext: ctx, OwnerID: "input-binder-owner",
		InputBinder: func(context.Context, *AgentInputRequest) error {
			binderCalls++
			return errors.New("provider settings are unavailable")
		},
	})
	if err != nil {
		t.Fatalf("new harness: %v", err)
	}
	t.Cleanup(func() { _ = harness.Close() })

	receipt, err := harness.SubmitInput(ctx, AgentInputRequest{
		RequestID: "input-binder-retry", Content: "retry after provider settings changed",
	})
	if err != nil {
		t.Fatalf("retry input: %v", err)
	}
	if binderCalls != 0 {
		t.Fatalf("input binder calls = %d, want 0 for an existing request ID", binderCalls)
	}
	if receipt.RunID != seeded.ID || receipt.SessionID != seeded.SessionID || receipt.RequestID != seeded.RequestID {
		t.Fatalf("retry receipt = %+v, want seeded run %+v", receipt, seeded)
	}
}

type inputBinderBlockingModel struct {
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (m *inputBinderBlockingModel) Execute(context.Context, ModelTurnRequest, ModelDeltaSink) (ModelTurnResult, error) {
	m.once.Do(func() { close(m.started) })
	<-m.release
	return ModelTurnResult{Completed: true}, nil
}

func TestSubmitInputReturnsExistingSteerBeforeInputBinder(t *testing.T) {
	ctx := context.Background()
	ledger := testLedger(t)
	model := &inputBinderBlockingModel{started: make(chan struct{}), release: make(chan struct{})}
	binderCalls := 0
	failBinder := false
	harness, err := NewAgentRunHarness(HarnessConfig{
		Ledger: ledger, Model: model, RootContext: ctx, OwnerID: "input-binder-steer-owner",
		InputBinder: func(context.Context, *AgentInputRequest) error {
			binderCalls++
			if failBinder {
				return errors.New("provider settings are unavailable")
			}
			return nil
		},
	})
	if err != nil {
		t.Fatalf("new harness: %v", err)
	}
	t.Cleanup(func() {
		close(model.release)
		_ = harness.Close()
	})

	first, err := harness.SubmitInput(ctx, AgentInputRequest{
		RequestID: "input-binder-steer-root", Content: "first input",
	})
	if err != nil {
		t.Fatalf("submit root input: %v", err)
	}
	select {
	case <-model.started:
	case <-time.After(time.Second):
		t.Fatal("model did not start")
	}
	active, err := ledger.GetRun(ctx, first.RunID)
	if err != nil {
		t.Fatalf("read active run: %v", err)
	}
	steerRequest := AgentInputRequest{
		RequestID: "input-binder-steer-retry", SessionID: first.SessionID,
		Content: "take a different direction", DispatchMode: DispatchSteer,
		ExpectedRevision: active.Revision,
	}
	steered, err := harness.SubmitInput(ctx, steerRequest)
	if err != nil {
		t.Fatalf("submit steer: %v", err)
	}
	if steered.Disposition != "steered" || steered.RunID != first.RunID {
		t.Fatalf("steer receipt = %+v, want run %q", steered, first.RunID)
	}

	failBinder = true
	retryRequest := steerRequest
	// The host's default dispatch mode may have changed after the steer was
	// accepted. A blank mode is still a retry of the durable steer command.
	retryRequest.DispatchMode = ""
	retry, err := harness.SubmitInput(ctx, retryRequest)
	if err != nil {
		t.Fatalf("retry steer after provider settings changed: %v", err)
	}
	if retry.Disposition != "steered" || retry.RunID != first.RunID {
		t.Fatalf("retry steer receipt = %+v, want original run %q", retry, first.RunID)
	}
	if binderCalls != 2 {
		t.Fatalf("input binder calls = %d, want 2 without an invocation for the existing steer", binderCalls)
	}
}

func TestSubmitInputRechecksSteerAfterInputBinderFailure(t *testing.T) {
	ctx := context.Background()
	ledger := testLedger(t)
	target, err := ledger.CreateRun(ctx, CreateRunRequest{
		SessionID: "input-binder-race-session", RequestID: "input-binder-race-root",
		Policy: DefaultRunPolicy(), InitialMessage: &Message{Role: "user", Content: "first input"},
	})
	if err != nil {
		t.Fatalf("create steer target: %v", err)
	}
	const requestID = "input-binder-race-steer"
	binderCalls := 0
	harness, err := NewAgentRunHarness(HarnessConfig{
		Ledger: ledger, RootContext: ctx, OwnerID: "input-binder-race-owner",
		InputBinder: func(_ context.Context, request *AgentInputRequest) error {
			binderCalls++
			if request.RequestID != requestID {
				return nil
			}
			payload, payloadErr := marshalSteerInputPayload(*request)
			if payloadErr != nil {
				return payloadErr
			}
			if _, enqueueErr := ledger.EnqueueCommand(ctx, ControlCommand{
				ID: request.RequestID, RunID: target.ID, Action: ControlSteer,
				Payload: payload, ExpectedRevision: request.ExpectedRevision,
			}); enqueueErr != nil {
				return enqueueErr
			}
			return errors.New("provider settings are unavailable")
		},
	})
	if err != nil {
		t.Fatalf("new harness: %v", err)
	}
	t.Cleanup(func() { _ = harness.Close() })

	receipt, err := harness.SubmitInput(ctx, AgentInputRequest{
		RequestID: requestID, SessionID: target.SessionID, Content: "steer accepted elsewhere",
		DispatchMode: DispatchSteer, ExpectedRevision: target.Revision,
	})
	if err != nil {
		t.Fatalf("submit steer racing provider failure: %v", err)
	}
	if receipt.Disposition != "steered" || receipt.RunID != target.ID || receipt.SessionID != target.SessionID {
		t.Fatalf("racing steer receipt = %+v, want target %+v", receipt, target)
	}
	if binderCalls != 1 {
		t.Fatalf("input binder calls = %d, want 1", binderCalls)
	}
}

func TestSubmitInputRejectsConflictingExistingSteerBeforeInputBinder(t *testing.T) {
	ctx := context.Background()
	ledger := testLedger(t)
	target, err := ledger.CreateRun(ctx, CreateRunRequest{
		SessionID: "input-binder-conflict-session", RequestID: "input-binder-conflict-root",
		Policy: DefaultRunPolicy(), InitialMessage: &Message{Role: "user", Content: "first input"},
	})
	if err != nil {
		t.Fatalf("create steer target: %v", err)
	}
	base := AgentInputRequest{
		RequestID: "input-binder-conflict-steer", SessionID: target.SessionID,
		Content: "keep this steer", DispatchMode: DispatchSteer, ExpectedRevision: target.Revision,
	}
	payload, err := marshalSteerInputPayload(base)
	if err != nil {
		t.Fatalf("marshal steer payload: %v", err)
	}
	if _, err := ledger.EnqueueCommand(ctx, ControlCommand{
		ID: base.RequestID, RunID: target.ID, Action: ControlSteer,
		Payload: payload, ExpectedRevision: target.Revision,
	}); err != nil {
		t.Fatalf("enqueue durable steer: %v", err)
	}
	binderCalls := 0
	harness, err := NewAgentRunHarness(HarnessConfig{
		Ledger: ledger, RootContext: ctx, OwnerID: "input-binder-conflict-owner",
		InputBinder: func(context.Context, *AgentInputRequest) error {
			binderCalls++
			return errors.New("provider settings are unavailable")
		},
	})
	if err != nil {
		t.Fatalf("new harness: %v", err)
	}
	t.Cleanup(func() { _ = harness.Close() })

	tests := []struct {
		name   string
		mutate func(*AgentInputRequest)
	}{
		{
			name: "dispatch",
			mutate: func(request *AgentInputRequest) {
				request.DispatchMode = DispatchQueue
			},
		},
		{
			name: "session",
			mutate: func(request *AgentInputRequest) {
				request.SessionID = "another-session"
			},
		},
		{
			name: "branch",
			mutate: func(request *AgentInputRequest) {
				request.BranchFromMessageID = "branch-cursor"
			},
		},
		{
			name: "revision",
			mutate: func(request *AgentInputRequest) {
				request.ExpectedRevision++
			},
		},
		{
			name: "content",
			mutate: func(request *AgentInputRequest) {
				request.Content = "different steer"
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := base
			test.mutate(&request)
			_, err := harness.SubmitInput(ctx, request)
			if !errors.Is(err, ErrControlCommandConflict) {
				t.Fatalf("conflicting replay error = %v, want ErrControlCommandConflict", err)
			}
		})
	}
	if binderCalls != 0 {
		t.Fatalf("input binder calls = %d, want 0 for conflicting durable steer retries", binderCalls)
	}
}
