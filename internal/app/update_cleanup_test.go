package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestShouldRemoveWindowsUpdateArtifact(t *testing.T) {
	cases := []struct {
		name  string
		isDir bool
		want  bool
	}{
		{name: "GoNavi-dev-abc-Windows-Amd64.exe", want: true},
		{name: "GoNavi-dev-abc-Windows-Amd64-Installer.msi", want: true},
		{name: "GoNavi-0.8.4-Windows-Amd64-Portable.zip", want: true},
		{name: "gonavi-update-windows-123.log", want: true},
		{name: ".gonavi-update-windows-dev-dev-abc", isDir: true, want: true},
		{name: "GoNavi-dev-abc-MacOS-Arm64.dmg", want: false},
		{name: "GoNavi.exe", want: false},
		{name: "notes.log", want: false},
	}

	for _, tc := range cases {
		if got := shouldRemoveWindowsUpdateArtifact(tc.name, tc.isDir); got != tc.want {
			t.Fatalf("shouldRemoveWindowsUpdateArtifact(%q, %v) = %v, want %v", tc.name, tc.isDir, got, tc.want)
		}
	}
}

func TestResolveReusableStagedUpdateDoesNotReuseDifferentWindowsPackageType(t *testing.T) {
	tempDir := t.TempDir()
	assetPath := filepath.Join(tempDir, "GoNavi-0.8.5-Windows-Amd64-Installer.msi")
	if err := os.WriteFile(assetPath, []byte("12345678"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}
	info := UpdateInfo{
		Channel:       string(updateChannelLatest),
		LatestVersion: "0.8.5",
		AssetName:     filepath.Base(assetPath),
		AssetSize:     8,
		InstallMode:   string(updateInstallModeMSI),
		PackageType:   string(updatePackageTypeMSI),
		AutoRelaunch:  true,
	}
	current := &stagedUpdate{
		Channel:      updateChannelLatest,
		Version:      info.LatestVersion,
		AssetName:    info.AssetName,
		FilePath:     assetPath,
		InstallMode:  updateInstallModePortable,
		PackageType:  updatePackageTypePortable,
		AutoRelaunch: true,
	}

	reused := resolveReusableStagedUpdateForPlatform("windows", "", "", info, current)
	if reused != nil {
		t.Fatalf("expected package type mismatch not to reuse current staged update, got %#v", reused)
	}
}

func TestCleanupWindowsUpdateArtifactsKeepsCurrentTargetAndRemovesStalePackages(t *testing.T) {
	dir := t.TempDir()
	currentTarget := filepath.Join(dir, "GoNavi-dev-current-Windows-Amd64.exe")
	currentPackage := filepath.Join(dir, "GoNavi-dev-new-Windows-Amd64.exe")
	stalePackage := filepath.Join(dir, "GoNavi-dev-old-Windows-Amd64.exe")
	staleLog := filepath.Join(dir, "gonavi-update-windows-123.log")
	staleStage := filepath.Join(dir, ".gonavi-update-windows-dev-old")
	otherFile := filepath.Join(dir, "notes.txt")

	for _, path := range []string{currentTarget, currentPackage, stalePackage, staleLog, otherFile} {
		if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
			t.Fatalf("WriteFile(%q) returned error: %v", path, err)
		}
	}
	if err := os.MkdirAll(staleStage, 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}

	cleanupWindowsUpdateArtifacts([]string{dir}, map[string]struct{}{
		cleanComparablePath(currentTarget):  {},
		cleanComparablePath(currentPackage): {},
	})

	for _, path := range []string{currentTarget, currentPackage, otherFile} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("expected %q to remain: %v", path, err)
		}
	}
	for _, path := range []string{stalePackage, staleLog, staleStage} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("expected %q to be removed, stat err=%v", path, err)
		}
	}
}

