//go:build windows

package app

import (
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"GoNavi-Wails/internal/logger"

	"golang.org/x/sys/windows"
)

const windowsCreateNoWindow = 0x08000000

const (
	windowsCloseMessage              = 0x0010
	windowsGracefulProcessCloseWait  = 1500 * time.Millisecond
	windowsForcedProcessCloseTimeout = 10 * time.Second
	// A candidate mid-teardown keeps failing its image-name query until the
	// PID disappears or the query succeeds; a few short retries separate the
	// two outcomes without delaying a healthy enumeration.
	windowsProcessInspectAttempts = 4
)

var (
	windowsProcessImageKernel32         = windows.NewLazySystemDLL("kernel32.dll")
	windowsProcessGetImageFileName      = windowsProcessImageKernel32.NewProc("K32GetProcessImageFileNameW")
	windowsUpdateQueryProcessExecutable = queryWindowsProcessExecutable
	windowsUpdateInspectRetryDelay      = 200 * time.Millisecond
	windowsUpdateDosDeviceTarget        = queryWindowsDosDeviceTarget
)

func configureWindowsUpdateCommand(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windowsCreateNoWindow,
	}
}

func findOtherWindowsUpdateInstances(targetPaths []string, currentPID int) ([]windowsUpdateProcess, error) {
	targets := make(map[string]struct{}, len(targetPaths)*2)
	targetNames := make(map[string]struct{}, len(targetPaths))
	for _, targetPath := range targetPaths {
		addWindowsUpdateComparablePath(targets, targetPath)
		if name := strings.ToLower(filepath.Base(strings.TrimSpace(targetPath))); name != "" && name != "." {
			targetNames[name] = struct{}{}
		}
	}
	if len(targets) == 0 {
		return nil, nil
	}

	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, fmt.Errorf("enumerate running processes: %w", err)
	}
	defer windows.CloseHandle(snapshot)

	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	if err := windows.Process32First(snapshot, &entry); err != nil {
		if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
			return nil, nil
		}
		return nil, fmt.Errorf("read running processes: %w", err)
	}

	result := make([]windowsUpdateProcess, 0, 2)
	for {
		pid := entry.ProcessID
		if pid != 0 && int(pid) != currentPID {
			executable, queryErr := windowsUpdateQueryProcessExecutable(pid)
			if queryErr != nil {
				executable, queryErr = retryWindowsProcessExecutableQuery(pid, queryErr)
			}
			if queryErr == nil && windowsUpdatePathMatches(targets, executable) {
				result = append(result, windowsUpdateProcess{PID: pid, Executable: executable})
			} else if queryErr != nil && !errors.Is(queryErr, windows.ERROR_INVALID_PARAMETER) {
				entryName := strings.ToLower(windows.UTF16ToString(entry.ExeFile[:]))
				if _, mayBeTarget := targetNames[entryName]; mayBeTarget {
					if errors.Is(queryErr, windows.ERROR_ACCESS_DENIED) {
						// A protected live instance can neither be verified nor
						// terminated, so the update cannot guarantee a clean
						// close and must fail with a visible reason.
						return nil, fmt.Errorf("inspect possible GoNavi process %d (%s): %w", pid, entryName, queryErr)
					}
					// A candidate that already exited can keep reporting
					// transient image-query errors (ERROR_GEN_FAILURE) until
					// the PID disappears. Skipping it is safe: a dying process
					// is gone before the installer starts, and a live one is
					// reported by the installer's own files-in-use handling.
					logger.Warnf("跳过无法核实的疑似 GoNavi 进程 pid=%d name=%s error=%v", pid, entryName, queryErr)
				}
			}
		}

		if err := windows.Process32Next(snapshot, &entry); err != nil {
			if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
				break
			}
			return nil, fmt.Errorf("read running processes: %w", err)
		}
	}
	markWindowsUpdateInteractiveInstances(result)
	return result, nil
}

// retryWindowsProcessExecutableQuery re-queries a candidate whose image-name
// inspection failed. A process mid-teardown keeps failing with transient
// errors until OpenProcess starts reporting ERROR_INVALID_PARAMETER, so the
// retry window lets a dying candidate resolve itself; access-denied and
// already-invalid PIDs cannot change and stop the loop immediately.
func retryWindowsProcessExecutableQuery(pid uint32, firstErr error) (string, error) {
	executable := ""
	queryErr := firstErr
	for attempt := 1; attempt < windowsProcessInspectAttempts; attempt++ {
		if queryErr == nil || errors.Is(queryErr, windows.ERROR_ACCESS_DENIED) || errors.Is(queryErr, windows.ERROR_INVALID_PARAMETER) {
			break
		}
		time.Sleep(windowsUpdateInspectRetryDelay)
		executable, queryErr = windowsUpdateQueryProcessExecutable(pid)
	}
	return executable, queryErr
}

