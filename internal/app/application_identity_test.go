package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWindowsApplicationUserModelIDForIconPathRotatesOnlyForBrandICO(t *testing.T) {
	cases := []struct {
		name     string
		iconPath string
		want     string
	}{
		{"empty path keeps base identity", "", windowsApplicationUserModelID},
		{"executable icon keeps base identity", `C:\Program Files\GoNavi\GoNavi.exe`, windowsApplicationUserModelID},
		{"legacy icon without hash keeps base identity", `C:\icons\gonavi-brand.ico`, windowsApplicationUserModelID},
		{"non-hex token keeps base identity", `C:\icons\gonavi-brand-not-hex.ico`, windowsApplicationUserModelID},
		{"empty token keeps base identity", `C:\icons\gonavi-brand-.ico`, windowsApplicationUserModelID},
		{
			"hashed brand icon rotates identity",
			`C:\Users\tester\.gonavi\application-icons\gonavi-brand-d89e4f026a938e22fe081e12.ico`,
			"Syngnat.GoNavi.Icon.d89e4f026a938e22fe081e12",
		},
		{
			"uppercase hash is normalized to lowercase",
			`C:\icons\gonavi-brand-ABCDEF0123456789ABCDEF12.ico`,
			"Syngnat.GoNavi.Icon.abcdef0123456789abcdef12",
		},
		{
			"forward slashed path rotates the same way",
			`C:/icons/gonavi-brand-deadbeef01.ico`,
			"Syngnat.GoNavi.Icon.deadbeef01",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := windowsApplicationUserModelIDForIconPath(testCase.iconPath); got != testCase.want {
				t.Fatalf("windowsApplicationUserModelIDForIconPath(%q) = %q, want %q", testCase.iconPath, got, testCase.want)
			}
		})
	}
}

func TestWindowsApplicationUserModelIDForStartupFollowsPersistedSelection(t *testing.T) {
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
	want := "Syngnat.GoNavi.Icon.d89e4f026a938e22fe081e12"
	if got := windowsApplicationUserModelIDForStartup(configDir); got != want {
		t.Fatalf("startup identity with selection = %q, want %q", got, want)
	}
}
