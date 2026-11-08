//go:build windows

package app

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"GoNavi-Wails/internal/logger"

	"golang.org/x/sys/windows"
)

const windowsRuntimeReaperArgument = "--gonavi-reap-runtime-processes"

const maxProcessCommandLineBytes = 32 * 1024

var (
	windowsRuntimeReaperMu      sync.Mutex
	windowsRuntimeReaperStarted bool
	windowsWebViewJobStarted    bool
)

// HandleWindowsRuntimeReaperArgs runs the hidden cleanup process that waits
// for its parent GoNavi to exit and then stops leftover WebView2 processes.
// Windows 11 shows those processes under the host name, so a closed window
// otherwise leaves a list of GoNavi entries in Task Manager.
func HandleWindowsRuntimeReaperArgs(args []string) bool {
	if len(args) == 0 || args[0] != windowsRuntimeReaperArgument {
		return false
	}
	pid, err := parseWindowsRuntimeReaperParentPID(args)
	if err != nil {
		logger.Errorf("Windows 运行时进程回收器参数无效：%v", err)
		return true
	}
	if err := runWindowsRuntimeReaper(pid); err != nil {
		logger.Errorf("回收脱离宿主的 WebView 进程失败：%v", err)
	}
	return true
}

func parseWindowsRuntimeReaperParentPID(args []string) (int, error) {
	if len(args) != 2 {
		return 0, fmt.Errorf("expected parent process id")
	}
	pid, err := strconv.Atoi(args[1])
	if err != nil || pid <= 4 {
		return 0, fmt.Errorf("invalid parent process id %q", args[1])
	}
	return pid, nil
}

func runWindowsRuntimeReaper(parentPID int) error {
	if err := waitForWindowsProcessExit(parentPID); err != nil {
		logger.Warnf("等待 GoNavi 父进程退出失败，仍回收 WebView 进程：pid=%d err=%v", parentPID, err)
	}
	// Give Windows a moment to reparent the browser process before scanning.
	time.Sleep(150 * time.Millisecond)
	return reapOrphanedWindowsWebViewProcesses()
}

// StartWindowsRuntimeProcessReaper installs the WebView2 cleanup mechanism
// before WebView2 starts. A kill-on-close job object is preferred: the kernel
// terminates browser processes when GoNavi exits, with no helper process. The
// helper reaper stays as a fallback for environments where job assignment is
// rejected. Retrying from shutdown is safe: an installed mechanism is not
// started twice.
func StartWindowsRuntimeProcessReaper() {
	windowsRuntimeReaperMu.Lock()
	defer windowsRuntimeReaperMu.Unlock()
	if windowsRuntimeReaperStarted || windowsWebViewJobStarted {
		return
	}
	err := startWindowsWebViewJob()
	if err == nil {
		windowsWebViewJobStarted = true
		return
	}
	logger.Warnf("启动 WebView2 Job Object 失败，回退到进程回收器：%v", err)
	if err := startWindowsRuntimeProcessReaper(); err != nil {
		logger.Warnf("启动 Windows 运行时进程回收器失败：%v", err)
		return
	}
	windowsRuntimeReaperStarted = true
}

// startWindowsRuntimeReaperFallback launches the legacy helper after the job
// watcher reports that assignment is not permitted. It is a no-op when a
// reaper is already running.
func startWindowsRuntimeReaperFallback() {
	windowsRuntimeReaperMu.Lock()
	defer windowsRuntimeReaperMu.Unlock()
	if windowsRuntimeReaperStarted {
		return
	}
	if err := startWindowsRuntimeProcessReaper(); err != nil {
		logger.Warnf("启动 Windows 运行时进程回收器失败：%v", err)
		return
	}
	windowsRuntimeReaperStarted = true
}

func startWindowsRuntimeProcessReaper() error {
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve executable: %w", err)
	}
	command := exec.Command(executable, windowsRuntimeReaperArgument, strconv.Itoa(os.Getpid()))
	command.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windows.CREATE_NO_WINDOW,
	}
	if err := command.Start(); err != nil {
		return fmt.Errorf("start runtime reaper: %w", err)
	}
	if command.Process == nil {
		return errors.New("runtime reaper process is unavailable")
	}
	if err := command.Process.Release(); err != nil {
		logger.Warnf("释放 Windows 运行时进程回收器句柄失败：%v", err)
	}
	return nil
}

