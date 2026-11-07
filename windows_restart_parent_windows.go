//go:build windows && !wails3

package main

import "GoNavi-Wails/internal/app"

// waitForWindowsRestartParent delegates to the shared implementation so the
// Wails v3 entry point can use the same startup barrier.
func waitForWindowsRestartParent(args []string) error {
	return app.WaitForWindowsRestartParent(args)
}
