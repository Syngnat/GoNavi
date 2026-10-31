package app

import (
	"context"
	"encoding/json"
	"testing"

	"GoNavi-Wails/internal/plugin"
)

func TestPluginCapabilityWindowChannelUsesSharedRegistry(t *testing.T) {
	status := plugin.Status{
		Manifest:       pluginPageTestManifest("test.window", plugin.QueryReadPermission),
		Generation:     5,
		State:          plugin.StateRunning,
		DesiredEnabled: true,
	}
	a := &App{}
	ctx := context.Background()

	raw, err := a.pluginCapabilityCall(ctx, status, pluginCapabilityChannelWindow, "app.info", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code := decodePluginCapabilityEnvelope(t, raw)
	if !ok || code != "" {
		t.Fatalf("app.info window envelope = %s", raw)
	}

	// ui.notify is page-local only; a plugin window must use its own UI SDK toast.
	raw, err = a.pluginCapabilityCall(ctx, status, pluginCapabilityChannelWindow, "ui.notify", json.RawMessage(`{"message":"hi"}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code = decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "internal" {
		t.Fatalf("ui.notify window envelope = %s", raw)
	}

	raw, err = a.pluginCapabilityCall(ctx, status, pluginCapabilityChannelWindow, "metadata.views", json.RawMessage(`{"connectionId":"missing","database":"db"}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code = decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "permission_denied" {
		t.Fatalf("metadata.views window envelope = %s", raw)
	}
}
