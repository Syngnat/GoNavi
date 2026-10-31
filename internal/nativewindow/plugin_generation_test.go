package nativewindow

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestPluginRevokeFencesAnOpeningWindow(t *testing.T) {
	c, runtime := newPluginTestController(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	runtime.beforeAsset = func() { close(entered); <-release }
	// A one-result buffer lets the goroutine finish even if an assertion fails.
	result := make(chan error, 1)
	go func() { _, err := c.Open(context.Background(), "test.one", "test.one", nil, "", ""); result <- err }()
	<-entered
	c.Revoke("test.one")
	close(release)
	if err := <-result; err == nil {
		t.Fatal("window admitted after its opening generation was revoked")
	}
	c.mu.Lock()
	count := len(c.windows)
	c.mu.Unlock()
	if count != 0 {
		t.Fatal("revoked admission launched a process")
	}
}

func TestPluginRevokeDoesNotNeedRuntimeLock(t *testing.T) {
	c, runtime := newPluginTestController(t)
	entry := openPluginTestWindow(t, c, "test.one")
	runtime.mu.Lock()
	c.Revoke("test.one")
	runtime.mu.Unlock()
	if entry.life.Err() == nil {
		t.Fatal("capability was not immediately canceled")
	}
	awaitPluginDone(t, entry.done)
}

func TestPluginWindowReinstallIdentityIsFenced(t *testing.T) {
	c, runtime := newPluginTestController(t)
	entry := openPluginTestWindow(t, c, "test.one")
	runtime.mu.Lock()
	runtime.statuses[0].InstalledAt = "reinstalled"
	runtime.mu.Unlock()
	response := servePluginTest(c, entry, http.MethodGet, pluginBridgePrefix+"bootstrap", "")
	if response.Code != http.StatusGone {
		t.Fatal("old capability reached replacement installation")
	}
	awaitPluginDone(t, entry.done)
	next := openPluginTestWindow(t, c, "test.one")
	if next.stamp.installedAt != "reinstalled" {
		t.Fatal("new installation cannot open")
	}
}

func TestPluginUserCloseAllowsExplicitReopen(t *testing.T) {
	c, _ := newPluginTestController(t)
	entry := openPluginTestWindow(t, c, "test.one")
	response := servePluginTest(c, entry, http.MethodPost, pluginBridgePrefix+"close", "{}")
	if response.Code != http.StatusNoContent {
		t.Fatal(response.Body.String())
	}
	awaitPluginDone(t, entry.done)
	next := openPluginTestWindow(t, c, "test.one")
	if next.info.ID == entry.info.ID {
		t.Fatal("closed child capability was reused")
	}
}

func TestPluginReloadCanRestartDocumentHeartbeatSequence(t *testing.T) {
	c, _ := newPluginTestController(t)
	entry := openPluginTestWindow(t, c, "test.one")
	if response := servePluginTest(c, entry, http.MethodPost, pluginBridgePrefix+"heartbeat", `{"sequence":100}`); response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	if response := servePluginTest(c, entry, http.MethodGet, pluginBridgePrefix+"bootstrap", ""); response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	if response := servePluginTest(c, entry, http.MethodPost, pluginBridgePrefix+"heartbeat", `{"sequence":1}`); response.Code != 200 {
		t.Fatal("reload heartbeat rejected")
	}
}

func TestPluginWindowTeardownFencesReopen(t *testing.T) {
	c, _ := newPluginTestController(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	released := false
	defer func() {
		if !released {
			close(release)
		}
	}()
	c.onWindowClosed = func(context.Context, PluginWindowInfo) {
		select {
		case <-entered:
		default:
			close(entered)
		}
		<-release
	}
	entry := openPluginTestWindow(t, c, "test.one")
	entry.process.(*pluginProcessFake).exit()
	awaitPluginDone(t, entered)
	if _, err := c.Open(context.Background(), "test.one", "test.one", nil, "", ""); err == nil {
		t.Fatal("reopened generation before its previous teardown completed")
	}
	select {
	case <-entry.done:
		t.Fatal("window cleanup completed while its teardown was blocked")
	default:
	}
	close(release)
	released = true
	awaitPluginDone(t, entry.done)
	next := openPluginTestWindow(t, c, "test.one")
	if next.info.ID == entry.info.ID || next.info.Generation != entry.info.Generation {
		t.Fatal("same generation did not receive a fresh window after teardown")
	}
}

func TestPluginWindowTeardownKeepsExitedGeneration(t *testing.T) {
	for _, mode := range []string{"restart", "remove", "revoke"} {
		t.Run(mode, func(t *testing.T) {
			c, runtime := newPluginTestController(t)
			entered := make(chan struct{})
			release := make(chan struct{})
			released := false
			defer func() {
				if !released {
					close(release)
				}
			}()
			var closedInfo PluginWindowInfo
			var teardownErr error
			invocations := 0
			runtime.invoke = func(context.Context, string, uint64, string, json.RawMessage) (json.RawMessage, error) {
				invocations++
				return nil, nil
			}
			c.onWindowClosed = func(ctx context.Context, info PluginWindowInfo) {
				closedInfo = info
				close(entered)
				<-release
				_, teardownErr = runtime.InvokeGeneration(ctx, info.PluginID, info.Generation, "session.teardown", nil)
			}
			entry := openPluginTestWindow(t, c, "test.one")
			entry.process.(*pluginProcessFake).exit()
			awaitPluginDone(t, entered)
			runtime.mu.Lock()
			switch mode {
			case "restart":
				runtime.statuses[0].Generation++
			case "remove":
				runtime.statuses = nil
			case "revoke":
				runtime.statuses[0].DesiredEnabled = false
			}
			runtime.mu.Unlock()
			if mode == "revoke" {
				c.Revoke("test.one")
			}
			if closedInfo != entry.info || closedInfo.Generation != 1 {
				t.Fatalf("closed window identity = %+v, want %+v", closedInfo, entry.info)
			}
			close(release)
			released = true
			awaitPluginDone(t, entry.done)
			if teardownErr == nil || invocations != 0 {
				t.Fatalf("stale teardown reached current runtime: calls=%d err=%v", invocations, teardownErr)
			}
			c.mu.Lock()
			c.onWindowClosed = nil
			c.mu.Unlock()
			if mode == "restart" {
				next := openPluginTestWindow(t, c, "test.one")
				if next.info.Generation != 2 {
					t.Fatal("replacement generation could not open after old teardown")
				}
			}
		})
	}
}
