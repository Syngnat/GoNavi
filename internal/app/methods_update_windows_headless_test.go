//go:build windows

package app

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// 只有无头后台进程（运行时清理进程、MCP 服务）时不弹确认：它们没有未保存内容，直接关闭后继续安装。
func TestInstallUpdateAndRestartClosesHeadlessInstancesWithoutConfirmation(t *testing.T) {
	dir := t.TempDir()
	packagePath := filepath.Join(dir, "GoNavi-Installer.msi")
	if err := os.WriteFile(packagePath, []byte("fake msi"), 0o644); err != nil {
		t.Fatalf("WriteFile MSI: %v", err)
	}
	app := NewApp()
	app.SetLanguage("en-US")
	app.updateState.staged = &stagedUpdate{
		Version:      "1.2.3",
		AssetName:    filepath.Base(packagePath),
		FilePath:     packagePath,
		StagedDir:    dir,
		InstallMode:  updateInstallModeMSI,
		PackageType:  updatePackageTypeMSI,
		AutoRelaunch: true,
	}

	originalResolveTarget := updateResolveInstallTarget
	originalResolveInstallMode := updateResolveInstallMode
	originalFindOtherInstances := updateFindOtherWindowsInstances
	originalCloseInstances := updateCloseWindowsInstances
	originalAcquireMaintenance := updateAcquireWindowsMaintenance
	originalLaunch := updateLaunchInstallScript
	originalQuitSleep := updateQuitSleep
	originalExitProcess := updateExitProcess
	t.Cleanup(func() {
		updateResolveInstallTarget = originalResolveTarget
		updateResolveInstallMode = originalResolveInstallMode
		updateFindOtherWindowsInstances = originalFindOtherInstances
		updateCloseWindowsInstances = originalCloseInstances
		updateAcquireWindowsMaintenance = originalAcquireMaintenance
		updateLaunchInstallScript = originalLaunch
		updateQuitSleep = originalQuitSleep
		updateExitProcess = originalExitProcess
	})
	target := filepath.Join(dir, "GoNavi.exe")
	updateResolveInstallTarget = func() string { return target }
	updateResolveInstallMode = func() updateInstallMode { return updateInstallModeMSI }
	updateAcquireWindowsMaintenance = func(string) (windowsUpdateMaintenanceLease, error) {
		return windowsUpdateMaintenanceLease{Name: `Global\GoNavi-Update-Test`}, nil
	}
	headless := []windowsUpdateProcess{{PID: 5001, Executable: target}, {PID: 5002, Executable: target}}
	closed := false
	updateFindOtherWindowsInstances = func([]string, int) ([]windowsUpdateProcess, error) {
		if closed {
			return nil, nil
		}
		return headless, nil
	}
	var closedPIDs []uint32
	updateCloseWindowsInstances = func(processes []windowsUpdateProcess) error {
		closedPIDs = otherWindowsUpdateProcessIDs(processes)
		closed = true
		return nil
	}
	launched := false
	updateLaunchInstallScript = func(*stagedUpdate) error {
		if !closed {
			t.Fatal("headless instances must be closed before the installer starts")
		}
		launched = true
		return nil
	}
	quitFinished := make(chan struct{}, 1)
	updateQuitSleep = func(time.Duration) {}
	updateExitProcess = func(int) { quitFinished <- struct{}{} }

	result := app.InstallUpdateAndRestart(false)
	if !result.Success {
		t.Fatalf("headless-only update should launch without confirmation, got %#v", result)
	}
	if len(closedPIDs) != 2 || closedPIDs[0] != 5001 || closedPIDs[1] != 5002 {
		t.Fatalf("closed PIDs = %v, want the two headless instances", closedPIDs)
	}
	if !launched {
		t.Fatal("update launcher did not start after closing headless instances")
	}
	select {
	case <-quitFinished:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for updater-controlled quit goroutine")
	}
}

// 真实枚举：带主窗口的替身进程标记为有界面，无头替身不标记。
func TestFindOtherWindowsUpdateInstancesMarksInteractiveInstances(t *testing.T) {
	helperPath := buildWindowsUpdateHelper(t)
	windowed := startWindowsUpdateHelper(t, helperPath, "window")
	headless := startWindowsUpdateHelper(t, helperPath)
	waitForWindowsApplicationWindow(t, windowed.PID)

	instances, err := findOtherWindowsUpdateInstances([]string{helperPath}, -1)
	if err != nil {
		t.Fatalf("findOtherWindowsUpdateInstances returned error: %v", err)
	}
	interactiveByPID := make(map[uint32]bool, len(instances))
	for _, instance := range instances {
		interactiveByPID[instance.PID] = instance.Interactive
	}
	if len(instances) != 2 || !interactiveByPID[windowed.PID] || interactiveByPID[headless.PID] {
		t.Fatalf("instances = %#v, want windowed %d interactive and headless %d not", instances, windowed.PID, headless.PID)
	}
	if got := interactiveWindowsUpdateProcesses(instances); len(got) != 1 || got[0].PID != windowed.PID {
		t.Fatalf("interactive instances = %#v, want only %d", got, windowed.PID)
	}
}
