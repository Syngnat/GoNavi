package app

import (
	"context"
	"strings"

	"GoNavi-Wails/internal/connection"
)

type pluginCapabilityConnectionHealthArguments struct {
	ConnectionID string `json:"connectionId"`
}

// pluginCapabilityConnectionHealth runs the same bounded checks as the desktop
// health panel. It resolves the connection on the host and returns no secrets.
func pluginCapabilityConnectionHealth(ctx context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilityConnectionHealthArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	id := strings.TrimSpace(arguments.ConnectionID)
	if id == "" {
		return nil, "invalid_arguments"
	}
	report, ok := a.inspectSavedConnectionHealthWithContext(ctx, id)
	if !ok {
		return nil, "internal"
	}
	if report.OverallStatus == "" {
		return connection.ConnectionHealthReport{ConnectionID: id}, ""
	}
	return report, ""
}