func closeWindowsUpdateInstances(processes []windowsUpdateProcess) error {
	unique := make(map[uint32]windowsUpdateProcess, len(processes))
	for _, process := range processes {
		if process.PID != 0 {
			unique[process.PID] = process
		}
	}
	if len(unique) == 0 {
		return nil
	}

	opened, err := openWindowsUpdateProcesses(unique)
	if err != nil {
		return err
	}
	defer func() {
		for _, process := range opened {
			windows.CloseHandle(process.handle)
		}
	}()
	if len(opened) == 0 {
		return nil
	}

	openedByPID := make(map[uint32]windowsUpdateProcess, len(opened))
	for _, process := range opened {
		openedByPID[process.process.PID] = process.process
	}
	interactive := requestWindowsProcessesClose(openedByPID)

	// Only an instance with an application window can act on WM_CLOSE. All
	// of them share one graceful deadline instead of one wait each, and
	// headless helpers (MCP servers, the runtime reaper) skip the wait: they
	// never see the message, so waiting only delayed the update by 1.5s per
	// process.
	var closeErrors []error
	gracefulDeadline := time.Now().Add(windowsGracefulProcessCloseWait)
	remaining := make([]openedWindowsUpdateProcess, 0, len(opened))
	for _, process := range opened {
		var wait time.Duration
		if interactive[process.process.PID] {
			wait = time.Until(gracefulDeadline)
		}
		exited, err := waitWindowsUpdateProcessExit(process, wait)
		if err != nil {
			closeErrors = append(closeErrors, err)
			continue
		}
		if !exited {
			remaining = append(remaining, process)
		}
	}

	terminated := make([]openedWindowsUpdateProcess, 0, len(remaining))
	for _, process := range remaining {
		if err := windows.TerminateProcess(process.handle, 0); err != nil {
			// The process may have exited on its own right after the wait.
			if exited, _ := waitWindowsUpdateProcessExit(process, 0); exited {
				continue
			}
			closeErrors = append(closeErrors, fmt.Errorf("terminate GoNavi process %d (%s): %w", process.process.PID, process.process.Executable, err))
			continue
		}
		terminated = append(terminated, process)
	}
	forcedDeadline := time.Now().Add(windowsForcedProcessCloseTimeout)
	for _, process := range terminated {
		exited, err := waitWindowsUpdateProcessExit(process, time.Until(forcedDeadline))
		if err != nil {
			closeErrors = append(closeErrors, err)
			continue
		}
		if !exited {
			closeErrors = append(closeErrors, fmt.Errorf("GoNavi process %d did not exit after termination", process.process.PID))
		}
	}
	return errors.Join(closeErrors...)
}

type openedWindowsUpdateProcess struct {
	process windowsUpdateProcess
	handle  windows.Handle
}

func openWindowsUpdateProcesses(processes map[uint32]windowsUpdateProcess) ([]openedWindowsUpdateProcess, error) {
	opened := make([]openedWindowsUpdateProcess, 0, len(processes))
	for _, process := range processes {
		handle, err := windows.OpenProcess(
			windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE,
			false,
			process.PID,
		)
		if err != nil {
			if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
				continue
			}
			for _, item := range opened {
				windows.CloseHandle(item.handle)
			}
			return nil, fmt.Errorf("open GoNavi process %d (%s): %w", process.PID, process.Executable, err)
		}

		actualExecutable, queryErr := queryWindowsProcessExecutableFromHandle(handle)
		if queryErr != nil {
			windows.CloseHandle(handle)
			for _, item := range opened {
				windows.CloseHandle(item.handle)
			}
			return nil, fmt.Errorf("verify GoNavi process %d (%s): %w", process.PID, process.Executable, queryErr)
		}
		expectedPaths := make(map[string]struct{}, 2)
		addWindowsUpdateComparablePath(expectedPaths, process.Executable)
		if !windowsUpdatePathMatches(expectedPaths, actualExecutable) {
			windows.CloseHandle(handle)
			for _, item := range opened {
				windows.CloseHandle(item.handle)
			}
			return nil, fmt.Errorf(
				"GoNavi process %d executable changed from %s to %s",
				process.PID,
				process.Executable,
				actualExecutable,
			)
		}
		opened = append(opened, openedWindowsUpdateProcess{process: process, handle: handle})
	}
	return opened, nil
}

// waitWindowsUpdateProcessExit waits up to timeout for the process to exit; a
// non-positive timeout only polls its current state.
func waitWindowsUpdateProcessExit(opened openedWindowsUpdateProcess, timeout time.Duration) (bool, error) {
	if timeout < 0 {
		timeout = 0
	}
	event, err := windows.WaitForSingleObject(opened.handle, uint32(timeout.Milliseconds()))
	if err != nil {
		return false, fmt.Errorf("wait for GoNavi process %d to close: %w", opened.process.PID, err)
	}
	switch event {
	case windows.WAIT_OBJECT_0:
		return true, nil
	case uint32(windows.WAIT_TIMEOUT):
		return false, nil
	default:
		return false, fmt.Errorf("wait for GoNavi process %d returned status %#x", opened.process.PID, event)
	}
}

