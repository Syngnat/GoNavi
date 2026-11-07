//go:build darwin && cgo

package nativewindow

/*
#cgo CFLAGS: -I${SRCDIR}
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#include "plugin_profile_darwin_guard.h"
*/

import "C"

import "errors"

// ensurePluginConfigurationGuard makes every WKWebView in this process use an
// ephemeral data store. The v2 and v3 plugin child both call it before creating
// their first webview; the host process never calls it.
func ensurePluginConfigurationGuard() error {
	if C.installPluginConfigurationGuard() == 0 {
		return errors.New("plugin WebKit private profile is unavailable")
	}
	return nil
}
