package sessionagent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 写一个最小 rollout 会话文件并返回路径。
func writeRollout(t *testing.T, dir, name string, lines ...string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatalf("write rollout: %v", err)
	}
	return path
}

const metaLine = `{"type":"session_meta","payload":{"id":"th-1","cwd":"C:/work/demo","timestamp":1760000000}}`

func TestMakePreviewTruncatesLinesThenChars(t *testing.T) {
	text := strings.Repeat("line\n", 20) + strings.Repeat("x", 2000)
	preview := MakePreview(text)
	if !preview.Truncated {
		t.Fatal("must truncate")
	}
	if preview.LineCount != 21 {
		t.Fatalf("lineCount = %d, want 21", preview.LineCount)
	}
	if len([]rune(preview.Text)) > PreviewChars {
		t.Fatalf("preview exceeds PreviewChars: %d", len([]rune(preview.Text)))
	}
}

func TestOneLineTitle(t *testing.T) {
	if got := OneLineTitle("hello\nworld"); got != "hello…" {
		t.Fatalf("got %q", got)
	}
	if got := OneLineTitle(strings.Repeat("a", TitleChars+10)); !strings.HasSuffix(got, "…") {
		t.Fatalf("must ellipsis long title: %q", got)
	}
	if got := OneLineTitle("plain"); got != "plain" {
		t.Fatalf("got %q", got)
	}
}

func TestCountDiffLines(t *testing.T) {
	added, removed := CountDiffLines("+++ a\n--- b\n+one\n+two\n-three\n")
	if added != 2 || removed != 1 {
		t.Fatalf("added=%d removed=%d", added, removed)
	}
}

func TestBuildTurns(t *testing.T) {
	messages := []SessionMessage{
		{Role: RoleUser, Content: "问题一", TurnID: "t1"},
		{Role: RoleAssistant, Content: "回答一", TurnID: "t1"},
		{Role: RoleUser, Content: "问题二", TurnID: "t2"},
		{Role: RoleAssistant, Blocks: []SessionBlock{
			{Type: BlockToolCall, ToolCall: &ToolCallBlock{ID: "c1", Kind: ToolShell, Title: "ls"}},
			{Type: BlockToolResult, ToolResult: &ToolResultBlock{CallID: "c1", Status: ToolStatusError}},
		}, TurnID: "t2"},
		{Role: RoleUser, Content: "注入包装", TurnID: "t2", Injected: true},
	}
	turns := BuildTurns(messages)
	if len(turns) != 2 {
		t.Fatalf("turns = %d, want 2: %+v", len(turns), turns)
	}
	if turns[0].QuestionPreview != "问题一" {
		t.Fatalf("q0 = %q", turns[0].QuestionPreview)
	}
	if turns[1].StepCount != 1 || turns[1].ErrorCount != 1 {
		t.Fatalf("turn1 steps=%d errors=%d", turns[1].StepCount, turns[1].ErrorCount)
	}
}

func TestIsInjectedUserText(t *testing.T) {
	cases := map[string]bool{
		"# AGENTS.md instructions":                                        true,
		"<environment_context> x</environment_context>":                   true,
		"<recommended_plugins> list</recommended_plugins>":                true,
		"<in-app-browser-context source=\"x\">y</in-app-browser-context>": true,
		"<user_instructions> z</user_instructions>":                       true,
		"<turn_aborted>":      true,
		"正常用户提问":              false,
		"<image name=\"a\"/>": true,
	}
	for text, want := range cases {
		if got := isInjectedUserText(text); got != want {
			t.Fatalf("isInjectedUserText(%q) = %v, want %v", text, got, want)
		}
	}
}

