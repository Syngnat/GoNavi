package app

import (
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/plugin"
)

func TestPluginConnectionActionLaunchScopesCredentials(t *testing.T) {
	a := newPluginTestApp(t)
	repository := a.savedConnectionRepository()
	if _, err := repository.Save(connection.SavedConnectionInput{
		ID:   "mongo-local",
		Name: "Local Mongo",
		Config: connection.ConnectionConfig{
			Type: "mongodb", Host: "127.0.0.1", Port: 27017, Database: "admin",
		},
		EnvironmentType: "development",
	}); err != nil {
		t.Fatal(err)
	}
	view, err := repository.Find("mongo-local")
	if err != nil {
		t.Fatal(err)
	}
	manifest := plugin.Manifest{
		SchemaVersion: 1, APIVersion: 1, ID: "test.mongo", Name: "Mongo", Version: "1.0.0",
		Permissions: []string{plugin.ConnectionsCredentialsPermission},
		Window:      &plugin.Window{Entry: "index.html"},
		Contributes: plugin.Contributions{ConnectionActions: []plugin.ConnectionAction{{
			ID: "open", Title: "MongoShell", ConnectionTypes: []string{"mongodb"},
			Scopes: []string{"connection", "database", "collection"}, Target: plugin.LaunchTarget{Type: "window"},
		}}},
	}
	status := plugin.Status{Manifest: manifest, State: plugin.StateRunning, DesiredEnabled: true}
	action := manifest.Contributes.ConnectionActions[0]
	launch, code := a.pluginConnectionActionLaunch(status, action, view, "mongodb", "app", "users", true)
	if code != "" {
		t.Fatal(code)
	}
	if launch.Kind != "connectionAction" || launch.ConnectionID != "mongo-local" || launch.Database != "app" || launch.Collection != "users" {
		t.Fatalf("unexpected launch: %+v", launch)
	}
	if launch.Config == nil || launch.Config.Host != "127.0.0.1" || launch.Config.Port != 27017 {
		t.Fatalf("credentials not scoped to permitted plugin: %+v", launch.Config)
	}
	manifest.Permissions = nil
	status.Manifest = manifest
	launch, code = a.pluginConnectionActionLaunch(status, action, view, "mongodb", "", "", true)
	if code != "" || launch.Config != nil {
		t.Fatalf("credentials leaked without permission: %+v %s", launch, code)
	}
}

func TestPluginConnectionActionTypeAndScopeMatching(t *testing.T) {
	action := plugin.ConnectionAction{
		ConnectionTypes: []string{"mongodb"},
		Scopes:          []string{"connection", "database"},
	}
	if !pluginConnectionActionAllowsType(action, "mongodb") || pluginConnectionActionAllowsType(action, "mysql") {
		t.Fatal("type matching failed")
	}
	if !pluginConnectionActionAllowsScope(action, "connection") || pluginConnectionActionAllowsScope(action, "collection") {
		t.Fatal("scope matching failed")
	}
	action.Scopes = nil
	if !pluginConnectionActionAllowsScope(action, "connection") || pluginConnectionActionAllowsScope(action, "database") {
		t.Fatal("default connection scope failed")
	}
}
