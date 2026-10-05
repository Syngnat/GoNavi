package aiservice

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

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
	// 它们彼此独立且只读，串行执行会把 8 次探测的耗时直接叠加到设置页打开路径上，
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
			return inspectExternalJSONMCPClientInstallStatus(cursorMCPClientSpec, command, args, resolveErr, s.serviceText)
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
