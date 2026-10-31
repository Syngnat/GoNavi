package app

import (
	"context"
	"strings"
)

type pluginCapabilityJVMConnectionArguments struct {
	ConnectionID string `json:"connectionId"`
}

type pluginCapabilityJVMResourceArguments struct {
	ConnectionID string `json:"connectionId"`
	ParentPath   string `json:"parentPath,omitempty"`
	ResourcePath string `json:"resourcePath,omitempty"`
}

type pluginCapabilityJVMAuditArguments struct {
	ConnectionID string `json:"connectionId"`
	Limit        int    `json:"limit,omitempty"`
}

func pluginCapabilityJVMCapabilities(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilityJVMConnectionArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.JVMProbeCapabilities(config)
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}

func pluginCapabilityJVMResources(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilityJVMResourceArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	if strings.TrimSpace(arguments.ConnectionID) == "" || len(arguments.ParentPath) > 1024 {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.JVMListResources(config, strings.TrimSpace(arguments.ParentPath))
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}

func pluginCapabilityJVMValue(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilityJVMResourceArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	path := strings.TrimSpace(arguments.ResourcePath)
	if strings.TrimSpace(arguments.ConnectionID) == "" || path == "" || len(path) > 2048 {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.JVMGetValue(config, path)
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}

func pluginCapabilityJVMAudit(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilityJVMAuditArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	if strings.TrimSpace(arguments.ConnectionID) == "" {
		return nil, "invalid_arguments"
	}
	limit := arguments.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	result := a.JVMListAuditRecords(arguments.ConnectionID, limit)
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}
