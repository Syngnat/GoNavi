package aiservice

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/ai"

	"github.com/tailscale/hujson"
)

const openCodeConfigSchema = "https://opencode.ai/config.json"

var openCodeConfigPathFunc = resolveOpenCodeConfigPath

type openCodeMCPServerConfig struct {
	Type    string
	Command []string
	Enabled *bool
}

// AIInstallOpenCodeMCP writes GoNavi into OpenCode's user-level MCP config.
func (s *Service) AIInstallOpenCodeMCP() (ai.MCPClientInstallResult, error) {
	configPath, err := openCodeConfigPathFunc()
	if err != nil {
		return ai.MCPClientInstallResult{}, fmt.Errorf("%s", s.serviceText("ai.service.mcp_client.opencode.config_path_failed", map[string]any{"detail": localizeMCPClientPathDetail(s.serviceText, err)}))
	}
	if err := requireLocalMCPClientCommand(openCodeClientCommandName, "OpenCode", s.serviceText); err != nil {
		return ai.MCPClientInstallResult{}, err
	}

	command, args, err := resolveCurrentLocalMCPCommand(s.serviceText)
	if err != nil {
		return ai.MCPClientInstallResult{}, err
	}

	enabled := true
	serverConfig := openCodeMCPServerConfig{
		Type:    "local",
		Command: append([]string{command}, args...),
		Enabled: &enabled,
	}
	if err := upsertOpenCodeMCPServerConfig(configPath, gonaviMCPServerID, serverConfig, s.serviceText); err != nil {
		return ai.MCPClientInstallResult{}, err
	}

	return ai.MCPClientInstallResult{
		Success:    true,
		Client:     "opencode",
		Message:    s.serviceText("ai.service.mcp_client.opencode.install_success", nil),
		ConfigPath: configPath,
		Command:    command,
		Args:       append([]string(nil), args...),
	}, nil
}

func resolveOpenCodeConfigPath() (string, error) {
	configRoot := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME"))
	if configRoot == "" {
		homeDir, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		homeDir = strings.TrimSpace(homeDir)
		if homeDir == "" {
			return "", errMCPClientUserHomeDirUnavailable
		}
		configRoot = filepath.Join(homeDir, ".config")
	}

	configDir := filepath.Join(configRoot, "opencode")
	for _, name := range []string{"opencode.jsonc", "opencode.json", "config.json"} {
		candidate := filepath.Join(configDir, name)
		_, err := os.Stat(candidate)
		switch {
		case err == nil:
			return candidate, nil
		case errors.Is(err, os.ErrNotExist):
			continue
		default:
			return "", err
		}
	}
	return filepath.Join(configDir, "opencode.json"), nil
}

func inspectOpenCodeMCPInstallStatus(expectedCommand string, expectedArgs []string, expectedErr error, textFuncs ...mcpClientInstallTextFunc) ai.MCPClientInstallStatus {
	text := firstMCPClientInstallText(textFuncs)
	configPath, pathErr := openCodeConfigPathFunc()
	clientDetected, clientPath := detectLocalCLICommand(openCodeClientCommandName)
	status := ai.MCPClientInstallStatus{
		Client:         "opencode",
		DisplayName:    "OpenCode",
		InstallMode:    "auto",
		ClientDetected: clientDetected,
		ClientCommand:  openCodeClientCommandName,
		ClientPath:     clientPath,
		ConfigPath:     strings.TrimSpace(configPath),
		Message:        mcpClientInstallText(text, "ai.service.mcp_client.opencode.status.missing", nil),
	}
	if pathErr != nil {
		status.Message = mcpClientInstallText(text, "ai.service.mcp_client.opencode.config_path_failed", map[string]any{"detail": localizeMCPClientPathDetail(text, pathErr)})
		return status
	}

	serverConfig, found, sourcePath, err := readEffectiveOpenCodeMCPServerConfig(configPath, gonaviMCPServerID, text)
	if err != nil {
		status.Installed = found
		status.Message = err.Error()
		if found && len(serverConfig.Command) > 0 {
			status.Command = strings.TrimSpace(serverConfig.Command[0])
			status.Args = append([]string(nil), serverConfig.Command[1:]...)
		}
		return status
	}
	if !found {
		return status
	}

	status.Installed = true
	if strings.TrimSpace(sourcePath) != "" {
		status.ConfigPath = sourcePath
	}
	if len(serverConfig.Command) > 0 {
		status.Command = strings.TrimSpace(serverConfig.Command[0])
		status.Args = append([]string(nil), serverConfig.Command[1:]...)
	}
	if !status.ClientDetected {
		status.Message = mcpClientInstallText(text, "ai.service.mcp_client.local_client_not_detected", map[string]any{
			"label":   status.DisplayName,
			"command": status.ClientCommand,
		})
		return status
	}
	if expectedErr != nil {
		status.Message = mcpClientInstallText(text, "ai.service.mcp_client.opencode.status.path_check_failed", map[string]any{"detail": expectedErr.Error()})
		return status
	}

	enabled := serverConfig.Enabled == nil || *serverConfig.Enabled
	status.MatchesCurrent = enabled && strings.EqualFold(strings.TrimSpace(serverConfig.Type), "local") &&
		sameMCPCommand(status.Command, status.Args, expectedCommand, expectedArgs)
	if status.MatchesCurrent {
		status.Message = mcpClientInstallText(text, "ai.service.mcp_client.opencode.status.connected", nil)
		return status
	}
	status.Message = mcpClientInstallText(text, "ai.service.mcp_client.opencode.status.path_mismatch", nil)
	return status
}

