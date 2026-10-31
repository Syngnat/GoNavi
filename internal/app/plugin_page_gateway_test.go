package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/plugin"
)

func pluginPageTestCapabilities(seen *pluginPageRequest) pluginPageCapabilities {
	return pluginPageCapabilities{
		"echo": {
			permission: plugin.QueryReadPermission,
			handle: func(_ context.Context, _ *App, request pluginPageRequest) (any, string) {
				if seen != nil {
					*seen = request
				}
				return map[string]string{
					"plugin": request.pluginID,
					"page":   request.pageID,
					"args":   string(request.arguments),
				}, ""
			},
		},
		"guarded": {
			permission: plugin.MetadataReadPermission,
			handle:     func(context.Context, *App, pluginPageRequest) (any, string) { return "guarded", "" },
		},
		"failing": {
			handle: func(context.Context, *App, pluginPageRequest) (any, string) { return nil, "internal" },
		},
	}
}

func TestDispatchPluginPageCallEnforcesDocumentedOrder(t *testing.T) {
	status := plugin.Status{
		Manifest:       pluginPageTestManifest("test.pages", plugin.PagesPermission, plugin.QueryReadPermission),
		State:          plugin.StateRunning,
		DesiredEnabled: true,
	}
	oversized := json.RawMessage(`{"value":"` + strings.Repeat("a", pluginPageMaxArgumentsBytes) + `"}`)
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()

	for _, test := range []struct {
		name   string
		pageID string
		method string
		args   json.RawMessage
		ctx    context.Context
		want   string
	}{
		{name: "undeclared page wins over unknown method", pageID: "missing", method: "unknown", args: json.RawMessage(`{}`), want: "not_declared"},
		{name: "unknown method", pageID: "overview", method: "unknown", args: json.RawMessage(`{}`), want: "unknown_method"},
		{name: "missing permission", pageID: "overview", method: "guarded", args: json.RawMessage(`{}`), want: "permission_denied"},
		{name: "arguments over limit", pageID: "overview", method: "echo", args: oversized, want: "invalid_arguments"},
		{name: "arguments not object", pageID: "overview", method: "echo", args: json.RawMessage(`[1,2]`), want: "invalid_arguments"},
		{name: "handler failure", pageID: "overview", method: "failing", args: json.RawMessage(`{}`), want: "internal"},
		{name: "cancelled context", pageID: "overview", method: "echo", args: json.RawMessage(`{}`), ctx: cancelled, want: "internal"},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := test.ctx
			if ctx == nil {
				ctx = context.Background()
			}
			value, code := dispatchPluginPageCall(ctx, pluginPageTestCapabilities(nil), nil, status, test.pageID, test.method, test.args)
			if code != test.want {
				t.Fatalf("code = %q, want %q (value=%v)", code, test.want, value)
			}
		})
	}
}

func TestDispatchPluginPageCallPassesImmutableRequest(t *testing.T) {
	status := plugin.Status{
		Manifest:       pluginPageTestManifest("test.pages", plugin.PagesPermission, plugin.QueryReadPermission),
		State:          plugin.StateRunning,
		DesiredEnabled: true,
	}
	var seen pluginPageRequest
	value, code := dispatchPluginPageCall(
		context.Background(),
		pluginPageTestCapabilities(&seen),
		nil,
		status,
		"overview",
		"echo",
		json.RawMessage(`{"value":7}`),
	)
	if code != "" {
		t.Fatalf("code = %q", code)
	}
	if seen.pluginID != "test.pages" || seen.pageID != "overview" || seen.method != "echo" {
		t.Fatalf("unexpected request: %#v", seen)
	}
	if string(seen.arguments) != `{"value":7}` {
		t.Fatalf("arguments = %s", seen.arguments)
	}
	result, ok := value.(map[string]string)
	if !ok || result["args"] != `{"value":7}` {
		t.Fatalf("value = %#v", value)
	}
}

