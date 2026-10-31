package app

import (
	"context"
	"encoding/json"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/plugin"
)

func TestPluginCapabilitySQLClassify(t *testing.T) {
	a := newPluginTestApp(t)
	if _, err := a.savedConnectionRepository().Save(connection.SavedConnectionInput{
		ID: "classify-1", Name: "Classify",
		Config: connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306},
	}); err != nil {
		t.Fatal(err)
	}
	status := plugin.Status{
		Manifest:       pluginPageTestManifest("test.classify", plugin.QueryReadPermission),
		Generation:     1,
		State:          plugin.StateRunning,
		DesiredEnabled: true,
	}
	for _, test := range []struct {
		sql       string
		operation string
		readOnly  bool
	}{
		{"select 1", "query", true},
		{"delete from t where id = 1", "dml", false},
		{"create table t (id int)", "ddl", false},
	} {
		arguments, _ := json.Marshal(map[string]string{"connectionId": "classify-1", "sql": test.sql})
		raw, err := a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "sql.classify", arguments)
		if err != nil {
			t.Fatal(err)
		}
		ok, code := decodePluginCapabilityEnvelope(t, raw)
		if !ok || code != "" {
			t.Fatalf("%s envelope: %s", test.sql, raw)
		}
		var envelope struct {
			Data pluginCapabilitySQLClassifyResult `json:"data"`
		}
		if err := json.Unmarshal(raw, &envelope); err != nil {
			t.Fatal(err)
		}
		value := envelope.Data
		if value.Operation != test.operation || value.ReadOnly != test.readOnly {
			t.Fatalf("%s = %+v", test.sql, value)
		}
	}
	arguments, _ := json.Marshal(map[string]string{"connectionId": "classify-1", "sql": "select 1; select 2"})
	raw, err := a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "sql.classify", arguments)
	if err != nil {
		t.Fatal(err)
	}
	ok, code := decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "invalid_arguments" {
		t.Fatalf("multi statement envelope: %s", raw)
	}
	status.Manifest = pluginPageTestManifest("test.classify", "")
	raw, err = a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "sql.classify", arguments)
	if err != nil {
		t.Fatal(err)
	}
	ok, code = decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "permission_denied" {
		t.Fatalf("missing permission envelope: %s", raw)
	}
}
