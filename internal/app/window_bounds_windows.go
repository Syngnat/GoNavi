//go:build windows

package app

import (
	"context"
	"fmt"
	"reflect"
	"time"
)

const refreshWebViewBoundsInvokeTimeout = 2 * time.Second

// refreshWebViewBounds forces WebView2's controller bounds to match the current
// native client rect. Wails normally does this from WM_SIZE, but a late startup
// maximise can expose WS_MAXIMIZE before that resize reaches the WebView surface.
func refreshWebViewBounds(ctx context.Context) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("refresh WebView2 bounds panic: %v", recovered)
		}
	}()
	if ctx == nil {
		return fmt.Errorf("ctx is nil")
	}

	frontendValue, err := resolveWailsFrontendValue(ctx)
	if err != nil {
		return err
	}
	chromiumValue, err := accessibleWailsFrontendField(frontendValue, "chromium")
	if err != nil {
		return err
	}
	mainWindowValue, err := accessibleWailsFrontendField(frontendValue, "mainWindow")
	if err != nil {
		return err
	}

	resize := chromiumValue.MethodByName("Resize")
	if !resize.IsValid() {
		return fmt.Errorf("Resize method not found on chromium (go-webview2 version may have changed)")
	}
	if resize.Type().NumIn() != 0 || resize.Type().NumOut() != 0 {
		return fmt.Errorf("Resize signature changed: expected func(), got %v", resize.Type())
	}

	invoke := mainWindowValue.MethodByName("Invoke")
	if !invoke.IsValid() {
		return fmt.Errorf("mainWindow.Invoke method not found (wails version may have changed)")
	}
	if invoke.Type().NumIn() != 1 || invoke.Type().In(0).Kind() != reflect.Func || invoke.Type().In(0).NumIn() != 0 || invoke.Type().In(0).NumOut() != 0 || invoke.Type().NumOut() != 0 {
		return fmt.Errorf("mainWindow.Invoke signature changed: expected func(func()), got %v", invoke.Type())
	}

	done := make(chan error, 1)
	if err := safeCallInvoke(invoke, func() {
		done <- safeCallResizeWebView(resize)
	}); err != nil {
		return err
	}

	select {
	case err := <-done:
		return err
	case <-time.After(refreshWebViewBoundsInvokeTimeout):
		return fmt.Errorf("timed out waiting for mainWindow.Invoke to refresh WebView2 bounds")
	}
}

func safeCallResizeWebView(resize reflect.Value) (err error) {
	defer func() {
		if value := recover(); value != nil {
			err = fmt.Errorf("Resize panicked while refreshing WebView2 bounds: %v", value)
		}
	}()
	resize.Call(nil)
	return nil
}
