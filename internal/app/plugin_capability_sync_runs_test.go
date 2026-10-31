package app

import (
	"context"
	"encoding/json"
	"testing"

	"GoNavi-Wails/internal/plugin"
)

func TestPluginCapabilitySyncRunsValidatesArgumentsAndPermission(t *testing.T) {
	a := newPluginTestApp(t)
	status := plugin.Status{
		Manifest:       pluginPageTestManifest("test.sync.runs", plugin.MetadataReadPermission),
		Generation:     1,
		State:          plugin.StateRunning,
		DesiredEnabled: true,
	}
	raw, err := a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "sync.run", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code := decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "invalid_arguments" {
		t.Fatalf("empty run envelope: %s", raw)
	}
	status.Manifest = pluginPageTestManifest("test.sync.runs", "")
	raw, err = a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "sync.runs", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code = decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "permission_denied" {
		t.Fatalf("missing permission envelope: %s", raw)
	}
	raw, err = a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "sync.run", json.RawMessage(`{"runId":"run-1"}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code = decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "permission_denied" {
		t.Fatalf("run missing permission envelope: %s", raw)
	}
}
