package app

import (
	"path/filepath"
	"testing"
)

// 智能体集成配置的读写：添加、更新、移除都只碰 agents.json。

func TestAgentIntegrationAddUpdateRemove(t *testing.T) {
	t.Setenv("GONAVI_DATA_ROOT", t.TempDir())
	app := &App{}

	added, err := app.AddAgentIntegration("codex", "C:/Users/me/.codex", "")
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	if added.DataDir == "" {
		t.Fatal("data dir must be persisted")
	}
	if added.DisplayName != "ChatGPT" {
		t.Fatalf("display name = %q, want ChatGPT", added.DisplayName)
	}

	// 更新：数据目录与显示名同时改。
	updated, err := app.UpdateAgentIntegration("codex", "C:/Users/me/.codex-2", "我的 Codex")
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	wantDir, err := filepath.Abs("C:/Users/me/.codex-2")
	if err != nil {
		t.Fatalf("abs: %v", err)
	}
	if updated.DataDir != wantDir {
		t.Fatalf("data dir = %q, want %q", updated.DataDir, wantDir)
	}
	if updated.DisplayName != "我的 Codex" {
		t.Fatalf("display name = %q", updated.DisplayName)
	}
	listed, err := app.ListAgentIntegrations()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(listed) != 1 || listed[0].DataDir != wantDir {
		t.Fatalf("listed = %+v", listed)
	}
}

func TestUpdateAgentIntegrationKeepsEmptyFields(t *testing.T) {
	t.Setenv("GONAVI_DATA_ROOT", t.TempDir())
	app := &App{}
	added, err := app.AddAgentIntegration("codex", "C:/Users/me/.codex", "")
	if err != nil {
		t.Fatalf("add: %v", err)
	}

	// 空参数表示保留原值（前端只改其中一个字段时用得到）。
	updated, err := app.UpdateAgentIntegration("codex", "", "")
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.DataDir != added.DataDir {
		t.Fatalf("data dir = %q, want %q", updated.DataDir, added.DataDir)
	}
	if updated.DisplayName != added.DisplayName {
		t.Fatalf("display name = %q, want %q", updated.DisplayName, added.DisplayName)
	}
}

func TestUpdateAgentIntegrationRejectsUnknownKind(t *testing.T) {
	t.Setenv("GONAVI_DATA_ROOT", t.TempDir())
	app := &App{}
	if _, err := app.AddAgentIntegration("codex", "C:/Users/me/.codex", ""); err != nil {
		t.Fatalf("add: %v", err)
	}
	if _, err := app.UpdateAgentIntegration("claude", "C:/Users/me/.claude", ""); err == nil {
		t.Fatal("unknown kind must be rejected")
	}
	// 失败不得影响既有配置。
	listed, err := app.ListAgentIntegrations()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(listed) != 1 || listed[0].Kind != "codex" {
		t.Fatalf("listed = %+v", listed)
	}
}
