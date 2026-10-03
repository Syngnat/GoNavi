//go:build windows

package app

import (
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	windowsTaskbarListClassID = windows.GUID{
		Data1: 0x56fdf344,
		Data2: 0xfd6d,
		Data3: 0x11d0,
		Data4: [8]byte{0x95, 0x8a, 0x00, 0x60, 0x97, 0xc9, 0xa0, 0x90},
	}
	windowsTaskbarListInterfaceID = windows.GUID{
		Data1: 0x56fdf342,
		Data2: 0xfd6d,
		Data3: 0x11d0,
		Data4: [8]byte{0x95, 0x8a, 0x00, 0x60, 0x97, 0xc9, 0xa0, 0x90},
	}
	windowsTaskbarOle32            = windows.NewLazySystemDLL("ole32.dll")
	windowsTaskbarCoCreateInstance = windowsTaskbarOle32.NewProc("CoCreateInstance")
)

type windowsTaskbarList struct {
	vtable *windowsTaskbarListVTable
}

type windowsTaskbarListVTable struct {
	queryInterface uintptr
	addRef         uintptr
	release        uintptr
	hrInit         uintptr
	addTab         uintptr
	deleteTab      uintptr
	setActiveAlt   uintptr
}

// refreshWindowsTaskbarButton makes Explorer discard the current taskbar
// button and register the window again, forcing it to load the new icon.
func refreshWindowsTaskbarButton(hwnd uintptr) error {
	if hwnd == 0 {
		return fmt.Errorf("refresh Windows taskbar button: window handle is zero")
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	shouldUninitialize, err := initializeWindowsCOMForTaskbar()
	if err != nil {
		return fmt.Errorf("initialise COM for Windows taskbar refresh: %w", err)
	}
	if shouldUninitialize {
		defer windows.CoUninitialize()
	}

	taskbar, err := createWindowsTaskbarList()
	if err != nil {
		return err
	}
	defer syscall.SyscallN(taskbar.vtable.release, uintptr(unsafe.Pointer(taskbar)))

	if err := callWindowsTaskbarMethod("initialise", taskbar.vtable.hrInit, taskbar); err != nil {
		return err
	}
	if err := callWindowsTaskbarWindowMethod("remove", taskbar.vtable.deleteTab, taskbar, hwnd); err != nil {
		return err
	}
	if err := callWindowsTaskbarWindowMethod("register", taskbar.vtable.addTab, taskbar, hwnd); err != nil {
		// Delete 已成功而 Add 失败会让窗口失去任务栏按钮。Explorer 可能在重建
		// 托盘（比如刚恢复会话），重新 HrInit 后再尝试一次注册。
		if initErr := callWindowsTaskbarMethod("initialise", taskbar.vtable.hrInit, taskbar); initErr != nil {
			return initErr
		}
		if retryErr := callWindowsTaskbarWindowMethod("register", taskbar.vtable.addTab, taskbar, hwnd); retryErr != nil {
			return retryErr
		}
	}
	return nil
}

func createWindowsTaskbarList() (*windowsTaskbarList, error) {
	var taskbar *windowsTaskbarList
	result, _, _ := windowsTaskbarCoCreateInstance.Call(
		uintptr(unsafe.Pointer(&windowsTaskbarListClassID)),
		0,
		windows.CLSCTX_INPROC_SERVER,
		uintptr(unsafe.Pointer(&windowsTaskbarListInterfaceID)),
		uintptr(unsafe.Pointer(&taskbar)),
	)
	if windowsHRESULTFailed(result) || taskbar == nil || taskbar.vtable == nil {
		return nil, fmt.Errorf("create Windows taskbar list: HRESULT %#x", uint32(result))
	}
	return taskbar, nil
}

func callWindowsTaskbarMethod(action string, method uintptr, taskbar *windowsTaskbarList) error {
	result, _, _ := syscall.SyscallN(method, uintptr(unsafe.Pointer(taskbar)))
	if windowsHRESULTFailed(result) {
		return fmt.Errorf("%s Windows taskbar list: HRESULT %#x", action, uint32(result))
	}
	return nil
}

func callWindowsTaskbarWindowMethod(action string, method uintptr, taskbar *windowsTaskbarList, hwnd uintptr) error {
	result, _, _ := syscall.SyscallN(method, uintptr(unsafe.Pointer(taskbar)), hwnd)
	if windowsHRESULTFailed(result) {
		return fmt.Errorf("%s Windows taskbar button: HRESULT %#x", action, uint32(result))
	}
	return nil
}
