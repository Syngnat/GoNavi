package app

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/plugin"
)

func TestPluginSchemaPreviewAndApplyFailClosed(t *testing.T) {
	a := newPluginTestApp(t)
	a.headlessRuntime = true
	status := plugin.Status{
		Manifest:       pluginPageTestManifest("test.schema", plugin.SchemaWritePermission),
		Generation:     1,
		State:          plugin.StateRunning,
		DesiredEnabled: true,
	}
	save := func(id string, config connection.ConnectionConfig) {
		if _, err := a.savedConnectionRepository().Save(connection.SavedConnectionInput{ID: id, Name: id, Config: config}); err != nil {
			t.Fatal(err)
		}
	}
	save("schema-1", connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306})
	save("schema-readonly", connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, ReadOnly: true})

	preview := func(sql string) (bool, string, string) {
		arguments, _ := json.Marshal(map[string]any{"connectionId": "schema-1", "database": "app", "statements": []string{sql}})
		raw, err := a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "schema.preview", arguments)
		if err != nil {
			t.Fatal(err)
		}
		ok, code := decodePluginCapabilityEnvelope(t, raw)
		var envelope struct {
			Data pluginCapabilitySchemaPreviewResult `json:"data"`
		}
		_ = json.Unmarshal(raw, &envelope)
		return ok, code, envelope.Data.PlanID
	}
	for _, sql := range []string{"select 1", "truncate table t", "drop database app", "create table t (id int); drop table t"} {
		if ok, code, _ := preview(sql); ok || code != "invalid_arguments" {
			t.Fatalf("%q should be rejected: %v %s", sql, ok, code)
		}
	}
	ok, code, planID := preview("create table t (id int)")
	if !ok || code != "" || planID == "" {
		t.Fatalf("valid preview failed: %v %s %q", ok, code, planID)
	}
	arguments, _ := json.Marshal(map[string]string{"planId": planID})
	raw, err := a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "schema.apply", arguments)
	if err != nil {
		t.Fatal(err)
	}
	if ok, code = decodePluginCapabilityEnvelope(t, raw); ok || code != "confirmation_unavailable" {
		t.Fatalf("headless apply must fail closed: %s", raw)
	}
	if ok, code, _ = preview("create table t (id int)"); !ok || code != "" {
		t.Fatal("valid preview after apply failed")
	}
	// A read-only saved connection must be rejected before a plan exists.
	readOnlyArguments, _ := json.Marshal(map[string]any{"connectionId": "schema-readonly", "statements": []string{"create table t (id int)"}})
	raw, err = a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "schema.preview", readOnlyArguments)
	if err != nil {
		t.Fatal(err)
	}
	if ok, code = decodePluginCapabilityEnvelope(t, raw); ok || code != "read_only" {
		t.Fatalf("read-only preview must fail: %s", raw)
	}
	expired := a.schemaWritePlans.put(schemaWritePlan{connectionID: "schema-1", statements: []string{"create table t (id int)"}, expiresAt: time.Now().Add(-time.Second)})
	raw, err = a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "schema.apply", json.RawMessage(`{"planId":"`+expired+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	if ok, code = decodePluginCapabilityEnvelope(t, raw); ok || code != "plan_expired" {
		t.Fatalf("expired plan must fail: %s", raw)
	}
	status.Manifest = pluginPageTestManifest("test.schema", "")
	raw, err = a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "schema.preview", readOnlyArguments)
	if err != nil {
		t.Fatal(err)
	}
	if ok, code = decodePluginCapabilityEnvelope(t, raw); ok || code != "permission_denied" {
		t.Fatalf("missing permission envelope: %s", raw)
	}
}
