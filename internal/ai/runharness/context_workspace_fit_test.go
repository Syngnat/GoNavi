package runharness

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func bulkyWorkspace(attached int) (*WorkspaceSnapshot, *WorkspaceSnapshotReference) {
	draft := strings.Repeat("SELECT id, total FROM orders WHERE created_at > '2026-01-01';\n", 20)
	items := make([]any, 0, attached)
	for i := 0; i < attached; i++ {
		items = append(items, map[string]any{"dbName": "shop", "tableName": fmt.Sprintf("t%d", i), "ddl": fmt.Sprintf("CREATE TABLE t%d (id BIGINT PRIMARY KEY, name VARCHAR(80))", i)})
	}
	snapshot := &WorkspaceSnapshot{
		SchemaVersion: CurrentSchemaVersion, SourceKind: WorkspaceDesktop, SourceID: "desktop", SourceInstanceID: "window-1", Revision: 3,
		CapturedAt: time.Unix(100, 0).UTC(), ContentHash: "full-hash",
		ActiveContext: map[string]any{"connectionId": "conn-1", "dbName": "shop", "attachedItems": items},
		ActiveTabID:   "tab-1",
		Shortcuts:     map[string]string{"run": "cmd-enter", "save": "cmd-s"},
		Capabilities:  map[string]bool{"desktopTabs": true},
	}
	for i := 1; i <= 6; i++ {
		snapshot.Tabs = append(snapshot.Tabs, WorkspaceTab{ID: fmt.Sprintf("tab-%d", i), Title: fmt.Sprintf("query %d", i), Kind: "query", Draft: draft})
		snapshot.SQLActivity = append(snapshot.SQLActivity, WorkspaceSQLActivity{ID: fmt.Sprintf("log-%d", i), Statement: draft[:200], Status: "ok"})
		snapshot.SavedQueries = append(snapshot.SavedQueries, WorkspaceQuery{ID: fmt.Sprintf("q-%d", i), Name: "saved", Content: draft[:300]})
	}
	reference := &WorkspaceSnapshotReference{SourceID: "desktop", SourceInstanceID: "window-1", Revision: 3, ContentHash: "full-hash"}
	return snapshot, reference
}

func workspaceEnvelope(t *testing.T, message Message) (envelope struct {
	Trimmed  string            `json:"trimmed"`
	Snapshot WorkspaceSnapshot `json:"snapshot"`
}) {
	t.Helper()
	if err := json.Unmarshal([]byte(message.Content), &envelope); err != nil {
		t.Fatalf("decode workspace message: %v", err)
	}
	return envelope
}

func attachedCount(snapshot WorkspaceSnapshot) int { return len(attachedItems(snapshot.ActiveContext)) }

func buildWith(t *testing.T, builder *DeterministicContextBuilder, window, reserved int, snapshot *WorkspaceSnapshot, reference *WorkspaceSnapshotReference, content string) (ContextBuildResult, error) {
	t.Helper()
	return builder.Build(context.Background(), ContextBuildRequest{
		Messages:          []Message{{ID: "m-1", Sequence: 1, Role: "user", Content: content}},
		WorkspaceSnapshot: snapshot, WorkspaceReference: reference,
		ContextWindowTokens: window, ReservedOutputTokens: reserved,
	})
}

func TestWorkspaceIsSentWholeWhenItFits(t *testing.T) {
	snapshot, reference := bulkyWorkspace(2)
	built, err := buildWith(t, NewDeterministicContextBuilder(), 0, 0, snapshot, reference, "hi")
	if err != nil {
		t.Fatal(err)
	}
	envelope := workspaceEnvelope(t, built.Request.Messages[0])
	if built.Compression.WorkspaceTrimmed != "" || envelope.Trimmed != "" || len(envelope.Snapshot.Tabs) != 6 || len(envelope.Snapshot.SavedQueries) != 6 {
		t.Fatalf("an unbounded request must keep the whole workspace: trimmed=%q tabs=%d", built.Compression.WorkspaceTrimmed, len(envelope.Snapshot.Tabs))
	}
}

