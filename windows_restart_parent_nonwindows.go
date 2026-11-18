//go:build !windows && !wails3

package main

import "GoNavi-Wails/internal/app"

func waitForWindowsRestartParent(args []string) error {
	return app.WaitForWindowsRestartParent(args)
}
