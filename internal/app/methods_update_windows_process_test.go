//go:build windows

package app

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBuildWindowsLaunchCommandHidesConsoleWindow(t *testing.T) {
	cmd := buildWindowsLaunchCommand(
		`C:\tmp\gonavi-update\update.ps1`,
		windowsUpdateLaunchContext{StagedDir: `C:\tmp\gonavi-update`},
	)

	if cmd.SysProcAttr == nil {
		t.Fatalf("expected Windows update launcher to configure SysProcAttr")
	}
	if !cmd.SysProcAttr.HideWindow {
		t.Fatalf("expected Windows update launcher to hide the console window")
	}
	if cmd.SysProcAttr.CreationFlags&windowsCreateNoWindow == 0 {
		t.Fatalf("expected Windows update launcher to set CREATE_NO_WINDOW, flags=%#x", cmd.SysProcAttr.CreationFlags)
	}
}

func TestFindOtherWindowsUpdateInstancesMatchesExecutablePath(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable returned error: %v", err)
	}

	instances, err := findOtherWindowsUpdateInstances([]string{executable}, -1)
	if err != nil {
		t.Fatalf("findOtherWindowsUpdateInstances returned error: %v", err)
	}
	for _, instance := range instances {
		if instance.PID == uint32(os.Getpid()) {
			return
		}
	}
	t.Fatalf("expected current executable process %d to be detected, got %#v", os.Getpid(), instances)
}

func TestCloseWindowsUpdateInstancesTerminatesProcessesWithoutWindows(t *testing.T) {
	helperPath := filepath.Join(t.TempDir(), "GoNavi.exe")
	build := exec.Command("go", "build", "-ldflags=-H=windowsgui", "-o", helperPath, "./testdata/windows_update_helper")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build update helper: %v\n%s", err, output)
	}
	command := exec.Command(helperPath)
	if err := command.Start(); err != nil {
		t.Fatalf("start update helper: %v", err)
	}
	t.Cleanup(func() {
		if command.Process != nil {
			_ = command.Process.Kill()
		}
	})
	time.Sleep(150 * time.Millisecond)

	process := windowsUpdateProcess{PID: uint32(command.Process.Pid), Executable: helperPath}
	if err := closeWindowsUpdateInstances([]windowsUpdateProcess{process}); err != nil {
		t.Fatalf("closeWindowsUpdateInstances returned error: %v", err)
	}
	_ = command.Wait()
	instances, err := findOtherWindowsUpdateInstances([]string{helperPath}, -1)
	if err != nil {
		t.Fatalf("findOtherWindowsUpdateInstances after close: %v", err)
	}
	if len(instances) != 0 {
		t.Fatalf("helper still running after close: %#v", instances)
	}
}

func TestCloseWindowsUpdateInstancesRejectsChangedExecutableIdentity(t *testing.T) {
	helperPath := filepath.Join(t.TempDir(), "GoNavi.exe")
	build := exec.Command("go", "build", "-ldflags=-H=windowsgui", "-o", helperPath, "./testdata/windows_update_helper")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build update helper: %v\n%s", err, output)
	}
	command := exec.Command(helperPath)
	if err := command.Start(); err != nil {
		t.Fatalf("start update helper: %v", err)
	}
	t.Cleanup(func() {
		if command.Process != nil {
			_ = command.Process.Kill()
			_, _ = command.Process.Wait()
		}
	})
	time.Sleep(150 * time.Millisecond)

	staleIdentity := windowsUpdateProcess{
		PID:        uint32(command.Process.Pid),
		Executable: filepath.Join(filepath.Dir(helperPath), "Different.exe"),
	}
	err := closeWindowsUpdateInstances([]windowsUpdateProcess{staleIdentity})
	if err == nil || !strings.Contains(err.Error(), "executable changed") {
		t.Fatalf("identity mismatch error = %v, want executable changed", err)
	}
	instances, findErr := findOtherWindowsUpdateInstances([]string{helperPath}, -1)
	if findErr != nil {
		t.Fatalf("find helper after rejected close: %v", findErr)
	}
	if len(instances) != 1 || instances[0].PID != uint32(command.Process.Pid) {
		t.Fatalf("helper was not preserved after identity mismatch: %#v", instances)
	}
}