// The built-in model: a 4096-token window with 1024 reserved for the answer.
func TestOversizedWorkspaceIsTrimmedInsteadOfFailingTheRun(t *testing.T) {
	snapshot, reference := bulkyWorkspace(2)
	built, err := buildWith(t, NewDeterministicContextBuilder(), 4096, 1024, snapshot, reference, "你好")
	if err != nil {
		t.Fatalf("a large workspace must not fail the run: %v", err)
	}
	if !built.Compression.WorkspaceIncluded || built.Compression.WorkspaceTrimmed == "" {
		t.Fatalf("compression = %+v, want a trimmed workspace", built.Compression)
	}
	if built.Compression.ProviderBytes > 3072 {
		t.Fatalf("projection is %d bytes, over the 3072-byte prompt budget", built.Compression.ProviderBytes)
	}
	envelope := workspaceEnvelope(t, built.Request.Messages[0])
	if attachedCount(envelope.Snapshot) != 2 {
		t.Fatalf("the attached table schemas are what a SQL model needs; they must survive: %+v", envelope.Snapshot.ActiveContext)
	}
	if len(envelope.Snapshot.SQLActivity) != 0 || len(envelope.Snapshot.SavedQueries) != 0 || len(envelope.Snapshot.Shortcuts) != 0 {
		t.Fatalf("bulk sections should be the first thing dropped: %+v", envelope.Snapshot)
	}
	last := built.Request.Messages[len(built.Request.Messages)-1]
	if last.Content != "你好" {
		t.Fatalf("the newest message must be sent last and whole, got %q", last.Content)
	}
	// The durable reference still names the full snapshot.
	if !sameWorkspaceSnapshotReference(built.Compression.Workspace, reference) {
		t.Fatalf("workspace reference changed: %+v", built.Compression.Workspace)
	}
}

func TestTrimmingIsDeterministicAndDoesNotTouchTheCallersSnapshot(t *testing.T) {
	snapshot, reference := bulkyWorkspace(3)
	first, err := buildWith(t, NewDeterministicContextBuilder(), 4096, 1024, snapshot, reference, "hi")
	if err != nil {
		t.Fatal(err)
	}
	second, err := buildWith(t, NewDeterministicContextBuilder(), 4096, 1024, snapshot, reference, "hi")
	if err != nil {
		t.Fatal(err)
	}
	if first.Request.Messages[0].Content != second.Request.Messages[0].Content {
		t.Fatal("two builds of the same input differ")
	}
	if len(snapshot.Tabs) != 6 || len(snapshot.SQLActivity) != 6 || attachedCount(*snapshot) != 3 || snapshot.Tabs[0].Draft == "" {
		t.Fatal("trimming mutated the caller's snapshot")
	}
}

func TestAttachedItemsAreKeptInOrderAsFarAsTheyFit(t *testing.T) {
	snapshot, reference := bulkyWorkspace(60)
	built, err := buildWith(t, NewDeterministicContextBuilder(), 4096, 1024, snapshot, reference, "hi")
	if err != nil {
		t.Fatal(err)
	}
	envelope := workspaceEnvelope(t, built.Request.Messages[0])
	kept := attachedItems(envelope.Snapshot.ActiveContext)
	if built.Compression.WorkspaceTrimmed != WorkspaceTrimAttachments || len(kept) == 0 || len(kept) >= 60 {
		t.Fatalf("trimmed=%q kept=%d, want a non-empty strict prefix of the 60 items", built.Compression.WorkspaceTrimmed, len(kept))
	}
	for i, item := range kept {
		if name := item.(map[string]any)["tableName"]; name != fmt.Sprintf("t%d", i) {
			t.Fatalf("item %d is %v: the first items must be the ones kept", i, name)
		}
	}
	if built.Compression.ProviderBytes > 3072 {
		t.Fatalf("projection is %d bytes", built.Compression.ProviderBytes)
	}
}

