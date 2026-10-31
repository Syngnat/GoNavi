package app

import (
	"context"
	"encoding/json"
	"testing"

	"GoNavi-Wails/internal/plugin"
)

func pluginOpenExternalTestApp(t *testing.T, calls *[]string) *App {
	t.Helper()
	restore := openPluginExternalURL
	openPluginExternalURL = func(_ context.Context, target string) {
		if calls != nil {
			*calls = append(*calls, target)
		}
	}
	t.Cleanup(func() { openPluginExternalURL = restore })
	a := newPluginPageTestApp(t)
	return a
}

func TestPluginOpenExternalPageCallOpensTheValidatedURL(t *testing.T) {
	var calls []string
	a := pluginOpenExternalTestApp(t, &calls)
	id := installAndEnablePluginPage(t, a, "test.pages.external", plugin.PagesPermission, plugin.OpenExternalPermission)

	result := a.PluginPageCall(id, "overview", "system.open-external", `{"url":"https://missav.ai/cn"} `)
	if !result.Success {
		t.Fatalf("system.open-external failed: %+v", result)
	}
	if len(calls) != 1 || calls[0] != "https://missav.ai/cn" {
		t.Fatalf("open calls = %#v", calls)
	}
	opened, ok := result.Data.(pluginCapabilityOpenExternalResult)
	if !ok || !opened.Opened {
		t.Fatalf("result = %#v", result.Data)
	}
}

func TestPluginOpenExternalRequiresTheDeclaredPermission(t *testing.T) {
	var calls []string
	a := pluginOpenExternalTestApp(t, &calls)
	id := installAndEnablePluginPage(t, a, "test.pages.external.denied", plugin.PagesPermission)

	requirePluginPageFailure(t,
		a.PluginPageCall(id, "overview", "system.open-external", `{"url":"https://missav.ai"}`),
		"page_permission_denied")
	if len(calls) != 0 {
		t.Fatalf("denied call still opened %#v", calls)
	}
}

func TestPluginOpenExternalRejectsUnsafeTargets(t *testing.T) {
	for _, target := range []string{
		`{"url":""}`,
		`{"url":"   "}`,
		`{"url":"file:///etc/passwd"}`,
		`{"url":"javascript:alert(1)"}`,
		`{"url":"data:text/html,<script>alert(1)</script>"}`,
		`{"url":"mailto:someone@example.com"}`,
		`{"url":"https://user:secret@missav.ai"}`,
		`{"url":"//missav.ai"}`,
		`{"url":"https://missav.ai/\nheader"}`,
		`{"url":"https://missav.ai/"}` + string(make([]byte, pluginExternalURLMaxBytes)),
		`{"url":42}`,
		`{"target":"https://missav.ai"}`,
	} {
		if target, ok := pluginExternalURL(target); ok {
			t.Fatalf("unsafe literal accepted: %q", target)
		}
	}
	var calls []string
	a := pluginOpenExternalTestApp(t, &calls)
	id := installAndEnablePluginPage(t, a, "test.pages.external.bad", plugin.PagesPermission, plugin.OpenExternalPermission)
	requirePluginPageFailure(t,
		a.PluginPageCall(id, "overview", "system.open-external", `{"url":"file:///etc/passwd"}`),
		"page_invalid_arguments")
	if len(calls) != 0 {
		t.Fatalf("invalid target still opened %#v", calls)
	}
}

func TestPluginOpenExternalIsDesktopOnly(t *testing.T) {
	var calls []string
	a := pluginOpenExternalTestApp(t, &calls)
	a.webRuntime = true
	status := plugin.Status{
		Manifest:       pluginPageTestManifest("test.window.external", plugin.OpenExternalPermission),
		Generation:     1,
		State:          plugin.StateRunning,
		DesiredEnabled: true,
	}
	raw, err := a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "system.open-external", json.RawMessage(`{"url":"https://missav.ai"}`))
	if err != nil {
		t.Fatal(err)
	}
	if ok, code := decodePluginCapabilityEnvelope(t, raw); ok || code != "internal" {
		t.Fatalf("web runtime envelope = %s", raw)
	}
	if len(calls) != 0 {
		t.Fatalf("web runtime still opened %#v", calls)
	}

	a.webRuntime = false
	raw, err = a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "system.open-external", json.RawMessage(`{"url":"https://missav.ai"}`))
	if err != nil {
		t.Fatal(err)
	}
	if ok, code := decodePluginCapabilityEnvelope(t, raw); !ok || code != "" {
		t.Fatalf("desktop window envelope = %s", raw)
	}
	if len(calls) != 1 || calls[0] != "https://missav.ai" {
		t.Fatalf("desktop window calls = %#v", calls)
	}
}

func TestPluginExternalURLAcceptsPlainHTTPAndHTTPS(t *testing.T) {
	for _, target := range []string{"https://missav.ai", "http://localhost:8080/x?y=1#z", "  https://example.com/a  "} {
		if _, ok := pluginExternalURL(target); !ok {
			t.Fatalf("safe target rejected: %q", target)
		}
	}
}

func TestPluginOpenExternalIsNotReachableFromTheBackendChannel(t *testing.T) {
	capability, registered := defaultPluginCapabilities()["system.open-external"]
	if !registered {
		t.Fatal("system.open-external is not registered")
	}
	if capability.Channels&pluginCapabilityChannelBackend != 0 {
		t.Fatal("system.open-external must not be callable from a plugin backend")
	}
	if capability.Permission != plugin.OpenExternalPermission {
		t.Fatalf("permission = %q", capability.Permission)
	}
}
