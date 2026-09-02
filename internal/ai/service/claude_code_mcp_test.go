package aiservice

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/shared/i18n"
)

func isolateOpenCodeMCPConfig(t *testing.T) string {
	t.Helper()
	originalConfigPathFunc := openCodeConfigPathFunc
	configPath := filepath.Join(t.TempDir(), "opencode.json")
	openCodeConfigPathFunc = func() (string, error) { return configPath, nil }
	t.Cleanup(func() { openCodeConfigPathFunc = originalConfigPathFunc })
	return configPath
}

func disableLocalCLICommandShellFallback(t *testing.T) {
	t.Helper()
	original := localCLICommandShellCandidatesFunc
	localCLICommandShellCandidatesFunc = func() []string { return nil }
	t.Setenv("NVM_DIR", filepath.Join(t.TempDir(), "empty-nvm"))
	t.Cleanup(func() { localCLICommandShellCandidatesFunc = original })
}

func TestResolveLocalMCPCommandUsesMainBinaryWithArgument(t *testing.T) {
	command, args, err := resolveLocalMCPCommand(`C:\Program Files\GoNavi\GoNavi.exe`)
	if err != nil {
		t.Fatalf("resolveLocalMCPCommand returned error: %v", err)
	}
	if command != `C:\Program Files\GoNavi\GoNavi.exe` {
		t.Fatalf("expected command to keep main binary path, got %q", command)
	}
	if !reflect.DeepEqual(args, []string{"mcp-server"}) {
		t.Fatalf("expected main binary args %#v, got %#v", []string{"mcp-server"}, args)
	}
}

func TestResolveLocalMCPCommandKeepsDedicatedServerBinary(t *testing.T) {
	command, args, err := resolveLocalMCPCommand(`D:\Work\CodeRepos\GoNavi\bin\gonavi-mcp-server.exe`)
	if err != nil {
		t.Fatalf("resolveLocalMCPCommand returned error: %v", err)
	}
	if command != `D:\Work\CodeRepos\GoNavi\bin\gonavi-mcp-server.exe` {
		t.Fatalf("expected dedicated server path to be reused, got %q", command)
	}
	if len(args) != 0 {
		t.Fatalf("expected dedicated server args to be empty, got %#v", args)
	}
}

func TestResolveLocalMCPCommandUsesDedicatedServerForWailsDevelopmentBuild(t *testing.T) {
	repoRoot := t.TempDir()
	developmentExecutable := filepath.Join(repoRoot, "build", "bin", "GoNavi-dev.exe")
	if err := os.MkdirAll(filepath.Dir(developmentExecutable), 0o755); err != nil {
		t.Fatalf("MkdirAll development output directory returned error: %v", err)
	}
	if err := os.WriteFile(developmentExecutable, []byte("development executable"), 0o755); err != nil {
		t.Fatalf("WriteFile development executable returned error: %v", err)
	}
	developmentServer := filepath.Join(repoRoot, "build", "bin", "gonavi-mcp-server-dev.exe")
	if err := os.WriteFile(developmentServer, []byte("development MCP server"), 0o755); err != nil {
		t.Fatalf("WriteFile development MCP server returned error: %v", err)
	}

	command, args, err := resolveLocalMCPCommand(developmentExecutable)
	if err != nil {
		t.Fatalf("resolveLocalMCPCommand returned error: %v", err)
	}
	if want := developmentServer; command != want {
		t.Fatalf("command = %q, want %q", command, want)
	}
	if len(args) != 0 {
		t.Fatalf("args = %#v, want no arguments", args)
	}
}

func TestResolveLocalMCPCommandBuildsMissingDedicatedServerForWailsDevelopmentBuild(t *testing.T) {
	repoRoot := t.TempDir()
	developmentExecutable := filepath.Join(repoRoot, "build", "bin", "GoNavi-dev.exe")
	if err := os.MkdirAll(filepath.Dir(developmentExecutable), 0o755); err != nil {
		t.Fatalf("MkdirAll development output directory returned error: %v", err)
	}
	if err := os.WriteFile(developmentExecutable, []byte("development executable"), 0o755); err != nil {
		t.Fatalf("WriteFile development executable returned error: %v", err)
	}
	developmentServer := filepath.Join(repoRoot, "build", "bin", "gonavi-mcp-server-dev.exe")

	originalBuilder := buildWailsDevelopmentMCPServerFunc
	buildCalls := 0
	buildWailsDevelopmentMCPServerFunc = func(gotRepoRoot string, gotServerPath string) error {
		buildCalls++
		if gotRepoRoot != repoRoot {
			t.Fatalf("repo root = %q, want %q", gotRepoRoot, repoRoot)
		}
		if gotServerPath != developmentServer {
			t.Fatalf("server path = %q, want %q", gotServerPath, developmentServer)
		}
		return os.WriteFile(gotServerPath, []byte("built development MCP server"), 0o755)
	}
	t.Cleanup(func() {
		buildWailsDevelopmentMCPServerFunc = originalBuilder
	})

	command, args, err := resolveLocalMCPCommand(developmentExecutable)
	if err != nil {
		t.Fatalf("resolveLocalMCPCommand returned error: %v", err)
	}
	if buildCalls != 1 {
		t.Fatalf("build calls = %d, want 1", buildCalls)
	}
	if command != developmentServer {
		t.Fatalf("command = %q, want %q", command, developmentServer)
	}
	if len(args) != 0 {
		t.Fatalf("args = %#v, want no arguments", args)
	}
}

func TestShouldRepairInstalledLocalMCPCommandMigratesExistingWailsDevelopmentBuild(t *testing.T) {
	repoRoot := t.TempDir()
	developmentExecutable := filepath.Join(repoRoot, "build", "bin", "GoNavi-dev.exe")
	if err := os.MkdirAll(filepath.Dir(developmentExecutable), 0o755); err != nil {
		t.Fatalf("MkdirAll development output directory returned error: %v", err)
	}
	if err := os.WriteFile(developmentExecutable, []byte("currently running MCP host"), 0o755); err != nil {
		t.Fatalf("WriteFile development executable returned error: %v", err)
	}

	developmentServer := filepath.Join(repoRoot, "build", "bin", "gonavi-mcp-server-dev.exe")
	if !shouldRepairInstalledLocalMCPCommand(developmentExecutable, []string{"mcp-server"}, developmentServer, nil) {
		t.Fatal("expected a Wails development executable to be migrated even while it exists")
	}
	legacyGoRunArgs := []string{"-C", repoRoot, "run", "./cmd/gonavi-mcp-server"}
	if !shouldRepairInstalledLocalMCPCommand(filepath.Join(repoRoot, "go.exe"), legacyGoRunArgs, developmentServer, nil) {
		t.Fatal("expected the legacy development go-run configuration to be migrated")
	}
	if shouldRepairInstalledLocalMCPCommand(developmentExecutable, []string{"mcp-server"}, filepath.Join(repoRoot, "GoNavi.exe"), []string{"mcp-server"}) {
		t.Fatal("expected a production launch to preserve a development MCP configuration")
	}
}

