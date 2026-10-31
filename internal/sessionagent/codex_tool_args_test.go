package sessionagent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Codex 工具参数与命名空间的解析回归。
//
// 真实 Codex 记录里 function_call 的 arguments 是「JSON 字符串里套 JSON」：
//
//	"arguments":"{\"cmd\":\"rg --files /tmp\"}"
//
// 而 namespace 单独成字段（"namespace":"mcp__cua_repl"），工具名往往只是
// "js" 这类短名。两者没被解析时，工具行只剩一个光秃秃的工具名，
// cmd/workdir/query/title 全部读不到，MCP 工具也全被判成 other。

// writeCodexRollout 写一个只含指定行的 rollout 文件。
func writeCodexRollout(t *testing.T, dir, name string, lines ...string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(joinLines(lines)+"\n"), 0o600); err != nil {
		t.Fatalf("write rollout: %v", err)
	}
	return path
}

func joinLines(lines []string) string {
	out := ""
	for i, line := range lines {
		if i > 0 {
			out += "\n"
		}
		out += line
	}
	return out
}

// firstToolCall 取第一条工具调用块。
func firstToolCall(t *testing.T, messages []SessionMessage) *ToolCallBlock {
	t.Helper()
	for _, msg := range messages {
		for _, block := range msg.Blocks {
			if block.Type == BlockToolCall && block.ToolCall != nil {
				return block.ToolCall
			}
		}
	}
	t.Fatal("no tool call block parsed")
	return nil
}

