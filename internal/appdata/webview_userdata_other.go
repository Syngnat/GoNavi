//go:build !windows

package appdata

// ResolveWindowsWebviewUserDataPath is Windows-only; other platforms use the
// runtime default.
func ResolveWindowsWebviewUserDataPath() string { return "" }
