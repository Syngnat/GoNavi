package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"GoNavi-Wails/internal/plugin"
)

func TestPluginCapabilityDriverStatusIsRedacted(t *testing.T) {
	a := newPluginTestApp(t)
	status := plugin.Status{
		Manifest:       pluginPageTestManifest("test.driver", plugin.MetadataReadPermission),
		Generation:     1,
		State:          plugin.StateRunning,
		DesiredEnabled: true,
	}
	raw, err := a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "driver.status", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code := decodePluginCapabilityEnvelope(t, raw)
	if !ok || code != "" {
		t.Fatalf("status envelope: %s", raw)
	}
	body := string(raw)
	for _, forbidden := range []string{"installDir", "packagePath", "executablePath", "defaultDownloadUrl", "manifestURL", "downloadDir"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("driver status leaked %s: %s", forbidden, body)
		}
	}
	status.Manifest = pluginPageTestManifest("test.driver", "")
	raw, err = a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "driver.status", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if ok, code = decodePluginCapabilityEnvelope(t, raw); ok || code != "permission_denied" {
		t.Fatalf("missing permission envelope: %s", raw)
	}
}
