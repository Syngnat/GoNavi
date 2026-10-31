package app

import (
	"context"
	"encoding/json"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/plugin"
)

func TestPluginCapabilitySessionsUnsupportedEngineStaysOffline(t *testing.T) {
	a := newPluginTestApp(t)
	if _, err := a.savedConnectionRepository().Save(connection.SavedConnectionInput{
		ID: "sessions-1", Name: "Sessions",
		Config: connection.ConnectionConfig{Type: "test-unsupported", Host: "127.0.0.1", Port: 1},
	}); err != nil {
		t.Fatal(err)
	}
	status := plugin.Status{
		Manifest:       pluginPageTestManifest("test.sessions", plugin.QueryReadPermission),
		Generation:     1,
		State:          plugin.StateRunning,
		DesiredEnabled: true,
	}
	ctx := context.Background()
	for method := range map[string]bool{"sessions.list": true, "sessions.databases": true, "sessions.longTransactions": true, "sessions.lockWaits": true, "sessions.capabilities": true} {
		raw, err := a.pluginCapabilityCall(ctx, status, pluginCapabilityChannelWindow, method, json.RawMessage(`{"connectionId":"sessions-1"}`))
		if err != nil {
			t.Fatalf("%s: %v", method, err)
		}
		ok, code := decodePluginCapabilityEnvelope(t, raw)
		if !ok || code != "" {
			t.Fatalf("%s envelope: %s", method, raw)
		}
	}
}

func TestPluginCapabilitySessionsValidatesArgumentsAndPermission(t *testing.T) {
	a := newPluginTestApp(t)
	status := plugin.Status{
		Manifest:       pluginPageTestManifest("test.sessions", plugin.QueryReadPermission),
		Generation:     1,
		State:          plugin.StateRunning,
		DesiredEnabled: true,
	}
	raw, err := a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "sessions.list", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code := decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "invalid_arguments" {
		t.Fatalf("missing connection envelope: %s", raw)
	}
	status.Manifest = pluginPageTestManifest("test.sessions", "")
	raw, err = a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "sessions.list", json.RawMessage(`{"connectionId":"sessions-1"}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code = decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "permission_denied" {
		t.Fatalf("missing permission envelope: %s", raw)
	}
}
