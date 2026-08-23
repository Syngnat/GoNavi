package aiservice

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/ai"

	"go.yaml.in/yaml/v3"
)

const (
	deepSeekHarnessClientCommandName = "dsh"
	deepSeekHarnessMCPEntryID        = "gonavi-mcp"
	deepSeekHarnessMCPPluginName     = "@deepseek-ai/dsh-mcp-client"
)

var deepSeekHarnessConfigPathFunc = resolveDeepSeekHarnessConfigPath
var deepSeekHarnessHomeDirFunc = resolveDeepSeekHarnessHomeDir
var deepSeekHarnessNpxPackageDirFunc = resolveDeepSeekHarnessNpxPackageDir

type deepSeekHarnessMCPServerConfig struct {
	Command string
	Args    []string
}

// AIInstallDeepSeekHarnessMCP writes a GoNavi MCP client plugin entry into the
// DeepSeek Harness home-level patch, which is applied to every local profile.
func (s *Service) AIInstallDeepSeekHarnessMCP() (ai.MCPClientInstallResult, error) {
	configPath, err := deepSeekHarnessConfigPathFunc()
	if err != nil {
		return ai.MCPClientInstallResult{}, externalMCPClientError(
			s.serviceText,
			"ai.service.mcp_client.external.config_path_failed",
			"DeepSeek Harness",
			map[string]any{"detail": localizeMCPClientPathDetail(s.serviceText, err)},
		)
	}
	if err := requireDeepSeekHarnessClient(s.serviceText); err != nil {
		return ai.MCPClientInstallResult{}, err
	}
	command, args, err := resolveCurrentLocalMCPCommand(s.serviceText)
	if err != nil {
		return ai.MCPClientInstallResult{}, err
	}
	if err := upsertDeepSeekHarnessMCPServerConfig(configPath, command, args, s.serviceText); err != nil {
		return ai.MCPClientInstallResult{}, err
	}
	return ai.MCPClientInstallResult{
		Success:    true,
		Client:     "deepseek-harness",
		Message:    externalMCPClientText(s.serviceText, "ai.service.mcp_client.external.install_success", "DeepSeek Harness", nil),
		ConfigPath: configPath,
		Command:    command,
		Args:       append([]string(nil), args...),
	}, nil
}

func resolveDeepSeekHarnessConfigPath() (string, error) {
	configRoot, err := resolveMCPClientConfigRoot("DSH_HOME", ".dsh")
	if err != nil {
		return "", err
	}
	return filepath.Join(configRoot, "cordis.patch.yml"), nil
}

func resolveDeepSeekHarnessHomeDir() string {
	configRoot, err := resolveMCPClientConfigRoot("DSH_HOME", ".dsh")
	if err != nil {
		return ""
	}
	return configRoot
}

// resolveDeepSeekHarnessNpxPackageDir locates the @deepseek-ai/dsh package in the
// npm npx cache. The official quick start (`npx @deepseek-ai/dsh web`) installs
// the harness into the transient npx cache instead of a PATH directory, so the
// presence of that package is a reliable "DeepSeek Harness is installed" signal
// for users who follow the documented setup.
func resolveDeepSeekHarnessNpxPackageDir() string {
	cacheRoot := strings.TrimSpace(os.Getenv("npm_config_cache"))
	if cacheRoot == "" {
		homeDir, err := resolveMCPClientUserHomeDir()
		if err != nil {
			return ""
		}
		cacheRoot = filepath.Join(homeDir, ".npm")
	}
	npxRoot := filepath.Join(cacheRoot, "_npx")
	entries, err := os.ReadDir(npxRoot)
	if err != nil {
		return ""
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		candidate := filepath.Join(npxRoot, entry.Name(), "node_modules", "@deepseek-ai", "dsh")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
	}
	return ""
}

// detectDeepSeekHarnessClient reports whether a DeepSeek Harness installation is
// present and returns the path to surface in the status UI. PATH detection alone
// misses the officially documented npx quick start (which never puts `dsh` on
// PATH), so the DSH home directory and the npx package cache are checked as
// fallbacks before the client is reported as missing.
func detectDeepSeekHarnessClient() (bool, string) {
	if detected, path := detectLocalCLICommand(deepSeekHarnessClientCommandName); detected {
		return true, path
	}
	if home := deepSeekHarnessHomeDirFunc(); home != "" && deepSeekHarnessHomeMarkersPresent(home) {
		return true, home
	}
	if packageDir := deepSeekHarnessNpxPackageDirFunc(); packageDir != "" {
		if info, err := os.Stat(filepath.Join(packageDir, "package.json")); err == nil && !info.IsDir() {
			return true, packageDir
		}
	}
	return false, ""
}

