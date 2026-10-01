package runharness

import (
	"encoding/json"
	"strings"
)

// mergeModelDeltaToolIntents folds one provider chunk into the tool calls that
// wait for the next model_delta event. Providers such as OpenAI Responses report
// a cumulative snapshot of every call seen so far, so a flush window spanning
// several chunks would otherwise repeat the same call ID inside one event and
// strict consumers reject the whole event. The latest snapshot wins and the
// first-seen order is kept. Fragments that have no call ID yet cannot be shown
// or matched; the completed turn still carries the validated calls.
func mergeModelDeltaToolIntents(pending, incoming []ToolIntent) []ToolIntent {
	for _, intent := range incoming {
		callID := strings.TrimSpace(intent.CallID)
		if callID == "" {
			continue
		}
		replaced := false
		for index := range pending {
			if pending[index].CallID == callID {
				pending[index] = intent
				replaced = true
				break
			}
		}
		if !replaced {
			pending = append(pending, intent)
		}
	}
	return pending
}

// projectModelDeltaToolIntents keeps intermediate provider fragments out of
// the durable event envelope. A streaming provider may emit `{"query":`
// before completing a tool call; json.RawMessage rejects that fragment during
// event serialization. The original intent remains untouched so final-turn
// validation still returns malformed_tool_call rather than treating it as {}.
func projectModelDeltaToolIntents(intents []ToolIntent) []ToolIntent {
	if len(intents) == 0 {
		return nil
	}
	projected := make([]ToolIntent, len(intents))
	copy(projected, intents)
	for index := range projected {
		if len(projected[index].Arguments) > 0 && !json.Valid(projected[index].Arguments) {
			projected[index].Arguments = nil
		}
	}
	return projected
}