func TestDetectLocalCLICommandFallsBackToLoginShellPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("login-shell PATH fallback is Unix-only")
	}

	originalPathFunc := localCLICommandPathFunc
	originalShellCandidatesFunc := localCLICommandShellCandidatesFunc
	originalShellOutputFunc := localCLICommandShellOutputFunc
	originalTimeout := localCLICommandShellLookupTimeout
	t.Cleanup(func() {
		localCLICommandPathFunc = originalPathFunc
		localCLICommandShellCandidatesFunc = originalShellCandidatesFunc
		localCLICommandShellOutputFunc = originalShellOutputFunc
		localCLICommandShellLookupTimeout = originalTimeout
	})

	const command = "claude"
	const shellPath = "/Users/mock/.local/bin/claude"
	t.Setenv("NVM_DIR", filepath.Join(t.TempDir(), "empty-nvm"))
	localCLICommandPathFunc = func(value string) (string, error) {
		if value == command {
			return "", exec.ErrNotFound
		}
		if value == "/usr/bin/ls" {
			t.Fatal("shell startup output with a different basename must be ignored")
		}
		if value == shellPath {
			return shellPath, nil
		}
		return "", exec.ErrNotFound
	}
	localCLICommandShellCandidatesFunc = func() []string { return []string{"/bin/zsh"} }
	localCLICommandShellOutputFunc = func(ctx context.Context, shell string, lookupCommand string) ([]byte, error) {
		if shell != "/bin/zsh" {
			t.Fatalf("shell = %q, want /bin/zsh", shell)
		}
		if lookupCommand != "command -v -- 'claude'" {
			t.Fatalf("lookup command = %q", lookupCommand)
		}
		if err := ctx.Err(); err != nil {
			t.Fatalf("lookup context already canceled: %v", err)
		}
		return []byte("shell startup notice\n/usr/bin/ls\n" + shellPath + "\n"), nil
	}
	localCLICommandShellLookupTimeout = time.Second

	detected, resolvedPath := detectLocalCLICommand(command)
	if !detected {
		t.Fatal("expected shell PATH fallback to detect Claude CLI")
	}
	if resolvedPath != shellPath {
		t.Fatalf("resolved path = %q, want %q", resolvedPath, shellPath)
	}
}

func TestDetectLocalCLICommandUsesRealLoginShellForDesktopPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("login-shell PATH fallback is Unix-only")
	}

	originalPathFunc := localCLICommandPathFunc
	originalShellCandidatesFunc := localCLICommandShellCandidatesFunc
	originalShellOutputFunc := localCLICommandShellOutputFunc
	originalTimeout := localCLICommandShellLookupTimeout
	t.Cleanup(func() {
		localCLICommandPathFunc = originalPathFunc
		localCLICommandShellCandidatesFunc = originalShellCandidatesFunc
		localCLICommandShellOutputFunc = originalShellOutputFunc
		localCLICommandShellLookupTimeout = originalTimeout
	})

	command := "gonavi-login-shell-client"
	commandPath := filepath.Join(t.TempDir(), command)
	if err := os.WriteFile(commandPath, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("WriteFile CLI fixture returned error: %v", err)
	}
	shellPath := filepath.Join(t.TempDir(), "login-shell")
	if err := os.WriteFile(shellPath, []byte("#!/bin/sh\nprintf '%s\\n' \"$GONAVI_TEST_LOGIN_SHELL_CLIENT\"\n"), 0o755); err != nil {
		t.Fatalf("WriteFile shell fixture returned error: %v", err)
	}

	t.Setenv("PATH", "/usr/bin:/bin")
	t.Setenv("SHELL", shellPath)
	t.Setenv("GONAVI_TEST_LOGIN_SHELL_CLIENT", commandPath)
	localCLICommandPathFunc = exec.LookPath
	localCLICommandShellCandidatesFunc = localCLICommandShellCandidates
	localCLICommandShellOutputFunc = runLocalCLICommandShell
	// This test starts a real shell subprocess. Leave production's two-second
	// lookup budget unchanged, but allow the fixture enough scheduling time
	// when go test runs packages in parallel.
	localCLICommandShellLookupTimeout = 5 * time.Second

	detected, resolvedPath := detectLocalCLICommand(command)
	if !detected {
		t.Fatal("expected login shell to recover a CLI hidden from the desktop PATH")
	}
	if resolvedPath != commandPath {
		t.Fatalf("resolved path = %q, want %q", resolvedPath, commandPath)
	}
}

func TestDetectLocalCLICommandRejectsUnsafeNameBeforeShellLookup(t *testing.T) {
	originalPathFunc := localCLICommandPathFunc
	originalShellCandidatesFunc := localCLICommandShellCandidatesFunc
	originalShellOutputFunc := localCLICommandShellOutputFunc
	t.Cleanup(func() {
		localCLICommandPathFunc = originalPathFunc
		localCLICommandShellCandidatesFunc = originalShellCandidatesFunc
		localCLICommandShellOutputFunc = originalShellOutputFunc
	})

	localCLICommandPathFunc = func(value string) (string, error) {
		if value != "claude; touch /tmp/pwned" {
			t.Fatalf("unexpected direct lookup: %q", value)
		}
		return "", exec.ErrNotFound
	}
	localCLICommandShellCandidatesFunc = func() []string {
		t.Fatal("unsafe command name must not invoke a shell")
		return nil
	}
	localCLICommandShellOutputFunc = func(context.Context, string, string) ([]byte, error) {
		t.Fatal("unsafe command name must not execute shell lookup")
		return nil, nil
	}

	detected, resolvedPath := detectLocalCLICommand("claude; touch /tmp/pwned")
	if detected || resolvedPath != "" {
		t.Fatalf("unsafe command lookup = (%t, %q), want (false, empty)", detected, resolvedPath)
	}
}

func TestDetectLocalCLICommandShellLookupHonorsTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("login-shell PATH fallback is Unix-only")
	}

	originalPathFunc := localCLICommandPathFunc
	originalShellCandidatesFunc := localCLICommandShellCandidatesFunc
	originalShellOutputFunc := localCLICommandShellOutputFunc
	originalTimeout := localCLICommandShellLookupTimeout
	t.Cleanup(func() {
		localCLICommandPathFunc = originalPathFunc
		localCLICommandShellCandidatesFunc = originalShellCandidatesFunc
		localCLICommandShellOutputFunc = originalShellOutputFunc
		localCLICommandShellLookupTimeout = originalTimeout
	})

	t.Setenv("NVM_DIR", filepath.Join(t.TempDir(), "empty-nvm"))
	localCLICommandPathFunc = func(string) (string, error) { return "", exec.ErrNotFound }
	localCLICommandShellCandidatesFunc = func() []string { return []string{"/bin/zsh", "/bin/bash"} }
	var shellCalls int
	localCLICommandShellOutputFunc = func(ctx context.Context, _ string, _ string) ([]byte, error) {
		shellCalls++
		<-ctx.Done()
		return nil, ctx.Err()
	}
	localCLICommandShellLookupTimeout = 10 * time.Millisecond

	started := time.Now()
	detected, resolvedPath := detectLocalCLICommand("claude")
	if detected || resolvedPath != "" {
		t.Fatalf("timed-out shell lookup = (%t, %q), want (false, empty)", detected, resolvedPath)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("shell lookup exceeded timeout budget: %s", elapsed)
	}
	if shellCalls != 1 {
		t.Fatalf("shell lookup used %d shells after the shared timeout expired, want 1", shellCalls)
	}
}

