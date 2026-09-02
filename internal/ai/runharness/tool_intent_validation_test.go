package runharness

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestValidateToolIntentsRejectsExplicitUnknownEffect(t *testing.T) {
	descriptors := []ToolDescriptor{{
		Name:   "read",
		Effect: ToolEffectReadOnly,
	}}
	intents := []ToolIntent{{
		CallID:    "call-1",
		ToolName:  "read",
		Effect:    ToolEffect("unexpected"),
		Arguments: json.RawMessage(`{}`),
	}}

	err := validateToolIntents(intents, descriptors)
	if !errors.Is(err, ErrMalformedToolCall) {
		t.Fatalf("validateToolIntents error = %v, want ErrMalformedToolCall", err)
	}
}

func TestValidateToolIntentsAllowsCatalogFilledEffect(t *testing.T) {
	descriptors := []ToolDescriptor{{
		Name:   "read",
		Effect: ToolEffectReadOnly,
	}}
	intents := []ToolIntent{{
		CallID:    "call-1",
		ToolName:  "read",
		Arguments: json.RawMessage(`{}`),
	}}

	if err := validateToolIntents(intents, descriptors); err != nil {
		t.Fatalf("validateToolIntents omitted effect error = %v", err)
	}
}

func TestSupersedeToolIntentsAndSteerIsIdempotentByRequestID(t *testing.T) {
	ledger := testLedger(t)
	ctx := context.Background()
	run, err := ledger.CreateRun(ctx, CreateRunRequest{
		SessionID: "steer-idempotency-session", RequestID: "steer-idempotency-run",
		Policy: DefaultRunPolicy(),
	})
	if err != nil {
		t.Fatal(err)
	}
	request := SupersedeToolIntentsRequest{
		RunID: run.ID, ExpectedRevision: run.Revision, RequestID: "steer-idempotency-command",
		SteerContent: "answer directly",
	}
	first, err := ledger.SupersedeToolIntentsAndSteer(ctx, request)
	if err != nil {
		t.Fatalf("first steer: %v", err)
	}
	if len(first.Messages) != 1 || len(first.Events) != 2 {
		t.Fatalf("first steer writes messages=%d events=%d, want 1/2", len(first.Messages), len(first.Events))
	}
	second, err := ledger.SupersedeToolIntentsAndSteer(ctx, request)
	if err != nil {
		t.Fatalf("idempotent steer retry: %v", err)
	}
	if second.Run.Revision != first.Run.Revision {
		t.Fatalf("retry revision = %d, want %d", second.Run.Revision, first.Run.Revision)
	}
	if len(second.Messages) != 0 || len(second.Events) != 0 {
		t.Fatalf("idempotent steer retry writes messages=%d events=%d", len(second.Messages), len(second.Events))
	}
	read, err := ledger.ReadRun(ctx, RunReadRequest{RunID: run.ID, Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	var steerInputs int
	for _, event := range read.Events {
		if event.Kind != EventInput {
			continue
		}
		var payload InputEvent
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		if payload.RequestID == request.RequestID {
			steerInputs++
		}
	}
	if steerInputs != 1 {
		t.Fatalf("steer input events = %d, want exactly one", steerInputs)
	}
}
