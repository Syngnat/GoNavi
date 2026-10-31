package app

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/plugin"
)

func runningSchemaWriteStatus(t *testing.T, a *App, id string) plugin.Status {
	t.Helper()
	installAndEnablePluginPage(t, a, id, plugin.PagesPermission, plugin.SchemaWritePermission)
	status, code := a.pluginCapabilityStatus(a.ctx, id, 0)
	if code != "" {
		t.Fatal(code)
	}
	return status
}

func TestPluginSchemaApplyRechecksAuthorityAfterConfirmation(t *testing.T) {
	for _, name := range []string{"generation", "permission", "connection_protection"} {
		t.Run(name, func(t *testing.T) {
			a := newPluginTestApp(t)
			database := &fakeBatchWriteDB{}
			original := newDatabaseFunc
			newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
			t.Cleanup(func() { newDatabaseFunc = original })
			config := connection.ConnectionConfig{Type: "postgres", Host: "db.internal"}
			save := func() {
				t.Helper()
				if _, err := a.savedConnectionRepository().Save(connection.SavedConnectionInput{ID: "authority-schema", Name: "Authority", Config: config}); err != nil {
					t.Fatal(err)
				}
			}
			save()
			status := runningSchemaWriteStatus(t, a, "test.schema.authority")
			if name == "permission" {
				// A stale authorization snapshot must not override the live permission set.
				id := installAndEnablePluginPage(t, a, "test.schema.no-write", plugin.PagesPermission)
				live, code := a.pluginCapabilityStatus(a.ctx, id, 0)
				if code != "" {
					t.Fatal(code)
				}
				status = live
				status.Manifest.Permissions = append(status.Manifest.Permissions, plugin.SchemaWritePermission)
			}
			planID := a.schemaWritePlans.put(schemaWritePlan{connectionID: "authority-schema", statements: []string{"CREATE TABLE unauthorized (id INT)"}, expiresAt: time.Now().Add(time.Minute)})
			a.schemaConfirm = func(context.Context, string) (bool, error) {
				switch name {
				case "generation":
					manager, err := a.pluginManager(a.ctx)
					if err != nil {
						t.Fatal(err)
					}
					if _, err := manager.SetEnabled(a.ctx, status.Manifest.ID, false); err != nil {
						t.Fatal(err)
					}
					enablePluginPageTestPackage(t, a, status.Manifest.ID)
				case "connection_protection":
					config.Protection.RestrictStructureEdit = true
					save()
				}
				return true, nil
			}
			args, err := json.Marshal(pluginCapabilitySchemaApplyArguments{PlanID: planID})
			if err != nil {
				t.Fatal(err)
			}
			raw, err := a.pluginCapabilityCall(a.ctx, status, pluginCapabilityChannelWindow, "schema.apply", args)
			if err != nil {
				t.Fatal(err)
			}
			want := map[string]string{"generation": "not_running", "permission": "permission_denied", "connection_protection": "read_only"}[name]
			if ok, code := decodePluginCapabilityEnvelope(t, raw); ok || code != want {
				t.Errorf("authority change must fail with %s: %s", want, raw)
			}
			if database.execCalls != 0 {
				t.Fatalf("revoked authority dispatched %d DDL statements", database.execCalls)
			}
		})
	}
}
