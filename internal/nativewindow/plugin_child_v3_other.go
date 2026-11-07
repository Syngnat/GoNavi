//go:build wails3 && !windows && (!darwin || !cgo)

package nativewindow

func preparePluginChildPlatform(string) error { return nil }
