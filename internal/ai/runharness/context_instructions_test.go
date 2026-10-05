package runharness

import (
	"context"
	"errors"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestTheInstructionsComeFirstAndCount(t *testing.T) {
	snapshot := bigWorkspace()
	built, err := NewDeterministicContextBuilder().Build(context.Background(), ContextBuildRequest{
		Run:               RunSnapshot{SessionID: "s"},
		Messages:          []Message{{ID: "m1", SessionID: "s", Role: "user", Content: "hi"}},
		WorkspaceSnapshot: &snapshot, WorkspaceReference: workspaceSnapshotReference(snapshot),
		ContextWindowTokens: 100_000, ReservedOutputTokens: 4096,
		Instructions: "  You are GoNavi's SQL assistant.  ",
	})
	if err != nil {
		t.Fatal(err)
	}
	messages := built.Request.Messages
	if len(messages) != 3 || !built.Compression.InstructionsIncluded || !built.Compression.WorkspaceIncluded {
		t.Fatalf("instructions, workspace, question: %+v", built.Compression)
	}
	if messages[0].Role != "system" || messages[0].Content != InstructionsHeader+"\nYou are GoNavi's SQL assistant." || !strings.Contains(string(messages[0].Metadata), `"instructions"`) {
		t.Fatalf("the first message carries the instructions: %+v", messages[0])
	}
	if !strings.HasPrefix(messages[1].Content, `{"kind":"workspace_snapshot"`) || messages[2].Content != "hi" {
		t.Fatalf("the workspace and the question follow: %+v", messages[1:])
	}
	want := 0
	for _, message := range messages {
		want += messageBytes(message)
	}
	if built.Compression.ProviderBytes != want {
		t.Fatalf("the instructions count toward what is sent: %d, want %d", built.Compression.ProviderBytes, want)
	}
}

func TestNoInstructionsChangeNothing(t *testing.T) {
	built, err := NewDeterministicContextBuilder().Build(context.Background(), ContextBuildRequest{
		Run:          RunSnapshot{SessionID: "s"},
		Messages:     []Message{{ID: "m1", SessionID: "s", Role: "user", Content: "hi"}},
		Instructions: " \n ",
	})
	if err != nil {
		t.Fatal(err)
	}
	if built.Compression.InstructionsIncluded || len(built.Request.Messages) != 1 {
		t.Fatalf("blank instructions send nothing: %+v", built.Request.Messages)
	}
}

func TestInstructionsTooLargeForTheWindowAreAContextLimit(t *testing.T) {
	_, err := NewDeterministicContextBuilder().Build(context.Background(), ContextBuildRequest{
		Run:                 RunSnapshot{SessionID: "s"},
		Messages:            []Message{{ID: "m1", SessionID: "s", Role: "user", Content: "hi"}},
		Instructions:        strings.Repeat("rule ", 2000),
		ContextWindowTokens: 1200, ReservedOutputTokens: 200,
	})
	if !errors.Is(err, ErrContextLimit) {
		t.Fatalf("got %v", err)
	}
}

// smallWindowBuild builds a turn in the 4k window a desktop uses before it has learned the
// built-in AI's own.
func smallWindowBuild(t *testing.T, snapshot WorkspaceSnapshot, instructions string) ContextBuildResult {
	t.Helper()
	built, err := NewDeterministicContextBuilder().Build(context.Background(), ContextBuildRequest{
		Run:               RunSnapshot{SessionID: "s"},
		Messages:          []Message{{ID: "m1", SessionID: "s", Role: "user", Content: "看下"}},
		WorkspaceSnapshot: &snapshot, WorkspaceReference: workspaceSnapshotReference(snapshot),
		ContextWindowTokens: 4096, ReservedOutputTokens: 1024,
		Instructions: instructions,
	})
	if err != nil {
		t.Fatal(err)
	}
	if built.Compression.ProviderTokens > 4096-1024 {
		t.Fatalf("what is sent (%d) must fit the budget", built.Compression.ProviderTokens)
	}
	return built
}

const roleSizedInstructions = "You are GoNavi's SQL assistant inside a database client. Put SQL in a fenced code block. Add LIMIT 100 to queries that may return many rows. Warn before DELETE or UPDATE without WHERE, and before DROP or TRUNCATE. Use only syntax the connected database supports. Call the tools to see what exists; the connection id is in the context."

// Regression: taking the instructions out of the workspace's share left a 4k window no room even
// for the connection and database, so the model could not address its tools.
func TestTheInstructionsDoNotCrowdOutTheActiveConnection(t *testing.T) {
	snapshot := WorkspaceSnapshot{
		SourceKind: WorkspaceDesktop, SourceID: previewSource, SourceInstanceID: previewInstance, Revision: 1,
		ActiveContext: map[string]any{"connectionId": "conn-1", "dbName": "shop", "databaseVersion": "8.0.36"},
	}
	if err := snapshot.Normalize(); err != nil {
		t.Fatal(err)
	}
	built := smallWindowBuild(t, snapshot, strings.Repeat(roleSizedInstructions, 2))
	if !built.Compression.WorkspaceIncluded || !strings.Contains(built.Request.Messages[1].Content, `"connectionId":"conn-1"`) {
		t.Fatalf("the active connection must still be sent: trimmed=%q", built.Compression.WorkspaceTrimmed)
	}
}

func TestTheInstructionsLeaveAnAttachedSelectionLessRoomButKeepIt(t *testing.T) {
	selection := map[string]any{"kind": "editor_selection", "content": strings.Repeat("SELECT name, city FROM scored WHERE r_score >= 4;\n", 80)}
	snapshot := bigWorkspace(selection)
	if err := snapshot.Normalize(); err != nil {
		t.Fatal(err)
	}
	without, with := smallWindowBuild(t, snapshot, ""), smallWindowBuild(t, snapshot, roleSizedInstructions)
	if !with.Compression.WorkspaceIncluded || with.Compression.WorkspaceTrimmed != WorkspaceTrimAttachments {
		t.Fatalf("the selection is cut, not dropped: %+v", with.Compression)
	}
	kept := func(built ContextBuildResult) int {
		for _, message := range built.Request.Messages {
			if strings.HasPrefix(message.Content, `{"kind":"workspace_snapshot"`) {
				return strings.Count(message.Content, "SELECT name, city")
			}
		}
		return 0
	}
	if kept(with) == 0 || kept(with) >= kept(without) {
		t.Fatalf("the instructions take their room from the selection: %d lines with, %d without", kept(with), kept(without))
	}
}

func TestVeryLongInstructionsAreCutOnACharacter(t *testing.T) {
	message, ok := instructionsMessage(strings.Repeat("提示", maxInstructionsBytes))
	if !ok {
		t.Fatal("expected a message")
	}
	body := strings.TrimPrefix(message.Content, InstructionsHeader+"\n")
	if len(body) > maxInstructionsBytes || !utf8.ValidString(body) {
		t.Fatalf("cut to %d bytes, valid=%v", len(body), utf8.ValidString(body))
	}
}

func TestThePreviewShowsWhatTheInstructionsTake(t *testing.T) {
	snapshot := bigWorkspace()
	f := newPreviewFixture(t, []Message{{Role: "user", Content: "earlier"}, {Role: "assistant", Content: "answer"}}, &snapshot)
	var asked InstructionsRequest
	f.harness.instructions = func(_ context.Context, request InstructionsRequest) string {
		asked = request
		return "You are GoNavi's SQL assistant."
	}

	preview := f.preview(t, ContextPreviewRequest{Content: "now", ContextWindowTokens: 100_000, ReservedOutputTokens: 4096, Provider: "builtin", TaskKind: AgentTaskKindQueryEditorGeneration})

	if asked.Provider != "builtin" || asked.TaskKind != AgentTaskKindQueryEditorGeneration || asked.Workspace == nil {
		t.Fatalf("the resolver is asked about the turn being previewed: %+v", asked)
	}
	message, _ := instructionsMessage("You are GoNavi's SQL assistant.")
	if preview.InstructionsBytes != messageBytes(message) {
		t.Fatalf("instructions measured as %d, want %d", preview.InstructionsBytes, messageBytes(message))
	}
	if preview.WorkspaceBytes == 0 || preview.UserBytes == 0 || preview.AssistantBytes == 0 {
		t.Fatalf("the other parts are still counted apart: %+v", preview)
	}
}

func TestAFailingResolverDoesNotFailTheTurn(t *testing.T) {
	f := newPreviewFixture(t, nil, nil)
	f.harness.instructions = func(context.Context, InstructionsRequest) string { panic("boom") }
	preview := f.preview(t, ContextPreviewRequest{Content: "hi", ContextWindowTokens: 8000, ReservedOutputTokens: 1000})
	if preview.InstructionsBytes != 0 || preview.UserBytes == 0 {
		t.Fatalf("the turn goes ahead without instructions: %+v", preview)
	}
}
