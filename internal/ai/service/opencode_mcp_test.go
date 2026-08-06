package aiservice

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestOpenCodeConfigPathUsesXDGAndEffectiveFilePriority(t *testing.T) {
	xdgRoot := filepath.Join(t.TempDir(), "xdg config")
	t.Setenv("XDG_CONFIG_HOME", xdgRoot)
	configDir := filepath.Join(xdgRoot, "opencode")
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}

	assertPath := func(want string) {
		t.Helper()
		got, err := openCodeConfigPathFunc()
		if err != nil {
			t.Fatalf("openCodeConfigPathFunc returned error: %v", err)
		}
		if got != want {
			t.Fatalf("expected OpenCode config path %q, got %q", want, got)
		}
	}

	// OpenCode's public docs and `opencode mcp add` use opencode.json when
	// there is no existing user-level config.
	assertPath(filepath.Join(configDir, "opencode.json"))

	legacyPath := filepath.Join(configDir, "config.json")
	if err := os.WriteFile(legacyPath, []byte("{}\n"), 0o644); err != nil {
		t.Fatalf("WriteFile legacy config returned error: %v", err)
	}
	assertPath(legacyPath)

	jsonPath := filepath.Join(configDir, "opencode.json")
	if err := os.WriteFile(jsonPath, []byte("{}\n"), 0o644); err != nil {
		t.Fatalf("WriteFile JSON config returned error: %v", err)
	}
	assertPath(jsonPath)

	jsoncPath := filepath.Join(configDir, "opencode.jsonc")
	if err := os.WriteFile(jsoncPath, []byte("{}\n"), 0o644); err != nil {
		t.Fatalf("WriteFile JSONC config returned error: %v", err)
	}
	assertPath(jsoncPath)
}

func TestOpenCodeConfigPathFallsBackToHomeDotConfig(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)

	got, err := openCodeConfigPathFunc()
	if err != nil {
		t.Fatalf("openCodeConfigPathFunc returned error: %v", err)
	}
	want := filepath.Join(homeDir, ".config", "opencode", "opencode.json")
	if got != want {
		t.Fatalf("expected OpenCode home config path %q, got %q", want, got)
	}
}

func TestUpsertOpenCodeMCPServerConfigPreservesJSONCAndIsIdempotent(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "opencode.jsonc")
	initial := `{
  // Keep this user comment.
  "$schema": "https://opencode.ai/config.json",
  "documentation": "https://example.com/a//b/*literal-text*/",
  "mcp": {
    "memory": {
      "type": "local",
      "command": ["memory-server"],
    },
  },
}
`
	if err := os.WriteFile(configPath, []byte(initial), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	command := `C:\Program Files\GoNavi\GoNavi.exe`
	enabled := true
	serverConfig := openCodeMCPServerConfig{
		Type:    "local",
		Command: []string{command, "mcp-server"},
		Enabled: &enabled,
	}
	if err := upsertOpenCodeMCPServerConfig(configPath, gonaviMCPServerID, serverConfig); err != nil {
		t.Fatalf("upsertOpenCodeMCPServerConfig returned error: %v", err)
	}

	first, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	text := string(first)
	for _, preserved := range []string{
		"// Keep this user comment.",
		`"documentation": "https://example.com/a//b/*literal-text*/"`,
		`"memory"`,
	} {
		if !strings.Contains(text, preserved) {
			t.Fatalf("expected JSONC content %q to remain, got:\n%s", preserved, text)
		}
	}
	if !strings.Contains(text, `"enabled": true`) {
		t.Fatalf("expected installed OpenCode MCP entry to be explicitly enabled, got:\n%s", text)
	}
	if !strings.Contains(text, `C:\\Program Files\\GoNavi\\GoNavi.exe`) {
		t.Fatalf("expected Windows path to be JSON-escaped exactly once, got:\n%s", text)
	}

	got, found, err := readOpenCodeMCPServerConfig(configPath, gonaviMCPServerID)
	if err != nil {
		t.Fatalf("readOpenCodeMCPServerConfig returned error: %v", err)
	}
	if !found {
		t.Fatal("expected OpenCode gonavi MCP entry to be found")
	}
	if got.Type != "local" || !reflect.DeepEqual(got.Command, serverConfig.Command) {
		t.Fatalf("unexpected OpenCode MCP config: %#v", got)
	}

	if err := upsertOpenCodeMCPServerConfig(configPath, gonaviMCPServerID, serverConfig); err != nil {
		t.Fatalf("second upsertOpenCodeMCPServerConfig returned error: %v", err)
	}
	second, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile after second upsert returned error: %v", err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("expected idempotent OpenCode config upsert; second write changed the file\nfirst:\n%s\nsecond:\n%s", first, second)
	}
}

