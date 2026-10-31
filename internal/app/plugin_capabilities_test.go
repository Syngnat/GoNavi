package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"GoNavi-Wails/internal/plugin"
)

func TestDefaultPluginCapabilitiesContract(t *testing.T) {
	capabilities := defaultPluginCapabilities()
	required := []string{
		"app.info",
		"app.capabilities",
		"connections.list",
		"connections.test",
		"metadata.databases",
		"metadata.tables",
		"metadata.columns",
		"metadata.views",
		"metadata.objects",
		"metadata.allColumns",
		"metadata.indexes",
		"metadata.foreignKeys",
		"metadata.triggers",
		"metadata.createStatement",
		"metadata.tableInfo",
		"metadata.serverVersion",
		"metadata.tableExists",
		"metadata.databaseForeignKeys",
		"metadata.charsets",
		"metadata.collations",
		"query.read",
		"ui.notify",
	}
	for _, name := range required {
		if _, ok := capabilities[name]; !ok {
			t.Fatalf("capability %q is not registered", name)
		}
	}
	if len(capabilities) < len(required) {
		t.Fatalf("capability count = %d, want at least %d", len(capabilities), len(required))
	}
	permissionless := map[string]bool{"app.info": true, "app.capabilities": true, "ui.notify": true}
	for name, capability := range capabilities {
		if capability.Name != name {
			t.Fatalf("capability %q carries name %q", name, capability.Name)
		}
		if capability.Handler == nil {
			t.Fatalf("capability %q has no handler", name)
		}
		if capability.Channels == 0 {
			t.Fatalf("capability %q has no channel", name)
		}
		if capability.Channels&pluginCapabilityChannelPage == 0 {
			t.Fatalf("capability %q is not reachable from a page", name)
		}
		if !capability.Runtimes.allows("desktop") {
			t.Fatalf("capability %q is not available on desktop", name)
		}
		if capability.Permission == "" && !permissionless[name] {
			t.Fatalf("capability %q has no permission", name)
		}
	}
}

func TestDispatchPluginCapabilityValidationOrder(t *testing.T) {
	status := plugin.Status{
		Manifest:       pluginPageTestManifest("test.pages", plugin.PagesPermission, plugin.QueryReadPermission),
		State:          plugin.StateRunning,
		DesiredEnabled: true,
	}
	capabilities := pluginCapabilities{
		"echo": {
			Permission:     plugin.QueryReadPermission,
			Channels:       pluginCapabilityChannelPage,
			Runtimes:       pluginCapabilityRuntimeDesktop | pluginCapabilityRuntimeWeb,
			MaxArgsBytes:   64,
			MaxResultBytes: 1024,
			Handler: func(_ context.Context, _ *App, request pluginCapabilityRequest) (any, string) {
				return map[string]string{"plugin": request.Caller.PluginID}, ""
			},
		},
		"window-only": {
			Channels: pluginCapabilityChannelWindow,
			Runtimes: pluginCapabilityRuntimeDesktop,
			Handler:  func(context.Context, *App, pluginCapabilityRequest) (any, string) { return "window", "" },
		},
		"guarded": {
			Permission: plugin.ConnectionsReadPermission,
			Channels:   pluginCapabilityChannelPage,
			Runtimes:   pluginCapabilityRuntimeDesktop,
			Handler:    func(context.Context, *App, pluginCapabilityRequest) (any, string) { return "guarded", "" },
		},
		"desktop-only": {
			Channels: pluginCapabilityChannelPage,
			Runtimes: pluginCapabilityRuntimeDesktop,
			Handler:  func(context.Context, *App, pluginCapabilityRequest) (any, string) { return "desktop", "" },
		},
		"oversized": {
			Channels:       pluginCapabilityChannelPage,
			Runtimes:       pluginCapabilityRuntimeDesktop,
			MaxResultBytes: 8,
			Handler:        func(context.Context, *App, pluginCapabilityRequest) (any, string) { return strings.Repeat("x", 64), "" },
		},
		"failing": {
			Channels: pluginCapabilityChannelPage,
			Runtimes: pluginCapabilityRuntimeDesktop,
			Handler:  func(context.Context, *App, pluginCapabilityRequest) (any, string) { return nil, "internal" },
		},
	}
	caller := pluginCapabilityCaller{
		PluginID:    "test.pages",
		PageID:      "overview",
		Channel:     pluginCapabilityChannelPage,
		Runtime:     "desktop",
		Permissions: status.Manifest.Permissions,
	}
	oversizedArgs := json.RawMessage(`{"value":"` + strings.Repeat("a", 128) + `"}`)
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()

	for _, test := range []struct {
		name    string
		pageID  string
		method  string
		args    json.RawMessage
		ctx     context.Context
		runtime string
		want    string
	}{
		{name: "undeclared page wins", pageID: "missing", method: "unknown", args: json.RawMessage(`{}`), want: "not_declared"},
		{name: "unknown method", pageID: "overview", method: "unknown", args: json.RawMessage(`{}`), want: "unknown_method"},
		{name: "window channel rejected", pageID: "overview", method: "window-only", args: json.RawMessage(`{}`), want: "internal"},
		{name: "runtime rejected", pageID: "overview", method: "desktop-only", args: json.RawMessage(`{}`), runtime: "web", want: "internal"},
		{name: "missing permission", pageID: "overview", method: "guarded", args: json.RawMessage(`{}`), want: "permission_denied"},
		{name: "oversized arguments", pageID: "overview", method: "echo", args: oversizedArgs, want: "invalid_arguments"},
		{name: "arguments not object", pageID: "overview", method: "echo", args: json.RawMessage(`[1,2]`), want: "invalid_arguments"},
		{name: "result too large", pageID: "overview", method: "oversized", args: json.RawMessage(`{}`), want: "result_too_large"},
		{name: "handler failure", pageID: "overview", method: "failing", args: json.RawMessage(`{}`), want: "internal"},
		{name: "cancelled context", pageID: "overview", method: "echo", args: json.RawMessage(`{}`), ctx: cancelled, want: "internal"},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := test.ctx
			if ctx == nil {
				ctx = context.Background()
			}
			call := caller
			if test.pageID != "" {
				call.PageID = test.pageID
			}
			if test.runtime != "" {
				call.Runtime = test.runtime
			}
			value, code := dispatchPluginCapability(ctx, capabilities, nil, status, call, test.method, test.args)
			if code != test.want {
				t.Fatalf("code = %q, want %q (value=%v)", code, test.want, value)
			}
		})
	}
}

