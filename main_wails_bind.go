//go:build !wails3

package main

import (
	aiservice "GoNavi-Wails/internal/ai/service"
	"GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/nativewindow"
	"GoNavi-Wails/internal/secretstore"
)

func newBindingsSecretStore() secretstore.SecretStore {
	return secretstore.NewUnavailableStore("wails bindings generation")
}

func collectWailsBindings(
	application *app.App,
	aiService *aiservice.Service,
	nativeWindowManager *nativewindow.Manager,
) []interface{} {
	bindings := []interface{}{application, aiService}
	if nativeWindowManager != nil {
		bindings = append(bindings, nativeWindowManager)
	}
	return bindings
}