func queryWindowsProcessExecutable(pid uint32) (string, error) {
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(process)
	return queryWindowsProcessExecutableFromHandle(process)
}

func queryWindowsProcessExecutableFromHandle(process windows.Handle) (string, error) {
	buffer := make([]uint16, windows.MAX_LONG_PATH)
	size := uint32(len(buffer))
	queryErr := windows.QueryFullProcessImageName(process, 0, &buffer[0], &size)
	if queryErr == nil {
		if size == 0 {
			return "", errors.New("process executable path is empty")
		}
		return windows.UTF16ToString(buffer[:size]), nil
	}
	// A terminating process can fail this query with transient errors such as
	// ERROR_GEN_FAILURE. The kernel image-name query reads the same
	// section-backed path through a different code path and often still
	// succeeds, but only returns a device path that must be mapped back to a
	// DOS drive letter before it can match the update target.
	devicePath, fallbackErr := queryWindowsProcessImageDeviceName(process)
	if fallbackErr != nil {
		return "", queryErr
	}
	drivePath, ok := convertWindowsDevicePathToDrivePath(devicePath, windowsUpdateDosDeviceTarget)
	if !ok {
		return "", queryErr
	}
	return drivePath, nil
}

func queryWindowsProcessImageDeviceName(process windows.Handle) (string, error) {
	buffer := make([]uint16, windows.MAX_LONG_PATH)
	result, _, callErr := windowsProcessGetImageFileName.Call(
		uintptr(process),
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(len(buffer)),
	)
	if result == 0 {
		return "", fmt.Errorf("query process image device path: %w", callErr)
	}
	if result >= uintptr(len(buffer)) {
		return "", fmt.Errorf("process image device path exceeds %d characters", len(buffer)-1)
	}
	return windows.UTF16ToString(buffer[:result]), nil
}

func queryWindowsDosDeviceTarget(drive string) (string, error) {
	pointer, err := windows.UTF16PtrFromString(drive)
	if err != nil {
		return "", err
	}
	buffer := make([]uint16, 512)
	if _, err := windows.QueryDosDevice(pointer, &buffer[0], uint32(len(buffer))); err != nil {
		return "", err
	}
	// QueryDosDevice returns a MULTI_SZ list whose first entry is the active
	// mapping; UTF16ToString stops at the first NUL.
	target := windows.UTF16ToString(buffer)
	if target == "" {
		return "", errors.New("empty DOS device mapping")
	}
	return target, nil
}

// convertWindowsDevicePathToDrivePath maps a kernel device path such as
// `\Device\HarddiskVolume3\Tools\GoNavi.exe` to its DOS drive form by
// comparing against each drive letter's QueryDosDevice target.
func convertWindowsDevicePathToDrivePath(devicePath string, dosDeviceTarget func(string) (string, error)) (string, bool) {
	trimmed := strings.TrimSpace(devicePath)
	normalized := strings.ToLower(trimmed)
	if !strings.HasPrefix(normalized, `\device\`) {
		return "", false
	}
	for letter := 'A'; letter <= 'Z'; letter++ {
		drive := string(letter) + ":"
		target, err := dosDeviceTarget(drive)
		if err != nil || strings.TrimSpace(target) == "" {
			continue
		}
		if !strings.HasPrefix(normalized, strings.ToLower(target)) {
			continue
		}
		rest := trimmed[len(target):]
		// Reject prefix collisions such as \Device\HarddiskVolume3 matching
		// the drive whose target is \Device\HarddiskVolume30.
		if !strings.HasPrefix(rest, `\`) {
			continue
		}
		return drive + rest, true
	}
	return "", false
}

func windowsUpdatePathMatches(targets map[string]struct{}, executable string) bool {
	paths := make(map[string]struct{}, 2)
	addWindowsUpdateComparablePath(paths, executable)
	for path := range paths {
		if _, ok := targets[path]; ok {
			return true
		}
	}
	return false
}

func addWindowsUpdateComparablePath(paths map[string]struct{}, path string) {
	path = strings.TrimSpace(path)
	if path == "" {
		return
	}
	path = strings.TrimPrefix(path, `\\?\`)
	if absolute, err := filepath.Abs(path); err == nil {
		path = absolute
	}
	path = strings.ToLower(filepath.Clean(path))
	paths[path] = struct{}{}

	if evaluated, err := filepath.EvalSymlinks(path); err == nil {
		paths[strings.ToLower(filepath.Clean(evaluated))] = struct{}{}
	}
}
