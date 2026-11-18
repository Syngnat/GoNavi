//go:build !wails3

package nativewindow

import "testing"

func TestNormalizeDetachedWindowBoundsForDisplaysRecentersOffscreenWindow(t *testing.T) {
	displays := []WindowBounds{{X: 0, Y: 24, Width: 2048, Height: 1128}}

	got := normalizeDetachedWindowBoundsForDisplays(
		WindowBounds{X: 0, Y: 1152, Width: 921, Height: 812},
		displays,
	)

	want := WindowBounds{X: 563, Y: 182, Width: 921, Height: 812}
	if got != want {
		t.Fatalf("normalized bounds = %#v, want %#v", got, want)
	}
}

func TestNormalizeDetachedWindowBoundsForDisplaysPreservesVisibleSecondaryDisplay(t *testing.T) {
	displays := []WindowBounds{
		{X: 0, Y: 24, Width: 2048, Height: 1128},
		{X: -1920, Y: 0, Width: 1920, Height: 1080},
	}
	want := WindowBounds{X: -1600, Y: 120, Width: 921, Height: 812}

	if got := normalizeDetachedWindowBoundsForDisplays(want, displays); got != want {
		t.Fatalf("normalized bounds = %#v, want unchanged %#v", got, want)
	}
}

func TestNormalizeDetachedWindowBoundsForDisplaysPreservesDisplayAbovePrimary(t *testing.T) {
	displays := []WindowBounds{
		{X: 0, Y: 24, Width: 2048, Height: 1128},
		{X: 224, Y: -900, Width: 1600, Height: 900},
	}
	want := WindowBounds{X: 420, Y: -820, Width: 921, Height: 812}

	if got := normalizeDetachedWindowBoundsForDisplays(want, displays); got != want {
		t.Fatalf("normalized bounds = %#v, want unchanged %#v", got, want)
	}
}

func TestNormalizeDetachedWindowBoundsForDisplaysFitsOversizedWindow(t *testing.T) {
	displays := []WindowBounds{{X: 0, Y: 24, Width: 1280, Height: 696}}

	got := normalizeDetachedWindowBoundsForDisplays(
		WindowBounds{X: 2200, Y: 200, Width: 1600, Height: 900},
		displays,
	)

	want := WindowBounds{X: 0, Y: 24, Width: 1280, Height: 696}
	if got != want {
		t.Fatalf("normalized bounds = %#v, want %#v", got, want)
	}
}

func TestNormalizeDetachedWindowBoundsForDisplaysFitsVisibleOversizedWindow(t *testing.T) {
	displays := []WindowBounds{{X: 0, Y: 24, Width: 1280, Height: 696}}

	got := normalizeDetachedWindowBoundsForDisplays(
		WindowBounds{X: 0, Y: 24, Width: 1600, Height: 900},
		displays,
	)

	want := WindowBounds{X: 0, Y: 24, Width: 1280, Height: 696}
	if got != want {
		t.Fatalf("normalized bounds = %#v, want %#v", got, want)
	}
}
