//go:build windows

package app

import (
	"context"
	"fmt"
	"reflect"
	"time"
	"unsafe"
)

const resetWebViewZoomInvokeTimeout = 2 * time.Second

// resetWebViewZoomFactor 通过 WebView2 ICoreWebView2Controller::put_ZoomFactor 把 WebView2
// 内部 zoom factor 重置为 1.0。这是 Windows 任务栏恢复后字体度量异常变大的根因解：
// 字体度量缓存在 WebView2 D2D/DirectWrite 层，Chromium layout invalidation（CSS zoom hack）
// 改不了它，必须调 WebView2 COM API。
//
// 实现路径：
//  1. Wails 在 ctx 里以 key "frontend" 注入了 *desktop/windows.Frontend
//  2. Frontend.chromium 是 unexported 字段 *edge.Chromium
//  3. Frontend.mainWindow 是 unexported 字段 *windows.Window，可用 Invoke 切回窗口线程
//  4. Chromium.PutZoomFactor(float64) 是 exported 方法（封装了 controller.put_ZoomFactor）
//
// 用反射 + unsafe.Pointer 解锁 unexported 字段后，通过 mainWindow.Invoke 调 PutZoomFactor。
// 不需要 import wails 内部包，也不需要 fork wails。
//
// 失败时返回错误（不 panic），让调用方决定是否回退到 toggle 路径。
//
// **依赖 wails v2.11/v2.12 内部实现细节**：如果 wails 升级改名了 frontend.chromium 字段或
// edge.Chromium.PutZoomFactor 方法名，此函数会返回 error。CI 中应该有跨版本兼容性测试。
func resetWebViewZoomFactor(ctx context.Context, factor float64) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("reset WebView2 zoom panic: %v", recovered)
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

	putZoomFactor := chromiumValue.MethodByName("PutZoomFactor")
	if !putZoomFactor.IsValid() {
		return fmt.Errorf("PutZoomFactor method not found on chromium (go-webview2 version may have changed)")
	}
	if putZoomFactor.Type().NumIn() != 1 || putZoomFactor.Type().In(0).Kind() != reflect.Float64 || putZoomFactor.Type().NumOut() != 0 {
		return fmt.Errorf("PutZoomFactor signature changed: expected func(float64), got %v", putZoomFactor.Type())
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
		done <- safeCallPutZoomFactor(putZoomFactor, factor)
	}); err != nil {
		return err
	}

	select {
	case err := <-done:
		return err
	case <-time.After(resetWebViewZoomInvokeTimeout):
		return fmt.Errorf("timed out waiting for mainWindow.Invoke to reset WebView2 zoom factor")
	}
}

func resolveWailsFrontendValue(ctx context.Context) (reflect.Value, error) {
	frontendIface := ctx.Value("frontend")
	if frontendIface == nil {
		return reflect.Value{}, fmt.Errorf("wails frontend not found in ctx (key=\"frontend\")")
	}

	frontendValue := reflect.ValueOf(frontendIface)
	if frontendValue.Kind() == reflect.Ptr {
		if frontendValue.IsNil() {
			return reflect.Value{}, fmt.Errorf("wails frontend is nil")
		}
		frontendValue = frontendValue.Elem()
	}
	if !frontendValue.IsValid() || frontendValue.Kind() != reflect.Struct {
		return reflect.Value{}, fmt.Errorf("wails frontend has unexpected kind %v", frontendValue.Kind())
	}
	if !frontendValue.CanAddr() {
		return reflect.Value{}, fmt.Errorf("wails frontend is not addressable")
	}
	return frontendValue, nil
}

func accessibleWailsFrontendField(frontendValue reflect.Value, fieldName string) (reflect.Value, error) {
	field := frontendValue.FieldByName(fieldName)
	if !field.IsValid() {
		return reflect.Value{}, fmt.Errorf("wails Frontend.%s field not found (wails version may have changed)", fieldName)
	}
	if !field.CanAddr() {
		return reflect.Value{}, fmt.Errorf("wails Frontend.%s field is not addressable", fieldName)
	}
	if isNilReflectValue(field) {
		return reflect.Value{}, fmt.Errorf("wails Frontend.%s is nil (WebView2 not yet initialised)", fieldName)
	}

	return reflect.NewAt(field.Type(), unsafe.Pointer(field.UnsafeAddr())).Elem(), nil
}

func isNilReflectValue(value reflect.Value) bool {
	switch value.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Ptr, reflect.Slice:
		return value.IsNil()
	default:
		return false
	}
}

func safeCallInvoke(invoke reflect.Value, fn func()) (err error) {
	defer func() {
		if value := recover(); value != nil {
			err = fmt.Errorf("mainWindow.Invoke panicked: %v", value)
		}
	}()
	invoke.Call([]reflect.Value{reflect.ValueOf(fn)})
	return nil
}

func safeCallPutZoomFactor(putZoomFactor reflect.Value, factor float64) (err error) {
	defer func() {
		if value := recover(); value != nil {
			err = fmt.Errorf("PutZoomFactor panicked while resetting WebView2 zoom factor: %v", value)
		}
	}()
	putZoomFactor.Call([]reflect.Value{reflect.ValueOf(factor)})
	return nil
}
