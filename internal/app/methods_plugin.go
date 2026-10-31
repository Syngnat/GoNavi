package app

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/plugin"
)

func (a *App) pluginFailure(code string) connection.QueryResult {
	logger.Warnf("Plugin operation rejected: %s", code)
	return connection.QueryResult{Success: false, Message: a.appText("plugin.backend.error."+code, nil), Data: map[string]any{"code": code}}
}

func (a *App) pluginResult(value any, err error) connection.QueryResult {
	if err != nil {
		if errors.Is(err, plugin.ErrDataSourceWriteEffect) {
			return a.pluginFailure("datasource_write_effect")
		}
		if errors.Is(err, plugin.ErrDataSourceCommandReserved) || errors.Is(err, plugin.ErrAIProviderCommandReserved) || errors.Is(err, plugin.ErrExporterCommandReserved) {
			return a.pluginFailure("command_reserved")
		}
		// Lifecycle failures stay specific: a generic code hides whether the user needs to
		// disable a plugin, re-inspect a changed package or wait for a settling generation.
		if errors.Is(err, plugin.ErrDisabled) {
			return a.pluginFailure("plugin_disabled")
		}
		if errors.Is(err, plugin.ErrDigestMismatch) {
			return a.pluginFailure("digest_mismatch")
		}
		if errors.Is(err, plugin.ErrNotFound) {
			return a.pluginFailure("not_found")
		}
		if errors.Is(err, plugin.ErrEnabled) {
			return a.pluginFailure("plugin_enabled")
		}
		// A stale or mistyped package path is an OS condition, not a plugin lifecycle state:
		// reporting it as operation_failed told the user to "check the plugin status" instead
		// of the path that does not exist.
		if errors.Is(err, fs.ErrNotExist) {
			return a.pluginFailure("path_not_found")
		}
		if errors.Is(err, plugin.ErrBusy) {
			return a.pluginFailure("plugin_busy")
		}
		return a.pluginFailure("operation_failed")
	}
	return connection.QueryResult{Success: true, Data: value}
}

// PluginRuntimeInfo describes core controls without loading plugin code.
func (a *App) PluginRuntimeInfo() connection.QueryResult {
	return connection.QueryResult{Success: true, Data: map[string]bool{
		"safeMode":          pluginEnvEnabled("GONAVI_DISABLE_PLUGINS"),
		"managementAllowed": a.pluginManagementAllowed(),
		"webRuntime":        a != nil && a.webRuntime,
	}}
}

// PluginList returns installed and actual runtime states without consulting plugins.
func (a *App) PluginList() connection.QueryResult {
	manager, err := a.pluginManager(a.pluginContext())
	if err != nil {
		return a.pluginFailure("runtime_unavailable")
	}
	statuses := manager.List()
	if statuses == nil {
		statuses = []plugin.Status{}
	}
	return a.pluginResult(statuses, nil)
}

// PluginInspect statically inspects package contents; it never runs an entry point.
func (a *App) PluginInspect(path string) connection.QueryResult {
	return a.pluginInspectContext(a.pluginContext(), path)
}

func (a *App) pluginInspectContext(ctx context.Context, path string) connection.QueryResult {
	if !a.pluginManagementAllowed() {
		return a.pluginFailure("management_denied")
	}
	manager, err := a.pluginManager(ctx)
	if err != nil {
		return a.pluginFailure("runtime_unavailable")
	}
	value, err := manager.Inspect(ctx, expandPluginPackagePath(path))
	return a.pluginResult(value, err)
}

// PluginInstall installs only the exact content whose digest the user trusted.
func (a *App) PluginInstall(path, digest string, trusted bool) connection.QueryResult {
	return a.pluginInstallContext(a.pluginContext(), path, digest, trusted)
}

func (a *App) pluginInstallContext(ctx context.Context, path, digest string, trusted bool) connection.QueryResult {
	if !a.pluginManagementAllowed() {
		return a.pluginFailure("management_denied")
	}
	manager, err := a.pluginManager(ctx)
	if err != nil {
		return a.pluginFailure("runtime_unavailable")
	}
	a.plugins.mutationMu.Lock()
	defer a.plugins.mutationMu.Unlock()
	value, err := manager.Install(ctx, plugin.InstallRequest{Path: expandPluginPackagePath(path), Digest: digest, Trusted: trusted})
	if err == nil {
		a.forgetPluginMarketSource(ctx, value.Manifest.ID)
	}
	return a.pluginResult(value, err)
}

