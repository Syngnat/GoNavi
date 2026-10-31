package app

import (
	"context"
	"encoding/json"
	"testing"

	"GoNavi-Wails/internal/plugin"
)

func TestPluginCapabilityRedisValidatesArgumentsAndPermission(t *testing.T) {
	a := newPluginTestApp(t)
	status := plugin.Status{
		Manifest:       pluginPageTestManifest("test.redis", plugin.QueryReadPermission),
		Generation:     1,
		State:          plugin.StateRunning,
		DesiredEnabled: true,
	}
	for _, method := range []string{"redis.scan", "redis.value", "redis.serverInfo", "redis.databases"} {
		raw, err := a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, method, json.RawMessage(`{}`))
		if err != nil {
			t.Fatalf("%s: %v", method, err)
		}
		ok, code := decodePluginCapabilityEnvelope(t, raw)
		if ok || code != "invalid_arguments" {
			t.Fatalf("%s missing id envelope: %s", method, raw)
		}
	}
	status.Manifest = pluginPageTestManifest("test.redis", "")
	raw, err := a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "redis.databases", json.RawMessage(`{"connectionId":"redis-1"}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code := decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "permission_denied" {
		t.Fatalf("missing permission envelope: %s", raw)
	}
	raw, err = a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "redis.scan", json.RawMessage(`{"connectionId":"redis-1"}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code = decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "permission_denied" {
		t.Fatalf("scan missing permission envelope: %s", raw)
	}
}
