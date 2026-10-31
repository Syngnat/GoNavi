//go:build windows

package sessionagent

import (
	"context"
	"os/exec"
	"syscall"
	"testing"
)

// 探测命令不能弹出控制台窗口：桌面上闪一个黑窗很难解释。
func TestConfigureProbeProcessHidesWindowsConsole(t *testing.T) {
	cmd := exec.CommandContext(context.Background(), "codex", "--version")
	configureProbeProcess(cmd)
	if cmd.SysProcAttr == nil {
		t.Fatal("expected Windows process attributes to be configured")
	}
	if !cmd.SysProcAttr.HideWindow {
		t.Fatal("expected the probe process window to be hidden")
	}
	if cmd.SysProcAttr.CreationFlags&windowsCreateNoWindow == 0 {
		t.Fatalf("expected CREATE_NO_WINDOW, got creation flags %#x", cmd.SysProcAttr.CreationFlags)
	}
	_ = syscall.SysProcAttr{}
}
