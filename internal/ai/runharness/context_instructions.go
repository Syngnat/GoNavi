package runharness

import (
	"context"
	"encoding/json"
	"strings"
	"unicode/utf8"
)

// Standing instructions are what the host tells the model before anything else: GoNavi's role
// prompt for the kind of task, followed by the instructions the person wrote in the AI settings.
// The harness does not choose them; the host does (see InstructionsResolver), once per turn, from
// what the turn is about. They reach the model as the first system message and count against the
// prompt budget like the workspace does: they are never dropped to make room.

// InstructionsHeader starts the instructions message, so a provider adapter that has to present
// them differently (a small model, see the built-in AI) can recognize them.
const InstructionsHeader = "# GoNavi instructions"

// maxInstructionsBytes bounds what the host may hand over, so a very long custom prompt cannot
// crowd the conversation out of the window.
const maxInstructionsBytes = 16 << 10

// InstructionsRequest is what a turn is about.
type InstructionsRequest struct {
	TaskKind AgentTaskKind
	// Provider is the provider ID the turn runs on.
	Provider string
	// Workspace is the snapshot the turn is built from (nil when there is none). Read only.
	Workspace *WorkspaceSnapshot
}

// InstructionsResolver returns the standing instructions for a turn, or "" for none.
type InstructionsResolver func(context.Context, InstructionsRequest) string

// WithInstructions sets where the standing instructions come from.
func WithInstructions(resolver InstructionsResolver) HarnessOption {
	return func(c *HarnessConfig) { c.Instructions = resolver }
}

// instructionsFor asks the host for a turn's instructions. A host that fails must not fail the
// turn: it goes ahead without them.
func (h *AgentRunHarness) instructionsFor(ctx context.Context, request InstructionsRequest) (text string) {
	if h == nil || h.instructions == nil {
		return ""
	}
	defer func() {
		if recover() != nil {
			text = ""
		}
	}()
	return h.instructions(ctx, request)
}

// instructionsMessage is the system message carrying the instructions, or false when there are none.
func instructionsMessage(text string) (Message, bool) {
	text = strings.TrimSpace(text)
	if text == "" {
		return Message{}, false
	}
	if len(text) > maxInstructionsBytes {
		cut := maxInstructionsBytes
		for cut > 0 && !utf8.RuneStart(text[cut]) {
			cut--
		}
		text = text[:cut]
	}
	metadata, _ := json.Marshal(struct {
		Kind string `json:"kind"`
	}{Kind: "instructions"})
	return Message{Role: "system", Content: InstructionsHeader + "\n" + text, Metadata: metadata}, true
}
