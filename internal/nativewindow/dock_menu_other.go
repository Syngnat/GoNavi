//go:build (!darwin || !cgo) && !wails3

package nativewindow

func supportsDetachedDockMenu() bool {
	return false
}

func installDetachedDockMenu() {}

func publishDetachedDockMenuSnapshotToPlatform([]byte, uint64) {}
