package runharness

import (
	"context"
	"encoding/json"
	"testing"
)

func TestMergeModelDeltaToolIntentsKeepsLatestSnapshotPerCallID(t *testing.T) {
	first := ToolIntent{CallID: "call-a", ToolName: "execute_sql"}
	second := ToolIntent{CallID: "call-b", ToolName: "get_tables"}
	firstWithArgs := ToolIntent{CallID: "call-a", ToolName: "execute_sql", Arguments: json.RawMessage(`{"sql":"select 1"}`)}

	pending := mergeModelDeltaToolIntents(nil, []ToolIntent{first})
	pending = mergeModelDeltaToolIntents(pending, []ToolIntent{first, second})
	pending = mergeModelDeltaToolIntents(pending, []ToolIntent{firstWithArgs, second})

	if len(pending) != 2 {
		t.Fatalf("pending tool intents = %d, want 2 (one per call ID): %+v", len(pending), pending)
	}
	if pending[0].CallID != "call-a" || pending[1].CallID != "call-b" {
		t.Fatalf("first-seen order lost: %+v", pending)
	}
	if string(pending[0].Arguments) != `{"sql":"select 1"}` {
		t.Fatalf("latest snapshot did not win: %q", pending[0].Arguments)
	}
}

func TestMergeModelDeltaToolIntentsSkipsFragmentsWithoutCallID(t *testing.T) {
	pending := mergeModelDeltaToolIntents(nil, []ToolIntent{
		{ToolName: "execute_sql"},
		{CallID: "  ", ToolName: "execute_sql"},
	})
	if len(pending) != 0 {
		t.Fatalf("fragments without a call ID must not reach the event envelope: %+v", pending)
	}
}

// cumulativeToolDeltaModel mimics the OpenAI Responses provider: every chunk
// carries the full list of tool calls seen so far, and several chunks land
// inside one event flush window.
type cumulativeToolDeltaModel struct{}

func (cumulativeToolDeltaModel) Execute(ctx context.Context, _ ModelTurnRequest, sink ModelDeltaSink) (ModelTurnResult, error) {
	version := ToolIntent{CallID: "call-version", ToolName: "get_server_version", Arguments: json.RawMessage(`{"connectionId":"c1"}`)}
	tables := ToolIntent{CallID: "call-tables", ToolName: "get_tables"}
	snapshots := [][]ToolIntent{
		{version},
		{version, tables},
		{version, tables},
	}
	for _, snapshot := range snapshots {
		if err := sink(ctx, ModelDelta{ToolCalls: snapshot}); err != nil {
			return ModelTurnResult{}, err
		}
	}
	return ModelTurnResult{Text: "done", Completed: true}, nil
}

func TestHarnessModelDeltaEventsNeverRepeatToolCallIDs(t *testing.T) {
	harness, _ := newContractHarness(t, cumulativeToolDeltaModel{}, nil, nil)

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{
		RequestID: "cumulative-tool-deltas",
		Content:   "inspect the schema",
	})
	if err != nil {
		t.Fatal(err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool {
		return run.State.Terminal()
	})

	sawToolDelta := false
	for _, event := range read.Events {
		if event.Kind != EventModelDelta {
			continue
		}
		var payload ModelDeltaEvent
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			t.Fatalf("decode model delta: %v", err)
		}
		seen := map[string]bool{}
		for _, call := range payload.ToolCalls {
			sawToolDelta = true
			if seen[call.CallID] {
				t.Fatalf("model_delta seq %d repeats call ID %q: %+v", event.Sequence, call.CallID, payload.ToolCalls)
			}
			seen[call.CallID] = true
		}
	}
	if !sawToolDelta {
		t.Fatal("expected at least one model_delta carrying tool calls")
	}
}
