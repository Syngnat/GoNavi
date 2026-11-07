//go:build !windows && !wails3

package main

func resolveWindowsWebviewUserDataPath() string {
	return ""
}
