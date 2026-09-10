//go:build windows

package app

import (
	"context"
	"fmt"
	"reflect"
	"sync"
	"time"
	"unsafe"
)

const wailsFocusGuardInvokeTimeout = 2 * time.Second

// suspendWailsWebViewFocus temporarily disables Wails' WM_SETFOCUS handler.
// go-webview2 v1.0.22 treats a transient MoveFocus(E_INVALIDARG) as fatal and
// calls os.Exit(1). Windows may return that error while a native common-file
// dialog gives focus back to the WebView, so keep the handler detached until
// the modal loop has fully returned.
func suspendWailsWebViewFocus(ctx context.Context) (func() error, error) {
	frontendValue, err := resolveWailsFrontendValue(ctx)
	if err != nil {
		return nil, err
	}
	mainWindowValue, err := accessibleWailsFrontendField(frontendValue, "mainWindow")
	if err != nil {
		return nil, err
	}
	invoke, err := resolveWailsWindowInvoke(mainWindowValue)
	if err != nil {
		return nil, err
	}

	var handlerField reflect.Value
	var originalHandler reflect.Value
	if err := invokeWailsWindowAndWait(invoke, func() error {
		handlerField, err = resolveWailsFocusHandlerField(mainWindowValue)
		if err != nil {
			return err
		}
		originalHandler = reflect.New(handlerField.Type()).Elem()
		originalHandler.Set(handlerField)
		handlerField.Set(reflect.Zero(handlerField.Type()))
		return nil
	}); err != nil {
		return nil, err
	}

	var once sync.Once
	var restoreErr error
	return func() error {
		once.Do(func() {
			restoreErr = invokeWailsWindowAndWait(invoke, func() error {
				handlerField.Set(originalHandler)
				return nil
			})
		})
		return restoreErr
	}, nil
}

func resolveWailsWindowInvoke(mainWindowValue reflect.Value) (reflect.Value, error) {
	invoke := mainWindowValue.MethodByName("Invoke")
	if !invoke.IsValid() {
		return reflect.Value{}, fmt.Errorf("mainWindow.Invoke method not found (wails version may have changed)")
	}
	if invoke.Type().NumIn() != 1 || invoke.Type().In(0).Kind() != reflect.Func || invoke.Type().In(0).NumIn() != 0 || invoke.Type().In(0).NumOut() != 0 || invoke.Type().NumOut() != 0 {
		return reflect.Value{}, fmt.Errorf("mainWindow.Invoke signature changed: expected func(func()), got %v", invoke.Type())
	}
	return invoke, nil
}

func resolveWailsFocusHandlerField(mainWindowValue reflect.Value) (reflect.Value, error) {
	onSetFocus := mainWindowValue.MethodByName("OnSetFocus")
	if !onSetFocus.IsValid() || onSetFocus.Type().NumIn() != 0 || onSetFocus.Type().NumOut() != 1 {
		return reflect.Value{}, fmt.Errorf("mainWindow.OnSetFocus signature changed")
	}
	eventManager := onSetFocus.Call(nil)[0]
	for eventManager.IsValid() && (eventManager.Kind() == reflect.Interface || eventManager.Kind() == reflect.Ptr) {
		if eventManager.IsNil() {
			return reflect.Value{}, fmt.Errorf("mainWindow.OnSetFocus returned nil")
		}
		eventManager = eventManager.Elem()
	}
	if !eventManager.IsValid() || eventManager.Kind() != reflect.Struct || !eventManager.CanAddr() {
		return reflect.Value{}, fmt.Errorf("mainWindow.OnSetFocus returned an unsupported event manager")
	}
	handler := eventManager.FieldByName("handler")
	if !handler.IsValid() || handler.Kind() != reflect.Func || !handler.CanAddr() {
		return reflect.Value{}, fmt.Errorf("Wails focus event handler field not found")
	}
	return reflect.NewAt(handler.Type(), unsafe.Pointer(handler.UnsafeAddr())).Elem(), nil
}

func invokeWailsWindowAndWait(invoke reflect.Value, operation func() error) error {
	done := make(chan error, 1)
	if err := safeCallInvoke(invoke, func() {
		done <- operation()
	}); err != nil {
		return err
	}
	select {
	case err := <-done:
		return err
	case <-time.After(wailsFocusGuardInvokeTimeout):
		return fmt.Errorf("timed out waiting for Wails window focus guard")
	}
}
