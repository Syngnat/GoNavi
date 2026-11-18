//go:build windows

package app

import (
	"context"
	"fmt"
	"reflect"
	"unsafe"
)

func resolveWailsFrontendValue(ctx context.Context) (reflect.Value, error) {
	frontendIface := ctx.Value("frontend")
	if frontendIface == nil {
		return reflect.Value{}, fmt.Errorf("wails frontend not found in ctx (key=\"frontend\")")
	}

	frontendValue := reflect.ValueOf(frontendIface)
	for depth := 0; depth < 8; depth++ {
		for frontendValue.IsValid() && (frontendValue.Kind() == reflect.Interface || frontendValue.Kind() == reflect.Ptr) {
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

		// In a production build, ctx["frontend"] is the platform Frontend
		// itself. In `wails dev`, it is DevWebServer, which anonymously embeds
		// frontend.Frontend and delegates to the same platform value. Unwrap the
		// exported interface before looking for Windows-only private fields.
		if frontendValue.FieldByName("chromium").IsValid() && frontendValue.FieldByName("mainWindow").IsValid() {
			return frontendValue, nil
		}
		embeddedFrontend := frontendValue.FieldByName("Frontend")
		if !embeddedFrontend.IsValid() {
			return frontendValue, nil
		}
		frontendValue = embeddedFrontend
	}
	return reflect.Value{}, fmt.Errorf("wails frontend wrapper nesting exceeds supported depth")
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
