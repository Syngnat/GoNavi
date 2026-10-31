package app

import (
	"bytes"
	"context"
	"encoding/json"
	"sort"
	"time"

	"GoNavi-Wails/internal/plugin"
)

const (
	pluginCapabilityDefaultMaxArgsBytes   = 64 << 10
	pluginCapabilityDefaultMaxResultBytes = 256 << 10
	pluginCapabilityDefaultTimeout        = 30 * time.Second
)

// dispatchPluginCapability applies the shared validation order for every
// channel. Page callers additionally need a declared page; the host still
// checks the page before the method so an undeclared page cannot probe the
// capability catalogue.
func dispatchPluginCapability(
	ctx context.Context,
	capabilities pluginCapabilities,
	a *App,
	status plugin.Status,
	caller pluginCapabilityCaller,
	method string,
	arguments json.RawMessage,
) (any, string) {
	if caller.Channel == pluginCapabilityChannelPage && !pluginPageDeclared(status.Manifest, caller.PageID) {
		return nil, "not_declared"
	}
	capability, registered := capabilities[method]
	if !registered {
		return nil, "unknown_method"
	}
	if capability.Channels&caller.Channel == 0 {
		return nil, "internal"
	}
	if !capability.Runtimes.allows(caller.Runtime) {
		return nil, "internal"
	}
	if capability.Permission != "" && !pluginCapabilityPermissionGranted(caller.Permissions, capability.Permission) {
		return nil, "permission_denied"
	}
	maxArgs := capability.MaxArgsBytes
	if maxArgs <= 0 {
		maxArgs = pluginCapabilityDefaultMaxArgsBytes
	}
	if !pluginCapabilityArgumentsValid(arguments, maxArgs) {
		return nil, "invalid_arguments"
	}
	if ctx == nil || ctx.Err() != nil {
		return nil, "internal"
	}

	callCtx := ctx
	timeout := capability.Timeout
	if timeout <= 0 {
		timeout = pluginCapabilityDefaultTimeout
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	value, code := capability.Handler(callCtx, a, pluginCapabilityRequest{
		Caller:    caller,
		Status:    status,
		Method:    method,
		Arguments: arguments,
	})
	if code != "" {
		return nil, code
	}
	if callCtx.Err() != nil {
		return nil, "internal"
	}
	maxResult := capability.MaxResultBytes
	if maxResult <= 0 {
		maxResult = pluginCapabilityDefaultMaxResultBytes
	}
	if code := pluginCapabilityResultCode(value, maxResult); code != "" {
		return nil, code
	}
	return value, ""
}

func pluginCapabilityPermissionGranted(permissions []string, permission string) bool {
	for _, granted := range permissions {
		if granted == permission {
			return true
		}
	}
	return false
}

// pluginCapabilityArgumentsValid requires exactly one bounded JSON object, the
// same contract the page bridge has always enforced.
func pluginCapabilityArgumentsValid(arguments json.RawMessage, limit int) bool {
	if len(arguments) == 0 || len(arguments) > limit || !json.Valid(arguments) {
		return false
	}
	trimmed := bytes.TrimSpace(arguments)
	return len(trimmed) >= 2 && trimmed[0] == '{' && trimmed[len(trimmed)-1] == '}'
}

func pluginCapabilityResultCode(value any, limit int) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "internal"
	}
	if len(encoded) > limit {
		return "result_too_large"
	}
	return ""
}

// pluginCapabilityCatalogHandler is the only permission-free data capability
// besides app.info. It lets a page discover what the host actually supports
// and which of those methods this plugin was granted.
func pluginCapabilityCatalogHandler(_ context.Context, _ *App, request pluginCapabilityRequest) (any, string) {
	return pluginCapabilityCatalog(defaultPluginCapabilities(), request.Caller.Permissions), ""
}

func pluginCapabilityCatalog(capabilities pluginCapabilities, permissions []string) []pluginCapabilityDescription {
	names := make([]string, 0, len(capabilities))
	for name := range capabilities {
		names = append(names, name)
	}
	sort.Strings(names)
	items := make([]pluginCapabilityDescription, 0, len(names))
	for _, name := range names {
		capability := capabilities[name]
		items = append(items, pluginCapabilityDescription{
			Name:                 name,
			Permission:           capability.Permission,
			Description:          capability.Description,
			Channels:             capability.Channels.names(),
			Mutating:             capability.Mutating,
			Destructive:          capability.Destructive,
			RequiresConfirmation: capability.RequiresConfirmation,
			Granted:              capability.Permission == "" || pluginCapabilityPermissionGranted(permissions, capability.Permission),
		})
	}
	return items
}