func repairOpenCodeMCPClientConfig(expectedCommand string, expectedArgs []string, text mcpClientInstallTextFunc) error {
	if !isLocalMCPClientCommandDetected(openCodeClientCommandName) {
		return nil
	}
	configPath, err := openCodeConfigPathFunc()
	if err != nil {
		return err
	}
	serverConfig, found, sourcePath, err := readEffectiveOpenCodeMCPServerConfig(configPath, gonaviMCPServerID, text)
	if err != nil || !found || len(serverConfig.Command) == 0 {
		return err
	}
	command, args := serverConfig.Command[0], serverConfig.Command[1:]
	if sameMCPCommand(command, args, expectedCommand, expectedArgs) ||
		!strings.EqualFold(strings.TrimSpace(serverConfig.Type), "local") ||
		!shouldRepairInstalledLocalMCPCommand(command, args, expectedCommand, expectedArgs) {
		return nil
	}
	serverConfig.Command = append([]string{expectedCommand}, expectedArgs...)
	if strings.TrimSpace(sourcePath) == "" {
		sourcePath = configPath
	}
	return upsertOpenCodeMCPServerConfig(sourcePath, gonaviMCPServerID, serverConfig, text)
}

func readOpenCodeMCPServerConfig(configPath string, serverID string, textFuncs ...mcpClientInstallTextFunc) (openCodeMCPServerConfig, bool, error) {
	text := firstMCPClientInstallText(textFuncs)
	root, err := readOpenCodeConfig(configPath, text)
	if err != nil {
		return openCodeMCPServerConfig{}, false, err
	}
	return decodeOpenCodeMCPServerConfig(root, serverID, text)
}

