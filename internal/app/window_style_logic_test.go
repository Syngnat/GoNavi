package app

import "testing"

func TestResolveMacNativeWindowControlStateEnabled(t *testing.T) {
	state := resolveMacNativeWindowControlState(true)

	if !state.ShowNativeButtons {
		t.Fatal("expected native buttons to be visible when enabled")
	}
	if !state.UseTitledWindow || !state.UseFullSizeContent {
		t.Fatal("expected enabled state to request titled full-size content window")
	}
	if !state.HideWindowTitle || !state.TransparentTitlebar {
		t.Fatal("expected enabled state to hide title and use transparent titlebar")
	}
	if !state.AllowNativeFullscreen {
		t.Fatal("expected enabled state to allow native fullscreen")
	}
}

func TestResolveMacNativeWindowControlStateIgnoresLegacyDisablePreference(t *testing.T) {
	state := resolveMacNativeWindowControlState(false)

	if !state.ShowNativeButtons {
		t.Fatal("expected native buttons to remain visible for a legacy disabled preference")
	}
	if !state.UseTitledWindow || !state.UseFullSizeContent {
		t.Fatal("expected native titled full-size content window for a legacy disabled preference")
	}
	if !state.HideWindowTitle || !state.TransparentTitlebar {
		t.Fatal("expected hidden title and transparent titlebar for a legacy disabled preference")
	}
	if !state.AllowNativeFullscreen {
		t.Fatal("expected native fullscreen behavior for a legacy disabled preference")
	}
}

func TestShouldApplyMacNativeWindowStyleAcceptsMainWailsWindow(t *testing.T) {
	tests := []macWindowIdentity{
		{ClassName: "WailsWindow", DelegateClassName: "WindowDelegate", Title: "GoNavi"},
		{ClassName: "WailsWindow", DelegateClassName: "", Title: ""},
		{ClassName: "", DelegateClassName: "WindowDelegate", Title: ""},
		{ClassName: "", DelegateClassName: "", Title: "GoNavi"},
	}

	for _, tt := range tests {
		if !shouldApplyMacNativeWindowStyle(tt) {
			t.Fatalf("expected window identity %+v to be treated as main app window", tt)
		}
	}
}

func TestShouldApplyMacNativeWindowStyleRejectsSystemAuxiliaryWindows(t *testing.T) {
	tests := []macWindowIdentity{
		{ClassName: "TUINSWindow", DelegateClassName: "TUINSWindow", Title: ""},
		{ClassName: "NSToolbarFullScreenWindow", DelegateClassName: "", Title: ""},
		{ClassName: "_NSFullScreenTransitionOverlayWindow", DelegateClassName: "", Title: ""},
		{ClassName: "NSPanel", DelegateClassName: "", Title: ""},
	}

	for _, tt := range tests {
		if shouldApplyMacNativeWindowStyle(tt) {
			t.Fatalf("expected window identity %+v to be rejected as auxiliary/system window", tt)
		}
	}
}