func TestRepairInstalledLocalMCPClientConfigsUpdatesMissingManagedCommands(t *testing.T) {
	isolateOpenCodeMCPConfig(t)
	isolateAdditionalMCPClientConfigs(t)
	mockLocalMCPClientCommandsDetected(t)
	originalClaudeConfigPathFunc := claudeCodeConfigPathFunc
	originalCodexConfigPathFunc := codexConfigPathFunc
	originalExecutablePathFunc := localMCPExecutablePathFunc
	t.Cleanup(func() {
		claudeCodeConfigPathFunc = originalClaudeConfigPathFunc
		codexConfigPathFunc = originalCodexConfigPathFunc
		localMCPExecutablePathFunc = originalExecutablePathFunc
	})

	tempDir := t.TempDir()
	claudeConfigPath := filepath.Join(tempDir, ".claude.json")
	codexConfigPath := filepath.Join(tempDir, ".codex", "config.toml")
	currentExecutable := filepath.Join(tempDir, "current", "GoNavi.exe")
	if err := os.MkdirAll(filepath.Dir(currentExecutable), 0o755); err != nil {
		t.Fatalf("MkdirAll current executable dir returned error: %v", err)
	}
	if err := os.WriteFile(currentExecutable, []byte("current"), 0o755); err != nil {
		t.Fatalf("WriteFile current executable returned error: %v", err)
	}
	missingOldExecutable := filepath.Join(tempDir, "old", "GoNavi-0.8.0-Windows-Amd64.exe")

	claudeConfig := map[string]any{
		"theme": "dark",
		"mcpServers": map[string]any{
			"memory": map[string]any{"type": "stdio", "command": "memory-server"},
			gonaviMCPServerID: map[string]any{
				"type":    "stdio",
				"command": missingOldExecutable,
				"args":    []string{"mcp-server"},
			},
		},
	}
	claudeData, err := json.MarshalIndent(claudeConfig, "", "  ")
	if err != nil {
		t.Fatalf("MarshalIndent Claude config returned error: %v", err)
	}
	if err := os.WriteFile(claudeConfigPath, append(claudeData, '\n'), 0o644); err != nil {
		t.Fatalf("WriteFile Claude config returned error: %v", err)
	}

	if err := os.MkdirAll(filepath.Dir(codexConfigPath), 0o755); err != nil {
		t.Fatalf("MkdirAll Codex config dir returned error: %v", err)
	}
	codexConfig := strings.Join([]string{
		`model = "gpt-5.4"`,
		``,
		`[mcp_servers.memory]`,
		`command = "memory-server"`,
		``,
		`[mcp_servers.gonavi]`,
		fmt.Sprintf("command = %s", tomlString(missingOldExecutable)),
		`args = ['mcp-server']`,
		`startup_timeout_sec = 60`,
		``,
	}, "\n")
	if err := os.WriteFile(codexConfigPath, []byte(codexConfig), 0o644); err != nil {
		t.Fatalf("WriteFile Codex config returned error: %v", err)
	}

	claudeCodeConfigPathFunc = func() (string, error) { return claudeConfigPath, nil }
	codexConfigPathFunc = func() (string, error) { return codexConfigPath, nil }
	localMCPExecutablePathFunc = func() (string, error) { return currentExecutable, nil }

	service := NewService()
	if err := service.repairInstalledLocalMCPClientConfigs(); err != nil {
		t.Fatalf("repairInstalledLocalMCPClientConfigs returned error: %v", err)
	}

	statuses := service.AIGetMCPClientInstallStatuses()
	if len(statuses) < 2 || !statuses[0].MatchesCurrent || !statuses[1].MatchesCurrent {
		t.Fatalf("expected Claude Code and Codex configs to match current executable, got %#v", statuses)
	}

	updatedClaudeData, err := os.ReadFile(claudeConfigPath)
	if err != nil {
		t.Fatalf("ReadFile updated Claude config returned error: %v", err)
	}
	if !strings.Contains(string(updatedClaudeData), `"memory"`) || !strings.Contains(string(updatedClaudeData), `"theme": "dark"`) {
		t.Fatalf("expected unrelated Claude config to remain, got %s", string(updatedClaudeData))
	}
	updatedCodexData, err := os.ReadFile(codexConfigPath)
	if err != nil {
		t.Fatalf("ReadFile updated Codex config returned error: %v", err)
	}
	if !strings.Contains(string(updatedCodexData), `[mcp_servers.memory]`) || !strings.Contains(string(updatedCodexData), `model = "gpt-5.4"`) {
		t.Fatalf("expected unrelated Codex config to remain, got %s", string(updatedCodexData))
	}
}

func TestRepairInstalledLocalMCPClientConfigsLeavesExistingOrCustomCommandsUntouched(t *testing.T) {
	existingManagedCommand := filepath.Join(t.TempDir(), "GoNavi.exe")
	if err := os.WriteFile(existingManagedCommand, []byte("old but available"), 0o755); err != nil {
		t.Fatalf("WriteFile existing managed command returned error: %v", err)
	}

	if shouldRepairInstalledLocalMCPCommand(existingManagedCommand, []string{"mcp-server"}, filepath.Join(t.TempDir(), "GoNavi.exe")) {
		t.Fatal("expected an existing managed command to remain untouched")
	}
	if shouldRepairInstalledLocalMCPCommand("missing-custom-proxy", []string{"--serve"}, "GoNavi.exe") {
		t.Fatal("expected a custom command to remain untouched")
	}
	if shouldRepairInstalledLocalMCPCommand("missing-custom-proxy", []string{"mcp-server"}, "GoNavi.exe") {
		t.Fatal("expected a missing non-GoNavi command to remain untouched")
	}
	if !shouldRepairInstalledLocalMCPCommand(filepath.Join(t.TempDir(), "missing", "GoNavi.exe"), []string{"mcp-server"}, "GoNavi.exe") {
		t.Fatal("expected a missing managed GoNavi command to be repaired")
	}
}

func TestShouldRepairInstalledLocalMCPCommandUpdatesExistingVersionedWindowsTarget(t *testing.T) {
	dir := t.TempDir()
	oldCommand := filepath.Join(dir, "GoNavi-0.8.4-Windows-Amd64.exe")
	newCommand := filepath.Join(dir, "GoNavi-0.8.5-Windows-Amd64.exe")
	if err := os.WriteFile(oldCommand, []byte("still locked by an MCP process"), 0o755); err != nil {
		t.Fatalf("WriteFile old command returned error: %v", err)
	}

	if !shouldRepairInstalledLocalMCPCommand(oldCommand, []string{"mcp-server"}, newCommand) {
		t.Fatal("expected a same-directory versioned Windows update to refresh the MCP command")
	}
	if shouldRepairInstalledLocalMCPCommand(oldCommand, []string{"mcp-server"}, filepath.Join(t.TempDir(), filepath.Base(newCommand))) {
		t.Fatal("expected a versioned command in another directory to remain untouched")
	}
}

func TestReadClaudeCodeMCPServerConfigReadsExistingInstall(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, ".claude.json")
	initial := map[string]any{
		"mcpServers": map[string]any{
			gonaviMCPServerID: map[string]any{
				"type":    "stdio",
				"command": `C:\Program Files\GoNavi\GoNavi.exe`,
				"args":    []string{"mcp-server"},
			},
		},
	}
	data, err := json.MarshalIndent(initial, "", "  ")
	if err != nil {
		t.Fatalf("MarshalIndent returned error: %v", err)
	}
	if err := os.WriteFile(configPath, append(data, '\n'), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	cfg, found, err := readClaudeCodeMCPServerConfig(configPath, gonaviMCPServerID)
	if err != nil {
		t.Fatalf("readClaudeCodeMCPServerConfig returned error: %v", err)
	}
	if !found {
		t.Fatal("expected gonavi install to be detected")
	}
	if cfg.Command != `C:\Program Files\GoNavi\GoNavi.exe` {
		t.Fatalf("unexpected command: %q", cfg.Command)
	}
	if !reflect.DeepEqual(cfg.Args, []string{"mcp-server"}) {
		t.Fatalf("unexpected args: %#v", cfg.Args)
	}
}