// ReapOrphanedWindowsWebViewProcesses stops WebView2 processes that still use
// GoNavi's user-data directory after their host process has exited.
func ReapOrphanedWindowsWebViewProcesses() {
	if err := reapOrphanedWindowsWebViewProcesses(); err != nil {
		logger.Warnf("回收脱离宿主的 WebView 进程失败：%v", err)
	}
}

func reapOrphanedWindowsWebViewProcesses() error {
	killed, err := terminateOrphanedWebViewProcesses(windowsWebViewImageName, windowsHostProcessImages(), windowsWebViewDataDirMarkers())
	if err != nil {
		return err
	}
	if killed > 0 {
		logger.Infof("已结束脱离宿主的 WebView 进程：count=%d", killed)
	}
	return nil
}

func terminateOrphanedWebViewProcesses(webViewImage string, hostImages map[string]struct{}, markers []string) (int, error) {
	nodes, err := listRuntimeProcesses(webViewImage, hostImages)
	if err != nil {
		return 0, err
	}
	targets := selectOrphanRuntimeTargets(nodes, webViewImage, hostImages, markers)
	return terminateRuntimeProcesses(targets)
}

func windowsHostProcessImages() map[string]struct{} {
	images := map[string]struct{}{"gonavi.exe": {}}
	if executable, err := os.Executable(); err == nil {
		if base := strings.ToLower(filepath.Base(executable)); base != "" && base != "." {
			images[base] = struct{}{}
		}
	}
	return images
}

func windowsWebViewDataDirMarkers() []string {
	appData := strings.TrimSpace(os.Getenv("APPDATA"))
	if appData == "" {
		return nil
	}
	exeName := "GoNavi.exe"
	if executable, err := os.Executable(); err == nil {
		if base := strings.TrimSpace(filepath.Base(executable)); base != "" && base != "." {
			exeName = base
		}
	}
	exeBase := strings.TrimSuffix(exeName, filepath.Ext(exeName))
	return uniquePathMarkers(
		filepath.Join(appData, "GoNavi", "WebView2"),
		filepath.Join(appData, exeName),
		filepath.Join(appData, exeBase),
	)
}

func uniquePathMarkers(paths ...string) []string {
	seen := make(map[string]struct{}, len(paths))
	markers := make([]string, 0, len(paths))
	for _, path := range paths {
		token := normalizePathToken(path)
		if token == "" || token == "." {
			continue
		}
		if _, exists := seen[token]; exists {
			continue
		}
		seen[token] = struct{}{}
		markers = append(markers, path)
	}
	return markers
}

func listRuntimeProcesses(webViewImage string, hostImages map[string]struct{}) ([]runtimeProcess, error) {
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

	webViewImage = strings.ToLower(strings.TrimSpace(webViewImage))
	nodes := make([]runtimeProcess, 0, 64)
	for {
		imageName := strings.ToLower(windows.UTF16ToString(entry.ExeFile[:]))
		node := runtimeProcess{PID: entry.ProcessID, ParentPID: entry.ParentProcessID, ImageName: imageName}
		if node.PID > 4 && shouldReadRuntimeCommandLine(imageName, webViewImage, hostImages) {
			commandLine, readErr := readProcessCommandLine(node.PID)
			if readErr == nil {
				node.CommandLine = commandLine
				node.CommandLineKnown = true
			}
		}
		nodes = append(nodes, node)
		if err := windows.Process32Next(snapshot, &entry); err != nil {
			if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
				break
			}
			return nil, fmt.Errorf("read running processes: %w", err)
		}
	}
	return nodes, nil
}

func shouldReadRuntimeCommandLine(imageName, webViewImage string, hostImages map[string]struct{}) bool {
	if imageName == webViewImage {
		return true
	}
	_, host := hostImages[imageName]
	return host
}

func terminateRuntimeProcesses(pids []uint32) (int, error) {
	killed := 0
	var first error
	for _, pid := range pids {
		stopped, err := terminateWindowsPID(pid)
		if err != nil && first == nil {
			first = fmt.Errorf("terminate process %d: %w", pid, err)
		}
		if stopped {
			killed++
		}
	}
	return killed, first
}

