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
	"strconv"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/provider"
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
var localCLICommandShellCandidatesFunc = localCLICommandShellCandidates
var localCLICommandShellOutputFunc = runLocalCLICommandShell
var localCLICommandShellLookupTimeout = 2 * time.Second
var buildWailsDevelopmentMCPServerFunc = buildWailsDevelopmentMCPServer
var wailsDevelopmentMCPBuildMu sync.Mutex

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
	// 每个 inspect 都可能触发一次命令存在性探测（未命中缓存时要起 login shell）。
	// 它们彼此独立且只读，串行执行会把 7 次探测的耗时直接叠加到设置页打开路径上，
	// 所以并发执行并按固定下标写回，保持返回顺序稳定。
	inspectors := []func() ai.MCPClientInstallStatus{
		func() ai.MCPClientInstallStatus {
			return inspectClaudeCodeMCPInstallStatus(command, args, resolveErr, s.serviceText)
		},
		func() ai.MCPClientInstallStatus {
			return inspectCodexMCPInstallStatus(command, args, resolveErr, s.serviceText)
		},
		func() ai.MCPClientInstallStatus {
			return inspectOpenCodeMCPInstallStatus(command, args, resolveErr, s.serviceText)
		},
		func() ai.MCPClientInstallStatus {
			return inspectExternalJSONMCPClientInstallStatus(zCodeMCPClientSpec, command, args, resolveErr, s.serviceText)
		},
		func() ai.MCPClientInstallStatus {
			return inspectDeepSeekHarnessMCPInstallStatus(command, args, resolveErr, s.serviceText)
		},
		func() ai.MCPClientInstallStatus {
			return inspectExternalJSONMCPClientInstallStatus(kimiCodeMCPClientSpec, command, args, resolveErr, s.serviceText)
		},
		func() ai.MCPClientInstallStatus {
			return inspectGrokBuildMCPInstallStatus(command, args, resolveErr, s.serviceText)
		},
		func() ai.MCPClientInstallStatus {
			return buildRemoteMCPClientInstallStatus("openclaw", "OpenClaw", s.serviceText)
		},
		func() ai.MCPClientInstallStatus {
			return buildRemoteMCPClientInstallStatus("hermans", "Hermans", s.serviceText)
		},
	}
	statuses := make([]ai.MCPClientInstallStatus, len(inspectors))
	var wg sync.WaitGroup
	for index, inspect := range inspectors {
		wg.Add(1)
		go func(index int, inspect func() ai.MCPClientInstallStatus) {
			defer wg.Done()
			statuses[index] = inspect()
		}(index, inspect)
	}
	wg.Wait()
	return statuses
}

