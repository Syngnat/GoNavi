package app

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildWindowsMSIUpdatePowerShellScriptInstallsRelaunchesAndCleans(t *testing.T) {
	script := buildWindowsMSIUpdatePowerShellScript()
	mustContain := []string{
		`function Save-GoNaviDesktopShortcutState`,
		`function Remove-GoNaviDesktopShortcutsForTarget`,
		`function Restore-GoNaviDesktopShortcutState`,
		`function Send-ShellItemUpdatedNotification`,
		`SHChangeNotify`,
		`function Repair-LegacyGoNaviTaskbarPins`,
		`while (Get-Process -Id $HostProcessId -ErrorAction SilentlyContinue)`,
		`$DesktopShortcutState = Save-GoNaviDesktopShortcutState -TargetPath $Target -BackupDirectory $StagedDir`,
		`if (-not $DesktopShortcutState.Succeeded)`,
		`$DesktopShortcutInstallValue = $DesktopShortcutState.InstallValue`,
		`Start-Process -FilePath $MSIExecPath -Verb RunAs`,
		`'INSTALLFOLDER=' + (Quote-NativeArgument $TargetDir)`,
		`'INSTALLDESKTOPSHORTCUT=' + $DesktopShortcutInstallValue`,
		`'/passive'`,
		`'/norestart'`,
		`'/L*v'`,
		`$InstallerExitCode -notin @(0, 1641, 3010)`,
		`if (-not (Restore-GoNaviDesktopShortcutState -State $DesktopShortcutState -OnlyForeign))`,
		`Repair-LegacyGoNaviTaskbarPins -TargetPath $Target`,
		`function Release-UpdateMaintenanceLock`,
		`[Threading.EventWaitHandle]::OpenExisting($MaintenanceEventName)`,
		`[void]$HandoffEvent.Set()`,
		`update maintenance lock could not be released before relaunch`,
		`Start-Process -FilePath $Target -WorkingDirectory $TargetDir`,
		`Remove-UpdateArtifact $Source`,
		`Remove-Item -LiteralPath $env:GONAVI_UPDATE_ROOT_DIR`,
		`MSI package retained for manual install`,
		`previous application relaunched after MSI failure`,
	}
	for _, token := range mustContain {
		if !strings.Contains(script, token) {
			t.Fatalf("MSI updater missing %q\n%s", token, script)
		}
	}
	if strings.Index(script, `Remove-UpdateArtifact $Source`) < strings.Index(script, `Start-Process -FilePath $Target -WorkingDirectory $TargetDir`) {
		t.Fatalf("MSI package must be removed only after relaunch\n%s", script)
	}
	desktopStateIndex := strings.Index(script, `$DesktopShortcutState = Save-GoNaviDesktopShortcutState -TargetPath $Target -BackupDirectory $StagedDir`)
	installerIndex := strings.Index(script, `Start-Process -FilePath $MSIExecPath -Verb RunAs`)
	if desktopStateIndex < 0 || desktopStateIndex > installerIndex {
		t.Fatalf("desktop shortcut state must be captured before MSI starts\n%s", script)
	}
	repairIndex := strings.Index(script, `Repair-LegacyGoNaviTaskbarPins -TargetPath $Target`)
	releaseIndex := strings.Index(script, `if (-not (Release-UpdateMaintenanceLock))`)
	relaunchIndex := strings.Index(script, `Start-Process -FilePath $Target -WorkingDirectory $TargetDir`)
	if repairIndex < installerIndex || repairIndex > relaunchIndex {
		t.Fatalf("legacy taskbar pins must be repaired after install and before relaunch\n%s", script)
	}
	if releaseIndex < repairIndex || releaseIndex > relaunchIndex {
		t.Fatalf("maintenance lock must be released after install repair and before relaunch\n%s", script)
	}
	cleanupIndex := strings.Index(script, `Remove-Item -LiteralPath $env:GONAVI_UPDATE_ROOT_DIR -Recurse -Force -ErrorAction SilentlyContinue`)
	failureIndex := strings.LastIndex(script, `} catch {`)
	if cleanupIndex < relaunchIndex || failureIndex < cleanupIndex {
		t.Fatalf("MSI updates cleanup must be scheduled only after relaunch on the success path\n%s", script)
	}
	for _, r := range script {
		if r > 0x7f {
			t.Fatalf("MSI updater must remain ASCII-only, found %q", r)
		}
	}
}

