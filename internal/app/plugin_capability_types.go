package app

import (
	"context"
	"encoding/json"
	"time"

	"GoNavi-Wails/internal/plugin"
)

// pluginCapabilityChannel identifies which host surface may call a capability.
// The page bridge, the plugin window bridge and the native plugin backend share
// one registry; the channel decides whether a method is reachable at all.
type pluginCapabilityChannel uint8

const (
	pluginCapabilityChannelPage pluginCapabilityChannel = 1 << iota
	pluginCapabilityChannelWindow
	pluginCapabilityChannelBackend
	pluginCapabilityChannelUI
)

func (c pluginCapabilityChannel) names() []string {
	names := make([]string, 0, 4)
	if c&pluginCapabilityChannelPage != 0 {
		names = append(names, "page")
	}
	if c&pluginCapabilityChannelWindow != 0 {
		names = append(names, "window")
	}
	if c&pluginCapabilityChannelBackend != 0 {
		names = append(names, "backend")
	}
	if c&pluginCapabilityChannelUI != 0 {
		names = append(names, "ui")
	}
	return names
}

// pluginCapabilityRuntime is the process family a capability is available in.
// Web sessions deliberately share the registry but keep desktop-only methods
// out of reach through the same permission gate.
type pluginCapabilityRuntime uint8

const (
	pluginCapabilityRuntimeDesktop pluginCapabilityRuntime = 1 << iota
	pluginCapabilityRuntimeWeb
	pluginCapabilityRuntimeHeadless
)

func (r pluginCapabilityRuntime) allows(name string) bool {
	switch name {
	case "web":
		return r&pluginCapabilityRuntimeWeb != 0
	case "headless":
		return r&pluginCapabilityRuntimeHeadless != 0
	default:
		return r&pluginCapabilityRuntimeDesktop != 0
	}
}

// pluginCapabilityCaller is bound by the host. A plugin can never supply its
// own identity, generation, page or permission list through arguments.
type pluginCapabilityCaller struct {
	PluginID    string
	Generation  uint64
	PageID      string
	Channel     pluginCapabilityChannel
	Runtime     string
	Locale      string
	Permissions []string
}

// pluginCapabilityRequest is the immutable context handed to one handler.
type pluginCapabilityRequest struct {
	Caller    pluginCapabilityCaller
	Status    plugin.Status
	Method    string
	Arguments json.RawMessage
}

// pluginCapabilityHandler returns a JSON-serializable value or a stable failure
// code. Handlers must honor ctx and must not leak credentials.
type pluginCapabilityHandler func(ctx context.Context, a *App, request pluginCapabilityRequest) (any, string)

// pluginCapabilitySpec is one registered host capability. Adding a capability
// means adding a spec, a permission, docs and tests; it is never a reflection
// entry point over the Wails bindings.
type pluginCapabilitySpec struct {
	Name                 string
	Permission           string
	Description          string
	Channels             pluginCapabilityChannel
	Runtimes             pluginCapabilityRuntime
	Mutating             bool
	Destructive          bool
	RequiresConfirmation bool
	MaxArgsBytes         int
	MaxResultBytes       int
	Timeout              time.Duration
	Handler              pluginCapabilityHandler
}

type pluginCapabilities map[string]pluginCapabilitySpec

// pluginCapabilityDescription is the safe introspection shape returned by
// app.capabilities. It never contains handler names or host paths.
type pluginCapabilityDescription struct {
	Name                 string   `json:"name"`
	Permission           string   `json:"permission"`
	Description          string   `json:"description,omitempty"`
	Channels             []string `json:"channels"`
	Mutating             bool     `json:"mutating"`
	Destructive          bool     `json:"destructive"`
	RequiresConfirmation bool     `json:"requiresConfirmation"`
	Granted              bool     `json:"granted"`
}
