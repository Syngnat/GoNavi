//go:build linux && !wails3

package nativewindow

import (
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
)

func configurePluginWebview(app *options.App, _ string) error {
	// Wails v2 uses the process-default WebKit context. XDG paths and HOME were
	// replaced before exec, before GLib can cache the host's storage directories.
	app.Linux = &linux.Options{ProgramName: "gonavi-plugin-window", WebviewGpuPolicy: linux.WebviewGpuPolicyOnDemand}
	return nil
}
