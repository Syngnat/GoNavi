//go:build darwin && cgo

package nativewindow

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework WebKit
int installPluginConfigurationGuard(void);
*/

import "C"

import "errors"

// installPluginConfigurationGuard makes every WKWebView in this process use an
// ephemeral data store. The v2 and v3 plugin child both call it before creating
// their first webview; the host process never calls it.
func installPluginConfigurationGuard() error {
	if C.installPluginConfigurationGuard() == 0 {
		return errors.New("plugin WebKit private profile is unavailable")
	}
	return nil
}