func TestUpsertOpenCodeMCPServerConfigUpdatesManagedEntryAndKeepsOtherSettings(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "opencode.json")
	initial := `{
  "model": "openai/gpt-5",
  "mcp": {
    "memory": {"type": "local", "command": ["memory-server"]},
    "gonavi": {
      "type": "local",
      "command": ["old-gonavi.exe", "mcp-server"],
      "enabled": false
    }
  }
}
`
	if err := os.WriteFile(configPath, []byte(initial), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	command := `D:\Apps\GoNavi\GoNavi.exe`
	enabled := true
	if err := upsertOpenCodeMCPServerConfig(configPath, gonaviMCPServerID, openCodeMCPServerConfig{
		Type:    "local",
		Command: []string{command, "mcp-server"},
		Enabled: &enabled,
	}); err != nil {
		t.Fatalf("upsertOpenCodeMCPServerConfig returned error: %v", err)
	}

	updated, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	text := string(updated)
	if !strings.Contains(text, `"model": "openai/gpt-5"`) || !strings.Contains(text, `"memory"`) {
		t.Fatalf("expected unrelated OpenCode settings to remain, got:\n%s", text)
	}
	if strings.Contains(text, "old-gonavi.exe") {
		t.Fatalf("expected stale managed command to be replaced, got:\n%s", text)
	}
	if !strings.Contains(text, `"enabled": true`) {
		t.Fatalf("expected an explicit install action to enable gonavi, got:\n%s", text)
	}
}

func TestUpsertOpenCodeMCPServerConfigPreservesConfigSymlink(t *testing.T) {
	tempDir := t.TempDir()
	targetPath := filepath.Join(tempDir, "shared", "opencode.jsonc")
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}
	if err := os.WriteFile(targetPath, []byte("{}\n"), 0o640); err != nil {
		t.Fatalf("WriteFile target returned error: %v", err)
	}
	targetInfoBefore, err := os.Stat(targetPath)
	if err != nil {
		t.Fatalf("Stat target before upsert returned error: %v", err)
	}
	targetModeBefore := targetInfoBefore.Mode().Perm()
	configPath := filepath.Join(tempDir, "opencode.jsonc")
	if err := os.Symlink(targetPath, configPath); err != nil {
		t.Skipf("Symlink is unavailable: %v", err)
	}

	enabled := true
	if err := upsertOpenCodeMCPServerConfig(configPath, gonaviMCPServerID, openCodeMCPServerConfig{
		Type:    "local",
		Command: []string{"GoNavi", "mcp-server"},
		Enabled: &enabled,
	}); err != nil {
		t.Fatalf("upsertOpenCodeMCPServerConfig returned error: %v", err)
	}
	if info, err := os.Lstat(configPath); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("expected config symlink to remain, info=%v err=%v", info, err)
	}
	if info, err := os.Stat(targetPath); err != nil || info.Mode().Perm() != targetModeBefore {
		t.Fatalf("expected target permissions %04o to remain, info=%v err=%v", targetModeBefore, info, err)
	}
	if _, found, err := readOpenCodeMCPServerConfig(targetPath, gonaviMCPServerID); err != nil || !found {
		t.Fatalf("expected linked target to contain OpenCode MCP config, found=%v err=%v", found, err)
	}
}

