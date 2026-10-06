//go:build windows

package app

import (
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func buildWindowsUpdateHelper(t *testing.T) string {
	t.Helper()
	helperPath := filepath.Join(t.TempDir(), "GoNavi.exe")
	build := exec.Command("go", "build", "-ldflags=-H=windowsgui", "-o", helperPath, "./testdata/windows_update_helper")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build update helper: %v\n%s", err, output)
	}
	return helperPath
}

func startWindowsUpdateHelper(t *testing.T, helperPath string, args ...string) windowsUpdateProcess {
	t.Helper()
	command := exec.Command(helperPath, args...)
	if err := command.Start(); err != nil {
		t.Fatalf("start update helper: %v", err)
	}
	t.Cleanup(func() {
		_ = command.Process.Kill()
		_, _ = command.Process.Wait()
	})
	return windowsUpdateProcess{PID: uint32(command.Process.Pid), Executable: helperPath}
}

// waitForWindowsApplicationWindow 等替身进程把主窗口建出来，否则它会被当成无头进程直接结束。
func waitForWindowsApplicationWindow(t *testing.T, pid uint32) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		found := false
		callback := syscall.NewCallback(func(hwnd uintptr, _ uintptr) uintptr {
			var owner uint32
			if _, err := windows.GetWindowThreadProcessId(windows.HWND(hwnd), &owner); err == nil && owner == pid && isWindowsApplicationWindow(hwnd) {
				found = true
			}
			return 1
		})
		_ = windows.EnumWindows(callback, nil)
		if found {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("helper %d never created its application window", pid)
}

func assertWindowsUpdateHelpersClosed(t *testing.T, helperPath string) {
	t.Helper()
	instances, err := findOtherWindowsUpdateInstances([]string{helperPath}, -1)
	if err != nil {
		t.Fatalf("findOtherWindowsUpdateInstances after close: %v", err)
	}
	if len(instances) != 0 {
		t.Fatalf("helpers still running after close: %#v", instances)
	}
}

// 无头实例（MCP 服务、运行时清理进程）收不到 WM_CLOSE，逐个等满优雅退出时间只会让更新确认框
// 多转 1.5 秒 × 实例数；它们应当直接结束。
func TestCloseWindowsUpdateInstancesDoesNotWaitForHeadlessProcesses(t *testing.T) {
	helperPath := buildWindowsUpdateHelper(t)
	processes := make([]windowsUpdateProcess, 0, 3)
	for range 3 {
		processes = append(processes, startWindowsUpdateHelper(t, helperPath))
	}
	time.Sleep(200 * time.Millisecond)

	started := time.Now()
	if err := closeWindowsUpdateInstances(processes); err != nil {
		t.Fatalf("closeWindowsUpdateInstances returned error: %v", err)
	}
	elapsed := time.Since(started)
	if elapsed >= windowsGracefulProcessCloseWait {
		t.Fatalf("closing 3 headless instances took %v; they must not wait for the graceful window", elapsed)
	}
	assertWindowsUpdateHelpersClosed(t, helperPath)
}

// 带界面窗口的实例共用同一个优雅退出期限：两个都不响应关闭时总等待约 1.5 秒，而不是每个各等 1.5 秒。
func TestCloseWindowsUpdateInstancesSharesGracefulDeadlineAcrossWindowedProcesses(t *testing.T) {
	helperPath := buildWindowsUpdateHelper(t)
	processes := []windowsUpdateProcess{
		startWindowsUpdateHelper(t, helperPath, "window"),
		startWindowsUpdateHelper(t, helperPath, "window"),
		startWindowsUpdateHelper(t, helperPath),
	}
	waitForWindowsApplicationWindow(t, processes[0].PID)
	waitForWindowsApplicationWindow(t, processes[1].PID)

	started := time.Now()
	if err := closeWindowsUpdateInstances(processes); err != nil {
		t.Fatalf("closeWindowsUpdateInstances returned error: %v", err)
	}
	elapsed := time.Since(started)
	if elapsed < windowsGracefulProcessCloseWait-200*time.Millisecond {
		t.Fatalf("windowed instances were closed after %v without their graceful window", elapsed)
	}
	if elapsed >= 2*windowsGracefulProcessCloseWait-200*time.Millisecond {
		t.Fatalf("closing 2 windowed instances took %v; the graceful window must be shared", elapsed)
	}
	assertWindowsUpdateHelpersClosed(t, helperPath)
}
