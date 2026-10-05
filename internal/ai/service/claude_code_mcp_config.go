package aiservice

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/ai"
)

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
	if !status.ClientDetected {
		status.Message = mcpClientInstallText(text, "ai.service.mcp_client.local_client_not_detected", map[string]any{
			"label":   status.DisplayName,
			"command": status.ClientCommand,
		})
		return status
	}
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
	if !status.ClientDetected {
		status.Message = mcpClientInstallText(text, "ai.service.mcp_client.local_client_not_detected", map[string]any{
			"label":   status.DisplayName,
			"command": status.ClientCommand,
		})
		return status
	}
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

	if err := writeMCPConfigFileAtomically(configPath, append(data, '\n')); err != nil {
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

	updated := replaceOrAppendTOMLMCPServerBlock(string(data), strings.TrimSpace(serverID), renderCodexMCPServerBlock(serverID, serverConfig))
	if err := writeMCPConfigFileAtomically(configPath, []byte(updated)); err != nil {
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
