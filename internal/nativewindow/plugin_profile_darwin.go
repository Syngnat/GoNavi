//go:build darwin && cgo && !wails3

package nativewindow

import (
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

func configurePluginWebview(app *options.App, _ string) error {
	if err := installPluginConfigurationGuard(); err != nil {
		return err
	}
	app.Mac = &mac.Options{}
	return nil
}