func TestUpsertClaudeCodeMCPServerConfigCreatesAndMergesUserConfig(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, ".claude.json")
	initial := map[string]any{
		"theme": "dark-daltonized",
		"mcpServers": map[string]any{
			"memory": map[string]any{
				"type":    "stdio",
				"command": "cmd",
			},
		},
	}
	data, err := json.MarshalIndent(initial, "", "  ")
	if err != nil {
		t.Fatalf("MarshalIndent returned error: %v", err)
	}
	if err := os.WriteFile(configPath, append(data, '\n'), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	err = upsertClaudeCodeMCPServerConfig(configPath, gonaviMCPServerID, claudeCodeMCPServerConfig{
		Type:    "stdio",
		Command: `C:\Program Files\GoNavi\GoNavi.exe`,
		Args:    []string{"mcp-server"},
		Env:     map[string]string{},
	})
	if err != nil {
		t.Fatalf("upsertClaudeCodeMCPServerConfig returned error: %v", err)
	}

	updated, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}

	var root map[string]any
	if err := json.Unmarshal(updated, &root); err != nil {
		t.Fatalf("Unmarshal returned error: %v", err)
	}
	if got := strings.TrimSpace(root["theme"].(string)); got != "dark-daltonized" {
		t.Fatalf("expected theme to be preserved, got %q", got)
	}

	mcpServers, ok := root["mcpServers"].(map[string]any)
	if !ok {
		t.Fatalf("expected mcpServers object, got %#v", root["mcpServers"])
	}
	if _, ok := mcpServers["memory"]; !ok {
		t.Fatalf("expected existing memory server to be preserved, got %#v", mcpServers)
	}

	gonavi, ok := mcpServers[gonaviMCPServerID].(map[string]any)
	if !ok {
		t.Fatalf("expected gonavi server object, got %#v", mcpServers[gonaviMCPServerID])
	}
	if got := strings.TrimSpace(gonavi["command"].(string)); got != `C:\Program Files\GoNavi\GoNavi.exe` {
		t.Fatalf("expected gonavi command to be written, got %q", got)
	}
	args, ok := gonavi["args"].([]any)
	if !ok || len(args) != 1 || strings.TrimSpace(args[0].(string)) != "mcp-server" {
		t.Fatalf("expected gonavi args to contain mcp-server, got %#v", gonavi["args"])
	}
}

func TestUpsertClaudeCodeMCPServerConfigRejectsInvalidMCPServersShape(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, ".claude.json")
	if err := os.WriteFile(configPath, []byte("{\"mcpServers\":[]}"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	err := upsertClaudeCodeMCPServerConfig(configPath, gonaviMCPServerID, claudeCodeMCPServerConfig{
		Type:    "stdio",
		Command: "GoNavi.exe",
	})
	if err == nil {
		t.Fatal("expected invalid mcpServers shape to return error")
	}
	if !strings.Contains(err.Error(), "mcpServers should be an object") {
		t.Fatalf("expected invalid shape error, got %v", err)
	}
}

func TestParseCodexMCPServerConfigDetectsExistingInstall(t *testing.T) {
	content := strings.Join([]string{
		`model = "gpt-5.4"`,
		``,
		`[mcp_servers.gonavi]`,
		`command = 'C:\Program Files\GoNavi\GoNavi.exe'`,
		`args = ['mcp-server']`,
		`startup_timeout_sec = 60`,
		``,
		`[projects.'D:\Work\CodeRepos\GoNavi']`,
		`trust_level = "trusted"`,
		``,
	}, "\n")

	cfg, found, err := parseCodexMCPServerConfig(content, gonaviMCPServerID)
	if err != nil {
		t.Fatalf("parseCodexMCPServerConfig returned error: %v", err)
	}
	if !found {
		t.Fatal("expected gonavi install to be detected")
	}
	if cfg.Command != `C:\Program Files\GoNavi\GoNavi.exe` {
		t.Fatalf("unexpected command: %q", cfg.Command)
	}
	if !reflect.DeepEqual(cfg.Args, []string{"mcp-server"}) {
		t.Fatalf("unexpected args: %#v", cfg.Args)
	}
	if cfg.StartupTimeoutSec != 60 {
		t.Fatalf("unexpected startup timeout: %d", cfg.StartupTimeoutSec)
	}
}

func TestCodexMCPConfigParserInternalErrorsUseEnglishText(t *testing.T) {
	hanText := regexp.MustCompile(`\p{Han}`)
	cases := []struct {
		name string
		err  error
		want string
	}{
		{
			name: "short string",
			err:  func() error { _, err := parseTOMLString("x"); return err }(),
			want: "invalid string format",
		},
		{
			name: "unclosed single quoted string",
			err:  func() error { _, err := parseTOMLString("'x"); return err }(),
			want: "single-quoted string is not closed",
		},
		{
			name: "non string",
			err:  func() error { _, err := parseTOMLString("[bad]"); return err }(),
			want: "not a string",
		},
		{
			name: "non array",
			err:  func() error { _, err := parseTOMLStringArray("'x'"); return err }(),
			want: "not an array",
		},
		{
			name: "invalid array separator",
			err:  func() error { _, err := parseTOMLStringArray("['a' 'b']"); return err }(),
			want: "invalid array separator",
		},
		{
			name: "empty array item",
			err:  func() error { _, _, err := consumeTOMLQuotedString(""); return err }(),
			want: "string is empty",
		},
		{
			name: "unclosed double quoted string",
			err:  func() error { _, _, err := consumeTOMLQuotedString(`"x`); return err }(),
			want: "double-quoted string is not closed",
		},
		{
			name: "non string array element",
			err:  func() error { _, err := decodeJSONLikeStringSlice([]any{"ok", 1}); return err }(),
			want: "array element is not a string",
		},
		{
			name: "non string array",
			err:  func() error { _, err := decodeJSONLikeStringSlice("x"); return err }(),
			want: "not a string array",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.err == nil {
				t.Fatal("expected parser helper to return an error")
			}
			if hanText.MatchString(tc.err.Error()) {
				t.Fatalf("expected English internal parser error, got %q", tc.err.Error())
			}
			if tc.err.Error() != tc.want {
				t.Fatalf("expected parser helper error %q, got %q", tc.want, tc.err.Error())
			}
		})
	}
}

func TestUpsertCodexMCPServerConfigCreatesAndMergesConfig(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "config.toml")
	initial := strings.Join([]string{
		`model = "gpt-5.4"`,
		``,
		`[mcp_servers.memory]`,
		`command = "cmd"`,
		`args = ["/c", "npx"]`,
		``,
	}, "\n")
	if err := os.WriteFile(configPath, []byte(initial), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	err := upsertCodexMCPServerConfig(configPath, gonaviMCPServerID, codexMCPServerConfig{
		Command:           `C:\Program Files\GoNavi\GoNavi.exe`,
		Args:              []string{"mcp-server"},
		StartupTimeoutSec: defaultCodexMCPStartupTimeoutSecond,
	})
	if err != nil {
		t.Fatalf("upsertCodexMCPServerConfig returned error: %v", err)
	}

	updated, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	text := string(updated)
	if !strings.Contains(text, `[mcp_servers.memory]`) {
		t.Fatalf("expected memory server to be preserved, got %s", text)
	}
	if !strings.Contains(text, `[mcp_servers.gonavi]`) {
		t.Fatalf("expected gonavi section to be created, got %s", text)
	}
	if !strings.Contains(text, `command = 'C:\Program Files\GoNavi\GoNavi.exe'`) {
		t.Fatalf("expected gonavi command to be written, got %s", text)
	}
	if !strings.Contains(text, `args = ['mcp-server']`) {
		t.Fatalf("expected gonavi args to be written, got %s", text)
	}
	if !strings.Contains(text, `startup_timeout_sec = 60`) {
		t.Fatalf("expected startup timeout to be written, got %s", text)
	}
}

