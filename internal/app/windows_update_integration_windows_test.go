//go:build windows

package app

import (
	"archive/zip"
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWindowsPowerShellUpdaterHandlesUnicodeAndShellMetacharacters(t *testing.T) {
	root := t.TempDir()
	installDir := filepath.Join(root, `软件 ! 100% & (便携版)`, `O'Brien`)
	stagedDir := filepath.Join(root, `literal-%TEMP%-stage`)
	if err := os.MkdirAll(installDir, 0o755); err != nil {
		t.Fatalf("MkdirAll install dir: %v", err)
	}
	if err := os.MkdirAll(stagedDir, 0o755); err != nil {
		t.Fatalf("MkdirAll staged dir: %v", err)
	}

	sourcePath := filepath.Join(stagedDir, "GoNavi-0.8.5-Windows-Amd64.exe")
	build := exec.Command("go", "build", "-ldflags=-H=windowsgui", "-o", sourcePath, "./testdata/windows_update_helper")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build update helper: %v\n%s", err, output)
	}
	sourceData, err := os.ReadFile(sourcePath)
	if err != nil {
		t.Fatalf("ReadFile source: %v", err)
	}
	wantHash := sha256.Sum256(sourceData)

	targetPath := filepath.Join(installDir, "GoNavi.exe")
	if err := os.WriteFile(targetPath, []byte("old executable"), 0o755); err != nil {
		t.Fatalf("WriteFile old target: %v", err)
	}
	logPath := filepath.Join(stagedDir, "gonavi-update-windows-test.log")
	scriptPath := filepath.Join(stagedDir, "update.ps1")
	if err := os.WriteFile(scriptPath, []byte(buildWindowsPowerShellScript()), 0o644); err != nil {
		t.Fatalf("WriteFile updater: %v", err)
	}
	maintenanceName, handoffName := prepareWindowsUpdateIntegrationEvents(t)

	context := windowsUpdateLaunchContext{
		SourcePath:           sourcePath,
		TargetPath:           targetPath,
		CurrentTargetPath:    targetPath,
		UpdatesDir:           stagedDir,
		StagedDir:            stagedDir,
		LogPath:              logPath,
		MaintenanceEventName: maintenanceName,
		HandoffEventName:     handoffName,
		PID:                  2147483647,
	}
	cmd := buildWindowsLaunchCommand(scriptPath, context)
	if output, err := cmd.CombinedOutput(); err != nil {
		logData, _ := os.ReadFile(logPath)
		t.Fatalf("run updater: %v\nstdout/stderr:\n%s\nlog:\n%s", err, output, logData)
	}

	// The helper remains alive long enough for the updater's launch health check.
	// Wait for it to exit before the test temp directory is removed on Windows.
	time.Sleep(7 * time.Second)
	targetData, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatalf("ReadFile updated target: %v", err)
	}
	if gotHash := sha256.Sum256(targetData); gotHash != wantHash {
		t.Fatalf("updated target hash = %x, want %x", gotHash, wantHash)
	}
	if _, err := os.Stat(targetPath + ".old"); !os.IsNotExist(err) {
		t.Fatalf("expected rollback executable to be cleaned, stat err=%v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		_, err := os.Stat(stagedDir)
		if os.IsNotExist(err) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("staged directory was not cleaned: %s", stagedDir)
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Logf("updated target at %s (%s)", targetPath, fmt.Sprintf("%x", wantHash[:8]))
}

func TestWindowsPowerShellUpdaterRenamesVersionedPortableExecutable(t *testing.T) {
	root := t.TempDir()
	installDir := filepath.Join(root, "install")
	stagedDir := filepath.Join(root, "stage")
	for _, dir := range []string{installDir, stagedDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("MkdirAll %q: %v", dir, err)
		}
	}

	sourcePath := filepath.Join(stagedDir, "GoNavi-dev-new-Windows-Amd64-Portable.exe")
	build := exec.Command("go", "build", "-ldflags=-H=windowsgui", "-o", sourcePath, "./testdata/windows_update_helper")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build update helper: %v\n%s", err, output)
	}
	sourceData, err := os.ReadFile(sourcePath)
	if err != nil {
		t.Fatalf("ReadFile source: %v", err)
	}
	wantHash := sha256.Sum256(sourceData)

	currentTargetPath := filepath.Join(installDir, "GoNavi-dev-old-Windows-Amd64.exe")
	targetPath := filepath.Join(installDir, "GoNavi-dev-new-Windows-Amd64-Portable.exe")
	if err := os.WriteFile(currentTargetPath, []byte("old executable"), 0o755); err != nil {
		t.Fatalf("WriteFile old target: %v", err)
	}
	logPath := filepath.Join(stagedDir, "gonavi-update-windows-versioned.log")
	scriptPath := filepath.Join(stagedDir, "update.ps1")
	if err := os.WriteFile(scriptPath, []byte(buildWindowsPowerShellScript()), 0o644); err != nil {
		t.Fatalf("WriteFile updater: %v", err)
	}
	maintenanceName, handoffName := prepareWindowsUpdateIntegrationEvents(t)

	cmd := buildWindowsLaunchCommand(scriptPath, windowsUpdateLaunchContext{
		SourcePath:           sourcePath,
		TargetPath:           targetPath,
		CurrentTargetPath:    currentTargetPath,
		UpdatesDir:           stagedDir,
		StagedDir:            stagedDir,
		LogPath:              logPath,
		MaintenanceEventName: maintenanceName,
		HandoffEventName:     handoffName,
		PID:                  2147483647,
	})
	if output, err := cmd.CombinedOutput(); err != nil {
		logData, _ := os.ReadFile(logPath)
		t.Fatalf("run versioned updater: %v\nstdout/stderr:\n%s\nlog:\n%s", err, output, logData)
	}

	// The helper remains alive through the updater's launch health check.
	time.Sleep(7 * time.Second)
	targetData, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatalf("ReadFile renamed target: %v", err)
	}
	if gotHash := sha256.Sum256(targetData); gotHash != wantHash {
		t.Fatalf("renamed target hash = %x, want %x", gotHash, wantHash)
	}
	if _, err := os.Stat(currentTargetPath); !os.IsNotExist(err) {
		t.Fatalf("expected old versioned executable to be removed, stat err=%v", err)
	}
}

