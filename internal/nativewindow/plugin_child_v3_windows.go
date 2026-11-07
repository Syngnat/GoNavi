//go:build windows && wails3

package nativewindow

import (
	"golang.org/x/sys/windows"
)

func preparePluginChildPlatform(string) error {
	return windows.SetDefaultDllDirectories(
		windows.LOAD_LIBRARY_SEARCH_SYSTEM32 | windows.LOAD_LIBRARY_SEARCH_APPLICATION_DIR,
	)
}
