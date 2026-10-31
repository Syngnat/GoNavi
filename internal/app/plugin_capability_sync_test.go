package app

import (
	"context"
	"encoding/json"
	"testing"

	"GoNavi-Wails/internal/plugin"
)

func TestPluginCapabilitySyncValidatesArgumentsAndPermission(t *testing.T) {
	a := newPluginTestApp(t)
	status := plugin.Status{
		Manifest:       pluginPageTestManifest("test.sync", plugin.MetadataReadPermission),
		Generation:     1,
		State:          plugin.StateRunning,
		DesiredEnabled: true,
	}
	raw, err := a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "sync.job", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code := decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "invalid_arguments" {
		t.Fatalf("empty job envelope: %s", raw)
	}
	status.Manifest = pluginPageTestManifest("test.sync", "")
	raw, err = a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "sync.jobs", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code = decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "permission_denied" {
		t.Fatalf("missing permission envelope: %s", raw)
	}
	raw, err = a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "sync.job", json.RawMessage(`{"jobId":"job-1"}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code = decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "permission_denied" {
		t.Fatalf("job missing permission envelope: %s", raw)
	}
}
