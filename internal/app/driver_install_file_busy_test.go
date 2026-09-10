package app

import (
	"errors"
	"os"
	"strings"
	"syscall"
	"testing"
)

func TestIsDriverInstallFileBusyError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{name: "nil", err: nil, want: false},
		{name: "access denied text", err: errors.New("rename a.tmp a.exe: Access is denied."), want: true},
		{name: "sharing violation", err: errors.New("unlinkat duckdb.dll: The process cannot access the file because it is being used by another process."), want: true},
		{name: "windows errno 5", err: syscall.Errno(5), want: true},
		{name: "windows errno 32", err: syscall.Errno(32), want: true},
		{name: "unrelated", err: errors.New("no such file or directory"), want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isDriverInstallFileBusyError(tc.err); got != tc.want {
				t.Fatalf("isDriverInstallFileBusyError(%v)=%v want %v", tc.err, got, tc.want)
			}
		})
	}
}

func TestWrapDriverInstallReplaceErrorBusyMessage(t *testing.T) {
	err := wrapDriverInstallReplaceError(errors.New("rename x.tmp x.exe: Access is denied."))
	var localized *localizedDriverBackendError
	if !errors.As(err, &localized) {
		t.Fatalf("expected localized error, got %T %v", err, err)
	}
	if localized.key != "driver_manager.backend.error.agent_file_busy" {
		t.Fatalf("key=%q", localized.key)
	}
	msg := localizedDriverBackendErrorMessage(nil, err)
	if msg == "" {
		t.Fatal("empty message")
	}
	lower := strings.ToLower(msg)
	if strings.Contains(lower, "access is denied") || strings.Contains(lower, "unlinkat") {
		t.Fatalf("user message should not dump raw OS text, got %q", msg)
	}
}

func TestLocalizeOptionalDriverActivateErrorPreservesBusy(t *testing.T) {
	busy := wrapDriverInstallReplaceError(errors.New("rename a.tmp a.exe: Access is denied."))
	got := localizeOptionalDriverActivateError("DuckDB", busy)
	var localized *localizedDriverBackendError
	if !errors.As(got, &localized) {
		t.Fatalf("expected localized, got %v", got)
	}
	if localized.key != "driver_manager.backend.error.agent_file_busy" {
		t.Fatalf("expected busy key preserved, got %q", localized.key)
	}
}

func TestRenameTempFileOverTargetWrapsBusy(t *testing.T) {
	dir := t.TempDir()
	target := dir + string(os.PathSeparator) + "locked.exe"
	temp := target + ".tmp"
	if err := os.WriteFile(temp, []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(target, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	renameErr := renameTempFileOverTarget(temp, target)
	if renameErr == nil {
		t.Skip("rename succeeded unexpectedly; environment did not lock the file")
	}
	if isDriverInstallFileBusyError(renameErr) {
		var localized *localizedDriverBackendError
		if !errors.As(renameErr, &localized) || localized.key != "driver_manager.backend.error.agent_file_busy" {
			t.Fatalf("busy rename should return localized agent_file_busy, got %v", renameErr)
		}
	}
}
