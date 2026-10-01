package app

import (
	"strings"
	"testing"
)

// Antivirus heuristic engines classify a script as a dropper by shape, not by
// behaviour: an obfuscated command, a disabled execution policy, a concealed
// window and a recursive self-delete together are the canonical combination,
// and a nested interpreter spawned from a script makes it worse. These scripts
// are embedded into the shipped executable, so every one of those tokens is
// readable as plain text by a scanner walking the binary, which is why a
// release build was quarantined as HEUR:Trojan.PowerShell.Generic. Keep the
// updater scripts clear of that shape.
func TestWindowsUpdaterScriptsAvoidDropperHeuristics(t *testing.T) {
	scripts := []struct {
		name   string
		script string
	}{
		{name: "windows_update.ps1", script: buildWindowsPowerShellScript()},
		{name: "windows_msi_update.ps1", script: buildWindowsMSIUpdatePowerShellScript()},
		{name: "windows_shortcut_repair.ps1", script: windowsShortcutRepairPowerShellScript},
	}

	forbiddenTokens := []string{
		"EncodedCommand",
		"ToBase64String",
		"FromBase64String",
		"-ExecutionPolicy Bypass",
		"'Bypass'",
		"-WindowStyle",
		"Invoke-Expression",
		"DownloadString",
		"Start-Process -FilePath 'powershell",
		`Start-Process -FilePath "powershell`,
	}

	for _, script := range scripts {
		for _, token := range forbiddenTokens {
			if strings.Contains(script.script, token) {
				t.Errorf("%s must not contain dropper-shaped token %q", script.name, token)
			}
		}
	}
}

// The staging tree cannot be removed while it is this process's current
// directory, so the updater has to relocate before deleting. Releasing the
// handle takes both halves: Set-Location moves the PowerShell provider
// location, and resetting Environment.CurrentDirectory moves the Win32 current
// directory that actually keeps the tree locked. Doing that in the same process
// is what keeps a second interpreter from being spawned.
func TestWindowsUpdaterScriptsRelocateBeforeDeletingStagingTree(t *testing.T) {
	scripts := []struct {
		name   string
		script string
	}{
		{name: "windows_update.ps1", script: buildWindowsPowerShellScript()},
		{name: "windows_msi_update.ps1", script: buildWindowsMSIUpdatePowerShellScript()},
	}

	orderedTokens := []string{
		`Set-Location -LiteralPath $CleanupWorkingDirectory -ErrorAction Stop`,
		`[System.Environment]::CurrentDirectory = $CleanupWorkingDirectory`,
		`Remove-Item -LiteralPath $env:GONAVI_UPDATE_ROOT_DIR -Recurse -Force`,
	}

	for _, script := range scripts {
		previous := -1
		for _, token := range orderedTokens {
			index := strings.Index(script.script, token)
			if index < 0 {
				t.Errorf("%s must contain %q", script.name, token)
				continue
			}
			if index < previous {
				t.Errorf("%s must reset the Win32 current directory before deleting the staging tree (index=%d previous=%d)", script.name, index, previous)
			}
			previous = index
		}
	}
}
