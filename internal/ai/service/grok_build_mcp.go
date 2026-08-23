package aiservice

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/ai"
)

const (
	grokBuildClientCommandName              = "grok"
	defaultGrokBuildMCPStartupTimeoutSecond = 60
)

var grokBuildConfigPathFunc = resolveGrokBuildConfigPath

type grokBuildMCPServerConfig struct {
	Command           string
	Args              []string
	StartupTimeoutSec int
}

// AIInstallGrokBuildMCP writes GoNavi into Grok Build's user-level MCP config.
func (s *Service) AIInstallGrokBuildMCP() (ai.MCPClientInstallResult, error) {
	configPath, err := grokBuildConfigPathFunc()
	if err != nil {
		return ai.MCPClientInstallResult{}, externalMCPClientError(
			s.serviceText,
			"ai.service.mcp_client.external.config_path_failed",
			"Grok Build",
			map[string]any{"detail": localizeMCPClientPathDetail(s.serviceText, err)},
		)
	}
	if err := requireLocalMCPClientCommand(grokBuildClientCommandName, "Grok Build", s.serviceText); err != nil {
		return ai.MCPClientInstallResult{}, err
	}
	command, args, err := resolveCurrentLocalMCPCommand(s.serviceText)
	if err != nil {
		return ai.MCPClientInstallResult{}, err
	}

	if err := upsertGrokBuildMCPServerConfig(configPath, gonaviMCPServerID, grokBuildMCPServerConfig{
		Command:           command,
		Args:              append([]string(nil), args...),
		StartupTimeoutSec: defaultGrokBuildMCPStartupTimeoutSecond,
	}, s.serviceText); err != nil {
		return ai.MCPClientInstallResult{}, err
	}
	return ai.MCPClientInstallResult{
		Success:    true,
		Client:     "grok-build",
		Message:    externalMCPClientText(s.serviceText, "ai.service.mcp_client.external.install_success", "Grok Build", nil),
		ConfigPath: configPath,
		Command:    command,
		Args:       append([]string(nil), args...),
	}, nil
}

func resolveGrokBuildConfigPath() (string, error) {
	homeDir, err := resolveMCPClientUserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(homeDir, ".grok", "config.toml"), nil
}

func inspectGrokBuildMCPInstallStatus(expectedCommand string, expectedArgs []string, expectedErr error, textFuncs ...mcpClientInstallTextFunc) ai.MCPClientInstallStatus {
	text := firstMCPClientInstallText(textFuncs)
	configPath, pathErr := grokBuildConfigPathFunc()
	clientDetected, clientPath := detectLocalCLICommand(grokBuildClientCommandName)
	status := ai.MCPClientInstallStatus{
		Client:         "grok-build",
		DisplayName:    "Grok Build",
		InstallMode:    "auto",
		ClientDetected: clientDetected,
		ClientCommand:  grokBuildClientCommandName,
		ClientPath:     clientPath,
		ConfigPath:     strings.TrimSpace(configPath),
		Message:        externalMCPClientText(text, "ai.service.mcp_client.external.status.missing", "Grok Build", nil),
	}
	if pathErr != nil {
		status.Message = externalMCPClientText(text, "ai.service.mcp_client.external.config_path_failed", "Grok Build", map[string]any{"detail": localizeMCPClientPathDetail(text, pathErr)})
		return status
	}

	serverConfig, found, err := readGrokBuildMCPServerConfig(configPath, gonaviMCPServerID, text)
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
		status.Message = externalMCPClientText(text, "ai.service.mcp_client.local_client_not_detected", "Grok Build", map[string]any{
			"command": status.ClientCommand,
		})
		return status
	}
	if expectedErr != nil {
		status.Message = externalMCPClientText(text, "ai.service.mcp_client.external.status.path_check_failed", "Grok Build", map[string]any{"detail": expectedErr.Error()})
		return status
	}
	status.MatchesCurrent = sameMCPCommand(serverConfig.Command, serverConfig.Args, expectedCommand, expectedArgs) &&
		(serverConfig.StartupTimeoutSec == 0 || serverConfig.StartupTimeoutSec == defaultGrokBuildMCPStartupTimeoutSecond)
	if status.MatchesCurrent {
		status.Message = externalMCPClientText(text, "ai.service.mcp_client.external.status.connected", "Grok Build", nil)
		return status
	}
	status.Message = externalMCPClientText(text, "ai.service.mcp_client.external.status.path_mismatch", "Grok Build", nil)
	return status
}

