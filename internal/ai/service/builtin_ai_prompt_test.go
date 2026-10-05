package aiservice

import (
	"encoding/json"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/runharness"
)

func workspaceMessage(t *testing.T, active map[string]any) ai.Message {
	t.Helper()
	encoded, err := json.Marshal(map[string]any{
		"kind":     "workspace_snapshot",
		"snapshot": map[string]any{"schemaVersion": 1, "sourceKind": "desktop", "activeContext": active},
	})
	if err != nil {
		t.Fatal(err)
	}
	return ai.Message{Role: "system", Content: string(encoded)}
}

func TestBuiltinAIGetsTheSelectedSQLAsPlainTextWithTheQuestion(t *testing.T) {
	messages := []ai.Message{
		workspaceMessage(t, map[string]any{
			"connectionId": "conn-1", "dbName": "dbms_job", "databaseVersion": "KingbaseES V8", "sqlDialectConstraint": "Use PostgreSQL syntax.",
			"attachedItems": []any{
				map[string]any{"kind": "editor_selection", "label": "RFM report", "ddl": "", "content": "WITH rfm AS (SELECT 1)\nSELECT * FROM rfm", "source": map[string]any{"startLine": float64(1), "endLine": float64(2)}},
				map[string]any{"dbName": "dbms_job", "tableName": "lab_customers", "ddl": "CREATE TABLE lab_customers (id bigint)"},
			},
		}),
		{Role: "user", Content: "请看一下我绑定的选中内容"},
	}

	got := presentBuiltinAIContext(messages)

	if len(got) != 1 || got[0].Role != "user" {
		t.Fatalf("the workspace JSON must be gone and the text merged into the user message: %+v", got)
	}
	content := got[0].Content
	for _, want := range []string{
		"Database: dbms_job", "KingbaseES V8", "Use PostgreSQL syntax.",
		"selected this code in the SQL editor", `(tab "RFM report")`, "lines 1-2",
		"```sql\nWITH rfm AS (SELECT 1)\nSELECT * FROM rfm\n```",
		"Table dbms_job.lab_customers", "CREATE TABLE lab_customers (id bigint)",
		"### Request\n请看一下我绑定的选中内容",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("the model's prompt lacks %q:\n%s", want, content)
		}
	}
	if strings.Contains(content, `"kind"`) || strings.Contains(content, "workspace_snapshot") {
		t.Errorf("JSON leaked into the prompt:\n%s", content)
	}
}

func TestOnlyTheLatestUserMessageCarriesTheContext(t *testing.T) {
	messages := []ai.Message{
		workspaceMessage(t, map[string]any{"dbName": "shop", "attachedItems": []any{map[string]any{"kind": "editor_selection", "content": "SELECT 1"}}}),
		{Role: "user", Content: "first question"},
		{Role: "assistant", Content: "first answer"},
		{Role: "user", Content: "second question"},
	}
	got := presentBuiltinAIContext(messages)
	if len(got) != 3 || got[0].Content != "first question" || got[1].Content != "first answer" {
		t.Fatalf("earlier turns must be untouched: %+v", got)
	}
	if !strings.Contains(got[2].Content, "SELECT 1") || !strings.HasSuffix(got[2].Content, "### Request\nsecond question") {
		t.Fatalf("the latest question carries the context: %q", got[2].Content)
	}
}

func TestAWorkspaceWithNothingUsableIsDroppedNotSent(t *testing.T) {
	messages := []ai.Message{workspaceMessage(t, map[string]any{"attachedItems": []any{}}), {Role: "user", Content: "hi"}}
	got := presentBuiltinAIContext(messages)
	if len(got) != 1 || got[0].Content != "hi" {
		t.Fatalf("an empty context must cost the small window nothing: %+v", got)
	}
}

