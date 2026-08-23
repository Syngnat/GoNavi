package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

func TestShouldEnableWindowsMSISingleInstanceOnlyForInstalledMainGUI(t *testing.T) {
	installDir := t.TempDir()
	executablePath := filepath.Join(installDir, "GoNavi.exe")

	if shouldEnableWindowsMSISingleInstance("windows", executablePath) {
		t.Fatal("Portable executable unexpectedly enabled single-instance mode")
	}
	if err := os.WriteFile(filepath.Join(installDir, ".gonavi-msi-install"), []byte("MSI"), 0o644); err != nil {
		t.Fatalf("WriteFile MSI marker: %v", err)
	}

	if !shouldEnableWindowsMSISingleInstance("windows", executablePath) {
		t.Fatal("MSI executable did not enable single-instance lock")
	}
	if shouldEnableWindowsMSISingleInstance("darwin", executablePath) {
		t.Fatal("non-Windows executable unexpectedly enabled single-instance mode")
	}
}

func TestPrimaryWindowActivatorQueuesRequestsUntilRuntimeStartup(t *testing.T) {
	type activationContextKey struct{}
	ctx := context.WithValue(context.Background(), activationContextKey{}, "ready")
	activatedWith := make([]context.Context, 0, 2)
	activator := primaryWindowActivator{
		show: func(runtimeCtx context.Context) {
			activatedWith = append(activatedWith, runtimeCtx)
		},
	}

	activator.requestActivation()
	if len(activatedWith) != 0 {
		t.Fatalf("activation ran before startup context was available: %d", len(activatedWith))
	}
	activator.bindRuntimeContext(ctx)
	if len(activatedWith) != 1 || activatedWith[0] != ctx {
		t.Fatalf("queued activation contexts = %#v, want startup context", activatedWith)
	}
	activator.requestActivation()
	if len(activatedWith) != 2 || activatedWith[1] != ctx {
		t.Fatalf("live activation contexts = %#v, want startup context twice", activatedWith)
	}
}

func TestMainReturnsNonZeroForSpecialModeFailure(t *testing.T) {
	const helperEnv = "GONAVI_SPECIAL_MODE_FAILURE_HELPER"
	if os.Getenv(helperEnv) == "1" {
		os.Args = []string{"GoNavi", "mcp-server", "invalid-mode"}
		main()
		return
	}

	cmd := exec.Command(os.Args[0], "-test.run=^TestMainReturnsNonZeroForSpecialModeFailure$")
	cmd.Env = append(os.Environ(), helperEnv+"=1")
	err := cmd.Run()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("main returned success for a special-mode failure: %v", err)
	}
	if exitErr.ExitCode() != 1 {
		t.Fatalf("special-mode failure exit code = %d, want 1", exitErr.ExitCode())
	}
}

func TestMainReturnsZeroForSuccessfulSpecialMode(t *testing.T) {
	const helperEnv = "GONAVI_SPECIAL_MODE_SUCCESS_HELPER"
	if os.Getenv(helperEnv) == "1" {
		os.Args = []string{
			"GoNavi",
			"mcp-server",
			"remote-config",
			"--client",
			"openclaw",
			"--url",
			"https://example.com/mcp",
			"--token",
			"test-token",
		}
		main()
		return
	}

	cmd := exec.Command(os.Args[0], "-test.run=^TestMainReturnsZeroForSuccessfulSpecialMode$")
	cmd.Env = append(os.Environ(), helperEnv+"=1")
	if err := cmd.Run(); err != nil {
		t.Fatalf("successful special mode returned error: %v", err)
	}
}