func TestWindowsPowerShellUpdaterSelectsExactTargetFilenameRecursivelyFromZip(t *testing.T) {
	root := t.TempDir()
	installDir := filepath.Join(root, "install")
	stagedDir := filepath.Join(root, "stage")
	for _, dir := range []string{installDir, stagedDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("MkdirAll %q: %v", dir, err)
		}
	}

	helperPath := filepath.Join(root, "update-helper.exe")
	build := exec.Command("go", "build", "-ldflags=-H=windowsgui", "-o", helperPath, "./testdata/windows_update_helper")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build update helper: %v\n%s", err, output)
	}
	helperData, err := os.ReadFile(helperPath)
	if err != nil {
		t.Fatalf("ReadFile helper: %v", err)
	}
	wantHash := sha256.Sum256(helperData)

	sourcePath := filepath.Join(stagedDir, "portable.zip")
	writeWindowsUpdateTestZip(t, sourcePath, []windowsUpdateZipEntry{
		{Name: "nested/GoNavi.exe", Data: helperData},
		{Name: "portable.exe", Data: []byte("package-name distractor")},
		{Name: "tools/GoNavi-helper.exe", Data: []byte("GoNavi-name distractor")},
	})
	targetPath := filepath.Join(installDir, "GoNavi.exe")
	if err := os.WriteFile(targetPath, []byte("old executable"), 0o755); err != nil {
		t.Fatalf("WriteFile old target: %v", err)
	}
	logPath := filepath.Join(stagedDir, "gonavi-update-windows-zip.log")
	scriptPath := filepath.Join(stagedDir, "update.ps1")
	if err := os.WriteFile(scriptPath, []byte(buildWindowsPowerShellScript()), 0o644); err != nil {
		t.Fatalf("WriteFile updater: %v", err)
	}
	maintenanceName, handoffName := prepareWindowsUpdateIntegrationEvents(t)

	cmd := buildWindowsLaunchCommand(scriptPath, windowsUpdateLaunchContext{
		SourcePath:           sourcePath,
		TargetPath:           targetPath,
		CurrentTargetPath:    targetPath,
		UpdatesDir:           stagedDir,
		StagedDir:            stagedDir,
		LogPath:              logPath,
		MaintenanceEventName: maintenanceName,
		HandoffEventName:     handoffName,
		PID:                  2147483647,
	})
	if output, err := cmd.CombinedOutput(); err != nil {
		logData, _ := os.ReadFile(logPath)
		t.Fatalf("run ZIP updater: %v\nstdout/stderr:\n%s\nlog:\n%s", err, output, logData)
	}

	// The selected helper remains alive through the launch health check.
	time.Sleep(7 * time.Second)
	targetData, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatalf("ReadFile updated target: %v", err)
	}
	if gotHash := sha256.Sum256(targetData); gotHash != wantHash {
		t.Fatalf("updated target hash = %x, want exact target-name candidate hash %x", gotHash, wantHash)
	}
}