func TestUpsertCodexMCPServerConfigReplacesExistingBlockAndNestedSections(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "config.toml")
	initial := strings.Join([]string{
		`model = "gpt-5.4"`,
		``,
		`[mcp_servers.gonavi]`,
		`command = 'old.exe'`,
		`args = ['old']`,
		`startup_timeout_sec = 15`,
		``,
		`[mcp_servers.gonavi.env]`,
		`FOO = "bar"`,
		``,
		`[projects.'D:\Work\CodeRepos\GoNavi']`,
		`trust_level = "trusted"`,
		``,
	}, "\n")
	if err := os.WriteFile(configPath, []byte(initial), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	err := upsertCodexMCPServerConfig(configPath, gonaviMCPServerID, codexMCPServerConfig{
		Command:           `C:\Program Files\GoNavi\GoNavi.exe`,
		Args:              []string{"mcp-server"},
		StartupTimeoutSec: defaultCodexMCPStartupTimeoutSecond,
	})
	if err != nil {
		t.Fatalf("upsertCodexMCPServerConfig returned error: %v", err)
	}

	updated, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	text := string(updated)
	if strings.Contains(text, `command = 'old.exe'`) || strings.Contains(text, `[mcp_servers.gonavi.env]`) {
		t.Fatalf("expected old gonavi block to be replaced, got %s", text)
	}
	if !strings.Contains(text, `[projects.'D:\Work\CodeRepos\GoNavi']`) {
		t.Fatalf("expected unrelated project config to be preserved, got %s", text)
	}
}

func TestInspectClaudeCodeMCPInstallStatusIncludesLocalCLIAvailability(t *testing.T) {
	originalConfigPathFunc := claudeCodeConfigPathFunc
	originalCLIPathFunc := localCLICommandPathFunc
	t.Cleanup(func() {
		claudeCodeConfigPathFunc = originalConfigPathFunc
		localCLICommandPathFunc = originalCLIPathFunc
	})

	tempDir := t.TempDir()
	claudeCodeConfigPathFunc = func() (string, error) {
		return filepath.Join(tempDir, ".claude.json"), nil
	}
	localCLICommandPathFunc = func(file string) (string, error) {
		if file != claudeCodeClientCommandName {
			t.Fatalf("expected lookup for %q, got %q", claudeCodeClientCommandName, file)
		}
		return `C:\Users\mock\AppData\Roaming\npm\claude.CMD`, nil
	}

	status := inspectClaudeCodeMCPInstallStatus(`C:\Program Files\GoNavi\GoNavi.exe`, []string{"mcp-server"}, nil)
	if !status.ClientDetected {
		t.Fatal("expected Claude Code command detection to be true")
	}
	if status.ClientCommand != claudeCodeClientCommandName {
		t.Fatalf("expected client command %q, got %q", claudeCodeClientCommandName, status.ClientCommand)
	}
	if status.ClientPath != `C:\Users\mock\AppData\Roaming\npm\claude.CMD` {
		t.Fatalf("unexpected client path: %q", status.ClientPath)
	}
	if status.Installed {
		t.Fatal("expected MCP config to remain uninstalled when config file is absent")
	}
}

func TestInspectCodexMCPInstallStatusKeepsMissingCLISignalSeparateFromConfigState(t *testing.T) {
	disableLocalCLICommandShellFallback(t)
	originalConfigPathFunc := codexConfigPathFunc
	originalCLIPathFunc := localCLICommandPathFunc
	t.Cleanup(func() {
		codexConfigPathFunc = originalConfigPathFunc
		localCLICommandPathFunc = originalCLIPathFunc
	})

	tempDir := t.TempDir()
	codexConfigPathFunc = func() (string, error) {
		return filepath.Join(tempDir, "config.toml"), nil
	}
	localCLICommandPathFunc = func(file string) (string, error) {
		if file != codexClientCommandName {
			t.Fatalf("expected lookup for %q, got %q", codexClientCommandName, file)
		}
		return "", errors.New("not found")
	}

	status := inspectCodexMCPInstallStatus(`C:\Program Files\GoNavi\GoNavi.exe`, []string{"mcp-server"}, nil)
	if status.ClientDetected {
		t.Fatal("expected codex command detection to be false")
	}
	if status.ClientCommand != codexClientCommandName {
		t.Fatalf("expected client command %q, got %q", codexClientCommandName, status.ClientCommand)
	}
	if status.ClientPath != "" {
		t.Fatalf("expected missing codex command path to be empty, got %q", status.ClientPath)
	}
	if status.Message != "No Codex user-level GoNavi MCP configuration was detected" {
		t.Fatalf("unexpected config message: %q", status.Message)
	}
}

func TestMCPClientInstallResultMessagesUseServiceLanguage(t *testing.T) {
	isolateOpenCodeMCPConfig(t)
	mockLocalMCPClientCommandsDetected(t)
	originalClaudeConfigPathFunc := claudeCodeConfigPathFunc
	originalCodexConfigPathFunc := codexConfigPathFunc
	originalExecutablePathFunc := localMCPExecutablePathFunc
	t.Cleanup(func() {
		claudeCodeConfigPathFunc = originalClaudeConfigPathFunc
		codexConfigPathFunc = originalCodexConfigPathFunc
		localMCPExecutablePathFunc = originalExecutablePathFunc
	})

	tempDir := t.TempDir()
	claudeCodeConfigPathFunc = func() (string, error) {
		return filepath.Join(tempDir, ".claude.json"), nil
	}
	codexConfigPathFunc = func() (string, error) {
		return filepath.Join(tempDir, ".codex", "config.toml"), nil
	}
	localMCPExecutablePathFunc = func() (string, error) {
		return `C:\Program Files\GoNavi\GoNavi.exe`, nil
	}

	service := NewService()
	service.AISetLanguage(string(i18n.LanguageEnUS))
	hanText := regexp.MustCompile(`\p{Han}`)

	claudeResult, err := service.AIInstallClaudeCodeMCP()
	if err != nil {
		t.Fatalf("AIInstallClaudeCodeMCP returned error: %v", err)
	}
	if hanText.MatchString(claudeResult.Message) {
		t.Fatalf("Claude Code install message should be localized to English, got %q", claudeResult.Message)
	}
	if !strings.Contains(claudeResult.Message, "Claude Code user-level MCP configuration") {
		t.Fatalf("unexpected Claude Code install message: %q", claudeResult.Message)
	}

	codexResult, err := service.AIInstallCodexMCP()
	if err != nil {
		t.Fatalf("AIInstallCodexMCP returned error: %v", err)
	}
	if hanText.MatchString(codexResult.Message) {
		t.Fatalf("Codex install message should be localized to English, got %q", codexResult.Message)
	}
	if !strings.Contains(codexResult.Message, "Codex user-level MCP configuration") {
		t.Fatalf("unexpected Codex install message: %q", codexResult.Message)
	}

	openCodeResult, err := service.AIInstallOpenCodeMCP()
	if err != nil {
		t.Fatalf("AIInstallOpenCodeMCP returned error: %v", err)
	}
	if hanText.MatchString(openCodeResult.Message) {
		t.Fatalf("OpenCode install message should be localized to English, got %q", openCodeResult.Message)
	}
	if !strings.Contains(openCodeResult.Message, "OpenCode user-level MCP configuration") {
		t.Fatalf("unexpected OpenCode install message: %q", openCodeResult.Message)
	}
}