func TestPrepareWindowsStagedUpdateAssetMovesPackageIntoStagedDir(t *testing.T) {
	dir := t.TempDir()
	stagedDir := filepath.Join(dir, ".gonavi-update-windows-dev-new")
	source := filepath.Join(dir, "GoNavi-dev-new-Windows-Amd64.exe")
	if err := os.WriteFile(source, []byte("payload"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	prepared, err := prepareWindowsStagedUpdateAsset(source, stagedDir)
	if err != nil {
		t.Fatalf("prepareWindowsStagedUpdateAsset returned error: %v", err)
	}
	want := filepath.Join(stagedDir, filepath.Base(source))
	if prepared != want {
		t.Fatalf("expected prepared path %q, got %q", want, prepared)
	}
	if _, err := os.Stat(source); !os.IsNotExist(err) {
		t.Fatalf("expected source to be moved away, stat err=%v", err)
	}
	if data, err := os.ReadFile(prepared); err != nil || string(data) != "payload" {
		t.Fatalf("expected payload in staged file, data=%q err=%v", string(data), err)
	}
}

func TestResolveWindowsUpdateFinalTargetPathMapsDownloadedPortableZipToExe(t *testing.T) {
	currentTarget := filepath.Join("D:", "软件", "数据库管理工具", "GoNavi", "GoNavi-dev-f930ffe-Windows-Amd64.exe")
	stagedSource := filepath.Join("C:", "Temp", "gonavi-updates", "GoNavi-dev-2d5f246-Windows-Amd64-Portable.zip")
	want := filepath.Join(filepath.Dir(currentTarget), "GoNavi-dev-2d5f246-Windows-Amd64-Portable.exe")

	if got := resolveWindowsUpdateFinalTargetPath(currentTarget, stagedSource); got != want {
		t.Fatalf("Windows update target = %q, want downloaded versioned path %q", got, want)
	}
}

func TestResolveWindowsUpdateFinalTargetPathKeepsLegacyPortableExeName(t *testing.T) {
	currentTarget := filepath.Join("D:", "软件", "数据库管理工具", "GoNavi", "GoNavi-dev-f930ffe-Windows-Amd64.exe")
	stagedSource := filepath.Join("C:", "Temp", "gonavi-updates", "GoNavi-dev-2d5f246-Windows-Amd64-Portable.exe")
	want := filepath.Join(filepath.Dir(currentTarget), filepath.Base(stagedSource))

	if got := resolveWindowsUpdateFinalTargetPath(currentTarget, stagedSource); got != want {
		t.Fatalf("Windows update target = %q, want legacy executable path %q", got, want)
	}
}

func TestResolveWindowsUpdateFinalTargetPathKeepsFixedExecutablePath(t *testing.T) {
	currentTarget := filepath.Join("D:", "软件", "数据库管理工具", "GoNavi", "GoNavi.exe")
	stagedSource := filepath.Join("C:", "Temp", "gonavi-updates", "GoNavi-dev-2d5f246-Windows-Amd64-Portable.zip")

	if got := resolveWindowsUpdateFinalTargetPath(currentTarget, stagedSource); got != currentTarget {
		t.Fatalf("Windows update target = %q, want fixed executable path %q", got, currentTarget)
	}
}

func TestBuildWindowsPowerShellScriptSchedulesUpdatesDirectoryCleanupAfterSuccess(t *testing.T) {
	script := buildWindowsPowerShellScript()

	mustContain := []string{
		`Write-UpdateLog 'update finished'`,
		`$CleanupCommand = 'Start-Sleep -Seconds 2; Remove-Item -LiteralPath $env:GONAVI_UPDATE_ROOT_DIR`,
		`$CleanupWorkingDirectory = [IO.Path]::GetTempPath()`,
		`-EncodedCommand`,
	}
	for _, token := range mustContain {
		if !strings.Contains(script, token) {
			t.Fatalf("expected script to contain %q\n%s", token, script)
		}
	}
	if strings.Contains(script, `cmd.exe`) {
		t.Fatalf("PowerShell updater must not route cleanup through cmd.exe\n%s", script)
	}
	relaunchIdx := strings.Index(script, `$NewProcess = Start-Process -FilePath $Target`)
	cleanupIdx := strings.Index(script, `$CleanupCommand = 'Start-Sleep -Seconds 2; Remove-Item -LiteralPath $env:GONAVI_UPDATE_ROOT_DIR`)
	failureIdx := strings.LastIndex(script, `} catch {`)
	if relaunchIdx < 0 || cleanupIdx < relaunchIdx || failureIdx < cleanupIdx {
		t.Fatalf("updates cleanup must be scheduled only on the success path (relaunch=%d cleanup=%d failure=%d)\n%s", relaunchIdx, cleanupIdx, failureIdx, script)
	}
}

func TestBuildWindowsPowerShellScriptDoesNotEmbedUnicodeRuntimePaths(t *testing.T) {
	source := `C:\Users\tester\AppData\Local\Temp\gonavi-updates\.gonavi-update-windows-latest-0.8.5\GoNavi-0.8.5-Windows-Amd64.exe`
	target := `D:\软件\数据库管理工具\GoNavi\GoNavi.exe`
	stagedDir := `C:\Users\tester\AppData\Local\Temp\gonavi-updates\.gonavi-update-windows-latest-0.8.5`
	logPath := filepath.Join(stagedDir, "gonavi-update-windows.log")

	script := buildWindowsPowerShellScript()
	for _, path := range []string{source, target, stagedDir, logPath} {
		if strings.Contains(script, path) {
			t.Fatalf("Windows PowerShell updater must not embed runtime path %q because legacy cmd.exe decoding would corrupt it\n%s", path, script)
		}
	}
	for _, r := range script {
		if r > 0x7f {
			t.Fatalf("Windows PowerShell updater must stay ASCII-only, found %q\n%s", r, script)
		}
	}
}

func TestBuildWindowsPowerShellScriptRelaunchesBeforeDeletingFallbacks(t *testing.T) {
	script := buildWindowsPowerShellScript()

	startIdx := strings.Index(script, `$NewProcess = Start-Process -FilePath $Target`)
	releaseIdx := strings.Index(script, `if (-not (Release-UpdateMaintenanceLock))`)
	deleteCurrentIdx := strings.Index(script, `Remove-UpdateArtifact $CurrentTarget`)
	deleteSourceIdx := strings.Index(script, `Remove-UpdateArtifact $Source`)
	if releaseIdx < 0 || startIdx < 0 || deleteCurrentIdx < 0 || deleteSourceIdx < 0 {
		t.Fatalf("expected maintenance release, relaunch and cleanup commands in script (release=%d start=%d current=%d source=%d)\n%s", releaseIdx, startIdx, deleteCurrentIdx, deleteSourceIdx, script)
	}
	if releaseIdx > startIdx {
		t.Fatalf("maintenance lock must be released immediately before relaunch (release=%d start=%d)\n%s", releaseIdx, startIdx, script)
	}
	if deleteCurrentIdx < startIdx || deleteSourceIdx < startIdx {
		t.Fatalf("fallback files must be deleted only after relaunch (start=%d current=%d source=%d)\n%s", startIdx, deleteCurrentIdx, deleteSourceIdx, script)
	}
}

func TestBuildWindowsLaunchCommandPreservesSpecialPathsInEnvironment(t *testing.T) {
	context := windowsUpdateLaunchContext{
		SourcePath:           `C:\Users\tester\AppData\Local\Temp\GoNavi %TEMP%\GoNavi-0.8.5-Windows-Amd64.exe`,
		TargetPath:           `D:\软件 ! 100% & (便携版)\O'Brien\GoNavi.exe`,
		CurrentTargetPath:    `D:\软件 ! 100% & (便携版)\O'Brien\GoNavi-dev-f930ffe.exe`,
		UpdatesDir:           `C:\Users\tester\AppData\Local\Temp\GoNavi %TEMP%\updates`,
		StagedDir:            `C:\Users\tester\AppData\Local\Temp\GoNavi %TEMP%\updates\0.8.5\stage`,
		LogPath:              `C:\Users\tester\AppData\Local\Temp\GoNavi %TEMP%\updates\0.8.5\stage\update.log`,
		MaintenanceEventName: `Global\GoNavi-Update-Test`,
		HandoffEventName:     `Local\GoNavi-Update-Handoff-Test`,
		PID:                  12345,
	}
	cmd := buildWindowsLaunchCommand(filepath.Join(context.StagedDir, "update.ps1"), context)

	wantEnvironment := map[string]string{
		"GONAVI_UPDATE_SOURCE":                 context.SourcePath,
		"GONAVI_UPDATE_TARGET":                 context.TargetPath,
		"GONAVI_UPDATE_CURRENT_TARGET":         context.CurrentTargetPath,
		"GONAVI_UPDATE_ROOT_DIR":               context.UpdatesDir,
		"GONAVI_UPDATE_STAGED_DIR":             context.StagedDir,
		"GONAVI_UPDATE_LOG_PATH":               context.LogPath,
		"GONAVI_UPDATE_MAINTENANCE_EVENT_NAME": context.MaintenanceEventName,
		"GONAVI_UPDATE_HANDOFF_EVENT_NAME":     context.HandoffEventName,
		"GONAVI_UPDATE_PID":                    "12345",
	}
	gotEnvironment := make(map[string]string, len(wantEnvironment))
	for _, item := range cmd.Env {
		name, value, ok := strings.Cut(item, "=")
		if !ok {
			continue
		}
		if _, exists := wantEnvironment[name]; exists {
			gotEnvironment[name] = value
		}
	}
	for name, want := range wantEnvironment {
		if got := gotEnvironment[name]; got != want {
			t.Fatalf("update environment %s = %q, want %q", name, got, want)
		}
	}
	if cmd.Dir != context.StagedDir {
		t.Fatalf("update command directory = %q, want %q", cmd.Dir, context.StagedDir)
	}
}
