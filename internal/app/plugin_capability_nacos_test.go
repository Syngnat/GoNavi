package app

import (
	"context"
	"encoding/json"
	"testing"

	"GoNavi-Wails/internal/plugin"
)

func TestPluginCapabilityNacosValidatesArgumentsAndPermission(t *testing.T) {
	a := newPluginTestApp(t)
	status := plugin.Status{
		Manifest:       pluginPageTestManifest("test.nacos", plugin.MetadataReadPermission),
		Generation:     1,
		State:          plugin.StateRunning,
		DesiredEnabled: true,
	}
	for _, method := range []string{"nacos.services", "nacos.service", "nacos.instances", "nacos.instance"} {
		raw, err := a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, method, json.RawMessage(`{}`))
		if err != nil {
			t.Fatalf("%s: %v", method, err)
		}
		ok, code := decodePluginCapabilityEnvelope(t, raw)
		if ok || code != "invalid_arguments" {
			t.Fatalf("%s empty envelope: %s", method, raw)
		}
	}
	status.Manifest = pluginPageTestManifest("test.nacos", "")
	for _, method := range []string{"nacos.services", "nacos.service", "nacos.instances", "nacos.instance"} {
		raw, err := a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, method, json.RawMessage(`{"connectionId":"nacos-1"}`))
		if err != nil {
			t.Fatalf("%s: %v", method, err)
		}
		ok, code := decodePluginCapabilityEnvelope(t, raw)
		if ok || code != "permission_denied" {
			t.Fatalf("%s permission envelope: %s", method, raw)
		}
	}
}
