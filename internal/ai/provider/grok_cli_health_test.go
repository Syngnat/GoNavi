package provider

import (
	"context"
	"errors"
	"os/exec"
	"reflect"
	"testing"
	"time"
)

func TestGrokCLIModelCheck(t *testing.T) {
	originalLookPath, originalOutput, originalTimeout := cliModelLookPath, cliModelCommandOutput, modelDiscoveryTimeout
	t.Cleanup(func() {
		cliModelLookPath, cliModelCommandOutput, modelDiscoveryTimeout = originalLookPath, originalOutput, originalTimeout
	})
	for _, test := range []struct {
		name, output                                string
		missing, timeout, commandFailure, wantError bool
	}{
		{name: "model list", output: "You are logged in with grok.com.\n  * grok-test (default)\n  • grok-other"},
		{name: "not installed", missing: true, wantError: true},
		{name: "not logged in zero exit", output: "Not logged in. Run grok login.\n * grok-test", wantError: true},
		{name: "empty output", wantError: true},
		{name: "rejection zero exit", output: "Couldn't set model\n * grok-test", wantError: true},
		{name: "nonzero exit with partial list", output: " * grok-test", commandFailure: true, wantError: true},
		{name: "timeout with partial list", output: " * grok-test", timeout: true, wantError: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			cliModelLookPath = func(string) (string, error) {
				if test.missing {
					return "", exec.ErrNotFound
				}
				return "fake-grok", nil
			}
			modelDiscoveryTimeout = 10 * time.Millisecond
			calls := 0
			cliModelCommandOutput = func(ctx context.Context, command string, args ...string) ([]byte, error) {
				calls++
				if command != "fake-grok" || !reflect.DeepEqual(args, []string{"models"}) {
					t.Fatal("check must only run the models subcommand")
				}
				if _, ok := ctx.Deadline(); !ok {
					t.Fatal("model check must have a deadline")
				}
				if test.timeout {
					<-ctx.Done()
				}
				if test.commandFailure {
					return []byte(test.output), errors.New("exit 1")
				}
				return []byte(test.output), nil
			}
			err := CheckGrokCLIModels(context.Background())
			if (err != nil) != test.wantError {
				t.Fatalf("unexpected result: %v", err)
			}
			if test.timeout && !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("timeout must be preserved: %v", err)
			}
			if test.missing && calls != 0 {
				t.Fatal("missing command must not execute")
			}
		})
	}
}

func TestGrokCLICommandResolution(t *testing.T) {
	for _, test := range []struct{ os, installed string }{{"darwin", "grok"}, {"linux", "grok"}, {"windows", "grok.cmd"}, {"windows", "grok.exe"}} {
		t.Run(test.os+test.installed, func(t *testing.T) {
			command, err := resolveGrokCLICommand(test.os, func(name string) (string, error) {
				if name == test.installed {
					return name, nil
				}
				return "", exec.ErrNotFound
			})
			if err != nil || command != test.installed {
				t.Fatalf("resolution failed: %q %v", command, err)
			}
		})
	}
}