func TestWorkspaceIsOmittedWhenNothingOfItFits(t *testing.T) {
	snapshot, reference := bulkyWorkspace(2)
	// A window so small that even the connection line does not fit beside the question.
	built, err := buildWith(t, NewDeterministicContextBuilder(), 800, 400, snapshot, reference, "hello there")
	if err != nil {
		t.Fatalf("an unfit workspace must be dropped, not fail the run: %v", err)
	}
	if built.Compression.WorkspaceIncluded || built.Compression.WorkspaceTrimmed != WorkspaceTrimOmitted {
		t.Fatalf("compression = %+v, want the workspace omitted", built.Compression)
	}
	if len(built.Request.Messages) != 1 || built.Request.Messages[0].Content != "hello there" {
		t.Fatalf("messages = %+v, want only the user's message", built.Request.Messages)
	}
}

func TestAMessageThatCannotFitIsStillAnError(t *testing.T) {
	snapshot, reference := bulkyWorkspace(2)
	_, err := buildWith(t, NewDeterministicContextBuilder(), 4096, 1024, snapshot, reference, strings.Repeat("x", 5000))
	if !errors.Is(err, ErrContextLimit) || !strings.Contains(err.Error(), "newest durable message") {
		t.Fatalf("err = %v, want the newest-message limit error", err)
	}
}

func TestTrimmedDraftNeverSplitsACharacter(t *testing.T) {
	text := strings.Repeat("查询订单表", 400)
	got := truncateUTF8(text, essentialDraftBytes)
	if !utf8.ValidString(got) || len(got) > essentialDraftBytes || len(got) < essentialDraftBytes-3 {
		t.Fatalf("truncated to %d bytes, valid=%v", len(got), utf8.ValidString(got))
	}
}

func selectionItem(text string) map[string]any {
	return map[string]any{"kind": "editor_selection", "dbName": "shop", "tableName": "__gonavi_editor_selection__", "ddl": "", "label": "RFM report", "content": text}
}

// Regression: a selected piece of SQL is what the person attached on purpose.
// It used to be dropped whole when it did not fit, so the model answered "please
// provide what you want me to look at".
func TestALargeEditorSelectionIsCutDownNotDropped(t *testing.T) {
	snapshot, reference := bulkyWorkspace(0)
	query := strings.Repeat("SELECT c.id, c.name, COUNT(*) AS orders FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.id, c.name;\n", 60)
	snapshot.ActiveContext["attachedItems"] = []any{selectionItem(query)}
	built, err := buildWith(t, NewDeterministicContextBuilder(), 4096, 1024, snapshot, reference, "看下")
	if err != nil {
		t.Fatal(err)
	}
	if built.Compression.WorkspaceTrimmed != WorkspaceTrimAttachments {
		t.Fatalf("trimmed = %q, want the attachment level", built.Compression.WorkspaceTrimmed)
	}
	items := attachedItems(workspaceEnvelope(t, built.Request.Messages[0]).Snapshot.ActiveContext)
	if len(items) != 1 {
		t.Fatalf("the selection was dropped: %+v", items)
	}
	kept := items[0].(map[string]any)
	content, _ := kept["content"].(string)
	if kept["truncated"] != true || !strings.HasPrefix(content, "SELECT c.id") || !strings.Contains(content, "truncated to fit") {
		t.Fatalf("selection = truncated:%v content:%.80q", kept["truncated"], content)
	}
	if len(content) < 1500 {
		t.Fatalf("only %d bytes of the selection survived; most of the budget should go to it", len(content))
	}
	if built.Compression.ProviderBytes > 3072 {
		t.Fatalf("projection is %d bytes, over the 3072-byte prompt budget", built.Compression.ProviderBytes)
	}
}

