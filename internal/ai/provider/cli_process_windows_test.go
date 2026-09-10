//go:build windows

package provider

import (
	"context"
	"os/exec"
	"syscall"
	"testing"
)

func TestNewLocalCLICommandHidesWindowsConsole(t *testing.T) {
	const existingCreationFlag uint32 = 0x00000004
	const windowsCreateNoWindow uint32 = 0x08000000
	commandContext := func(ctx context.Context, name string, args ...string) *exec.Cmd {
		cmd := exec.CommandContext(ctx, name, args...)
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: existingCreationFlag}
		return cmd
	}

	cmd := newLocalCLICommand(commandContext, context.Background(), "local-cli.cmd", "--version")

	if cmd.SysProcAttr == nil {
		t.Fatal("expected Windows process attributes to be configured")
	}
	if !cmd.SysProcAttr.HideWindow {
		t.Fatal("expected local CLI window to be hidden")
	}
	if cmd.SysProcAttr.CreationFlags&windowsCreateNoWindow == 0 {
		t.Fatalf("expected CREATE_NO_WINDOW, got creation flags %#x", cmd.SysProcAttr.CreationFlags)
	}
	if cmd.SysProcAttr.CreationFlags&existingCreationFlag == 0 {
		t.Fatalf("expected existing creation flags to be preserved, got %#x", cmd.SysProcAttr.CreationFlags)
	}
}
