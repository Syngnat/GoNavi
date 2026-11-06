package aiservice

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// 装了桌面客户端、但没装 CLI 的用户，原先会被判成「未检测到客户端」。
// 现在两者任一存在都算检测到。
func TestMCPClientDetectedByDesktopApp(t *testing.T) {
	originalDesktop := localMCPClientDesktopAppPathFunc
	originalCLI := localCLICommandPathFunc
	t.Cleanup(func() {
		localMCPClientDesktopAppPathFunc = originalDesktop
		localCLICommandPathFunc = originalCLI
		resetLocalMCPClientDesktopDetectCache()
	})

	// CLI 不存在
	localCLICommandPathFunc = func(string) (string, error) { return "", os.ErrNotExist }
	// 桌面端存在
	localMCPClientDesktopAppPathFunc = func(commandName string) string {
		if commandName == "claude" {
			return "/Applications/Claude.app"
		}
		return ""
	}

	if !isLocalMCPClientCommandDetected("claude") {
		t.Fatal("装了桌面客户端也应算检测到")
	}
	if isLocalMCPClientCommandDetected("cursor") {
		t.Fatal("既无 CLI 也无桌面端时应判为未检测到")
	}
}

// CLI 存在时维持原行为，不受桌面端影响。
func TestMCPClientDetectedByCLI(t *testing.T) {
	originalDesktop := localMCPClientDesktopAppPathFunc
	originalCLI := localCLICommandPathFunc
	t.Cleanup(func() {
		localMCPClientDesktopAppPathFunc = originalDesktop
		localCLICommandPathFunc = originalCLI
		resetLocalMCPClientDesktopDetectCache()
	})

	localCLICommandPathFunc = func(string) (string, error) { return "/usr/local/bin/claude", nil }
	localMCPClientDesktopAppPathFunc = func(string) string { return "" }

	if !isLocalMCPClientCommandDetected("claude") {
		t.Fatal("CLI 存在时应算检测到")
	}
}

// Claude Desktop 的配置与 Claude Code 是两个文件，不能写错地方。
func TestClaudeMCPConfigPathPrefersCLIThenDesktop(t *testing.T) {
	originalDesktop := localMCPClientDesktopAppPathFunc
	originalCLI := localCLICommandPathFunc
	originalConfigPath := claudeCodeConfigPathFunc
	originalDesktopConfigPath := claudeDesktopConfigPathFunc
	t.Cleanup(func() {
		localMCPClientDesktopAppPathFunc = originalDesktop
		localCLICommandPathFunc = originalCLI
		claudeCodeConfigPathFunc = originalConfigPath
		claudeDesktopConfigPathFunc = originalDesktopConfigPath
		resetLocalMCPClientDesktopDetectCache()
	})
	// CI 的 Linux 容器里 user home 未必可用，真实路径解析会直接失败。
	claudeDesktopConfigPathFunc = func() (string, error) {
		return "/home/u/Library/Application Support/Claude/claude_desktop_config.json", nil
	}

	claudeCodeConfigPathFunc = func() (string, error) { return "/home/u/.claude.json", nil }

	// 有 CLI：走 Claude Code 的配置
	localCLICommandPathFunc = func(string) (string, error) { return "/usr/local/bin/claude", nil }
	localMCPClientDesktopAppPathFunc = func(string) string { return "/Applications/Claude.app" }
	if got, _ := resolveClaudeMCPConfigPath(); got != "/home/u/.claude.json" {
		t.Fatalf("有 CLI 时应写 Claude Code 配置，got %q", got)
	}

	// 没 CLI、只有桌面端：走桌面端配置
	localCLICommandPathFunc = func(string) (string, error) { return "", os.ErrNotExist }
	got, err := resolveClaudeMCPConfigPath()
	if err != nil {
		t.Fatalf("解析桌面端配置路径失败：%v", err)
	}
	if !strings.Contains(got, "claude_desktop_config.json") {
		t.Fatalf("没 CLI 时应写桌面端配置，got %q", got)
	}
}

// 桌面应用检测只认确定的应用名；未登记的客户端直接判为未安装。
func TestMCPClientDesktopAppPathSkipsUnknownClient(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("仅 macOS 做桌面端判定")
	}
	resetLocalMCPClientDesktopDetectCache()
	t.Cleanup(resetLocalMCPClientDesktopDetectCache)

	if got := localMCPClientDesktopAppPath("not-a-real-client"); got != "" {
		t.Fatalf("未登记的客户端不应命中任何路径，got %q", got)
	}
}

// 桌面端路径落在标准位置，且以应用名命名。
func TestClaudeDesktopConfigPathShape(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS 专用路径")
	}
	path, err := claudeDesktopConfigPath()
	if err != nil {
		t.Fatalf("解析桌面端配置路径失败：%v", err)
	}
	if filepath.Base(path) != "claude_desktop_config.json" {
		t.Fatalf("配置文件名不对：%q", path)
	}
	if !strings.Contains(path, filepath.Join("Library", "Application Support", "Claude")) {
		t.Fatalf("配置目录不对：%q", path)
	}
}
