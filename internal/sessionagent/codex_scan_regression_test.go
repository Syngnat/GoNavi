package sessionagent

// 本文件是 Codex 列表元数据解析的回归测试：覆盖真实 rollout 文件形态
// 演进带来的解析断层（压缩形态、source 多形态、子代理标记、注入块）。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
)

// writeCompressedRollout 写一个 zstd 压缩形态的 rollout 文件。
func writeCompressedRollout(t *testing.T, dir, name string, lines ...string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	file, err := os.Create(path)
	if err != nil {
		t.Fatalf("create rollout: %v", err)
	}
	encoder, err := zstd.NewWriter(file)
	if err != nil {
		t.Fatalf("zstd writer: %v", err)
	}
	if _, err := encoder.Write([]byte(strings.Join(lines, "\n") + "\n")); err != nil {
		t.Fatalf("zstd write: %v", err)
	}
	if err := encoder.Close(); err != nil {
		t.Fatalf("zstd close: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close file: %v", err)
	}
	return path
}

// 真实 Codex 的 source 字段是字符串形态，用固定结构体反序列化会失败，
// 连带丢掉 cwd 与 timestamp。
func TestParseCodexSessionMetaHandlesStringSource(t *testing.T) {
	dir := t.TempDir()
	path := writeRollout(t, dir, "rollout-2026-10-20T04-11-57-01a155ca-ceec-7f01-aaed-c13af437c7a7.jsonl",
		`{"type":"session_meta","payload":{"id":"th-str","session_id":"th-str","cwd":"E:/work/CoBot","timestamp":"2026-10-19T20:11:57.251Z","source":"vscode","thread_source":"user"}}`,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"帮我看看这个"}]}}`,
	)
	meta, err := parseCodexSessionMeta(path, map[string]string{})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if meta == nil {
		t.Fatal("meta must not be nil")
	}
	if meta.ProjectDir != "E:/work/CoBot" {
		t.Fatalf("projectDir = %q, want E:/work/CoBot", meta.ProjectDir)
	}
	if meta.CreatedAt == 0 {
		t.Fatal("createdAt must be parsed from RFC3339 timestamp")
	}
	if meta.Title != "帮我看看这个" {
		t.Fatalf("title = %q", meta.Title)
	}
}

// 压缩形态必须真正解压后再解析，否则列表拿不到任何元数据。
func TestParseCodexSessionMetaDecodesCompressedRollout(t *testing.T) {
	dir := t.TempDir()
	path := writeCompressedRollout(t, dir, "rollout-2026-10-19T03-08-15-01a1506a-22b6-77a1-babd-a1aa63f59069.jsonl.zst",
		`{"type":"session_meta","payload":{"id":"th-zst","cwd":"E:/work/GoNavi","timestamp":"2026-10-19T03:08:15.000Z","source":"vscode"}}`,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"压缩会话也要能看"}]}}`,
	)
	meta, err := parseCodexSessionMeta(path, map[string]string{})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if meta == nil {
		t.Fatal("meta must not be nil")
	}
	if meta.SessionID != "th-zst" {
		t.Fatalf("sessionID = %q", meta.SessionID)
	}
	if meta.ProjectDir != "E:/work/GoNavi" {
		t.Fatalf("projectDir = %q", meta.ProjectDir)
	}
	if meta.Title != "压缩会话也要能看" {
		t.Fatalf("title = %q", meta.Title)
	}
}

// 子代理的 source.subagent 是对象（旧版是布尔），两种形态都要拦住。
func TestParseCodexSessionMetaSkipsObjectSubagent(t *testing.T) {
	dir := t.TempDir()
	path := writeRollout(t, dir, "rollout-2026-10-14T22-34-12-01a13ad5-ca99-7462-bc49-4ab5c69a16a5.jsonl",
		`{"type":"session_meta","payload":{"id":"th-sub","source":{"subagent":{"thread_spawn":{"parent_thread_id":"01a13667-48a9-7a92-9303-198269feba28","depth":1,"agent_path":"/root/review"}}}}}`,
	)
	meta, err := parseCodexSessionMeta(path, map[string]string{})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if meta != nil {
		t.Fatalf("subagent must be skipped: %+v", meta)
	}
}

