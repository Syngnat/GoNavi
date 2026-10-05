package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWindowsApplicationUserModelIDForIconPathStaysStable(t *testing.T) {
	for _, iconPath := range []string{
		"",
		`C:\Program Files\GoNavi\GoNavi.exe`,
		`C:\icons\gonavi-brand.ico`,
		`C:\icons\gonavi-brand-d89e4f026a938e22fe081e12.ico`,
		`C:/icons/gonavi-brand-deadbeef01.ico`,
	} {
		t.Run(iconPath, func(t *testing.T) {
			if got := windowsApplicationUserModelIDForIconPath(iconPath); got != windowsApplicationUserModelID {
				t.Fatalf("windowsApplicationUserModelIDForIconPath(%q) = %q, want %q", iconPath, got, windowsApplicationUserModelID)
			}
		})
	}
}

func TestWindowsApplicationUserModelIDForStartupIgnoresPersistedSelection(t *testing.T) {
	configDir := t.TempDir()
	if got := windowsApplicationUserModelIDForStartup(configDir); got != windowsApplicationUserModelID {
		t.Fatalf("startup identity without selection = %q, want %q", got, windowsApplicationUserModelID)
	}

	iconDir := filepath.Join(configDir, windowsApplicationIconDirectoryName)
	if err := os.MkdirAll(iconDir, 0o755); err != nil {
		t.Fatal(err)
	}
	iconName := "gonavi-brand-d89e4f026a938e22fe081e12.ico"
	if err := os.WriteFile(filepath.Join(iconDir, iconName), []byte("ico"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(iconDir, windowsApplicationIconStateFileName), []byte(iconName+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := windowsApplicationUserModelIDForStartup(configDir); got != windowsApplicationUserModelID {
		t.Fatalf("startup identity with selection = %q, want stable identity", got)
	}
}

func TestWindowsBrandShortcutMatchTargetOnlyEnv(t *testing.T) {
	portableDir := t.TempDir()
	if got := windowsBrandShortcutMatchTargetOnlyEnv(filepath.Join(portableDir, "GoNavi.exe")); got != "1" {
		t.Fatalf("portable match-target flag = %q, want 1", got)
	}
	msiDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(msiDir, windowsMSIInstallMarker), []byte("MSI"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := windowsBrandShortcutMatchTargetOnlyEnv(filepath.Join(msiDir, "GoNavi.exe")); got != "0" {
		t.Fatalf("MSI match-target flag = %q, want 0", got)
	}
}