func terminateWindowsPID(pid uint32) (bool, error) {
	if pid <= 4 || int(pid) == os.Getpid() {
		return false, fmt.Errorf("refuse to terminate process %d", pid)
	}
	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, pid)
	if err != nil {
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			return false, nil
		}
		return false, err
	}
	defer windows.CloseHandle(handle)
	if err := windows.TerminateProcess(handle, 1); err != nil {
		return false, err
	}
	return true, nil
}

func waitForWindowsProcessExit(pid int) error {
	if pid <= 4 {
		return fmt.Errorf("invalid process id %d", pid)
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			return nil
		}
		return fmt.Errorf("open process %d: %w", pid, err)
	}
	defer windows.CloseHandle(handle)
	result, err := windows.WaitForSingleObject(handle, windows.INFINITE)
	if err != nil {
		return fmt.Errorf("wait for process %d: %w", pid, err)
	}
	if result != windows.WAIT_OBJECT_0 {
		return fmt.Errorf("wait for process %d returned status %#x", pid, result)
	}
	return nil
}

func readProcessCommandLine(pid uint32) (string, error) {
	if unsafe.Sizeof(uintptr(0)) != 8 {
		return "", errors.New("reading a process command line requires a 64-bit process")
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_INFORMATION|windows.PROCESS_VM_READ, false, pid)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(handle)

	var info windows.PROCESS_BASIC_INFORMATION
	var returned uint32
	err = windows.NtQueryInformationProcess(
		handle,
		windows.ProcessBasicInformation,
		unsafe.Pointer(&info),
		uint32(unsafe.Sizeof(info)),
		&returned,
	)
	if err != nil {
		return "", err
	}
	if info.PebBaseAddress == nil {
		return "", errors.New("process peb is unavailable")
	}
	// ProcessParameters sits at PEB+0x20 on 64-bit Windows. Reading only that
	// pointer avoids depending on the full PEB layout.
	var paramsAddress uint64
	pebAddress := uintptr(unsafe.Pointer(info.PebBaseAddress))
	if err := readProcessMemory(handle, pebAddress+0x20, unsafe.Pointer(&paramsAddress), unsafe.Sizeof(paramsAddress)); err != nil {
		return "", err
	}
	if paramsAddress == 0 {
		return "", errors.New("process parameters are unavailable")
	}
	return readProcessCommandLineAt(handle, uintptr(paramsAddress))
}

func readProcessCommandLineAt(handle windows.Handle, paramsAddress uintptr) (string, error) {
	// RTL_USER_PROCESS_PARAMETERS.CommandLine is at offset 0x70 on 64-bit Windows.
	const commandLineOffset = 0x70
	buffer := make([]byte, commandLineOffset+16)
	if err := readProcessMemory(handle, paramsAddress, unsafe.Pointer(&buffer[0]), uintptr(len(buffer))); err != nil {
		return "", err
	}
	length := binary.LittleEndian.Uint16(buffer[commandLineOffset:])
	address := uintptr(binary.LittleEndian.Uint64(buffer[commandLineOffset+8:]))
	return readRemoteUTF16(handle, address, length)
}

func readRemoteUTF16(handle windows.Handle, address uintptr, length uint16) (string, error) {
	if address == 0 || length == 0 {
		return "", nil
	}
	size := int(length)
	if size < 0 || size%2 != 0 {
		return "", fmt.Errorf("invalid command line length %d", length)
	}
	if size > maxProcessCommandLineBytes {
		size = maxProcessCommandLineBytes
	}
	buffer := make([]uint16, size/2)
	if err := readProcessMemory(handle, address, unsafe.Pointer(&buffer[0]), uintptr(size)); err != nil {
		return "", err
	}
	return windows.UTF16ToString(buffer), nil
}

func readProcessMemory(handle windows.Handle, address uintptr, destination unsafe.Pointer, size uintptr) error {
	if address == 0 || size == 0 || destination == nil {
		return errors.New("invalid process memory read")
	}
	var read uintptr
	err := windows.ReadProcessMemory(handle, address, (*byte)(destination), size, &read)
	if err != nil {
		return err
	}
	if read != size {
		return fmt.Errorf("short process memory read: %d/%d", read, size)
	}
	return nil
}
