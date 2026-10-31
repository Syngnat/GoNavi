package app

import (
	"context"
	"encoding/json"
	"testing"

	"GoNavi-Wails/internal/plugin"
)

func TestPluginCapabilityBackupStatus(t *testing.T) {
	a := newPluginTestApp(t)
	status := plugin.Status{
		Manifest:       pluginPageTestManifest("test.backup", plugin.MetadataReadPermission),
		Generation:     1,
		State:          plugin.StateRunning,
		DesiredEnabled: true,
	}
	raw, err := a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "backup.status", json.RawMessage(`{"unexpected":true}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code := decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "invalid_arguments" {
		t.Fatalf("invalid args envelope: %s", raw)
	}
	raw, err = a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "backup.status", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if ok, code = decodePluginCapabilityEnvelope(t, raw); !ok || code != "" {
		t.Fatalf("status envelope: %s", raw)
	}
	status.Manifest = pluginPageTestManifest("test.backup", "")
	raw, err = a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "backup.status", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if ok, code = decodePluginCapabilityEnvelope(t, raw); ok || code != "permission_denied" {
		t.Fatalf("missing permission envelope: %s", raw)
	}
}
