//go:build !windows

package sessionagent

import "os/exec"

// configureProbeProcess 在非 Windows 平台没有控制台窗口问题，空实现。
func configureProbeProcess(cmd *exec.Cmd) {
	_ = cmd
}
