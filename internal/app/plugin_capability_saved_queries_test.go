package app

import (
	"context"
	"encoding/json"
	"testing"

	"GoNavi-Wails/internal/plugin"
)

func TestPluginCapabilitySavedQueriesAreReadOnlyAndPermissionBound(t *testing.T) {
	a := newPluginTestApp(t)
	status := plugin.Status{
		Manifest:       pluginPageTestManifest("test.saved", plugin.MetadataReadPermission),
		Generation:     1,
		State:          plugin.StateRunning,
		DesiredEnabled: true,
	}
	raw, err := a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "metadata.savedQueries", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code := decodePluginCapabilityEnvelope(t, raw)
	if !ok || code != "" {
		t.Fatalf("saved queries envelope: %s", raw)
	}
	var data map[string]any
	if err = json.Unmarshal(raw, &struct {
		Data *map[string]any `json:"data"`
	}{Data: &data}); err != nil {
		t.Fatal(err)
	}
	if _, exists := data["queries"]; !exists {
		t.Fatalf("missing queries: %s", raw)
	}
	status.Manifest = pluginPageTestManifest("test.saved", "")
	raw, err = a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "metadata.savedQueries", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code = decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "permission_denied" {
		t.Fatalf("missing permission envelope: %s", raw)
	}
}
