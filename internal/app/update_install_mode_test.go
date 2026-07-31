package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveUpdateInstallModeForExecutableUsesSiblingMSIMarker(t *testing.T) {
	installDir := t.TempDir()
	executablePath := filepath.Join(installDir, "GoNavi.exe")

	if got := resolveUpdateInstallModeForExecutable("windows", executablePath); got != updateInstallModePortable {
		t.Fatalf("install mode without marker = %q, want portable", got)
	}
	markerPath := filepath.Join(installDir, windowsMSIInstallMarker)
	if err := os.WriteFile(markerPath, []byte("msi\n"), 0o644); err != nil {
		t.Fatalf("WriteFile marker: %v", err)
	}
	if got := resolveUpdateInstallModeForExecutable("windows", executablePath); got != updateInstallModeMSI {
		t.Fatalf("install mode with marker = %q, want msi", got)
	}
	if got := resolveUpdateInstallModeForExecutable("linux", executablePath); got != updateInstallModeUnknown {
		t.Fatalf("non-Windows install mode = %q, want unknown", got)
	}
}

func TestResolveUpdateInstallModeForExecutableRejectsMarkerDirectory(t *testing.T) {
	installDir := t.TempDir()
	if err := os.Mkdir(filepath.Join(installDir, windowsMSIInstallMarker), 0o755); err != nil {
		t.Fatalf("Mkdir marker: %v", err)
	}
	if got := resolveUpdateInstallModeForExecutable("windows", filepath.Join(installDir, "GoNavi.exe")); got != updateInstallModeUnknown {
		t.Fatalf("install mode with invalid marker directory = %q, want unknown", got)
	}
}

func TestExpectedAssetNameForWindowsInstallMode(t *testing.T) {
	cases := []struct {
		name        string
		arch        string
		installMode updateInstallMode
		want        string
	}{
		{name: "amd64 portable", arch: "amd64", installMode: updateInstallModePortable, want: "GoNavi-1.2.3-Windows-Amd64-Portable.zip"},
		{name: "amd64 msi", arch: "amd64", installMode: updateInstallModeMSI, want: "GoNavi-1.2.3-Windows-Amd64-Installer.msi"},
		{name: "arm64 portable", arch: "arm64", installMode: updateInstallModePortable, want: "GoNavi-1.2.3-Windows-Arm64-Portable.zip"},
		{name: "arm64 msi", arch: "arm64", installMode: updateInstallModeMSI, want: "GoNavi-1.2.3-Windows-Arm64-Installer.msi"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := expectedAssetNameForExecutableAndInstallMode("windows", tc.arch, "v1.2.3", "", tc.installMode)
			if err != nil {
				t.Fatalf("expectedAssetNameForExecutableAndInstallMode: %v", err)
			}
			if got != tc.want {
				t.Fatalf("asset name = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestResolveUpdateWorkspaceDirForPlatformUsesVersionedCacheForEveryPlatform(t *testing.T) {
	installTarget := filepath.Join("Users", "tester", "Desktop", "GoNavi.exe")
	userCacheDir := filepath.Join("Users", "tester", "cache")
	want := filepath.Join(userCacheDir, "GoNavi", "updates", "1.2.3")
	cases := []struct {
		goos        string
		installMode updateInstallMode
	}{
		{goos: "darwin", installMode: updateInstallModePortable},
		{goos: "windows", installMode: updateInstallModePortable},
		{goos: "windows", installMode: updateInstallModeMSI},
		{goos: "linux", installMode: updateInstallModePortable},
	}

	for _, tc := range cases {
		got := resolveUpdateWorkspaceDirForPlatform(tc.goos, "1.2.3", tc.installMode, installTarget, userCacheDir)
		if got != want {
			t.Fatalf("%s/%s workspace = %q, want %q", tc.goos, tc.installMode, got, want)
		}
	}
}

func TestResolveUpdateWorkspaceDirForPlatformFallsBackToVersionedTempDirectory(t *testing.T) {
	got := resolveUpdateWorkspaceDirForPlatform("linux", "v1.2.3 beta", updateInstallModePortable, "/opt/GoNavi", "")
	want := filepath.Join(os.TempDir(), "GoNavi", "updates", "v1.2.3-beta")
	if got != want {
		t.Fatalf("temporary workspace = %q, want %q", got, want)
	}
}

func TestValidateUpdatePackageForCurrentInstallModeRejectsModeAndSuffixMismatch(t *testing.T) {
	originalResolveMode := updateResolveInstallMode
	t.Cleanup(func() { updateResolveInstallMode = originalResolveMode })
	updateResolveInstallMode = func() updateInstallMode { return updateInstallModeMSI }

	if err := validateUpdatePackageForCurrentInstallMode("windows", updateInstallModeMSI, updatePackageTypeMSI, `C:\\tmp\\GoNavi-Installer.msi`); err != nil {
		t.Fatalf("valid MSI package rejected: %v", err)
	}
	if err := validateUpdatePackageForCurrentInstallMode("windows", updateInstallModePortable, updatePackageTypePortable, `C:\\tmp\\GoNavi-Portable.exe`); err == nil {
		t.Fatal("expected changed install mode to be rejected")
	}
	if err := validateUpdatePackageForCurrentInstallMode("windows", updateInstallModeMSI, updatePackageTypeMSI, `C:\\tmp\\GoNavi-Installer.exe`); err == nil {
		t.Fatal("expected invalid MSI suffix to be rejected")
	}
}

func TestPortableUpdatePackageAcceptsZipAndLegacyExe(t *testing.T) {
	for _, assetPath := range []string{
		`C:\\tmp\\GoNavi-Portable.zip`,
		`C:\\tmp\\GoNavi-Portable.exe`,
	} {
		if !isUpdatePackageCompatibleWithInstallMode("windows", updateInstallModePortable, updatePackageTypePortable, assetPath) {
			t.Fatalf("valid portable package rejected: %s", assetPath)
		}
	}
	if isUpdatePackageCompatibleWithInstallMode("windows", updateInstallModePortable, updatePackageTypePortable, `C:\\tmp\\GoNavi-Installer.msi`) {
		t.Fatal("expected MSI suffix to be rejected for portable mode")
	}
}
