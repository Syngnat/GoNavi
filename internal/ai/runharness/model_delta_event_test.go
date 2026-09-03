package runharness

import (
	"context"
	"encoding/json"
	"testing"
)

type incompleteToolDeltaModel struct{}

func (incompleteToolDeltaModel) Execute(ctx context.Context, _ ModelTurnRequest, sink ModelDeltaSink) (ModelTurnResult, error) {
	partial := ToolIntent{
		CallID:    "partial-call",
		ToolName:  "read",
		Arguments: json.RawMessage(`{"query":`),
		Effect:    ToolEffectReadOnly,
	}
	if err := sink(ctx, ModelDelta{ToolCalls: []ToolIntent{partial}}); err != nil {
		return ModelTurnResult{}, err
	}
	return ModelTurnResult{ToolCalls: []ToolIntent{partial}, Completed: true}, nil
}

func TestHarnessProjectsIncompleteStreamToolArgumentsWithoutBreakingLedgerEvents(t *testing.T) {
	harness, _ := newContractHarness(t, incompleteToolDeltaModel{}, &contractToolCatalog{
		descriptor: ToolDescriptor{
			Name:        "read",
			Effect:      ToolEffectReadOnly,
			InputSchema: json.RawMessage(`{"type":"object"}`),
		},
		effect: ToolEffectReadOnly,
	}, nil)

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{
		RequestID: "partial-stream-tool-arguments",
		Content:   "read the current schema",
	})
	if err != nil {
		t.Fatal(err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool {
		return run.State.Terminal()
	})
	if read.Run.State != RunStateFailed {
		t.Fatalf("run state = %s, want %s", read.Run.State, RunStateFailed)
	}

	var foundDelta, foundMalformedError bool
	for _, event := range read.Events {
		switch event.Kind {
		case EventModelDelta:
			var payload ModelDeltaEvent
			if err := json.Unmarshal(event.Payload, &payload); err != nil {
				t.Fatalf("decode model delta: %v", err)
			}
			if len(payload.ToolCalls) == 1 && payload.ToolCalls[0].CallID == "partial-call" {
				foundDelta = true
				if len(payload.ToolCalls[0].Arguments) != 0 {
					t.Fatalf("event exposed incomplete tool arguments: %q", payload.ToolCalls[0].Arguments)
				}
			}
		case EventRunError:
			var payload RunErrorEvent
			if err := json.Unmarshal(event.Payload, &payload); err != nil {
				t.Fatalf("decode run error: %v", err)
			}
			foundMalformedError = foundMalformedError || payload.Code == "malformed_tool_call"
		}
	}
	if !foundDelta {
		t.Fatal("missing model_delta event for partial tool call")
	}
	if !foundMalformedError {
		t.Fatal("missing malformed_tool_call error; expected validation instead of event marshal failure")
	}
}
