//go:build windows

package app

import (
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// windowsMainWindowClass is the class of a GoNavi (Wails) application window;
// it identifies a GUI instance even while that window is still hidden.
const windowsMainWindowClass = "wailsWindow"

var (
	windowsUser32          = windows.NewLazySystemDLL("user32.dll")
	windowsPostMessage     = windowsUser32.NewProc("PostMessageW")
	windowsIsWindowVisible = windowsUser32.NewProc("IsWindowVisible")
	windowsGetClassName    = windowsUser32.NewProc("GetClassNameW")
)

var (
	windowsTopLevelWindowsMu    sync.Mutex
	windowsTopLevelWindowsVisit func(hwnd uintptr, pid uint32)
	// Go never frees a syscall callback, so every enumeration shares this one.
	windowsTopLevelWindowsCallback = sync.OnceValue(func() uintptr {
		return syscall.NewCallback(func(hwnd uintptr, _ uintptr) uintptr {
			var pid uint32
			if _, err := windows.GetWindowThreadProcessId(windows.HWND(hwnd), &pid); err == nil && windowsTopLevelWindowsVisit != nil {
				windowsTopLevelWindowsVisit(hwnd, pid)
			}
			return 1
		})
	})
)

// forEachWindowsTopLevelWindow calls visit with every top-level window and
// the process that owns it.
func forEachWindowsTopLevelWindow(visit func(hwnd uintptr, pid uint32)) {
	windowsTopLevelWindowsMu.Lock()
	defer windowsTopLevelWindowsMu.Unlock()
	windowsTopLevelWindowsVisit = visit
	defer func() { windowsTopLevelWindowsVisit = nil }()
	_ = windows.EnumWindows(windowsTopLevelWindowsCallback(), nil)
}

// requestWindowsProcessesClose posts WM_CLOSE to every top-level window of the
// given processes and reports which of them own an application window (a
// visible window or the Wails main window), i.e. can close gracefully.
func requestWindowsProcessesClose(processes map[uint32]windowsUpdateProcess) map[uint32]bool {
	interactive := make(map[uint32]bool, len(processes))
	forEachWindowsTopLevelWindow(func(hwnd uintptr, pid uint32) {
		if _, ok := processes[pid]; !ok {
			return
		}
		if !interactive[pid] && isWindowsApplicationWindow(hwnd) {
			interactive[pid] = true
		}
		windowsPostMessage.Call(hwnd, windowsCloseMessage, 0, 0)
	})
	return interactive
}

// markWindowsUpdateInteractiveInstances flags the instances that own an
// application window. The rest are headless helpers (the runtime reaper, MCP
// servers): they hold the executable open but no unsaved work, so an update
// closes them without asking the user.
func markWindowsUpdateInteractiveInstances(instances []windowsUpdateProcess) {
	if len(instances) == 0 {
		return
	}
	indexByPID := make(map[uint32]int, len(instances))
	for index, instance := range instances {
		indexByPID[instance.PID] = index
	}
	forEachWindowsTopLevelWindow(func(hwnd uintptr, pid uint32) {
		index, ok := indexByPID[pid]
		if ok && !instances[index].Interactive && isWindowsApplicationWindow(hwnd) {
			instances[index].Interactive = true
		}
	})
}

// isWindowsApplicationWindow tells an application window apart from the
// hidden helper windows (IME, GDI+ hook) that every process loading user32
// owns, headless ones included.
func isWindowsApplicationWindow(hwnd uintptr) bool {
	if visible, _, _ := windowsIsWindowVisible.Call(hwnd); visible != 0 {
		return true
	}
	buffer := make([]uint16, 64)
	length, _, _ := windowsGetClassName.Call(hwnd, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
	return length > 0 && windows.UTF16ToString(buffer[:length]) == windowsMainWindowClass
}