// thread_source="subagent" 是新版标记，与 source 形态无关。
func TestParseCodexSessionMetaSkipsThreadSourceSubagent(t *testing.T) {
	dir := t.TempDir()
	path := writeRollout(t, dir, "rollout-2026-10-15T20-02-46-01a13f71-83fe-7ed1-9c07-f34abc188996.jsonl",
		`{"type":"session_meta","payload":{"id":"th-sub2","source":"vscode","thread_source":"subagent"}}`,
	)
	meta, err := parseCodexSessionMeta(path, map[string]string{})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if meta != nil {
		t.Fatalf("subagent must be skipped: %+v", meta)
	}
}

// 旧版本子代理没有 session_meta 标记，只能靠文件名识别。
func TestParseCodexSessionMetaSkipsSubagentByFileName(t *testing.T) {
	dir := t.TempDir()
	path := writeRollout(t, dir,
		"rollout-2026-10-13T15-30-27-01a12b8c-abc7-7ed3-b123-fd389010f6b2_01a1342b-7c7c-73f2-92c9-aa847cc5501e.jsonl",
		`{"type":"session_meta","payload":{"id":"01a12b8c-abc7-7ed3-b123-fd389010f6b2","source":"vscode"}}`,
	)
	meta, err := parseCodexSessionMeta(path, map[string]string{})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if meta != nil {
		t.Fatalf("subagent must be skipped: %+v", meta)
	}
}

// 头部注入块可达 20 行以上，首条真实用户消息必须仍能取到。
func TestParseCodexSessionMetaFindsUserMessageAfterInjectedBlocks(t *testing.T) {
	dir := t.TempDir()
	lines := []string{
		`{"type":"session_meta","payload":{"id":"th-inj","cwd":"E:/work/demo","source":"vscode"}}`,
		`{"type":"event_msg","payload":{"type":"x"}}`,
		`{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"developer 指令"}]}}`,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for E:/work"}]}}`,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\n<current_date>2026-10-20</current_date>\n</environment_context>"}]}}`,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<external_codex_apps_open_page>{\"page_id\":null}</external_codex_apps_open_page>"}]}}`,
		`{"type":"turn_context","payload":{"turn_id":"t1"}}`,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<recommended_plugins>\n- Dropbox\n</recommended_plugins>"}]}}`,
	}
	// 补足到 20 行注入块之后才出现真实用户消息。
	for i := 0; i < 12; i++ {
		lines = append(lines, `{"type":"event_msg","payload":{"type":"filler"}}`)
	}
	lines = append(lines,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"真正的问题在这里"}]}}`,
	)
	path := writeRollout(t, dir, "rollout-2026-10-20T04-11-57-01a155ca-ceec-7f01-aaed-c13af437c7a7.jsonl", lines...)
	meta, err := parseCodexSessionMeta(path, map[string]string{})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if meta == nil {
		t.Fatal("meta must not be nil")
	}
	if meta.FirstMessage != "真正的问题在这里" {
		t.Fatalf("firstMessage = %q", meta.FirstMessage)
	}
	if meta.Title != "真正的问题在这里" {
		t.Fatalf("title = %q", meta.Title)
	}
}

// 尾部注入块（turn_aborted 等）不能出现在摘要里。实测 turn_aborted
// 是 developer 角色注入的。
func TestParseCodexSessionMetaSkipsInjectedSummary(t *testing.T) {
	dir := t.TempDir()
	path := writeRollout(t, dir, "rollout-2026-10-14T03-18-45-01a136b3-f1eb-7e01-a01d-6476c30dbd85.jsonl",
		`{"type":"session_meta","payload":{"id":"th-sum","source":"vscode"}}`,
		`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"这是正常的回复内容"}]}}`,
		`{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<turn_aborted> The previous turn was interrupted on purpose."}]}}`,
	)
	meta, err := parseCodexSessionMeta(path, map[string]string{})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if meta == nil {
		t.Fatal("meta must not be nil")
	}
	if strings.Contains(meta.Summary, "turn_aborted") {
		t.Fatalf("summary must not contain injected block: %q", meta.Summary)
	}
	if meta.Summary != "这是正常的回复内容" {
		t.Fatalf("summary = %q", meta.Summary)
	}
}

