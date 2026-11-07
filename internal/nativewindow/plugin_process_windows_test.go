//go:build windows

package nativewindow

import (
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestPluginWindowsJobKillsDescendantTree(t *testing.T) {
	spec := pluginHelperSpec(t, "tree")
	process, err := startPluginProcess(spec)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- process.Wait() }()
	t.Cleanup(func() {
		if err := process.Kill(); err != nil {
			t.Error(err)
		}
	})
	pid, err := strconv.Atoi(string(awaitPluginFile(t, filepath.Join(spec.directory, "descendant.pid"))))
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		t.Fatal(err)
	}
	defer closePluginHandle(handle)
	if err := process.Kill(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("root process not reaped")
	}
	result, err := windows.WaitForSingleObject(handle, 3000)
	if err != nil || result != windows.WAIT_OBJECT_0 {
		t.Fatalf("descendant survived job termination: result=%d error=%v", result, err)
	}
}
