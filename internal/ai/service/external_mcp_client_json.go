package aiservice

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/ai"
)

const (
	zCodeClientCommandName    = "zcode"
	kimiCodeClientCommandName = "kimi"
)

var zCodeConfigPathFunc = resolveZCodeConfigPath
var kimiCodeConfigPathFunc = resolveKimiCodeConfigPath

type externalJSONMCPClientSpec struct {
	Client         string
	DisplayName    string
	CLICommand     string
	ConfigPathFunc func() (string, error)
	ServerPath     []string
	EnabledKey     string
}

type externalJSONMCPServerConfig struct {
	Command string
	Args    []string
	Enabled bool
}

var zCodeMCPClientSpec = externalJSONMCPClientSpec{
	Client:      "zcode",
	DisplayName: "ZCode",
	CLICommand:  zCodeClientCommandName,
	ConfigPathFunc: func() (string, error) {
		return zCodeConfigPathFunc()
	},
	ServerPath: []string{"mcp", "servers"},
	EnabledKey: "enable",
}

var kimiCodeMCPClientSpec = externalJSONMCPClientSpec{
	Client:      "kimi",
	DisplayName: "Kimi Code",
	CLICommand:  kimiCodeClientCommandName,
	ConfigPathFunc: func() (string, error) {
		return kimiCodeConfigPathFunc()
	},
	ServerPath: []string{"mcpServers"},
	EnabledKey: "enabled",
}

// AIInstallZCodeMCP writes GoNavi into ZCode's user-level MCP config.
func (s *Service) AIInstallZCodeMCP() (ai.MCPClientInstallResult, error) {
	return s.installExternalJSONMCPClient(zCodeMCPClientSpec)
}

// AIInstallKimiMCP writes GoNavi into Kimi Code's user-level MCP config.
func (s *Service) AIInstallKimiMCP() (ai.MCPClientInstallResult, error) {
	return s.installExternalJSONMCPClient(kimiCodeMCPClientSpec)
}

func resolveZCodeConfigPath() (string, error) {
	homeDir, err := resolveMCPClientUserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(homeDir, ".zcode", "cli", "config.json"), nil
}

func resolveKimiCodeConfigPath() (string, error) {
	configRoot, err := resolveMCPClientConfigRoot("KIMI_CODE_HOME", ".kimi-code")
	if err != nil {
		return "", err
	}
	return filepath.Join(configRoot, "mcp.json"), nil
}

func resolveMCPClientUserHomeDir() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	homeDir = strings.TrimSpace(homeDir)
	if homeDir == "" {
		return "", errMCPClientUserHomeDirUnavailable
	}
	return filepath.Clean(homeDir), nil
}

func resolveMCPClientConfigRoot(envName string, defaultDirName string) (string, error) {
	configRoot := strings.TrimSpace(os.Getenv(envName))
	if configRoot != "" {
		return filepath.Clean(configRoot), nil
	}
	homeDir, err := resolveMCPClientUserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(homeDir, defaultDirName), nil
}

func (s *Service) installExternalJSONMCPClient(spec externalJSONMCPClientSpec) (ai.MCPClientInstallResult, error) {
	configPath, err := spec.ConfigPathFunc()
	if err != nil {
		return ai.MCPClientInstallResult{}, externalMCPClientError(
			s.serviceText,
			"ai.service.mcp_client.external.config_path_failed",
			spec.DisplayName,
			map[string]any{"detail": localizeMCPClientPathDetail(s.serviceText, err)},
		)
	}
	if err := requireLocalMCPClientCommand(spec.CLICommand, spec.DisplayName, s.serviceText); err != nil {
		return ai.MCPClientInstallResult{}, err
	}

	command, args, err := resolveCurrentLocalMCPCommand(s.serviceText)
	if err != nil {
		return ai.MCPClientInstallResult{}, err
	}

	if err := upsertExternalJSONMCPServerConfig(configPath, gonaviMCPServerID, command, args, spec, s.serviceText); err != nil {
		return ai.MCPClientInstallResult{}, err
	}
	return ai.MCPClientInstallResult{
		Success:    true,
		Client:     spec.Client,
		Message:    externalMCPClientText(s.serviceText, "ai.service.mcp_client.external.install_success", spec.DisplayName, nil),
		ConfigPath: configPath,
		Command:    command,
		Args:       append([]string(nil), args...),
	}, nil
}