// 参数是双层编码时也要读出 cmd，并把搜索类命令识别成 ToolSearch。
func TestCodexToolCallDecodesDoubleEncodedArguments(t *testing.T) {
	dir := t.TempDir()
	path := writeCodexRollout(t, dir, "rollout-double.jsonl",
		metaLine,
		`{"type":"response_item","payload":{"type":"function_call","name":"exec","call_id":"c1","arguments":"{\"cmd\":\"rg --files /tmp\",\"workdir\":\"/work\"}"}}`,
	)
	messages, _, err := ParseCodexMessages(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	call := firstToolCall(t, messages)
	if call.Title != "rg --files /tmp" {
		t.Fatalf("title = %q, want the decoded command", call.Title)
	}
	if call.Detail != "/work" {
		t.Fatalf("detail = %q, want the decoded workdir", call.Detail)
	}
	if call.Kind != ToolSearch {
		t.Fatalf("kind = %q, want %q (rg is a search tool)", call.Kind, ToolSearch)
	}
	// 预览必须是剥壳后的参数文本，不能是整屏转义引号的原始字符串。
	if want := `{"cmd":"rg --files /tmp","workdir":"/work"}`; call.InputPreview != want {
		t.Fatalf("input preview = %q, want %q", call.InputPreview, want)
	}
}

// 已经是对象形态的参数不能被回归（双层解码的兼容面）。
func TestCodexToolCallAcceptsPlainObjectArguments(t *testing.T) {
	dir := t.TempDir()
	path := writeCodexRollout(t, dir, "rollout-plain.jsonl",
		metaLine,
		`{"type":"response_item","payload":{"type":"function_call","name":"exec","call_id":"c1","arguments":{"cmd":"cat README.md"}}}`,
	)
	messages, _, err := ParseCodexMessages(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	call := firstToolCall(t, messages)
	if call.Title != "cat README.md" {
		t.Fatalf("title = %q, want the decoded command", call.Title)
	}
	if call.Kind != ToolShell {
		t.Fatalf("kind = %q, want %q", call.Kind, ToolShell)
	}
}

// namespace 单独成字段时，MCP 工具必须被识别成 ToolMcp，标题取参数 title。
func TestCodexToolCallUsesNamespaceForMCPClassification(t *testing.T) {
	dir := t.TempDir()
	path := writeCodexRollout(t, dir, "rollout-mcp.jsonl",
		metaLine,
		`{"type":"response_item","payload":{"type":"function_call","name":"js","namespace":"mcp__cua_repl","call_id":"c1","arguments":"{\"code\":\"await cua.getState();\",\"title\":\"检查可用的 macOS 桌面控制\"}"}}`,
	)
	messages, _, err := ParseCodexMessages(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	call := firstToolCall(t, messages)
	if call.Kind != ToolMcp {
		t.Fatalf("kind = %q, want %q (namespace marks it as MCP)", call.Kind, ToolMcp)
	}
	if call.Title != "检查可用的 macOS 桌面控制" {
		t.Fatalf("title = %q, want the argument title", call.Title)
	}
	if call.Detail != "await cua.getState();" {
		t.Fatalf("detail = %q, want the argument code", call.Detail)
	}
}

// 没有 namespace 时，旧的 name 前缀判定仍然有效。
func TestCodexToolCallKeepsMCPNamePrefixDetection(t *testing.T) {
	dir := t.TempDir()
	path := writeCodexRollout(t, dir, "rollout-mcp-name.jsonl",
		metaLine,
		`{"type":"response_item","payload":{"type":"function_call","name":"mcp__cua_repl__js","call_id":"c1","arguments":"{}"}}`,
	)
	messages, _, err := ParseCodexMessages(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	call := firstToolCall(t, messages)
	if call.Kind != ToolMcp {
		t.Fatalf("kind = %q, want %q", call.Kind, ToolMcp)
	}
}

// custom_tool_call 的 input 不是 JSON，而是工具调用脚本文本，name 恒为
// "exec"。命令只存在于这段文本里，抠不出来的话工具行只剩一个没有信息量
// 的 "exec"。
func TestCodexCustomToolCallExtractsCommandFromScriptText(t *testing.T) {
	dir := t.TempDir()
	path := writeCodexRollout(t, dir, "rollout-custom.jsonl",
		metaLine,
		`{"type":"response_item","payload":{"type":"custom_tool_call","call_id":"c1","name":"exec","input":"text(await tools.exec_command({cmd:\"git status --short\",max_output_tokens:13000}));"}}`,
	)
	messages, _, err := ParseCodexMessages(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	call := firstToolCall(t, messages)
	if call.Title != "git status --short" {
		t.Fatalf("title = %q, want the command extracted from the script text", call.Title)
	}
	if call.Kind != ToolShell {
		t.Fatalf("kind = %q, want %q", call.Kind, ToolShell)
	}
}

// 脚本里是搜索类命令时要识别成 ToolSearch。
func TestCodexCustomToolCallDetectsSearchCommand(t *testing.T) {
	dir := t.TempDir()
	path := writeCodexRollout(t, dir, "rollout-custom-search.jsonl",
		metaLine,
		`{"type":"response_item","payload":{"type":"custom_tool_call","call_id":"c1","name":"exec","input":"text(await tools.exec_command({cmd:\"rg --files /tmp\"}));"}}`,
	)
	messages, _, err := ParseCodexMessages(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	call := firstToolCall(t, messages)
	if call.Title != "rg --files /tmp" {
		t.Fatalf("title = %q", call.Title)
	}
	if call.Kind != ToolSearch {
		t.Fatalf("kind = %q, want %q", call.Kind, ToolSearch)
	}
}

// 没有 cmd 的调用（write_stdin 之类）退回被调工具名，而不是干巴巴的 exec。
func TestCodexCustomToolCallFallsBackToCalledToolName(t *testing.T) {
	dir := t.TempDir()
	path := writeCodexRollout(t, dir, "rollout-custom-write.jsonl",
		metaLine,
		`{"type":"response_item","payload":{"type":"custom_tool_call","call_id":"c1","name":"exec","input":"text(await tools.write_stdin({session_id:123,chars:\"\\n\"}));"}}`,
	)
	messages, _, err := ParseCodexMessages(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	call := firstToolCall(t, messages)
	if call.Title != "write_stdin" {
		t.Fatalf("title = %q, want the called tool name", call.Title)
	}
}

// 一次调用里有多条命令时，标题给出第一条并标注还有几条。
func TestCodexCustomToolCallSummarizesMultipleCommands(t *testing.T) {
	dir := t.TempDir()
	path := writeCodexRollout(t, dir, "rollout-custom-multi.jsonl",
		metaLine,
		`{"type":"response_item","payload":{"type":"custom_tool_call","call_id":"c1","name":"exec","input":"const r=await Promise.allSettled([tools.exec_command({cmd:\"git status\"}),tools.exec_command({cmd:\"git diff\"})]);"}}`,
	)
	messages, _, err := ParseCodexMessages(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	call := firstToolCall(t, messages)
	if !strings.Contains(call.Title, "git status") {
		t.Fatalf("title = %q, want the first command", call.Title)
	}
	if !strings.Contains(call.Title, "+1") {
		t.Fatalf("title = %q, want the extra-command count", call.Title)
	}
}
