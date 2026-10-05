package runharness

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

const (
	previewSource   = "preview-source"
	previewInstance = "preview-instance"
)

// bigWorkspace is what a desktop with several editors open publishes: far more than a small window takes.
func bigWorkspace(attached ...any) WorkspaceSnapshot {
	snapshot := WorkspaceSnapshot{
		SourceKind: WorkspaceDesktop, SourceID: previewSource, SourceInstanceID: previewInstance, Revision: 1,
		ActiveContext: map[string]any{"connectionId": "c1", "dbName": "shop", "attachedItems": attached},
		ActiveTabID:   "tab-0",
	}
	for i := 0; i < 6; i++ {
		snapshot.Tabs = append(snapshot.Tabs, WorkspaceTab{ID: fmt.Sprintf("tab-%d", i), Title: fmt.Sprintf("query %d", i), Kind: "query", Draft: strings.Repeat("select * from orders where id = 1;\n", 120)})
	}
	for i := 0; i < 20; i++ {
		snapshot.SQLActivity = append(snapshot.SQLActivity, WorkspaceSQLActivity{ID: fmt.Sprintf("a-%d", i), Statement: strings.Repeat("update t set a = 1; ", 40), Status: "ok"})
	}
	return snapshot
}

type previewFixture struct {
	harness *AgentRunHarness
	ledger  *Ledger
	session string
}

func newPreviewFixture(t *testing.T, history []Message, snapshot *WorkspaceSnapshot) previewFixture {
	t.Helper()
	harness, ledger := newContextBuilderHarness(t, &contextHarnessModel{}, nil, nil)
	session, err := ledger.CreateSession(context.Background(), CreateSessionRequest{SessionID: "preview-session"})
	if err != nil {
		t.Fatal(err)
	}
	for i, message := range history {
		message.ID, message.SessionID = fmt.Sprintf("h-%d", i), session.ID
		if _, err := ledger.AppendMessage(context.Background(), message); err != nil {
			t.Fatal(err)
		}
	}
	if snapshot != nil {
		if _, err := ledger.PutWorkspaceSnapshot(context.Background(), *snapshot); err != nil {
			t.Fatal(err)
		}
	}
	return previewFixture{harness: harness, ledger: ledger, session: session.ID}
}

