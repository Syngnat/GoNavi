//go:build windows && !wails3

package nativewindow

import (
	"path/filepath"
	"testing"

	"github.com/wailsapp/wails/v2/pkg/options"
)

func TestPluginWindowsUsesDedicatedWebviewProfile(t *testing.T) {
	app := &options.App{}
	profile := t.TempDir()
	if err := configurePluginWebview(app, profile); err != nil {
		t.Fatal(err)
	}
	if app.Windows == nil || app.Windows.WebviewUserDataPath != filepath.Join(profile, "webview2") {
		t.Fatal("default shared WebView2 profile selected")
	}
	if len(app.Bind) != 0 {
		t.Fatal("host bindings exposed")
	}
}