func TestMCPClientInstallStatusMessagesUseServiceLanguage(t *testing.T) {
	disableLocalCLICommandShellFallback(t)
	isolateOpenCodeMCPConfig(t)
	isolateAdditionalMCPClientConfigs(t)
	originalClaudeConfigPathFunc := claudeCodeConfigPathFunc
	originalCodexConfigPathFunc := codexConfigPathFunc
	originalExecutablePathFunc := localMCPExecutablePathFunc
	originalCLIPathFunc := localCLICommandPathFunc
	t.Cleanup(func() {
		claudeCodeConfigPathFunc = originalClaudeConfigPathFunc
		codexConfigPathFunc = originalCodexConfigPathFunc
		localMCPExecutablePathFunc = originalExecutablePathFunc
		localCLICommandPathFunc = originalCLIPathFunc
	})

	tempDir := t.TempDir()
	claudeCodeConfigPathFunc = func() (string, error) {
		return filepath.Join(tempDir, ".claude.json"), nil
	}
	codexConfigPathFunc = func() (string, error) {
		return filepath.Join(tempDir, ".codex", "config.toml"), nil
	}
	localMCPExecutablePathFunc = func() (string, error) {
		return `C:\Program Files\GoNavi\GoNavi.exe`, nil
	}
	localCLICommandPathFunc = func(string) (string, error) {
		return "", errors.New("not found")
	}

	service := NewService()
	service.AISetLanguage(string(i18n.LanguageEnUS))
	statuses := service.AIGetMCPClientInstallStatuses()
	hanText := regexp.MustCompile(`\p{Han}`)

	for _, status := range statuses {
		if hanText.MatchString(status.Message) {
			t.Fatalf("%s status message should be localized to English, got %q", status.Client, status.Message)
		}
	}

	if len(statuses) != 9 {
		t.Fatalf("expected 9 MCP client statuses, got %d", len(statuses))
	}
	if !strings.Contains(statuses[0].Message, "No Claude Code user-level GoNavi MCP configuration") {
		t.Fatalf("unexpected Claude Code status message: %q", statuses[0].Message)
	}
	if !strings.Contains(statuses[1].Message, "No Codex user-level GoNavi MCP configuration") {
		t.Fatalf("unexpected Codex status message: %q", statuses[1].Message)
	}
	if !strings.Contains(statuses[2].Message, "No OpenCode user-level GoNavi MCP configuration") {
		t.Fatalf("unexpected OpenCode status message: %q", statuses[2].Message)
	}
	for _, index := range []int{3, 4, 5, 6} {
		if !strings.Contains(statuses[index].Message, "No ") || !strings.Contains(statuses[index].Message, "user-level GoNavi MCP configuration") {
			t.Fatalf("unexpected %s status message: %q", statuses[index].Client, statuses[index].Message)
		}
	}
	if !strings.Contains(statuses[7].Message, "usually runs in the cloud or a remote environment") {
		t.Fatalf("unexpected remote client status message: %q", statuses[7].Message)
	}
}

func TestMCPClientInstallConfigPathFailuresUseServiceLanguage(t *testing.T) {
	disableLocalCLICommandShellFallback(t)
	isolateOpenCodeMCPConfig(t)
	isolateAdditionalMCPClientConfigs(t)
	originalClaudeConfigPathFunc := claudeCodeConfigPathFunc
	originalCodexConfigPathFunc := codexConfigPathFunc
	originalExecutablePathFunc := localMCPExecutablePathFunc
	originalCLIPathFunc := localCLICommandPathFunc
	t.Cleanup(func() {
		claudeCodeConfigPathFunc = originalClaudeConfigPathFunc
		codexConfigPathFunc = originalCodexConfigPathFunc
		localMCPExecutablePathFunc = originalExecutablePathFunc
		localCLICommandPathFunc = originalCLIPathFunc
	})

	claudeCodeConfigPathFunc = func() (string, error) {
		return "", errors.New("claude config denied")
	}
	codexConfigPathFunc = func() (string, error) {
		return "", errors.New("codex config denied")
	}
	localMCPExecutablePathFunc = func() (string, error) {
		return `C:\Program Files\GoNavi\GoNavi.exe`, nil
	}
	localCLICommandPathFunc = func(string) (string, error) {
		return "", errors.New("not found")
	}

	service := NewService()
	service.AISetLanguage(string(i18n.LanguageEnUS))
	hanText := regexp.MustCompile(`\p{Han}`)

	if _, err := service.AIInstallClaudeCodeMCP(); err == nil {
		t.Fatal("expected Claude Code install config path error")
	} else if hanText.MatchString(err.Error()) || !strings.Contains(err.Error(), "Failed to locate Claude Code configuration") || !strings.Contains(err.Error(), "claude config denied") {
		t.Fatalf("Claude Code install error should use English wrapper and keep raw detail, got %q", err.Error())
	}

	if _, err := service.AIInstallCodexMCP(); err == nil {
		t.Fatal("expected Codex install config path error")
	} else if hanText.MatchString(err.Error()) || !strings.Contains(err.Error(), "Failed to locate Codex configuration") || !strings.Contains(err.Error(), "codex config denied") {
		t.Fatalf("Codex install error should use English wrapper and keep raw detail, got %q", err.Error())
	}

	statuses := service.AIGetMCPClientInstallStatuses()
	if len(statuses) < 2 {
		t.Fatalf("expected at least Claude Code and Codex statuses, got %d", len(statuses))
	}
	if hanText.MatchString(statuses[0].Message) || !strings.Contains(statuses[0].Message, "Failed to locate Claude Code configuration") || !strings.Contains(statuses[0].Message, "claude config denied") {
		t.Fatalf("Claude Code status should use English wrapper and keep raw detail, got %q", statuses[0].Message)
	}
	if hanText.MatchString(statuses[1].Message) || !strings.Contains(statuses[1].Message, "Failed to locate Codex configuration") || !strings.Contains(statuses[1].Message, "codex config denied") {
		t.Fatalf("Codex status should use English wrapper and keep raw detail, got %q", statuses[1].Message)
	}
}

func TestMCPClientInstallHomeDirDetailUsesServiceLanguage(t *testing.T) {
	disableLocalCLICommandShellFallback(t)
	isolateOpenCodeMCPConfig(t)
	isolateAdditionalMCPClientConfigs(t)
	originalClaudeConfigPathFunc := claudeCodeConfigPathFunc
	originalCodexConfigPathFunc := codexConfigPathFunc
	originalExecutablePathFunc := localMCPExecutablePathFunc
	originalCLIPathFunc := localCLICommandPathFunc
	t.Cleanup(func() {
		claudeCodeConfigPathFunc = originalClaudeConfigPathFunc
		codexConfigPathFunc = originalCodexConfigPathFunc
		localMCPExecutablePathFunc = originalExecutablePathFunc
		localCLICommandPathFunc = originalCLIPathFunc
	})

	claudeCodeConfigPathFunc = func() (string, error) {
		return "", errMCPClientUserHomeDirUnavailable
	}
	codexConfigPathFunc = func() (string, error) {
		return "", errMCPClientUserHomeDirUnavailable
	}
	localMCPExecutablePathFunc = func() (string, error) {
		return `C:\Program Files\GoNavi\GoNavi.exe`, nil
	}
	localCLICommandPathFunc = func(string) (string, error) {
		return "", errors.New("not found")
	}

	service := NewService()
	service.AISetLanguage(string(i18n.LanguageEnUS))
	hanText := regexp.MustCompile(`\p{Han}`)

	if _, err := service.AIInstallClaudeCodeMCP(); err == nil {
		t.Fatal("expected Claude Code install home-dir error")
	} else if hanText.MatchString(err.Error()) || !strings.Contains(err.Error(), "Unable to determine the current user home directory") {
		t.Fatalf("Claude Code install home-dir detail should be localized, got %q", err.Error())
	}

	if _, err := service.AIInstallCodexMCP(); err == nil {
		t.Fatal("expected Codex install home-dir error")
	} else if hanText.MatchString(err.Error()) || !strings.Contains(err.Error(), "Unable to determine the current user home directory") {
		t.Fatalf("Codex install home-dir detail should be localized, got %q", err.Error())
	}

	statuses := service.AIGetMCPClientInstallStatuses()
	if len(statuses) < 2 {
		t.Fatalf("expected at least Claude Code and Codex statuses, got %d", len(statuses))
	}
	if hanText.MatchString(statuses[0].Message) || !strings.Contains(statuses[0].Message, "Unable to determine the current user home directory") {
		t.Fatalf("Claude Code status home-dir detail should be localized, got %q", statuses[0].Message)
	}
	if hanText.MatchString(statuses[1].Message) || !strings.Contains(statuses[1].Message, "Unable to determine the current user home directory") {
		t.Fatalf("Codex status home-dir detail should be localized, got %q", statuses[1].Message)
	}
}