// deepSeekHarnessHomeMarkersPresent reports whether the DSH home directory was
// created by DeepSeek Harness itself (settings.yaml and/or profiles are written
// on first boot) rather than by an unrelated process.
func deepSeekHarnessHomeMarkersPresent(home string) bool {
	for _, marker := range []string{"settings.yaml", "profiles"} {
		if _, err := os.Stat(filepath.Join(home, marker)); err == nil {
			return true
		}
	}
	return false
}

func requireDeepSeekHarnessClient(textFuncs ...mcpClientInstallTextFunc) error {
	if detected, _ := detectDeepSeekHarnessClient(); detected {
		return nil
	}
	text := firstMCPClientInstallText(textFuncs)
	return fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.local_client_not_detected", map[string]any{
		"label":   "DeepSeek Harness",
		"command": deepSeekHarnessClientCommandName,
	}))
}

func inspectDeepSeekHarnessMCPInstallStatus(expectedCommand string, expectedArgs []string, expectedErr error, textFuncs ...mcpClientInstallTextFunc) ai.MCPClientInstallStatus {
	text := firstMCPClientInstallText(textFuncs)
	configPath, pathErr := deepSeekHarnessConfigPathFunc()
	clientDetected, clientPath := detectDeepSeekHarnessClient()
	status := ai.MCPClientInstallStatus{
		Client:         "deepseek-harness",
		DisplayName:    "DeepSeek Harness",
		InstallMode:    "auto",
		ClientDetected: clientDetected,
		ClientCommand:  deepSeekHarnessClientCommandName,
		ClientPath:     clientPath,
		ConfigPath:     strings.TrimSpace(configPath),
		Message:        externalMCPClientText(text, "ai.service.mcp_client.external.status.missing", "DeepSeek Harness", nil),
	}
	if pathErr != nil {
		status.Message = externalMCPClientText(text, "ai.service.mcp_client.external.config_path_failed", "DeepSeek Harness", map[string]any{"detail": localizeMCPClientPathDetail(text, pathErr)})
		return status
	}

	serverConfig, found, err := readDeepSeekHarnessMCPServerConfig(configPath, text)
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
		status.Message = externalMCPClientText(text, "ai.service.mcp_client.local_client_not_detected", "DeepSeek Harness", map[string]any{
			"command": status.ClientCommand,
		})
		return status
	}
	if expectedErr != nil {
		status.Message = externalMCPClientText(text, "ai.service.mcp_client.external.status.path_check_failed", "DeepSeek Harness", map[string]any{"detail": expectedErr.Error()})
		return status
	}
	status.MatchesCurrent = sameMCPCommand(serverConfig.Command, serverConfig.Args, expectedCommand, expectedArgs)
	if status.MatchesCurrent {
		status.Message = externalMCPClientText(text, "ai.service.mcp_client.external.status.connected", "DeepSeek Harness", nil)
		return status
	}
	status.Message = externalMCPClientText(text, "ai.service.mcp_client.external.status.path_mismatch", "DeepSeek Harness", nil)
	return status
}

func repairDeepSeekHarnessMCPClientConfig(expectedCommand string, expectedArgs []string, text mcpClientInstallTextFunc) error {
	if detected, _ := detectDeepSeekHarnessClient(); !detected {
		return nil
	}
	configPath, err := deepSeekHarnessConfigPathFunc()
	if err != nil {
		return err
	}
	serverConfig, found, err := readDeepSeekHarnessMCPServerConfig(configPath, text)
	if err != nil || !found || sameMCPCommand(serverConfig.Command, serverConfig.Args, expectedCommand, expectedArgs) {
		return err
	}
	if !shouldRepairInstalledLocalMCPCommand(serverConfig.Command, serverConfig.Args, expectedCommand, expectedArgs) {
		return nil
	}
	return upsertDeepSeekHarnessMCPServerConfig(configPath, expectedCommand, expectedArgs, text)
}

