package app

import (
	"strings"
	"testing"
)

func TestBuildWindowsPowerShellScriptUsesLiteralPathOperations(t *testing.T) {
	script := buildWindowsPowerShellScript()

	mustContain := []string{
		`$Source = $env:GONAVI_UPDATE_SOURCE`,
		`$Target = $env:GONAVI_UPDATE_TARGET`,
		`Test-Path -LiteralPath $Source -PathType Leaf`,
		`Expand-Archive -LiteralPath $Source -DestinationPath $ExtractDir -Force`,
		`Move-Item -LiteralPath $Target -Destination $TargetOld -Force`,
		`Copy-Item -LiteralPath $SourceExe -Destination $Target -Force`,
		`Start-Process -FilePath $Target -WorkingDirectory $TargetDir`,
	}
	for _, want := range mustContain {
		if !strings.Contains(script, want) {
			t.Fatalf("Windows PowerShell updater missing required token: %s\n%s", want, script)
		}
	}
}

func TestBuildWindowsPowerShellScriptWaitsRetriesAndRollsBack(t *testing.T) {
	script := buildWindowsPowerShellScript()

	mustContain := []string{
		`while (Get-Process -Id $HostProcessId -ErrorAction SilentlyContinue)`,
		`$waitedSeconds -ge 90`,
		`Start-Sleep -Seconds 3`,
		`for ($attempt = 0; $attempt -lt 15; $attempt++)`,
		`if ($PreviousTargetBackedUp -or $TargetWriteStarted)`,
		`previous executable backup is missing`,
		`Restore-PreviousTarget`,
		`if ($NewProcess.HasExited)`,
		`function Release-UpdateMaintenanceLock`,
		`[Threading.EventWaitHandle]::OpenExisting($MaintenanceEventName)`,
		`[void]$HandoffEvent.Set()`,
		`update maintenance lock could not be released before relaunch`,
		`package kept for manual install`,
		`previous application relaunched after update failure`,
	}
	for _, want := range mustContain {
		if !strings.Contains(script, want) {
			t.Fatalf("Windows PowerShell updater missing reliability token: %s\n%s", want, script)
		}
	}
}

func TestBuildWindowsPowerShellScriptSelectsPortableExecutableByStrictPriority(t *testing.T) {
	script := buildWindowsPowerShellScript()

	priorityTokens := []string{
		`$TargetFileName = [IO.Path]::GetFileName($TargetPath)`,
		`$ExactTargetMatches = @($ExecutableCandidates | Where-Object`,
		`$PackageExecutableName = [IO.Path]::GetFileNameWithoutExtension($PackagePath) + '.exe'`,
		`$PackageNameMatches = @($ExecutableCandidates | Where-Object`,
		`$GoNaviMatches = @($ExecutableCandidates | Where-Object`,
		`if ($ExecutableCandidates.Count -eq 1)`,
		`throw ("ambiguous portable zip: found "`,
	}
	lastIndex := -1
	for _, token := range priorityTokens {
		index := strings.Index(script, token)
		if index < 0 {
			t.Fatalf("Windows PowerShell updater missing strict ZIP selection token %q\n%s", token, script)
		}
		if index <= lastIndex {
			t.Fatalf("Windows PowerShell ZIP selection token %q is out of priority order\n%s", token, script)
		}
		lastIndex = index
	}
	if strings.Contains(script, `Select-Object -First 1`) {
		t.Fatalf("Windows PowerShell updater must not choose an arbitrary executable from a ZIP\n%s", script)
	}
	if !strings.Contains(script, `package retained for manual install`) {
		t.Fatalf("ambiguous ZIP failure must explain that the package is retained\n%s", script)
	}
}

func TestBuildWindowsPowerShellScriptUsesCRLFLineEndings(t *testing.T) {
	script := buildWindowsPowerShellScript()
	if !strings.Contains(script, "\r\n") {
		t.Fatal("Windows PowerShell updater should use CRLF line endings")
	}
	if strings.Contains(script, "$ErrorActionPreference = 'Stop'\n\n") {
		t.Fatal("Windows PowerShell updater should not contain LF-only line endings")
	}
}

func TestBuildWindowsPowerShellScriptAvoidsCmdParsing(t *testing.T) {
	script := buildWindowsPowerShellScript()
	for _, bad := range []string{
		`cmd.exe`,
		`EnableDelayedExpansion`,
		`__GONAVI_UPDATE_`,
		`-FilePath '%TARGET%'`,
	} {
		if strings.Contains(script, bad) {
			t.Fatalf("Windows PowerShell updater must not contain legacy cmd token %q\n%s", bad, script)
		}
	}
	for _, r := range script {
		if r > 0x7f {
			t.Fatalf("Windows PowerShell updater must remain ASCII-only, found %q", r)
		}
	}
}

func TestBuildWindowsLaunchCommandUsesHiddenPowerShellFile(t *testing.T) {
	context := windowsUpdateLaunchContext{
		SourcePath:           `C:\tmp\GoNavi-0.8.5-Windows-Amd64.exe`,
		TargetPath:           `C:\GoNavi\GoNavi.exe`,
		CurrentTargetPath:    `C:\GoNavi\GoNavi.exe`,
		UpdatesDir:           `C:\tmp\gonavi-update`,
		StagedDir:            `C:\tmp\gonavi-update`,
		LogPath:              `C:\tmp\gonavi-update\update.log`,
		MaintenanceEventName: `Global\GoNavi-Update-Test`,
		HandoffEventName:     `Local\GoNavi-Update-Handoff-Test`,
		PID:                  12345,
	}
	scriptPath := `C:\tmp\gonavi-update\update.ps1`
	cmd := buildWindowsLaunchCommand(scriptPath, context)

	want := []string{
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		"RemoteSigned",
		"-File",
		scriptPath,
	}
	if len(cmd.Args) != len(want) {
		t.Fatalf("unexpected arg length: got %d want %d, args=%v", len(cmd.Args), len(want), cmd.Args)
	}
	for i := range want {
		if cmd.Args[i] != want[i] {
			t.Fatalf("unexpected arg[%d]: got %q want %q", i, cmd.Args[i], want[i])
		}
	}
}
