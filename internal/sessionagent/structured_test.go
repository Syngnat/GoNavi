package sessionagent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 子 Agent 的结构化结论在解析阶段就要拆好：浏览端只负责渲染，不做 JSON 识别。

func TestSplitStructuredBodyPicksLongestStringAsProse(t *testing.T) {
	cases := []struct {
		name          string
		body          string
		wantProse     string
		wantProseKey  string
		wantFieldKeys []string
	}{
		{
			name: "审批结论：rationale 是正文",
			body: `{"outcome":"allow","rationale":"用户请求更新项目，且 AGENTS.md 明确授权自动执行仅快进 git pull。","risk_level":"medium","user_authorization":"high"}`,
			wantProse: "用户请求更新项目，且 AGENTS.md 明确授权自动执行仅快进 git pull。",
			wantProseKey:  "rationale",
			wantFieldKeys: []string{"outcome", "risk_level", "user_authorization"},
		},
		{
			name: "审查结论：summary 是正文",
			body: `{"acceptance":[],"findings":[],"summary":"审查被环境能力阻塞：会话仅提供协作等待相关工具。","verdict":"blocked","verification":[]}`,
			wantProse: "审查被环境能力阻塞：会话仅提供协作等待相关工具。",
			wantProseKey:  "summary",
			wantFieldKeys: []string{"acceptance", "findings", "verdict", "verification"},
		},
		{
			name: "交付结论：summary 是正文",
			body: `{"blockers":[],"changedFiles":[],"summary":"我先读取项目目标、待办和 CLI 相关源码。","verification":[]}`,
			wantProse: "我先读取项目目标、待办和 CLI 相关源码。",
			wantProseKey:  "summary",
			wantFieldKeys: []string{"blockers", "changedFiles", "verification"},
		},
		{
			name: "纯枚举结论：唯一字段就是正文",
			body: `{"outcome":"allow"}`,
			wantProse: "allow",
			wantProseKey:  "outcome",
			wantFieldKeys: nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			view := splitStructuredBody(tc.body)
			if view == nil {
				t.Fatal("must be recognised as a structured body")
			}
			if view.Prose != tc.wantProse {
				t.Fatalf("prose = %q, want %q", view.Prose, tc.wantProse)
			}
			if view.ProseField != tc.wantProseKey {
				t.Fatalf("prose field = %q, want %q", view.ProseField, tc.wantProseKey)
			}
			var keys []string
			for _, field := range view.Fields {
				keys = append(keys, field.Key)
			}
			if strings.Join(keys, ",") != strings.Join(tc.wantFieldKeys, ",") {
				t.Fatalf("field keys = %v, want %v", keys, tc.wantFieldKeys)
			}
		})
	}
}

func TestSplitStructuredBodyDescribesFieldKinds(t *testing.T) {
	view := splitStructuredBody(`{"summary":"结论。","verdict":"blocked","acceptance":[{"criterion":"x"}],"evidence":{"file":"a.go"}}`)
	if view == nil {
		t.Fatal("must be recognised as a structured body")
	}
	byKey := map[string]StructuredField{}
	for _, field := range view.Fields {
		byKey[field.Key] = field
	}
	if got := byKey["verdict"]; got.Kind != structuredKindScalar || got.Value != "blocked" {
		t.Fatalf("verdict field = %+v", got)
	}
	if got := byKey["acceptance"]; got.Kind != structuredKindArray || got.Count != 1 || !strings.Contains(got.Detail, "criterion") {
		t.Fatalf("acceptance field = %+v", got)
	}
	if got := byKey["evidence"]; got.Kind != structuredKindObject || got.Count != 1 || !strings.Contains(got.Detail, "a.go") {
		t.Fatalf("evidence field = %+v", got)
	}
}

func TestSplitStructuredBodyKeepsOrdinaryContent(t *testing.T) {
	cases := map[string]string{
		"普通正文":        "这是一段普通正文，不该被当成 JSON。",
		"工具原始输出":     `{"port":8080}`,
		"空对象":          `{}`,
		"顶层数组":         `["a","b"]`,
		"坏 JSON":        `{"summary": `,
		"嵌在正文里的 JSON":  "结果如下：{\"a\":1}",
		"空白":            "   ",
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			if view := splitStructuredBody(body); view != nil {
				t.Fatalf("must stay plain, got %+v", view)
			}
		})
	}
}

// 注入内容是工具塞给模型的上下文，不是给人看的结论，不做结构化拆解。
func TestSplitStructuredBodySkipsInjectedContent(t *testing.T) {
	if view := structuredBodyOf(`{"outcome":"allow"}`, true); view != nil {
		t.Fatalf("injected content must stay plain, got %+v", view)
	}
}

// 端到端：真实会话里的结构化结论消息带上 Structured 拆解。
func TestParseCodexMessagesMarksStructuredConclusion(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rollout-structured.jsonl")
	line := `{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"{\"outcome\":\"allow\",\"rationale\":\"用户明确授权，仅快进拉取，不改写历史。\",\"risk_level\":\"low\"}"}]}}`
	if err := os.WriteFile(path, []byte(line+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	messages, _, err := ParseCodexMessages(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	var found *StructuredBody
	for _, msg := range messages {
		if msg.Structured != nil {
			found = msg.Structured
		}
	}
	if found == nil {
		t.Fatal("structured conclusion must be marked")
	}
	if found.ProseField != "rationale" {
		t.Fatalf("prose field = %q", found.ProseField)
	}
	if !strings.Contains(found.Prose, "仅快进拉取") {
		t.Fatalf("prose = %q", found.Prose)
	}
	// 原始正文仍留在 Content 里，导出与搜索不受影响。
	for _, msg := range messages {
		if msg.Structured != nil && !strings.Contains(msg.Content, "\"rationale\"") {
			t.Fatalf("original content must be preserved, got %q", msg.Content)
		}
	}
}