func readDeepSeekHarnessMCPServerConfig(configPath string, textFuncs ...mcpClientInstallTextFunc) (deepSeekHarnessMCPServerConfig, bool, error) {
	text := firstMCPClientInstallText(textFuncs)
	_, root, err := readDeepSeekHarnessPatchDocument(configPath, text)
	if err != nil {
		return deepSeekHarnessMCPServerConfig{}, false, err
	}
	entries, err := deepSeekHarnessInsertedEntries(root, text)
	if err != nil {
		return deepSeekHarnessMCPServerConfig{}, false, err
	}
	matches, err := deepSeekHarnessEntriesWithID(entries, deepSeekHarnessMCPEntryID, text)
	if err != nil {
		return deepSeekHarnessMCPServerConfig{}, false, err
	}
	if len(matches) == 0 {
		return deepSeekHarnessMCPServerConfig{}, false, nil
	}
	if len(matches) > 1 {
		return deepSeekHarnessMCPServerConfig{}, true, deepSeekHarnessConfigFormatError(text, "insert.gonavi-mcp", "a single GoNavi MCP plugin entry")
	}
	config, err := decodeDeepSeekHarnessMCPServerConfig(matches[0], text)
	return config, true, err
}

func upsertDeepSeekHarnessMCPServerConfig(configPath string, command string, args []string, textFuncs ...mcpClientInstallTextFunc) error {
	text := firstMCPClientInstallText(textFuncs)
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		return externalMCPClientError(text, "ai.service.mcp_client.external.config_dir_create_failed", "DeepSeek Harness", map[string]any{"detail": err.Error()})
	}
	document, root, err := readDeepSeekHarnessPatchDocument(configPath, text)
	if err != nil {
		return err
	}
	entries, err := deepSeekHarnessInsertedEntries(root, text)
	if err != nil {
		return err
	}
	matches, err := deepSeekHarnessEntriesWithID(entries, deepSeekHarnessMCPEntryID, text)
	if err != nil {
		return err
	}
	if len(matches) > 1 {
		return deepSeekHarnessConfigFormatError(text, "insert.gonavi-mcp", "a single GoNavi MCP plugin entry")
	}
	if len(matches) == 0 {
		root.Content = append(root.Content, newDeepSeekHarnessPatch(command, args))
	} else {
		entry := matches[0]
		if existingName, exists, err := yamlMappingString(entry, "name"); err != nil {
			return deepSeekHarnessConfigFormatError(text, "insert.gonavi-mcp.name", "a string")
		} else if exists && existingName != deepSeekHarnessMCPPluginName {
			return deepSeekHarnessConfigFormatError(text, "insert.gonavi-mcp.name", deepSeekHarnessMCPPluginName)
		}
		setYAMLMappingValue(entry, "id", newYAMLStringNode(deepSeekHarnessMCPEntryID))
		setYAMLMappingValue(entry, "name", newYAMLStringNode(deepSeekHarnessMCPPluginName))
		configNode := yamlMappingValue(entry, "config")
		if configNode == nil {
			configNode = newDeepSeekHarnessMCPConfigNode(command, args)
			setYAMLMappingValue(entry, "config", configNode)
		} else if configNode.Kind != yaml.MappingNode {
			return deepSeekHarnessConfigFormatError(text, "insert.gonavi-mcp.config", "an object")
		} else {
			setYAMLMappingValue(configNode, "serverName", newYAMLStringNode(gonaviMCPServerID))
			setYAMLMappingValue(configNode, "transport", newYAMLStringNode("stdio"))
			setYAMLMappingValue(configNode, "command", newYAMLStringNode(command))
			setYAMLMappingValue(configNode, "args", newYAMLStringSequenceNode(args))
		}
	}

	data, err := yaml.Marshal(document)
	if err != nil {
		return externalMCPClientError(text, "ai.service.mcp_client.external.config_serialize_failed", "DeepSeek Harness", map[string]any{"detail": err.Error()})
	}
	if err := os.WriteFile(configPath, data, 0o644); err != nil {
		return externalMCPClientError(text, "ai.service.mcp_client.external.config_write_failed", "DeepSeek Harness", map[string]any{"detail": err.Error()})
	}
	return nil
}

