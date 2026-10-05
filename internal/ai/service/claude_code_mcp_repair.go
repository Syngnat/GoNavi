package aiservice

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// RepairInstalledLocalMCPClientConfigs refreshes stale GoNavi-owned client
// entries after an update or application move. Missing entries and custom
// entries that happen to use the gonavi key are left untouched.
func RepairInstalledLocalMCPClientConfigs(s *Service) error {
	if s == nil {
		return nil
	}
	return s.repairInstalledLocalMCPClientConfigs()
}

func (s *Service) repairInstalledLocalMCPClientConfigs() error {
	command, args, err := resolveCurrentLocalMCPCommand(s.serviceText)
	if err != nil {
		return err
	}

	var repairErrors []error
	if err := repairClaudeCodeMCPClientConfig(command, args, s.serviceText); err != nil {
		repairErrors = append(repairErrors, fmt.Errorf("Claude Code: %w", err))
	}
	if err := repairCodexMCPClientConfig(command, args, s.serviceText); err != nil {
		repairErrors = append(repairErrors, fmt.Errorf("Codex: %w", err))
	}
	if err := repairOpenCodeMCPClientConfig(command, args, s.serviceText); err != nil {
		repairErrors = append(repairErrors, fmt.Errorf("OpenCode: %w", err))
	}
	if err := repairExternalJSONMCPClientConfig(cursorMCPClientSpec, command, args, s.serviceText); err != nil {
		repairErrors = append(repairErrors, fmt.Errorf("Cursor: %w", err))
	}
	if err := repairExternalJSONMCPClientConfig(zCodeMCPClientSpec, command, args, s.serviceText); err != nil {
		repairErrors = append(repairErrors, fmt.Errorf("ZCode: %w", err))
	}
	if err := repairDeepSeekHarnessMCPClientConfig(command, args, s.serviceText); err != nil {
		repairErrors = append(repairErrors, fmt.Errorf("DeepSeek Harness: %w", err))
	}
	if err := repairExternalJSONMCPClientConfig(kimiCodeMCPClientSpec, command, args, s.serviceText); err != nil {
		repairErrors = append(repairErrors, fmt.Errorf("Kimi Code: %w", err))
	}
	if err := repairGrokBuildMCPClientConfig(command, args, s.serviceText); err != nil {
		repairErrors = append(repairErrors, fmt.Errorf("Grok Build: %w", err))
	}
	return errors.Join(repairErrors...)
}

func repairClaudeCodeMCPClientConfig(expectedCommand string, expectedArgs []string, text mcpClientInstallTextFunc) error {
	if !isLocalMCPClientCommandDetected(claudeCodeClientCommandName) {
		return nil
	}
	configPath, err := claudeCodeConfigPathFunc()
	if err != nil {
		return err
	}
	serverConfig, found, err := readClaudeCodeMCPServerConfig(configPath, gonaviMCPServerID, text)
	if err != nil || !found || sameMCPCommand(serverConfig.Command, serverConfig.Args, expectedCommand, expectedArgs) {
		return err
	}
	if !strings.EqualFold(strings.TrimSpace(serverConfig.Type), "stdio") ||
		!shouldRepairInstalledLocalMCPCommand(serverConfig.Command, serverConfig.Args, expectedCommand, expectedArgs) {
		return nil
	}
	return upsertClaudeCodeMCPServerConfig(configPath, gonaviMCPServerID, claudeCodeMCPServerConfig{
		Type:    "stdio",
		Command: expectedCommand,
		Args:    append([]string(nil), expectedArgs...),
		Env:     map[string]string{},
	}, text)
}

func repairCodexMCPClientConfig(expectedCommand string, expectedArgs []string, text mcpClientInstallTextFunc) error {
	if !isLocalMCPClientCommandDetected(codexClientCommandName) {
		return nil
	}
	configPath, err := codexConfigPathFunc()
	if err != nil {
		return err
	}
	serverConfig, found, err := readCodexMCPServerConfig(configPath, gonaviMCPServerID, text)
	if err != nil || !found || sameMCPCommand(serverConfig.Command, serverConfig.Args, expectedCommand, expectedArgs) {
		return err
	}
	if !shouldRepairInstalledLocalMCPCommand(serverConfig.Command, serverConfig.Args, expectedCommand, expectedArgs) {
		return nil
	}
	return upsertCodexMCPServerConfig(configPath, gonaviMCPServerID, codexMCPServerConfig{
		Command:           expectedCommand,
		Args:              append([]string(nil), expectedArgs...),
		StartupTimeoutSec: defaultCodexMCPStartupTimeoutSecond,
	}, text)
}

