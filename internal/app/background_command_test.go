package app

import (
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestStartBackgroundCommandReapsExitedProcess(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=^TestBackgroundCommandHelperProcess$")
	cmd.Env = append(os.Environ(), "GO_WANT_BACKGROUND_COMMAND_HELPER=1")

	reaped := make(chan error, 1)
	if err := startBackgroundCommand(cmd, func(err error) {
		reaped <- err
	}); err != nil {
		t.Fatalf("startBackgroundCommand returned error: %v", err)
	}

	select {
	case err := <-reaped:
		if err != nil {
			t.Fatalf("background helper exited with error: %v", err)
		}
		if cmd.ProcessState == nil || !cmd.ProcessState.Exited() {
			t.Fatalf("expected exited helper to be reaped, got state %#v", cmd.ProcessState)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("background helper exited but was not reaped")
	}
}

func TestBackgroundCommandHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_BACKGROUND_COMMAND_HELPER") != "1" {
		return
	}
}
