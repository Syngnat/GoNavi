package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/plugin"
)

// newPluginPageTestApp keeps the secret store working because the connection
// capability must resolve saved credentials without ever returning them.
func newPluginPageTestApp(t *testing.T) *App {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	a := NewAppWithSecretStore(newFakeAppSecretStore())
	a.configDir = t.TempDir()
	a.ctx = ctx
	a.activateSQLAudit()
	t.Cleanup(func() {
		a.closeSQLAuditStore()
		a.shutdownPlugins()
		cancel()
	})
	return a
}

func pluginPageTestManifest(id string, permissions ...string) plugin.Manifest {
	body := plugin.UINode{Type: "text", Text: "hello"}
	return plugin.Manifest{
		SchemaVersion: 1,
		APIVersion:    1,
		ID:            id,
		Name:          "Test pages",
		Version:       "1.2.3",
		Permissions:   permissions,
		Contributes: plugin.Contributions{
			Pages: []plugin.Page{{ID: "overview", Title: "Overview", Body: &body}},
			Navigation: []plugin.Navigation{{
				ID:       "overview-tools",
				Title:    "Overview",
				Page:     "overview",
				Location: plugin.PageLocationTools,
			}},
		},
	}
}

func pluginPageFullPermissions() []string {
	return []string{
		plugin.PagesPermission,
		plugin.ConnectionsReadPermission,
		plugin.MetadataReadPermission,
		plugin.QueryReadPermission,
	}
}

func writePluginPageTestPackage(t *testing.T, manifest plugin.Manifest) string {
	t.Helper()
	root := t.TempDir()
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "gonavi.plugin.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}

func installPluginPageTestPackage(t *testing.T, a *App, manifest plugin.Manifest) string {
	t.Helper()
	path := writePluginPageTestPackage(t, manifest)
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
	return manifest.ID
}

func enablePluginPageTestPackage(t *testing.T, a *App, id string) {
	t.Helper()
	if result := a.PluginSetEnabled(id, true); !result.Success {
		t.Fatalf("enable failed: %+v", result)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		list := a.PluginList()
		if !list.Success {
			t.Fatalf("list failed: %+v", list)
		}
		for _, status := range list.Data.([]plugin.Status) {
			if status.Manifest.ID == id && status.DesiredEnabled && status.State == plugin.StateRunning {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("plugin %s did not reach running", id)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func installAndEnablePluginPage(t *testing.T, a *App, id string, permissions ...string) string {
	t.Helper()
	installed := installPluginPageTestPackage(t, a, pluginPageTestManifest(id, permissions...))
	enablePluginPageTestPackage(t, a, installed)
	return installed
}

func requirePluginPageFailure(t *testing.T, result connection.QueryResult, code string) {
	t.Helper()
	if result.Success {
		t.Fatalf("page call succeeded: %+v", result)
	}
	data, ok := result.Data.(map[string]any)
	if !ok || data["code"] != code {
		t.Fatalf("code = %v, want %s", result.Data, code)
	}
	if result.Message == "" {
		t.Fatal("failure has no localized message")
	}
}
