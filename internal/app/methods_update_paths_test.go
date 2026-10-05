package app

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	stdRuntime "runtime"
	"strings"
	"sync"
	"testing"
)

func TestResolveExecutablePathKeepsOriginalWhenEvalSymlinksFails(t *testing.T) {
	original := filepath.Join(t.TempDir(), "GoNavi.exe")
	cases := []struct {
		name string
		eval func(string) (string, error)
	}{
		{
			name: "evaluation fails",
			eval: func(string) (string, error) { return "", errors.New("broken symlink") },
		},
		{
			name: "evaluation is empty",
			eval: func(string) (string, error) { return "", nil },
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolveExecutablePath(
				func() (string, error) { return original, nil },
				tc.eval,
			)
			if err != nil {
				t.Fatalf("resolveExecutablePath returned error: %v", err)
			}
			if got != original {
				t.Fatalf("resolveExecutablePath = %q, want original %q", got, original)
			}
		})
	}
}

func TestResolveReusableStagedUpdateForPlatformSkipsLegacyWindowsExeStagedAsset(t *testing.T) {
	preferredWorkspaceDir := t.TempDir()
	legacyWorkspaceDir := t.TempDir()
	info := UpdateInfo{
		Channel:       string(updateChannelLatest),
		LatestVersion: "0.8.4",
		AssetName:     "GoNavi-0.8.4-Windows-Amd64-Portable.exe",
		AssetSize:     8,
	}

	legacyStagedDir := filepath.Join(
		legacyWorkspaceDir,
		buildUpdateStageDirNameForPlatform("windows", info.Channel, info.LatestVersion),
	)
	if err := os.MkdirAll(legacyStagedDir, 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}
	legacyAssetPath := filepath.Join(legacyStagedDir, info.AssetName)
	if err := os.WriteFile(legacyAssetPath, []byte("12345678"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	reused := resolveReusableStagedUpdateForPlatform("windows", preferredWorkspaceDir, legacyWorkspaceDir, info, nil)
	if reused != nil {
		t.Fatalf("expected legacy staged windows exe to be ignored, got %#v", reused)
	}
}

func TestResolveReusableStagedUpdateForPlatformPrefersAssetInCacheWorkspace(t *testing.T) {
	preferredWorkspaceDir := t.TempDir()
	legacyWorkspaceDir := t.TempDir()
	info := UpdateInfo{
		Channel:       string(updateChannelLatest),
		LatestVersion: "0.8.4",
		AssetName:     "GoNavi-0.8.4-Windows-Amd64-Portable.exe",
		AssetSize:     8,
	}

	preferredAssetPath := filepath.Join(preferredWorkspaceDir, info.AssetName)
	if err := os.WriteFile(preferredAssetPath, []byte("12345678"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	legacyStagedDir := filepath.Join(
		legacyWorkspaceDir,
		buildUpdateStageDirNameForPlatform("windows", info.Channel, info.LatestVersion),
	)
	if err := os.MkdirAll(legacyStagedDir, 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}
	legacyAssetPath := filepath.Join(legacyStagedDir, info.AssetName)
	if err := os.WriteFile(legacyAssetPath, []byte("87654321"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	reused := resolveReusableStagedUpdateForPlatform("windows", preferredWorkspaceDir, legacyWorkspaceDir, info, nil)
	if reused == nil {
		t.Fatal("expected cache workspace windows exe to be reused")
	}
	if reused.FilePath != preferredAssetPath {
		t.Fatalf("expected preferred cache asset %q, got %q", preferredAssetPath, reused.FilePath)
	}
	if reused.WorkspaceDir != preferredWorkspaceDir {
		t.Fatalf("expected workspace %q, got %q", preferredWorkspaceDir, reused.WorkspaceDir)
	}
}

func TestResolveReusableStagedUpdateForPlatformDoesNotReuseCurrentWindowsExeInsideStagedDir(t *testing.T) {
	preferredWorkspaceDir := t.TempDir()
	legacyWorkspaceDir := t.TempDir()
	info := UpdateInfo{
		Channel:       string(updateChannelLatest),
		LatestVersion: "0.8.4",
		AssetName:     "GoNavi-0.8.4-Windows-Amd64-Portable.exe",
		AssetSize:     8,
	}

	legacyStagedDir := filepath.Join(
		legacyWorkspaceDir,
		buildUpdateStageDirNameForPlatform("windows", info.Channel, info.LatestVersion),
	)
	if err := os.MkdirAll(legacyStagedDir, 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}
	legacyAssetPath := filepath.Join(legacyStagedDir, info.AssetName)
	if err := os.WriteFile(legacyAssetPath, []byte("12345678"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	reused := resolveReusableStagedUpdateForPlatform("windows", preferredWorkspaceDir, legacyWorkspaceDir, info, &stagedUpdate{
		Channel:   updateChannelLatest,
		Version:   info.LatestVersion,
		AssetName: info.AssetName,
		FilePath:  legacyAssetPath,
		StagedDir: legacyStagedDir,
	})
	if reused != nil {
		t.Fatalf("expected current staged windows exe inside staging dir to be ignored, got %#v", reused)
	}
}

func TestResolveReusableStagedUpdateForPlatformReusesPortableZipFromFallbackWorkspaceRoot(t *testing.T) {
	preferredWorkspaceDir := t.TempDir()
	legacyWorkspaceDir := t.TempDir()
	info := UpdateInfo{
		Channel:       string(updateChannelLatest),
		LatestVersion: "0.8.5",
		AssetName:     "GoNavi-0.8.5-Windows-Amd64-Portable.zip",
		AssetSize:     8,
		InstallMode:   string(updateInstallModePortable),
		PackageType:   string(updatePackageTypePortable),
		AutoRelaunch:  true,
	}

	assetPath := filepath.Join(legacyWorkspaceDir, info.AssetName)
	if err := os.WriteFile(assetPath, []byte("12345678"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	reused := resolveReusableStagedUpdateForPlatform("windows", preferredWorkspaceDir, legacyWorkspaceDir, info, nil)
	if reused == nil {
		t.Fatal("expected fallback workspace portable ZIP to be reused")
	}
	if reused.FilePath != assetPath || reused.WorkspaceDir != legacyWorkspaceDir || reused.PackageType != updatePackageTypePortable {
		t.Fatalf("unexpected reused portable ZIP: %#v", reused)
	}
}

func TestEnsureWindowsUpdateTargetWritableAcceptsWritableDirectory(t *testing.T) {
	if stdRuntime.GOOS != "windows" {
		t.Skip("windows-only update target validation")
	}

	target := filepath.Join(t.TempDir(), "GoNavi.exe")
	if err := ensureWindowsUpdateTargetWritable(target); err != nil {
		t.Fatalf("ensureWindowsUpdateTargetWritable returned error: %v", err)
	}
}

func TestInstallUpdateAndRestartFailsBeforeLaunchWhenWindowsTargetDirIsNotWritable(t *testing.T) {
	if stdRuntime.GOOS != "windows" {
		t.Skip("windows-only update target validation")
	}

	stagedDir := t.TempDir()
	assetPath := filepath.Join(stagedDir, "GoNavi-0.8.2-Windows-Amd64-Portable.exe")
	if err := os.WriteFile(assetPath, []byte("12345678"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	app := NewApp()
	app.updateState.staged = &stagedUpdate{
		Channel:      updateChannelLatest,
		Version:      "0.8.2",
		AssetName:    filepath.Base(assetPath),
		FilePath:     assetPath,
		StagedDir:    stagedDir,
		InstallMode:  updateInstallModePortable,
		PackageType:  updatePackageTypePortable,
		AutoRelaunch: true,
	}

	originalResolveInstallTarget := updateResolveInstallTarget
	originalLaunchInstallScript := updateLaunchInstallScript
	t.Cleanup(func() {
		updateResolveInstallTarget = originalResolveInstallTarget
		updateLaunchInstallScript = originalLaunchInstallScript
	})

	updateResolveInstallTarget = func() string {
		return filepath.Join(stagedDir, "missing", "GoNavi.exe")
	}

	launched := false
	updateLaunchInstallScript = func(*stagedUpdate) error {
		launched = true
		return nil
	}

	result := app.InstallUpdateAndRestart(true)
	if result.Success {
		t.Fatalf("expected InstallUpdateAndRestart to fail, got %#v", result)
	}
	if launched {
		t.Fatal("expected launch script to be skipped when install target is not writable")
	}
	if !strings.Contains(result.Message, "not writable") {
		t.Fatalf("expected install target write failure in message, got %q", result.Message)
	}
}

func TestInstallUpdateAndRestartRejectsUnresolvedWindowsTargetBeforeMaintenance(t *testing.T) {
	if stdRuntime.GOOS != "windows" {
		t.Skip("windows-only install target validation")
	}

	stagedDir := t.TempDir()
	assetPath := filepath.Join(stagedDir, "GoNavi-0.8.6-Windows-Amd64-Portable.zip")
	if err := os.WriteFile(assetPath, []byte("12345678"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}
	app := NewApp()
	app.SetLanguage("en-US")
	app.updateState.staged = &stagedUpdate{
		Channel:      updateChannelLatest,
		Version:      "0.8.6",
		AssetName:    filepath.Base(assetPath),
		FilePath:     assetPath,
		StagedDir:    stagedDir,
		InstallMode:  updateInstallModePortable,
		PackageType:  updatePackageTypePortable,
		AutoRelaunch: true,
	}

	originalResolveInstallTarget := updateResolveInstallTarget
	originalResolveInstallMode := updateResolveInstallMode
	originalAcquireMaintenance := updateAcquireWindowsMaintenance
	originalLaunchInstallScript := updateLaunchInstallScript
	t.Cleanup(func() {
		updateResolveInstallTarget = originalResolveInstallTarget
		updateResolveInstallMode = originalResolveInstallMode
		updateAcquireWindowsMaintenance = originalAcquireMaintenance
		updateLaunchInstallScript = originalLaunchInstallScript
	})
	updateResolveInstallTarget = func() string { return "" }
	updateResolveInstallMode = func() updateInstallMode { return updateInstallModePortable }
	maintenanceCalled := false
	updateAcquireWindowsMaintenance = func(string) (windowsUpdateMaintenanceLease, error) {
		maintenanceCalled = true
		return windowsUpdateMaintenanceLease{}, nil
	}
	launched := false
	updateLaunchInstallScript = func(*stagedUpdate) error {
		launched = true
		return nil
	}

	result := app.InstallUpdateAndRestart(true)
	if result.Success {
		t.Fatalf("expected unresolved install target failure, got %#v", result)
	}
	if maintenanceCalled {
		t.Fatal("maintenance must not be acquired for an unresolved install target")
	}
	if launched {
		t.Fatal("installer must not launch for an unresolved install target")
	}
	if !strings.Contains(result.Message, "Unable to determine") {
		t.Fatalf("expected localized unresolved target detail, got %q", result.Message)
	}
}

func TestInstallUpdateAndRestartMSISkipsPortableTargetWriteProbe(t *testing.T) {
	if stdRuntime.GOOS != "windows" {
		t.Skip("windows-only MSI launch validation")
	}

	stagedDir := t.TempDir()
	assetPath := filepath.Join(stagedDir, "GoNavi-0.8.2-Windows-Amd64-Installer.msi")
	if err := os.WriteFile(assetPath, []byte("12345678"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}
	app := NewApp()
	app.updateState.staged = &stagedUpdate{
		Channel:      updateChannelLatest,
		Version:      "0.8.2",
		AssetName:    filepath.Base(assetPath),
		FilePath:     assetPath,
		StagedDir:    stagedDir,
		InstallMode:  updateInstallModeMSI,
		PackageType:  updatePackageTypeMSI,
		AutoRelaunch: true,
	}

	originalResolveInstallTarget := updateResolveInstallTarget
	originalResolveInstallMode := updateResolveInstallMode
	originalLaunchInstallScript := updateLaunchInstallScript
	t.Cleanup(func() {
		updateResolveInstallTarget = originalResolveInstallTarget
		updateResolveInstallMode = originalResolveInstallMode
		updateLaunchInstallScript = originalLaunchInstallScript
	})
	updateResolveInstallTarget = func() string {
		return filepath.Join(stagedDir, "missing", "GoNavi.exe")
	}
	updateResolveInstallMode = func() updateInstallMode { return updateInstallModeMSI }
	launched := false
	updateLaunchInstallScript = func(*stagedUpdate) error {
		launched = true
		return errors.New("stop after MSI launcher reached")
	}

	result := app.InstallUpdateAndRestart(true)
	if result.Success {
		t.Fatalf("expected injected launcher error, got %#v", result)
	}
	if !launched {
		t.Fatal("expected MSI launcher to run without probing target directory writability")
	}
}

func TestResolveUpdateWorkspaceDirUsesVersionedUserCacheDirectory(t *testing.T) {
	cacheDir, err := os.UserCacheDir()
	if err != nil || strings.TrimSpace(cacheDir) == "" {
		t.Skip("user cache directory is unavailable")
	}
	got := resolveUpdateWorkspaceDir("0.8.2")
	want := filepath.Join(cacheDir, "GoNavi", "updates", "0.8.2")
	if got != want {
		t.Fatalf("expected workspace dir %q, got %q", want, got)
	}
}

func TestSanitizeVersionForPathRejectsDotSegments(t *testing.T) {
	for _, version := range []string{"", ".", "..", " / "} {
		if got := sanitizeVersionForPath(version); got != "latest" {
			t.Fatalf("sanitizeVersionForPath(%q) = %q, want latest", version, got)
		}
	}
}

func TestShouldStoreUpdateAssetInWorkspaceRoot(t *testing.T) {
	cases := []struct {
		goos string
		want bool
	}{
		{goos: "windows", want: true},
		{goos: "darwin", want: true},
		{goos: "linux", want: true},
		{goos: "freebsd", want: false},
	}

	for _, tc := range cases {
		if got := shouldStoreUpdateAssetInWorkspaceRoot(tc.goos); got != tc.want {
			t.Fatalf("shouldStoreUpdateAssetInWorkspaceRoot(%q) = %v, want %v", tc.goos, got, tc.want)
		}
	}
}

func TestResolveUpdateStagedDirForPlatformStaysInsideWorkspaceOnWindows(t *testing.T) {
	workspaceDir := filepath.Join("C:\\GoNavi", "app")
	got := resolveUpdateStagedDirForPlatform("windows", workspaceDir, "dev", "dev-93dc696")
	want := filepath.Join(workspaceDir, buildUpdateStageDirNameForPlatform("windows", "dev", "dev-93dc696"))
	if got != want {
		t.Fatalf("expected windows staged dir %q, got %q", want, got)
	}
}

func TestPrepareUpdateWorkspaceAndStagingDirsFallsBackWhenPreferredIsUnavailable(t *testing.T) {
	rootDir := t.TempDir()
	preferredDir := filepath.Join(rootDir, "unavailable")
	if err := os.WriteFile(preferredDir, []byte("not a directory"), 0o644); err != nil {
		t.Fatalf("WriteFile preferred path: %v", err)
	}
	fallbackDir := filepath.Join(rootDir, "GoNavi", "updates", "1.2.3")

	workspaceDir, stagedDir, err := prepareUpdateWorkspaceAndStagingDirs(
		[]string{preferredDir, fallbackDir},
		string(updateChannelLatest),
		"1.2.3",
	)
	if err != nil {
		t.Fatalf("prepareUpdateWorkspaceAndStagingDirs returned error: %v", err)
	}
	if workspaceDir != fallbackDir {
		t.Fatalf("workspace = %q, want fallback %q", workspaceDir, fallbackDir)
	}
	if !isUpdatePathStrictlyInsideDir(stagedDir, fallbackDir) {
		t.Fatalf("staging directory %q must be inside fallback workspace %q", stagedDir, fallbackDir)
	}
	if stat, err := os.Stat(stagedDir); err != nil || !stat.IsDir() {
		t.Fatalf("fallback staging directory was not created: stat=%v err=%v", stat, err)
	}
}

func TestValidateStagedUpdateWorkspaceAllowsVersionDirectoryUnderTempRoot(t *testing.T) {
	workspaceDir := filepath.Join(os.TempDir(), "GoNavi", "updates", "1.2.3")
	staged := &stagedUpdate{
		Version:        "1.2.3",
		WorkspaceDir:   workspaceDir,
		FilePath:       filepath.Join(workspaceDir, "GoNavi-1.2.3.dmg"),
		StagedDir:      filepath.Join(workspaceDir, ".gonavi-update-darwin-latest-1.2.3"),
		InstallLogPath: filepath.Join(workspaceDir, "gonavi-update-macos.log"),
	}
	if err := validateStagedUpdateWorkspace(staged); err != nil {
		t.Fatalf("valid update workspace rejected: %v", err)
	}
	wantCleanupDir := filepath.Join(os.TempDir(), "GoNavi", "updates")
	if got := resolveUpdateCleanupDir(staged.WorkspaceDir); got != wantCleanupDir {
		t.Fatalf("cleanup directory = %q, want entire updates directory %q", got, wantCleanupDir)
	}
}

func TestValidateStagedUpdateWorkspaceRejectsUnsafeCleanupTargets(t *testing.T) {
	updateRoot := filepath.Join(os.TempDir(), "GoNavi", "updates")
	validWorkspace := filepath.Join(updateRoot, "1.2.3")
	newStaged := func(workspaceDir string) *stagedUpdate {
		return &stagedUpdate{
			Version:        "1.2.3",
			WorkspaceDir:   workspaceDir,
			FilePath:       filepath.Join(workspaceDir, "GoNavi-1.2.3.dmg"),
			StagedDir:      filepath.Join(workspaceDir, "stage"),
			InstallLogPath: filepath.Join(workspaceDir, "update.log"),
		}
	}

	cases := []struct {
		name   string
		staged *stagedUpdate
	}{
		{name: "update root itself", staged: newStaged(updateRoot)},
		{name: "nested version directory", staged: newStaged(filepath.Join(updateRoot, "nested", "1.2.3"))},
		{name: "desktop directory", staged: newStaged(filepath.Join(os.TempDir(), "Desktop", "GoNavi-1.2.3"))},
		{name: "empty workspace", staged: newStaged("")},
	}
	outsidePackage := newStaged(validWorkspace)
	outsidePackage.FilePath = filepath.Join(os.TempDir(), "GoNavi-1.2.3.dmg")
	cases = append(cases, struct {
		name   string
		staged *stagedUpdate
	}{name: "package outside workspace", staged: outsidePackage})

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := validateStagedUpdateWorkspace(tc.staged); err == nil {
				t.Fatalf("unsafe workspace accepted: %#v", tc.staged)
			}
		})
	}
}

func TestExpectedAssetNameForExecutableUsesWindowsPortableSuffix(t *testing.T) {
	cases := []struct {
		name    string
		goarch  string
		version string
		want    string
	}{
		{
			name:    "amd64 release",
			goarch:  "amd64",
			version: "v1.2.3",
			want:    "GoNavi-1.2.3-Windows-Amd64-Portable.zip",
		},
		{
			name:    "arm64 dev",
			goarch:  "arm64",
			version: "dev-a1b2c3d",
			want:    "GoNavi-dev-a1b2c3d-Windows-Arm64-Portable.zip",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := expectedAssetNameForExecutable("windows", tc.goarch, tc.version, "")
			if err != nil {
				t.Fatalf("expectedAssetNameForExecutable returned error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("expectedAssetNameForExecutable() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestBuildWindowsPowerShellScriptReplacesTargetWithDownloadedExe(t *testing.T) {
	script := buildWindowsPowerShellScript()

	mustContain := []string{
		`Move-Item -LiteralPath $Target -Destination $TargetOld -Force`,
		`Copy-Item -LiteralPath $SourceExe -Destination $Target -Force`,
		`Start-Process -FilePath $Target -WorkingDirectory $TargetDir`,
		`package kept for manual install`,
		`Remove-UpdateArtifact $Source`,
	}
	for _, want := range mustContain {
		if !strings.Contains(script, want) {
			t.Fatalf("windows update script missing required token: %s\nscript:\n%s", want, script)
		}
	}
	// relaunch 必须在删除安装包之前
	startIdx := strings.Index(script, `Start-Process -FilePath $Target -WorkingDirectory $TargetDir`)
	delIdx := strings.LastIndex(script, `Remove-UpdateArtifact $Source`)
	if startIdx < 0 || delIdx < 0 || delIdx < startIdx {
		t.Fatalf("source package must be deleted only after relaunch attempt (start=%d del=%d)", startIdx, delIdx)
	}
}

func TestExpectedAssetNameForExecutableUsesLinuxWebKit41Suffix(t *testing.T) {
	assetName, err := expectedAssetNameForExecutable(
		"linux",
		"amd64",
		"v0.6.5",
		"/opt/GoNavi/gonavi-build-linux-amd64-webkit41",
	)
	if err != nil {
		t.Fatalf("expectedAssetNameForExecutable returned error: %v", err)
	}

	want := "GoNavi-0.6.5-Linux-Amd64-WebKit41.tar.gz"
	if assetName != want {
		t.Fatalf("unexpected linux webkit41 asset name: got %q want %q", assetName, want)
	}
}

func TestExpectedAssetNameForExecutableSupportsLinuxArm64(t *testing.T) {
	assetName, err := expectedAssetNameForExecutable(
		"linux",
		"arm64",
		"v0.6.5",
		"/opt/GoNavi/gonavi-build-linux-arm64",
	)
	if err != nil {
		t.Fatalf("expectedAssetNameForExecutable returned error: %v", err)
	}

	want := "GoNavi-0.6.5-Linux-Arm64.tar.gz"
	if assetName != want {
		t.Fatalf("unexpected linux arm64 asset name: got %q want %q", assetName, want)
	}
}

func TestBuildLinuxScriptPrefersTargetExecutableBasename(t *testing.T) {
	script := buildLinuxScript(
		"/tmp/GoNavi/updates/0.6.5/GoNavi-0.6.5-Linux-Amd64-WebKit41.tar.gz",
		"/opt/GoNavi/gonavi-build-linux-amd64-webkit41",
		"/tmp/GoNavi/updates",
		"/tmp/GoNavi/updates/0.6.5/.gonavi-update-linux-0.6.5",
		"/tmp/GoNavi/updates/0.6.5/update.log",
		12345,
	)

	mustContain := []string{
		`TARGET_NAME="$(basename "$TARGET")"`,
		`NEWBIN="$UPDATE_TMP_DIR/$TARGET_NAME"`,
		`NEWBIN=$(find "$UPDATE_TMP_DIR" -type f -name "$TARGET_NAME" | head -n 1)`,
		`NEWBIN=$(find "$UPDATE_TMP_DIR" -type f -name "GoNavi" | head -n 1)`,
		`if ! kill -0 "$NEW_PID" 2>/dev/null; then`,
		`exec rm -rf "$UPDATES_DIR"`,
	}
	for _, want := range mustContain {
		if !strings.Contains(script, want) {
			t.Fatalf("linux update script missing required token: %s\nscript:\n%s", want, script)
		}
	}
	launchIdx := strings.Index(script, `"$TARGET" >/dev/null 2>&1 &`)
	cleanupIdx := strings.Index(script, `exec rm -rf "$UPDATES_DIR"`)
	if launchIdx < 0 || cleanupIdx < launchIdx {
		t.Fatalf("linux updates cleanup must follow successful relaunch (launch=%d cleanup=%d)\n%s", launchIdx, cleanupIdx, script)
	}
}

func TestApplyGitHubAPIRequestHeadersUsesTokenAndVersion(t *testing.T) {
	t.Setenv("GONAVI_GITHUB_TOKEN", "ghp_test_token")
	req, err := http.NewRequest(http.MethodGet, "https://api.github.com/repos/Syngnat/GoNavi/releases/latest", nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	applyGitHubAPIRequestHeaders(req)
	if got := req.Header.Get("Authorization"); got != "Bearer ghp_test_token" {
		t.Fatalf("Authorization = %q", got)
	}
	if got := req.Header.Get("X-GitHub-Api-Version"); got != updateGitHubAPIVersion {
		t.Fatalf("X-GitHub-Api-Version = %q", got)
	}
	if !strings.HasPrefix(req.Header.Get("User-Agent"), "GoNavi-Updater/") {
		t.Fatalf("User-Agent = %q", req.Header.Get("User-Agent"))
	}
}

func TestClassifyGitHubUpdateHTTPErrorRateLimit(t *testing.T) {
	headers := http.Header{}
	headers.Set("X-RateLimit-Remaining", "0")
	headers.Set("X-RateLimit-Reset", "1783562945")
	body := []byte(`{"message":"API rate limit exceeded for 1.2.3.4."}`)
	err := classifyGitHubUpdateHTTPError(http.StatusForbidden, body, headers, true)
	var localized localizedUpdateError
	if !errors.As(err, &localized) {
		t.Fatalf("expected localizedUpdateError, got %T %v", err, err)
	}
	if localized.key != "app.update.backend.error.check_http_rate_limited" {
		t.Fatalf("unexpected key: %s", localized.key)
	}
	if detail, _ := localized.params["detail"].(string); !strings.Contains(detail, "rate limit") {
		t.Fatalf("detail should include rate limit message: %q", detail)
	}
}

func TestFetchReleaseByURLFallsBackToCacheOn403(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"API rate limit exceeded"}`))
	}))
	defer server.Close()

	updateReleaseCache = sync.Map{}
	storeCachedGitHubRelease(server.URL, &githubRelease{
		TagName: "v9.9.9",
		Name:    "cached",
		HTMLURL: "https://example.com",
	})

	release, err := fetchReleaseByURL(server.URL)
	if err != nil {
		t.Fatalf("expected cache fallback, got err=%v", err)
	}
	if release.TagName != "v9.9.9" {
		t.Fatalf("unexpected release: %#v", release)
	}
}
