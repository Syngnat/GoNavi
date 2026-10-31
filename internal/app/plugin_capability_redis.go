package app

import (
	"context"
	"strings"

	"GoNavi-Wails/internal/connection"
)

type pluginCapabilityRedisConnectionArguments struct {
	ConnectionID string `json:"connectionId"`
}

type pluginCapabilityRedisScanArguments struct {
	ConnectionID string `json:"connectionId"`
	Pattern      string `json:"pattern,omitempty"`
	Cursor       any    `json:"cursor,omitempty"`
	Count        int64  `json:"count,omitempty"`
}

type pluginCapabilityRedisValueArguments struct {
	ConnectionID string `json:"connectionId"`
	Key          string `json:"key"`
}

func pluginCapabilityRedisConfig(a *App, connectionID string) (connection.ConnectionConfig, string) {
	if strings.TrimSpace(connectionID) == "" {
		return connection.ConnectionConfig{}, "invalid_arguments"
	}
	return a.pluginPageConnectionConfig(connectionID)
}

func pluginCapabilityRedisScan(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilityRedisScanArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	config, code := pluginCapabilityRedisConfig(a, arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	pattern := strings.TrimSpace(arguments.Pattern)
	if pattern == "" {
		pattern = "*"
	}
	if len(pattern) > 512 {
		return nil, "invalid_arguments"
	}
	count := arguments.Count
	if count <= 0 {
		count = 100
	}
	if count > 1000 {
		count = 1000
	}
	result := a.RedisScanKeys(config, pattern, arguments.Cursor, count)
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}

func pluginCapabilityRedisValue(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilityRedisValueArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	key := strings.TrimSpace(arguments.Key)
	if key == "" || len(key) > 1024 {
		return nil, "invalid_arguments"
	}
	config, code := pluginCapabilityRedisConfig(a, arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.RedisGetValue(config, key)
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}

func pluginCapabilityRedisServerInfo(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilityRedisConnectionArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	config, code := pluginCapabilityRedisConfig(a, arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.RedisGetServerInfo(config)
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}

func pluginCapabilityRedisDatabases(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilityRedisConnectionArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	config, code := pluginCapabilityRedisConfig(a, arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.RedisGetDatabases(config)
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}
