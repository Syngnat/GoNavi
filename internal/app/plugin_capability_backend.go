package app

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"

	"GoNavi-Wails/internal/plugin"
)

// pluginHostCapability is the native backend channel into the shared capability
// registry. It is wired into plugin.Options and therefore caller-bound to the
// exact plugin instance/generation that made the JSON-RPC request.
func (a *App) pluginHostCapability(ctx context.Context, pluginID string, generation uint64, params json.RawMessage) (json.RawMessage, error) {
	var request struct {
		Method    string          `json:"method"`
		Arguments json.RawMessage `json:"arguments"`
	}
	decoder := json.NewDecoder(bytes.NewReader(params))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return pluginCapabilityBackendError("invalid_arguments")
	}
	method := strings.TrimSpace(request.Method)
	if method == "" || len(method) > 256 {
		return pluginCapabilityBackendError("invalid_arguments")
	}
	arguments := request.Arguments
	if len(arguments) == 0 || bytes.Equal(bytes.TrimSpace(arguments), []byte("null")) {
		arguments = json.RawMessage("{}")
	}

	status, code := a.pluginCapabilityStatus(ctx, pluginID, generation)
	if code != "" {
		return pluginCapabilityBackendError(code)
	}
	return a.pluginCapabilityCall(ctx, status, pluginCapabilityChannelBackend, method, arguments)
}

// PluginWindowCapabilityHandler returns the controller-facing callback without
// exporting a Wails binding. The plugin window bridge authenticates the window
// token and generation before this callback runs.
func PluginWindowCapabilityHandler(a *App) func(context.Context, string, uint64, string, json.RawMessage) (json.RawMessage, error) {
	return func(ctx context.Context, pluginID string, generation uint64, method string, arguments json.RawMessage) (json.RawMessage, error) {
		return a.pluginWindowCapability(ctx, pluginID, generation, method, arguments)
	}
}

// pluginWindowCapability is the independent plugin-window channel. The native
// window controller has already authenticated the window token and generation;
// this method re-checks the live plugin generation before dispatching.
func (a *App) pluginWindowCapability(ctx context.Context, pluginID string, generation uint64, method string, arguments json.RawMessage) (json.RawMessage, error) {
	method = strings.TrimSpace(method)
	if method == "" || len(method) > 256 {
		return pluginCapabilityBackendError("invalid_arguments")
	}
	if len(arguments) == 0 || bytes.Equal(bytes.TrimSpace(arguments), []byte("null")) {
		arguments = json.RawMessage("{}")
	}
	status, code := a.pluginCapabilityStatus(ctx, pluginID, generation)
	if code != "" {
		return pluginCapabilityBackendError(code)
	}
	return a.pluginCapabilityCall(ctx, status, pluginCapabilityChannelWindow, method, arguments)
}

func (a *App) pluginCapabilityStatus(ctx context.Context, pluginID string, generation uint64) (plugin.Status, string) {
	manager, err := a.pluginManager(ctx)
	if err != nil {
		return plugin.Status{}, "runtime_unavailable"
	}
	for _, candidate := range manager.List() {
		if candidate.Manifest.ID != pluginID {
			continue
		}
		if !candidate.DesiredEnabled || candidate.State != plugin.StateRunning ||
			(generation != 0 && candidate.Generation != generation) {
			return plugin.Status{}, "not_running"
		}
		return candidate, ""
	}
	return plugin.Status{}, "not_running"
}

// pluginCapabilityBackendCall is the backend-channel wrapper kept for focused tests.
func (a *App) pluginCapabilityBackendCall(
	ctx context.Context,
	status plugin.Status,
	method string,
	arguments json.RawMessage,
) (json.RawMessage, error) {
	return a.pluginCapabilityCall(ctx, status, pluginCapabilityChannelBackend, method, arguments)
}

// pluginCapabilityCall keeps the envelope shape testable without a live plugin
// process. User-visible failures are normal results, not RPC errors, so the
// page, window and SDK callers receive a stable code instead of a generic
// transport failure.
func (a *App) pluginCapabilityCall(
	ctx context.Context,
	status plugin.Status,
	channel pluginCapabilityChannel,
	method string,
	arguments json.RawMessage,
) (json.RawMessage, error) {
	caller := pluginCapabilityCaller{
		PluginID:    status.Manifest.ID,
		Generation:  status.Generation,
		Channel:     channel,
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
		method,
		arguments,
	)
	if code != "" {
		return pluginCapabilityBackendError(code)
	}
	encoded, err := json.Marshal(map[string]any{"ok": true, "data": value})
	if err != nil {
		return nil, err
	}
	return encoded, nil
}

func pluginCapabilityBackendError(code string) (json.RawMessage, error) {
	encoded, err := json.Marshal(map[string]any{
		"ok": false,
		"error": map[string]string{
			"code": code,
		},
	})
	if err != nil {
		return nil, err
	}
	return encoded, nil
}
