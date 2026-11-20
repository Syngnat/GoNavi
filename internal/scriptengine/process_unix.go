//go:build !windows

package scriptengine

import (
	"os/exec"
	"syscall"
)

func prepareWorkerCommand(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func attachWorkerJob(*exec.Cmd, int64) error {
	return nil
}

func releaseWorkerJob(*exec.Cmd) {}

func terminateWorkerProcess(command *exec.Cmd) {
	if command == nil || command.Process == nil {
		return
	}
	pid := command.Process.Pid
	if pid > 0 {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
	}
	_ = command.Process.Kill()
}

// killWorkerProcessHandle targets only the process represented by os.Process.
// Unlike a raw negative-PID signal, this path uses the process handle/pidfd
// maintained by Go and is safe to call while Wait may complete concurrently.
func killWorkerProcessHandle(command *exec.Cmd) {
	if command == nil || command.Process == nil {
		return
	}
	_ = command.Process.Kill()
}
