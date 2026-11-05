package aiservice

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// 桌面客户端的安装检测。
//
// 原先「是否检测到客户端」只看 exec.LookPath：装了 Claude Desktop 或 Cursor
// 桌面版、但没装对应 CLI 的用户会被判成「未检测到客户端」，明明装了却接不进去。
// 这里补上桌面应用的安装判定：CLI 存在 **或** 桌面应用存在，都算检测到。
//
// 只认确定的应用名，路径不存在就返回 false——不做模糊匹配，避免把同名的
// 无关应用误判成客户端。

// localMCPClientDesktopAppNames 把客户端标识映射到桌面应用的显示名（不含 .app）。
// 没有独立桌面客户端的条目留空，检测会直接跳过。
var localMCPClientDesktopAppNames = map[string]string{
	"claude":   "Claude",
	"codex":    "Codex",
	"cursor":   "Cursor",
	"kimi":     "Kimi",
	"zcode":    "ZCode",
	"grok":     "Grok",
	"opencode": "OpenCode",
	"dsh":      "DeepSeek Harness",
}

var (
	localMCPClientDesktopDetectMu    sync.Mutex
	localMCPClientDesktopDetectCache = map[string]string{}
)

// localMCPClientDesktopAppPathFunc 是检测钩子，测试可替换以免受开发机
// 上真实安装的 /Applications/Claude.app 影响。
var localMCPClientDesktopAppPathFunc = localMCPClientDesktopAppPath

// localMCPClientDesktopAppPath 返回命中的桌面应用路径；未安装返回空串。
//
// macOS 只看 /Applications 与 ~/Applications 两个标准位置；其他平台暂不做
// 桌面端判定——各家的 Windows 安装目录差异很大，猜错会被当成「已安装」，
// 比不检测更糟。
func localMCPClientDesktopAppPath(commandName string) string {
	name := strings.TrimSpace(localMCPClientDesktopAppNames[strings.TrimSpace(commandName)])
	if name == "" || runtime.GOOS != "darwin" {
		return ""
	}

	localMCPClientDesktopDetectMu.Lock()
	if cached, ok := localMCPClientDesktopDetectCache[commandName]; ok {
		localMCPClientDesktopDetectMu.Unlock()
		return cached
	}
	localMCPClientDesktopDetectMu.Unlock()

	candidates := []string{
		filepath.Join("/Applications", name+".app"),
	}
	if homeDir, err := resolveMCPClientUserHomeDir(); err == nil && strings.TrimSpace(homeDir) != "" {
		candidates = append(candidates, filepath.Join(homeDir, "Applications", name+".app"))
	}

	found := ""
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			found = candidate
			break
		}
	}

	localMCPClientDesktopDetectMu.Lock()
	localMCPClientDesktopDetectCache[commandName] = found
	localMCPClientDesktopDetectMu.Unlock()
	return found
}

// resetLocalMCPClientDesktopDetectCache 供测试清空缓存。
func resetLocalMCPClientDesktopDetectCache() {
	localMCPClientDesktopDetectMu.Lock()
	localMCPClientDesktopDetectCache = map[string]string{}
	localMCPClientDesktopDetectMu.Unlock()
}

// claudeDesktopConfigPath 返回 Claude Desktop 的 MCP 配置路径。
//
// 与 Claude Code 的 ~/.claude.json 是两个完全独立的文件：桌面端只读它自己的
// claude_desktop_config.json，写到 CLI 的配置里桌面端是看不到的。两者的
// mcpServers 结构一致，所以读写逻辑可以复用，只有路径不同。
func claudeDesktopConfigPath() (string, error) {
	if runtime.GOOS == "darwin" {
		homeDir, err := resolveMCPClientUserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json"), nil
	}
	appData := strings.TrimSpace(os.Getenv("APPDATA"))
	if appData == "" {
		return "", errMCPClientUserHomeDirUnavailable
	}
	return filepath.Join(appData, "Claude", "claude_desktop_config.json"), nil
}

// resolveClaudeMCPConfigPath 按实际安装形态选配置路径。
//
// 优先 CLI：已装 Claude Code 的用户维持原行为，不受这次改动影响。
// 只有「没装 CLI、但装了桌面端」时才落到桌面端配置——这正是原先被漏掉的场景。
func resolveClaudeMCPConfigPath() (string, error) {
	if detected, _ := detectLocalCLICommand(claudeCodeClientCommandName); detected {
		return claudeCodeConfigPathFunc()
	}
	if localMCPClientDesktopAppPathFunc(claudeCodeClientCommandName) != "" {
		return claudeDesktopConfigPath()
	}
	return claudeCodeConfigPathFunc()
}