func shouldRepairInstalledLocalMCPCommand(command string, args []string, expectedCommand string, expectedArgs ...[]string) bool {
	command = strings.TrimSpace(command)
	normalizedArgs := normalizeStringSlice(args)
	normalizedExpectedArgs := []string(nil)
	if len(expectedArgs) > 0 {
		normalizedExpectedArgs = normalizeStringSlice(expectedArgs[0])
	}
	if isWailsDevelopmentMCPCommand(command, normalizedArgs) {
		// Wails replaces this executable on every backend rebuild. It must never
		// remain registered as a long-lived MCP process on Windows. Only a dev
		// instance may migrate it, so a production launch cannot overwrite a
		// developer's active source-tree configuration.
		return isWailsDevelopmentDedicatedMCPCommand(expectedCommand, normalizedExpectedArgs)
	}
	if isWailsDevelopmentGoRunMCPCommand(command, normalizedArgs) {
		return isWailsDevelopmentDedicatedMCPCommand(expectedCommand, normalizedExpectedArgs)
	}
	if isWailsDevelopmentDedicatedMCPCommand(command, normalizedArgs) {
		return isWailsDevelopmentDedicatedMCPCommand(expectedCommand, normalizedExpectedArgs)
	}
	if command == "" || !isManagedLocalMCPCommand(command, normalizedArgs) {
		return false
	}
	_, err := os.Stat(command)
	if errors.Is(err, os.ErrNotExist) {
		return true
	}
	return isSameDirectoryVersionedWindowsGoNaviCommand(command, expectedCommand)
}

func isSameDirectoryVersionedWindowsGoNaviCommand(command string, expectedCommand string) bool {
	if !isVersionedWindowsGoNaviExecutable(command) || !isVersionedWindowsGoNaviExecutable(expectedCommand) {
		return false
	}
	return strings.EqualFold(portablePathDir(command), portablePathDir(expectedCommand))
}

func isVersionedWindowsGoNaviExecutable(command string) bool {
	baseName := strings.ToLower(portablePathBase(command))
	return strings.HasPrefix(baseName, "gonavi-") &&
		strings.Contains(baseName, "-windows-") &&
		strings.HasSuffix(baseName, ".exe")
}

func isManagedLocalMCPCommand(command string, args []string) bool {
	normalizedArgs := normalizeStringSlice(args)
	if len(normalizedArgs) == 1 && strings.EqualFold(normalizedArgs[0], "mcp-server") {
		baseName := strings.ToLower(portablePathBase(command))
		return baseName == "gonavi" || baseName == "gonavi.exe" ||
			strings.HasPrefix(baseName, "gonavi-build-") ||
			isVersionedWindowsGoNaviExecutable(command) ||
			(strings.HasPrefix(baseName, "gonavi-") && strings.HasSuffix(baseName, ".appimage")) ||
			isWailsDevelopmentMCPCommand(command, normalizedArgs)
	}
	if isWailsDevelopmentGoRunMCPCommand(command, normalizedArgs) {
		return true
	}
	if isWailsDevelopmentDedicatedMCPCommand(command, normalizedArgs) {
		return true
	}
	if len(normalizedArgs) != 0 {
		return false
	}
	baseName := strings.ToLower(portablePathBase(command))
	return baseName == "gonavi-mcp-server" || baseName == "gonavi-mcp-server.exe"
}

func resolveCurrentLocalMCPCommand(textFuncs ...mcpClientInstallTextFunc) (string, []string, error) {
	text := firstMCPClientInstallText(textFuncs)
	executablePath, err := localMCPExecutablePathFunc()
	if err != nil {
		return "", nil, fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.executable_path_failed", map[string]any{"detail": err.Error()}))
	}
	command, args, err := resolveLocalMCPCommand(executablePath, text)
	if err != nil {
		return "", nil, err
	}
	return command, args, nil
}

func resolveLocalMCPCommand(executablePath string, textFuncs ...mcpClientInstallTextFunc) (string, []string, error) {
	text := firstMCPClientInstallText(textFuncs)
	executablePath = strings.TrimSpace(executablePath)
	if executablePath == "" {
		return "", nil, fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.executable_path_empty", nil))
	}

	cleaned := filepath.Clean(executablePath)
	baseName := strings.ToLower(portablePathBase(cleaned))
	switch baseName {
	case "gonavi-mcp-server", "gonavi-mcp-server.exe":
		return cleaned, []string{}, nil
	}

	if repoRoot, isDevelopmentBuild := wailsDevelopmentRepoRoot(cleaned); isDevelopmentBuild {
		serverPath := wailsDevelopmentMCPServerExecutablePath(repoRoot, cleaned)
		if err := ensureWailsDevelopmentMCPServerExecutable(repoRoot, serverPath); err != nil {
			return "", nil, fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.executable_path_failed", map[string]any{"detail": err.Error()}))
		}
		return serverPath, []string{}, nil
	}

	return cleaned, []string{"mcp-server"}, nil
}