func (f previewFixture) preview(t *testing.T, request ContextPreviewRequest) ContextPreview {
	t.Helper()
	request.SessionID = f.session
	request.ContextSourceID, request.ContextSourceInstanceID = previewSource, previewInstance
	preview, err := f.harness.PreviewContext(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	return preview
}

func total(p ContextPreview) int {
	return p.WorkspaceBytes + p.BoundBytes + p.UserBytes + p.AssistantBytes + p.ToolBytes
}

func TestAWorkspaceThatDoesNotFitIsMeasuredAsTrimmedNotAsPublished(t *testing.T) {
	snapshot := bigWorkspace()
	f := newPreviewFixture(t, nil, &snapshot)
	raw, _, err := workspaceContextMessage(&snapshot, workspaceSnapshotReference(snapshot), "")
	if err != nil {
		t.Fatal(err)
	}
	published := messageBytes(raw)
	if published < 20_000 {
		t.Fatalf("the fixture must be big, got %d", published)
	}

	small := f.preview(t, ContextPreviewRequest{Content: "hi", ContextWindowTokens: 4096, ReservedOutputTokens: 1024})
	if small.Overflow || small.WorkspaceTrimmed == "" {
		t.Fatalf("a 4k window must trim the workspace: %+v", small)
	}
	budget := 4096 - 1024
	// Only the active connection line, the least that is kept, may take more than the background share.
	if small.WorkspaceTrimmed != WorkspaceTrimMinimal || small.WorkspaceBytes == 0 {
		t.Fatalf("a 4k window still sends the active connection: %+v", small)
	}
	if small.WorkspaceBytes > budget*attachedBudgetNumerator/attachedBudgetDenominator {
		t.Fatalf("the workspace as sent (%d) cannot exceed its share of the budget %d", small.WorkspaceBytes, budget)
	}
	if total(small) > budget {
		t.Fatalf("what is sent (%d) must fit the budget (%d)", total(small), budget)
	}

	roomy := f.preview(t, ContextPreviewRequest{Content: "hi", ContextWindowTokens: 200_000, ReservedOutputTokens: 4096})
	if roomy.WorkspaceTrimmed != "" || roomy.WorkspaceBytes < published-200 {
		t.Fatalf("a large window sends the workspace whole: trimmed=%q bytes=%d published=%d", roomy.WorkspaceTrimmed, roomy.WorkspaceBytes, published)
	}
}

func TestThePreviewIsExactlyWhatTheBuilderSends(t *testing.T) {
	snapshot := bigWorkspace()
	history := []Message{
		{Role: "user", Content: strings.Repeat("first question ", 30)},
		{Role: "assistant", Content: strings.Repeat("first answer ", 40), Reasoning: "thinking"},
		{Role: "user", Content: "second question"},
		{Role: "assistant", Content: strings.Repeat("second answer ", 20)},
	}
	f := newPreviewFixture(t, history, &snapshot)
	draft := Attachment{Name: "notes.md", MediaType: "text/markdown", Data: strings.Repeat("a note about the schema\n", 30)}

	for _, window := range []int{3_000, 12_000, 100_000} {
		preview := f.preview(t, ContextPreviewRequest{Content: "now this", Attachments: []Attachment{draft}, ContextWindowTokens: window, ReservedOutputTokens: window / 8})

		stored, _ := f.ledger.GetMessages(context.Background(), f.session, 0, 100)
		latest, _, _ := f.ledger.LatestWorkspaceSnapshotAllowExpired(context.Background(), previewSource, previewInstance)
		built, err := NewDeterministicContextBuilder().Build(context.Background(), ContextBuildRequest{
			Run:               RunSnapshot{SessionID: f.session},
			Messages:          append(stored, Message{ID: "preview-input", SessionID: f.session, Role: "user", Content: "now this", Attachments: []Attachment{draft}}),
			WorkspaceSnapshot: &latest, WorkspaceReference: workspaceSnapshotReference(latest),
			ContextWindowTokens: window, ReservedOutputTokens: window / 8,
		})
		if err != nil {
			t.Fatalf("window %d: %v", window, err)
		}
		if total(preview) != built.Compression.ProviderBytes {
			t.Errorf("window %d: preview %d bytes, builder %d bytes", window, total(preview), built.Compression.ProviderBytes)
		}
		if preview.OmittedMessages != built.Compression.OmittedMessageCount || preview.WorkspaceTrimmed != built.Compression.WorkspaceTrimmed {
			t.Errorf("window %d: omitted/trimmed %d/%q vs %d/%q", window, preview.OmittedMessages, preview.WorkspaceTrimmed, built.Compression.OmittedMessageCount, built.Compression.WorkspaceTrimmed)
		}
	}
}

func TestEarlierMessagesThatNoLongerFitAreCountedAsLeftOut(t *testing.T) {
	var history []Message
	for i := 0; i < 8; i++ {
		role := "user"
		if i%2 == 1 {
			role = "assistant"
		}
		history = append(history, Message{Role: role, Content: strings.Repeat(fmt.Sprintf("message %d ", i), 120)})
	}
	f := newPreviewFixture(t, history, nil)

	whole := f.preview(t, ContextPreviewRequest{Content: "next", ContextWindowTokens: 100_000, ReservedOutputTokens: 1000})
	if whole.OmittedMessages != 0 || whole.RetainedMessages != 9 || whole.UserBytes == 0 || whole.AssistantBytes == 0 {
		t.Fatalf("with room everything is sent: %+v", whole)
	}
	tight := f.preview(t, ContextPreviewRequest{Content: "next", ContextWindowTokens: 4_000, ReservedOutputTokens: 500})
	if tight.OmittedMessages == 0 || tight.RetainedMessages+tight.OmittedMessages != 9 || total(tight) > 3_500 {
		t.Fatalf("with little room the oldest are left out: %+v", tight)
	}
}

func TestWhatWasBoundIsMeasuredApartFromTheWorkspaceAndNotCountedTwice(t *testing.T) {
	selection := map[string]any{"kind": "editor_selection", "dbName": "shop", "tableName": "__gonavi_editor_selection__", "ddl": "", "label": "q", "content": strings.Repeat("select 1;\n", 100)}
	snapshot := bigWorkspace(selection)
	f := newPreviewFixture(t, nil, &snapshot)
	request := ContextPreviewRequest{Content: "explain", ContextWindowTokens: 200_000, ReservedOutputTokens: 4096}

	published := f.preview(t, request)
	if published.BoundBytes < 900 {
		t.Fatalf("the published selection should be measured as bound: %+v", published)
	}

	// The same selection also travels with the message as a chip: it is one binding, not two.
	chip := Attachment{Name: "q", MediaType: ContextChipMediaType, Data: `{"v":1,"kind":"editor_selection","label":"q","dbName":"shop","text":"` + strings.Repeat("select 1;\\n", 100) + `"}`}
	request.Attachments = []Attachment{chip}
	again := f.preview(t, request)
	if again.BoundBytes != published.BoundBytes {
		t.Fatalf("a binding that is already published must not be counted again: %d vs %d", again.BoundBytes, published.BoundBytes)
	}

	// A binding the snapshot does not hold yet (the person just made it) is added.
	other := Attachment{Name: "other", MediaType: ContextChipMediaType, Data: `{"v":1,"kind":"editor_selection","label":"other","dbName":"shop","text":"delete from audit_log"}`}
	request.Attachments = []Attachment{chip, other}
	fresh := f.preview(t, request)
	if fresh.BoundBytes <= published.BoundBytes {
		t.Fatalf("a new binding must show up: %d vs %d", fresh.BoundBytes, published.BoundBytes)
	}
}

func TestAnAttachedFileCountsAsWhatThePersonSends(t *testing.T) {
	f := newPreviewFixture(t, nil, nil)
	plain := f.preview(t, ContextPreviewRequest{Content: "see file", ContextWindowTokens: 100_000, ReservedOutputTokens: 1000})
	withFile := f.preview(t, ContextPreviewRequest{Content: "see file", ContextWindowTokens: 100_000, ReservedOutputTokens: 1000,
		Attachments: []Attachment{{Name: "a.md", MediaType: "text/markdown", Data: strings.Repeat("x", 3_000)}}})
	if withFile.UserBytes-plain.UserBytes < 3_000 {
		t.Fatalf("the file's text reaches the model, so it counts: %d vs %d", withFile.UserBytes, plain.UserBytes)
	}
	if withFile.WorkspaceBytes != 0 || withFile.AssistantBytes != 0 {
		t.Fatalf("nothing else changes: %+v", withFile)
	}
}

func TestAnInputThatCannotFitIsReportedAsOverflow(t *testing.T) {
	f := newPreviewFixture(t, nil, nil)
	preview := f.preview(t, ContextPreviewRequest{Content: strings.Repeat("x", 20_000), ContextWindowTokens: 2_000, ReservedOutputTokens: 500})
	if !preview.Overflow || preview.UserBytes < 20_000 {
		t.Fatalf("preview = %+v", preview)
	}
}

func TestAnUnknownSessionAndAMissingWorkspaceAreNotErrors(t *testing.T) {
	f := newPreviewFixture(t, nil, nil)
	preview, err := f.harness.PreviewContext(context.Background(), ContextPreviewRequest{
		SessionID: "does-not-exist", Content: "hello", ContextSourceID: previewSource, ContextSourceInstanceID: previewInstance,
		ContextWindowTokens: 8_000, ReservedOutputTokens: 1_000,
	})
	if err != nil || preview.WorkspaceBytes != 0 || preview.RetainedMessages != 1 || preview.UserBytes == 0 {
		t.Fatalf("preview = %+v, err = %v", preview, err)
	}
	// With no session and no source at all (a brand-new conversation before the desktop published anything).
	if _, err := f.harness.PreviewContext(context.Background(), ContextPreviewRequest{Content: "hello", ContextWindowTokens: 8_000, ReservedOutputTokens: 1_000}); err != nil {
		t.Fatal(err)
	}
}

func TestPreviewingChangesNothing(t *testing.T) {
	snapshot := bigWorkspace()
	f := newPreviewFixture(t, []Message{{Role: "user", Content: "one"}}, &snapshot)
	before, err := f.ledger.GetSession(context.Background(), f.session, true)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		f.preview(t, ContextPreviewRequest{Content: "draft", ContextWindowTokens: 4_000, ReservedOutputTokens: 500})
	}
	after, err := f.ledger.GetSession(context.Background(), f.session, true)
	if err != nil {
		t.Fatal(err)
	}
	if after.Revision != before.Revision || len(after.Messages) != len(before.Messages) {
		t.Fatalf("a preview wrote to the ledger: revision %d -> %d, messages %d -> %d", before.Revision, after.Revision, len(before.Messages), len(after.Messages))
	}
}