// AIInstallClaudeCodeMCP 把 GoNavi 的 MCP server 写入 Claude Code 用户级 MCP 配置。
func (s *Service) AIInstallClaudeCodeMCP() (ai.MCPClientInstallResult, error) {
	configPath, err := claudeCodeConfigPathFunc()
	if err != nil {
		return ai.MCPClientInstallResult{}, fmt.Errorf("%s", s.serviceText("ai.service.mcp_client.claude_code.config_path_failed", map[string]any{"detail": localizeMCPClientPathDetail(s.serviceText, err)}))
	}
	if err := requireLocalMCPClientCommand(claudeCodeClientCommandName, "Claude Code", s.serviceText); err != nil {
		return ai.MCPClientInstallResult{}, err
	}

	command, args, err := resolveCurrentLocalMCPCommand(s.serviceText)
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
	if err := requireLocalMCPClientCommand(codexClientCommandName, "Codex", s.serviceText); err != nil {
		return ai.MCPClientInstallResult{}, err
	}

	command, args, err := resolveCurrentLocalMCPCommand(s.serviceText)
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

// localCLICommandDetectionTTL 决定命令存在性探测结果的复用窗口。
//
// 未命中缓存时，先 LookPath，再读 nvm default（文件系统，毫秒级），Unix 才退到 login shell。
// 只有 nvm 也没有的命令才要把候选 shell 各起一次，单项约 1s。
// 设置页一次要探测 7 个客户端，串行叠加就是 2–4.5s 的白屏。
// 命令是否安装在一次会话里几乎不变，因此按短 TTL 复用；安装 MCP 配置只改配置文件，
// 不改变命令存在性，所以不需要为安装动作单独失效。
var localCLICommandDetectionTTL = 60 * time.Second

type localCLICommandDetection struct {
	found     bool
	path      string
	expiresAt time.Time
}

var (
	localCLICommandDetectionMu    sync.Mutex
	localCLICommandDetectionCache = map[string]localCLICommandDetection{}
)

// localCLICommandCacheKey 把探测所依赖的三个钩子的函数身份并入键。
// 测试替换任一钩子后键即改变，缓存自然失效，因此既有用例不需要感知这层缓存，
// 也不会被上一个用例的探测结果污染。
func localCLICommandCacheKey(commandName string) string {
	return fmt.Sprintf("%s\x00%x\x00%x\x00%x",
		commandName,
		reflect.ValueOf(localCLICommandPathFunc).Pointer(),
		reflect.ValueOf(localCLICommandShellCandidatesFunc).Pointer(),
		reflect.ValueOf(localCLICommandShellOutputFunc).Pointer(),
	)
}

func lookupLocalCLICommandCache(commandName string) (localCLICommandDetection, bool) {
	localCLICommandDetectionMu.Lock()
	defer localCLICommandDetectionMu.Unlock()
	entry, ok := localCLICommandDetectionCache[localCLICommandCacheKey(commandName)]
	if !ok || time.Now().After(entry.expiresAt) {
		return localCLICommandDetection{}, false
	}
	return entry, true
}

func storeLocalCLICommandCache(commandName string, found bool, path string) {
	localCLICommandDetectionMu.Lock()
	defer localCLICommandDetectionMu.Unlock()
	localCLICommandDetectionCache[localCLICommandCacheKey(commandName)] = localCLICommandDetection{
		found:     found,
		path:      path,
		expiresAt: time.Now().Add(localCLICommandDetectionTTL),
	}
}

// resetLocalCLICommandCache 供测试清空缓存，避免用例之间互相污染。
func resetLocalCLICommandCache() {
	localCLICommandDetectionMu.Lock()
	defer localCLICommandDetectionMu.Unlock()
	localCLICommandDetectionCache = map[string]localCLICommandDetection{}
}

func detectLocalCLICommand(commandName string) (bool, string) {
	commandName = strings.TrimSpace(commandName)
	if commandName == "" {
		return false, ""
	}
	if entry, ok := lookupLocalCLICommandCache(commandName); ok {
		return entry.found, entry.path
	}
	found, path := detectLocalCLICommandUncached(commandName)
	storeLocalCLICommandCache(commandName, found, path)
	return found, path
}

func detectLocalCLICommandUncached(commandName string) (bool, string) {
	resolvedPath, err := provider.LookupLocalCLICommandUsing(provider.CLILookupHooks{
		LookPath:        localCLICommandPathFunc,
		ShellCandidates: localCLICommandShellCandidatesFunc,
		ShellOutput:     localCLICommandShellOutputFunc,
		Timeout:         localCLICommandShellLookupTimeout,
	}, commandName)
	if err != nil || strings.TrimSpace(resolvedPath) == "" {
		return false, ""
	}
	return true, filepath.Clean(strings.TrimSpace(resolvedPath))
}

func runLocalCLICommandShell(ctx context.Context, shell string, lookupCommand string) ([]byte, error) {
	return exec.CommandContext(ctx, shell, "-ilc", lookupCommand).Output()
}

func localCLICommandShellCandidates() []string {
	seen := make(map[string]struct{}, 4)
	result := make([]string, 0, 4)
	appendShell := func(value string) {
		value = strings.TrimSpace(value)
		if value == "" {
			return
		}
		if _, ok := seen[value]; ok {
			return
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	appendShell(os.Getenv("SHELL"))
	appendShell("/bin/zsh")
	appendShell("/bin/bash")
	appendShell("/bin/sh")
	return result
}

func isLocalMCPClientCommandDetected(commandName string) bool {
	detected, _ := detectLocalCLICommand(commandName)
	return detected
}

func requireLocalMCPClientCommand(commandName string, displayName string, textFuncs ...mcpClientInstallTextFunc) error {
	if isLocalMCPClientCommandDetected(commandName) {
		return nil
	}
	text := firstMCPClientInstallText(textFuncs)
	return fmt.Errorf("%s", mcpClientInstallText(text, "ai.service.mcp_client.local_client_not_detected", map[string]any{
		"label":   strings.TrimSpace(displayName),
		"command": strings.TrimSpace(commandName),
	}))
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

	updated := replaceOrAppendTOMLMCPServerBlock(string(data), strings.TrimSpace(serverID), renderCodexMCPServerBlock(serverID, serverConfig))
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

func replaceOrAppendTOMLMCPServerBlock(content string, serverID string, block string) string {
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

// replaceOrAppendCodexMCPServerBlock preserves the existing helper name for
// callers and tests that were added before other TOML MCP clients existed.
func replaceOrAppendCodexMCPServerBlock(content string, serverID string, block string) string {
	return replaceOrAppendTOMLMCPServerBlock(content, serverID, block)
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

// prewarmLocalCLICommandCache 在后台预热外部客户端探测结果。
//
// 冷路径实测约 1.2s（未安装的命令要把候选 shell 逐个起 login shell 直到超时），
// 全部发生在设置页打开的同步路径上。启动时先在后台跑一遍，用户真正打开设置页时
// 命中缓存，代价降到毫秒级。预热失败没有后果——它只是提前填缓存，
// 真正的探测逻辑与结果判定完全不变。
func prewarmLocalCLICommandCache() {
	names := []string{
		claudeCodeClientCommandName,
		codexClientCommandName,
		openCodeClientCommandName,
		zCodeClientCommandName,
		kimiCodeClientCommandName,
		deepSeekHarnessClientCommandName,
		grokBuildClientCommandName,
	}
	var wg sync.WaitGroup
	for _, name := range names {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			detectLocalCLICommand(name)
		}(name)
	}
	wg.Wait()
}
