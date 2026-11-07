//go:build !wails3

package main

import (
	"sync/atomic"
	"testing"
	"time"
)

func TestShouldShowStartupWindow(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		iconReady     bool
		frontendReady bool
		timedOut      bool
		showBound     bool
		want          bool
	}{
		{name: "frontend without icon stays hidden", frontendReady: true, showBound: true},
		{name: "icon without paint stays hidden", iconReady: true, showBound: true},
		{name: "unbound show stays hidden", iconReady: true, frontendReady: true},
		{name: "icon and frontend present", iconReady: true, frontendReady: true, showBound: true, want: true},
		{name: "timeout presents after icon", iconReady: true, timedOut: true, showBound: true, want: true},
		{name: "timeout without icon stays hidden", timedOut: true, showBound: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := shouldShowStartupWindow(tt.iconReady, tt.frontendReady, tt.timedOut, tt.showBound)
			if got != tt.want {
				t.Fatalf("shouldShow = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestStartupWindowGateWaitsForFrontendPaint(t *testing.T) {
	t.Parallel()

	var shown atomic.Int32
	gate := newStartupWindowGate()
	gate.markFrontendReady()
	gate.bindShow(func() { shown.Add(1) })
	if got := shown.Load(); got != 0 {
		t.Fatalf("presented before icon ready: %d", got)
	}
	gate.markIconReady()
	if got := shown.Load(); got != 1 {
		t.Fatalf("first presentation = %d, want 1", got)
	}
	gate.markFrontendReady()
	gate.markTimedOut()
	if got := shown.Load(); got != 1 {
		t.Fatalf("repeat presentation = %d, want 1", got)
	}
}

func TestStartupWindowGateTimeoutPresentsAfterIcon(t *testing.T) {
	t.Parallel()

	var shown atomic.Int32
	gate := newStartupWindowGate()
	gate.bindShow(func() { shown.Add(1) })
	gate.markIconReady()
	if got := shown.Load(); got != 0 {
		t.Fatalf("presented before timeout: %d", got)
	}
	gate.markTimedOut()
	if got := shown.Load(); got != 1 {
		t.Fatalf("timeout presentation = %d, want 1", got)
	}
}

func TestStartupWindowGateFallbackTimer(t *testing.T) {
	t.Parallel()

	var shown atomic.Int32
	gate := newStartupWindowGate()
	gate.bindShow(func() { shown.Add(1) })
	gate.markIconReady()
	done := make(chan struct{})
	gate.startFallback(time.Millisecond, func() {
		gate.markTimedOut()
		close(done)
	})
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("fallback timer did not fire")
	}
	if got := shown.Load(); got != 1 {
		t.Fatalf("fallback presentation = %d, want 1", got)
	}
}
