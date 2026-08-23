//go:build !darwin || !cgo

package app

import "testing"

func TestInstallMacNativeWindowDiagnosticsNoopOnNonDarwin(t *testing.T) {
	installMacNativeWindowDiagnostics("")
	installMacNativeWindowDiagnostics("ignored.log")
}
