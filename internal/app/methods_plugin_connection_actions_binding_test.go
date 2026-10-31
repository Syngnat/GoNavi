package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/plugin"
)

func TestPluginRunConnectionActionLaunchesWindowWithScopedContext(t *testing.T) {
	a := newPluginTestApp(t)
	windows := &pluginTestWindows{}
	ConfigurePluginWindows(a, func(context.Context, *plugin.Manager) (PluginWindowHost, error) { return windows, nil })

	root := t.TempDir()
	manifest := plugin.Manifest{
		SchemaVersion: 1, APIVersion: 1, ID: "test.mongo", Name: "MongoShell", Version: "1.0.0",
		Permissions: []string{plugin.ConnectionsCredentialsPermission},
		Window:      &plugin.Window{Entry: "index.html", Title: "MongoShell"},
		Contributes: plugin.Contributions{ConnectionActions: []plugin.ConnectionAction{{
			ID: "open-shell", Title: "MongoShell", ConnectionTypes: []string{"mongodb"},
			Scopes: []string{"connection", "database", "collection"}, Target: plugin.LaunchTarget{Type: "window"},
		}}},
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "gonavi.plugin.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "index.html"), []byte("<!doctype html><html><body>shell</body></html>"), 0o600); err != nil {
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
		list := a.PluginList()
		if !list.Success {
			t.Fatalf("list: %+v", list)
		}
		statuses := list.Data.([]plugin.Status)
		if len(statuses) == 1 && statuses[0].State == plugin.StateRunning {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("plugin did not run: %+v", statuses)
		}
		time.Sleep(10 * time.Millisecond)
	}
	repository := a.savedConnectionRepository()
	if _, err = repository.Save(connection.SavedConnectionInput{
		ID: "mongo-local", Name: "Local Mongo",
		Config: connection.ConnectionConfig{Type: "mongodb", Host: "127.0.0.1", Port: 27017, Database: "admin"},
	}); err != nil {
		t.Fatal(err)
	}
	result := a.PluginRunConnectionAction(manifest.ID, "open-shell", "mongo-local", "app", "users")
	if !result.Success {
		t.Fatalf("launch: %+v", result)
	}
	windows.mu.Lock()
	opened := append([]pluginTestWindowOpen(nil), windows.opened...)
	windows.mu.Unlock()
	if len(opened) != 1 || opened[0].pluginID != manifest.ID {
		t.Fatalf("window open: %+v", opened)
	}
	if !strings.Contains(opened[0].windowKey, "open-shell") || !strings.Contains(opened[0].windowKey, "mongo-local") {
		t.Fatalf("window key: %s", opened[0].windowKey)
	}
	var launch pluginConnectionActionContext
	if err = json.Unmarshal(opened[0].context, &launch); err != nil {
		t.Fatal(err)
	}
	if launch.Kind != "connectionAction" || launch.Database != "app" || launch.Collection != "users" ||
		launch.Config == nil || launch.Config.Host != "127.0.0.1" {
		t.Fatalf("launch context: %+v", launch)
	}
}
