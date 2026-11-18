//go:build darwin && cgo && !wails3

package nativewindow

/*
#include <stdlib.h>

void gonaviInstallDetachedDockMenu(void);
void gonaviPublishDetachedDockMenuSnapshot(const char *snapshotJSON, unsigned long long revision);
*/
import "C"

import "unsafe"

func supportsDetachedDockMenu() bool {
	return true
}

func installDetachedDockMenu() {
	C.gonaviInstallDetachedDockMenu()
}

func publishDetachedDockMenuSnapshotToPlatform(payload []byte, revision uint64) {
	snapshotJSON := C.CString(string(payload))
	defer C.free(unsafe.Pointer(snapshotJSON))
	C.gonaviPublishDetachedDockMenuSnapshot(snapshotJSON, C.ulonglong(revision))
}

//export gonaviFocusDetachedDockMenuWindow
func gonaviFocusDetachedDockMenuWindow(windowID *C.char) {
	if windowID == nil {
		return
	}
	id := C.GoString(windowID)
	go focusDetachedDockMenuWindow(id)
}