func TestUpsertOpenCodeMCPServerConfigReplacesRemoteOnlyFields(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "opencode.json")
	initial := `{
  "mcp": {
    "gonavi": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "headers": {"Authorization": "Bearer secret"},
      "oauth": false,
      "enabled": true
    }
  }
}
`
	if err := os.WriteFile(configPath, []byte(initial), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	enabled := true
	if err := upsertOpenCodeMCPServerConfig(configPath, gonaviMCPServerID, openCodeMCPServerConfig{
		Type:    "local",
		Command: []string{"GoNavi", "mcp-server"},
		Enabled: &enabled,
	}); err != nil {
		t.Fatalf("upsertOpenCodeMCPServerConfig returned error: %v", err)
	}

	root, err := readOpenCodeConfig(configPath, NewService().serviceText)
	if err != nil {
		t.Fatalf("readOpenCodeConfig returned error: %v", err)
	}
	mcpServers := root["mcp"].(map[string]any)
	gonavi := mcpServers[gonaviMCPServerID].(map[string]any)
	for _, remoteOnlyKey := range []string{"url", "headers", "oauth"} {
		if _, exists := gonavi[remoteOnlyKey]; exists {
			t.Fatalf("expected remote-only field %q to be removed, got %#v", remoteOnlyKey, gonavi)
		}
	}
	if gonavi["type"] != "local" || !reflect.DeepEqual(gonavi["command"], []any{"GoNavi", "mcp-server"}) {
		t.Fatalf("expected a valid local OpenCode MCP entry, got %#v", gonavi)
	}
}

func TestUpsertOpenCodeMCPServerConfigCleansMixedLocalEntry(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "opencode.jsonc")
	initial := `{
  "mcp": {
    "gonavi": {
      "type": "local",
      "command": ["old-gonavi", "mcp-server"],
      "url": "https://stale.example.com/mcp",
      "headers": {"X-Stale": "1"},
      "oauth": false,
      "environment": {"KEEP": "1"}
    }
  }
}
`
	if err := os.WriteFile(configPath, []byte(initial), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}
	enabled := true
	if err := upsertOpenCodeMCPServerConfig(configPath, gonaviMCPServerID, openCodeMCPServerConfig{
		Type:    "local",
		Command: []string{"GoNavi", "mcp-server"},
		Enabled: &enabled,
	}); err != nil {
		t.Fatalf("upsertOpenCodeMCPServerConfig returned error: %v", err)
	}
	root, err := readOpenCodeConfig(configPath, NewService().serviceText)
	if err != nil {
		t.Fatalf("readOpenCodeConfig returned error: %v", err)
	}
	gonavi := root["mcp"].(map[string]any)[gonaviMCPServerID].(map[string]any)
	for _, remoteOnlyKey := range []string{"url", "headers", "oauth"} {
		if _, exists := gonavi[remoteOnlyKey]; exists {
			t.Fatalf("expected remote-only field %q to be removed, got %#v", remoteOnlyKey, gonavi)
		}
	}
	environment := gonavi["environment"].(map[string]any)
	if environment["KEEP"] != "1" {
		t.Fatalf("expected local environment to remain, got %#v", environment)
	}
}