func readDeepSeekHarnessPatchDocument(configPath string, text mcpClientInstallTextFunc) (*yaml.Node, *yaml.Node, error) {
	data, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			document, root := newDeepSeekHarnessPatchDocument()
			return document, root, nil
		}
		return nil, nil, externalMCPClientError(text, "ai.service.mcp_client.external.config_read_failed", "DeepSeek Harness", map[string]any{"detail": err.Error()})
	}
	if strings.TrimSpace(string(data)) == "" {
		document, root := newDeepSeekHarnessPatchDocument()
		return document, root, nil
	}

	document := &yaml.Node{}
	if err := yaml.Unmarshal(data, document); err != nil {
		return nil, nil, externalMCPClientError(text, "ai.service.mcp_client.external.config_parse_failed", "DeepSeek Harness", map[string]any{"detail": err.Error()})
	}
	if document.Kind != yaml.DocumentNode || len(document.Content) != 1 || document.Content[0] == nil {
		return nil, nil, deepSeekHarnessConfigFormatError(text, "YAML root", "a patch list")
	}
	root := document.Content[0]
	if root.Kind != yaml.SequenceNode {
		return nil, nil, deepSeekHarnessConfigFormatError(text, "YAML root", "a patch list")
	}
	return document, root, nil
}

func newDeepSeekHarnessPatchDocument() (*yaml.Node, *yaml.Node) {
	root := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
	return &yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{root}}, root
}

func deepSeekHarnessInsertedEntries(root *yaml.Node, text mcpClientInstallTextFunc) ([]*yaml.Node, error) {
	if root == nil || root.Kind != yaml.SequenceNode {
		return nil, deepSeekHarnessConfigFormatError(text, "YAML root", "a patch list")
	}
	entries := make([]*yaml.Node, 0)
	for index, patch := range root.Content {
		if patch == nil || patch.Kind != yaml.MappingNode {
			return nil, deepSeekHarnessConfigFormatError(text, fmt.Sprintf("patch[%d]", index), "an object")
		}
		insert := yamlMappingValue(patch, "insert")
		if insert == nil {
			continue
		}
		if insert.Kind != yaml.SequenceNode {
			return nil, deepSeekHarnessConfigFormatError(text, fmt.Sprintf("patch[%d].insert", index), "a list")
		}
		entries = append(entries, insert.Content...)
	}
	return entries, nil
}

func deepSeekHarnessEntriesWithID(entries []*yaml.Node, targetID string, text mcpClientInstallTextFunc) ([]*yaml.Node, error) {
	matches := make([]*yaml.Node, 0, 1)
	for index, entry := range entries {
		if entry == nil || entry.Kind != yaml.MappingNode {
			return nil, deepSeekHarnessConfigFormatError(text, fmt.Sprintf("insert[%d]", index), "an object")
		}
		id, exists, err := yamlMappingString(entry, "id")
		if err != nil {
			return nil, deepSeekHarnessConfigFormatError(text, fmt.Sprintf("insert[%d].id", index), "a string")
		}
		if exists && id == targetID {
			matches = append(matches, entry)
		}
	}
	return matches, nil
}

func decodeDeepSeekHarnessMCPServerConfig(entry *yaml.Node, text mcpClientInstallTextFunc) (deepSeekHarnessMCPServerConfig, error) {
	name, exists, err := yamlMappingString(entry, "name")
	if err != nil || !exists || name != deepSeekHarnessMCPPluginName {
		return deepSeekHarnessMCPServerConfig{}, deepSeekHarnessConfigFormatError(text, "insert.gonavi-mcp.name", deepSeekHarnessMCPPluginName)
	}
	configNode := yamlMappingValue(entry, "config")
	if configNode == nil || configNode.Kind != yaml.MappingNode {
		return deepSeekHarnessMCPServerConfig{}, deepSeekHarnessConfigFormatError(text, "insert.gonavi-mcp.config", "an object")
	}
	serverName, exists, err := yamlMappingString(configNode, "serverName")
	if err != nil || !exists || serverName != gonaviMCPServerID {
		return deepSeekHarnessMCPServerConfig{}, deepSeekHarnessConfigFormatError(text, "insert.gonavi-mcp.config.serverName", gonaviMCPServerID)
	}
	transport, exists, err := yamlMappingString(configNode, "transport")
	if err != nil || !exists || transport != "stdio" {
		return deepSeekHarnessMCPServerConfig{}, deepSeekHarnessConfigFormatError(text, "insert.gonavi-mcp.config.transport", "stdio")
	}
	command, exists, err := yamlMappingString(configNode, "command")
	if err != nil || !exists || strings.TrimSpace(command) == "" {
		return deepSeekHarnessMCPServerConfig{}, deepSeekHarnessConfigFormatError(text, "insert.gonavi-mcp.config.command", "a non-empty string")
	}
	args, err := yamlMappingStringList(configNode, "args")
	if err != nil {
		return deepSeekHarnessMCPServerConfig{}, deepSeekHarnessConfigFormatError(text, "insert.gonavi-mcp.config.args", "a string array")
	}
	return deepSeekHarnessMCPServerConfig{
		Command: strings.TrimSpace(command),
		Args:    args,
	}, nil
}

