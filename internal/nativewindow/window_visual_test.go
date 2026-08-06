package nativewindow

import "testing"

func TestResolveDetachedWindowVisualOptionsUsesWebViewSurface(t *testing.T) {
	tests := []struct {
		name        string
		goos        string
		wantMac     bool
		wantLinux   bool
		wantWindows bool
	}{
		{name: "macOS", goos: "darwin", wantMac: true},
		{name: "linux", goos: "linux", wantLinux: true},
		{name: "windows", goos: "windows", wantWindows: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			visuals := resolveDetachedWindowVisualOptions(test.goos)
			if visuals.backgroundColour == nil || visuals.backgroundColour.A != 0 {
				t.Fatalf("background colour = %#v, want transparent", visuals.backgroundColour)
			}
			if (visuals.mac != nil) != test.wantMac {
				t.Fatalf("mac options present = %t, want %t", visuals.mac != nil, test.wantMac)
			}
			if (visuals.linux != nil) != test.wantLinux {
				t.Fatalf("linux options present = %t, want %t", visuals.linux != nil, test.wantLinux)
			}
			if (visuals.windows != nil) != test.wantWindows {
				t.Fatalf("windows options present = %t, want %t", visuals.windows != nil, test.wantWindows)
			}
		})
	}
}

func TestResolveDetachedWindowVisualOptionsKeepsUnknownPlatformsOpaque(t *testing.T) {
	visuals := resolveDetachedWindowVisualOptions("plan9")
	if visuals.backgroundColour == nil || visuals.backgroundColour.A != 255 {
		t.Fatalf("background colour = %#v, want opaque fallback", visuals.backgroundColour)
	}
}
