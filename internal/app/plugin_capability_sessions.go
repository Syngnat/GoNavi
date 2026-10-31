package app

import (
	"context"
	"strings"
)

type pluginCapabilitySessionArguments struct {
	ConnectionID string `json:"connectionId"`
	Database     string `json:"database,omitempty"`
}

func decodePluginCapabilitySessionsArguments(request pluginCapabilityRequest) (pluginCapabilitySessionArguments, bool) {
	var arguments pluginCapabilitySessionArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return arguments, false
	}
	arguments.ConnectionID = strings.TrimSpace(arguments.ConnectionID)
	arguments.Database = strings.TrimSpace(arguments.Database)
	if arguments.ConnectionID == "" {
		return arguments, false
	}
	return arguments, true
}

func pluginCapabilitySessionsList(ctx context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	arguments, ok := decodePluginCapabilitySessionsArguments(request)
	if !ok {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.dbListSessionsContext(ctx, config, arguments.Database)
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}

func pluginCapabilitySessionsDatabases(ctx context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	arguments, ok := decodePluginCapabilitySessionsArguments(request)
	if !ok {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.dbListSessionDatabasesContext(ctx, config, arguments.Database)
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}

func pluginCapabilitySessionsLongTransactions(ctx context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	arguments, ok := decodePluginCapabilitySessionsArguments(request)
	if !ok {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.dbListLongTransactionsContext(ctx, config, arguments.Database)
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}

func pluginCapabilitySessionsLockWaits(ctx context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	arguments, ok := decodePluginCapabilitySessionsArguments(request)
	if !ok {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.dbListLockWaitsContext(ctx, config, arguments.Database)
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}

func pluginCapabilitySessionsCapabilities(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	arguments, ok := decodePluginCapabilitySessionsArguments(request)
	if !ok {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.DBGetSessionMonitorCapabilities(config)
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}
