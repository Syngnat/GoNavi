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

func TestPluginRunConnectionActionPageTargetReturnsTabWithoutWindow(t *testing.T) {
	a := newPluginTestApp(t)
	windows := &pluginTestWindows{}
	ConfigurePluginWindows(a, func(context.Context, *plugin.Manager) (PluginWindowHost, error) { return windows, nil })

	root := t.TempDir()
	body := plugin.UINode{Type: "text", Text: "shell"}
	manifest := plugin.Manifest{
		SchemaVersion: 1, APIVersion: 1, ID: "test.page-action", Name: "Page action", Version: "1.0.0",
		Permissions: []string{plugin.PagesPermission},
		Contributes: plugin.Contributions{
			Pages: []plugin.Page{{ID: "shell", Title: "MongoShell tab", Body: &body}},
			ConnectionActions: []plugin.ConnectionAction{{
				ID: "open-shell", Title: "Open shell", ConnectionTypes: []string{"mongodb"},
				Scopes: []string{"connection", "database"}, Target: plugin.LaunchTarget{Type: "page", Page: "shell"},
			}},
		},
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "gonavi.plugin.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	inspected := a.PluginInspect(root)
	if !inspected.Success {
		t.Fatalf("inspect: %+v", inspected)
	}
	snapshot := inspected.Data.(plugin.Inspection)
	if result := a.PluginInstall(root, snapshot.Digest, true); !result.Success {
		t.Fatalf("install: %+v", result)
	}
	if result := a.PluginSetEnabled(manifest.ID, true); !result.Success {
		t.Fatalf("enable: %+v", result)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		statuses := a.PluginList().Data.([]plugin.Status)
		if len(statuses) == 1 && statuses[0].State == plugin.StateRunning {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("plugin did not run: %+v", statuses)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err = a.savedConnectionRepository().Save(connection.SavedConnectionInput{
		ID: "mongo-local", Name: "Local Mongo",
		Config: connection.ConnectionConfig{Type: "mongodb", Host: "127.0.0.1", Port: 27017},
	}); err != nil {
		t.Fatal(err)
	}
	result := a.PluginRunConnectionAction(manifest.ID, "open-shell", "mongo-local", "app", "")
	if !result.Success {
		t.Fatalf("page action failed: %+v", result)
	}
	data, ok := result.Data.(map[string]any)
	if !ok || data["kind"] != "page" || data["pageId"] != "shell" || data["title"] != "MongoShell tab" {
		t.Fatalf("page result: %#v", result.Data)
	}
	launch, ok := data["launch"].(pluginConnectionActionContext)
	if !ok {
		t.Fatalf("launch type: %T", data["launch"])
	}
	if launch.Config != nil || launch.ConnectionID != "mongo-local" || launch.Database != "app" {
		t.Fatalf("page launch leaked config or lost identity: %+v", launch)
	}
	windows.mu.Lock()
	defer windows.mu.Unlock()
	if len(windows.opened) != 0 {
		t.Fatalf("page target opened a window: %+v", windows.opened)
	}
}
