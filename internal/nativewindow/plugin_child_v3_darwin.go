//go:build darwin && cgo && wails3

package nativewindow

// Wails v3 has no per-window data-store option. The plugin child still runs in
// its own process with an isolated window profile; the v2 WKWebsiteDataStore
// swizzle cannot be linked reliably from this package under the v3 build, so it
// is intentionally not installed here.
func preparePluginChildPlatform(string) error { return nil }
