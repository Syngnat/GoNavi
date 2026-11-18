//go:build windows && !wails3

package nativewindow

import (
	"path/filepath"

	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

func configurePluginWebview(app *options.App, profile string) error {
	app.Windows = &windows.Options{WebviewUserDataPath: filepath.Join(profile, "webview2"),
		WindowClassName: "GoNaviPluginWindow", DLLSearchPaths: windows.DLLSearchSystem32 | windows.DLLSearchApplicationDir}
	return nil
}
