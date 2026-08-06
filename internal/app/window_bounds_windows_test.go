//go:build windows

package app

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
)

type fakeBoundsChromium struct {
	resized atomic.Int32
}

func (f *fakeBoundsChromium) Resize() {
	f.resized.Add(1)
}

type fakeBoundsFrontend struct {
	chromium   *fakeBoundsChromium
	mainWindow *fakeWindow
}

type panicBoundsChromium struct{}

func (*panicBoundsChromium) Resize() {
	panic("WebView2 bounds refresh failed")
}

type panicBoundsFrontend struct {
	chromium   *panicBoundsChromium
	mainWindow *fakeWindow
}

type missingResizeFrontend struct {
	chromium   *fakeChromium
	mainWindow *fakeWindow
}

func TestRefreshWebViewBoundsCallsChromiumResizeOnWindowThread(t *testing.T) {
	chromium := &fakeBoundsChromium{}
	window := &fakeWindow{}
	ctx := context.WithValue(context.Background(), stringContextKey("frontend"), &fakeBoundsFrontend{
		chromium:   chromium,
		mainWindow: window,
	})

	if err := refreshWebViewBounds(ctx); err != nil {
		t.Fatalf("expected bounds refresh to succeed against fake frontend, got %v", err)
	}
	if got := window.invoked.Load(); got != 1 {
		t.Fatalf("expected refresh to run through mainWindow.Invoke exactly once, got %d", got)
	}
	if got := chromium.resized.Load(); got != 1 {
		t.Fatalf("expected Chromium.Resize called exactly once, got %d", got)
	}
}

func TestRefreshWebViewBoundsErrorsWhenChromiumNil(t *testing.T) {
	ctx := context.WithValue(context.Background(), stringContextKey("frontend"), &fakeBoundsFrontend{
		chromium:   nil,
		mainWindow: &fakeWindow{},
	})

	err := refreshWebViewBounds(ctx)
	if err == nil || !strings.Contains(err.Error(), "chromium") {
		t.Fatalf("expected chromium error, got %v", err)
	}
}

func TestRefreshWebViewBoundsErrorsWhenResizeMethodMissing(t *testing.T) {
	ctx := context.WithValue(context.Background(), stringContextKey("frontend"), &missingResizeFrontend{
		chromium:   &fakeChromium{},
		mainWindow: &fakeWindow{},
	})

	err := refreshWebViewBounds(ctx)
	if err == nil || !strings.Contains(err.Error(), "Resize") {
		t.Fatalf("expected Resize compatibility error, got %v", err)
	}
}

func TestRefreshWebViewBoundsErrorsWhenMainWindowNil(t *testing.T) {
	ctx := context.WithValue(context.Background(), stringContextKey("frontend"), &fakeBoundsFrontend{
		chromium:   &fakeBoundsChromium{},
		mainWindow: nil,
	})

	err := refreshWebViewBounds(ctx)
	if err == nil || !strings.Contains(err.Error(), "mainWindow") {
		t.Fatalf("expected mainWindow error, got %v", err)
	}
}

func TestRefreshWebViewBoundsRecoversFromResizePanic(t *testing.T) {
	ctx := context.WithValue(context.Background(), stringContextKey("frontend"), &panicBoundsFrontend{
		chromium:   &panicBoundsChromium{},
		mainWindow: &fakeWindow{},
	})

	err := refreshWebViewBounds(ctx)
	if err == nil || !strings.Contains(err.Error(), "panic") {
		t.Fatalf("expected resize panic to be converted to error, got %v", err)
	}
}

func TestAppRefreshWebViewBoundsRPCReportsSuccess(t *testing.T) {
	chromium := &fakeBoundsChromium{}
	ctx := context.WithValue(context.Background(), stringContextKey("frontend"), &fakeBoundsFrontend{
		chromium:   chromium,
		mainWindow: &fakeWindow{},
	})

	result := (&App{ctx: ctx}).RefreshWebViewBounds()
	if !result.Success {
		t.Fatalf("expected RPC success, got %q", result.Message)
	}
	if got := chromium.resized.Load(); got != 1 {
		t.Fatalf("expected RPC to refresh bounds exactly once, got %d", got)
	}
}