func TestWindowsPowerShellUpdaterRejectsAmbiguousZipAndRetainsPackage(t *testing.T) {
	root := t.TempDir()
	installDir := filepath.Join(root, "install")
	stagedDir := filepath.Join(root, "stage")
	for _, dir := range []string{installDir, stagedDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("MkdirAll %q: %v", dir, err)
		}
	}

	sourcePath := filepath.Join(stagedDir, "portable.zip")
	writeWindowsUpdateTestZip(t, sourcePath, []windowsUpdateZipEntry{
		{Name: "tools/alpha.exe", Data: []byte("alpha")},
		{Name: "nested/beta.exe", Data: []byte("beta")},
	})
	targetPath := filepath.Join(installDir, "Application.exe")
	oldTargetData := []byte("old executable")
	if err := os.WriteFile(targetPath, oldTargetData, 0o755); err != nil {
		t.Fatalf("WriteFile old target: %v", err)
	}
	logPath := filepath.Join(stagedDir, "gonavi-update-windows-ambiguous.log")
	scriptPath := filepath.Join(stagedDir, "update.ps1")
	if err := os.WriteFile(scriptPath, []byte(buildWindowsPowerShellScript()), 0o644); err != nil {
		t.Fatalf("WriteFile updater: %v", err)
	}
	maintenanceName, handoffName := prepareWindowsUpdateIntegrationEvents(t)

	cmd := buildWindowsLaunchCommand(scriptPath, windowsUpdateLaunchContext{
		SourcePath:           sourcePath,
		TargetPath:           targetPath,
		CurrentTargetPath:    targetPath,
		UpdatesDir:           stagedDir,
		StagedDir:            stagedDir,
		LogPath:              logPath,
		MaintenanceEventName: maintenanceName,
		HandoffEventName:     handoffName,
		PID:                  2147483647,
	})
	if output, err := cmd.CombinedOutput(); err == nil {
		t.Fatalf("ambiguous ZIP updater unexpectedly succeeded\n%s", output)
	}

	if _, err := os.Stat(sourcePath); err != nil {
		t.Fatalf("ambiguous update package must be retained: %v", err)
	}
	targetData, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatalf("ReadFile target after ambiguous update: %v", err)
	}
	if string(targetData) != string(oldTargetData) {
		t.Fatalf("target changed after ambiguous ZIP selection: got %q want %q", targetData, oldTargetData)
	}
	logData, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("ReadFile updater log: %v", err)
	}
	if !strings.Contains(string(logData), "ambiguous portable zip") ||
		!strings.Contains(string(logData), "package retained for manual install") {
		t.Fatalf("expected ambiguous retained-package error in updater log:\n%s", logData)
	}
}

type windowsUpdateZipEntry struct {
	Name string
	Data []byte
}

func prepareWindowsUpdateIntegrationEvents(t *testing.T) (string, string) {
	t.Helper()
	name := fmt.Sprintf(`Global\GoNavi-Update-Integration-%d-%d`, os.Getpid(), time.Now().UnixNano())
	lease, err := acquireWindowsUpdateMaintenanceObject(name)
	if err != nil {
		t.Fatalf("acquire integration maintenance object: %v", err)
	}
	handoff, err := prepareWindowsUpdateHandoff()
	if err != nil {
		lease.Release()
		t.Fatalf("prepare integration handoff: %v", err)
	}
	t.Cleanup(lease.Release)
	t.Cleanup(handoff.Close)
	return lease.Name, handoff.Name
}

func writeWindowsUpdateTestZip(t *testing.T, path string, entries []windowsUpdateZipEntry) {
	t.Helper()

	archive, err := os.Create(path)
	if err != nil {
		t.Fatalf("Create ZIP %q: %v", path, err)
	}
	writer := zip.NewWriter(archive)
	for _, entry := range entries {
		file, createErr := writer.Create(entry.Name)
		if createErr != nil {
			_ = writer.Close()
			_ = archive.Close()
			t.Fatalf("Create ZIP entry %q: %v", entry.Name, createErr)
		}
		if _, writeErr := file.Write(entry.Data); writeErr != nil {
			_ = writer.Close()
			_ = archive.Close()
			t.Fatalf("Write ZIP entry %q: %v", entry.Name, writeErr)
		}
	}
	if err := writer.Close(); err != nil {
		_ = archive.Close()
		t.Fatalf("Close ZIP writer: %v", err)
	}
	if err := archive.Close(); err != nil {
		t.Fatalf("Close ZIP file: %v", err)
	}
}
