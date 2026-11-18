//go:build windows && !wails3

package nativewindow

import (
	"os"
	"testing"
)

func TestGrantParentForegroundAccessTargetsDirectParent(t *testing.T) {
	original := allowSetForegroundWindow
	t.Cleanup(func() {
		allowSetForegroundWindow = original
	})

	var processID uint32
	allowSetForegroundWindow = func(candidate uint32) bool {
		processID = candidate
		return true
	}

	if err := grantParentForegroundAccess(); err != nil {
		t.Fatalf("grantParentForegroundAccess error = %v", err)
	}
	if processID != uint32(os.Getppid()) {
		t.Fatalf("foreground process ID = %d, want parent %d", processID, os.Getppid())
	}
}

func TestGrantParentForegroundAccessReportsWindowsRejection(t *testing.T) {
	original := allowSetForegroundWindow
	t.Cleanup(func() {
		allowSetForegroundWindow = original
	})
	allowSetForegroundWindow = func(uint32) bool { return false }

	if err := grantParentForegroundAccess(); err == nil {
		t.Fatal("grantParentForegroundAccess error = nil, want Windows rejection")
	}
}