func TestTheModelIsToldWhichConnectionItsToolsAddress(t *testing.T) {
	messages := []ai.Message{workspaceMessage(t, map[string]any{"connectionId": "conn-1", "dbName": "shop", "schemaName": "public"}), {Role: "user", Content: "hi"}}
	got := presentBuiltinAIContext(messages)
	if len(got) != 1 || !strings.Contains(got[0].Content, "Connection id (for tools): conn-1") || !strings.Contains(got[0].Content, "Schema: public") {
		t.Fatalf("the tools need the connection id: %+v", got)
	}
}

func TestTheInstructionsComeFirstNextToTheQuestion(t *testing.T) {
	messages := []ai.Message{
		{Role: "system", Content: runharness.InstructionsHeader + "\nYou are GoNavi's SQL assistant.\n\n## The user's own instructions\nAnswer briefly."},
		workspaceMessage(t, map[string]any{"dbName": "shop"}),
		{Role: "user", Content: "hi"},
	}
	got := presentBuiltinAIContext(messages)
	if len(got) != 1 || got[0].Role != "user" {
		t.Fatalf("the instructions and the workspace both go into the question: %+v", got)
	}
	want := "### Instructions\nYou are GoNavi's SQL assistant.\n\n## The user's own instructions\nAnswer briefly.\n\n### Context\nDatabase: shop\n\n### Request\nhi"
	if got[0].Content != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got[0].Content, want)
	}
	if strings.Contains(got[0].Content, runharness.InstructionsHeader) {
		t.Fatalf("the header is for recognizing the message, not for the model: %q", got[0].Content)
	}
}

func TestInstructionsWithoutAQuestionStayASystemMessage(t *testing.T) {
	messages := []ai.Message{{Role: "system", Content: runharness.InstructionsHeader + "\nBe brief."}, {Role: "assistant", Content: "ok"}}
	got := presentBuiltinAIContext(messages)
	if len(got) != 2 || got[0].Role != "system" || got[0].Content != "### Instructions\nBe brief." || got[1].Content != "ok" {
		t.Fatalf("got %+v", got)
	}
}

func TestMessagesWithoutAWorkspaceAreLeftAlone(t *testing.T) {
	messages := []ai.Message{{Role: "system", Content: "You are helpful."}, {Role: "user", Content: "hi"}}
	if got := presentBuiltinAIContext(messages); len(got) != 2 || got[0].Content != "You are helpful." || got[1].Content != "hi" {
		t.Fatalf("got %+v", got)
	}
	broken := []ai.Message{{Role: "system", Content: `{"kind":"workspace_snapshot", not json`}, {Role: "user", Content: "hi"}}
	if got := presentBuiltinAIContext(broken); len(got) != 2 {
		t.Fatalf("an unreadable workspace message is left exactly as it was: %+v", got)
	}
}

func TestATruncatedSelectionKeepsItsMarker(t *testing.T) {
	messages := []ai.Message{
		workspaceMessage(t, map[string]any{"attachedItems": []any{map[string]any{"kind": "editor_selection", "content": "SELECT 1\n/* ... truncated to fit the model's context window ... */", "truncated": true}}}),
		{Role: "user", Content: "q"},
	}
	if got := presentBuiltinAIContext(messages); !strings.Contains(got[0].Content, "truncated to fit") {
		t.Fatalf("the model should see that the selection was cut: %q", got[0].Content)
	}
}

func TestAQuotedPassageIsPresentedAsPlainText(t *testing.T) {
	messages := []ai.Message{
		workspaceMessage(t, map[string]any{"attachedItems": []any{map[string]any{"kind": "chat_quote", "content": "use an index on order_date"}}}),
		{Role: "user", Content: "why?"},
	}
	got := presentBuiltinAIContext(messages)
	if len(got) != 1 || !strings.Contains(got[0].Content, "replying to this passage from an earlier answer") || !strings.Contains(got[0].Content, "use an index on order_date") || !strings.HasSuffix(got[0].Content, "### Request\nwhy?") {
		t.Fatalf("got %+v", got)
	}
}
