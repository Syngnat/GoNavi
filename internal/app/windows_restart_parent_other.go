//go:build !windows

package app

// WaitForWindowsRestartParent is a no-op outside Windows.
func WaitForWindowsRestartParent(_ []string) error { return nil }
