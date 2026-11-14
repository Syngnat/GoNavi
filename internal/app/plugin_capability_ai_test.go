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

// TestPluginCapabilityAIProvidersReadHasItsOwnPermission 新窄权限必须自成一档：
// ai.providers.read 只认 host.ai.providers.read，host.metadata.read 不再能打开它；
// 同时旧能力 ai.providers 的绑定不变（host.metadata.read），已有插件不受影响。
func TestPluginCapabilityAIProvidersReadHasItsOwnPermission(t *testing.T) {
	a := newPluginTestApp(t)
	call := func(method string, permissions ...string) (bool, string) {
		t.Helper()
		status := plugin.Status{
			Manifest:       pluginPageTestManifest("test.ai", permissions...),
			Generation:     1,
			State:          plugin.StateRunning,
			DesiredEnabled: true,
		}
		raw, err := a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, method, json.RawMessage(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		return decodePluginCapabilityEnvelope(t, raw)
	}

	if ok, code := call("ai.providers.read", plugin.AIProvidersReadPermission); !ok || code != "" {
		t.Fatalf("ai.providers.read 持窄权限应放行：ok=%v code=%q", ok, code)
	}
	if ok, code := call("ai.providers.read", plugin.MetadataReadPermission); ok || code != "permission_denied" {
		t.Fatalf("ai.providers.read 不该被 host.metadata.read 打开：ok=%v code=%q", ok, code)
	}
	if ok, code := call("ai.providers", plugin.MetadataReadPermission); !ok || code != "" {
		t.Fatalf("旧能力 ai.providers 的绑定必须保持不变：ok=%v code=%q", ok, code)
	}
	if ok, code := call("ai.providers", plugin.AIProvidersReadPermission); ok || code != "permission_denied" {
		t.Fatalf("旧能力不该被新权限打开：ok=%v code=%q", ok, code)
	}
}
