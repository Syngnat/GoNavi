//go:build darwin && cgo && !wails3

package nativewindow

import (
	"errors"
	"testing"

	"github.com/wailsapp/wails/v2/pkg/options"
)

func TestRunDetachedChildApplicationInstallsAccessoryGuardBeforeWailsRun(t *testing.T) {
	runnerErr := errors.New("runner stopped")
	runnerCalled := false

	err := runDetachedChildApplication(&options.App{}, func(*options.App) error {
		runnerCalled = true
		if !detachedAccessoryActivationPolicyGuardInstalled() {
			t.Fatal("accessory activation-policy guard was not installed before Wails started")
		}
		return runnerErr
	})

	if !runnerCalled {
		t.Fatal("Wails runner was not called")
	}
	if !errors.Is(err, runnerErr) {
		t.Fatalf("runDetachedChildApplication() error = %v, want %v", err, runnerErr)
	}
}
