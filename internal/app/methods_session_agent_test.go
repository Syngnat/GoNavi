package app

import (
	"os"
	"path/filepath"
	"testing"

	"GoNavi-Wails/internal/sessionagent"
)

// 绑定层回归：sessionAgentService 的成功路径必须显式置启用集。
//
// Service.Enabled 为 nil 时 isEnabled 视为「全部启用」，而未添加的工具
// 目录为空串会被解析成默认家目录（~/.codex、~/.claude）——没添加的智能体
// 照样被扫描，删除链路也照样可达。域层的 fix_regression_test 只直接调
// SetEnabled()，走不到绑定层这个构造路径，所以这里补一条绑定层回归。
func TestSessionAgentServiceEnablesOnlyAddedAgents(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("GONAVI_DATA_ROOT", t.TempDir())

	// 未添加的 Codex：造一条落在默认目录里的会话记录。
	sessions := filepath.Join(home, ".codex", "sessions")
	if err := os.MkdirAll(sessions, 0o700); err != nil {
		t.Fatal(err)
	}
	metaLine := `{"type":"session_meta","payload":{"id":"th-1","cwd":"C:/work/demo","timestamp":1760000000}}`
	rollout := filepath.Join(sessions, "rollout-2026-01-01T00-00-00-11111111-2222-3333-4444-555555555555.jsonl")
	if err := os.WriteFile(rollout, []byte(metaLine+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	app := &App{}
	if _, err := app.AddAgentIntegration("claude", filepath.Join(home, ".claude"), ""); err != nil {
		t.Fatalf("add: %v", err)
	}

	service := app.sessionAgentService()
	if service.Enabled == nil {
		t.Fatal("Enabled must be set on the success path (nil means every provider is enabled)")
	}
	if service.Enabled[sessionagent.ProviderCodex] {
		t.Fatal("codex must stay disabled when it was not added")
	}
	if !service.Enabled[sessionagent.ProviderClaude] {
		t.Fatal("claude must be enabled after being added")
	}

	// 列表里不得出现未添加的 codex 会话。
	result := app.SessionAgentList("", "")
	if !result.Success {
		t.Fatalf("list failed: %s", result.Message)
	}
	data, _ := result.Data.(map[string]any)
	items, _ := data["items"].([]sessionagent.SessionMeta)
	for _, item := range items {
		if item.ProviderID == sessionagent.ProviderCodex {
			t.Fatalf("unadded provider leaked into the list: %+v", item)
		}
	}
}

// 绑定层回归：删除链路同样只对已添加的工具可达。
func TestSessionAgentDeleteRejectsUnaddedProvider(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("GONAVI_DATA_ROOT", t.TempDir())

	sessions := filepath.Join(home, ".codex", "sessions")
	if err := os.MkdirAll(sessions, 0o700); err != nil {
		t.Fatal(err)
	}
	metaLine := `{"type":"session_meta","payload":{"id":"th-1","cwd":"C:/work/demo","timestamp":1760000000}}`
	rollout := filepath.Join(sessions, "rollout-2026-01-01T00-00-00-11111111-2222-3333-4444-555555555555.jsonl")
	if err := os.WriteFile(rollout, []byte(metaLine+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	app := &App{}
	if _, err := app.AddAgentIntegration("claude", filepath.Join(home, ".claude"), ""); err != nil {
		t.Fatalf("add: %v", err)
	}

	if err := app.sessionAgentService().Delete(sessionagent.ProviderCodex, rollout, "th-1"); err == nil {
		t.Fatal("delete must be rejected for a provider that was not added")
	}
	if _, err := os.Stat(rollout); err != nil {
		t.Fatalf("rollout file must survive a rejected delete: %v", err)
	}
}