func TestASelectionThatFitsIsSentWholeAndKeepsAttachOrder(t *testing.T) {
	snapshot, reference := bulkyWorkspace(2)
	snapshot.ActiveContext["attachedItems"] = append(attachedItems(snapshot.ActiveContext), selectionItem("SELECT 1 FROM dual"))
	built, err := buildWith(t, NewDeterministicContextBuilder(), 4096, 1024, snapshot, reference, "看下")
	if err != nil {
		t.Fatal(err)
	}
	items := attachedItems(workspaceEnvelope(t, built.Request.Messages[0]).Snapshot.ActiveContext)
	if len(items) != 3 || items[2].(map[string]any)["content"] != "SELECT 1 FROM dual" || items[0].(map[string]any)["tableName"] != "t0" {
		t.Fatalf("items = %+v, want the three items in attach order with the selection whole", items)
	}
}

func TestASelectionOutranksTableSchemasWhenOnlyOneFits(t *testing.T) {
	snapshot, reference := bulkyWorkspace(5)
	query := strings.Repeat("SELECT 1 FROM dual WHERE a = b AND c = d;\n", 120)
	snapshot.ActiveContext["attachedItems"] = append(attachedItems(snapshot.ActiveContext), selectionItem(query))
	built, err := buildWith(t, NewDeterministicContextBuilder(), 4096, 1024, snapshot, reference, "看下")
	if err != nil {
		t.Fatal(err)
	}
	items := attachedItems(workspaceEnvelope(t, built.Request.Messages[0]).Snapshot.ActiveContext)
	foundSelection := false
	for _, item := range items {
		if item.(map[string]any)["kind"] == "editor_selection" {
			foundSelection = true
		}
	}
	if !foundSelection {
		t.Fatalf("the selection must be kept before any table schema: %+v", items)
	}
}

// A bound selection is stored with the user message as an attachment so the chat
// can show it as a chip. It is never sent to the model, so it must not count
// against the window: a 30 KB selection used to make the newest message "too big".
func TestStoredAttachmentsDoNotCountAgainstTheProviderWindow(t *testing.T) {
	snapshot, reference := bulkyWorkspace(1)
	input := ContextBuildRequest{
		Messages: []Message{{
			ID: "m-1", Sequence: 1, Role: "user", Content: "看下",
			Attachments: []Attachment{{Name: "RFM report", MediaType: "application/vnd.gonavi.context+json", Data: strings.Repeat("SELECT 1;", 4000)}},
		}},
		WorkspaceSnapshot: snapshot, WorkspaceReference: reference,
		ContextWindowTokens: 4096, ReservedOutputTokens: 1024,
	}
	built, err := NewDeterministicContextBuilder().Build(context.Background(), input)
	if err != nil {
		t.Fatalf("a message with a large stored attachment must still fit: %v", err)
	}
	if built.Compression.ProviderBytes > 3072 {
		t.Fatalf("projection is %d bytes", built.Compression.ProviderBytes)
	}
	last := built.Request.Messages[len(built.Request.Messages)-1]
	if last.Content != "看下" {
		t.Fatalf("the question must be sent whole: %q", last.Content)
	}
}

func chipAttachment(t *testing.T, payload map[string]any) Attachment {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return Attachment{Name: "chip", MediaType: ContextChipMediaType, Data: string(encoded)}
}

