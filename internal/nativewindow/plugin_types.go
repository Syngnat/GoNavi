package nativewindow

import (
	"context"
	"encoding/json"
	"io/fs"
	"time"

	"GoNavi-Wails/internal/plugin"
)

// PluginWindowArgument selects the isolated plugin UI child before App startup.
const PluginWindowArgument = "--plugin-window"

const (
	pluginBridgePrefix      = "/__gonavi/plugin-window/"
	pluginAssetPrefix       = "/plugin-assets/"
	pluginTokenHeader       = "X-GoNavi-Plugin-Token"
	pluginWindowHeader      = "X-GoNavi-Plugin-Window"
	pluginMaxJSONBytes      = 1 << 20
	pluginMaxCalls          = 8
	pluginMaxWindows        = 16
	pluginHeartbeatInterval = time.Second
	pluginHeartbeatTimeout  = 3 * time.Second
	pluginStartupTimeout    = 10 * time.Second
	pluginStopTimeout       = 2 * time.Second
	pluginTeardownTimeout   = 10 * time.Second
)

// PluginControllerOptions supplies only the standalone bridge bundle, not the
// host frontend. Assets must contain runtime.js at its root.
type PluginControllerOptions struct {
	Assets     fs.FS
	Executable string
	// Capability dispatches one plugin-window capability through the host
	// registry. The controller authenticates the window token and generation
	// first; the callback re-checks the live plugin generation and permissions.
	Capability func(ctx context.Context, pluginID string, generation uint64, method string, arguments json.RawMessage) (json.RawMessage, error)
	// OnWindowClosed 在 supervisor 内清理窗口所属 generation 的后端状态。
	// 回调期间保留重开屏障；必须响应 ctx 的生命周期取消与清理超时。
	OnWindowClosed func(ctx context.Context, info PluginWindowInfo)
}

// PluginWindowInfo identifies a host-owned child; it carries no bridge secret.
type PluginWindowInfo struct {
	ID         string `json:"id"`
	PluginID   string `json:"pluginId"`
	Generation uint64 `json:"generation"`
	PID        int    `json:"pid"`
}

type pluginWindowRuntime interface {
	List() []plugin.Status
	AssetPath(id, relative string) (string, error)
	InvokeGeneration(ctx context.Context, id string, generation uint64, command string, args json.RawMessage) (json.RawMessage, error)
}

type pluginProcessSpec struct {
	executable string
	args       []string
	env        []string
	directory  string
}

type pluginProcess interface {
	PID() int
	Wait() error
	Kill() error
}

type pluginBootstrap struct {
	PluginID            string          `json:"pluginId"`
	Generation          uint64          `json:"generation"`
	Title               string          `json:"title"`
	Context             json.RawMessage `json:"context,omitempty"`
	Preferences         json.RawMessage `json:"preferences,omitempty"`
	PreferencesRevision uint64          `json:"preferencesRevision,omitempty"`
}

type pluginInvokeRequest struct {
	ID        string          `json:"id"`
	Command   string          `json:"command"`
	Arguments json.RawMessage `json:"arguments"`
}

type pluginCapabilityRequest struct {
	ID        string          `json:"id"`
	Method    string          `json:"method"`
	Arguments json.RawMessage `json:"arguments"`
}
