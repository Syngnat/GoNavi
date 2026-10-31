package app

import (
	"context"
	"reflect"
	"testing"
)

func TestMarketSourceWebHandlersKeepRequestContext(t *testing.T) {
	handlers := withPluginContextHandlers(&App{}, map[string]any{})
	contextType := reflect.TypeOf((*context.Context)(nil)).Elem()
	for _, name := range marketSourceContextMethodNames {
		handler, ok := handlers[name]
		if !ok {
			t.Fatalf("missing context handler: %s", name)
		}
		typ := reflect.TypeOf(handler)
		if typ.NumIn() == 0 || typ.In(0) != contextType {
			t.Fatalf("request context missing: %s", name)
		}
	}
}