func decodeOpenCodeMCPServerConfig(root map[string]any, serverID string, text mcpClientInstallTextFunc) (openCodeMCPServerConfig, bool, error) {
	rawMCP, exists := root["mcp"]
	if !exists || rawMCP == nil {
		return openCodeMCPServerConfig{}, false, nil
	}
	mcpServers, ok := rawMCP.(map[string]any)
	if !ok {
		return openCodeMCPServerConfig{}, false, openCodeConfigFormatError(text, "mcp", "an object")
	}
	rawServer, exists := mcpServers[strings.TrimSpace(serverID)]
	if !exists || rawServer == nil {
		return openCodeMCPServerConfig{}, false, nil
	}
	serverMap, ok := rawServer.(map[string]any)
	if !ok {
		return openCodeMCPServerConfig{}, true, openCodeConfigFormatError(text, fmt.Sprintf("mcp.%s", strings.TrimSpace(serverID)), "an object")
	}

	result := openCodeMCPServerConfig{}
	rawType, exists := serverMap["type"]
	if !exists {
		return result, true, openCodeConfigFormatError(text, fmt.Sprintf("mcp.%s.type", strings.TrimSpace(serverID)), "a string")
	}
	typeName, ok := rawType.(string)
	if !ok || strings.TrimSpace(typeName) == "" {
		return result, true, openCodeConfigFormatError(text, fmt.Sprintf("mcp.%s.type", strings.TrimSpace(serverID)), "a string")
	}
	result.Type = strings.TrimSpace(typeName)
	if rawEnabled, exists := serverMap["enabled"]; exists {
		enabled, ok := rawEnabled.(bool)
		if !ok {
			return result, true, openCodeConfigFormatError(text, fmt.Sprintf("mcp.%s.enabled", strings.TrimSpace(serverID)), "a boolean")
		}
		result.Enabled = &enabled
	}
	rawCommand, exists := serverMap["command"]
	if !exists {
		if !strings.EqualFold(result.Type, "local") {
			return result, true, nil
		}
		return result, true, openCodeConfigFormatError(text, fmt.Sprintf("mcp.%s.command", strings.TrimSpace(serverID)), "a string array")
	}
	command, err := decodeJSONLikeStringSlice(rawCommand)
	if err != nil {
		return result, true, openCodeConfigFormatError(text, fmt.Sprintf("mcp.%s.command", strings.TrimSpace(serverID)), "a string array")
	}
	if len(command) == 0 || strings.TrimSpace(command[0]) == "" {
		return result, true, openCodeConfigFormatError(text, fmt.Sprintf("mcp.%s.command", strings.TrimSpace(serverID)), "a non-empty string array")
	}
	result.Command = command
	return result, true, nil
}

func readEffectiveOpenCodeMCPServerConfig(configPath string, serverID string, text mcpClientInstallTextFunc) (openCodeMCPServerConfig, bool, string, error) {
	configPaths, err := openCodeConfigLayerPaths(configPath, text)
	if err != nil {
		return openCodeMCPServerConfig{}, false, "", err
	}

	effective := map[string]any{}
	lastDeclarationPath := ""
	lastFullConfigPath := ""
	commandSourcePath := ""
	for _, path := range configPaths {
		root, err := readOpenCodeConfig(path, text)
		if err != nil {
			return openCodeMCPServerConfig{}, false, "", err
		}
		found, fullConfig, commandDeclared, err := validateOpenCodeMCPServerLayer(root, serverID, text)
		if err != nil {
			return openCodeMCPServerConfig{}, found, path, err
		}
		if found {
			lastDeclarationPath = path
		}
		if fullConfig {
			lastFullConfigPath = path
		}
		if commandDeclared {
			commandSourcePath = path
		}
		effective = mergeOpenCodeConfig(effective, root)
	}

	serverConfig, found, err := decodeOpenCodeMCPServerConfig(effective, serverID, text)
	serverSourcePath := commandSourcePath
	if !strings.EqualFold(strings.TrimSpace(serverConfig.Type), "local") || serverSourcePath == "" {
		serverSourcePath = lastFullConfigPath
	}
	if serverSourcePath == "" {
		serverSourcePath = lastDeclarationPath
	}
	if err != nil {
		return serverConfig, found, serverSourcePath, err
	}
	return serverConfig, found, serverSourcePath, nil
}

func validateOpenCodeMCPServerLayer(root map[string]any, serverID string, text mcpClientInstallTextFunc) (found bool, fullConfig bool, commandDeclared bool, err error) {
	rawMCP, exists := root["mcp"]
	if !exists || rawMCP == nil {
		return false, false, false, nil
	}
	mcpServers, ok := rawMCP.(map[string]any)
	if !ok {
		return false, false, false, openCodeConfigFormatError(text, "mcp", "an object")
	}
	trimmedServerID := strings.TrimSpace(serverID)
	rawServer, exists := mcpServers[trimmedServerID]
	if !exists || rawServer == nil {
		return false, false, false, nil
	}
	serverMap, ok := rawServer.(map[string]any)
	if !ok {
		return true, false, false, openCodeConfigFormatError(text, fmt.Sprintf("mcp.%s", trimmedServerID), "an object")
	}
	if _, hasType := serverMap["type"]; hasType {
		_, _, err := decodeOpenCodeMCPServerConfig(root, serverID, text)
		return true, true, serverMap["command"] != nil, err
	}
	if len(serverMap) == 1 {
		if enabled, exists := serverMap["enabled"]; exists {
			if _, ok := enabled.(bool); ok {
				return true, false, false, nil
			}
			return true, false, false, openCodeConfigFormatError(text, fmt.Sprintf("mcp.%s.enabled", trimmedServerID), "a boolean")
		}
	}
	return true, false, false, openCodeConfigFormatError(text, fmt.Sprintf("mcp.%s", trimmedServerID), "a complete local/remote config or an enabled-only override")
}

