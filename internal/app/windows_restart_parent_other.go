//go:build !windows && !darwin

package app

// WaitForWindowsRestartParent is a no-op outside Windows and macOS.
func WaitForWindowsRestartParent(_ []string) error { return nil }
