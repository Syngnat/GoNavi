package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func testManager(t *testing.T) *Manager {
	t.Helper()
	return managerAt(t, t.TempDir())
}
func managerAt(t *testing.T, root string) *Manager {
	t.Helper()
	m, err := NewManager(Options{Root: root, HostVersion: "1.0.0", HandshakeTimeout: 3 * time.Second, HeartbeatInterval: 100 * time.Millisecond, HeartbeatTimeout: 200 * time.Millisecond, ShutdownTimeout: 150 * time.Millisecond, InvocationTimeout: time.Second, ReconcileInterval: 10 * time.Millisecond, MaxConcurrentInvocations: 2})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := m.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	return m
}
func installFixture(t *testing.T, m *Manager, id, mode string) Status {
	t.Helper()
	manifest := basicManifest(id)
	if mode != "" {
		executable := "backend"
		if runtime.GOOS == "windows" {
			executable += ".exe"
		}
		manifest.Backend = &Backend{Default: &Entry{Executable: executable, Args: []string{"-test.run=^TestFixtureProcess$", "--", "--plugin-fixture", mode}}}
		manifest.Contributes.Commands = []Command{{ID: "echo", Title: "Echo"}}
	}
	source := writePackage(t, manifest)
	if mode != "" {
		executable, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		in, err := os.Open(executable)
		if err != nil {
			t.Fatal(err)
		}
		out, err := os.Create(filepath.Join(source, manifest.Backend.Default.Executable))
		if err != nil {
			in.Close()
			t.Fatal(err)
		}
		_, err = io.Copy(out, in)
		closeIn := in.Close()
		closeOut := out.Close()
		if err != nil || closeIn != nil || closeOut != nil {
			t.Fatalf("copy fixture: %v %v %v", err, closeIn, closeOut)
		}
	}
	return installSource(t, m, source)
}
func installSource(t *testing.T, m *Manager, source string) Status {
	t.Helper()
	inspection, err := m.Inspect(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	status, err := m.Install(context.Background(), InstallRequest{Path: source, Digest: inspection.Digest, Trusted: true})
	if err != nil {
		t.Fatal(err)
	}
	return status
}
func waitFor(t *testing.T, description string, check func() bool) {
	t.Helper()
	deadline := time.NewTimer(8 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		if check() {
			return
		}
		select {
		case <-deadline.C:
			t.Fatalf("timed out: %s", description)
		case <-ticker.C:
		}
	}
}
func waitState(t *testing.T, m *Manager, id string, state State) Status {
	t.Helper()
	defer func() {
		if t.Failed() {
			t.Logf("final statuses: %+v", m.List())
		}
	}()
	var result Status
	waitFor(t, "state "+id+" = "+string(state), func() bool {
		for _, s := range m.List() {
			if s.Manifest.ID == id {
				result = s
				return s.State == state
			}
		}
		return false
	})
	return result
}
func enableFixture(t *testing.T, m *Manager, id string) {
	t.Helper()
	if _, err := m.SetEnabled(context.Background(), id, true); err != nil {
		t.Fatal(err)
	}
}
func TestRealProcessInvocationAndGeneration(t *testing.T) {
	m := testManager(t)
	status := installFixture(t, m, "test.echo", "echo")
	ctx := context.Background()
	enableFixture(t, m, status.Manifest.ID)
	if err := m.Start(ctx); err != nil {
		t.Fatal(err)
	}
	running := waitState(t, m, status.Manifest.ID, StateRunning)
	result, err := m.InvokeGeneration(ctx, status.Manifest.ID, running.Generation, "echo", json.RawMessage(`{"hello":"world"}`))
	if err != nil {
		t.Fatal(err)
	}
	if string(result) != `{"hello":"world"}` {
		t.Fatalf("echo: %s", result)
	}
	if _, err = m.SetEnabled(ctx, status.Manifest.ID, false); err != nil {
		t.Fatal(err)
	}
	enableFixture(t, m, status.Manifest.ID)
	next := waitState(t, m, status.Manifest.ID, StateRunning)
	if next.Generation <= running.Generation {
		t.Fatal("generation did not advance")
	}
	if _, err = m.InvokeGeneration(ctx, status.Manifest.ID, running.Generation, "echo", nil); !errors.Is(err, ErrDisabled) {
		t.Fatalf("stale generation admitted: %v", err)
	}
	if _, err = m.Invoke(ctx, status.Manifest.ID, "missing", nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("undeclared command: %v", err)
	}
}
func TestQuarantineRetriesAfterConcurrentGenerationBump(t *testing.T) {
	m := testManager(t)
	status := installFixture(t, m, "test.echo", "echo")
	enableFixture(t, m, status.Manifest.ID)
	if err := m.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitState(t, m, status.Manifest.ID, StateRunning)
	m.mu.Lock()
	inst := m.instances[status.Manifest.ID]
	m.mu.Unlock()
	if inst == nil {
		t.Fatal("instance missing")
	}
	cause := errors.New("plugin process exited: exit status 23")
	// A concurrent external write moves the record generation after start; the quarantine
	// used to drop silently on the stale generation, and the next reconcile restart turned
	// one fault into a restart loop that ended in a bogus disabled state.
	if _, err := m.mutate(context.Background(), func(state *diskState) (bool, error) {
		r, ok := state.Records[status.Manifest.ID]
		if !ok {
			return false, ErrNotFound
		}
		r.Generation = state.Generation
		state.Records[status.Manifest.ID] = r
		return true, nil
	}); err != nil {
		t.Fatal(err)
	}
	m.quarantine(inst, cause)
	state, err := m.loadState()
	if err != nil {
		t.Fatal(err)
	}
	record := state.Records[status.Manifest.ID]
	if !record.Quarantined || record.State != StateFaulted {
		t.Fatalf("quarantine dropped after generation bump: quarantined=%v state=%s", record.Quarantined, record.State)
	}
	if !strings.Contains(record.LastError, "exit status 23") {
		t.Fatalf("quarantine lost the cause: %q", record.LastError)
	}
}
func TestRealProcessFaultsAreQuarantined(t *testing.T) {
	for _, mode := range []string{"crash", "hang-init", "hang-heartbeat", "malformed", "flood", "stderr"} {
		t.Run(mode, func(t *testing.T) {
			m := testManager(t)
			status := installFixture(t, m, "test.failure", mode)
			enableFixture(t, m, status.Manifest.ID)
			if err := m.Start(context.Background()); err != nil {
				t.Fatal(err)
			}
			fault := waitState(t, m, status.Manifest.ID, StateFaulted)
			if fault.LastError == "" || !fault.DesiredEnabled {
				t.Fatal("fault did not preserve actionable intent")
			}
			waitFor(t, "failed process reaped", func() bool { m.mu.Lock(); defer m.mu.Unlock(); return len(m.instances) == 0 })
			state, err := m.loadState()
			if err != nil {
				t.Fatal(err)
			}
			if !state.Records[status.Manifest.ID].Quarantined {
				t.Fatal("quarantine not durable")
			}
			if err = m.Close(context.Background()); err != nil {
				t.Fatal(err)
			}
			next := managerAt(t, m.root)
			if err = next.Start(context.Background()); err != nil {
				t.Fatal(err)
			}
			current := waitState(t, next, status.Manifest.ID, StateFaulted)
			if current.Generation != fault.Generation {
				t.Fatal("quarantined plugin restarted")
			}
		})
	}
}
func TestDisableNeverWaitsForBusyPlugin(t *testing.T) {
	m := testManager(t)
	status := installFixture(t, m, "test.hang", "ignore-cancel")
	enableFixture(t, m, status.Manifest.ID)
	if err := m.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitState(t, m, status.Manifest.ID, StateRunning)
	var calls sync.WaitGroup
	calls.Add(2)
	for i := 0; i < 2; i++ {
		go func() { defer calls.Done(); m.Invoke(context.Background(), status.Manifest.ID, "echo", nil) }()
	}
	waitFor(t, "all invocation slots busy", func() bool {
		m.mu.Lock()
		defer m.mu.Unlock()
		inst := m.instances[status.Manifest.ID]
		return inst != nil && inst.inflight == 2
	})
	if _, err := m.Invoke(context.Background(), status.Manifest.ID, "echo", nil); !errors.Is(err, ErrBusy) {
		t.Fatalf("unbounded concurrency: %v", err)
	}
	started := time.Now()
	if _, err := m.SetEnabled(context.Background(), status.Manifest.ID, false); err != nil {
		t.Fatal(err)
	}
	// 这个断言要证明的是「disable 没有等待插件里的长任务」，不是测调度精度。
	// Windows CI 上 300ms 会被正常的进程启动/调度抖动打穿（实测 315ms），
	// 而真正的「等待」会等满插件的阻塞时长（秒级），两者相差一个数量级。
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("disable waited on plugin: %s", elapsed)
	}
	if _, err := m.AssetPath(status.Manifest.ID, "asset.txt"); !errors.Is(err, ErrDisabled) {
		t.Fatalf("disabled assets still exposed: %v", err)
	}
	calls.Wait()
	waitFor(t, "hung process reaped", func() bool { m.mu.Lock(); defer m.mu.Unlock(); return len(m.instances) == 0 })
}
func TestDisableTerminatesDescendant(t *testing.T) {
	m := testManager(t)
	status := installFixture(t, m, "test.tree", "spawn-child")
	enableFixture(t, m, status.Manifest.ID)
	if err := m.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitState(t, m, status.Manifest.ID, StateRunning)
	var childPID int
	waitFor(t, "descendant started", func() bool {
		content, err := os.ReadFile(filepath.Join(m.root, "data", status.Manifest.ID, "child.pid"))
		if err != nil {
			return false
		}
		childPID, err = strconv.Atoi(string(content))
		return err == nil && processAlive(childPID)
	})
	if _, err := m.SetEnabled(context.Background(), status.Manifest.ID, false); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "descendant killed", func() bool { return !processAlive(childPID) })
}
func TestCrossProcessDesiredState(t *testing.T) {
	m := testManager(t)
	status := installFixture(t, m, "test.external", "echo")
	enableFixture(t, m, status.Manifest.ID)
	if err := m.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitState(t, m, status.Manifest.ID, StateRunning)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(executable, "-test.run=^TestExternalController$", "--", m.root, status.Manifest.ID)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("external disable: %v %s", err, output)
	}
	waitState(t, m, status.Manifest.ID, StateDisabled)
	waitFor(t, "external intent reaped process", func() bool { m.mu.Lock(); defer m.mu.Unlock(); return len(m.instances) == 0 })
}
func TestExternalController(t *testing.T) {
	root, id := "", ""
	for i, arg := range os.Args {
		if arg == "--" && i+2 < len(os.Args) {
			root, id = os.Args[i+1], os.Args[i+2]
			break
		}
	}
	if root == "" {
		return
	}
	m, err := NewManager(Options{Root: root})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close(context.Background())
	if err = m.Start(context.Background()); !errors.Is(err, ErrLocked) {
		t.Fatalf("second owner allowed: %v", err)
	}
	if _, err = m.SetEnabled(context.Background(), id, false); err != nil {
		t.Fatal(err)
	}
}
