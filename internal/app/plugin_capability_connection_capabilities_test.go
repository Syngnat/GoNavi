package app

import (
	"context"
	"encoding/json"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/plugin"
)

func TestPluginCapabilityConnectionCapabilitiesIsOfflineAndBounded(t *testing.T) {
	a := newPluginTestApp(t)
	if _, err := a.savedConnectionRepository().Save(connection.SavedConnectionInput{
		ID: "caps-1", Name: "Caps",
		Config: connection.ConnectionConfig{Type: "test-unsupported", Host: "127.0.0.1", Port: 1},
	}); err != nil {
		t.Fatal(err)
	}
	status := plugin.Status{
		Manifest:       pluginPageTestManifest("test.caps", plugin.ConnectionsReadPermission),
		Generation:     1,
		State:          plugin.StateRunning,
		DesiredEnabled: true,
	}
	raw, err := a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "connections.capabilities", json.RawMessage(`{"connectionId":"caps-1"}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code := decodePluginCapabilityEnvelope(t, raw)
	if !ok || code != "" {
		t.Fatalf("capabilities envelope: %s", raw)
	}
	raw, err = a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "connections.capabilities", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code = decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "invalid_arguments" {
		t.Fatalf("empty id envelope: %s", raw)
	}
	status.Manifest = pluginPageTestManifest("test.caps", "")
	raw, err = a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "connections.capabilities", json.RawMessage(`{"connectionId":"caps-1"}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code = decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "permission_denied" {
		t.Fatalf("missing permission envelope: %s", raw)
	}
}