// The desktop clears what it bound the moment the message is sent and republishes the
// snapshot, which then no longer holds it. The message itself must carry it.
func TestAMessageCarriesTheContextItBoundEvenWhenTheSnapshotNoLongerHasIt(t *testing.T) {
	snapshot, reference := bulkyWorkspace(0) // nothing attached any more
	input := ContextBuildRequest{
		Messages: []Message{{
			ID: "m-1", Sequence: 1, Role: "user", Content: "看下",
			Attachments: []Attachment{
				chipAttachment(t, map[string]any{"v": 1, "kind": "editor_selection", "label": "RFM", "text": "SELECT 1 FROM dual", "dbName": "shop", "startLine": 1, "endLine": 3}),
				chipAttachment(t, map[string]any{"v": 1, "kind": "chat_quote", "label": "answer", "text": "use an index on order_date"}),
				chipAttachment(t, map[string]any{"v": 1, "kind": "table_schema", "text": "CREATE TABLE t (id int)", "dbName": "shop", "tableName": "t"}),
				{Name: "notes.md", MediaType: "text/markdown", Data: "# not a chip"},
				{Name: "bad", MediaType: ContextChipMediaType, Data: "not json"},
			},
		}},
		WorkspaceSnapshot: snapshot, WorkspaceReference: reference,
		ContextWindowTokens: 4096, ReservedOutputTokens: 1024,
	}
	built, err := NewDeterministicContextBuilder().Build(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	items := attachedItems(workspaceEnvelope(t, built.Request.Messages[0]).Snapshot.ActiveContext)
	kinds := map[string]string{}
	for _, item := range items {
		entry := item.(map[string]any)
		kind, _ := entry["kind"].(string)
		if kind == "" {
			kind = "table_schema"
		}
		kinds[kind], _ = entry[itemTextField(entry)].(string)
	}
	if len(items) != 3 || kinds["editor_selection"] != "SELECT 1 FROM dual" || kinds["chat_quote"] != "use an index on order_date" || kinds["table_schema"] != "CREATE TABLE t (id int)" {
		t.Fatalf("items = %+v, want the three bound items and nothing else", items)
	}
	if len(snapshot.ActiveContext) == 0 || attachedCount(*snapshot) != 0 {
		t.Fatal("the caller's snapshot was modified")
	}
}

func TestContextAlreadyInTheSnapshotIsNotRepeated(t *testing.T) {
	snapshot, reference := bulkyWorkspace(0)
	snapshot.ActiveContext["attachedItems"] = []any{selectionItem("SELECT 1 FROM dual")}
	input := ContextBuildRequest{
		Messages: []Message{{ID: "m-1", Sequence: 1, Role: "user", Content: "q",
			Attachments: []Attachment{chipAttachment(t, map[string]any{"v": 1, "kind": "editor_selection", "label": "RFM", "text": "SELECT 1 FROM dual"})}}},
		WorkspaceSnapshot: snapshot, WorkspaceReference: reference,
		ContextWindowTokens: 4096, ReservedOutputTokens: 1024,
	}
	built, err := NewDeterministicContextBuilder().Build(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if items := attachedItems(workspaceEnvelope(t, built.Request.Messages[0]).Snapshot.ActiveContext); len(items) != 1 {
		t.Fatalf("the same selection must appear once: %+v", items)
	}
}

func TestOnlyTheNewestUserMessageContributesItsContext(t *testing.T) {
	snapshot, reference := bulkyWorkspace(0)
	chip := chipAttachment(t, map[string]any{"v": 1, "kind": "chat_quote", "text": "old quote"})
	input := ContextBuildRequest{
		Messages: []Message{
			{ID: "m-1", Sequence: 1, Role: "user", Content: "first", Attachments: []Attachment{chip}},
			{ID: "m-2", Sequence: 2, Role: "assistant", Content: "answer"},
			{ID: "m-3", Sequence: 3, Role: "user", Content: "second"},
		},
		WorkspaceSnapshot: snapshot, WorkspaceReference: reference,
		ContextWindowTokens: 4096, ReservedOutputTokens: 1024,
	}
	built, err := NewDeterministicContextBuilder().Build(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if items := attachedItems(workspaceEnvelope(t, built.Request.Messages[0]).Snapshot.ActiveContext); len(items) != 0 {
		t.Fatalf("an earlier message's binding must not follow the conversation: %+v", items)
	}
}