func TestParseCodexSessionMetaFromHeadTail(t *testing.T) {
	dir := t.TempDir()
	path := writeRollout(t, dir, "rollout-2026-01-01-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
		metaLine,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"帮我修复构建"}]}}`,
		`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"好的"}]}}`,
	)
	meta, err := parseCodexSessionMeta(path, map[string]string{})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if meta.SessionID != "th-1" {
		t.Fatalf("sessionID = %q", meta.SessionID)
	}
	if meta.ResumeCommand != "codex resume th-1" {
		t.Fatalf("resume = %q", meta.ResumeCommand)
	}
	if !strings.HasPrefix(meta.Title, "帮我修复构建") {
		t.Fatalf("title = %q", meta.Title)
	}
	if meta.ProjectDir != "C:/work/demo" {
		t.Fatalf("projectDir = %q", meta.ProjectDir)
	}
	if meta.CreatedAt != 1760000000*1000 {
		t.Fatalf("createdAt = %d", meta.CreatedAt)
	}
}

func TestParseCodexSessionMetaSkipsSubagent(t *testing.T) {
	dir := t.TempDir()
	path := writeRollout(t, dir, "rollout-sub.jsonl",
		`{"type":"session_meta","payload":{"id":"th-sub","source":{"subagent":true}}}`,
	)
	meta, err := parseCodexSessionMeta(path, map[string]string{})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if meta != nil {
		t.Fatalf("subagent must be skipped: %+v", meta)
	}
}

func TestParseCodexMessagesMapsBlocks(t *testing.T) {
	dir := t.TempDir()
	path := writeRollout(t, dir, "rollout-msg.jsonl",
		metaLine,
		`{"type":"turn_context","payload":{"turn_id":"t1","model":"gpt-5"}}`,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"列出文件"}]}}`,
		`{"type":"response_item","payload":{"type":"reasoning","summary":[{"text":"想一想"}],"content":"内部推理"}}`,
		// 命令用 cat 而非 ls：ls 命中 classifyCodexTool 的搜索分支
		// （rg/grep/fd/find/ls → ToolSearch），这里要断言的是 exec→shell
		// 的映射。参数能否被解析出来由下面的专项用例覆盖。
		`{"type":"response_item","payload":{"type":"function_call","name":"exec","call_id":"c1","arguments":"{\"cmd\":\"cat README.md\"}"}}`,
		`{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"file1\nfile2"}}`,
	)
	messages, turns, err := ParseCodexMessages(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	var sawThinking, sawCall, sawResult bool
	for _, msg := range messages {
		for _, block := range msg.Blocks {
			switch block.Type {
			case BlockThinking:
				sawThinking = true
			case BlockToolCall:
				sawCall = true
				if block.ToolCall == nil || block.ToolCall.Kind != ToolShell {
					t.Fatalf("tool call wrong: %+v", block.ToolCall)
				}
			case BlockToolResult:
				sawResult = true
				if block.ToolResult == nil || block.ToolResult.Status != ToolStatusSuccess {
					t.Fatalf("tool result wrong: %+v", block.ToolResult)
				}
			}
		}
	}
	if !sawThinking || !sawCall || !sawResult {
		t.Fatalf("missing blocks: thinking=%v call=%v result=%v", sawThinking, sawCall, sawResult)
	}
	if len(turns) == 0 {
		t.Fatal("no turns")
	}
}

func TestDedupeRolloutSiblings(t *testing.T) {
	paths := []string{
		"/x/a.jsonl",
		"/x/a.jsonl.zst",
		"/x/b.jsonl.zst",
	}
	result := DedupeRolloutSiblings(paths)
	if len(result) != 2 {
		t.Fatalf("result = %v", result)
	}
	if result[0] != "/x/a.jsonl" || result[1] != "/x/b.jsonl.zst" {
		t.Fatalf("result = %v", result)
	}
}

func TestStripOutputHeader(t *testing.T) {
	got := stripOutputHeader("Script completed\nWall time: 0.1s\nOutput:\nreal body")
	if got != "real body" {
		t.Fatalf("got %q", got)
	}
	got = stripOutputHeader("plain output")
	if got != "plain output" {
		t.Fatalf("got %q", got)
	}
}

