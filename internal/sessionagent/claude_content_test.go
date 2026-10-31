package sessionagent

import (
	"strings"
	"testing"
)

// Claude 工具输出与图片块的解析回归。
//
// Claude 把工具输出写在 content 字段（不是 text），可以是字符串，也可以是
// [{type:text,text}] 内容项数组；图片块的载荷在 source 里（base64 或文件
// 路径）。旧实现只读 c.Text，两种形态都取不到：工具输出在界面上完全不
// 可达，粘贴的截图也只剩 alt 文本。

// claudeToolResult 取第一条工具结果块。
func claudeToolResult(t *testing.T, messages []SessionMessage) *ToolResultBlock {
	t.Helper()
	for _, msg := range messages {
		for _, block := range msg.Blocks {
			if block.Type == BlockToolResult && block.ToolResult != nil {
				return block.ToolResult
			}
		}
	}
	t.Fatal("no tool result block parsed")
	return nil
}

// claudeImage 取第一张图片块。
func claudeImage(t *testing.T, messages []SessionMessage) *ImageRef {
	t.Helper()
	for _, msg := range messages {
		for _, block := range msg.Blocks {
			if block.Type == BlockImage && block.Image != nil {
				return block.Image
			}
		}
	}
	t.Fatal("no image block parsed")
	return nil
}

// 工具输出写在 content 字符串里时，正文必须能取到。
func TestClaudeToolResultReadsStringContent(t *testing.T) {
	dir := t.TempDir()
	path := writeClaudeFile(t, dir, "ses-res-string.jsonl",
		`{"type":"user","sessionId":"ses-r1","message":{"role":"user","content":[{"type":"text","text":"运行测试"}]}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"bash","input":"{\"command\":\"go test\"}"}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok\nall passed"}]}}`,
	)
	messages, _, err := ParseClaudeMessages(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	result := claudeToolResult(t, messages)
	if result.CallID != "t1" {
		t.Fatalf("callID = %q", result.CallID)
	}
	if !strings.Contains(result.Preview, "all passed") {
		t.Fatalf("preview = %q, want the tool output body", result.Preview)
	}
	if result.TotalLen == 0 {
		t.Fatal("totalLen must reflect the tool output body")
	}
}

// 工具输出写成内容项数组时，正文同样要能取到。
func TestClaudeToolResultReadsArrayContent(t *testing.T) {
	dir := t.TempDir()
	path := writeClaudeFile(t, dir, "ses-res-array.jsonl",
		`{"type":"user","sessionId":"ses-r2","message":{"role":"user","content":[{"type":"text","text":"运行测试"}]}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"bash","input":"{\"command\":\"go test\"}"}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"first line"},{"type":"text","text":"second line"}]}]}}`,
	)
	messages, _, err := ParseClaudeMessages(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	result := claudeToolResult(t, messages)
	if !strings.Contains(result.Preview, "first line") || !strings.Contains(result.Preview, "second line") {
		t.Fatalf("preview = %q, want both content items", result.Preview)
	}
}

// base64 图片块必须产出内联引用（正文在会话文件里，没有本机路径）。
func TestClaudeImageReadsBase64Source(t *testing.T) {
	dir := t.TempDir()
	path := writeClaudeFile(t, dir, "ses-img.jsonl",
		`{"type":"user","sessionId":"ses-i1","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"aGVsbG8="}}]}}`,
	)
	messages, _, err := ParseClaudeMessages(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	image := claudeImage(t, messages)
	if image.Source != ImageInline {
		t.Fatalf("source = %q, want %q", image.Source, ImageInline)
	}
	if image.MediaType != "image/png" {
		t.Fatalf("mediaType = %q", image.MediaType)
	}
	if image.Content == nil {
		t.Fatal("inline image must carry a content reference")
	}
	if image.Content.Kind != ContentJSONL {
		t.Fatalf("content kind = %q, want %q", image.Content.Kind, ContentJSONL)
	}
	if !strings.Contains(image.Content.Pointer, "/source/data") {
		t.Fatalf("pointer = %q, want it to point at the base64 payload", image.Content.Pointer)
	}
}

// file 形态的图片块必须产出本机路径。
func TestClaudeImageReadsFileSource(t *testing.T) {
	dir := t.TempDir()
	path := writeClaudeFile(t, dir, "ses-img-file.jsonl",
		`{"type":"user","sessionId":"ses-i2","message":{"role":"user","content":[{"type":"image","source":{"type":"file","path":"/tmp/shot.png"}}]}}`,
	)
	messages, _, err := ParseClaudeMessages(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	image := claudeImage(t, messages)
	if image.Source != ImageLocalFile {
		t.Fatalf("source = %q, want %q", image.Source, ImageLocalFile)
	}
	if image.Path != "/tmp/shot.png" {
		t.Fatalf("path = %q", image.Path)
	}
}

// 内联图片的引用必须真的能回源取到 base64（指针要落在行内正确位置）。
func TestClaudeInlineImageContentIsResolvable(t *testing.T) {
	dir := t.TempDir()
	path := writeClaudeFile(t, dir, "ses-img-resolve.jsonl",
		`{"type":"user","sessionId":"ses-i3","message":{"role":"user","content":[{"type":"text","text":"看这个"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"aGVsbG8="}}]}}`,
	)
	messages, _, err := ParseClaudeMessages(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	image := claudeImage(t, messages)
	if image.Content == nil {
		t.Fatal("inline image must carry a content reference")
	}
	full, err := resolveContentFull(path, *image.Content)
	if err != nil {
		t.Fatalf("resolve inline image: %v", err)
	}
	if full != "aGVsbG8=" {
		t.Fatalf("resolved payload = %q, want the base64 body", full)
	}
}