func newDeepSeekHarnessPatch(command string, args []string) *yaml.Node {
	return newYAMLMappingNode(
		"insert", newYAMLSequenceNode(newDeepSeekHarnessMCPEntry(command, args)),
	)
}

func newDeepSeekHarnessMCPEntry(command string, args []string) *yaml.Node {
	return newYAMLMappingNode(
		"id", newYAMLStringNode(deepSeekHarnessMCPEntryID),
		"name", newYAMLStringNode(deepSeekHarnessMCPPluginName),
		"config", newDeepSeekHarnessMCPConfigNode(command, args),
	)
}

func newDeepSeekHarnessMCPConfigNode(command string, args []string) *yaml.Node {
	return newYAMLMappingNode(
		"serverName", newYAMLStringNode(gonaviMCPServerID),
		"transport", newYAMLStringNode("stdio"),
		"command", newYAMLStringNode(command),
		"args", newYAMLStringSequenceNode(args),
	)
}

func newYAMLStringSequenceNode(values []string) *yaml.Node {
	items := make([]*yaml.Node, 0, len(values))
	for _, value := range values {
		items = append(items, newYAMLStringNode(value))
	}
	return newYAMLSequenceNode(items...)
}

func newYAMLMappingNode(values ...any) *yaml.Node {
	node := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	for index := 0; index+1 < len(values); index += 2 {
		key, _ := values[index].(string)
		value, _ := values[index+1].(*yaml.Node)
		node.Content = append(node.Content, newYAMLStringNode(key), value)
	}
	return node
}

func newYAMLSequenceNode(values ...*yaml.Node) *yaml.Node {
	return &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq", Content: values}
}

func newYAMLStringNode(value string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value}
}

func yamlMappingValue(node *yaml.Node, key string) *yaml.Node {
	if node == nil || node.Kind != yaml.MappingNode {
		return nil
	}
	for index := 0; index+1 < len(node.Content); index += 2 {
		if node.Content[index] != nil && node.Content[index].Value == key {
			return node.Content[index+1]
		}
	}
	return nil
}

func setYAMLMappingValue(node *yaml.Node, key string, value *yaml.Node) {
	for index := 0; index+1 < len(node.Content); index += 2 {
		if node.Content[index] != nil && node.Content[index].Value == key {
			node.Content[index+1] = value
			return
		}
	}
	node.Content = append(node.Content, newYAMLStringNode(key), value)
}

func yamlMappingString(node *yaml.Node, key string) (string, bool, error) {
	value := yamlMappingValue(node, key)
	if value == nil {
		return "", false, nil
	}
	if value.Kind != yaml.ScalarNode || value.Tag == "!!null" {
		return "", true, fmt.Errorf("expected scalar")
	}
	return value.Value, true, nil
}

func yamlMappingStringList(node *yaml.Node, key string) ([]string, error) {
	value := yamlMappingValue(node, key)
	if value == nil {
		return nil, fmt.Errorf("missing string array")
	}
	if value.Kind != yaml.SequenceNode {
		return nil, fmt.Errorf("expected sequence")
	}
	result := make([]string, 0, len(value.Content))
	for _, item := range value.Content {
		if item == nil || item.Kind != yaml.ScalarNode || item.Tag == "!!null" {
			return nil, fmt.Errorf("expected string item")
		}
		result = append(result, item.Value)
	}
	return result, nil
}

func deepSeekHarnessConfigFormatError(text mcpClientInstallTextFunc, path string, expected string) error {
	return externalMCPClientError(text, "ai.service.mcp_client.external.config_format_invalid", "DeepSeek Harness", map[string]any{
		"path":     path,
		"expected": expected,
	})
}
