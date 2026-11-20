//go:build windows

package scriptengine

import (
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const workerMemoryPollInterval = time.Second

type processMemoryCounters struct {
	Size                       uint32
	PageFaultCount             uint32
	PeakWorkingSetSize         uintptr
	WorkingSetSize             uintptr
	QuotaPeakPagedPoolUsage    uintptr
	QuotaPagedPoolUsage        uintptr
	QuotaPeakNonPagedPoolUsage uintptr
	QuotaNonPagedPoolUsage     uintptr
	PagefileUsage              uintptr
	PeakPagefileUsage          uintptr
}

var (
	psapiDLL             = windows.NewLazySystemDLL("psapi.dll")
	getProcessMemoryInfo = psapiDLL.NewProc("GetProcessMemoryInfo")
)

func startWorkerMemoryWatch(pid int, limitBytes int64, onExceeded func()) func() {
	if pid <= 0 || limitBytes <= 0 || onExceeded == nil {
		return func() {}
	}
	stop := make(chan struct{})
	done := make(chan struct{})
	var once sync.Once
	go func() {
		defer close(done)
		ticker := time.NewTicker(workerMemoryPollInterval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				rss, err := workerRSSBytes(pid)
				if err != nil {
					continue
				}
				if rss > uint64(limitBytes) {
					onExceeded()
					return
				}
			}
		}
	}()
	return func() {
		once.Do(func() { close(stop) })
		<-done
	}
}

func workerRSSBytes(pid int) (uint64, error) {
	process, err := windows.OpenProcess(
		windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_VM_READ,
		false,
		uint32(pid),
	)
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(process)
	counters := processMemoryCounters{Size: uint32(unsafe.Sizeof(processMemoryCounters{}))}
	ok, _, callErr := getProcessMemoryInfo.Call(
		uintptr(process),
		uintptr(unsafe.Pointer(&counters)),
		uintptr(counters.Size),
	)
	if ok == 0 {
		return 0, callErr
	}
	return uint64(counters.WorkingSetSize), nil
}
