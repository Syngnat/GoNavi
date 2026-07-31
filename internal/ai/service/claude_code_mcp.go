package aiservice

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/ai"
)

const (
	gonaviMCPServerID                   = "gonavi"
	defaultCodexMCPStartupTimeoutSecond = 60
	claudeCodeClientCommandName         = "claude"
	codexClientCommandName              = "codex"
	openCodeClientCommandName           = "opencode"
)

type mcpClientInstallTextFunc func(string, map[string]any) string

var errMCPClientUserHomeDirUnavailable = errors.New("user home directory is unavailable")

var claudeCodeConfigPathFunc = func() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	homeDir = strings.TrimSpace(homeDir)
	if homeDir == "" {
		return "", errMCPClientUserHomeDirUnavailable
	}
	return filepath.Join(homeDir, ".claude.json"), nil
}

var codexConfigPathFunc = func() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	homeDir = strings.TrimSpace(homeDir)
	if homeDir == "" {
		return "", errMCPClientUserHomeDirUnavailable
	}
	return filepath.Join(homeDir, ".codex", "config.toml"), nil
}

var localMCPExecutablePathFunc = os.Executable
var localCLICommandPathFunc = exec.LookPath

type claudeCodeMCPServerConfig struct {
	Type    string            `json:"type"`
	Command string            `json:"command"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

type codexMCPServerConfig struct {
	Command           string
	Args              []string
	StartupTimeoutSec int
}

// AIGetMCPClientInstallStatuses 返回 GoNavi MCP 在常见外部客户端中的安装状态。
func (s *Service) AIGetMCPClientInstallStatuses() []ai.MCPClientInstallStatus {
	command, args, resolveErr := resolveCurrentLocalMCPCommand(s.serviceText)
	return []ai.MCPClientInstallStatus{
		inspectClaudeCodeMCPInstallStatus(command, args, resolveErr, s.serviceText),
		inspectCodexMCPInstallStatus(command, args, resolveErr, s.serviceText),
		inspectOpenCodeMCPInstallStatus(command, args, resolveErr, s.serviceText),
		buildRemoteMCPClientInstallStatus("openclaw", "OpenClaw", s.serviceText),
		buildRemoteMCPClientInstallStatus("hermans", "Hermans", s.serviceText),
	}
}

// AIInstallClaudeCodeMCP 把 GoNavi 的 MCP server 写入 Claude Code 用户级 MCP 配置。
func (s *Service) AIInstallClaudeCodeMCP() (ai.MCPClientInstallResult, error) {
	configPath, err := claudeCodeConfigPathFunc()
	if err != nil {
		return ai.MCPClientInstallResult{}, fmt.Errorf("%s", s.serviceText("ai.service.mcp_client.claude_code.config_path_failed", map[string]any{"detail": localizeMCPClientPathDetail(s.serviceText, err)}))
	}

	executablePath, err := localMCPExecutablePathFunc()
	if err != nil {
		return ai.MCPClientInstallResult{}, fmt.Errorf("%s", s.serviceText("ai.service.mcp_client.executable_path_failed", map[string]any{"detail": err.Error()}))
	}

	command, args, err := resolveLocalMCPCommand(executablePath, s.serviceText)
	if err != nil {
		return ai.MCPClientInstallResult{}, err
	}

	serverConfig := claudeCodeMCPServerConfig{
		Type:    "stdio",
		Command: command,
		Args:    append([]string(nil), args...),
		Env:     map[string]string{},
	}
	if err := upsertClaudeCodeMCPServerConfig(configPath, gonaviMCPServerID, serverConfig, s.serviceText); err != nil {
		return ai.MCPClientInstallResult{}, err
	}

	return ai.MCPClientInstallResult{
		Success:    true,
		Client:     "claude-code",
		Message:    s.serviceText("ai.service.mcp_client.claude_code.install_success", nil),
		ConfigPath: configPath,
		Command:    command,
		Args:       append([]string(nil), args...),
	}, nil
}

// AIInstallCodexMCP 把 GoNavi 的 MCP server 写入 Codex 用户级 MCP 配置。
func (s *Service) AIInstallCodexMCP() (ai.MCPClientInstallResult, error) {
	configPath, err := codexConfigPathFunc()
	if err != nil {
		return ai.MCPClientInstallResult{}, fmt.Errorf("%s", s.serviceText("ai.service.mcp_client.codex.config_path_failed", map[string]any{"detail": localizeMCPClientPathDetail(s.serviceText, err)}))
	}

	executablePath, err := localMCPExecutablePathFunc()
	if err != nil {
		return ai.MCPClientInstallResult{}, fmt.Errorf("%s", s.serviceText("ai.service.mcp_client.executable_path_failed", map[string]any{"detail": err.Error()}))
	}

	command, args, err := resolveLocalMCPCommand(executablePath, s.serviceText)
	if err != nil {
		return ai.MCPClientInstallResult{}, err
	}

	serverConfig := codexMCPServerConfig{
		Command:           command,
		Args:              append([]string(nil), args...),
		StartupTimeoutSec: defaultCodexMCPStartupTimeoutSecond,
	}
	if err := upsertCodexMCPServerConfig(configPath, gonaviMCPServerID, serverConfig, s.serviceText); err != nil {
		return ai.MCPClientInstallResult{}, err
	}

	return ai.MCPClientInstallResult{
		Success:    true,
		Client:     "codex",
		Message:    s.serviceText("ai.service.mcp_client.codex.install_success", nil),
		ConfigPath: configPath,
		Command:    command,
		Args:       append([]string(nil), args...),
	}, nil
}

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
	return errors.Join(repairErrors...)
}

func repairClaudeCodeMCPClientConfig(expectedCommand string, expectedArgs []string, text mcpClientInstallTextFunc) error {
	configPath, err := claudeCodeConfigPathFunc()
	if err != nil {
		return err
	}
	serverConfig, found, err := readClaudeCodeMCPServerConfig(configPath, gonaviMCPServerID, text)
	if err != nil || !found || sameMCPCommand(serverConfig.Command, serverConfig.Args, expectedCommand, expectedArgs) {
		return err
	}
	if !strings.EqualFold(strings.TrimSpace(serverConfig.Type), "stdio") ||
		!shouldRepairInstalledLocalMCPCommand(serverConfig.Command, serverConfig.Args, expectedCommand) {
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
	configPath, err := codexConfigPathFunc()
	if err != nil {
		return err
	}
	serverConfig, found, err := readCodexMCPServerConfig(configPath, gonaviMCPServerID, text)
	if err != nil || !found || sameMCPCommand(serverConfig.Command, serverConfig.Args, expectedCommand, expectedArgs) {
		return err
	}
	if !shouldRepairInstalledLocalMCPCommand(serverConfig.Command, serverConfig.Args, expectedCommand) {
		return nil
	}
	return upsertCodexMCPServerConfig(configPath, gonaviMCPServerID, codexMCPServerConfig{
		Command:           expectedCommand,
		Args:              append([]string(nil), expectedArgs...),
		StartupTimeoutSec: defaultCodexMCPStartupTimeoutSecond,
	}, text)
}

func shouldRepairInstalledLocalMCPCommand(command string, args []string, expectedCommand string) bool {
	command = strings.TrimSpace(command)
	if command == "" || !isManagedLocalMCPCommand(command, args) {
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
			(strings.HasPrefix(baseName, "gonavi-") && strings.HasSuffix(baseName, ".appimage"))
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
	default:
		return cleaned, []string{"mcp-server"}, nil
	}
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

func detectLocalCLICommand(commandName string) (bool, string) {
	commandName = strings.TrimSpace(commandName)
	if commandName == "" {
		return false, ""
	}
	resolvedPath, err := localCLICommandPathFunc(commandName)
	if err != nil {
		return false, ""
	}
	resolvedPath = strings.TrimSpace(resolvedPath)
	if resolvedPath == "" {
		return false, ""
	}
	return true, filepath.Clean(resolvedPath)
}

func mcpClientInstallText(text mcpClientInstallTextFunc, key string, params map[string]any) string {
	if text == nil {
		return serviceTextFromLocalizer(nil, key, params)
	}
	return text(key, params)
}

func firstMCPClientInstallText(textFuncs []mcpClientInstallTextFunc) mcpClientInstallTextFunc {
	if len(textFuncs) == 0 {
		return nil
	}
	return textFuncs[0]
}

func localizeMCPClientPathDetail(text mcpClientInstallTextFunc, err error) string {
	if err == nil {
		return ""
	}
	detail := strings.TrimSpace(err.Error())
	if errors.Is(err, errMCPClientUserHomeDirUnavailable) || detail == errMCPClientUserHomeDirUnavailable.Error() {
		return mcpClientInstallText(text, "ai.service.mcp_client.user_home_dir_unavailable", nil)
	}
	return detail
}

func inspectClaudeCodeMCPInstallStatus(expectedCommand string, expectedArgs []string, expectedErr error, textFuncs ...mcpClientInstallTextFunc) ai.MCPClientInstallStatus {
	text := firstMCPClientInstallText(textFuncs)
	configPath, pathErr := claudeCodeConfigPathFunc()
	clientDetected, clientPath := detectLocalCLICommand(claudeCodeClientCommandName)
	status := ai.MCPClientInstallStatus{
		Client:         "claude-code",
		DisplayName:    "Claude Code",
		InstallMode:    "auto",
		ClientDetected: clientDetected,
		ClientCommand:  claudeCodeClientCommandName,
		ClientPath:     clientPath,
		ConfigPath:     strings.TrimSpace(configPath),
		Message:        mcpClientInstallText(text, "ai.service.mcp_client.claude_code.status.missing", nil),
	}
	if pathErr != nil {
		status.Message = mcpClientInstallText(text, "ai.service.mcp_client.claude_code.config_path_failed", map[string]any{"detail": localizeMCPClientPathDetail(text, pathErr)})
		return status
	}

	serverConfig, found, err := readClaudeCodeMCPServerConfig(configPath, gonaviMCPServerID, text)
	if err != nil {
		status.Installed = found
		status.Message = err.Error()
		if found {
			status.Command = strings.TrimSpace(serverConfig.Command)
			status.Args = append([]string(nil), serverConfig.Args...)
		}
		return status
	}
	if !found {
		return status
	}

	status.Installed = true
	status.Command = strings.TrimSpace(serverConfig.Command)
	status.Args = append([]string(nil), serverConfig.Args...)
	if expectedErr != nil {
		status.Message = mcpClientInstallText(text, "ai.service.mcp_client.claude_code.status.path_check_failed", map[string]any{"detail": expectedErr.Error()})
		return status
	}

	status.MatchesCurrent = strings.EqualFold(strings.TrimSpace(serverConfig.Type), "stdio") &&
		sameMCPCommand(serverConfig.Command, serverConfig.Args, expectedCommand, expectedArgs)
	if status.MatchesCurrent {
		status.Message = mcpClientInstallText(text, "ai.service.mcp_client.claude_code.status.connected", nil)
		return status
	}

	status.Message = mcpClientInstallText(text, "ai.service.mcp_client.claude_code.status.path_mismatch", nil)
	return status
}

func inspectCodexMCPInstallStatus(expectedCommand string, expectedArgs []string, expectedErr error, textFuncs ...mcpClientInstallTextFunc) ai.MCPClientInstallStatus {
	text := firstMCPClientInstallText(textFuncs)
	configPath, pathErr := codexConfigPathFunc()
	clientDetected, clientPath := detectLocalCLICommand(codexClientCommandName)
	status := ai.MCPClientInstallStatus{
		Client:         "codex",
		DisplayName:    "Codex",
		InstallMode:    "auto",
		ClientDetected: clientDetected,
		ClientCommand:  codexClientCommandName,
		ClientPath:     clientPath,
		ConfigPath:     strings.TrimSpace(configPath),
		Message:        mcpClientInstallText(text, "ai.service.mcp_client.codex.status.missing", nil),
	}
	if pathErr != nil {
		status.Message = mcpClientInstallText(text, "ai.service.mcp_client.codex.config_path_failed", map[string]any{"detail": localizeMCPClientPathDetail(text, pathErr)})
		return status
	}

	serverConfig, found, err := readCodexMCPServerConfig(configPath, gonaviMCPServerID, text)
	if err != nil {
		status.Installed = found
		status.Message = err.Error()
		if found {
			status.Command = strings.TrimSpace(serverConfig.Command)
			status.Args = append([]string(nil), serverConfig.Args...)
		}
		return status
	}
	if !found {
		return status
	}

	status.Installed = true
	status.Command = strings.TrimSpace(serverConfig.Command)
	status.Args = append([]string(nil), serverConfig.Args...)
	if expectedErr != nil {
		status.Message = mcpClientInstallText(text, "ai.service.mcp_client.codex.status.path_check_failed", map[string]any{"detail": expectedErr.Error()})
		return status
	}

	status.MatchesCurrent = sameMCPCommand(serverConfig.Command, serverConfig.Args, expectedCommand, expectedArgs) &&
		(serverConfig.StartupTimeoutSec == 0 || serverConfig.StartupTimeoutSec == defaultCodexMCPStartupTimeoutSecond)
	if status.MatchesCurrent {
		status.Message = mcpClientInstallText(text, "ai.service.mcp_client.codex.status.connected", nil)
		return status
	}

	status.Message = mcpClientInstallText(text, "ai.service.mcp_client.codex.status.path_mismatch", nil)
	return status
}

func buildRemoteMCPClientInstallStatus(client string, displayName string, textFuncs ...mcpClientInstallTextFunc) ai.MCPClientInstallStatus {
	text := firstMCPClientInstallText(textFuncs)
	return ai.MCPClientInstallStatus{
		Client:         client,
		DisplayName:    displayName,
		InstallMode:    "remote",
		ClientDetected: false,
		Message:        mcpClientInstallText(text, "ai.service.mcp_client.remote.status.message", map[string]any{"label": displayName}),
	}
}

func readClaudeCodeMCPServerConfig(configPath string, serverID string, textFuncs ...mcpClientInstallTextFunc) (claudeCodeMCPServerConfig, bool, error) {
	text := firstMCPClientInstallText(textFuncs)
	root, err := readClaudeCodeConfig(configPath, text)
	if err != nil {
		return claudeCodeMCPServerConfig{}, false, err
	}

	rawServers, exists := root["mcpServers"]
	if !exists || rawServers == nil {
		return claudeCodeMCPServerConfig{}, false, nil
	}
	mcpServers, ok := rawServers.(map[string]any)
	if !ok {
		return claudeCodeMCPServerConfig{}, false, fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.claude_code.config_format_invalid", map[string]any{"path": "mcpServers", "expected": "an object"}))
	}

	rawServer, exists := mcpServers[strings.TrimSpace(serverID)]
	if !exists || rawServer == nil {
		return claudeCodeMCPServerConfig{}, false, nil
	}
	serverMap, ok := rawServer.(map[string]any)
	if !ok {
		return claudeCodeMCPServerConfig{}, true, fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.claude_code.config_format_invalid", map[string]any{"path": fmt.Sprintf("mcpServers.%s", strings.TrimSpace(serverID)), "expected": "an object"}))
	}

	args, err := decodeJSONLikeStringSlice(serverMap["args"])
	if err != nil {
		return claudeCodeMCPServerConfig{}, true, fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.claude_code.config_format_invalid", map[string]any{"path": fmt.Sprintf("mcpServers.%s.args", strings.TrimSpace(serverID)), "expected": "a string array"}))
	}
	return claudeCodeMCPServerConfig{
		Type:    strings.TrimSpace(anyString(serverMap["type"])),
		Command: strings.TrimSpace(anyString(serverMap["command"])),
		Args:    args,
	}, true, nil
}

func upsertClaudeCodeMCPServerConfig(configPath string, serverID string, serverConfig claudeCodeMCPServerConfig, textFuncs ...mcpClientInstallTextFunc) error {
	text := firstMCPClientInstallText(textFuncs)
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		return fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.claude_code.config_dir_create_failed", map[string]any{"detail": err.Error()}))
	}
	root, err := readClaudeCodeConfig(configPath, text)
	if err != nil {
		return err
	}

	mcpServers, err := ensureJSONMap(root, "mcpServers", text)
	if err != nil {
		return err
	}

	mcpServers[strings.TrimSpace(serverID)] = map[string]any{
		"type":    serverConfig.Type,
		"command": serverConfig.Command,
		"args":    append([]string(nil), serverConfig.Args...),
		"env":     cloneStringMap(serverConfig.Env),
	}
	root["mcpServers"] = mcpServers

	data, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.claude_code.config_serialize_failed", map[string]any{"detail": err.Error()}))
	}

	if err := os.WriteFile(configPath, append(data, '\n'), 0o644); err != nil {
		return fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.claude_code.config_write_failed", map[string]any{"detail": err.Error()}))
	}
	return nil
}

func readClaudeCodeConfig(configPath string, textFuncs ...mcpClientInstallTextFunc) (map[string]any, error) {
	text := firstMCPClientInstallText(textFuncs)
	data, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}, nil
		}
		return nil, fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.claude_code.config_read_failed", map[string]any{"detail": err.Error()}))
	}

	if strings.TrimSpace(string(data)) == "" {
		return map[string]any{}, nil
	}

	var root map[string]any
	if err := json.Unmarshal(data, &root); err != nil {
		return nil, fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.claude_code.config_parse_failed", map[string]any{"detail": err.Error()}))
	}
	if root == nil {
		return map[string]any{}, nil
	}
	return root, nil
}

func ensureJSONMap(root map[string]any, key string, textFuncs ...mcpClientInstallTextFunc) (map[string]any, error) {
	text := firstMCPClientInstallText(textFuncs)
	if root == nil {
		return nil, fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.claude_code.config_format_invalid", map[string]any{"path": "JSON root", "expected": "an object"}))
	}

	value, exists := root[key]
	if !exists || value == nil {
		result := map[string]any{}
		root[key] = result
		return result, nil
	}

	typed, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.claude_code.config_format_invalid", map[string]any{"path": key, "expected": "an object"}))
	}
	return typed, nil
}

func readCodexMCPServerConfig(configPath string, serverID string, textFuncs ...mcpClientInstallTextFunc) (codexMCPServerConfig, bool, error) {
	text := firstMCPClientInstallText(textFuncs)
	data, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return codexMCPServerConfig{}, false, nil
		}
		return codexMCPServerConfig{}, false, fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.codex.config_read_failed", map[string]any{"detail": err.Error()}))
	}
	return parseCodexMCPServerConfig(string(data), serverID, textFuncs...)
}

func upsertCodexMCPServerConfig(configPath string, serverID string, serverConfig codexMCPServerConfig, textFuncs ...mcpClientInstallTextFunc) error {
	text := firstMCPClientInstallText(textFuncs)
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		return fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.codex.config_dir_create_failed", map[string]any{"detail": err.Error()}))
	}
	data, err := os.ReadFile(configPath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.codex.config_read_failed", map[string]any{"detail": err.Error()}))
	}

	updated := replaceOrAppendCodexMCPServerBlock(string(data), strings.TrimSpace(serverID), renderCodexMCPServerBlock(serverID, serverConfig))
	if err := os.WriteFile(configPath, []byte(updated), 0o644); err != nil {
		return fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.codex.config_write_failed", map[string]any{"detail": err.Error()}))
	}
	return nil
}

func renderCodexMCPServerBlock(serverID string, serverConfig codexMCPServerConfig) string {
	trimmedID := strings.TrimSpace(serverID)
	if trimmedID == "" {
		trimmedID = gonaviMCPServerID
	}

	lines := []string{
		fmt.Sprintf("[mcp_servers.%s]", trimmedID),
		fmt.Sprintf("command = %s", tomlString(serverConfig.Command)),
		fmt.Sprintf("args = [%s]", strings.Join(renderTomlStringArray(serverConfig.Args), ", ")),
	}
	if serverConfig.StartupTimeoutSec > 0 {
		lines = append(lines, fmt.Sprintf("startup_timeout_sec = %d", serverConfig.StartupTimeoutSec))
	}
	return strings.Join(lines, "\n") + "\n"
}

func parseCodexMCPServerConfig(content string, serverID string, textFuncs ...mcpClientInstallTextFunc) (codexMCPServerConfig, bool, error) {
	text := firstMCPClientInstallText(textFuncs)
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	mainHeader := fmt.Sprintf("[mcp_servers.%s]", strings.TrimSpace(serverID))
	result := codexMCPServerConfig{}
	found := false
	inside := false

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !inside {
			if trimmed == mainHeader {
				inside = true
				found = true
			}
			continue
		}
		if isTOMLHeaderLine(trimmed) {
			break
		}
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}

		key, value, ok := splitTOMLAssignment(trimmed)
		if !ok {
			continue
		}
		switch key {
		case "command":
			parsed, err := parseTOMLString(value)
			if err != nil {
				return result, true, fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.codex.config_format_invalid", map[string]any{"path": fmt.Sprintf("mcp_servers.%s.command", strings.TrimSpace(serverID)), "expected": "a TOML string"}))
			}
			result.Command = parsed
		case "args":
			parsed, err := parseTOMLStringArray(value)
			if err != nil {
				return result, true, fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.codex.config_format_invalid", map[string]any{"path": fmt.Sprintf("mcp_servers.%s.args", strings.TrimSpace(serverID)), "expected": "a TOML string array"}))
			}
			result.Args = parsed
		case "startup_timeout_sec":
			parsed, err := strconv.Atoi(strings.TrimSpace(value))
			if err != nil {
				return result, true, fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.codex.config_format_invalid", map[string]any{"path": fmt.Sprintf("mcp_servers.%s.startup_timeout_sec", strings.TrimSpace(serverID)), "expected": "an integer"}))
			}
			result.StartupTimeoutSec = parsed
		}
	}

	return result, found, nil
}

func replaceOrAppendCodexMCPServerBlock(content string, serverID string, block string) string {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	mainHeader := fmt.Sprintf("[mcp_servers.%s]", serverID)
	nestedPrefix := fmt.Sprintf("[mcp_servers.%s.", serverID)

	start, end := -1, -1
	for index, line := range lines {
		trimmed := strings.TrimSpace(line)
		if start == -1 {
			if trimmed == mainHeader || strings.HasPrefix(trimmed, nestedPrefix) {
				start = index
			}
			continue
		}
		if isTOMLHeaderLine(trimmed) && trimmed != mainHeader && !strings.HasPrefix(trimmed, nestedPrefix) {
			end = index
			break
		}
	}
	if start != -1 && end == -1 {
		end = len(lines)
	}

	rendered := strings.TrimRight(block, "\n")
	if start == -1 {
		base := strings.TrimSpace(strings.Join(lines, "\n"))
		if base == "" {
			return rendered + "\n"
		}
		return strings.TrimRight(strings.Join(lines, "\n"), "\n") + "\n\n" + rendered + "\n"
	}

	before := strings.TrimRight(strings.Join(lines[:start], "\n"), "\n")
	after := strings.TrimLeft(strings.Join(lines[end:], "\n"), "\n")
	switch {
	case before == "" && after == "":
		return rendered + "\n"
	case before == "":
		return rendered + "\n\n" + after
	case after == "":
		return before + "\n\n" + rendered + "\n"
	default:
		return before + "\n\n" + rendered + "\n\n" + after
	}
}

func renderTomlStringArray(values []string) []string {
	rendered := make([]string, 0, len(values))
	for _, value := range values {
		rendered = append(rendered, tomlString(value))
	}
	return rendered
}

func tomlString(value string) string {
	if !strings.Contains(value, "'") && !strings.Contains(value, "\n") && !strings.Contains(value, "\r") {
		return "'" + value + "'"
	}
	return strconv.Quote(value)
}

func splitTOMLAssignment(line string) (string, string, bool) {
	index := strings.Index(line, "=")
	if index <= 0 {
		return "", "", false
	}
	key := strings.TrimSpace(line[:index])
	value := strings.TrimSpace(line[index+1:])
	if key == "" {
		return "", "", false
	}
	return key, value, true
}

func parseTOMLString(value string) (string, error) {
	value = strings.TrimSpace(value)
	if len(value) < 2 {
		return "", fmt.Errorf("invalid string format")
	}
	switch value[0] {
	case '\'':
		if value[len(value)-1] != '\'' {
			return "", fmt.Errorf("single-quoted string is not closed")
		}
		return value[1 : len(value)-1], nil
	case '"':
		parsed, err := strconv.Unquote(value)
		if err != nil {
			return "", err
		}
		return parsed, nil
	default:
		return "", fmt.Errorf("not a string")
	}
}

func parseTOMLStringArray(value string) ([]string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return []string{}, nil
	}
	if !strings.HasPrefix(value, "[") || !strings.HasSuffix(value, "]") {
		return nil, fmt.Errorf("not an array")
	}

	inner := strings.TrimSpace(value[1 : len(value)-1])
	if inner == "" {
		return []string{}, nil
	}

	result := make([]string, 0, 4)
	for inner != "" {
		item, rest, err := consumeTOMLQuotedString(inner)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
		inner = strings.TrimSpace(rest)
		if inner == "" {
			break
		}
		if !strings.HasPrefix(inner, ",") {
			return nil, fmt.Errorf("invalid array separator")
		}
		inner = strings.TrimSpace(inner[1:])
	}
	return result, nil
}

func consumeTOMLQuotedString(value string) (string, string, error) {
	value = strings.TrimLeft(value, " \t")
	if value == "" {
		return "", "", fmt.Errorf("string is empty")
	}
	switch value[0] {
	case '\'':
		end := strings.IndexByte(value[1:], '\'')
		if end < 0 {
			return "", "", fmt.Errorf("single-quoted string is not closed")
		}
		end++
		return value[1:end], value[end+1:], nil
	case '"':
		escaped := false
		for index := 1; index < len(value); index++ {
			ch := value[index]
			if escaped {
				escaped = false
				continue
			}
			if ch == '\\' {
				escaped = true
				continue
			}
			if ch == '"' {
				parsed, err := strconv.Unquote(value[:index+1])
				if err != nil {
					return "", "", err
				}
				return parsed, value[index+1:], nil
			}
		}
		return "", "", fmt.Errorf("double-quoted string is not closed")
	default:
		return "", "", fmt.Errorf("not a string")
	}
}

func decodeJSONLikeStringSlice(value any) ([]string, error) {
	switch typed := value.(type) {
	case nil:
		return []string{}, nil
	case []string:
		return append([]string(nil), typed...), nil
	case []any:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			str, ok := item.(string)
			if !ok {
				return nil, fmt.Errorf("array element is not a string")
			}
			result = append(result, str)
		}
		return result, nil
	default:
		return nil, fmt.Errorf("not a string array")
	}
}

func anyString(value any) string {
	text, _ := value.(string)
	return text
}

func sameMCPCommand(actualCommand string, actualArgs []string, expectedCommand string, expectedArgs []string) bool {
	return strings.TrimSpace(actualCommand) == strings.TrimSpace(expectedCommand) &&
		reflect.DeepEqual(normalizeStringSlice(actualArgs), normalizeStringSlice(expectedArgs))
}

func normalizeStringSlice(values []string) []string {
	if len(values) == 0 {
		return []string{}
	}
	result := make([]string, 0, len(values))
	for _, value := range values {
		result = append(result, strings.TrimSpace(value))
	}
	return result
}

func isTOMLHeaderLine(line string) bool {
	line = strings.TrimSpace(line)
	return strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]")
}
