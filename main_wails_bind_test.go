//go:build !wails3

package main

import (
	"testing"

	aiservice "GoNavi-Wails/internal/ai/service"
	"GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/nativewindow"
	"GoNavi-Wails/internal/secretstore"
)

func TestNewBindingsSecretStoreDoesNotOpenKeyring(t *testing.T) {
	store := newBindingsSecretStore()
	if err := store.HealthCheck(); err == nil || !secretstore.IsUnavailable(err) {
		t.Fatalf("HealthCheck() = %v, want unavailable store", err)
	}
}

func TestCollectWailsBindingsKeepsDesktopOrder(t *testing.T) {
	store := newBindingsSecretStore()
	application := app.NewAppWithSecretStore(store)
	aiService := aiservice.NewServiceWithSecretStore(store)

	withoutManager := collectWailsBindings(application, aiService, nil)
	if len(withoutManager) != 2 {
		t.Fatalf("len(bindings) = %d, want 2", len(withoutManager))
	}
	if withoutManager[0] != application || withoutManager[1] != aiService {
		t.Fatalf("bindings = %#v, want App then Service", withoutManager)
	}

	manager := &nativewindow.Manager{}
	withManager := collectWailsBindings(application, aiService, manager)
	if len(withManager) != 3 {
		t.Fatalf("len(bindings) = %d, want 3", len(withManager))
	}
	if withManager[2] != manager {
		t.Fatalf("bindings[2] = %#v, want native window manager", withManager[2])
	}
}
