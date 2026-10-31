package app

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/plugin"
)

type pluginCapabilityInvokeArguments struct {
	Command      string          `json:"command"`
	Arguments    json.RawMessage `json:"arguments,omitempty"`
	ConnectionID string          `json:"connectionId,omitempty"`
}

func pluginCapabilityCommandAcceptsConfig(command plugin.Command) bool {
	if len(command.InputSchema) == 0 {
		return false
	}
	var schema struct {
		Properties map[string]json.RawMessage `json:"properties"`
	}
	if err := json.Unmarshal(command.InputSchema, &schema); err != nil {
		return false
	}
	_, ok := schema.Properties["config"]
	return ok
}

func pluginCapabilityManifestHasPermission(manifest plugin.Manifest, permission string) bool {
	for _, item := range manifest.Permissions {
		if strings.TrimSpace(item) == permission {
			return true
		}
	}
	return false
}

// pluginCapabilityInvoke lets a declared plugin page invoke only commands that
// its own manifest declares. When the command accepts a connection config and
// the plugin holds host.connections.credentials, the host resolves the saved
// connection and injects it into the backend arguments; the page never sees it.
func pluginCapabilityInvoke(ctx context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilityInvokeArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	commandID := strings.TrimSpace(arguments.Command)
	if commandID == "" || len(commandID) > 128 {
		return nil, "invalid_arguments"
	}
	var declared *plugin.Command
	for index := range request.Status.Manifest.Contributes.Commands {
		if request.Status.Manifest.Contributes.Commands[index].ID == commandID {
			declared = &request.Status.Manifest.Contributes.Commands[index]
			break
		}
	}
	if declared == nil {
		return nil, "invalid_arguments"
	}
	rawArguments := arguments.Arguments
	if len(rawArguments) == 0 {
		rawArguments = json.RawMessage(`{}`)
	}
	if !json.Valid(rawArguments) {
		return nil, "invalid_arguments"
	}
	if connectionID := strings.TrimSpace(arguments.ConnectionID); connectionID != "" &&
		pluginCapabilityCommandAcceptsConfig(*declared) &&
		pluginCapabilityManifestHasPermission(request.Status.Manifest, plugin.ConnectionsCredentialsPermission) {
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(rawArguments, &payload); err != nil || payload == nil {
			return nil, "invalid_arguments"
		}
		config, code := a.pluginPageConnectionConfig(connectionID)
		if code != "" {
			return nil, code
		}
		encoded, err := json.Marshal(config)
		if err != nil {
			return nil, "internal"
		}
		payload["config"] = encoded
		payload["readOnly"] = json.RawMessage(strconv.FormatBool(pluginPageConnectionReadOnly(config)))
		rawArguments, err = json.Marshal(payload)
		if err != nil {
			return nil, "internal"
		}
	}
	manager, err := a.pluginManager(ctx)
	if err != nil {
		return nil, "runtime_unavailable"
	}
	value, err := manager.InvokeGeneration(ctx, request.Caller.PluginID, request.Caller.Generation, commandID, rawArguments)
	if err != nil {
		return nil, "internal"
	}
	return json.RawMessage(value), ""
}