func inspectExternalJSONMCPClientInstallStatus(spec externalJSONMCPClientSpec, expectedCommand string, expectedArgs []string, expectedErr error, textFuncs ...mcpClientInstallTextFunc) ai.MCPClientInstallStatus {
	text := firstMCPClientInstallText(textFuncs)
	configPath, pathErr := spec.ConfigPathFunc()
	clientDetected, clientPath := detectLocalCLICommand(spec.CLICommand)
	status := ai.MCPClientInstallStatus{
		Client:         spec.Client,
		DisplayName:    spec.DisplayName,
		InstallMode:    "auto",
		ClientDetected: clientDetected,
		ClientCommand:  spec.CLICommand,
		ClientPath:     clientPath,
		ConfigPath:     strings.TrimSpace(configPath),
		Message:        externalMCPClientText(text, "ai.service.mcp_client.external.status.missing", spec.DisplayName, nil),
	}
	if pathErr != nil {
		status.Message = externalMCPClientText(text, "ai.service.mcp_client.external.config_path_failed", spec.DisplayName, map[string]any{"detail": localizeMCPClientPathDetail(text, pathErr)})
		return status
	}

	serverConfig, found, err := readExternalJSONMCPServerConfig(configPath, gonaviMCPServerID, spec, text)
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
		status.Message = externalMCPClientText(text, "ai.service.mcp_client.local_client_not_detected", spec.DisplayName, map[string]any{
			"command": status.ClientCommand,
		})
		return status
	}
	if expectedErr != nil {
		status.Message = externalMCPClientText(text, "ai.service.mcp_client.external.status.path_check_failed", spec.DisplayName, map[string]any{"detail": expectedErr.Error()})
		return status
	}
	status.MatchesCurrent = serverConfig.Enabled && sameMCPCommand(serverConfig.Command, serverConfig.Args, expectedCommand, expectedArgs)
	if status.MatchesCurrent {
		status.Message = externalMCPClientText(text, "ai.service.mcp_client.external.status.connected", spec.DisplayName, nil)
		return status
	}
	status.Message = externalMCPClientText(text, "ai.service.mcp_client.external.status.path_mismatch", spec.DisplayName, nil)
	return status
}

func repairExternalJSONMCPClientConfig(spec externalJSONMCPClientSpec, expectedCommand string, expectedArgs []string, text mcpClientInstallTextFunc) error {
	if !isLocalMCPClientCommandDetected(spec.CLICommand) {
		return nil
	}
	configPath, err := spec.ConfigPathFunc()
	if err != nil {
		return err
	}
	serverConfig, found, err := readExternalJSONMCPServerConfig(configPath, gonaviMCPServerID, spec, text)
	if err != nil || !found || !serverConfig.Enabled || sameMCPCommand(serverConfig.Command, serverConfig.Args, expectedCommand, expectedArgs) {
		return err
	}
	if !shouldRepairInstalledLocalMCPCommand(serverConfig.Command, serverConfig.Args, expectedCommand, expectedArgs) {
		return nil
	}
	return upsertExternalJSONMCPServerConfig(configPath, gonaviMCPServerID, expectedCommand, expectedArgs, spec, text)
}

func readExternalJSONMCPServerConfig(configPath string, serverID string, spec externalJSONMCPClientSpec, textFuncs ...mcpClientInstallTextFunc) (externalJSONMCPServerConfig, bool, error) {
	text := firstMCPClientInstallText(textFuncs)
	root, err := readExternalJSONMCPConfig(configPath, spec.DisplayName, text)
	if err != nil {
		return externalJSONMCPServerConfig{}, false, err
	}
	servers, exists, err := readExternalJSONMapAtPath(root, spec.ServerPath, spec, text)
	if err != nil || !exists {
		return externalJSONMCPServerConfig{}, false, err
	}
	rawServer, exists := servers[strings.TrimSpace(serverID)]
	if !exists || rawServer == nil {
		return externalJSONMCPServerConfig{}, false, nil
	}
	serverMap, ok := rawServer.(map[string]any)
	if !ok {
		return externalJSONMCPServerConfig{}, true, externalJSONMCPConfigFormatError(text, spec, strings.Join(append(append([]string(nil), spec.ServerPath...), strings.TrimSpace(serverID)), "."), "an object")
	}
	serverConfig, err := decodeExternalJSONMCPServerConfig(serverMap, serverID, spec, text)
	return serverConfig, true, err
}

func upsertExternalJSONMCPServerConfig(configPath string, serverID string, command string, args []string, spec externalJSONMCPClientSpec, textFuncs ...mcpClientInstallTextFunc) error {
	text := firstMCPClientInstallText(textFuncs)
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		return externalMCPClientError(text, "ai.service.mcp_client.external.config_dir_create_failed", spec.DisplayName, map[string]any{"detail": err.Error()})
	}
	root, err := readExternalJSONMCPConfig(configPath, spec.DisplayName, text)
	if err != nil {
		return err
	}
	servers, err := ensureExternalJSONMapAtPath(root, spec.ServerPath, spec, text)
	if err != nil {
		return err
	}
	servers[strings.TrimSpace(serverID)] = map[string]any{
		"command":       command,
		"args":          append([]string(nil), args...),
		"env":           map[string]string{},
		spec.EnabledKey: true,
	}

	data, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return externalMCPClientError(text, "ai.service.mcp_client.external.config_serialize_failed", spec.DisplayName, map[string]any{"detail": err.Error()})
	}
	if err := os.WriteFile(configPath, append(data, '\n'), 0o644); err != nil {
		return externalMCPClientError(text, "ai.service.mcp_client.external.config_write_failed", spec.DisplayName, map[string]any{"detail": err.Error()})
	}
	return nil
}

