package sessionagent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// P0 回归：解析产出的 ContentRef 必须携带有效字节区间，ResolveContent
// 端到端可取到全文（此前 ref 只写 pointer，length=0 导致展开全文必失败）。
func TestContentRefCarriesSpanAndResolves(t *testing.T) {
	dir := t.TempDir()
	// 构造输出超过 1200 字符的会话，触发 Full 引用。
	longOutput := strings.Repeat("甲", 2000)
	path := writeRollout(t, dir, "rollout-ref.jsonl",
		metaLine,
		`{"type":"response_item","payload":{"type":"function_call","name":"exec","call_id":"c1","arguments":"{\"cmd\":\"big\"}"}}`,
		`{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"`+longOutput+`"}}`,
	)
	messages, _, err := ParseCodexMessages(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	var ref *ContentRef
	for _, msg := range messages {
		for _, block := range msg.Blocks {
			if block.Type == BlockToolResult && block.ToolResult != nil && block.ToolResult.Truncated {
				ref = block.ToolResult.Full
			}
		}
	}
	if ref == nil {
		t.Fatal("truncated result must carry Full ref")
	}
	if ref.Length <= 0 {
		t.Fatalf("ref must carry byte span: %+v", ref)
	}
	// 端到端：按 ref 取全文。
	content, err := ResolveContent(path, *ref, 0, MaxPageChars)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if content.Text != longOutput {
		t.Fatalf("resolved text mismatch: len=%d", len([]rune(content.Text)))
	}
}

// CRLF 行尾文件：行字节定位仍需正确（Length 含 \r\n 两字节时读取端
// 需剥离；offset 序列不得漂移）。
func TestContentRefOnCRLFFile(t *testing.T) {
	dir := t.TempDir()
	line1 := `{"payload":{"output":"first"}}`
	line2 := `{"payload":{"output":"second"}}`
	content := line1 + "\r\n" + line2 + "\r\n"
	path := filepath.Join(dir, "crlf.jsonl")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	// 手工构造第二行的正确区间（CRLF：len+2）。
	ref := ContentRef{
		Kind:    ContentJSONL,
		Offset:  int64(len(line1) + 2),
		Length:  uint32(len(line2) + 2),
		Pointer: "/payload/output",
	}
	resolved, err := ResolveContent(path, ref, 0, MaxPageChars)
	if err != nil {
		t.Fatalf("resolve CRLF: %v", err)
	}
	if resolved.Text != "second" {
		t.Fatalf("text = %q, want second", resolved.Text)
	}
}

// P1 回归：Claude 用户消息 content 为纯字符串时不丢消息。
func TestClaudeStringContentNotDropped(t *testing.T) {
	dir := t.TempDir()
	path := writeClaudeFile(t, dir, "ses-str.jsonl",
		`{"type":"user","sessionId":"ses-str","cwd":"C:/proj","message":{"role":"user","content":"帮我看看这个构建为什么挂了"}}`,
		`{"type":"assistant","sessionId":"ses-str","message":{"role":"assistant","content":[{"type":"text","text":"好的，我来看。"}]}}`,
	)
	meta, err := parseClaudeSessionMeta(path)
	if err != nil {
		t.Fatalf("parse meta: %v", err)
	}
	if !strings.Contains(meta.Title, "帮我看看这个构建为什么挂了") {
		t.Fatalf("title = %q, want real question (string content)", meta.Title)
	}
	messages, _, err := ParseClaudeMessages(path)
	if err != nil {
		t.Fatalf("parse messages: %v", err)
	}
	var sawUser bool
	for _, msg := range messages {
		if msg.Role == RoleUser && strings.Contains(msg.Content, "帮我看看") {
			sawUser = true
		}
	}
	if !sawUser {
		t.Fatalf("string-content user message dropped: %+v", messages)
	}
}

// FileParseCache 并发 Scan 不产生数据竞争（-race 下验证）。
func TestFileParseCacheConcurrentScan(t *testing.T) {
	dir := t.TempDir()
	var paths []string
	for i := 0; i < 20; i++ {
		paths = append(paths, writeRollout(t, dir, "rollout-c"+string(rune('a'+i))+".jsonl", metaLine))
	}
	cache := NewFileParseCache()
	parse := func(string) (*SessionMeta, error) {
		return &SessionMeta{SessionID: "x"}, nil
	}
	done := make(chan struct{})
	for i := 0; i < 4; i++ {
		go func() {
			defer func() { done <- struct{}{} }()
			cache.Scan(paths, parse)
		}()
	}
	for i := 0; i < 4; i++ {
		<-done
	}
}

// 绑定层防御回归：配置不可读时绑定层调用 SetEnabled() 显式置空启用集，
// List 不得放行默认目录扫描（Enabled=nil 的宽松语义只允许测试构造使用）。
func TestSetEnabledEmptyBlocksDefaultScan(t *testing.T) {
	codexDir := t.TempDir()
	sessionsDir := filepath.Join(codexDir, "sessions")
	if err := os.MkdirAll(sessionsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeRollout(t, sessionsDir, "rollout-e.jsonl", metaLine)
	svc := &Service{CodexDir: codexDir, ClaudeDir: filepath.Join(t.TempDir(), "absent")}
	if len(svc.List("", "")) != 1 {
		t.Fatal("precondition: nil Enabled scans by default")
	}
	svc.SetEnabled()
	if items := svc.List("", ""); len(items) != 0 {
		t.Fatalf("SetEnabled() must block scan, got %d items", len(items))
	}
	if svc.isEnabled(ProviderCodex) || svc.isEnabled(ProviderClaude) {
		t.Fatal("no provider may stay enabled after SetEnabled()")
	}
}

// 绑定层防御回归的领域侧约定：List 允许返回 nil slice（零结果），由
// 绑定层 SessionAgentList 归一为 [] 再下发（Go nil 序列化为 JSON null，
// 前端按数组消费会崩）。这里锁定「nil 或空均可、len 必为 0」的契约，
// 防止未来有人把哨兵值混进空结果。
func TestListEmptyResultContract(t *testing.T) {
	svc := &Service{}
	svc.SetEnabled()
	items := svc.List("", "")
	if len(items) != 0 {
		t.Fatalf("empty service must list 0 items, got %d", len(items))
	}
}