// PluginReplace swaps an installed plugin for the exact reviewed package and keeps its enable intent.
func (a *App) PluginReplace(path, digest string, trusted bool) connection.QueryResult {
	return a.pluginReplaceContext(a.pluginContext(), path, digest, trusted)
}

func (a *App) pluginReplaceContext(ctx context.Context, path, digest string, trusted bool) connection.QueryResult {
	if !a.pluginManagementAllowed() {
		return a.pluginFailure("management_denied")
	}
	manager, err := a.pluginManager(ctx)
	if err != nil {
		return a.pluginFailure("runtime_unavailable")
	}
	a.plugins.mutationMu.Lock()
	defer a.plugins.mutationMu.Unlock()
	value, err := manager.ReplacePackage(ctx, plugin.InstallRequest{Path: expandPluginPackagePath(path), Digest: digest, Trusted: trusted})
	if err == nil {
		a.forgetPluginMarketSource(ctx, value.Manifest.ID)
	}
	return a.pluginResult(value, err)
}

// PluginSetEnabled revokes controls before waiting on any uncooperative process.
func (a *App) PluginSetEnabled(id string, enabled bool) connection.QueryResult {
	return a.pluginSetEnabledContext(a.pluginContext(), id, enabled)
}

func (a *App) pluginSetEnabledContext(ctx context.Context, id string, enabled bool) connection.QueryResult {
	if enabled {
		a.plugins.mutationMu.Lock()
		defer a.plugins.mutationMu.Unlock()
	}
	if !a.pluginManagementAllowed() {
		return a.pluginFailure("management_denied")
	}
	if !enabled {
		a.revokePluginWindows(id)
	}
	manager, err := a.pluginManager(ctx)
	if err != nil {
		return a.pluginFailure("runtime_unavailable")
	}
	value, err := manager.SetEnabled(ctx, id, enabled)
	return a.pluginResult(value, err)
}

// PluginRemove removes a disabled installation; retaining private data is the default.
func (a *App) PluginRemove(id string, purge bool) connection.QueryResult {
	return a.pluginRemoveContext(a.pluginContext(), id, purge)
}

func (a *App) pluginRemoveContext(ctx context.Context, id string, purge bool) connection.QueryResult {
	if !a.pluginManagementAllowed() {
		return a.pluginFailure("management_denied")
	}
	a.revokePluginWindows(id)
	manager, err := a.pluginManager(ctx)
	if err != nil {
		return a.pluginFailure("runtime_unavailable")
	}
	a.plugins.mutationMu.Lock()
	defer a.plugins.mutationMu.Unlock()
	err = manager.Remove(ctx, id, purge)
	if err == nil {
		a.forgetPluginMarketSource(ctx, id)
	}
	return a.pluginResult(nil, err)
}

// PluginInvoke invokes a declared command; no arbitrary App method is exposed.
func (a *App) PluginInvoke(id, command, argumentsJSON string) connection.QueryResult {
	return a.pluginInvokeContext(a.pluginContext(), id, command, argumentsJSON)
}

func (a *App) pluginInvokeContext(ctx context.Context, id, command, argumentsJSON string) connection.QueryResult {
	if !a.pluginManagementAllowed() {
		return a.pluginFailure("management_denied")
	}
	args := json.RawMessage(strings.TrimSpace(argumentsJSON))
	if len(args) == 0 {
		args = json.RawMessage("{}")
	}
	if len(args) > 1<<20 || !json.Valid(args) {
		return a.pluginFailure("invalid_request")
	}
	manager, err := a.pluginManager(ctx)
	if err != nil {
		return a.pluginFailure("runtime_unavailable")
	}
	value, err := manager.Invoke(ctx, id, command, args)
	return a.pluginResult(value, err)
}

// PluginOpenWindow opens only the independent, scoped native plugin window.
// locale and theme mirror the current main-application appearance so the
// plugin window can follow them; empty values keep the plugin's own defaults.
func (a *App) PluginOpenWindow(id, locale, theme string) connection.QueryResult {
	if !a.pluginManagementAllowed() || a.headlessRuntime {
		return a.pluginFailure("window_unavailable")
	}
	if _, err := a.pluginManager(a.pluginContext()); err != nil {
		return a.pluginFailure("runtime_unavailable")
	}
	a.plugins.mu.Lock()
	windows := a.plugins.windows
	a.plugins.mu.Unlock()
	if windows == nil {
		return a.pluginFailure("window_unavailable")
	}
	value, err := windows.Open(a.pluginContext(), id, id, nil, locale, theme)
	if errors.Is(err, context.Canceled) {
		return a.pluginFailure("window_unavailable")
	}
	return a.pluginResult(value, err)
}