func TestParseApplyPatchFiles(t *testing.T) {
	files := ParseApplyPatchFiles(
		"*** Begin Patch\n" +
			"*** Add File: a.go\n+x1\n+x2\n" +
			"*** Update File: b.go\n ctx\n-old\n+new\n" +
			"*** Delete File: c.go\n-del1\n-del2\n" +
			"*** End Patch")
	if len(files) != 3 {
		t.Fatalf("files = %+v", files)
	}
	if files[0].Path != "a.go" || files[0].Op != DiffAdd || files[0].Added != 2 || files[0].Removed != 0 {
		t.Fatalf("file0 = %+v", files[0])
	}
	if files[1].Path != "b.go" || files[1].Op != DiffUpdate || files[1].Added != 1 || files[1].Removed != 1 {
		t.Fatalf("file1 = %+v", files[1])
	}
	if files[2].Path != "c.go" || files[2].Op != DiffDelete || files[2].Added != 0 || files[2].Removed != 2 {
		t.Fatalf("file2 = %+v", files[2])
	}
}

func TestCodexExtractApplyPatch(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "extracts patch wrapped in exec script",
			input: "text(await tools.apply_patch(\"*** Begin Patch\n*** Add File: a.go\n+x\n*** End Patch\"));\ntools.exec_command({cmd:\"ls\"})",
			want:  "*** Begin Patch\n*** Add File: a.go\n+x\n*** End Patch",
		},
		{
			name:  "decodes escaped exec string literal",
			input: `text(await tools.apply_patch("*** Begin Patch\n*** Add File: a.go\n+x\n*** End Patch"));`,
			want:  "*** Begin Patch\n*** Add File: a.go\n+x\n*** End Patch",
		},
		{
			name:  "rejects script without parseable files",
			input: `text(await tools.apply_patch("*** Begin Patch\n@@\n*** End Patch"))`,
			want:  "",
		},
		{
			name:  "ignores ordinary exec command",
			input: `text(await tools.exec_command({cmd:"git apply patch"}))`,
			want:  "",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := codexExtractApplyPatch(tt.input); got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestParseCodexMessagesExtractsWrappedApplyPatch(t *testing.T) {
	dir := t.TempDir()
	path := writeRollout(t, dir, "rollout-patch.jsonl",
		metaLine,
		`{"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"c1","input":"text(await tools.apply_patch(\"*** Begin Patch\n*** Update File: main.go\n-x\n+y\n*** End Patch\"));"}}`,
		`{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c1","output":"ok"}}`,
	)
	messages, _, err := ParseCodexMessages(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	var call *ToolCallBlock
	for _, msg := range messages {
		for _, block := range msg.Blocks {
			if block.Type == BlockToolCall && block.ToolCall != nil {
				call = block.ToolCall
			}
		}
	}
	if call == nil {
		t.Fatal("tool call missing")
	}
	if call.Kind != ToolDiff || call.Diff == nil {
		t.Fatalf("call = %+v", call)
	}
	if len(call.Diff.Files) != 1 || call.Diff.Files[0].Path != "main.go" {
		t.Fatalf("files = %+v", call.Diff.Files)
	}
	if call.Diff.Files[0].Added != 1 || call.Diff.Files[0].Removed != 1 {
		t.Fatalf("file counts = %+v", call.Diff.Files[0])
	}
	// 改动页要能展示 patch 内容：预览必须带上，且包含 + 行。
	if !strings.Contains(call.InputPreview, "+y") {
		t.Fatalf("inputPreview = %q", call.InputPreview)
	}
}

func TestUnderRoots(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "sub")
	if err := os.MkdirAll(sub, 0o700); err != nil {
		t.Fatal(err)
	}
	ok, err := UnderRoots(sub, []string{dir})
	if err != nil || !ok {
		t.Fatalf("sub must be under dir: ok=%v err=%v", ok, err)
	}
	ok, _ = UnderRoots(dir, []string{sub})
	if ok {
		t.Fatal("dir must NOT be under sub")
	}
}