// 助手回复里的 HTML 不是注入包装，不能被摘要过滤误伤。
func TestParseCodexSessionMetaKeepsAssistantHTML(t *testing.T) {
	dir := t.TempDir()
	path := writeRollout(t, dir, "rollout-2026-10-14T03-18-46-01a136b3-f1eb-7e01-a01d-6476c30dbd86.jsonl",
		`{"type":"session_meta","payload":{"id":"th-html","source":"vscode"}}`,
		`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"<div class=\"row\">内容</div>"}]}}`,
	)
	meta, err := parseCodexSessionMeta(path, map[string]string{})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if meta == nil {
		t.Fatal("meta must not be nil")
	}
	if !strings.Contains(meta.Summary, "<div") {
		t.Fatalf("assistant html must be kept as summary: %q", meta.Summary)
	}
}

// 压缩形态的头尾扫描：头尾行都要来自解压后的真实内容。
func TestReadSessionLinesDecodesCompressed(t *testing.T) {	dir := t.TempDir()
	lines := make([]string, 0, 40)
	for i := 0; i < 40; i++ {
		lines = append(lines, `{"type":"event_msg","payload":{"n":`+string(rune('0'+i%10))+`}}`)
	}
	path := writeCompressedRollout(t, dir, "rollout-x.jsonl.zst", lines...)
	result, err := ReadSessionLines(path, 3, 2)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(result.Head) != 3 {
		t.Fatalf("head = %d lines, want 3", len(result.Head))
	}
	if len(result.Tail) != 2 {
		t.Fatalf("tail = %d lines, want 2", len(result.Tail))
	}
	if !strings.Contains(result.Head[0], "event_msg") {
		t.Fatalf("head[0] = %q", result.Head[0])
	}
	if !strings.Contains(result.Tail[1], "event_msg") {
		t.Fatalf("tail[1] = %q", result.Tail[1])
	}
}

// 同一会话在 sessions 与 archived_sessions 各有一份时只应出现一行。
func TestDedupeRolloutCopiesAcrossRoots(t *testing.T) {
	paths := []string{
		"/x/sessions/2026/10/19/rollout-a.jsonl",
		"/x/archived_sessions/rollout-a.jsonl.zst",
		"/x/sessions/2026/10/19/rollout-b.jsonl.zst",
	}
	result := DedupeRolloutCopies(paths)
	if len(result) != 2 {
		t.Fatalf("result = %v", result)
	}
	if result[0] != "/x/sessions/2026/10/19/rollout-a.jsonl" {
		t.Fatalf("result[0] = %q", result[0])
	}
	if result[1] != "/x/sessions/2026/10/19/rollout-b.jsonl.zst" {
		t.Fatalf("result[1] = %q", result[1])
	}
}

