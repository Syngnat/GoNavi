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
	cleanupIndex := strings.Index(script, `$CleanupCommand = 'Start-Sleep -Seconds 2; Remove-Item -LiteralPath $env:GONAVI_UPDATE_ROOT_DIR`)
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