func openCodeConfigLayerPaths(configPath string, text mcpClientInstallTextFunc) ([]string, error) {
	baseName := strings.ToLower(filepath.Base(configPath))
	if baseName != "config.json" && baseName != "opencode.json" && baseName != "opencode.jsonc" {
		return []string{configPath}, nil
	}

	configDir := filepath.Dir(configPath)
	paths := make([]string, 0, 3)
	for _, name := range []string{"config.json", "opencode.json", "opencode.jsonc"} {
		candidate := filepath.Join(configDir, name)
		_, err := os.Stat(candidate)
		switch {
		case err == nil:
			paths = append(paths, candidate)
		case errors.Is(err, os.ErrNotExist):
			continue
		default:
			return nil, fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.opencode.config_read_failed", map[string]any{"detail": err.Error()}))
		}
	}
	if len(paths) == 0 {
		paths = append(paths, configPath)
	}
	return paths, nil
}

func mergeOpenCodeConfig(target map[string]any, source map[string]any) map[string]any {
	if target == nil {
		target = map[string]any{}
	}
	for key, sourceValue := range source {
		sourceMap, sourceIsMap := sourceValue.(map[string]any)
		targetMap, targetIsMap := target[key].(map[string]any)
		if sourceIsMap && targetIsMap {
			target[key] = mergeOpenCodeConfig(targetMap, sourceMap)
			continue
		}
		target[key] = sourceValue
	}
	return target
}

func upsertOpenCodeMCPServerConfig(configPath string, serverID string, serverConfig openCodeMCPServerConfig, textFuncs ...mcpClientInstallTextFunc) error {
	text := firstMCPClientInstallText(textFuncs)
	data, err := os.ReadFile(configPath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.opencode.config_read_failed", map[string]any{"detail": err.Error()}))
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		data = []byte("{}\n")
	}

	root, err := parseOpenCodeConfig(data, text)
	if err != nil {
		return err
	}
	standard, err := standardOpenCodeConfig(root)
	if err != nil {
		return fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.opencode.config_parse_failed", map[string]any{"detail": err.Error()}))
	}
	mcpExists := false
	serverExists := false
	existingServerType := ""
	remoteOnlyFields := make([]string, 0, 3)
	if rawMCP, exists := standard["mcp"]; exists && rawMCP != nil {
		mcpServers, ok := rawMCP.(map[string]any)
		if !ok {
			return openCodeConfigFormatError(text, "mcp", "an object")
		}
		mcpExists = true
		if rawServer, exists := mcpServers[strings.TrimSpace(serverID)]; exists && rawServer != nil {
			serverMap, ok := rawServer.(map[string]any)
			if !ok {
				return openCodeConfigFormatError(text, fmt.Sprintf("mcp.%s", strings.TrimSpace(serverID)), "an object")
			}
			serverExists = true
			if typeName, ok := serverMap["type"].(string); ok {
				existingServerType = strings.TrimSpace(typeName)
			}
			for _, key := range []string{"url", "headers", "oauth"} {
				if _, exists := serverMap[key]; exists {
					remoteOnlyFields = append(remoteOnlyFields, key)
				}
			}
		}
	}

	serverValue := map[string]any{
		"type":    serverConfig.Type,
		"command": append([]string(nil), serverConfig.Command...),
	}
	if serverConfig.Enabled != nil {
		serverValue["enabled"] = *serverConfig.Enabled
	}
	serverPath := "/mcp/" + escapeJSONPointerToken(strings.TrimSpace(serverID))
	operations := make([]map[string]any, 0, 3)
	switch {
	case !mcpExists:
		operations = append(operations, map[string]any{
			"op":    "add",
			"path":  "/mcp",
			"value": map[string]any{strings.TrimSpace(serverID): serverValue},
		})
	case !serverExists || !strings.EqualFold(existingServerType, "local"):
		operations = append(operations, map[string]any{"op": "add", "path": serverPath, "value": serverValue})
	default:
		for _, key := range remoteOnlyFields {
			operations = append(operations, map[string]any{"op": "remove", "path": serverPath + "/" + escapeJSONPointerToken(key)})
		}
		operations = append(operations,
			map[string]any{"op": "add", "path": serverPath + "/type", "value": serverConfig.Type},
			map[string]any{"op": "add", "path": serverPath + "/command", "value": append([]string(nil), serverConfig.Command...)},
		)
		if serverConfig.Enabled != nil {
			operations = append(operations, map[string]any{"op": "add", "path": serverPath + "/enabled", "value": *serverConfig.Enabled})
		}
	}
	patch, err := json.Marshal(operations)
	if err != nil {
		return fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.opencode.config_serialize_failed", map[string]any{"detail": err.Error()}))
	}
	if err := root.Patch(patch); err != nil {
		return fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.opencode.config_serialize_failed", map[string]any{"detail": err.Error()}))
	}
	root.Format()
	payload := root.Pack()
	if _, statErr := os.Stat(configPath); errors.Is(statErr, os.ErrNotExist) {
		payload, err = addOpenCodeSchema(payload)
		if err != nil {
			return fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.opencode.config_serialize_failed", map[string]any{"detail": err.Error()}))
		}
	}

	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		return fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.opencode.config_dir_create_failed", map[string]any{"detail": err.Error()}))
	}
	if err := writeOpenCodeConfigFile(configPath, payload); err != nil {
		return fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.opencode.config_write_failed", map[string]any{"detail": err.Error()}))
	}
	return nil
}

