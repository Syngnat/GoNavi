//go:build darwin

package app

import (
	"os/exec"
	"strconv"
	"testing"
	"time"
)

func TestWaitForWindowsRestartParentWaitsForProcessExit(t *testing.T) {
	cmd := exec.Command("/bin/sleep", "0.3")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	waitDone := make(chan error, 1)
	go func() { waitDone <- cmd.Wait() }()
	startedAt := time.Now()
	err := WaitForWindowsRestartParent([]string{windowsRestartParentPIDArgument + strconv.Itoa(cmd.Process.Pid)})
	if err != nil {
		_ = cmd.Process.Kill()
		<-waitDone
		t.Fatal(err)
	}
	if elapsed := time.Since(startedAt); elapsed < 150*time.Millisecond {
		_ = cmd.Process.Kill()
		<-waitDone
		t.Fatalf("returned before the old process exited: %s", elapsed)
	}
	if err := <-waitDone; err != nil {
		t.Fatalf("wait for probe process: %v", err)
	}
}
