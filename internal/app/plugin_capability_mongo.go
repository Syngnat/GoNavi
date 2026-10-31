package app

import (
	"context"
	"strings"
)

type pluginCapabilityMongoArguments struct {
	ConnectionID string `json:"connectionId"`
}

// pluginCapabilityMongoDiscoverMembers exposes a bounded, read-only topology
// view for a saved MongoDB connection. It never runs a write command.
func pluginCapabilityMongoDiscoverMembers(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilityMongoArguments
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
	result := a.MongoDiscoverMembers(config)
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}
