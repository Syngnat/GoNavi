//go:build !wails3

package nativewindow

import (
	"reflect"
	"testing"
)

func TestBuildDockMenuSnapshotIncludesOnlyCurrentReadyWindows(t *testing.T) {
	windows := []WindowInfo{
		{ID: "closing", Title: "Closing", PID: 42, OpenedAt: 1, Ready: true, CloseSent: true},
		{ID: "hidden", Title: "Hidden", PID: 48, OpenedAt: 3, Ready: true, Hidden: true},
		{ID: "not-ready", Title: "Starting", PID: 43, OpenedAt: 2},
		{ID: " result-2 ", Title: " Result 2 ", PID: 44, OpenedAt: 40, Ready: true},
		{ID: "workbench-1", Title: "Workbench", PID: 45, OpenedAt: 20, Ready: true},
		{ID: "", Title: "Missing ID", PID: 46, OpenedAt: 10, Ready: true},
		{ID: "ai-chat", Title: "   ", PID: 47, OpenedAt: 30, Ready: true},
	}

	got := buildDockMenuSnapshot(windows)
	want := []dockMenuWindow{
		{ID: "workbench-1", Title: "Workbench", PID: 45},
		{ID: "ai-chat", Title: "GoNavi", PID: 47},
		{ID: "result-2", Title: "Result 2", PID: 44},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("dock menu snapshot = %#v, want %#v", got, want)
	}
}

func TestBuildDockMenuSnapshotUsesStableIDOrderForEqualOpenTimes(t *testing.T) {
	windows := []WindowInfo{
		{ID: "window-b", Title: "B", OpenedAt: 12, Ready: true},
		{ID: "window-a", Title: "A", OpenedAt: 12, Ready: true},
	}

	got := buildDockMenuSnapshot(windows)
	want := []dockMenuWindow{
		{ID: "window-a", Title: "A"},
		{ID: "window-b", Title: "B"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("dock menu snapshot = %#v, want %#v", got, want)
	}
}