func readExternalJSONMCPConfig(configPath string, displayName string, textFuncs ...mcpClientInstallTextFunc) (map[string]any, error) {
	text := firstMCPClientInstallText(textFuncs)
	data, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}, nil
		}
		return nil, externalMCPClientError(text, "ai.service.mcp_client.external.config_read_failed", displayName, map[string]any{"detail": err.Error()})
	}
	if strings.TrimSpace(string(data)) == "" {
		return map[string]any{}, nil
	}

	var root map[string]any
	if err := json.Unmarshal(data, &root); err != nil {
		return nil, externalMCPClientError(text, "ai.service.mcp_client.external.config_parse_failed", displayName, map[string]any{"detail": err.Error()})
	}
	if root == nil {
		return map[string]any{}, nil
	}
	return root, nil
}

func readExternalJSONMapAtPath(root map[string]any, path []string, spec externalJSONMCPClientSpec, text mcpClientInstallTextFunc) (map[string]any, bool, error) {
	current := root
	for index, key := range path {
		value, exists := current[key]
		if !exists || value == nil {
			return nil, false, nil
		}
		next, ok := value.(map[string]any)
		if !ok {
			return nil, false, externalJSONMCPConfigFormatError(text, spec, strings.Join(path[:index+1], "."), "an object")
		}
		current = next
	}
	return current, true, nil
}

func ensureExternalJSONMapAtPath(root map[string]any, path []string, spec externalJSONMCPClientSpec, text mcpClientInstallTextFunc) (map[string]any, error) {
	if root == nil {
		return nil, externalJSONMCPConfigFormatError(text, spec, "JSON root", "an object")
	}
	current := root
	for index, key := range path {
		value, exists := current[key]
		if !exists || value == nil {
			next := map[string]any{}
			current[key] = next
			current = next
			continue
		}
		next, ok := value.(map[string]any)
		if !ok {
			return nil, externalJSONMCPConfigFormatError(text, spec, strings.Join(path[:index+1], "."), "an object")
		}
		current = next
	}
	return current, nil
}

func decodeExternalJSONMCPServerConfig(serverMap map[string]any, serverID string, spec externalJSONMCPClientSpec, text mcpClientInstallTextFunc) (externalJSONMCPServerConfig, error) {
	pathPrefix := strings.Join(append(append([]string(nil), spec.ServerPath...), strings.TrimSpace(serverID)), ".")
	command, ok := serverMap["command"].(string)
	if !ok || strings.TrimSpace(command) == "" {
		return externalJSONMCPServerConfig{}, externalJSONMCPConfigFormatError(text, spec, pathPrefix+".command", "a non-empty string")
	}
	args, err := decodeJSONLikeStringSlice(serverMap["args"])
	if err != nil {
		return externalJSONMCPServerConfig{}, externalJSONMCPConfigFormatError(text, spec, pathPrefix+".args", "a string array")
	}
	enabled := true
	if rawEnabled, exists := serverMap[spec.EnabledKey]; exists {
		value, ok := rawEnabled.(bool)
		if !ok {
			return externalJSONMCPServerConfig{}, externalJSONMCPConfigFormatError(text, spec, pathPrefix+"."+spec.EnabledKey, "a boolean")
		}
		enabled = value
	}
	return externalJSONMCPServerConfig{
		Command: strings.TrimSpace(command),
		Args:    append([]string(nil), args...),
		Enabled: enabled,
	}, nil
}

func externalJSONMCPConfigFormatError(text mcpClientInstallTextFunc, spec externalJSONMCPClientSpec, path string, expected string) error {
	return externalMCPClientError(text, "ai.service.mcp_client.external.config_format_invalid", spec.DisplayName, map[string]any{
		"path":     path,
		"expected": expected,
	})
}

func externalMCPClientError(text mcpClientInstallTextFunc, key string, displayName string, params map[string]any) error {
	return fmt.Errorf("%s", externalMCPClientText(text, key, displayName, params))
}

func externalMCPClientText(text mcpClientInstallTextFunc, key string, displayName string, params map[string]any) string {
	values := make(map[string]any, len(params)+1)
	for name, value := range params {
		values[name] = value
	}
	values["label"] = displayName
	return mcpClientInstallText(text, key, values)
}
