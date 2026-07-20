package singleinstance

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func uniqueName(t *testing.T) string {
	t.Helper()
	return "test-" + filepath.Base(t.Name()) + "-" + time.Now().Format("150405.000")
}

func TestAcquireReleaseAndSecondInstance(t *testing.T) {
	name := uniqueName(t)
	_ = os.Remove(endpointFilePath(name))

	first := Acquire(name, nil)
	if !first.Acquired {
		t.Fatalf("first acquire failed: %v", first.AcquireErr)
	}
	defer first.Handle.Close()

	received := make(chan ActivationMessage, 1)
	if err := first.Handle.Listen(name, func(message ActivationMessage) error {
		received <- message
		return nil
	}); err != nil {
		t.Fatalf("listen: %v", err)
	}

	second := Acquire(name, []string{"demo.sql"})
	if second.Acquired {
		t.Fatal("second instance should not acquire lock")
	}
	if second.AcquireErr != nil {
		t.Fatalf("second acquire unexpected error: %v", second.AcquireErr)
	}
	if second.NotifyErr != nil {
		t.Fatalf("notify failed: %v", second.NotifyErr)
	}

	select {
	case msg := <-received:
		if len(msg.Args) != 1 || msg.Args[0] != "demo.sql" {
			t.Fatalf("unexpected message: %#v", msg)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("did not receive activation")
	}
}

func TestSecondInstanceWaitsForDelayedListener(t *testing.T) {
	name := uniqueName(t)
	_ = os.Remove(endpointFilePath(name))

	primary := Acquire(name, nil)
	if !primary.Acquired {
		t.Fatalf("primary acquire failed: %v", primary.AcquireErr)
	}
	defer primary.Handle.Close()

	received := make(chan ActivationMessage, 1)
	done := make(chan error, 1)
	go func() {
		// 模拟冷启动：先拿到锁，稍后再 Listen。
		time.Sleep(150 * time.Millisecond)
		done <- primary.Handle.Listen(name, func(message ActivationMessage) error {
			received <- message
			return nil
		})
	}()

	second := Acquire(name, []string{"cold.sql"})
	if second.Acquired {
		t.Fatal("second should not acquire")
	}
	if second.NotifyErr != nil {
		t.Fatalf("notify should succeed after retry: %v", second.NotifyErr)
	}
	if err := <-done; err != nil {
		t.Fatalf("listen failed: %v", err)
	}
	select {
	case msg := <-received:
		if len(msg.Args) != 1 || msg.Args[0] != "cold.sql" {
			t.Fatalf("unexpected message: %#v", msg)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("activation not received")
	}
}

func TestEndpointLifecycle(t *testing.T) {
	name := uniqueName(t)
	path := endpointFilePath(name)
	_ = os.Remove(path)

	h := Acquire(name, nil)
	if !h.Acquired {
		t.Fatalf("acquire failed: %v", h.AcquireErr)
	}
	if err := h.Handle.Listen(name, func(ActivationMessage) error { return nil }); err != nil {
		t.Fatalf("listen: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("endpoint missing: %v", err)
	}
	if err := h.Handle.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	// Close 后 endpoint 应被清理（Windows/Unix Release 都会 removeEndpoint）。
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("endpoint still exists after close: %v", err)
	}
}

func TestAcquireLockFailureDoesNotFailOpen(t *testing.T) {
	originalAcquireLock := platformAcquireLock
	t.Cleanup(func() { platformAcquireLock = originalAcquireLock })
	wantErr := errors.New("lock infrastructure unavailable")
	platformAcquireLock = func(string) (platformLock, error) {
		return nil, wantErr
	}

	result := Acquire(uniqueName(t), nil)
	if result.Acquired || result.Handle != nil {
		t.Fatalf("lock failure unexpectedly allowed GUI startup: %#v", result)
	}
	if !errors.Is(result.AcquireErr, wantErr) {
		t.Fatalf("AcquireErr = %v, want %v", result.AcquireErr, wantErr)
	}
}

func TestCloseIsIdempotent(t *testing.T) {
	name := uniqueName(t)
	h := Acquire(name, nil)
	if !h.Acquired {
		t.Fatalf("acquire failed: %v", h.AcquireErr)
	}
	if err := h.Handle.Close(); err != nil {
		t.Fatalf("first close: %v", err)
	}
	if err := h.Handle.Close(); err != nil {
		t.Fatalf("second close: %v", err)
	}
}

func TestEmptyNameFallsBack(t *testing.T) {
	if got := normalizeName(""); got != defaultName {
		t.Fatalf("normalize empty = %q", got)
	}
	if got := normalizeName("  "); got != defaultName {
		t.Fatalf("normalize spaces = %q", got)
	}
}

func TestRuntimeDirWritable(t *testing.T) {
	dir := runtimeDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir runtime dir: %v", err)
	}
	path := filepath.Join(dir, "probe-"+uniqueName(t))
	if err := os.WriteFile(path, []byte("ok"), 0o600); err != nil {
		t.Fatalf("write runtime dir: %v", err)
	}
	_ = os.Remove(path)
}