func TestOpenCodeStatusAndRepairUseMergedGlobalConfigLayers(t *testing.T) {
	originalConfigPathFunc := openCodeConfigPathFunc
	t.Cleanup(func() { openCodeConfigPathFunc = originalConfigPathFunc })

	tempDir := t.TempDir()
	configDir := filepath.Join(tempDir, ".config", "opencode")
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}
	lowerPath := filepath.Join(configDir, "opencode.json")
	higherPath := filepath.Join(configDir, "opencode.jsonc")
	oldCommand := filepath.Join(tempDir, "missing", "GoNavi.exe")
	currentCommand := filepath.Join(tempDir, "current", "GoNavi.exe")
	lowerConfig, err := json.Marshal(map[string]any{
		"mcp": map[string]any{
			gonaviMCPServerID: map[string]any{
				"type":    "local",
				"command": []string{oldCommand, "mcp-server"},
				"enabled": true,
			},
		},
	})
	if err != nil {
		t.Fatalf("Marshal lower config returned error: %v", err)
	}
	if err := os.WriteFile(lowerPath, lowerConfig, 0o644); err != nil {
		t.Fatalf("WriteFile lower config returned error: %v", err)
	}
	higherBefore := []byte("{\n  // Enabled-only overrides are valid OpenCode config layers.\n  \"model\": \"openai/gpt-5\",\n  \"mcp\": {\"gonavi\": {\"enabled\": false}},\n}\n")
	if err := os.WriteFile(higherPath, higherBefore, 0o644); err != nil {
		t.Fatalf("WriteFile higher config returned error: %v", err)
	}
	openCodeConfigPathFunc = func() (string, error) { return higherPath, nil }

	status := inspectOpenCodeMCPInstallStatus(currentCommand, []string{"mcp-server"}, nil)
	if !status.Installed || status.MatchesCurrent || status.ConfigPath != lowerPath {
		t.Fatalf("expected stale lower-layer OpenCode config to be detected, got %#v", status)
	}
	if err := repairOpenCodeMCPClientConfig(currentCommand, []string{"mcp-server"}, NewService().serviceText); err != nil {
		t.Fatalf("repairOpenCodeMCPClientConfig returned error: %v", err)
	}
	repaired, found, err := readOpenCodeMCPServerConfig(lowerPath, gonaviMCPServerID)
	if err != nil || !found || !reflect.DeepEqual(repaired.Command, []string{currentCommand, "mcp-server"}) {
		t.Fatalf("expected lower-layer MCP declaration to be repaired, config=%#v found=%v err=%v", repaired, found, err)
	}
	higherAfter, err := os.ReadFile(higherPath)
	if err != nil {
		t.Fatalf("ReadFile higher config returned error: %v", err)
	}
	if !reflect.DeepEqual(higherBefore, higherAfter) {
		t.Fatalf("expected unrelated higher layer to remain byte-for-byte unchanged\nbefore:\n%s\nafter:\n%s", higherBefore, higherAfter)
	}
	status = inspectOpenCodeMCPInstallStatus(currentCommand, []string{"mcp-server"}, nil)
	if !status.Installed || status.MatchesCurrent {
		t.Fatalf("expected repaired command to remain disabled by the higher layer, got %#v", status)
	}
	higherEnabled := []byte("{\n  \"model\": \"openai/gpt-5\",\n  \"mcp\": {\"gonavi\": {\"enabled\": true}},\n}\n")
	if err := os.WriteFile(higherPath, higherEnabled, 0o644); err != nil {
		t.Fatalf("WriteFile enabled higher config returned error: %v", err)
	}
	status = inspectOpenCodeMCPInstallStatus(currentCommand, []string{"mcp-server"}, nil)
	if !status.MatchesCurrent {
		t.Fatalf("expected enabled merged OpenCode status to match after repair, got %#v", status)
	}
}