func TestPluginPageResultLimit(t *testing.T) {
	if code := pluginPageResultCode(strings.Repeat("a", pluginPageMaxResultBytes)); code != "result_too_large" {
		t.Fatalf("code = %q, want result_too_large", code)
	}
	if code := pluginPageResultCode(map[string]any{"ok": true}); code != "" {
		t.Fatalf("small result rejected: %q", code)
	}
	if code := pluginPageResultCode(func() {}); code != "internal" {
		t.Fatalf("unencodable result code = %q, want internal", code)
	}
}

func TestPluginPageCallRejectsWebRuntimeBeforeTouchingStorage(t *testing.T) {
	a := &App{configDir: t.TempDir(), webRuntime: true}
	requirePluginPageFailure(t, a.PluginPageCall("test.pages", "overview", "app.info", "{}"), "management_denied")
	if _, err := os.Stat(filepath.Join(a.configDir, "plugins")); !os.IsNotExist(err) {
		t.Fatalf("web rejection touched plugin storage: %v", err)
	}
}

func TestPluginPageCallRejectsInvalidIdentityBeforeStatusLookup(t *testing.T) {
	a := &App{configDir: t.TempDir(), ctx: context.Background()}
	requirePluginPageFailure(t, a.PluginPageCall("", "overview", "app.info", "{}"), "page_invalid_identity")
	requirePluginPageFailure(t, a.PluginPageCall("test.pages", strings.Repeat("a", pluginPageMaxIdentityBytes+1), "app.info", "{}"), "page_invalid_identity")
}

func TestPluginPageArgumentsNormalization(t *testing.T) {
	if string(pluginPageArgumentsRaw("  ")) != "{}" {
		t.Fatal("blank arguments did not normalize to an object")
	}
	if string(pluginPageArgumentsRaw(` {"a":1} `)) != `{"a":1}` {
		t.Fatal("arguments were not trimmed")
	}
}

func TestDefaultPluginPageCapabilitiesMatchContract(t *testing.T) {
	expected := map[string]string{
		pluginPageMethodAppInfo:           "",
		pluginPageMethodConnectionsList:   plugin.ConnectionsReadPermission,
		pluginPageMethodMetadataDatabases: plugin.MetadataReadPermission,
		pluginPageMethodMetadataTables:    plugin.MetadataReadPermission,
		pluginPageMethodMetadataColumns:   plugin.MetadataReadPermission,
		pluginPageMethodQueryRead:         plugin.QueryReadPermission,
		pluginPageMethodNotify:            "",
	}
	capabilities := defaultPluginPageCapabilities()
	if len(capabilities) != len(expected) {
		t.Fatalf("capability count = %d, want %d", len(capabilities), len(expected))
	}
	for method, permission := range expected {
		capability, registered := capabilities[method]
		if !registered {
			t.Fatalf("method %q is not registered", method)
		}
		if capability.permission != permission {
			t.Fatalf("method %q permission = %q, want %q", method, capability.permission, permission)
		}
		if capability.handle == nil {
			t.Fatalf("method %q has no handler", method)
		}
	}
}

func TestDispatchPluginPageCallPropagatesCancelToHandler(t *testing.T) {
	status := plugin.Status{
		Manifest:       pluginPageTestManifest("test.pages", plugin.PagesPermission),
		State:          plugin.StateRunning,
		DesiredEnabled: true,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	capabilities := pluginPageCapabilities{
		"wait": {
			handle: func(ctx context.Context, _ *App, _ pluginPageRequest) (any, string) {
				select {
				case <-ctx.Done():
					return nil, "internal"
				case <-time.After(2 * time.Second):
					return "unexpected", ""
				}
			},
		},
	}
	if _, code := dispatchPluginPageCall(ctx, capabilities, nil, status, "overview", "wait", json.RawMessage(`{}`)); code != "internal" {
		t.Fatalf("code = %q, want internal", code)
	}
}
