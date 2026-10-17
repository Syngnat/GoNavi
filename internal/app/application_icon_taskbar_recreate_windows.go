//go:build windows

package app

import (
	"unsafe"

	"GoNavi-Wails/internal/logger"

	"golang.org/x/sys/windows"
)

const (
	windowsShowWindowHide = 0
	windowsShowWindowShow = 5
)

var (
	windowsTaskbarRecreationUser32        = windows.NewLazySystemDLL("user32.dll")
	windowsTaskbarRecreationShowWindow    = windowsTaskbarRecreationUser32.NewProc("ShowWindow")
	windowsTaskbarRecreationGetPlacement  = windowsTaskbarRecreationUser32.NewProc("GetWindowPlacement")
	windowsTaskbarRecreationSetPlacement  = windowsTaskbarRecreationUser32.NewProc("SetWindowPlacement")
	windowsTaskbarRecreationGetForeground = windowsTaskbarRecreationUser32.NewProc("GetForegroundWindow")
	windowsTaskbarRecreationSetForeground = windowsTaskbarRecreationUser32.NewProc("SetForegroundWindow")
)

type windowsWindowPoint struct {
	X int32
	Y int32
}

type windowsWindowPlacement struct {
	Length           uint32
	Flags            uint32
	ShowCmd          uint32
	PtMinPosition    windowsWindowPoint
	PtMaxPosition    windowsWindowPoint
	RcNormalPosition windows.Rect
}

// recreateWindowsTaskbarButtonForPinRefresh forces Explorer to destroy and
// rebuild the taskbar button merged with a pinned shortcut by hiding the main
// window and restoring it in its original state. The pinned button's icon
// snapshot is not re-sampled by per-item notifications, window property
// commits, DeleteTab/AddTab, WM_SETICON or even the global association flush
// (the desktop redraws, the pinned button keeps the old icon — observed on
// Windows 11 26200); the one path that re-resolves the pinned shortcut is
// button creation, which is exactly what startup relies on. The window and
// its taskbar button blink once; this runs only on a live brand switch while
// a GoNavi pin exists. Best effort: on any failure the window state is left
// untouched and the caller continues.
func recreateWindowsTaskbarButtonForPinRefresh(hwnd uintptr) bool {
	if hwnd == 0 {
		logger.Warnf("固定项按钮重建跳过：窗口句柄为零")
		return false
	}
	wasForeground, _, _ := windowsTaskbarRecreationGetForeground.Call()
	placement := windowsWindowPlacement{Length: uint32(unsafe.Sizeof(windowsWindowPlacement{}))}
	// 读不到窗口状态就放弃：盲目隐藏再 SW_SHOW 可能把最大化的窗口还原成
	// 普通状态，宁可不闪也不改变用户当前的窗口状态。失败必须留痕：这是
	// 固定项图标在本次切换里唯一的刷新路径，静默放弃会让用户看到「改了
	// 图标任务栏没变」且无任何诊断线索。
	if success, _, _ := windowsTaskbarRecreationGetPlacement.Call(hwnd, uintptr(unsafe.Pointer(&placement))); success == 0 {
		logger.Warnf("固定项按钮重建放弃：读取窗口状态失败（本次切换的固定项图标可能保持旧图）")
		return false
	}
	windowsTaskbarRecreationShowWindow.Call(hwnd, windowsShowWindowHide)
	// ShowCmd 保持隐藏前读到的原值（1=正常/2=最小化/3=最大化），
	// SetWindowPlacement 按原状态恢复且不需要激活。
	if success, _, _ := windowsTaskbarRecreationSetPlacement.Call(hwnd, uintptr(unsafe.Pointer(&placement))); success == 0 {
		logger.Warnf("固定项按钮重建恢复窗口失败（SetWindowPlacement），已按普通显示恢复")
		windowsTaskbarRecreationShowWindow.Call(hwnd, windowsShowWindowShow)
	}
	if wasForeground == hwnd {
		windowsTaskbarRecreationSetForeground.Call(hwnd)
	}
	return true
}