func TestUpsertOpenCodeMCPServerConfigRejectsInvalidConfigWithoutChangingFile(t *testing.T) {
	cases := []struct {
		name    string
		content string
	}{
		{name: "invalid JSONC", content: `{"mcp":`},
		{name: "root is not object", content: `[]`},
		{name: "mcp is not object", content: `{"mcp": []}`},
		{name: "gonavi entry is not object", content: `{"mcp": {"gonavi": []}}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			configPath := filepath.Join(t.TempDir(), "opencode.jsonc")
			before := []byte(tc.content)
			if err := os.WriteFile(configPath, before, 0o644); err != nil {
				t.Fatalf("WriteFile returned error: %v", err)
			}

			err := upsertOpenCodeMCPServerConfig(configPath, gonaviMCPServerID, openCodeMCPServerConfig{
				Type:    "local",
				Command: []string{"GoNavi.exe", "mcp-server"},
			})
			if err == nil {
				t.Fatal("expected invalid OpenCode config to be rejected")
			}

			after, readErr := os.ReadFile(configPath)
			if readErr != nil {
				t.Fatalf("ReadFile returned error: %v", readErr)
			}
			if !reflect.DeepEqual(after, before) {
				t.Fatalf("invalid OpenCode config was modified\nbefore: %s\nafter: %s", before, after)
			}
		})
	}
}

func TestInspectOpenCodeMCPInstallStatusHonorsEnabledAndCommandShape(t *testing.T) {
	originalConfigPathFunc := openCodeConfigPathFunc
	originalCLIPathFunc := localCLICommandPathFunc
	t.Cleanup(func() {
		openCodeConfigPathFunc = originalConfigPathFunc
		localCLICommandPathFunc = originalCLIPathFunc
	})

	configPath := filepath.Join(t.TempDir(), "opencode.jsonc")
	openCodeConfigPathFunc = func() (string, error) { return configPath, nil }
	localCLICommandPathFunc = func(file string) (string, error) {
		if file != "opencode" {
			t.Fatalf("expected lookup for opencode, got %q", file)
		}
		return `C:\Users\demo\bin\opencode.exe`, nil
	}

	command := `C:\Program Files\GoNavi\GoNavi.exe`
	encodedCommand, err := json.Marshal(command)
	if err != nil {
		t.Fatalf("Marshal command returned error: %v", err)
	}
	cases := []struct {
		name        string
		entry       string
		wantMatch   bool
		wantCommand string
		wantArgs    []string
	}{
		{
			name:        "explicitly enabled",
			entry:       fmt.Sprintf(`{"type":"local","command":[%s,"mcp-server"],"enabled":true}`, encodedCommand),
			wantMatch:   true,
			wantCommand: command,
			wantArgs:    []string{"mcp-server"},
		},
		{
			name:        "enabled omitted defaults to enabled",
			entry:       fmt.Sprintf(`{"type":"local","command":[%s,"mcp-server"]}`, encodedCommand),
			wantMatch:   true,
			wantCommand: command,
			wantArgs:    []string{"mcp-server"},
		},
		{
			name:        "explicitly disabled",
			entry:       fmt.Sprintf(`{"type":"local","command":[%s,"mcp-server"],"enabled":false}`, encodedCommand),
			wantMatch:   false,
			wantCommand: command,
			wantArgs:    []string{"mcp-server"},
		},
		{
			name:        "command mismatch",
			entry:       `{"type":"local","command":["other-gonavi","mcp-server"],"enabled":true}`,
			wantMatch:   false,
			wantCommand: "other-gonavi",
			wantArgs:    []string{"mcp-server"},
		},
		{
			name:        "remote entry is not local install",
			entry:       `{"type":"remote","url":"https://example.com/mcp","enabled":true}`,
			wantMatch:   false,
			wantCommand: "",
			wantArgs:    nil,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			content := fmt.Sprintf(`{"mcp":{"gonavi":%s}}`, tc.entry)
			if err := os.WriteFile(configPath, []byte(content), 0o644); err != nil {
				t.Fatalf("WriteFile returned error: %v", err)
			}

			status := inspectOpenCodeMCPInstallStatus(command, []string{"mcp-server"}, nil)
			if status.Client != "opencode" || status.DisplayName != "OpenCode" || status.InstallMode != "auto" {
				t.Fatalf("unexpected OpenCode client identity: %#v", status)
			}
			if !status.ClientDetected || status.ClientCommand != "opencode" {
				t.Fatalf("expected OpenCode CLI detection to remain separate from config state: %#v", status)
			}
			if !status.Installed {
				t.Fatalf("expected gonavi entry to be reported as installed: %#v", status)
			}
			if status.MatchesCurrent != tc.wantMatch {
				t.Fatalf("expected MatchesCurrent=%v, got %#v", tc.wantMatch, status)
			}
			if status.Command != tc.wantCommand || !reflect.DeepEqual(status.Args, tc.wantArgs) {
				t.Fatalf("unexpected command projection: %#v", status)
			}
		})
	}
}

func TestAIInstallOpenCodeMCPWritesArgvAndIsIdempotent(t *testing.T) {
	originalConfigPathFunc := openCodeConfigPathFunc
	originalExecutablePathFunc := localMCPExecutablePathFunc
	t.Cleanup(func() {
		openCodeConfigPathFunc = originalConfigPathFunc
		localMCPExecutablePathFunc = originalExecutablePathFunc
	})

	configPath := filepath.Join(t.TempDir(), "nested", "opencode.json")
	command := `C:\Program Files\GoNavi\GoNavi.exe`
	openCodeConfigPathFunc = func() (string, error) { return configPath, nil }
	localMCPExecutablePathFunc = func() (string, error) { return command, nil }

	service := NewService()
	result, err := service.AIInstallOpenCodeMCP()
	if err != nil {
		t.Fatalf("AIInstallOpenCodeMCP returned error: %v", err)
	}
	if !result.Success || result.Client != "opencode" || result.ConfigPath != configPath || result.Command != command || !reflect.DeepEqual(result.Args, []string{"mcp-server"}) {
		t.Fatalf("unexpected OpenCode install result: %#v", result)
	}

	first, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	cfg, found, err := readOpenCodeMCPServerConfig(configPath, gonaviMCPServerID)
	if err != nil || !found {
		t.Fatalf("expected installed OpenCode config, found=%v err=%v", found, err)
	}
	if cfg.Type != "local" || !reflect.DeepEqual(cfg.Command, []string{command, "mcp-server"}) {
		t.Fatalf("expected OpenCode command to be stored as argv, got %#v", cfg)
	}
	if cfg.Enabled == nil || !*cfg.Enabled {
		t.Fatalf("expected OpenCode install to explicitly enable gonavi, got %#v", cfg.Enabled)
	}
	root, err := readOpenCodeConfig(configPath, service.serviceText)
	if err != nil {
		t.Fatalf("readOpenCodeConfig returned error: %v", err)
	}
	if root["$schema"] != "https://opencode.ai/config.json" {
		t.Fatalf("expected new OpenCode config to include the official schema, got %#v", root["$schema"])
	}

	if _, err := service.AIInstallOpenCodeMCP(); err != nil {
		t.Fatalf("second AIInstallOpenCodeMCP returned error: %v", err)
	}
	second, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile after second install returned error: %v", err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("expected repeated OpenCode install to be idempotent\nfirst:\n%s\nsecond:\n%s", first, second)
	}
}

func TestRepairOpenCodeMCPClientConfigUpdatesOnlyManagedCommand(t *testing.T) {
	originalConfigPathFunc := openCodeConfigPathFunc
	t.Cleanup(func() { openCodeConfigPathFunc = originalConfigPathFunc })

	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "opencode.jsonc")
	oldCommand := filepath.Join(tempDir, "missing", "GoNavi.exe")
	currentCommand := filepath.Join(tempDir, "current", "GoNavi.exe")
	oldJSON, err := json.Marshal(oldCommand)
	if err != nil {
		t.Fatalf("Marshal old command returned error: %v", err)
	}
	initial := fmt.Sprintf(`{
  // Preserve repair-time comments.
  "mcp": {
    "memory": {"type": "local", "command": ["memory-server"]},
    "gonavi": {
      "type": "local",
      "command": [%s, "mcp-server"],
      "enabled": false,
      "environment": {"KEEP": "1"},
    },
  },
}
`, oldJSON)
	if err := os.WriteFile(configPath, []byte(initial), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}
	openCodeConfigPathFunc = func() (string, error) { return configPath, nil }

	service := NewService()
	if err := repairOpenCodeMCPClientConfig(currentCommand, []string{"mcp-server"}, service.serviceText); err != nil {
		t.Fatalf("repairOpenCodeMCPClientConfig returned error: %v", err)
	}

	updated, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	text := string(updated)
	for _, preserved := range []string{
		"// Preserve repair-time comments.",
		`"memory"`,
		`"KEEP"`,
	} {
		if !strings.Contains(text, preserved) {
			t.Fatalf("expected repair to preserve %q, got:\n%s", preserved, text)
		}
	}

	cfg, found, err := readOpenCodeMCPServerConfig(configPath, gonaviMCPServerID)
	if err != nil || !found {
		t.Fatalf("expected repaired OpenCode config, found=%v err=%v", found, err)
	}
	if !reflect.DeepEqual(cfg.Command, []string{currentCommand, "mcp-server"}) {
		t.Fatalf("expected stale managed command to be repaired, got %#v", cfg.Command)
	}
	if cfg.Enabled == nil || *cfg.Enabled {
		t.Fatalf("expected repair to preserve enabled=false, got %#v", cfg.Enabled)
	}
	root, err := readOpenCodeConfig(configPath, service.serviceText)
	if err != nil {
		t.Fatalf("readOpenCodeConfig returned error: %v", err)
	}
	mcpServers, ok := root["mcp"].(map[string]any)
	if !ok {
		t.Fatalf("expected parsed mcp object, got %#v", root["mcp"])
	}
	gonavi, ok := mcpServers[gonaviMCPServerID].(map[string]any)
	if !ok {
		t.Fatalf("expected parsed gonavi object, got %#v", mcpServers[gonaviMCPServerID])
	}
	environment, ok := gonavi["environment"].(map[string]any)
	if !ok || environment["KEEP"] != "1" {
		t.Fatalf("expected repair to preserve environment, got %#v", gonavi["environment"])
	}
	status := inspectOpenCodeMCPInstallStatus(currentCommand, []string{"mcp-server"}, nil)
	if !status.Installed || status.MatchesCurrent {
		t.Fatalf("expected repaired but explicitly disabled config to remain disabled, got %#v", status)
	}
}

func TestRepairOpenCodeMCPClientConfigLeavesCustomCommandUntouched(t *testing.T) {
	originalConfigPathFunc := openCodeConfigPathFunc
	t.Cleanup(func() { openCodeConfigPathFunc = originalConfigPathFunc })

	configPath := filepath.Join(t.TempDir(), "opencode.json")
	initial := []byte(`{"mcp":{"gonavi":{"type":"local","command":["custom-proxy","--serve"],"enabled":true}}}`)
	if err := os.WriteFile(configPath, initial, 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}
	openCodeConfigPathFunc = func() (string, error) { return configPath, nil }

	if err := repairOpenCodeMCPClientConfig("GoNavi.exe", []string{"mcp-server"}, NewService().serviceText); err != nil {
		t.Fatalf("repairOpenCodeMCPClientConfig returned error: %v", err)
	}
	after, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	if !reflect.DeepEqual(initial, after) {
		t.Fatalf("expected custom OpenCode MCP command to remain byte-for-byte unchanged\nbefore: %s\nafter: %s", initial, after)
	}
}

func TestInspectOpenCodeMCPInstallStatusKeepsMissingCLISignalSeparate(t *testing.T) {
	originalConfigPathFunc := openCodeConfigPathFunc
	originalCLIPathFunc := localCLICommandPathFunc
	t.Cleanup(func() {
		openCodeConfigPathFunc = originalConfigPathFunc
		localCLICommandPathFunc = originalCLIPathFunc
	})

	configPath := filepath.Join(t.TempDir(), "opencode.json")
	openCodeConfigPathFunc = func() (string, error) {
		return configPath, nil
	}
	localCLICommandPathFunc = func(file string) (string, error) {
		if file != "opencode" {
			t.Fatalf("expected lookup for opencode, got %q", file)
		}
		return "", errors.New("not found")
	}

	status := inspectOpenCodeMCPInstallStatus("GoNavi.exe", []string{"mcp-server"}, nil)
	if status.ClientDetected || status.ClientPath != "" {
		t.Fatalf("expected missing OpenCode CLI to be reported independently, got %#v", status)
	}
	if status.Installed || status.MatchesCurrent {
		t.Fatalf("expected absent config to remain uninstalled, got %#v", status)
	}
}
