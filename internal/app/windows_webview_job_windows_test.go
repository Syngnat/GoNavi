//go:build windows

package app

import (
	"slices"
	"testing"
)

func TestSelectWindowsWebViewJobTargetsOnlyDescendantWebViews(t *testing.T) {
	nodes := []runtimeProcess{
		{PID: 100, ParentPID: 1, ImageName: "gonavi.exe"},
		// Direct child browser process, as WebView2 creates it.
		{PID: 200, ParentPID: 100, ImageName: "msedgewebview2.exe"},
		// Renderer/GPU children inherit the job from their browser process and
		// run at a lower integrity level, so they are not assigned directly.
		{PID: 201, ParentPID: 200, ImageName: "msedgewebview2.exe"},
		// WebView2 owned by a detached window child process.
		{PID: 300, ParentPID: 100, ImageName: "gonavi.exe"},
		{PID: 301, ParentPID: 300, ImageName: "msedgewebview2.exe"},
		// Unrelated WebView2 host.
		{PID: 400, ParentPID: 1, ImageName: "msedgewebview2.exe"},
		// Non-WebView descendant.
		{PID: 500, ParentPID: 100, ImageName: "conhost.exe"},
	}

	got := selectWindowsWebViewJobTargets(nodes, 100)
	want := []uint32{200, 301}
	if !slices.Equal(got, want) {
		t.Fatalf("targets = %v, want %v", got, want)
	}
}

func TestSelectWindowsWebViewJobTargetsRejectsInvalidSelfPID(t *testing.T) {
	nodes := []runtimeProcess{
		{PID: 200, ParentPID: 4, ImageName: "msedgewebview2.exe"},
	}
	if got := selectWindowsWebViewJobTargets(nodes, 4); got != nil {
		t.Fatalf("targets = %v, want nil", got)
	}
}

func TestSelectWindowsWebViewJobTargetsSkipsSelf(t *testing.T) {
	nodes := []runtimeProcess{
		{PID: 100, ParentPID: 1, ImageName: "msedgewebview2.exe"},
	}
	if got := selectWindowsWebViewJobTargets(nodes, 100); len(got) != 0 {
		t.Fatalf("targets = %v, want none", got)
	}
}