func TestIsLowMemoryMode(t *testing.T) {
	tests := []struct {
		name string
		env  string
		want bool
	}{
		{name: "disabled by default", env: "", want: false},
		{name: "enabled with one", env: "1", want: true},
		{name: "enabled with true", env: "true", want: true},
		{name: "enabled with yes and whitespace", env: " yes ", want: true},
		{name: "disabled with false", env: "false", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("GONAVI_LOW_MEMORY_MODE", tt.env)
			if got := isLowMemoryMode(); got != tt.want {
				t.Fatalf("isLowMemoryMode() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestResolveInitialWindowStartStateDoesNotOverrideFrontendPreference(t *testing.T) {
	for _, goos := range []string{"windows", "darwin", "linux"} {
		t.Run(goos, func(t *testing.T) {
			if got := resolveInitialWindowStartState(goos); got != options.Normal {
				t.Fatalf("resolveInitialWindowStartState(%q) = %v, want Normal", goos, got)
			}
		})
	}
}

func TestResolveMainWindowChromeUsesNativeMacControlsFromCreation(t *testing.T) {
	macChrome := resolveMainWindowChrome(" Darwin ")
	if macChrome.Frameless {
		t.Fatal("macOS main window unexpectedly uses frameless Windows-style chrome")
	}
	if macChrome.TitleBar == nil {
		t.Fatal("macOS main window title bar is nil")
	}
	if got, want := *macChrome.TitleBar, *mac.TitleBarHidden(); got != want {
		t.Fatalf("macOS title bar = %+v, want %+v", got, want)
	}

	for _, goos := range []string{"windows", "linux"} {
		t.Run(goos, func(t *testing.T) {
			chrome := resolveMainWindowChrome(goos)
			if !chrome.Frameless {
				t.Fatalf("%s main window unexpectedly enables native macOS chrome", goos)
			}
			if chrome.TitleBar != nil {
				t.Fatalf("%s main window title bar = %+v, want nil", goos, chrome.TitleBar)
			}
		})
	}
}

func TestResolveWindowVisualOptions(t *testing.T) {
	tests := []struct {
		name                string
		goos                string
		lowMemoryMode       bool
		wantBackground      options.RGBA
		wantWebviewOpaque   bool
		wantWindowOpaque    bool
		wantWindowsBackdrop windows.BackdropType
	}{
		{
			name:                "windows defaults to opaque without acrylic",
			goos:                "windows",
			wantBackground:      options.RGBA{R: 255, G: 255, B: 255, A: 255},
			wantWebviewOpaque:   true,
			wantWindowOpaque:    true,
			wantWindowsBackdrop: windows.None,
		},
		{
			name:                "windows low memory remains opaque",
			goos:                " Windows ",
			lowMemoryMode:       true,
			wantBackground:      options.RGBA{R: 255, G: 255, B: 255, A: 255},
			wantWebviewOpaque:   true,
			wantWindowOpaque:    true,
			wantWindowsBackdrop: windows.None,
		},
		{
			name:                "mac default remains transparent",
			goos:                "darwin",
			wantBackground:      options.RGBA{R: 0, G: 0, B: 0, A: 0},
			wantWebviewOpaque:   false,
			wantWindowOpaque:    false,
			wantWindowsBackdrop: windows.Acrylic,
		},
		{
			name:                "low memory remains opaque on other platforms",
			goos:                "darwin",
			lowMemoryMode:       true,
			wantBackground:      options.RGBA{R: 255, G: 255, B: 255, A: 255},
			wantWebviewOpaque:   true,
			wantWindowOpaque:    true,
			wantWindowsBackdrop: windows.None,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			background, windowsOptions := resolveWindowVisualOptions(tt.goos, tt.lowMemoryMode)
			if background == nil {
				t.Fatal("resolveWindowVisualOptions() background is nil")
			}
			if got := *background; got != tt.wantBackground {
				t.Fatalf("background = %+v, want %+v", got, tt.wantBackground)
			}
			if windowsOptions == nil {
				t.Fatal("resolveWindowVisualOptions() windows options are nil")
			}
			if got := !windowsOptions.WebviewIsTransparent; got != tt.wantWebviewOpaque {
				t.Fatalf("webview opaque = %v, want %v", got, tt.wantWebviewOpaque)
			}
			if got := !windowsOptions.WindowIsTranslucent; got != tt.wantWindowOpaque {
				t.Fatalf("window opaque = %v, want %v", got, tt.wantWindowOpaque)
			}
			if got := windowsOptions.BackdropType; got != tt.wantWindowsBackdrop {
				t.Fatalf("Windows backdrop = %v, want %v", got, tt.wantWindowsBackdrop)
			}
		})
	}
}

func TestBuildMacApplicationMenu(t *testing.T) {
	called := 0
	appMenu := buildMacApplicationMenu(func() {
		called++
	}, true)

	if appMenu == nil {
		t.Fatal("buildMacApplicationMenu() returned nil")
	}
	if len(appMenu.Items) != 3 {
		t.Fatalf("expected 3 top-level menu items, got %d", len(appMenu.Items))
	}
	if appMenu.Items[0].Role != menu.AppMenuRole {
		t.Fatalf("first top-level menu role = %v, want %v", appMenu.Items[0].Role, menu.AppMenuRole)
	}
	if appMenu.Items[1].Role != menu.EditMenuRole {
		t.Fatalf("second top-level menu role = %v, want %v", appMenu.Items[1].Role, menu.EditMenuRole)
	}

	queryEditorMenu := appMenu.Items[2]
	if queryEditorMenu.Label != "SQL" {
		t.Fatalf("query editor menu label = %q, want %q", queryEditorMenu.Label, "SQL")
	}
	if queryEditorMenu.SubMenu == nil || len(queryEditorMenu.SubMenu.Items) != 1 {
		t.Fatalf("query editor submenu items = %d, want 1", len(queryEditorMenu.SubMenu.Items))
	}

	copyCurrentLineItem := queryEditorMenu.SubMenu.Items[0]
	if copyCurrentLineItem.Label != "Copy Current Line" {
		t.Fatalf("menu item label = %q, want %q", copyCurrentLineItem.Label, "Copy Current Line")
	}
	if copyCurrentLineItem.Accelerator == nil {
		t.Fatal("menu item accelerator is nil")
	}
	if copyCurrentLineItem.Accelerator.Key != "e" {
		t.Fatalf("menu item accelerator key = %q, want %q", copyCurrentLineItem.Accelerator.Key, "e")
	}
	if len(copyCurrentLineItem.Accelerator.Modifiers) != 1 || copyCurrentLineItem.Accelerator.Modifiers[0] != keys.CmdOrCtrlKey {
		t.Fatalf("menu item modifiers = %v, want [%v]", copyCurrentLineItem.Accelerator.Modifiers, keys.CmdOrCtrlKey)
	}

	copyCurrentLineItem.Click(&menu.CallbackData{MenuItem: copyCurrentLineItem})
	if called != 1 {
		t.Fatalf("native select-current-line callback called %d times, want 1", called)
	}
}