func TestInstallUpdateAndRestartClosesOtherTargetInstances(t *testing.T) {
	dir := t.TempDir()
	currentTarget := filepath.Join(dir, "GoNavi-dev-old-Windows-Amd64-Portable.exe")
	newTarget := filepath.Join(dir, "GoNavi-dev-new-Windows-Amd64-Portable.exe")
	if err := os.WriteFile(newTarget, []byte("12345678"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	app := NewApp()
	app.SetLanguage("en-US")
	app.updateState.staged = &stagedUpdate{
		Channel:      updateChannelDev,
		Version:      "dev-new",
		AssetName:    filepath.Base(newTarget),
		FilePath:     newTarget,
		StagedDir:    filepath.Join(dir, ".gonavi-update-windows-dev-new"),
		InstallMode:  updateInstallModePortable,
		PackageType:  updatePackageTypePortable,
		AutoRelaunch: true,
	}

	originalResolveInstallTarget := updateResolveInstallTarget
	originalFindOtherInstances := updateFindOtherWindowsInstances
	originalCloseInstances := updateCloseWindowsInstances
	originalAcquireMaintenance := updateAcquireWindowsMaintenance
	originalLaunchInstallScript := updateLaunchInstallScript
	originalQuitSleep := updateQuitSleep
	originalExitProcess := updateExitProcess
	t.Cleanup(func() {
		updateResolveInstallTarget = originalResolveInstallTarget
		updateFindOtherWindowsInstances = originalFindOtherInstances
		updateCloseWindowsInstances = originalCloseInstances
		updateAcquireWindowsMaintenance = originalAcquireMaintenance
		updateLaunchInstallScript = originalLaunchInstallScript
		updateQuitSleep = originalQuitSleep
		updateExitProcess = originalExitProcess
	})
	updateResolveInstallTarget = func() string { return currentTarget }
	maintenanceAcquired := false
	updateAcquireWindowsMaintenance = func(string) (windowsUpdateMaintenanceLease, error) {
		maintenanceAcquired = true
		return windowsUpdateMaintenanceLease{Name: `Global\GoNavi-Update-Test`}, nil
	}

	var checkedTargets []string
	findCalls := 0
	updateFindOtherWindowsInstances = func(targets []string, currentPID int) ([]windowsUpdateProcess, error) {
		if !maintenanceAcquired {
			t.Fatal("other instances must be discovered after acquiring update maintenance")
		}
		findCalls++
		checkedTargets = append([]string(nil), targets...)
		if currentPID != os.Getpid() {
			t.Fatalf("current PID = %d, want %d", currentPID, os.Getpid())
		}
		if findCalls <= 2 {
			return []windowsUpdateProcess{{PID: 4321, Executable: newTarget}}, nil
		}
		return nil, nil
	}
	closed := false
	updateCloseWindowsInstances = func(processes []windowsUpdateProcess) error {
		closed = len(processes) == 1 && processes[0].PID == 4321 && processes[0].Executable == newTarget
		return nil
	}
	launched := false
	updateLaunchInstallScript = func(*stagedUpdate) error {
		launched = true
		return nil
	}
	quitFinished := make(chan struct{}, 1)
	updateQuitSleep = func(time.Duration) {}
	updateExitProcess = func(int) { quitFinished <- struct{}{} }

	result := app.InstallUpdateAndRestart(true)
	if !result.Success {
		t.Fatalf("expected confirmed update to close other instances and launch, got %#v", result)
	}
	if !closed {
		t.Fatal("confirmed update did not close the discovered GoNavi instance")
	}
	if !launched {
		t.Fatal("update launcher did not start after other instances closed")
	}
	if len(checkedTargets) != 2 || checkedTargets[0] != currentTarget || checkedTargets[1] != newTarget {
		t.Fatalf("checked targets = %#v, want current and final target", checkedTargets)
	}
	if findCalls != 3 {
		t.Fatalf("find calls = %d, want preflight, close discovery, and post-close verification", findCalls)
	}
	select {
	case <-quitFinished:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for updater-controlled quit goroutine")
	}
}

func TestInstallUpdateAndRestartRequiresCloseConfirmationOnWindows(t *testing.T) {
	dir := t.TempDir()
	packagePath := filepath.Join(dir, "GoNavi-Installer.msi")
	if err := os.WriteFile(packagePath, []byte("fake msi"), 0o644); err != nil {
		t.Fatalf("WriteFile MSI: %v", err)
	}
	app := NewApp()
	app.SetLanguage("en-US")
	app.updateState.staged = &stagedUpdate{
		Version:        "1.2.3",
		AssetName:      filepath.Base(packagePath),
		FilePath:       packagePath,
		StagedDir:      dir,
		InstallMode:    updateInstallModeMSI,
		PackageType:    updatePackageTypeMSI,
		AutoRelaunch:   true,
		InstallLogPath: filepath.Join(dir, "update.log"),
	}

	originalResolveTarget := updateResolveInstallTarget
	originalResolveInstallMode := updateResolveInstallMode
	originalFindOtherInstances := updateFindOtherWindowsInstances
	originalAcquireMaintenance := updateAcquireWindowsMaintenance
	originalLaunch := updateLaunchInstallScript
	t.Cleanup(func() {
		updateResolveInstallTarget = originalResolveTarget
		updateResolveInstallMode = originalResolveInstallMode
		updateFindOtherWindowsInstances = originalFindOtherInstances
		updateAcquireWindowsMaintenance = originalAcquireMaintenance
		updateLaunchInstallScript = originalLaunch
	})
	updateResolveInstallTarget = func() string { return filepath.Join(dir, "GoNavi.exe") }
	updateResolveInstallMode = func() updateInstallMode { return updateInstallModeMSI }
	maintenanceAcquired := false
	updateAcquireWindowsMaintenance = func(string) (windowsUpdateMaintenanceLease, error) {
		maintenanceAcquired = true
		return windowsUpdateMaintenanceLease{Name: `Global\GoNavi-Update-Test`}, nil
	}
	findCalls := 0
	updateFindOtherWindowsInstances = func([]string, int) ([]windowsUpdateProcess, error) {
		if !maintenanceAcquired {
			t.Fatal("other instances must be discovered after acquiring update maintenance")
		}
		findCalls++
		return []windowsUpdateProcess{{PID: 4321, Executable: filepath.Join(dir, "GoNavi.exe")}}, nil
	}
	launched := false
	updateLaunchInstallScript = func(*stagedUpdate) error {
		launched = true
		return nil
	}

	result := app.InstallUpdateAndRestart(false)
	if result.Success {
		t.Fatalf("update without close confirmation unexpectedly succeeded: %#v", result)
	}
	if launched {
		t.Fatal("update launcher must not start before close-all confirmation")
	}
	data, ok := result.Data.(map[string]any)
	if !ok || data["requiresCloseConfirmation"] != true {
		t.Fatalf("close confirmation data = %#v, want requiresCloseConfirmation=true", result.Data)
	}
	if data["instanceCount"] != 1 {
		t.Fatalf("instanceCount = %#v, want 1", data["instanceCount"])
	}
	if runningPids, ok := data["runningPids"].([]uint32); !ok || len(runningPids) != 1 || runningPids[0] != 4321 {
		t.Fatalf("runningPids = %#v, want [4321]", data["runningPids"])
	}
	if findCalls != 1 {
		t.Fatalf("finder calls = %d, want 1", findCalls)
	}
}

func TestInstallUpdateAndRestartSkipsCloseConfirmationForSingleWindowsInstance(t *testing.T) {
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
	originalAcquireMaintenance := updateAcquireWindowsMaintenance
	originalLaunch := updateLaunchInstallScript
	originalQuitSleep := updateQuitSleep
	originalExitProcess := updateExitProcess
	t.Cleanup(func() {
		updateResolveInstallTarget = originalResolveTarget
		updateResolveInstallMode = originalResolveInstallMode
		updateFindOtherWindowsInstances = originalFindOtherInstances
		updateAcquireWindowsMaintenance = originalAcquireMaintenance
		updateLaunchInstallScript = originalLaunch
		updateQuitSleep = originalQuitSleep
		updateExitProcess = originalExitProcess
	})
	updateResolveInstallTarget = func() string { return filepath.Join(dir, "GoNavi.exe") }
	updateResolveInstallMode = func() updateInstallMode { return updateInstallModeMSI }
	maintenanceAcquired := false
	findCalls := 0
	updateFindOtherWindowsInstances = func([]string, int) ([]windowsUpdateProcess, error) {
		if !maintenanceAcquired {
			t.Fatal("other instances must be discovered after acquiring update maintenance")
		}
		findCalls++
		return nil, nil
	}
	updateAcquireWindowsMaintenance = func(string) (windowsUpdateMaintenanceLease, error) {
		maintenanceAcquired = true
		return windowsUpdateMaintenanceLease{Name: `Global\GoNavi-Update-Test`}, nil
	}
	launched := false
	updateLaunchInstallScript = func(*stagedUpdate) error {
		launched = true
		return nil
	}
	quitFinished := make(chan struct{}, 1)
	updateQuitSleep = func(time.Duration) {}
	updateExitProcess = func(int) { quitFinished <- struct{}{} }

	result := app.InstallUpdateAndRestart(false)
	if !result.Success {
		t.Fatalf("single-instance update should launch without confirmation, got %#v", result)
	}
	if findCalls != 1 {
		t.Fatalf("finder calls = %d, want 1", findCalls)
	}
	if !launched {
		t.Fatal("single-instance update did not launch")
	}
	select {
	case <-quitFinished:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for updater-controlled quit goroutine")
	}
}
