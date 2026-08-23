//go:build !darwin || !cgo

package app

func installMacNativeWindowDiagnostics(logPath string) {}

func setMacNativeWindowControls(enabled bool) {}
