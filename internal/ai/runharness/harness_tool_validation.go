package runharness

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

func toolIntentFromRecord(record ToolCallRecord) ToolIntent {
	return ToolIntent{CallID: record.CallID, ToolName: record.ToolName,
		Arguments: append(json.RawMessage(nil), record.Arguments...), Effect: record.Effect,
		ArgsHash: record.ArgsHash}
}

// resumeToolCounters reconstructs the budget counters that are intentionally
// not reset when a process resumes an existing run. Event history is the source
// of truth, so a crash between turns cannot grant extra tool rounds.
func (h *AgentRunHarness) resumeToolCounters(ctx context.Context, runID string) (int, int) {
	if h == nil || h.ledger == nil {
		return 0, 0
	}
	events, err := h.ledger.ListEvents(ctx, runID, 0, 100000)
	if err != nil {
		return 0, 0
	}
	type round struct{ failed bool }
	rounds := make([]round, 0)
	for _, event := range events {
		switch event.Kind {
		case EventModelCompleted:
			var completed ModelCompletedEvent
			if json.Unmarshal(event.Payload, &completed) == nil && len(completed.ToolCalls) > 0 {
				rounds = append(rounds, round{})
			}
		case EventTool:
			if len(rounds) == 0 {
				continue
			}
			var tool ToolEvent
			// A durable started boundary proves that the executor may have begun,
			// but it is not an outcome. Counting it as a failed round would make a
			// resumed run exhaust its failure budget before the tool can settle.
			if json.Unmarshal(event.Payload, &tool) == nil && tool.Status != "started" && tool.Status != "completed" {
				rounds[len(rounds)-1].failed = true
			}
		}
	}
	failed := 0
	for index := len(rounds) - 1; index >= 0 && rounds[index].failed; index-- {
		failed++
	}
	return len(rounds), failed
}

func marshalToolResult(result ToolExecutionResult, err error) string {
	return string(encodeToolResult(result, err, 0).JSON)
}

func effectiveToolResultBytes(policy RunPolicy, descriptor ToolDescriptor) int64 {
	policyLimit := policy.MaxToolResultBytes
	descriptorLimit := descriptor.MaxResultBytes
	if policyLimit <= 0 {
		return descriptorLimit
	}
	if descriptorLimit <= 0 || policyLimit < descriptorLimit {
		return policyLimit
	}
	return descriptorLimit
}

func cloneMessages(messages []Message) []Message {
	if len(messages) == 0 {
		return nil
	}
	result := make([]Message, len(messages))
	copy(result, messages)
	for i := range result {
		result[i].ToolCalls = append(json.RawMessage(nil), result[i].ToolCalls...)
	}
	return result
}

func jsonEqualRaw(left, right json.RawMessage) bool {
	if len(left) == 0 {
		left = json.RawMessage(`{}`)
	}
	if len(right) == 0 {
		right = json.RawMessage(`{}`)
	}
	if !json.Valid(left) || !json.Valid(right) {
		return false
	}
	return ArgsHash(left) == ArgsHash(right)
}

func hasCommittedTool(messages []Message, runIDs ...string) bool {
	runID := ""
	if len(runIDs) > 0 {
		runID = strings.TrimSpace(runIDs[0])
	}
	for _, message := range messages {
		// Session history may contain tool messages from older/completed runs.
		// Restrict the guard to the current run when the caller supplies its ID;
		// retaining the no-argument behavior keeps this helper useful for legacy
		// callers and tests.
		if runID != "" && message.RunID != runID {
			continue
		}
		if message.Role == "tool" {
			return true
		}
		if message.Role != "assistant" {
			continue
		}
		// The assistant tool intent is committed atomically with the model turn,
		// before any executor runs. It is therefore enough to block a blind
		// provider retry even when no tool result message exists yet.
		trimmed := strings.TrimSpace(string(message.ToolCalls))
		if trimmed != "" && trimmed != "null" && trimmed != "[]" {
			return true
		}
	}
	return false
}

func descriptorEffect(descriptors []ToolDescriptor, name string) ToolEffect {
	for _, descriptor := range descriptors {
		if descriptor.Name == name {
			return descriptor.Effect
		}
	}
	return ToolEffectSideEffectUnknown
}

func normalizeToolIntentEffects(intents []ToolIntent, descriptors []ToolDescriptor) {
	for index := range intents {
		if strings.TrimSpace(string(intents[index].Effect)) != "" {
			continue
		}
		intents[index].Effect = descriptorEffect(descriptors, intents[index].ToolName)
	}
}

