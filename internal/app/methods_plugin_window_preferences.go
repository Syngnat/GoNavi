package app

import (
	"encoding/json"
	"strings"

	"GoNavi-Wails/internal/connection"
)

type pluginWindowPreferenceUpdater interface {
	UpdatePreferences(json.RawMessage) error
}

// PluginUpdateWindowPreferences forwards only safe presentation snapshots from the trusted desktop frontend.
func (a *App) PluginUpdateWindowPreferences(preferencesJSON string) connection.QueryResult {
	if !a.pluginManagementAllowed() || a.webRuntime || a.headlessRuntime || pluginEnvEnabled("GONAVI_DISABLE_PLUGINS") {
		return a.pluginFailure("window_unavailable")
	}
	raw := json.RawMessage(strings.TrimSpace(preferencesJSON))
	if len(raw) == 0 || len(raw) > 8192 || !json.Valid(raw) || len(raw) < 2 || raw[0] != '{' {
		return a.pluginFailure("invalid_request")
	}
	ctx := a.pluginContext()
	if _, err := a.pluginManager(ctx); err != nil {
		return a.pluginFailure("runtime_unavailable")
	}
	// A second app instance can hold the plugin execution lease, which leaves this
	// process without a window host. Creating it on demand means the first click
	// recovers instead of failing every later one, exactly like the open-window path.
	// Preference syncing is best effort either way: when no window host can be
	// created (another instance still owns the lease) the caller only needs to know
	// that no window is available right now.
	windows, err := a.ensurePluginWindows(ctx)
	if err != nil || windows == nil {
		return a.pluginFailure("window_unavailable")
	}
	updater, ok := windows.(pluginWindowPreferenceUpdater)
	if !ok {
		return a.pluginFailure("window_unavailable")
	}
	if err := updater.UpdatePreferences(raw); err != nil {
		return a.pluginFailure("invalid_request")
	}
	return a.pluginResult(nil, nil)
}
