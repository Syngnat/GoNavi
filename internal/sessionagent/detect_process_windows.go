//go:build windows

package sessionagent

import (
	"os/exec"
	"syscall"
)

const windowsCreateNoWindow = 0x08000000

// configureProbeProcess 让探测命令（codex/claude --version）不弹出控制台
// 窗口。Windows 上直接 exec 一个控制台程序会闪一个黑窗，桌面端体感很差。
func configureProbeProcess(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windowsCreateNoWindow,
	}
}