func isWailsDevelopmentMCPCommand(command string, normalizedArgs []string) bool {
	return len(normalizedArgs) == 1 &&
		strings.EqualFold(strings.TrimSpace(normalizedArgs[0]), "mcp-server") &&
		isWailsDevelopmentExecutable(command)
}

func isWailsDevelopmentGoRunMCPCommand(command string, normalizedArgs []string) bool {
	baseName := strings.ToLower(portablePathBase(command))
	if baseName != "go" && baseName != "go.exe" {
		return false
	}
	return len(normalizedArgs) == 4 &&
		strings.EqualFold(strings.TrimSpace(normalizedArgs[0]), "-C") &&
		strings.TrimSpace(normalizedArgs[1]) != "" &&
		strings.EqualFold(strings.TrimSpace(normalizedArgs[2]), "run") &&
		strings.EqualFold(strings.ReplaceAll(strings.TrimSpace(normalizedArgs[3]), "\\", "/"), "./cmd/gonavi-mcp-server")
}

func isWailsDevelopmentDedicatedMCPCommand(command string, normalizedArgs []string) bool {
	if len(normalizedArgs) != 0 {
		return false
	}
	baseName := strings.ToLower(portablePathBase(command))
	if baseName != "gonavi-mcp-server-dev" && baseName != "gonavi-mcp-server-dev.exe" {
		return false
	}
	binDir := portablePathDir(command)
	buildDir := portablePathDir(binDir)
	return strings.EqualFold(portablePathBase(binDir), "bin") &&
		strings.EqualFold(portablePathBase(buildDir), "build")
}

func isWailsDevelopmentExecutable(executablePath string) bool {
	baseName := strings.ToLower(portablePathBase(executablePath))
	if baseName != "gonavi-dev" && baseName != "gonavi-dev.exe" {
		return false
	}
	binDir := portablePathDir(executablePath)
	buildDir := portablePathDir(binDir)
	return strings.EqualFold(portablePathBase(binDir), "bin") &&
		strings.EqualFold(portablePathBase(buildDir), "build")
}

func wailsDevelopmentRepoRoot(executablePath string) (string, bool) {
	if !isWailsDevelopmentExecutable(executablePath) {
		return "", false
	}
	cleaned := filepath.Clean(strings.TrimSpace(executablePath))
	return filepath.Clean(filepath.Join(filepath.Dir(cleaned), "..", "..")), true
}

func wailsDevelopmentMCPServerExecutablePath(repoRoot string, developmentExecutable string) string {
	return filepath.Join(repoRoot, "build", "bin", "gonavi-mcp-server-dev"+filepath.Ext(filepath.Clean(developmentExecutable)))
}

func ensureWailsDevelopmentMCPServerExecutable(repoRoot string, serverPath string) error {
	wailsDevelopmentMCPBuildMu.Lock()
	defer wailsDevelopmentMCPBuildMu.Unlock()

	info, err := os.Stat(serverPath)
	if err == nil {
		if info.IsDir() {
			return fmt.Errorf("development MCP server path is a directory: %s", serverPath)
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := buildWailsDevelopmentMCPServerFunc(repoRoot, serverPath); err != nil {
		return err
	}
	info, err = os.Stat(serverPath)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return fmt.Errorf("development MCP server path is a directory: %s", serverPath)
	}
	return nil
}

func buildWailsDevelopmentMCPServer(repoRoot string, serverPath string) error {
	goCommand, err := exec.LookPath("go")
	if err != nil {
		return err
	}
	command := exec.Command(goCommand, "build", "-o", serverPath, "./cmd/gonavi-mcp-server")
	command.Dir = repoRoot
	output, err := command.CombinedOutput()
	if err != nil {
		detail := strings.TrimSpace(string(output))
		if detail == "" {
			return fmt.Errorf("build development MCP server: %w", err)
		}
		return fmt.Errorf("build development MCP server: %w: %s", err, detail)
	}
	return nil
}

func portablePathBase(path string) string {
	normalized := strings.ReplaceAll(strings.TrimSpace(path), "\\", "/")
	return strings.TrimSpace(filepath.Base(normalized))
}

func portablePathDir(path string) string {
	normalized := strings.TrimRight(strings.ReplaceAll(strings.TrimSpace(path), "\\", "/"), "/")
	separator := strings.LastIndex(normalized, "/")
	if separator < 0 {
		return "."
	}
	if separator == 0 {
		return "/"
	}
	return normalized[:separator]
}
