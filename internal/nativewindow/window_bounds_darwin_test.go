//go:build darwin && cgo && !wails3

package nativewindow

import (
	"testing"
	"time"
)

func TestActiveDetachedDisplayBoundsReturnsWithoutAppKitRunLoop(t *testing.T) {
	done := make(chan struct{})
	go func() {
		_ = activeDetachedDisplayBounds()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("screen bounds query blocked without an AppKit run loop")
	}
}