func repairGrokBuildMCPClientConfig(expectedCommand string, expectedArgs []string, text mcpClientInstallTextFunc) error {
	if !isLocalMCPClientCommandDetected(grokBuildClientCommandName) {
		return nil
	}
	configPath, err := grokBuildConfigPathFunc()
	if err != nil {
		return err
	}
	serverConfig, found, err := readGrokBuildMCPServerConfig(configPath, gonaviMCPServerID, text)
	if err != nil || !found || sameMCPCommand(serverConfig.Command, serverConfig.Args, expectedCommand, expectedArgs) {
		return err
	}
	if !shouldRepairInstalledLocalMCPCommand(serverConfig.Command, serverConfig.Args, expectedCommand, expectedArgs) {
		return nil
	}
	return upsertGrokBuildMCPServerConfig(configPath, gonaviMCPServerID, grokBuildMCPServerConfig{
		Command:           expectedCommand,
		Args:              append([]string(nil), expectedArgs...),
		StartupTimeoutSec: defaultGrokBuildMCPStartupTimeoutSecond,
	}, text)
}

func readGrokBuildMCPServerConfig(configPath string, serverID string, textFuncs ...mcpClientInstallTextFunc) (grokBuildMCPServerConfig, bool, error) {
	text := firstMCPClientInstallText(textFuncs)
	data, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return grokBuildMCPServerConfig{}, false, nil
		}
		return grokBuildMCPServerConfig{}, false, externalMCPClientError(text, "ai.service.mcp_client.external.config_read_failed", "Grok Build", map[string]any{"detail": err.Error()})
	}
	return parseGrokBuildMCPServerConfig(string(data), serverID, text)
}

func upsertGrokBuildMCPServerConfig(configPath string, serverID string, serverConfig grokBuildMCPServerConfig, textFuncs ...mcpClientInstallTextFunc) error {
	text := firstMCPClientInstallText(textFuncs)
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		return externalMCPClientError(text, "ai.service.mcp_client.external.config_dir_create_failed", "Grok Build", map[string]any{"detail": err.Error()})
	}
	data, err := os.ReadFile(configPath)
	if err != nil && !os.IsNotExist(err) {
		return externalMCPClientError(text, "ai.service.mcp_client.external.config_read_failed", "Grok Build", map[string]any{"detail": err.Error()})
	}
	updated := replaceOrAppendTOMLMCPServerBlock(string(data), strings.TrimSpace(serverID), renderGrokBuildMCPServerBlock(serverID, serverConfig))
	if err := os.WriteFile(configPath, []byte(updated), 0o644); err != nil {
		return externalMCPClientError(text, "ai.service.mcp_client.external.config_write_failed", "Grok Build", map[string]any{"detail": err.Error()})
	}
	return nil
}

func renderGrokBuildMCPServerBlock(serverID string, serverConfig grokBuildMCPServerConfig) string {
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

func parseGrokBuildMCPServerConfig(content string, serverID string, textFuncs ...mcpClientInstallTextFunc) (grokBuildMCPServerConfig, bool, error) {
	text := firstMCPClientInstallText(textFuncs)
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	mainHeader := fmt.Sprintf("[mcp_servers.%s]", strings.TrimSpace(serverID))
	result := grokBuildMCPServerConfig{}
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
				return result, true, externalMCPClientError(text, "ai.service.mcp_client.external.config_format_invalid", "Grok Build", map[string]any{"path": fmt.Sprintf("mcp_servers.%s.command", strings.TrimSpace(serverID)), "expected": "a TOML string"})
			}
			result.Command = parsed
		case "args":
			parsed, err := parseTOMLStringArray(value)
			if err != nil {
				return result, true, externalMCPClientError(text, "ai.service.mcp_client.external.config_format_invalid", "Grok Build", map[string]any{"path": fmt.Sprintf("mcp_servers.%s.args", strings.TrimSpace(serverID)), "expected": "a TOML string array"})
			}
			result.Args = parsed
		case "startup_timeout_sec":
			parsed, err := strconv.Atoi(strings.TrimSpace(value))
			if err != nil {
				return result, true, externalMCPClientError(text, "ai.service.mcp_client.external.config_format_invalid", "Grok Build", map[string]any{"path": fmt.Sprintf("mcp_servers.%s.startup_timeout_sec", strings.TrimSpace(serverID)), "expected": "an integer"})
			}
			result.StartupTimeoutSec = parsed
		}
	}
	return result, found, nil
}
