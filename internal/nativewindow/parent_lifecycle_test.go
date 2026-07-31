package nativewindow

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"
)

const (
	parentLifecycleHelperModeEnv = "GONAVI_TEST_PARENT_LIFECYCLE_MODE"
	parentLifecycleReadyEnv      = "GONAVI_TEST_PARENT_LIFECYCLE_READY"
	parentLifecycleExitedEnv     = "GONAVI_TEST_PARENT_LIFECYCLE_EXITED"
)

func TestDetachedParentWatcherStopsAfterRealParentExit(t *testing.T) {
	switch os.Getenv(parentLifecycleHelperModeEnv) {
	case "parent":
		runDetachedParentLifecycleHelperParent(t)
		return
	case "child":
		runDetachedParentLifecycleHelperChild(t)
		return
	}

	tempDir := t.TempDir()
	readyPath := filepath.Join(tempDir, "ready")
	exitedPath := filepath.Join(tempDir, "exited")
	command := exec.Command(os.Args[0], "-test.run=^TestDetachedParentWatcherStopsAfterRealParentExit$")
	command.Env = parentLifecycleHelperEnvironment("parent", readyPath, exitedPath)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("run detached parent helper: %v\n%s", err, output)
	}
	if !waitForParentLifecycleFile(exitedPath, 5*time.Second) {
		t.Fatal("detached child did not stop after the real parent process exited")
	}
}

func runDetachedParentLifecycleHelperParent(t *testing.T) {
	readyPath := os.Getenv(parentLifecycleReadyEnv)
	exitedPath := os.Getenv(parentLifecycleExitedEnv)
	command := exec.Command(os.Args[0], "-test.run=^TestDetachedParentWatcherStopsAfterRealParentExit$")
	command.Env = parentLifecycleHelperEnvironment("child", readyPath, exitedPath)
	if err := command.Start(); err != nil {
		t.Fatalf("start detached child helper: %v", err)
	}
	if !waitForParentLifecycleFile(readyPath, 5*time.Second) {
		_ = command.Process.Kill()
		_, _ = command.Process.Wait()
		t.Fatal("detached child helper did not become ready")
	}
	// Returning ends this helper process without waiting for the detached child.
}

func runDetachedParentLifecycleHelperChild(t *testing.T) {
	watcher, err := newDetachedParentWatcher(os.Getppid())
	if err != nil {
		t.Fatalf("create real detached parent watcher: %v", err)
	}
	readyPath := os.Getenv(parentLifecycleReadyEnv)
	if err := os.WriteFile(readyPath, []byte("ready"), 0o600); err != nil {
		t.Fatalf("mark detached child helper ready: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	monitorDetachedParent(ctx, watcher, 10*time.Millisecond, func() {
		if err := os.WriteFile(os.Getenv(parentLifecycleExitedEnv), []byte("exited"), 0o600); err != nil {
			t.Errorf("mark detached child helper exited: %v", err)
		}
	})
	if ctx.Err() != nil {
		t.Fatal("real detached parent watcher timed out")
	}
}

func parentLifecycleHelperEnvironment(mode string, readyPath string, exitedPath string) []string {
	environment := setEnvironmentValue(os.Environ(), parentLifecycleHelperModeEnv, mode)
	environment = setEnvironmentValue(environment, parentLifecycleReadyEnv, readyPath)
	return setEnvironmentValue(environment, parentLifecycleExitedEnv, exitedPath)
}

func waitForParentLifecycleFile(path string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

func TestDetachedProcessSpecUsesCurrentParentPID(t *testing.T) {
	t.Setenv(envParentPID, "999999")
	manager := &Manager{endpoint: "http://127.0.0.1:43119", token: "test-token"}
	spec := manager.processSpecLocked(OpenRequest{ID: "window-1", Kind: "workbench"})

	if got, want := environmentValue(spec.Env, envParentPID), strconv.Itoa(os.Getpid()); got != want {
		t.Fatalf("detached parent PID = %q, want %q", got, want)
	}
}

func TestDetachedParentWatcherReportsCurrentParentAlive(t *testing.T) {
	watcher, err := newDetachedParentWatcher(os.Getppid())
	if err != nil {
		t.Fatalf("create detached parent watcher: %v", err)
	}
	defer watcher.Close()

	alive, err := watcher.Alive()
	if err != nil {
		t.Fatalf("probe current parent process: %v", err)
	}
	if !alive {
		t.Fatal("current parent process was reported as exited")
	}
}

type parentLivenessResult struct {
	alive bool
	err   error
}

type scriptedParentWatcher struct {
	mu        sync.Mutex
	results   []parentLivenessResult
	checks    int
	closed    bool
	checkedCh chan struct{}
}

func (w *scriptedParentWatcher) Alive() (bool, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.checks++
	if w.checkedCh != nil {
		select {
		case w.checkedCh <- struct{}{}:
		default:
		}
	}
	if len(w.results) == 0 {
		return true, nil
	}
	result := w.results[0]
	if len(w.results) > 1 {
		w.results = w.results[1:]
	}
	return result.alive, result.err
}

func (w *scriptedParentWatcher) Close() error {
	w.mu.Lock()
	w.closed = true
	w.mu.Unlock()
	return nil
}

func TestMonitorDetachedParentExitsAfterParentDies(t *testing.T) {
	watcher := &scriptedParentWatcher{results: []parentLivenessResult{
		{alive: true},
		{alive: false},
	}}
	exited := make(chan struct{})
	done := make(chan struct{})
	go func() {
		monitorDetachedParent(context.Background(), watcher, time.Millisecond, func() {
			close(exited)
		})
		close(done)
	}()

	select {
	case <-exited:
	case <-time.After(time.Second):
		t.Fatal("detached child did not exit after its parent died")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("parent monitor did not stop after detecting parent exit")
	}

	watcher.mu.Lock()
	defer watcher.mu.Unlock()
	if watcher.checks != 2 {
		t.Fatalf("parent liveness checks = %d, want 2", watcher.checks)
	}
	if !watcher.closed {
		t.Fatal("parent watcher was not closed")
	}
}

func TestMonitorDetachedParentKeepsChildOnProbeError(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	watcher := &scriptedParentWatcher{
		results:   []parentLivenessResult{{err: errors.New("temporary probe failure")}},
		checkedCh: make(chan struct{}, 1),
	}
	exited := make(chan struct{})
	done := make(chan struct{})
	go func() {
		monitorDetachedParent(ctx, watcher, time.Millisecond, func() {
			close(exited)
		})
		close(done)
	}()

	select {
	case <-watcher.checkedCh:
	case <-time.After(time.Second):
		t.Fatal("parent liveness was not checked")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("parent monitor did not stop after cancellation")
	}
	select {
	case <-exited:
		t.Fatal("temporary parent probe error caused detached child exit")
	default:
	}

	watcher.mu.Lock()
	defer watcher.mu.Unlock()
	if !watcher.closed {
		t.Fatal("parent watcher was not closed after cancellation")
	}
}