func TestPluginCapabilityCatalogMarksGrantedPermissions(t *testing.T) {
	items := pluginCapabilityCatalog(defaultPluginCapabilities(), []string{plugin.MetadataReadPermission})
	byName := make(map[string]pluginCapabilityDescription, len(items))
	for _, item := range items {
		byName[item.Name] = item
	}
	if item := byName["metadata.views"]; !item.Granted {
		t.Fatalf("metadata.views should be granted: %#v", item)
	}
	if item := byName["query.read"]; item.Granted {
		t.Fatalf("query.read should not be granted: %#v", item)
	}
	if item := byName["app.info"]; !item.Granted {
		t.Fatalf("app.info should always be granted: %#v", item)
	}
	if item := byName["metadata.views"]; len(item.Channels) != 3 || item.Channels[0] != "page" || item.Channels[1] != "window" || item.Channels[2] != "backend" {
		t.Fatalf("metadata.views channels = %#v", item.Channels)
	}
}

func TestPluginPageExposesCapabilityCatalogAndNewMetadataGuards(t *testing.T) {
	a := newPluginPageTestApp(t)
	id := installAndEnablePluginPage(t, a, "test.pages.catalog", pluginPageFullPermissions()...)

	result := a.PluginPageCall(id, "overview", "app.capabilities", "{}")
	if !result.Success {
		t.Fatalf("app.capabilities failed: %+v", result)
	}
	items, ok := result.Data.([]pluginCapabilityDescription)
	if !ok || len(items) < 22 {
		t.Fatalf("capability catalog = %T %#v", result.Data, result.Data)
	}

	requirePluginPageFailure(t, a.PluginPageCall(id, "overview", "metadata.views", "{}"), "page_invalid_arguments")
	requirePluginPageFailure(t, a.PluginPageCall(id, "overview", "metadata.views", `{"connectionId":"missing","database":"db"}`), "page_invalid_arguments")
	requirePluginPageFailure(t, a.PluginPageCall(id, "overview", "connections.test", "{}"), "page_invalid_arguments")

	noMetadata := installAndEnablePluginPage(t, a, "test.pages.catalog.nometa", plugin.PagesPermission)
	requirePluginPageFailure(t, a.PluginPageCall(noMetadata, "overview", "metadata.views", `{"connectionId":"missing","database":"db"}`), "page_permission_denied")
}
