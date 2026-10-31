package app

import (
	"context"
	"encoding/json"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/plugin"
)

func TestPluginCapabilityExplainValidatesArgumentsAndPermission(t *testing.T) {
	a := newPluginTestApp(t)
	status := plugin.Status{
		Manifest:       pluginPageTestManifest("test.explain", plugin.QueryReadPermission),
		Generation:     1,
		State:          plugin.StateRunning,
		DesiredEnabled: true,
	}
	raw, err := a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "query.explain", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code := decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "invalid_arguments" {
		t.Fatalf("empty envelope: %s", raw)
	}
	if _, err = a.savedConnectionRepository().Save(connection.SavedConnectionInput{
		ID: "explain-1", Name: "Explain",
		Config: connection.ConnectionConfig{Type: "test-unsupported", Host: "127.0.0.1", Port: 1},
	}); err != nil {
		t.Fatal(err)
	}
	raw, err = a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "query.explain", json.RawMessage(`{"connectionId":"explain-1","sql":"delete from t"}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code = decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "invalid_arguments" {
		t.Fatalf("unsafe sql envelope: %s", raw)
	}
	status.Manifest = pluginPageTestManifest("test.explain", "")
	raw, err = a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "query.explain", json.RawMessage(`{"connectionId":"explain-1","sql":"select 1"}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code = decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "permission_denied" {
		t.Fatalf("missing permission envelope: %s", raw)
	}
}
