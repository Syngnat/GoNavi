//go:build bindings && !wails3

package main

import (
	"fmt"
	"os"

	aiservice "GoNavi-Wails/internal/ai/service"
	"GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/nativewindow"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

func main() {
	if err := runWailsBindingsGeneration(); err != nil {
		fmt.Fprintf(os.Stderr, "wails bindings: %v\n", err)
		os.Exit(1)
	}
}

func runWailsBindingsGeneration() error {
	store := newBindingsSecretStore()
	application := app.NewAppWithSecretStore(store)
	aiService := aiservice.NewServiceWithSecretStore(store)
	nativeWindowManager, err := nativewindow.NewManager(assets, application, aiService)
	if err != nil {
		return err
	}
	return wails.Run(&options.App{
		Title: "GoNavi",
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		Bind: collectWailsBindings(application, aiService, nativeWindowManager),
	})
}
