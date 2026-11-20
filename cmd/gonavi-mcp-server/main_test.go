package main

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"

	"GoNavi-Wails/internal/scriptengine"
)

func TestIsNormalServerExit(t *testing.T) {
	for name, err := range map[string]error{
		"context canceled": context.Canceled,
		"EOF":              io.EOF,
	} {
		t.Run(name, func(t *testing.T) {
			if !isNormalServerExit(err) {
				t.Fatalf("isNormalServerExit(%v) = false, want true", err)
			}
		})
	}

	if isNormalServerExit(errors.New("startup failed")) {
		t.Fatal("startup failure was treated as a normal server exit")
	}
}

func TestMainReturnsNonZeroForStartupFailure(t *testing.T) {
	const helperEnv = "GONAVI_MCP_MAIN_FAILURE_HELPER"
	if os.Getenv(helperEnv) == "1" {
		os.Args = []string{"gonavi-mcp-server", "invalid-mode"}
		main()
		return
	}

	cmd := exec.Command(os.Args[0], "-test.run=^TestMainReturnsNonZeroForStartupFailure$")
	cmd.Env = append(os.Environ(), helperEnv+"=1")
	err := cmd.Run()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("main returned success for a startup failure: %v", err)
	}
	if exitErr.ExitCode() != 1 {
		t.Fatalf("startup failure exit code = %d, want 1", exitErr.ExitCode())
	}
}

func TestRunRoutesScriptWorkerMode(t *testing.T) {
	emptyInput, err := os.CreateTemp(t.TempDir(), "empty-script-worker-*")
	if err != nil {
		t.Fatalf("create empty stdin: %v", err)
	}
	if err := emptyInput.Close(); err != nil {
		t.Fatalf("close empty stdin: %v", err)
	}
	input, err := os.Open(emptyInput.Name())
	if err != nil {
		t.Fatalf("open empty stdin: %v", err)
	}
	t.Cleanup(func() {
		_ = input.Close()
	})
	previous := os.Stdin
	os.Stdin = input
	t.Cleanup(func() {
		os.Stdin = previous
	})

	err = run(context.Background(), []string{scriptengine.WorkerModeArg})
	if err == nil || !strings.Contains(err.Error(), "received no run request") {
		t.Fatalf("script-worker mode error = %v, want empty run request", err)
	}
}
