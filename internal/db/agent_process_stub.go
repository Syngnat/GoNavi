//go:build !windows

package db

import "os/exec"

func configureAgentProcess(cmd *exec.Cmd) {
	_ = cmd
}
