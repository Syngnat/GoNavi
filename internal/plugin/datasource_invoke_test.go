package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func installDataSourceInvocationFixture(t *testing.T, m *Manager, mode string) Status {
	t.Helper()
	manifest := dataSourceManifest()
	manifest.Permissions = append(manifest.Permissions, "ai.tools")
	manifest.Contributes.Commands = append(manifest.Contributes.Commands, Command{ID: "ordinary", Title: "Ordinary"})
	if runtime.GOOS == "windows" {
		manifest.Backend.Default.Executable += ".exe"
	}
	manifest.Backend.Default.Args = []string{"-test.run=^TestFixtureProcess$", "--", "--plugin-fixture", mode}
	source := writePackage(t, manifest)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	input, err := os.Open(executable)
	if err != nil {
		t.Fatal(err)
	}
	output, err := os.Create(filepath.Join(source, manifest.Backend.Default.Executable))
	if err != nil {
		input.Close()
		t.Fatal(err)
	}
	_, copyErr := io.Copy(output, input)
	inputErr := input.Close()
	outputErr := output.Close()
	if copyErr != nil || inputErr != nil || outputErr != nil {
		t.Fatalf("copy fixture: %v %v %v", copyErr, inputErr, outputErr)
	}
	return installSource(t, m, source)
}

func TestDataSourceGenericInvocationIsReserved(t *testing.T) {
	manager := testManager(t)
	status := installDataSourceInvocationFixture(t, manager, "echo")
	ctx := context.Background()
	enableFixture(t, manager, status.Manifest.ID)
	if err := manager.Start(ctx); err != nil {
		t.Fatal(err)
	}
	running := waitState(t, manager, status.Manifest.ID, StateRunning)
	envelopes := []json.RawMessage{
		json.RawMessage(`{"protocolVersion":1,"operation":"connect","sessionId":"forged"}`),
		json.RawMessage(`{"protocolVersion":1,"operation":"query","sessionId":"forged","query":"DELETE FROM protected"}`), nil,
	}
	for _, args := range envelopes {
		if _, err := manager.Invoke(ctx, status.Manifest.ID, "database", args); !errors.Is(err, ErrDataSourceCommandReserved) {
			t.Fatalf("generic driver envelope admitted: %v", err)
		}
		if _, err := manager.InvokeGeneration(ctx, status.Manifest.ID, running.Generation, "database", args); !errors.Is(err, ErrDataSourceCommandReserved) {
			t.Fatalf("generation driver envelope admitted: %v", err)
		}
	}
	args := json.RawMessage(`{"ordinary":true}`)
	result, err := manager.InvokeGeneration(ctx, status.Manifest.ID, running.Generation, "ordinary", args)
	if err != nil || string(result) != string(args) {
		t.Fatalf("ordinary command changed: %s %v", result, err)
	}
	result, err = manager.Invoke(ctx, status.Manifest.ID, "ordinary", args)
	if err != nil || string(result) != string(args) {
		t.Fatalf("ordinary non-generation command changed: %s %v", result, err)
	}
	manager.mu.Lock()
	inflight := manager.instances[status.Manifest.ID].inflight
	manager.mu.Unlock()
	if inflight != 0 {
		t.Fatalf("rejected calls leaked slots: %d", inflight)
	}
	if current := manager.List()[0]; current.State != StateRunning {
		t.Fatalf("policy rejection faulted process: %+v", current)
	}
}

