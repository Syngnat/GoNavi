package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"GoNavi-Wails/internal/plugin"
)

func TestPluginCapabilityAIProvidersIsRedacted(t *testing.T) {
	a := newPluginTestApp(t)
	status := plugin.Status{
		Manifest:       pluginPageTestManifest("test.ai", plugin.MetadataReadPermission),
		Generation:     1,
		State:          plugin.StateRunning,
		DesiredEnabled: true,
	}
	raw, err := a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "ai.providers", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code := decodePluginCapabilityEnvelope(t, raw)
	if !ok || code != "" {
		t.Fatalf("providers envelope: %s", raw)
	}
	for _, forbidden := range []string{"apiKey", "headers", "cliEnv", "secretRef"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("AI provider metadata leaked %s: %s", forbidden, raw)
		}
	}
	status.Manifest = pluginPageTestManifest("test.ai", "")
	raw, err = a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "ai.providers", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if ok, code = decodePluginCapabilityEnvelope(t, raw); ok || code != "permission_denied" {
		t.Fatalf("missing permission envelope: %s", raw)
	}
}
