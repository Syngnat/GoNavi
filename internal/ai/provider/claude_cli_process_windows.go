//go:build windows

package provider

import (
	"os/exec"
	"syscall"
)

const claudeCLIWindowsCreateNoWindow uint32 = 0x08000000

func configureClaudeCLICommand(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= claudeCLIWindowsCreateNoWindow
}
