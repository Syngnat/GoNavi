package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/plugin"
	"GoNavi-Wails/internal/secretstore"
)

func newPluginTestApp(t *testing.T) *App {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	a := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	a.configDir = t.TempDir()
	a.ctx = ctx
	t.Cleanup(func() { a.shutdownPlugins(); cancel() })
	return a
}

func writePluginTestPackage(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	manifest := plugin.Manifest{SchemaVersion: 1, APIVersion: 1, ID: "test.panel", Name: "Test panel", Version: "1.0.0", Permissions: []string{}, Contributes: plugin.Contributions{Panels: []plugin.Panel{{ID: "hello", Title: "Hello", Body: plugin.UINode{Type: "text", Text: "Hello"}}}}}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "gonavi.plugin.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}

func installPluginTestPackage(t *testing.T, a *App) string {
	t.Helper()
	path := writePluginTestPackage(t)
	inspected := a.PluginInspect(path)
	if !inspected.Success {
		t.Fatalf("inspect failed: %+v", inspected)
	}
	snapshot, ok := inspected.Data.(plugin.Inspection)
	if !ok {
		t.Fatalf("unexpected inspection %T", inspected.Data)
	}
	if result := a.PluginInstall(path, snapshot.Digest, true); !result.Success {
		t.Fatalf("install failed: %+v", result)
	}
	return snapshot.Manifest.ID
}

func TestPluginBindingsInstallEnableDisableWithoutRestart(t *testing.T) {
	a := newPluginTestApp(t)
	id := installPluginTestPackage(t, a)
	if result := a.PluginSetEnabled(id, true); !result.Success {
		t.Fatalf("enable: %+v", result)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		list := a.PluginList()
		if !list.Success {
			t.Fatalf("list: %+v", list)
		}
		statuses := list.Data.([]plugin.Status)
		if len(statuses) == 1 && statuses[0].State == plugin.StateRunning {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("not running: %+v", statuses)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if result := a.PluginSetEnabled(id, false); !result.Success {
		t.Fatalf("disable: %+v", result)
	}
	if result := a.PluginInvoke(id, "undeclared", "{}"); result.Success {
		t.Fatal("disabled invocation succeeded")
	}
	if result := a.PluginSetEnabled(id, true); !result.Success {
		t.Fatalf("reenable: %+v", result)
	}
}

func TestPluginWebManagementFailsClosedBeforeFilesystemAccess(t *testing.T) {
	a := newPluginTestApp(t)
	a.webRuntime = true
	calls := map[string]func() connection.QueryResult{
		"inspect": func() connection.QueryResult { return a.PluginInspect("not-a-path") },
		"install": func() connection.QueryResult { return a.PluginInstall("not-a-path", "invalid", true) },
		"replace": func() connection.QueryResult { return a.PluginReplace("not-a-path", "invalid", true) },
		"enable":  func() connection.QueryResult { return a.PluginSetEnabled("test.panel", true) },
		"disable": func() connection.QueryResult { return a.PluginSetEnabled("test.panel", false) },
		"remove":  func() connection.QueryResult { return a.PluginRemove("test.panel", true) },
		"invoke":  func() connection.QueryResult { return a.PluginInvoke("test.panel", "run", "{}") },
		"window":  func() connection.QueryResult { return a.PluginOpenWindow("test.panel", "", "") },
	}
	for name, call := range calls {
		t.Run(name, func(t *testing.T) {
			if result := call(); result.Success {
				t.Fatalf("web operation accepted: %s", name)
			}
		})
	}
	if _, err := os.Stat(filepath.Join(a.configDir, "plugins")); !os.IsNotExist(err) {
		t.Fatalf("denied operation touched plugin store: %v", err)
	}
}

func TestPluginFailureDoesNotLeakUntrustedDetails(t *testing.T) {
	a := newPluginTestApp(t)
	result := a.PluginInspect(filepath.Join(a.configDir, "secret-do-not-display"))
	if result.Success || strings.Contains(result.Message, "secret-do-not-display") {
		t.Fatalf("unsafe error: %+v", result)
	}
	if result = a.PluginInvoke("test.panel", "run", "not-json"); result.Success {
		t.Fatal("invalid JSON accepted")
	}
	if result = a.PluginList(); !result.Success {
		t.Fatalf("failed inspection broke management: %+v", result)
	}
}

type pluginTestWindowOpen struct {
	pluginID  string
	windowKey string
	context   json.RawMessage
}

type pluginTestWindows struct {
	mu      sync.Mutex
	revoked []string
	opened  []pluginTestWindowOpen
	closed  bool
}

func (w *pluginTestWindows) Open(_ context.Context, pluginID, windowKey string, launchContext json.RawMessage, _, _ string) (any, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.opened = append(w.opened, pluginTestWindowOpen{pluginID: pluginID, windowKey: windowKey, context: append(json.RawMessage(nil), launchContext...)})
	return map[string]any{"id": windowKey}, nil
}
func (w *pluginTestWindows) Revoke(id string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.revoked = append(w.revoked, id)
}
func (w *pluginTestWindows) Close(context.Context) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.closed = true
	return nil
}

func TestPluginDisableRevokesWindowEvenWhenPackageAlreadyMissing(t *testing.T) {
	a := newPluginTestApp(t)
	windows := &pluginTestWindows{}
	ConfigurePluginWindows(a, func(context.Context, *plugin.Manager) (PluginWindowHost, error) { return windows, nil })
	if result := a.PluginList(); !result.Success {
		t.Fatalf("list: %+v", result)
	}
	a.PluginSetEnabled("missing.plugin", false)
	windows.mu.Lock()
	defer windows.mu.Unlock()
	if len(windows.revoked) != 1 || windows.revoked[0] != "missing.plugin" {
		t.Fatalf("not revoked: %+v", windows.revoked)
	}
}

func TestPluginSafeModeRetainsManagement(t *testing.T) {
	t.Setenv("GONAVI_DISABLE_PLUGINS", "1")
	a := newPluginTestApp(t)
	id := installPluginTestPackage(t, a)
	if result := a.PluginSetEnabled(id, true); result.Success {
		t.Fatalf("safe-mode enable succeeded: %+v", result)
	}
	if result := a.PluginSetEnabled(id, false); !result.Success {
		t.Fatalf("safe-mode disable failed: %+v", result)
	}
	list := a.PluginList()
	if !list.Success {
		t.Fatalf("safe-mode list failed: %+v", list)
	}
	statuses := list.Data.([]plugin.Status)
	if len(statuses) != 1 || statuses[0].DesiredEnabled {
		t.Fatalf("safe-mode enable changed intent: %+v", statuses)
	}
	if result := a.PluginInvoke(id, "run", "{}"); result.Success {
		t.Fatal("safe-mode invocation succeeded")
	}
	info := a.PluginRuntimeInfo()
	flags, ok := info.Data.(map[string]bool)
	if !info.Success || !ok || !flags["safeMode"] || !flags["managementAllowed"] {
		t.Fatalf("runtime info: %+v", info)
	}
	a.webRuntime = true
	info = a.PluginRuntimeInfo()
	flags, ok = info.Data.(map[string]bool)
	if !info.Success || !ok || !flags["safeMode"] || flags["managementAllowed"] {
		t.Fatalf("web runtime info: %+v", info)
	}
}
