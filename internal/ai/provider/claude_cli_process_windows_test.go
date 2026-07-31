//go:build windows

package provider

import (
	"os/exec"
	"syscall"
	"testing"
)

func TestConfigureClaudeCLICommandHidesWindowsConsole(t *testing.T) {
	const existingCreationFlag uint32 = 0x00000004
	cmd := &exec.Cmd{
		SysProcAttr: &syscall.SysProcAttr{CreationFlags: existingCreationFlag},
	}

	configureClaudeCLICommand(cmd)

	if cmd.SysProcAttr == nil {
		t.Fatal("expected Windows process attributes to be configured")
	}
	if !cmd.SysProcAttr.HideWindow {
		t.Fatal("expected Claude CLI window to be hidden")
	}
	if cmd.SysProcAttr.CreationFlags&claudeCLIWindowsCreateNoWindow == 0 {
		t.Fatalf("expected CREATE_NO_WINDOW, got creation flags %#x", cmd.SysProcAttr.CreationFlags)
	}
	if cmd.SysProcAttr.CreationFlags&existingCreationFlag == 0 {
		t.Fatalf("expected existing creation flags to be preserved, got %#x", cmd.SysProcAttr.CreationFlags)
	}
}
