//go:build !windows

package scriptengine

import (
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const workerMemoryPollInterval = time.Second

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
	if runtime.GOOS == "linux" {
		payload, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/statm")
		if err != nil {
			return 0, err
		}
		fields := strings.Fields(string(payload))
		if len(fields) < 2 {
			return 0, os.ErrInvalid
		}
		pages, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			return 0, err
		}
		return pages * uint64(os.Getpagesize()), nil
	}
	output, err := exec.Command("ps", "-o", "rss=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0, err
	}
	kilobytes, err := strconv.ParseUint(strings.TrimSpace(string(output)), 10, 64)
	if err != nil {
		return 0, err
	}
	return kilobytes * 1024, nil
}
