//go:build wails3

package main

import (
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func TestResolveV3StartURL(t *testing.T) {
	t.Run("uses the same origin as GoNavi v2 on every platform", func(t *testing.T) {
		cases := map[string]string{
			"darwin":  "wails://wails/",
			"linux":   "wails://wails/",
			"windows": "http://wails.localhost/",
		}
		for goos, want := range cases {
			if got := resolveV3StartURL(goos); got != want {
				t.Fatalf("%s: start URL = %q, want %q", goos, got, want)
			}
		}
	})

	t.Run("unknown platforms keep the Wails default", func(t *testing.T) {
		if got := resolveV3StartURL("plan9"); got != "/" {
			t.Fatalf("start URL = %q, want /", got)
		}
	})
}

func TestResolveV3WindowChrome(t *testing.T) {
	t.Run("windows and linux are frameless on an opaque surface", func(t *testing.T) {
		t.Setenv("GONAVI_LOW_MEMORY_MODE", "")
		for _, goos := range []string{"windows", "linux"} {
			frameless, backgroundType, colour, mac := resolveV3WindowChrome(goos)
			if !frameless {
				t.Fatalf("%s: frameless = false, want true", goos)
			}
			if backgroundType != application.BackgroundTypeSolid {
				t.Fatalf("%s: background type = %v, want solid", goos, backgroundType)
			}
			if colour != application.NewRGBA(255, 255, 255, 255) {
				t.Fatalf("%s: background = %#v, want white", goos, colour)
			}
			if mac.TitleBar != (application.MacTitleBar{}) {
				t.Fatalf("%s: unexpected mac window options %#v", goos, mac)
			}
		}
	})

	t.Run("darwin hides the title bar but keeps traffic lights", func(t *testing.T) {
		t.Setenv("GONAVI_LOW_MEMORY_MODE", "")
		frameless, backgroundType, colour, mac := resolveV3WindowChrome("darwin")
		if frameless {
			t.Fatal("darwin should keep the native frame")
		}
		if backgroundType != application.BackgroundTypeTransparent {
			t.Fatalf("background type = %v, want transparent", backgroundType)
		}
		if colour != application.NewRGBA(0, 0, 0, 0) {
			t.Fatalf("background = %#v, want fully transparent", colour)
		}
		if mac.TitleBar != application.MacTitleBarHidden {
			t.Fatalf("title bar = %#v, want MacTitleBarHidden", mac.TitleBar)
		}
		if mac.Backdrop != application.MacBackdropTranslucent {
			t.Fatalf("backdrop = %v, want translucent", mac.Backdrop)
		}
	})

	t.Run("low memory falls back to an opaque surface", func(t *testing.T) {
		t.Setenv("GONAVI_LOW_MEMORY_MODE", "1")
		for _, goos := range []string{"windows", "linux", "darwin"} {
			_, backgroundType, colour, mac := resolveV3WindowChrome(goos)
			if backgroundType != application.BackgroundTypeSolid {
				t.Fatalf("%s: background type = %v, want solid", goos, backgroundType)
			}
			if colour != application.NewRGBA(255, 255, 255, 255) {
				t.Fatalf("%s: background = %#v, want white", goos, colour)
			}
			if mac.Backdrop == application.MacBackdropTranslucent {
				t.Fatalf("%s: low memory must not enable a translucent backdrop", goos)
			}
		}
	})
}
