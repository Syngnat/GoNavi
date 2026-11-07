//go:build windows && !wails3

package app

import (
	"context"
	"sync"
	"sync/atomic"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const mainWindowSetPositionIsLocal = true
const mainWindowPositionIsGlobal = true

type windowsDisplayRect struct {
	Left, Top, Right, Bottom int32
}

type windowsDisplayMonitorInfo struct {
	Size    uint32
	Monitor windowsDisplayRect
	Work    windowsDisplayRect
	Flags   uint32
}

type windowsDisplayEnumeration struct {
	current    uintptr
	currentDPI int
	areas      []mainWindowDisplayArea
}

var (
	windowsDisplayEnumProc            = windowsApplicationIconUser32.NewProc("EnumDisplayMonitors")
	windowsDisplayGetInfoProc         = windowsApplicationIconUser32.NewProc("GetMonitorInfoW")
	windowsDisplayFromWindowProc      = windowsApplicationIconUser32.NewProc("MonitorFromWindow")
	windowsDisplayGetDPIForWindowProc = windowsApplicationIconUser32.NewProc("GetDpiForWindow")
	windowsDisplayDPIProc             = windows.NewLazySystemDLL("shcore.dll").NewProc("GetDpiForMonitor")
	windowsDisplayEnumCallback        = syscall.NewCallback(appendWindowsDisplayArea)
	windowsDisplayStates              sync.Map
	windowsDisplaySequence            atomic.Uint64
)

func appendWindowsDisplayArea(monitor, _, _, data uintptr) uintptr {
	value, ok := windowsDisplayStates.Load(data)
	if !ok {
		return 0
	}
	state := value.(*windowsDisplayEnumeration)
	info := windowsDisplayMonitorInfo{Size: uint32(unsafe.Sizeof(windowsDisplayMonitorInfo{}))}
	success, _, _ := windowsDisplayGetInfoProc.Call(monitor, uintptr(unsafe.Pointer(&info)))
	if success == 0 {
		return 1
	}
	dpi := currentWindowsSystemDPI()
	if windowsDisplayDPIProc.Find() == nil {
		var dpiX, dpiY uint32
		status, _, _ := windowsDisplayDPIProc.Call(monitor, 0, uintptr(unsafe.Pointer(&dpiX)), uintptr(unsafe.Pointer(&dpiY)))
		if status == 0 && dpiX > 0 {
			dpi = int(dpiX)
		}
	}
	if monitor == state.current && state.currentDPI > 0 {
		dpi = state.currentDPI
	}
	work := info.Work
	state.areas = append(state.areas, mainWindowDisplayArea{
		X: int(work.Left), Y: int(work.Top),
		Width: int(work.Right - work.Left), Height: int(work.Bottom - work.Top), DPI: dpi,
		Primary: info.Flags&1 != 0, Current: monitor == state.current,
	})
	return 1
}

func mainWindowDisplayAreas(ctx context.Context) []mainWindowDisplayArea {
	var current uintptr
	var currentDPI int
	if ctx != nil {
		if hwnd, err := resolveWailsMainWindowHandle(ctx); err == nil {
			current, _, _ = windowsDisplayFromWindowProc.Call(hwnd, 2) // MONITOR_DEFAULTTONEAREST
			if windowsDisplayGetDPIForWindowProc.Find() == nil {
				if dpi, _, _ := windowsDisplayGetDPIForWindowProc.Call(hwnd); dpi > 0 {
					currentDPI = int(dpi)
				}
			}
		}
	}
	state := &windowsDisplayEnumeration{
		current: current, currentDPI: currentDPI, areas: make([]mainWindowDisplayArea, 0, 2),
	}
	// Keep the callback stable and pass a per-call ID, not a Go pointer, through Win32.
	id := uintptr(windowsDisplaySequence.Add(1))
	windowsDisplayStates.Store(id, state)
	defer windowsDisplayStates.Delete(id)
	windowsDisplayEnumProc.Call(0, 0, windowsDisplayEnumCallback, id)
	if current == 0 {
		for index := range state.areas {
			if state.areas[index].Primary {
				state.areas[index].Current = true
				break
			}
		}
	}
	return state.areas
}
