package main

import (
	"embed"

	"GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/logger"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	// Create an instance of the app structure
	application := app.NewApp()

	// Create application with options
	err := wails.Run(&options.App{
		Title:  "GoNavi",
		Width:  1024,
		Height: 768,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 27, G: 38, B: 54, A: 1},
		OnStartup:        application.Startup,
		OnShutdown:       application.Shutdown,
		Bind: []interface{}{
			application,
		},
	})

	if err != nil {
		logger.Error(err, "应用启动失败")
	}
}