// 压缩形态的按需取全文：ContentRef 的字节偏移是在**解压流**上算出来的
//（解析时经 OpenRollout 解压），回读也必须走解压流，不能在压缩文件上
// 直接 seek。
func TestResolveContentOnCompressedRollout(t *testing.T) {
	dir := t.TempDir()
	payload := strings.Repeat("大内容输出", 800)
	path := writeCompressedRollout(t, dir, "rollout-content.jsonl.zst",
		`{"type":"session_meta","payload":{"id":"th-content","source":"vscode"}}`,
		`{"type":"response_item","payload":{"type":"function_call","name":"exec","call_id":"c1","arguments":"{}"}}`,
		`{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"`+payload+`"}}`,
	)
	messages, _, err := ParseCodexMessages(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	var ref *ContentRef
	for _, msg := range messages {
		for _, block := range msg.Blocks {
			if block.Type == BlockToolResult && block.ToolResult != nil && block.ToolResult.Full != nil {
				ref = block.ToolResult.Full
			}
		}
	}
	if ref == nil {
		t.Fatal("tool result must carry a content ref")
	}
	content, err := ResolveContent(path, *ref, 0, 0)
	if err != nil {
		t.Fatalf("resolve content: %v", err)
	}
	if !strings.Contains(content.Text, "大内容输出") {
		t.Fatalf("resolved text mismatch: %.120q", content.Text)
	}
	if content.TotalLen == 0 {
		t.Fatal("totalLen must be positive")
	}
}

// fork 会话要在列表里区分出来（session_meta.forked_from_id）。
func TestParseCodexSessionMetaDetectsFork(t *testing.T) {
	dir := t.TempDir()
	path := writeRollout(t, dir, "rollout-fork.jsonl",
		`{"type":"session_meta","payload":{"id":"th-fork","cwd":"E:/work/demo","source":"vscode","forked_from_id":"01a13667-48a9-7a92-9303-198269feba28"}}`,
	)
	meta, err := parseCodexSessionMeta(path, map[string]string{})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if meta == nil {
		t.Fatal("meta must not be nil")
	}
	if meta.ForkedFrom != "01a13667-48a9-7a92-9303-198269feba28" {
		t.Fatalf("forkedFrom = %q", meta.ForkedFrom)
	}
}

// 普通会话不能被误标成 fork。
func TestParseCodexSessionMetaWithoutFork(t *testing.T) {
	dir := t.TempDir()
	path := writeRollout(t, dir, "rollout-plain.jsonl",
		`{"type":"session_meta","payload":{"id":"th-plain","cwd":"E:/work/demo","source":"vscode"}}`,
	)
	meta, err := parseCodexSessionMeta(path, map[string]string{})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if meta == nil {
		t.Fatal("meta must not be nil")
	}
	if meta.ForkedFrom != "" {
		t.Fatalf("forkedFrom = %q, want empty", meta.ForkedFrom)
	}
}

// Codex 的 developer 消息装的是工具链上下文（审批记录、hook 事件、权限
// 说明等），不是对话内容——必须标成注入，否则会话详情被噪音淹没。
func TestCodexDeveloperMessagesAreInjected(t *testing.T) {
	dir := t.TempDir()
	path := writeRollout(t, dir, "rollout-dev.jsonl",
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"用户问题"}]}}`,
		`{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"Approved command prefix saved:\n- [\"pwsh.exe\", \"-Command\"]"}]}}`,
		`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"助手回答"}]}}`,
	)
	messages, _, err := ParseCodexMessages(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	var developer, assistant, user *SessionMessage
	for i := range messages {
		switch messages[i].Role {
		case RoleSystem:
			developer = &messages[i]
		case RoleAssistant:
			assistant = &messages[i]
		case RoleUser:
			user = &messages[i]
		}
	}
	if developer == nil {
		t.Fatal("developer message must be parsed")
	}
	if !developer.Injected {
		t.Fatal("developer message must be marked injected")
	}
	if assistant == nil || assistant.Injected {
		t.Fatal("assistant message must stay real content")
	}
	if user == nil || user.Injected {
		t.Fatal("user message must stay real content")
	}
}

// 归档副本必须一起删除，否则删完列表里立刻又出现同一会话。
func TestServiceDeleteRemovesArchivedCopy(t *testing.T) {
	root := t.TempDir()
	live := filepath.Join(root, "sessions", "2026", "10", "19")
	archive := filepath.Join(root, "archived_sessions")
	if err := os.MkdirAll(live, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(archive, 0o700); err != nil {
		t.Fatal(err)
	}
	meta := `{"type":"session_meta","payload":{"id":"th-del","cwd":"E:/work","source":"vscode"}}`
	name := "rollout-2026-10-19T03-08-15-01a1506a-22b6-77a1-babd-a1aa63f59069.jsonl"
	livePath := writeRollout(t, live, name, meta)
	archivePath := writeRollout(t, archive, name, meta)

	service := &Service{CodexDir: root}
	service.SetEnabled(ProviderCodex)
	if err := service.Delete(ProviderCodex, livePath, "th-del"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	for _, path := range []string{livePath, archivePath} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("copy must be removed: %s", path)
		}
	}
}