// A fresh conversation must leave most of the window to the conversation: the
// workspace is background, and on a small hosted model every byte is waiting time.
func TestAFreshChatLeavesMostOfTheWindowToTheConversation(t *testing.T) {
	snapshot := bigWorkspace()
	f := newPreviewFixture(t, nil, &snapshot)
	for _, window := range []int{4_096, 16_384, 32_768} {
		preview := f.preview(t, ContextPreviewRequest{ContextWindowTokens: window, ReservedOutputTokens: window / 8})
		budget := window - window/8
		if share := total(preview) * 100 / budget; share > 30 {
			t.Errorf("window %d: an empty chat already takes %d%% of the prompt budget (%+v)", window, share, preview)
		}
	}
}

func TestWhatWasBoundOnPurposeMayTakeMostOfTheBudgetAndIsKept(t *testing.T) {
	var items []any
	for i := 0; i < 6; i++ {
		items = append(items, map[string]any{"dbName": "shop", "tableName": fmt.Sprintf("table_%d", i), "ddl": strings.Repeat(fmt.Sprintf("col_%d bigint, ", i), 60)})
	}
	snapshot := bigWorkspace(items...)
	f := newPreviewFixture(t, nil, &snapshot)
	preview := f.preview(t, ContextPreviewRequest{Content: "write a query", ContextWindowTokens: 16_384, ReservedOutputTokens: 2_048})
	budget := 16_384 - 2_048
	if preview.BoundBytes < budget/4 {
		t.Fatalf("bound schemas (about 6 KB) must be kept, got %d: %+v", preview.BoundBytes, preview)
	}
	if preview.WorkspaceTrimmed != WorkspaceTrimAttachments {
		t.Fatalf("with bound schemas the background gives way: %+v", preview)
	}
	if total(preview) > budget*attachedBudgetNumerator/attachedBudgetDenominator+400 {
		t.Fatalf("bound context has its own share, not the whole budget: %d of %d", total(preview), budget)
	}
}

func TestAnEmptyInputBoxCountsForNothing(t *testing.T) {
	f := newPreviewFixture(t, nil, nil)
	empty := f.preview(t, ContextPreviewRequest{ContextWindowTokens: 8_000, ReservedOutputTokens: 1_000})
	if total(empty) != 0 || empty.RetainedMessages != 0 {
		t.Fatalf("nothing typed, nothing sent: %+v", empty)
	}
	typed := f.preview(t, ContextPreviewRequest{Content: "x", ContextWindowTokens: 8_000, ReservedOutputTokens: 1_000})
	if typed.UserBytes == 0 || typed.RetainedMessages != 1 {
		t.Fatalf("typed: %+v", typed)
	}
}
