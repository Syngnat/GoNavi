//go:build windows

package main

import (
	"runtime"
	"syscall"
	"unsafe"
)

const wmClose = 0x0010

var (
	user32              = syscall.NewLazyDLL("user32.dll")
	kernel32            = syscall.NewLazyDLL("kernel32.dll")
	procRegisterClassEx = user32.NewProc("RegisterClassExW")
	procCreateWindowEx  = user32.NewProc("CreateWindowExW")
	procDefWindowProc   = user32.NewProc("DefWindowProcW")
	procGetMessage      = user32.NewProc("GetMessageW")
	procDispatchMessage = user32.NewProc("DispatchMessageW")
	procGetModuleHandle = kernel32.NewProc("GetModuleHandleW")
)

type windowClassEx struct {
	size       uint32
	style      uint32
	wndProc    uintptr
	clsExtra   int32
	wndExtra   int32
	instance   uintptr
	icon       uintptr
	cursor     uintptr
	background uintptr
	menuName   *uint16
	className  *uint16
	iconSmall  uintptr
}

type windowMessage struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	x, y    int32
}

// runStubbornWindow 创建一个与 GoNavi 主窗口同类名的隐藏顶层窗口并吞掉 WM_CLOSE（窗口不显示，
// 测试时不会在桌面上闪现）。窗口与消息循环必须在同一个系统线程上。
func runStubbornWindow() {
	runtime.LockOSThread()
	className, _ := syscall.UTF16PtrFromString("wailsWindow")
	instance, _, _ := procGetModuleHandle.Call(0)
	class := windowClassEx{
		wndProc: syscall.NewCallback(func(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
			if message == wmClose {
				return 0
			}
			result, _, _ := procDefWindowProc.Call(hwnd, uintptr(message), wParam, lParam)
			return result
		}),
		instance:  instance,
		className: className,
	}
	class.size = uint32(unsafe.Sizeof(class))
	procRegisterClassEx.Call(uintptr(unsafe.Pointer(&class)))
	procCreateWindowEx.Call(0, uintptr(unsafe.Pointer(className)), uintptr(unsafe.Pointer(className)), 0,
		0, 0, 0, 0, 0, 0, instance, 0)
	var message windowMessage
	for {
		result, _, _ := procGetMessage.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(result) <= 0 {
			return
		}
		procDispatchMessage.Call(uintptr(unsafe.Pointer(&message)))
	}
}
