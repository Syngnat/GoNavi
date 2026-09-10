//go:build windows

package app

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
)

// fakeChromium 模仿 *edge.Chromium 的接口：只需要 exported 的 PutZoomFactor(float64) 方法。
// 用于在不依赖真实 wails / WebView2 的情况下验证反射路径。
type fakeChromium struct {
	called atomic.Int32
	last   atomic.Value // float64
}

func (f *fakeChromium) PutZoomFactor(factor float64) {
	f.called.Add(1)
	f.last.Store(factor)
}

type fakeWindow struct {
	invoked atomic.Int32
}

func (f *fakeWindow) Invoke(fn func()) {
	f.invoked.Add(1)
	fn()
}

// fakeFrontend 模仿 wails 的 internal/frontend/desktop/windows.Frontend：
// unexported 字段 chromium/mainWindow 分别模仿 *edge.Chromium 和 *windows.Window。
// 反射代码不依赖具体类型名，只检查 method signature。
type fakeFrontend struct {
	chromium   *fakeChromium
	mainWindow *fakeWindow
}

type panicChromium struct{}

func (p *panicChromium) PutZoomFactor(float64) {
	panic("webview2 zoom reset failed")
}

type panicFrontend struct {
	chromium   *panicChromium
	mainWindow *fakeWindow
}

// 测试必须用 wails 一致的 string key "frontend" 作为 context.WithValue 的 key，
// 否则反射拿不到。go vet 会警告 string key，用本地 stringContextKey 帮助函数封装来抑制。
// 这层封装等价于直接传字符串字面量，行为完全一致。
func stringContextKey(key string) any {
	type contextKeyAlias = string
	return contextKeyAlias(key)
}

func TestResetWebViewZoomFactorCallsPutZoomFactor(t *testing.T) {
	chromium := &fakeChromium{}
	window := &fakeWindow{}
	ctx := context.WithValue(context.Background(), stringContextKey("frontend"), &fakeFrontend{chromium: chromium, mainWindow: window})

	if err := resetWebViewZoomFactor(ctx, 1.0); err != nil {
		t.Fatalf("expected reset to succeed against fake frontend, got %v", err)
	}
	if got := window.invoked.Load(); got != 1 {
		t.Fatalf("expected reset to run through mainWindow.Invoke exactly once, got %d", got)
	}
	if got := chromium.called.Load(); got != 1 {
		t.Fatalf("expected PutZoomFactor called exactly once, got %d", got)
	}
	if got, _ := chromium.last.Load().(float64); got != 1.0 {
		t.Fatalf("expected factor 1.0, got %v", got)
	}
}

func TestResetWebViewZoomFactorUnwrapsWailsDevServerFrontend(t *testing.T) {
	chromium := &fakeChromium{}
	window := &fakeWindow{}
	ctx := context.WithValue(context.Background(), stringContextKey("frontend"), &fakeDevWebServer{
		Frontend: &fakeFrontend{chromium: chromium, mainWindow: window},
	})

	if err := resetWebViewZoomFactor(ctx, 1.0); err != nil {
		t.Fatalf("expected zoom reset to unwrap the wails dev frontend, got %v", err)
	}
	if got := window.invoked.Load(); got != 1 {
		t.Fatalf("expected wrapped frontend reset to invoke the window once, got %d", got)
	}
	if got := chromium.called.Load(); got != 1 {
		t.Fatalf("expected wrapped frontend PutZoomFactor called once, got %d", got)
	}
}

func TestResetWebViewZoomFactorErrorsWhenChromiumFieldMissing(t *testing.T) {
	type fakeFrontendWithoutChromium struct {
		other string
	}
	ctx := context.WithValue(context.Background(), stringContextKey("frontend"), &fakeFrontendWithoutChromium{})
	err := resetWebViewZoomFactor(ctx, 1.0)
	if err == nil {
		t.Fatal("expected error when chromium field is missing, got nil")
	}
	if !strings.Contains(err.Error(), "chromium") {
		t.Fatalf("expected error to mention chromium, got %v", err)
	}
}

func TestResetWebViewZoomFactorErrorsWhenChromiumNil(t *testing.T) {
	ctx := context.WithValue(context.Background(), stringContextKey("frontend"), &fakeFrontend{chromium: nil, mainWindow: &fakeWindow{}})
	err := resetWebViewZoomFactor(ctx, 1.0)
	if err == nil {
		t.Fatal("expected error when chromium is nil, got nil")
	}
	if !strings.Contains(err.Error(), "nil") {
		t.Fatalf("expected error to mention nil, got %v", err)
	}
}

func TestResetWebViewZoomFactorErrorsWhenMainWindowNil(t *testing.T) {
	ctx := context.WithValue(context.Background(), stringContextKey("frontend"), &fakeFrontend{chromium: &fakeChromium{}, mainWindow: nil})
	err := resetWebViewZoomFactor(ctx, 1.0)
	if err == nil {
		t.Fatal("expected error when mainWindow is nil, got nil")
	}
	if !strings.Contains(err.Error(), "mainWindow") {
		t.Fatalf("expected error to mention mainWindow, got %v", err)
	}
}

func TestResetWebViewZoomFactorErrorsWhenFrontendMissing(t *testing.T) {
	err := resetWebViewZoomFactor(context.Background(), 1.0)
	if err == nil {
		t.Fatal("expected error when frontend not in ctx, got nil")
	}
	if !strings.Contains(err.Error(), "frontend") {
		t.Fatalf("expected error to mention frontend, got %v", err)
	}
}

func TestResetWebViewZoomFactorRecoversFromPutZoomFactorPanic(t *testing.T) {
	ctx := context.WithValue(context.Background(), stringContextKey("frontend"), &panicFrontend{
		chromium:   &panicChromium{},
		mainWindow: &fakeWindow{},
	})

	err := resetWebViewZoomFactor(ctx, 1.0)
	if err == nil {
		t.Fatal("expected panic to be converted to error, got nil")
	}
	if !strings.Contains(err.Error(), "panic") {
		t.Fatalf("expected error to mention panic, got %v", err)
	}
}
