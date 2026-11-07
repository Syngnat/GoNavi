//go:build ((!windows && !linux && !darwin) || (darwin && !cgo)) && !wails3

package nativewindow

import (
	"errors"

	"github.com/wailsapp/wails/v2/pkg/options"
)

func configurePluginWebview(*options.App, string) error {
	return errors.New("isolated plugin WebView is unsupported on this build")
}
