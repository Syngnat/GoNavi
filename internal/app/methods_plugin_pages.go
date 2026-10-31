package app

import (
	"context"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/plugin"
)

// PluginPageCall is the only host entry for a declared plugin page.
// It validates the package identity, the page declaration and the capability
// permission before dispatching a bounded host capability. The bridge never
// exposes arbitrary bindings: every method below is registered explicitly.
func (a *App) PluginPageCall(id, pageID, method, argumentsJSON string) connection.QueryResult {
	return a.pluginPageCallContext(a.pluginContext(), id, pageID, method, argumentsJSON)
}

// pluginPageCallContext keeps the Wails binding thin and lets tests supply an
// explicit parent context without changing the exported signature.
func (a *App) pluginPageCallContext(parent context.Context, id, pageID, method, argumentsJSON string) connection.QueryResult {
	if a == nil || !a.pluginManagementAllowed() {
		return a.pluginFailure("management_denied")
	}
	if parent == nil {
		return a.pluginFailure("page_internal")
	}
	if !pluginPageIdentityValid(id) || !pluginPageIdentityValid(pageID) {
		return a.pluginFailure("page_invalid_identity")
	}
	ctx, cancel := context.WithTimeout(parent, pluginPageCallTimeout)
	defer cancel()
	status, code := a.pluginPageStatus(ctx, strings.TrimSpace(id))
	if code != "" {
		return a.pluginFailure("page_" + code)
	}
	caller := pluginCapabilityCaller{
		PluginID:    status.Manifest.ID,
		Generation:  status.Generation,
		PageID:      strings.TrimSpace(pageID),
		Channel:     pluginCapabilityChannelPage,
		Runtime:     a.pluginCapabilityRuntime(),
		Locale:      a.pluginPageLocale(),
		Permissions: status.Manifest.Permissions,
	}
	value, code := dispatchPluginCapability(
		ctx,
		defaultPluginCapabilities(),
		a,
		status,
		caller,
		strings.TrimSpace(method),
		pluginPageArgumentsRaw(argumentsJSON),
	)
	if code != "" {
		return a.pluginFailure("page_" + code)
	}
	if ctx.Err() != nil {
		return a.pluginFailure("page_internal")
	}
	return connection.QueryResult{Success: true, Data: value}
}

func (a *App) pluginCapabilityRuntime() string {
	if a != nil && a.webRuntime {
		return "web"
	}
	return "desktop"
}

// pluginPageStatus enforces the lifecycle order: the package must exist, the
// user must still want it enabled, and this host must observe it running.
func (a *App) pluginPageStatus(ctx context.Context, id string) (plugin.Status, string) {
	manager, err := a.pluginManager(ctx)
	if err != nil {
		return plugin.Status{}, "internal"
	}
	for _, status := range manager.List() {
		if status.Manifest.ID != id {
			continue
		}
		if !status.DesiredEnabled || status.State != plugin.StateRunning {
			return status, "not_running"
		}
		return status, ""
	}
	return plugin.Status{}, "invalid_identity"
}
