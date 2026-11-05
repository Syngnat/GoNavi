package aiservice

import (
	"fmt"
	"os"
	"testing"

	"GoNavi-Wails/internal/logger"
)

// Package tests exercise failure paths that log a warning or an error, so the
// log must never point at the user's real GoNavi log file.
func TestMain(m *testing.M) {
	testLogDir, err := os.MkdirTemp("", "gonavi-aiservice-log-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "create AI service test log directory: %v\n", err)
		os.Exit(2)
	}
	_ = os.Setenv("GONAVI_LOG_DIR", testLogDir)
	logger.Init()

	// 预热的 goroutine 会活过用例，并在别的用例换掉包级探测钩子之后继续探测，
	// 把那些 hook 的断言打成随机失败（expected lookup for opencode, got "zcode"）。
	localCLICachePrewarmDisabled.Store(true)

	// 桌面客户端检测默认关闭：开发机上真的装着 /Applications/Claude.app，
	// 会让「未安装 CLI 应被拒绝」这类用例在本机通过、在 CI 失败（或反过来）。
	// 需要验证桌面端的用例自己覆盖这个钩子。
	localMCPClientDesktopAppPathFunc = func(string) string { return "" }

	code := m.Run()
	logger.Close()
	_ = os.RemoveAll(testLogDir)
	os.Exit(code)
}
