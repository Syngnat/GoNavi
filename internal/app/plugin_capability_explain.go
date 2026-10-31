package app

import (
	"context"
	"strings"
)

type pluginCapabilityExplainArguments struct {
	ConnectionID string `json:"connectionId"`
	Database     string `json:"database,omitempty"`
	SQL          string `json:"sql"`
}

// pluginCapabilityExplain returns an estimated plan only. It never enables the
// ANALYZE option, which would execute the query even inside a read-only guard.
func pluginCapabilityExplain(ctx context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilityExplainArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	if strings.TrimSpace(arguments.ConnectionID) == "" || strings.TrimSpace(arguments.SQL) == "" {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.diagnoseQueryContext(ctx, config, strings.TrimSpace(arguments.Database), arguments.SQL)
	if !result.Success {
		return nil, "invalid_arguments"
	}
	return result.Data, ""
}
