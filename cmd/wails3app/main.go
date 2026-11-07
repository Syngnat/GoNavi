//go:build wails3

// Command wails3app is the Wails v3 migration spike. It is built only with the
// wails3 tag so the shipping v2 desktop build and CI keep their current
// dependency graph until the migration lands.
package main

import (
	"log"
	"os"

	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/desktop"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func main() {
	backend := appcore.NewApp()

	wailsApp := application.New(application.Options{
		Name:        "GoNavi",
		Description: "Database client",
		Services: []application.Service{
			application.NewService(backend),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(os.DirFS("frontend/dist")),
		},
		OnShutdown: func() {
			backend.Shutdown()
		},
	})

	window := wailsApp.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:     "GoNavi",
		Width:     1440,
		Height:    900,
		MinWidth:  900,
		MinHeight: 600,
		URL:       "/",
	})
	desktop.Bind(wailsApp, window)
	window.Show()

	if err := wailsApp.Run(); err != nil {
		log.Fatal(err)
	}
}
