//go:build !windows && !wails3

package main

func waitForWindowsRestartParent(_ []string) error { return nil }
