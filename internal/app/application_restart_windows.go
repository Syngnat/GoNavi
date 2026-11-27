//go:build windows

package app

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// restartApplicationProcess launches the same executable in a detached
// process. The child receives the current PID so main can wait for the old
// process to release the MSI single-instance event before creating its own.
func restartApplicationProcess() error {
	executablePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve executable: %w", err)
	}
	if executablePath == "" {
		return fmt.Errorf("resolved executable path is empty")
	}

	args := append([]string(nil), os.Args[1:]...)
	args = append(args, windowsRestartParentPIDArgument+fmt.Sprint(os.Getpid()))
	cmd := exec.Command(executablePath, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS,
		HideWindow:    true,
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start restarted application: %w", err)
	}
	return nil
}
