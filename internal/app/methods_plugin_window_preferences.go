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
	if _, err := a.pluginManager(a.pluginContext()); err != nil {
		return a.pluginFailure("runtime_unavailable")
	}
	a.plugins.mu.Lock()
	windows := a.plugins.windows
	a.plugins.mu.Unlock()
	updater, ok := windows.(pluginWindowPreferenceUpdater)
	if !ok {
		return a.pluginFailure("window_unavailable")
	}
	if err := updater.UpdatePreferences(raw); err != nil {
		return a.pluginFailure("invalid_request")
	}
	return a.pluginResult(nil, nil)
}
