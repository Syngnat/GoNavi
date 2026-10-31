package app

import (
	"context"
	"strings"
)

type pluginCapabilityNacosConnectionArguments struct {
	ConnectionID string `json:"connectionId"`
}

type pluginCapabilityNacosServiceArguments struct {
	ConnectionID   string `json:"connectionId"`
	NamespaceID    string `json:"namespaceId,omitempty"`
	ServiceName    string `json:"serviceName,omitempty"`
	GroupName      string `json:"groupName,omitempty"`
	PageNo         int    `json:"pageNo,omitempty"`
	PageSize       int    `json:"pageSize,omitempty"`
	WithStatistics bool   `json:"withStatistics,omitempty"`
	Clusters       string `json:"clusters,omitempty"`
	HealthyOnly    bool   `json:"healthyOnly,omitempty"`
	IP             string `json:"ip,omitempty"`
	Port           int    `json:"port,omitempty"`
	ClusterName    string `json:"clusterName,omitempty"`
}

func pluginCapabilityNacosServices(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilityNacosServiceArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.NacosListServices(config, NacosServiceQuery{
		NamespaceID:    strings.TrimSpace(arguments.NamespaceID),
		ServiceName:    strings.TrimSpace(arguments.ServiceName),
		GroupName:      strings.TrimSpace(arguments.GroupName),
		PageNo:         arguments.PageNo,
		PageSize:       arguments.PageSize,
		WithStatistics: arguments.WithStatistics,
	})
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}

func pluginCapabilityNacosService(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilityNacosServiceArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	if strings.TrimSpace(arguments.ServiceName) == "" {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.NacosGetService(config, strings.TrimSpace(arguments.NamespaceID), strings.TrimSpace(arguments.ServiceName), strings.TrimSpace(arguments.GroupName))
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}

func pluginCapabilityNacosInstances(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilityNacosServiceArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	if strings.TrimSpace(arguments.ServiceName) == "" {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.NacosListInstances(config, NacosInstanceQuery{
		NamespaceID: strings.TrimSpace(arguments.NamespaceID),
		ServiceName: strings.TrimSpace(arguments.ServiceName),
		GroupName:   strings.TrimSpace(arguments.GroupName),
		Clusters:    strings.TrimSpace(arguments.Clusters),
		HealthyOnly: arguments.HealthyOnly,
	})
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}

func pluginCapabilityNacosInstance(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilityNacosServiceArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	if strings.TrimSpace(arguments.ServiceName) == "" || strings.TrimSpace(arguments.IP) == "" ||
		arguments.Port <= 0 || arguments.Port > 65535 {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.NacosGetInstance(config, NacosInstancePayload{
		NamespaceID: strings.TrimSpace(arguments.NamespaceID),
		ServiceName: strings.TrimSpace(arguments.ServiceName),
		GroupName:   strings.TrimSpace(arguments.GroupName),
		IP:          strings.TrimSpace(arguments.IP),
		Port:        arguments.Port,
		ClusterName: strings.TrimSpace(arguments.ClusterName),
	})
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}