func TestWindowsShortcutBrandIconDoesNotWriteUnsupportedWScriptAUMID(t *testing.T) {
	script := windowsShortcutRepairPowerShellScript
	if strings.Contains(script, `$shortcut.AppUserModelID`) {
		t.Fatalf("WScript.Shell shortcuts do not support AppUserModelID; the icon save would be skipped:\n%s", script)
	}
	iconLocationIndex := strings.Index(script, `$shortcut.IconLocation = $wantedIconLocation`)
	if iconLocationIndex < 0 || !strings.Contains(script[iconLocationIndex:], `$shortcut.Save()`) {
		t.Fatalf("brand icon updates must save IconLocation changes:\n%s", script)
	}
	for _, token := range []string{
		`function Set-GoNaviShortcutRelaunchProperties`,
		`GoNaviShortcutPropertyStore`,
		`SetRelaunchProperties`,
		`$isTaskbarShortcut`,
		// Legacy pins repaired by the dedicated MSI pass go through $pin.FullName.
		`Set-GoNaviShortcutRelaunchProperties -ShortcutPath $pin.FullName`,
		`$useTaskbarPropertyStore`,
		`repaired legacy taskbar pin properties`,
		// The single-pass loop writes the relaunch identity to a pin only when
		// ownership evidence (matching target, MSI install, or GoNavi identity)
		// exists; a portable build must never rewrite a foreign pin identity.
		`if ($shouldWriteIdentity -and -not (Set-GoNaviShortcutRelaunchProperties`,
		// A single failing shortcut is logged and isolated, never aborts the batch.
		`continue`,
	} {
		if !strings.Contains(script, token) {
			t.Fatalf("taskbar pin migration missing %q:\n%s", token, script)
		}
	}
	// Empirically verified on Windows 11 (build 26200) by writing known probe
	// values and reading them back through System.AppUserModel.*: within this
	// property set pid 3 is RelaunchIconResource and pid 4 is
	// RelaunchDisplayNameResource. The icon path must land on pid 3 and the
	// display name on pid 4, with the ID (pid 5) written last because Windows
	// uses that write to notify the taskbar about relaunch changes.
	pid2 := strings.Index(script, `new PROPERTYKEY(PKEY_AppUserModel, 2), "\"" + targetPath + "\"")`)
	pid3 := strings.Index(script, `new PROPERTYKEY(PKEY_AppUserModel, 3), iconPath)`)
	pid4 := strings.Index(script, `new PROPERTYKEY(PKEY_AppUserModel, 4), "GoNavi")`)
	pid5 := strings.Index(script, `new PROPERTYKEY(PKEY_AppUserModel, 5), applicationUserModelID)`)
	if pid2 < 0 || pid3 < 0 || pid4 < 0 || pid5 < 0 {
		t.Fatalf("relaunch property writes missing:\n%s", script)
	}
	if !(pid2 < pid3 && pid3 < pid4 && pid4 < pid5) {
		t.Fatalf("relaunch properties must be written before AppUserModel.ID:\n%s", script)
	}
	// The property store helper has exactly five legitimate call sites: the
	// legacy pin repair pass, the AUMID shortcut creation, the guarded taskbar
	// branch of the single-pass loop, the non-taskbar identity restore after a
	// shortcut write (WScript.Shell.Save drops the AppUserModel property bag),
	// and the user desktop shortcut created when a machine desktop shortcut is
	// migrated. Any new call site must be reviewed for ownership gates before
	// this count is raised.
	if got := strings.Count(script, `Set-GoNaviShortcutRelaunchProperties -ShortcutPath`); got != 5 {
		t.Fatalf("unexpected relaunch property call site count %d:\n%s", got, script)
	}
	// The Start menu never re-reads an in-place IconLocation rewrite (observed
	// on Windows 11 26200), so non-taskbar shortcuts must be replaced by a new
	// file - the same mechanism that makes an MSI install refresh the Start
	// menu icon. Machine-level shortcuts cannot be replaced (their directories
	// deny CreateFiles to standard users), so they are migrated: deleted, and
	// the desktop entry is recreated at user level.
	for _, token := range []string{
		`$replacement.Save()`,
		`Move-Item -LiteralPath $replacementPath -Destination $shortcutFile.FullName -Force`,
		`shortcut replacement failed, falling back to in-place save`,
		`shortcut identity restore failed`,
		`migrated machine shortcut to user scope`,
		`machine shortcut migration delete failed`,
		`$script:GoNaviMigratedCommonDesktop`,
		`created user desktop shortcut after machine shortcut migration`,
	} {
		if !strings.Contains(script, token) {
			t.Fatalf("start menu shortcut replacement missing %q:\n%s", token, script)
		}
	}
	// The Start menu ignores per-item notifications for rewritten .lnk files
	// (observed on Windows 11 26200), so every shortcut update must also send
	// a folder-level UPDATEDIR and the notification type must expose it.
	for _, token := range []string{
		`function Send-ShellDirectoryUpdatedNotification`,
		`NotifyDirectoryUpdated`,
		`Send-ShellDirectoryUpdatedNotification ([IO.Path]::GetDirectoryName($shortcutFile.FullName))`,
		`Send-ShellDirectoryUpdatedNotification ([IO.Path]::GetDirectoryName($ShortcutPath))`,
	} {
		if !strings.Contains(script, token) {
			t.Fatalf("start menu folder refresh missing %q:\n%s", token, script)
		}
	}
	// Windows PowerShell 5.1 only allows Split-Path -LiteralPath together with
	// -Resolve; -Parent/-Leaf/-Qualifier throw AmbiguousParameterSet at runtime
	// (silently swallowed by catch blocks). The script must keep using
	// System.IO.Path helpers for literal paths.
	for _, token := range []string{
		`Split-Path -LiteralPath $ShortcutPath -Parent`,
		`Split-Path -LiteralPath $ShortcutPath -Leaf`,
		`Split-Path -LiteralPath $shortcutFile.FullName`,
	} {
		if strings.Contains(script, token) {
			t.Fatalf("PowerShell 5.1-incompatible Split-Path usage found %q:\n%s", token, script)
		}
	}
}

