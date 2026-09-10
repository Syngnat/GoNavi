//go:build windows

package app

import (
	"context"
	"sync/atomic"
	"testing"
)

type fakeFocusEventManager struct {
	handler func()
}

type fakeFocusWindow struct {
	invoked atomic.Int32
	focus   *fakeFocusEventManager
}

func (f *fakeFocusWindow) Invoke(operation func()) {
	f.invoked.Add(1)
	operation()
}

func (f *fakeFocusWindow) OnSetFocus() *fakeFocusEventManager {
	return f.focus
}

type fakeFocusFrontend struct {
	chromium   *fakeChromium
	mainWindow *fakeFocusWindow
}

func TestSuspendWailsWebViewFocusRestoresOriginalHandler(t *testing.T) {
	var focused atomic.Int32
	manager := &fakeFocusEventManager{handler: func() { focused.Add(1) }}
	window := &fakeFocusWindow{focus: manager}
	ctx := context.WithValue(context.Background(), stringContextKey("frontend"), &fakeFocusFrontend{
		chromium:   &fakeChromium{},
		mainWindow: window,
	})

	restore, err := suspendWailsWebViewFocus(ctx)
	if err != nil {
		t.Fatalf("suspend focus handler: %v", err)
	}
	if manager.handler != nil {
		t.Fatal("focus handler remained active while native dialog guard was installed")
	}
	if err := restore(); err != nil {
		t.Fatalf("restore focus handler: %v", err)
	}
	if manager.handler == nil {
		t.Fatal("focus handler was not restored")
	}
	manager.handler()
	if got := focused.Load(); got != 1 {
		t.Fatalf("restored focus handler call count = %d, want 1", got)
	}
	if err := restore(); err != nil {
		t.Fatalf("second restore should be idempotent: %v", err)
	}
	if got := window.invoked.Load(); got != 2 {
		t.Fatalf("window invoke count = %d, want suspend + one restore", got)
	}
}
