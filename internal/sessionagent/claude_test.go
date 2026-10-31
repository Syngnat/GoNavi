package sessionagent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeClaudeFile(t *testing.T, dir, name string, lines ...string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatalf("write claude: %v", err)
	}
	return path
}

func TestParseClaudeSessionMeta(t *testing.T) {
	dir := t.TempDir()
	path := writeClaudeFile(t, dir, "session-abc.jsonl",
		`{"type":"user","sessionId":"ses-1","cwd":"C:/proj/demo","timestamp":"2026-01-02T10:00:00Z","message":{"role":"user","content":[{"type":"text","text":"帮我重构这个模块"}]}}`,
		`{"type":"assistant","sessionId":"ses-1","timestamp":"2026-01-02T10:05:00Z","message":{"role":"assistant","content":[{"type":"text","text":"好的，我来处理"}]}}`,
	)
	meta, err := parseClaudeSessionMeta(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if meta.SessionID != "ses-1" {
		t.Fatalf("sessionID = %q", meta.SessionID)
	}
	if meta.ResumeCommand != "claude --resume ses-1" {
		t.Fatalf("resume = %q", meta.ResumeCommand)
	}
	if !strings.HasPrefix(meta.Title, "帮我重构这个模块") {
		t.Fatalf("title = %q", meta.Title)
	}
	if meta.ProjectDir != "C:/proj/demo" {
		t.Fatalf("projectDir = %q", meta.ProjectDir)
	}
	if meta.Summary == "" {
		t.Fatal("summary must be extracted")
	}
}

func TestParseClaudeSessionMetaCustomTitle(t *testing.T) {
	dir := t.TempDir()
	path := writeClaudeFile(t, dir, "ses-2.jsonl",
		`{"type":"user","sessionId":"ses-2","customTitle":"自定义标题","cwd":"/home/u/p","message":{"role":"user","content":[{"type":"text","text":"ignored"}]}}`,
	)
	meta, err := parseClaudeSessionMeta(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if meta.Title != "自定义标题" {
		t.Fatalf("title = %q", meta.Title)
	}
}

func TestParseClaudeMessages(t *testing.T) {
	dir := t.TempDir()
	path := writeClaudeFile(t, dir, "ses-3.jsonl",
		`{"type":"user","sessionId":"ses-3","message":{"role":"user","content":[{"type":"text","text":"运行测试"}]}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"bash","input":"{\"command\":\"go test\"}"}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}`,
	)
	messages, turns, err := ParseClaudeMessages(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	var sawCall, sawResult bool
	for _, msg := range messages {
		for _, block := range msg.Blocks {
			if block.Type == BlockToolCall {
				sawCall = true
				if block.ToolCall == nil || block.ToolCall.Kind != ToolShell {
					t.Fatalf("tool call wrong: %+v", block.ToolCall)
				}
			}
			if block.Type == BlockToolResult {
				sawResult = true
				if block.ToolResult == nil || block.ToolResult.CallID != "t1" {
					t.Fatalf("tool result wrong: %+v", block.ToolResult)
				}
			}
		}
	}
	if !sawCall || !sawResult {
		t.Fatalf("missing blocks: call=%v result=%v", sawCall, sawResult)
	}
	if len(turns) == 0 {
		t.Fatal("no turns")
	}
}

func TestStripSystemReminders(t *testing.T) {
	got := stripSystemReminders("头部<system-reminder>噪音</system-reminder>尾部")
	if got != "头部尾部" {
		t.Fatalf("got %q", got)
	}
}

func TestClaudeIsInjectedText(t *testing.T) {
	cases := map[string]bool{
		"<local-command-caveat> x":                  true,
		"<task-notification> y</task-notification>": true,
		"<command-name>/help</command-name>":        true,
		"正常提问":                                      false,
		"<environment_context> z":                   true,
	}
	for text, want := range cases {
		if got := claudeIsInjectedText(text); got != want {
			t.Fatalf("claudeIsInjectedText(%q) = %v, want %v", text, got, want)
		}
	}
}

func TestTranscriptCacheHitAndEvict(t *testing.T) {
	cache := NewTranscriptCache(2, 1<<20)
	loads := 0
	load := func() (*Transcript, error) {
		loads++
		return &Transcript{ApproxBytes: 128}, nil
	}
	fp := transcriptFingerprint{Modified: time.Unix(100, 0), Size: 10}
	_, cached, _, err := cache.GetOrLoad("k1", fp, load)
	if err != nil || cached {
		t.Fatalf("first load must miss: cached=%v err=%v", cached, err)
	}
	_, cached, _, err = cache.GetOrLoad("k1", fp, load)
	if err != nil || !cached {
		t.Fatalf("second load must hit: cached=%v err=%v", cached, err)
	}
	if loads != 1 {
		t.Fatalf("loads = %d, want 1", loads)
	}
	// 指纹变化 → 失效重解析。
	fp2 := transcriptFingerprint{Modified: time.Unix(200, 0), Size: 10}
	_, cached, _, _ = cache.GetOrLoad("k1", fp2, load)
	if cached {
		t.Fatal("changed fingerprint must miss")
	}
	// LRU 淘汰：超过条目上限。
	cache.GetOrLoad("k2", fp, load)
	cache.GetOrLoad("k3", fp, load)
	// k1 可能已被淘汰，再取应 miss。
	_, cached, _, _ = cache.GetOrLoad("k1", fp, load)
	if cached {
		t.Fatal("evicted entry must miss")
	}
}

func TestResolveContentJSONL(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "x.jsonl")
	line := `{"payload":{"output":"hello world"}}` + "\n"
	if err := os.WriteFile(path, []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	ref := ContentRef{Kind: ContentJSONL, Offset: 0, Length: uint32(len(line)), Pointer: "/payload/output"}
	content, err := ResolveContent(path, ref, 0, MaxPageChars)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if content.Text != "hello world" {
		t.Fatalf("text = %q", content.Text)
	}
	if content.Truncated {
		t.Fatal("must not truncate short content")
	}
}

func TestResolveContentPaging(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "y.jsonl")
	big := strings.Repeat("a", 3000)
	line := `{"payload":{"output":"` + big + `"}}` + "\n"
	if err := os.WriteFile(path, []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	ref := ContentRef{Kind: ContentJSONL, Offset: 0, Length: uint32(len(line)), Pointer: "/payload/output"}
	first, err := ResolveContent(path, ref, 0, 1000)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if !first.Truncated || first.NextOffset == nil || *first.NextOffset != 1000 {
		t.Fatalf("first page wrong: %+v", first)
	}
	second, err := ResolveContent(path, ref, *first.NextOffset, 1000)
	if err != nil {
		t.Fatalf("resolve2: %v", err)
	}
	if len([]rune(second.Text)) != 1000 {
		t.Fatalf("second page len = %d", len([]rune(second.Text)))
	}
}

func TestGroupByTime(t *testing.T) {
	now := time.Date(2026, 1, 10, 15, 0, 0, 0, time.UTC)
	today := now.Add(-2 * time.Hour).UnixMilli()
	yesterday := now.AddDate(0, 0, -1).Add(-2 * time.Hour).UnixMilli()
	older := now.AddDate(0, 0, -10).UnixMilli()
	sessions := []SessionMeta{
		{SessionID: "a", LastActiveAt: today},
		{SessionID: "b", LastActiveAt: yesterday},
		{SessionID: "c", LastActiveAt: older},
	}
	groups := GroupByTime(sessions, now)
	if len(groups["today"]) != 1 || len(groups["yesterday"]) != 1 || len(groups["older"]) != 1 {
		t.Fatalf("groups = %v", groups)
	}
}

func TestServiceListAndDelete(t *testing.T) {
	codexDir := t.TempDir()
	sessionsDir := filepath.Join(codexDir, "sessions")
	if err := os.MkdirAll(sessionsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeRollout(t, sessionsDir, "rollout-del.jsonl",
		metaLine,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"删除测试"}]}}`,
	)
	svc := &Service{CodexDir: codexDir, ClaudeDir: filepath.Join(t.TempDir(), "absent")}
	items := svc.List("", "")
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1", len(items))
	}
	meta := items[0]
	// 搜索过滤。
	if len(svc.List("", "删除测试")) != 1 {
		t.Fatal("search must match")
	}
	if len(svc.List("", "不存在的关键词xyz")) != 0 {
		t.Fatal("search must filter out")
	}
	// 详情加载。
	transcript, _, err := svc.LoadTranscript(ProviderCodex, meta.SourcePath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(transcript.Messages) == 0 {
		t.Fatal("no messages")
	}
	// 导出 Markdown。
	markdown, err := svc.ExportMarkdown(ProviderCodex, meta.SourcePath)
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	if !strings.Contains(markdown, "删除测试") {
		t.Fatalf("markdown = %q", markdown)
	}
	// 删除（含身份校验）。
	if err := svc.Delete(ProviderCodex, meta.SourcePath, meta.SessionID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if len(svc.List("", "")) != 0 {
		t.Fatal("list must be empty after delete")
	}
}

func TestServiceResumeCommand(t *testing.T) {
	svc := New()
	if got := svc.ResumeCommand(ProviderCodex, "abc"); got != "codex resume abc" {
		t.Fatalf("got %q", got)
	}
	if got := svc.ResumeCommand(ProviderClaude, "abc"); got != "claude --resume abc" {
		t.Fatalf("got %q", got)
	}
}
