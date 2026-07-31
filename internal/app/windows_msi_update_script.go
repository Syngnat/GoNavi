package app

import (
	_ "embed"
	"os/exec"
	"strconv"
	"strings"
)

//go:embed windows_msi_update.ps1
var windowsMSIUpdatePowerShellScript string

//go:embed windows_shortcut_repair.ps1
var windowsShortcutRepairPowerShellScript string

type windowsMSIUpdateLaunchContext struct {
	SourcePath           string
	TargetPath           string
	UpdatesDir           string
	StagedDir            string
	LogPath              string
	MSILogPath           string
	MSIExecPath          string
	MaintenanceEventName string
	HandoffEventName     string
	PID                  int
}

func buildWindowsMSIUpdatePowerShellScript() string {
	script := windowsShortcutRepairPowerShellScript + "\n\n" + windowsMSIUpdatePowerShellScript
	normalized := strings.ReplaceAll(script, "\r\n", "\n")
	return strings.ReplaceAll(normalized, "\n", "\r\n")
}

func buildWindowsMSILaunchCommand(scriptPath string, context windowsMSIUpdateLaunchContext) *exec.Cmd {
	cmd := exec.Command(
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		windowsUpdatePowerShellExecutionPolicy,
		"-File",
		scriptPath,
	)
	cmd.Dir = context.StagedDir
	cmd.Env = append(cmd.Environ(),
		"GONAVI_UPDATE_SOURCE="+context.SourcePath,
		"GONAVI_UPDATE_TARGET="+context.TargetPath,
		"GONAVI_UPDATE_ROOT_DIR="+context.UpdatesDir,
		"GONAVI_UPDATE_STAGED_DIR="+context.StagedDir,
		"GONAVI_UPDATE_LOG_PATH="+context.LogPath,
		"GONAVI_UPDATE_MSI_LOG_PATH="+context.MSILogPath,
		"GONAVI_UPDATE_MSIEXEC_PATH="+context.MSIExecPath,
		"GONAVI_UPDATE_MAINTENANCE_EVENT_NAME="+context.MaintenanceEventName,
		"GONAVI_UPDATE_HANDOFF_EVENT_NAME="+context.HandoffEventName,
		"GONAVI_UPDATE_PID="+strconv.Itoa(context.PID),
	)
	configureWindowsUpdateCommand(cmd)
	return cmd
}
