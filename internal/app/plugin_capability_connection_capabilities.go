package app

import (
	"context"
	"strings"
)

type pluginCapabilityConnectionArguments struct {
	ConnectionID string `json:"connectionId"`
}

// pluginCapabilityConnectionCapabilities reports driver/UI capabilities for a
// saved connection without opening a connection or exposing its credentials.
func pluginCapabilityConnectionCapabilities(ctx context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilityConnectionArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	if strings.TrimSpace(arguments.ConnectionID) == "" {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	if err := ctx.Err(); err != nil {
		return nil, "internal"
	}
	return a.DataSourceCapability(config), ""
}