func TestDataSourceDedicatedInvocationFencesIdentityAndGeneration(t *testing.T) {
	manager := testManager(t)
	status := installDataSourceInvocationFixture(t, manager, "echo")
	ctx := context.Background()
	if _, err := manager.InvokeDataSourceGeneration(ctx, status.Manifest.ID, status.Generation, "fixture", nil); !errors.Is(err, ErrDisabled) {
		t.Fatalf("disabled source admitted: %v", err)
	}
	enableFixture(t, manager, status.Manifest.ID)
	if err := manager.Start(ctx); err != nil {
		t.Fatal(err)
	}
	first := waitState(t, manager, status.Manifest.ID, StateRunning)
	args := json.RawMessage(`{"protocolVersion":1,"operation":"connect","sessionId":"host-session"}`)
	result, err := manager.InvokeDataSourceGeneration(ctx, status.Manifest.ID, first.Generation, "fixture", args)
	if err != nil || string(result) != string(args) {
		t.Fatalf("dedicated dispatch failed: %s %v", result, err)
	}
	for _, source := range []string{"missing", "database", "ordinary", "", "Fixture", "fixture:sqlite"} {
		if _, err := manager.InvokeDataSourceGeneration(ctx, status.Manifest.ID, first.Generation, source, args); !errors.Is(err, ErrNotFound) {
			t.Fatalf("unknown source %q: %v", source, err)
		}
	}
	if _, err := manager.InvokeDataSourceGeneration(ctx, status.Manifest.ID, 0, "fixture", args); !errors.Is(err, ErrDisabled) {
		t.Fatalf("zero generation accepted: %v", err)
	}
	oversized := json.RawMessage(`"` + strings.Repeat("x", maxRPCBytes) + `"`)
	if _, err := manager.InvokeDataSourceGeneration(ctx, status.Manifest.ID, first.Generation, "fixture", oversized); err == nil {
		t.Fatal("argument budget bypassed")
	}
	if _, err := manager.SetEnabled(ctx, status.Manifest.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.InvokeDataSourceGeneration(ctx, status.Manifest.ID, first.Generation, "fixture", args); !errors.Is(err, ErrDisabled) {
		t.Fatalf("revoked generation accepted: %v", err)
	}
	enableFixture(t, manager, status.Manifest.ID)
	next := waitState(t, manager, status.Manifest.ID, StateRunning)
	if _, err := manager.InvokeDataSourceGeneration(ctx, status.Manifest.ID, first.Generation, "fixture", args); !errors.Is(err, ErrDisabled) {
		t.Fatalf("stale generation accepted: %v", err)
	}
	if _, err := manager.InvokeDataSourceGeneration(ctx, status.Manifest.ID, next.Generation, "fixture", args); err != nil {
		t.Fatalf("fresh source failed: %v", err)
	}
}

func TestDataSourceDedicatedDisableCancelsInFlight(t *testing.T) {
	manager := testManager(t)
	status := installDataSourceInvocationFixture(t, manager, "ignore-cancel")
	ctx := context.Background()
	enableFixture(t, manager, status.Manifest.ID)
	if err := manager.Start(ctx); err != nil {
		t.Fatal(err)
	}
	running := waitState(t, manager, status.Manifest.ID, StateRunning)
	done := make(chan error, 1) // One result cannot strand cleanup after a failed assertion.
	go func() {
		_, err := manager.InvokeDataSourceGeneration(ctx, status.Manifest.ID, running.Generation, "fixture", json.RawMessage(`{"operation":"query"}`))
		done <- err
	}()
	waitFor(t, "dedicated request admitted", func() bool {
		manager.mu.Lock()
		defer manager.mu.Unlock()
		inst := manager.instances[status.Manifest.ID]
		return inst != nil && inst.inflight == 1
	})
	start := time.Now()
	if _, err := manager.SetEnabled(ctx, status.Manifest.ID, false); err != nil {
		t.Fatal(err)
	}
	// 与 TestDisableNeverWaitsForBusyPlugin 同一套判断：这里要证明的是
	// 「disable 不等 datasource 配合」，不是测调度精度。真正的等待会等满
	// fixture 的阻塞时长（秒级），Windows CI 上 300ms 会被进程调度抖动打穿。
	if time.Since(start) > time.Second {
		t.Fatal("disable waited for datasource cooperation")
	}
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) && !errors.Is(err, ErrDisabled) {
			t.Fatalf("unexpected cancellation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("dedicated call ignored cancellation")
	}
	waitFor(t, "datasource process reaped", func() bool { manager.mu.Lock(); defer manager.mu.Unlock(); return len(manager.instances) == 0 })
}

func TestDataSourceInvocationTargetValidation(t *testing.T) {
	cases := []struct {
		name   string
		change func(*Manifest)
		target invocationTarget
		want   error
	}{
		{"reserved generic", func(*Manifest) {}, invocationTarget{command: "database"}, ErrDataSourceCommandReserved},
		{"no permission", func(m *Manifest) { m.Permissions = []string{"ai.tools"} }, invocationTarget{sourceID: "fixture"}, ErrDisabled},
		{"permission case", func(m *Manifest) { m.Permissions = []string{"Data.Sources"} }, invocationTarget{sourceID: "fixture"}, ErrDisabled},
		{"no backend", func(m *Manifest) { m.Backend = nil }, invocationTarget{sourceID: "fixture"}, ErrDisabled},
		{"undeclared command", func(m *Manifest) { m.Contributes.DataSources[0].Command = "unknown" }, invocationTarget{sourceID: "fixture"}, ErrNotFound},
		{"missing source", func(*Manifest) {}, invocationTarget{sourceID: "missing"}, ErrNotFound},
		{"ambiguous authority", func(*Manifest) {}, invocationTarget{sourceID: "fixture", command: "database"}, ErrNotFound},
		{"reservation without permission", func(m *Manifest) { m.Permissions = nil }, invocationTarget{command: "database"}, ErrDataSourceCommandReserved},
		{"reservation without readonly", func(m *Manifest) { m.Contributes.DataSources[0].ReadOnly = false }, invocationTarget{command: "database"}, ErrDataSourceCommandReserved},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			manifest := dataSourceManifest()
			test.change(&manifest)
			if _, err := resolveInvocationCommand(manifest, test.target); !errors.Is(err, test.want) {
				t.Fatalf("result %v; want %v", err, test.want)
			}
		})
	}
	if command, err := resolveInvocationCommand(dataSourceManifest(), invocationTarget{sourceID: "fixture"}); err != nil || command != "database" {
		t.Fatalf("command resolution: %q %v", command, err)
	}
	writable := dataSourceManifest()
	writable.Contributes.DataSources[0].ReadOnly = false
	if command, err := resolveInvocationCommand(writable, invocationTarget{sourceID: "fixture"}); err != nil || command != "database" {
		t.Fatalf("writable command resolution: %q %v", command, err)
	}
}