func readOpenCodeConfig(configPath string, text mcpClientInstallTextFunc) (map[string]any, error) {
	data, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}, nil
		}
		return nil, fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.opencode.config_read_failed", map[string]any{"detail": err.Error()}))
	}
	if strings.TrimSpace(string(data)) == "" {
		return map[string]any{}, nil
	}
	root, err := parseOpenCodeConfig(data, text)
	if err != nil {
		return nil, err
	}
	return standardOpenCodeConfig(root)
}

func parseOpenCodeConfig(data []byte, text mcpClientInstallTextFunc) (*hujson.Value, error) {
	root, err := hujson.Parse(data)
	if err != nil {
		return nil, fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.opencode.config_parse_failed", map[string]any{"detail": err.Error()}))
	}
	if root.Value.Kind() != '{' {
		return nil, openCodeConfigFormatError(text, "JSON root", "an object")
	}
	return &root, nil
}

func standardOpenCodeConfig(root *hujson.Value) (map[string]any, error) {
	standard := root.Clone()
	standard.Standardize()
	var result map[string]any
	if err := json.Unmarshal(standard.Pack(), &result); err != nil {
		return nil, err
	}
	if result == nil {
		return map[string]any{}, nil
	}
	return result, nil
}

func openCodeConfigFormatError(text mcpClientInstallTextFunc, path string, expected string) error {
	return fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.opencode.config_format_invalid", map[string]any{"path": path, "expected": expected}))
}

func escapeJSONPointerToken(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "~", "~0"), "/", "~1")
}

func addOpenCodeSchema(payload []byte) ([]byte, error) {
	root, err := hujson.Parse(payload)
	if err != nil {
		return nil, err
	}
	patch, err := json.Marshal([]map[string]any{{"op": "add", "path": "/$schema", "value": openCodeConfigSchema}})
	if err != nil {
		return nil, err
	}
	if err := root.Patch(patch); err != nil {
		return nil, err
	}
	root.Format()
	return root.Pack(), nil
}

func writeOpenCodeConfigFile(configPath string, payload []byte) error {
	writePath := configPath
	if info, err := os.Lstat(configPath); err == nil && info.Mode()&os.ModeSymlink != 0 {
		resolvedPath, err := filepath.EvalSymlinks(configPath)
		if err != nil {
			return err
		}
		writePath = resolvedPath
	}
	mode := os.FileMode(0o644)
	if info, err := os.Stat(writePath); err == nil {
		mode = info.Mode().Perm()
	}
	temp, err := os.CreateTemp(filepath.Dir(writePath), ".opencode-*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(mode); err != nil {
		_ = temp.Close()
		return err
	}
	if _, err := temp.Write(payload); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return replaceOpenCodeConfigFile(tempPath, writePath)
}
