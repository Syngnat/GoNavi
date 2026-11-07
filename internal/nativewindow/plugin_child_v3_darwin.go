//go:build darwin && cgo && wails3

package nativewindow

func preparePluginChildPlatform(string) error {
	return ensurePluginConfigurationGuard()
}