func validateToolIntents(intents []ToolIntent, descriptors []ToolDescriptor) error {
	seen := make(map[string]struct{}, len(intents))
	for _, intent := range intents {
		callID := strings.TrimSpace(intent.CallID)
		name := strings.TrimSpace(intent.ToolName)
		if callID == "" || name == "" {
			return fmt.Errorf("%w: callId and toolName are required", ErrMalformedToolCall)
		}
		// Providers are allowed to omit effect (the immutable Go catalog fills it
		// in below), but an explicit value must still be a known enum.  Silently
		// accepting an unknown value would let malformed model output cross the
		// approval/start boundary and would make the durable tool contract
		// ambiguous on replay.
		if strings.TrimSpace(string(intent.Effect)) != "" && !intent.Effect.Valid() {
			return fmt.Errorf("%w: invalid effect %q for %s", ErrMalformedToolCall, intent.Effect, name)
		}
		if _, exists := seen[callID]; exists {
			return fmt.Errorf("%w: duplicate callId %q", ErrMalformedToolCall, callID)
		}
		seen[callID] = struct{}{}
		if !json.Valid(intent.Arguments) {
			return fmt.Errorf("%w: arguments for %s are not valid JSON", ErrMalformedToolCall, name)
		}
		found := false
		for _, descriptor := range descriptors {
			if descriptor.Name == name {
				found = true
				if err := validateToolArguments(descriptor.InputSchema, intent.Arguments); err != nil {
					return fmt.Errorf("%w: %s", ErrMalformedToolCall, err)
				}
				break
			}
		}
		if !found {
			return fmt.Errorf("%w: unknown tool %q", ErrMalformedToolCall, name)
		}
	}
	return nil
}

func validateRunToolIntents(intents []ToolIntent, descriptors []ToolDescriptor, allowTools bool) error {
	if !allowTools && len(intents) > 0 {
		return fmt.Errorf("%w: %w", ErrMalformedToolCall, ErrToolCallsDisabled)
	}
	return validateToolIntents(intents, descriptors)
}

// validateToolArguments covers the JSON-schema subset needed by built-in and
// MCP tools. Unknown schema keywords are intentionally ignored; malformed
// JSON and required/type violations are always rejected before execution.
func validateToolArguments(schema, arguments json.RawMessage) error {
	if len(arguments) == 0 {
		arguments = json.RawMessage(`{}`)
	}
	if !json.Valid(arguments) {
		return ErrToolSchema
	}
	if len(schema) == 0 || !json.Valid(schema) {
		return nil
	}
	var schemaValue struct {
		Type                 string   `json:"type"`
		Required             []string `json:"required"`
		AdditionalProperties *bool    `json:"additionalProperties"`
		Properties           map[string]struct {
			Type string `json:"type"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(schema, &schemaValue); err != nil {
		return err
	}
	var value map[string]any
	if err := json.Unmarshal(arguments, &value); err != nil {
		return ErrToolSchema
	}
	if schemaValue.Type == "object" && value == nil {
		return ErrToolSchema
	}
	if schemaValue.Type == "object" && schemaValue.AdditionalProperties != nil && !*schemaValue.AdditionalProperties {
		for name := range value {
			if _, known := schemaValue.Properties[name]; !known {
				return fmt.Errorf("unknown argument %q", name)
			}
		}
	}
	for _, required := range schemaValue.Required {
		if _, ok := value[required]; !ok {
			return fmt.Errorf("missing required argument %q", required)
		}
	}
	for name, property := range schemaValue.Properties {
		item, exists := value[name]
		if !exists || property.Type == "" {
			continue
		}
		if !jsonTypeMatches(item, property.Type) {
			return fmt.Errorf("argument %q must be %s", name, property.Type)
		}
	}
	return nil
}

func jsonTypeMatches(value any, expected string) bool {
	switch expected {
	case "string":
		_, ok := value.(string)
		return ok
	case "number":
		_, ok := value.(float64)
		return ok
	case "integer":
		number, ok := value.(float64)
		return ok && math.Trunc(number) == number
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "array":
		_, ok := value.([]any)
		return ok
	case "object":
		_, ok := value.(map[string]any)
		return ok
	case "null":
		return value == nil
	default:
		return true
	}
}

// ArgsHash is exported for adapters that need to display/compare approval
// bindings without persisting the raw tool arguments themselves.
func ArgsHash(arguments json.RawMessage) string {
	sum := sha256.Sum256(arguments)
	return hex.EncodeToString(sum[:])
}
