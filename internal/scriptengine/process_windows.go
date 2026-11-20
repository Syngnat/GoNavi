//go:build windows

package scriptengine

import (
	"os/exec"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var workerJobHandles sync.Map

func prepareWorkerCommand(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000,
	}
}

func attachWorkerJob(command *exec.Cmd, memoryLimitBytes int64) error {
	if command == nil || command.Process == nil {
		return nil
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if memoryLimitBytes > 0 {
		info.BasicLimitInformation.LimitFlags |= windows.JOB_OBJECT_LIMIT_PROCESS_MEMORY | windows.JOB_OBJECT_LIMIT_JOB_MEMORY
		info.ProcessMemoryLimit = uintptr(memoryLimitBytes)
		info.JobMemoryLimit = uintptr(memoryLimitBytes)
	}
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		_ = windows.CloseHandle(job)
		return err
	}
	process, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE,
		false,
		uint32(command.Process.Pid),
	)
	if err != nil {
		_ = windows.CloseHandle(job)
		return err
	}
	defer windows.CloseHandle(process)
	if err := windows.AssignProcessToJobObject(job, process); err != nil {
		_ = windows.CloseHandle(job)
		return err
	}
	workerJobHandles.Store(command.Process.Pid, job)
	return nil
}

func releaseWorkerJob(command *exec.Cmd) {
	if command == nil || command.Process == nil {
		return
	}
	if handle, ok := workerJobHandles.LoadAndDelete(command.Process.Pid); ok {
		_ = windows.CloseHandle(handle.(windows.Handle))
	}
}

func terminateWorkerProcess(command *exec.Cmd) {
	if command == nil || command.Process == nil {
		return
	}
	pid := command.Process.Pid
	if pid > 0 {
		if handle, ok := workerJobHandles.Load(pid); ok {
			_ = windows.TerminateJobObject(handle.(windows.Handle), 1)
		}
		kill := exec.Command("taskkill", "/PID", formatPID(pid), "/T", "/F")
		kill.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		_ = kill.Run()
	}
	_ = command.Process.Kill()
}

func killWorkerProcessHandle(command *exec.Cmd) {
	if command == nil || command.Process == nil {
		return
	}
	pid := command.Process.Pid
	if pid > 0 {
		if handle, ok := workerJobHandles.Load(pid); ok {
			_ = windows.TerminateJobObject(handle.(windows.Handle), 1)
		}
	}
	_ = command.Process.Kill()
}

func formatPID(pid int) string {
	if pid <= 0 {
		return ""
	}
	var digits [20]byte
	index := len(digits)
	for pid > 0 {
		index--
		digits[index] = byte('0' + pid%10)
		pid /= 10
	}
	return string(digits[index:])
}