func TestMCPClientInstallExecutablePathFailuresUseServiceLanguage(t *testing.T) {
	disableLocalCLICommandShellFallback(t)
	openCodeConfigPath := isolateOpenCodeMCPConfig(t)
	isolateAdditionalMCPClientConfigs(t)
	mockLocalMCPClientCommandsDetected(t)
	originalClaudeConfigPathFunc := claudeCodeConfigPathFunc
	originalCodexConfigPathFunc := codexConfigPathFunc
	originalExecutablePathFunc := localMCPExecutablePathFunc
	t.Cleanup(func() {
		claudeCodeConfigPathFunc = originalClaudeConfigPathFunc
		codexConfigPathFunc = originalCodexConfigPathFunc
		localMCPExecutablePathFunc = originalExecutablePathFunc
	})

	tempDir := t.TempDir()
	claudeConfigPath := filepath.Join(tempDir, ".claude.json")
	codexConfigPath := filepath.Join(tempDir, ".codex", "config.toml")
	claudeCodeConfigPathFunc = func() (string, error) {
		return claudeConfigPath, nil
	}
	codexConfigPathFunc = func() (string, error) {
		return codexConfigPath, nil
	}
	if err := os.WriteFile(claudeConfigPath, []byte(`{"mcpServers":{"gonavi":{"type":"stdio","command":"old-gonavi","args":["mcp-server"]}}}`), 0o644); err != nil {
		t.Fatalf("WriteFile Claude config returned error: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(codexConfigPath), 0o755); err != nil {
		t.Fatalf("MkdirAll Codex config dir returned error: %v", err)
	}
	if err := os.WriteFile(codexConfigPath, []byte("[mcp_servers.gonavi]\ncommand = 'old-gonavi'\nargs = ['mcp-server']\n"), 0o644); err != nil {
		t.Fatalf("WriteFile Codex config returned error: %v", err)
	}
	if err := os.WriteFile(openCodeConfigPath, []byte(`{"mcp":{"gonavi":{"type":"local","command":["old-gonavi","mcp-server"],"enabled":true}}}`), 0o644); err != nil {
		t.Fatalf("WriteFile OpenCode config returned error: %v", err)
	}

	service := NewService()
	service.AISetLanguage(string(i18n.LanguageEnUS))
	hanText := regexp.MustCompile(`\p{Han}`)

	localMCPExecutablePathFunc = func() (string, error) {
		return "", errors.New("executable lookup denied")
	}
	if _, err := service.AIInstallClaudeCodeMCP(); err == nil {
		t.Fatal("expected Claude Code install executable path error")
	} else if hanText.MatchString(err.Error()) || !strings.Contains(err.Error(), "Failed to locate the current GoNavi executable") || !strings.Contains(err.Error(), "executable lookup denied") {
		t.Fatalf("Claude Code executable path error should use English wrapper and keep raw detail, got %q", err.Error())
	}
	statuses := service.AIGetMCPClientInstallStatuses()
	if len(statuses) < 3 {
		t.Fatalf("expected Claude Code, Codex, and OpenCode statuses, got %d", len(statuses))
	}
	for _, status := range statuses[:3] {
		if hanText.MatchString(status.Message) || !strings.Contains(status.Message, "Failed to locate the current GoNavi executable") || !strings.Contains(status.Message, "executable lookup denied") {
			t.Fatalf("%s status executable path error should use English wrapper and keep raw detail, got %q", status.Client, status.Message)
		}
	}

	localMCPExecutablePathFunc = func() (string, error) {
		return "   ", nil
	}
	if _, err := service.AIInstallCodexMCP(); err == nil {
		t.Fatal("expected Codex install empty executable path error")
	} else if hanText.MatchString(err.Error()) || !strings.Contains(err.Error(), "Current GoNavi executable path is empty") {
		t.Fatalf("Codex empty executable path error should use English wrapper, got %q", err.Error())
	}
	statuses = service.AIGetMCPClientInstallStatuses()
	for _, status := range statuses[:3] {
		if hanText.MatchString(status.Message) || !strings.Contains(status.Message, "Current GoNavi executable path is empty") {
			t.Fatalf("%s status empty executable path error should use English wrapper, got %q", status.Client, status.Message)
		}
	}
}

func TestMCPClientInstallConfigFormatFailuresUseServiceLanguage(t *testing.T) {
	disableLocalCLICommandShellFallback(t)
	isolateOpenCodeMCPConfig(t)
	isolateAdditionalMCPClientConfigs(t)
	mockLocalMCPClientCommandsDetected(t)
	originalClaudeConfigPathFunc := claudeCodeConfigPathFunc
	originalCodexConfigPathFunc := codexConfigPathFunc
	originalExecutablePathFunc := localMCPExecutablePathFunc
	t.Cleanup(func() {
		claudeCodeConfigPathFunc = originalClaudeConfigPathFunc
		codexConfigPathFunc = originalCodexConfigPathFunc
		localMCPExecutablePathFunc = originalExecutablePathFunc
	})

	tempDir := t.TempDir()
	claudeConfigPath := filepath.Join(tempDir, ".claude.json")
	codexConfigPath := filepath.Join(tempDir, ".codex", "config.toml")
	claudeCodeConfigPathFunc = func() (string, error) {
		return claudeConfigPath, nil
	}
	codexConfigPathFunc = func() (string, error) {
		return codexConfigPath, nil
	}
	localMCPExecutablePathFunc = func() (string, error) {
		return `C:\Program Files\GoNavi\GoNavi.exe`, nil
	}

	service := NewService()
	service.AISetLanguage(string(i18n.LanguageEnUS))
	hanText := regexp.MustCompile(`\p{Han}`)

	if err := os.WriteFile(claudeConfigPath, []byte(`{"mcpServers":[]}`), 0o644); err != nil {
		t.Fatalf("WriteFile Claude config returned error: %v", err)
	}
	if _, err := service.AIInstallClaudeCodeMCP(); err == nil {
		t.Fatal("expected Claude Code invalid config shape error")
	} else if hanText.MatchString(err.Error()) || !strings.Contains(err.Error(), "Claude Code configuration format is invalid") || !strings.Contains(err.Error(), "mcpServers") {
		t.Fatalf("Claude Code config format error should use English wrapper and keep raw path segment, got %q", err.Error())
	}

	if err := os.WriteFile(claudeConfigPath, []byte(`{"mcpServers":{"gonavi":[]}}`), 0o644); err != nil {
		t.Fatalf("WriteFile Claude config returned error: %v", err)
	}
	statuses := service.AIGetMCPClientInstallStatuses()
	if len(statuses) < 2 {
		t.Fatalf("expected at least Claude Code and Codex statuses, got %d", len(statuses))
	}
	if hanText.MatchString(statuses[0].Message) || !strings.Contains(statuses[0].Message, "Claude Code configuration format is invalid") || !strings.Contains(statuses[0].Message, "mcpServers.gonavi") {
		t.Fatalf("Claude Code status format error should use English wrapper and keep raw path segment, got %q", statuses[0].Message)
	}

	if err := os.MkdirAll(filepath.Dir(codexConfigPath), 0o755); err != nil {
		t.Fatalf("MkdirAll Codex config dir returned error: %v", err)
	}
	if err := os.WriteFile(codexConfigPath, []byte("[mcp_servers.gonavi]\ncommand = [bad]\n"), 0o644); err != nil {
		t.Fatalf("WriteFile Codex config returned error: %v", err)
	}
	statuses = service.AIGetMCPClientInstallStatuses()
	if hanText.MatchString(statuses[1].Message) || !strings.Contains(statuses[1].Message, "Codex configuration format is invalid") || !strings.Contains(statuses[1].Message, "mcp_servers.gonavi.command") {
		t.Fatalf("Codex status format error should use English wrapper and keep raw path segment, got %q", statuses[1].Message)
	}
}

func TestMCPClientInstallConfigIOFailuresUseServiceLanguage(t *testing.T) {
	tempDir := t.TempDir()
	service := NewService()
	service.AISetLanguage(string(i18n.LanguageEnUS))
	hanText := regexp.MustCompile(`\p{Han}`)

	claudeConfigDir := filepath.Join(tempDir, "claude-dir")
	if err := os.MkdirAll(claudeConfigDir, 0o755); err != nil {
		t.Fatalf("MkdirAll Claude config dir returned error: %v", err)
	}
	if _, err := readClaudeCodeConfig(claudeConfigDir, service.serviceText); err == nil {
		t.Fatal("expected Claude Code read config error")
	} else if hanText.MatchString(err.Error()) || !strings.Contains(err.Error(), "Failed to read Claude Code configuration") {
		t.Fatalf("Claude Code read error should use English wrapper, got %q", err.Error())
	}

	invalidClaudeConfigPath := filepath.Join(tempDir, ".claude-invalid.json")
	if err := os.WriteFile(invalidClaudeConfigPath, []byte(`{"mcpServers":`), 0o644); err != nil {
		t.Fatalf("WriteFile invalid Claude config returned error: %v", err)
	}
	if _, err := readClaudeCodeConfig(invalidClaudeConfigPath, service.serviceText); err == nil {
		t.Fatal("expected Claude Code parse config error")
	} else if hanText.MatchString(err.Error()) || !strings.Contains(err.Error(), "Failed to parse Claude Code configuration") {
		t.Fatalf("Claude Code parse error should use English wrapper, got %q", err.Error())
	}

	blockingFile := filepath.Join(tempDir, "blocking-file")
	if err := os.WriteFile(blockingFile, []byte("not a directory"), 0o644); err != nil {
		t.Fatalf("WriteFile blocking file returned error: %v", err)
	}
	blockedClaudeConfigPath := filepath.Join(blockingFile, ".claude.json")
	if err := upsertClaudeCodeMCPServerConfig(blockedClaudeConfigPath, gonaviMCPServerID, claudeCodeMCPServerConfig{
		Type:    "stdio",
		Command: "GoNavi.exe",
	}, service.serviceText); err == nil {
		t.Fatal("expected Claude Code directory creation error")
	} else if hanText.MatchString(err.Error()) || !strings.Contains(err.Error(), "Failed to create Claude Code configuration directory") {
		t.Fatalf("Claude Code directory creation error should use English wrapper, got %q", err.Error())
	}

	codexConfigDir := filepath.Join(tempDir, "codex-dir")
	if err := os.MkdirAll(codexConfigDir, 0o755); err != nil {
		t.Fatalf("MkdirAll Codex config dir returned error: %v", err)
	}
	if _, _, err := readCodexMCPServerConfig(codexConfigDir, gonaviMCPServerID, service.serviceText); err == nil {
		t.Fatal("expected Codex read config error")
	} else if hanText.MatchString(err.Error()) || !strings.Contains(err.Error(), "Failed to read Codex configuration") {
		t.Fatalf("Codex read error should use English wrapper, got %q", err.Error())
	}

	blockedCodexConfigPath := filepath.Join(blockingFile, "config.toml")
	if err := upsertCodexMCPServerConfig(blockedCodexConfigPath, gonaviMCPServerID, codexMCPServerConfig{
		Command: "GoNavi.exe",
		Args:    []string{"mcp-server"},
	}, service.serviceText); err == nil {
		t.Fatal("expected Codex directory creation error")
	} else if hanText.MatchString(err.Error()) || !strings.Contains(err.Error(), "Failed to create Codex configuration directory") {
		t.Fatalf("Codex directory creation error should use English wrapper, got %q", err.Error())
	}
}

func TestMCPClientInstallMessageCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"ai.service.mcp_client.claude_code.install_success",
		"ai.service.mcp_client.codex.install_success",
		"ai.service.mcp_client.opencode.install_success",
		"ai.service.mcp_client.user_home_dir_unavailable",
		"ai.service.mcp_client.claude_code.config_path_failed",
		"ai.service.mcp_client.codex.config_path_failed",
		"ai.service.mcp_client.opencode.config_path_failed",
		"ai.service.mcp_client.executable_path_failed",
		"ai.service.mcp_client.executable_path_empty",
		"ai.service.mcp_client.claude_code.config_format_invalid",
		"ai.service.mcp_client.codex.config_format_invalid",
		"ai.service.mcp_client.opencode.config_format_invalid",
		"ai.service.mcp_client.claude_code.config_read_failed",
		"ai.service.mcp_client.claude_code.config_parse_failed",
		"ai.service.mcp_client.claude_code.config_serialize_failed",
		"ai.service.mcp_client.claude_code.config_dir_create_failed",
		"ai.service.mcp_client.claude_code.config_write_failed",
		"ai.service.mcp_client.codex.config_read_failed",
		"ai.service.mcp_client.codex.config_dir_create_failed",
		"ai.service.mcp_client.codex.config_write_failed",
		"ai.service.mcp_client.opencode.config_read_failed",
		"ai.service.mcp_client.opencode.config_parse_failed",
		"ai.service.mcp_client.opencode.config_serialize_failed",
		"ai.service.mcp_client.opencode.config_dir_create_failed",
		"ai.service.mcp_client.opencode.config_write_failed",
		"ai.service.mcp_client.claude_code.status.missing",
		"ai.service.mcp_client.codex.status.missing",
		"ai.service.mcp_client.opencode.status.missing",
		"ai.service.mcp_client.claude_code.status.path_check_failed",
		"ai.service.mcp_client.codex.status.path_check_failed",
		"ai.service.mcp_client.opencode.status.path_check_failed",
		"ai.service.mcp_client.claude_code.status.connected",
		"ai.service.mcp_client.codex.status.connected",
		"ai.service.mcp_client.opencode.status.connected",
		"ai.service.mcp_client.claude_code.status.path_mismatch",
		"ai.service.mcp_client.codex.status.path_mismatch",
		"ai.service.mcp_client.opencode.status.path_mismatch",
		"ai.service.mcp_client.external.config_dir_create_failed",
		"ai.service.mcp_client.external.config_format_invalid",
		"ai.service.mcp_client.external.config_parse_failed",
		"ai.service.mcp_client.external.config_path_failed",
		"ai.service.mcp_client.external.config_read_failed",
		"ai.service.mcp_client.external.config_serialize_failed",
		"ai.service.mcp_client.external.config_write_failed",
		"ai.service.mcp_client.external.install_success",
		"ai.service.mcp_client.external.status.connected",
		"ai.service.mcp_client.external.status.missing",
		"ai.service.mcp_client.external.status.path_check_failed",
		"ai.service.mcp_client.external.status.path_mismatch",
		"ai.service.mcp_client.remote.status.message",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing MCP client install message key %q", language, key)
			}
		}
	}
}