func TestBuildWindowsMSILaunchCommandPreservesPathsInEnvironment(t *testing.T) {
	context := windowsMSIUpdateLaunchContext{
		SourcePath:           `C:\Users\tester\AppData\Local\GoNavi 100%\GoNavi-Installer.msi`,
		TargetPath:           `D:\software ! 100% & portable\GoNavi.exe`,
		UpdatesDir:           `C:\Users\tester\AppData\Local\GoNavi 100%\updates`,
		StagedDir:            `C:\Users\tester\AppData\Local\GoNavi 100%\updates\1.2.3\stage`,
		LogPath:              `C:\Users\tester\AppData\Local\GoNavi 100%\updates\1.2.3\stage\update.log`,
		MSILogPath:           `C:\Users\tester\AppData\Local\GoNavi 100%\updates\1.2.3\stage\msi.log`,
		MSIExecPath:          `C:\Windows\System32\msiexec.exe`,
		MaintenanceEventName: `Global\GoNavi-Update-Test`,
		HandoffEventName:     `Local\GoNavi-Update-Handoff-Test`,
		PID:                  12345,
	}
	cmd := buildWindowsMSILaunchCommand(filepath.Join(context.StagedDir, "update-msi.ps1"), context)
	wantArgs := []string{
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		"RemoteSigned",
		"-File",
		filepath.Join(context.StagedDir, "update-msi.ps1"),
	}
	if len(cmd.Args) != len(wantArgs) {
		t.Fatalf("unexpected arg length: got %d want %d, args=%v", len(cmd.Args), len(wantArgs), cmd.Args)
	}
	for index := range wantArgs {
		if cmd.Args[index] != wantArgs[index] {
			t.Fatalf("unexpected arg[%d]: got %q want %q", index, cmd.Args[index], wantArgs[index])
		}
	}
	want := map[string]string{
		"GONAVI_UPDATE_SOURCE":                 context.SourcePath,
		"GONAVI_UPDATE_TARGET":                 context.TargetPath,
		"GONAVI_UPDATE_ROOT_DIR":               context.UpdatesDir,
		"GONAVI_UPDATE_STAGED_DIR":             context.StagedDir,
		"GONAVI_UPDATE_LOG_PATH":               context.LogPath,
		"GONAVI_UPDATE_MSI_LOG_PATH":           context.MSILogPath,
		"GONAVI_UPDATE_MSIEXEC_PATH":           context.MSIExecPath,
		"GONAVI_UPDATE_MAINTENANCE_EVENT_NAME": context.MaintenanceEventName,
		"GONAVI_UPDATE_HANDOFF_EVENT_NAME":     context.HandoffEventName,
		"GONAVI_UPDATE_PID":                    "12345",
	}
	got := make(map[string]string, len(want))
	for _, item := range cmd.Env {
		name, value, ok := strings.Cut(item, "=")
		if ok {
			if _, exists := want[name]; exists {
				got[name] = value
			}
		}
	}
	for name, value := range want {
		if got[name] != value {
			t.Fatalf("environment %s = %q, want %q", name, got[name], value)
		}
	}
}

func TestResolveWindowsMSIExecPathPrefersExplicitOverride(t *testing.T) {
	values := map[string]string{
		"GONAVI_UPDATE_MSIEXEC_PATH": `D:\\tools\\fake-msiexec.exe`,
		"SystemRoot":                 `C:\\Windows`,
	}
	got := resolveWindowsMSIExecPath(func(name string) string { return values[name] })
	if got != values["GONAVI_UPDATE_MSIEXEC_PATH"] {
		t.Fatalf("msiexec path = %q, want override %q", got, values["GONAVI_UPDATE_MSIEXEC_PATH"])
	}
	delete(values, "GONAVI_UPDATE_MSIEXEC_PATH")
	wantSystem := filepath.Join(values["SystemRoot"], "System32", "msiexec.exe")
	if got := resolveWindowsMSIExecPath(func(name string) string { return values[name] }); got != wantSystem {
		t.Fatalf("msiexec path = %q, want SystemRoot path %q", got, wantSystem)
	}
}
