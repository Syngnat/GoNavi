//go:build !windows

package scriptengine

import (
	"os"
	"testing"
	"time"
)

func TestWorkerMemoryWatchStopsProcessAtLimit(t *testing.T) {
	exceeded := make(chan struct{})
	stop := startWorkerMemoryWatch(os.Getpid(), 1, func() {
		close(exceeded)
	})
	defer stop()
	select {
	case <-exceeded:
	case <-time.After(3 * time.Second):
		t.Fatal("memory watch did not report an over-limit process")
	}
}

func TestWorkerMemoryWatchStopWaitsAndIsIdempotent(t *testing.T) {
	stop := startWorkerMemoryWatch(os.Getpid(), 1<<40, func() {
		t.Fatal("memory callback should not fire")
	})
	done := make(chan struct{})
	go func() {
		stop()
		stop()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("memory watch stop did not join the watcher")
	}
}
