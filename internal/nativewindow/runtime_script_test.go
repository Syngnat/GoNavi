//go:build !wails3

package nativewindow

import (
	"strings"
	"testing"
)

func TestBridgeWindowIDUsesChildIdentity(t *testing.T) {
	bridge := newBridge(ChildOptions{ID: "workbench:query-1"})
	if got := bridge.WindowID(); got != "workbench:query-1" {
		t.Fatalf("WindowID() = %q, want %q", got, "workbench:query-1")
	}
}

func TestRuntimeCommandsDoNotReloadBootstrapForWindowIdentity(t *testing.T) {
	script := detachedRuntimeBridgeScript()
	if !strings.Contains(script, "bridge.WindowID()") {
		t.Fatal("runtime bridge does not read the lightweight window identity")
	}
	if strings.Contains(script, "detached.loadBootstrap().then(function (bootstrap)") {
		t.Fatal("runtime command routing still reloads the full bootstrap payload")
	}
}

func TestRuntimeExposesParentWindowManagerInsideDetachedChildren(t *testing.T) {
	script := detachedRuntimeBridgeScript()
	for _, expected := range []string{
		"Manager: parentWindowManager",
		"bridge.OpenWindow(request || {})",
		"bridge.FocusWindow",
		"bridge.HideWindow",
		"bridge.CloseWindow",
	} {
		if !strings.Contains(script, expected) {
			t.Fatalf("runtime bridge is missing %q", expected)
		}
	}
}

func TestRuntimeRoutesRevisionedHideAndFocusCommands(t *testing.T) {
	script := detachedRuntimeBridgeScript()
	for _, expected := range []string{
		GracefulHideRequestEventName,
		"requestGracefulHide(command)",
		"visibilityRevisionOf(command)",
		"control.FocusRevision(visibilityRevisionOf(command))",
	} {
		if !strings.Contains(script, expected) {
			t.Fatalf("runtime bridge is missing revisioned visibility marker %q", expected)
		}
	}
	if strings.Contains(script, "control.Hide(") {
		t.Fatal("runtime hide command bypasses the frontend state flush")
	}
}

func TestRuntimeRoutesParentCloseThroughGracefulFrontendEvent(t *testing.T) {
	script := detachedRuntimeBridgeScript()
	for _, expected := range []string{
		GracefulCloseRequestEventName,
		"requestGracefulClose(command.reason)",
		"window.dispatchEvent(new CustomEvent",
	} {
		if !strings.Contains(script, expected) {
			t.Fatalf("runtime bridge is missing graceful close marker %q", expected)
		}
	}
	if strings.Contains(script, "control.Close();") {
		t.Fatal("parent close command still quits before the frontend can flush state")
	}
}

func TestRuntimeExposesTwoPhaseChildPresentation(t *testing.T) {
	script := detachedRuntimeBridgeScript()
	for _, expected := range []string{
		"present: function ()",
		"control.Present()",
		"native window present control is unavailable",
	} {
		if !strings.Contains(script, expected) {
			t.Fatalf("runtime bridge is missing presentation marker %q", expected)
		}
	}
}
