//go:build windows

package db

import (
	"os/exec"
	"syscall"
)

const windowsCreateNoWindow = 0x08000000

func configureAgentProcess(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windowsCreateNoWindow,
	}
}
