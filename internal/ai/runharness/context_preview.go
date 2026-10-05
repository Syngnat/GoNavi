package runharness

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
)

// ContextPreviewRequest is what the next input would be built from: the same
// pieces a real run reads (the session so far, the newest workspace snapshot the
// desktop published, the input being typed with what is attached to it), measured
// by the very builder a run uses. Nothing is stored and no provider is called.
type ContextPreviewRequest struct {
	SessionID   string       `json:"sessionId,omitempty"`
	Content     string       `json:"content"`
	Attachments []Attachment `json:"attachments,omitempty"`

	ContextSourceID         string `json:"contextSourceId,omitempty"`
	ContextSourceInstanceID string `json:"contextSourceInstanceId,omitempty"`

	// The provider's window and the room it keeps for the answer, as a run would freeze them.
	ContextWindowTokens  int  `json:"contextWindowTokens"`
	ReservedOutputTokens int  `json:"reservedOutputTokens"`
	OmitImages           bool `json:"omitImages,omitempty"`

	// Provider and TaskKind choose the standing instructions, as for a run.
	Provider string        `json:"provider,omitempty"`
	TaskKind AgentTaskKind `json:"taskKind,omitempty"`
}

// ContextPreview is what a run built from that input would send, in the unit the
// builder budgets in (bytes of each JSON-encoded message), by where it comes from.
// A workspace that had to be trimmed to fit, or earlier messages that no longer
// fit, are already left out of these numbers: they are what is sent.
type ContextPreview struct {
	WindowTokens         int `json:"windowTokens"`
	ReservedOutputTokens int `json:"reservedOutputTokens"`

	// InstructionsBytes is the standing instructions: GoNavi's role prompt and the person's own.
	InstructionsBytes int `json:"instructionsBytes"`

	// WorkspaceBytes is the workspace snapshot as sent, without the items the person
	// bound (BoundBytes: selections, quoted passages, table schemas).
	WorkspaceBytes int `json:"workspaceBytes"`
	BoundBytes     int `json:"boundBytes"`
	// What the conversation carries, newest message included.
	UserBytes      int `json:"userBytes"`
	AssistantBytes int `json:"assistantBytes"`
	ToolBytes      int `json:"toolBytes"`

	RetainedMessages int `json:"retainedMessages"`
	// OmittedMessages are earlier messages left out because they no longer fit.
	OmittedMessages int `json:"omittedMessages"`
	// WorkspaceTrimmed names how far the workspace was cut (see the WorkspaceTrim* levels); empty when sent whole.
	WorkspaceTrimmed string `json:"workspaceTrimmed,omitempty"`
	// Overflow is set when even the newest message alone does not fit, so a run would be refused.
	Overflow bool `json:"overflow,omitempty"`
}

// PreviewContext measures what the next input would send. It reads the ledger and
// changes nothing.
func (h *AgentRunHarness) PreviewContext(ctx context.Context, request ContextPreviewRequest) (ContextPreview, error) {
	messages, err := h.previewMessages(ctx, request.SessionID)
	if err != nil {
		return ContextPreview{}, err
	}
	// An empty input box is no message yet: nothing is counted for it.
	hasInput := strings.TrimSpace(request.Content) != "" || len(request.Attachments) > 0
	if hasInput {
		messages = append(messages, Message{ID: "preview-input", SessionID: request.SessionID, Role: "user", Content: request.Content, Attachments: request.Attachments})
	}

	var snapshot *WorkspaceSnapshot
	var reference *WorkspaceSnapshotReference
	if source, instance := strings.TrimSpace(request.ContextSourceID), strings.TrimSpace(request.ContextSourceInstanceID); source != "" && instance != "" {
		latest, _, snapshotErr := h.ledger.LatestWorkspaceSnapshotAllowExpired(ctx, source, instance)
		switch {
		case snapshotErr == nil:
			snapshot, reference = &latest, workspaceSnapshotReference(latest)
		case !errors.Is(snapshotErr, ErrNotFound):
			return ContextPreview{}, snapshotErr
		}
	}

	preview := ContextPreview{WindowTokens: request.ContextWindowTokens, ReservedOutputTokens: request.ReservedOutputTokens}
	instructions := h.instructionsFor(ctx, InstructionsRequest{TaskKind: request.TaskKind.Normalize(), Provider: request.Provider, Workspace: snapshot})
	built, err := h.contextBuilder.Build(ctx, ContextBuildRequest{
		Instructions:         instructions,
		Run:                  RunSnapshot{SessionID: request.SessionID},
		Messages:             messages,
		WorkspaceSnapshot:    snapshot,
		WorkspaceReference:   reference,
		ContextWindowTokens:  request.ContextWindowTokens,
		ReservedOutputTokens: request.ReservedOutputTokens,
		OmitImages:           request.OmitImages,
	})
	if errors.Is(err, ErrContextLimit) {
		// Not even the newest message fits: report it as such, with what is known.
		preview.Overflow = true
		if hasInput {
			preview.UserBytes = messageBytes(projectAttachments(messages[len(messages)-1:], request.ContextWindowTokens-request.ReservedOutputTokens, request.OmitImages)[0])
		}
		return preview, nil
	}
	if err != nil {
		return ContextPreview{}, err
	}

	preview.WorkspaceTrimmed = built.Compression.WorkspaceTrimmed
	preview.OmittedMessages = built.Compression.OmittedMessageCount
	messages = built.Request.Messages
	if built.Compression.InstructionsIncluded && len(messages) > 0 {
		preview.InstructionsBytes = messageBytes(messages[0])
		messages = messages[1:]
	}
	for index, message := range messages {
		if index == 0 && built.Compression.WorkspaceIncluded {
			total, bound := messageBytes(message), boundItemsBytes(message)
			preview.WorkspaceBytes, preview.BoundBytes = total-bound, bound
			continue
		}
		preview.RetainedMessages++
		switch message.Role {
		case "assistant":
			preview.AssistantBytes += messageBytes(message)
		case "tool":
			preview.ToolBytes += messageBytes(message)
		default:
			preview.UserBytes += messageBytes(message)
		}
	}
	return preview, nil
}

// previewMessages reads the session's durable messages the way a run does. A
// session that does not exist yet (a new conversation) has none.
func (h *AgentRunHarness) previewMessages(ctx context.Context, sessionID string) ([]Message, error) {
	if strings.TrimSpace(sessionID) == "" {
		return nil, nil
	}
	messages, err := h.messagesForRun(ctx, RunSnapshot{SessionID: strings.TrimSpace(sessionID)})
	if errors.Is(err, ErrNotFound) {
		return nil, nil
	}
	return messages, err
}

func messageBytes(message Message) int {
	bytes, _ := contextMessageSize(message, nil)
	return bytes
}

// boundItemsBytes is what the attached items take inside the workspace message: the
// snapshot travels as one JSON string, so the items are measured the same way.
func boundItemsBytes(workspace Message) int {
	var wrapper struct {
		Snapshot *WorkspaceSnapshot `json:"snapshot"`
	}
	if json.Unmarshal([]byte(workspace.Content), &wrapper) != nil || wrapper.Snapshot == nil {
		return 0
	}
	items := attachedItems(wrapper.Snapshot.ActiveContext)
	if len(items) == 0 {
		return 0
	}
	raw, err := json.Marshal(items)
	if err != nil {
		return 0
	}
	encoded, err := json.Marshal(string(raw))
	if err != nil {
		return 0
	}
	return len(encoded) - 2
}
