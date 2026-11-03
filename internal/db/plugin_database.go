package db

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"GoNavi-Wails/internal/plugin"
)

const (
	pluginDatabaseMaxJSON      = 1 << 20
	pluginDatabaseMaxQuery     = 256 << 10
	pluginDatabaseMaxRows      = 10000
	pluginDatabaseMaxFields    = 512
	pluginDatabaseMaxNames     = 10000
	pluginDatabaseMaxName      = 1024
	pluginDatabaseMaxText      = 64 << 10
	pluginDatabaseMaxCalls     = 8
	pluginDatabaseCloseTimeout = 250 * time.Millisecond
)

// ErrPluginDatabaseClosed means the adapter session is permanently closed.
var ErrPluginDatabaseClosed = errors.New("plugin database session is closed")

// ErrPluginDatabaseUnavailable means its immutable runtime generation is unavailable.
var ErrPluginDatabaseUnavailable = errors.New("plugin database generation is unavailable")

// ErrPluginDatabaseReadOnly rejects all writes and missing read-only policy validation.
var ErrPluginDatabaseReadOnly = errors.New("plugin database requires read-only operations")

// ErrPluginDatabaseProtocol rejects malformed, ambiguous or oversized plugin replies.
var ErrPluginDatabaseProtocol = errors.New("invalid plugin database response")

// ErrPluginDatabaseBudget rejects a complete reply that exceeds the caller budget.
var ErrPluginDatabaseBudget = errors.New("plugin database result exceeds caller row budget")

const (
	pluginDatabaseNew = iota
	pluginDatabaseConnecting
	pluginDatabaseConnected
	pluginDatabaseClosed
)

type pluginDatabaseRuntime interface {
	List() []plugin.Status
	InvokeDataSourceGeneration(context.Context, string, uint64, string, json.RawMessage) (json.RawMessage, error)
}

// PluginDatabase binds one SQL session to one installed plugin generation.
// Read-only declarations reject writes; writable declarations add explicit exec and
// transaction operations. It never registers a global driver, executes plugin code,
// reconnects or replays.
type PluginDatabase struct {
	mu               sync.Mutex
	runtime          pluginDatabaseRuntime
	pluginID         string
	generation       uint64
	digest           string
	installedAt      string
	source           plugin.DataSource
	connectionType   string
	sessionID        string
	validateReadOnly func(string) error
	state            int
	pending          map[uint64]context.CancelFunc
	nextCall         uint64
	connectTimeout   time.Duration
	queryTimeout     time.Duration
	closeDone        chan struct{}
	closeErr         error
}

var _ Database = (*PluginDatabase)(nil)
var _ QueryContexter = (*PluginDatabase)(nil)
var _ ColumnDefinitionContexter = (*PluginDatabase)(nil)
var _ ReadOnlyQueryContexter = (*PluginDatabase)(nil)

// NewPluginDatabase accepts only a declared source in the current installed
// generation. The validator is the host's read-only SQL safety policy.
func NewPluginDatabase(manager *plugin.Manager, status plugin.Status, source plugin.DataSource, validateReadOnly func(string) error) (*PluginDatabase, error) {
	if manager == nil {
		return nil, ErrPluginDatabaseUnavailable
	}
	return newPluginDatabase(manager, status, source, validateReadOnly)
}

func newPluginDatabase(runtime pluginDatabaseRuntime, status plugin.Status, source plugin.DataSource, validator func(string) error) (*PluginDatabase, error) {
	if runtime == nil || status.Generation == 0 || status.Digest == "" {
		return nil, ErrPluginDatabaseUnavailable
	}
	if validator == nil {
		return nil, ErrPluginDatabaseReadOnly
	}
	connectionType := plugin.DataSourceType(status.Manifest.ID, source)
	if connectionType == "" || !pluginDatabaseSourceDeclared(status, source) {
		return nil, ErrPluginDatabaseUnavailable
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return nil, pluginDatabaseFailure("create session", err)
	}
	database := &PluginDatabase{runtime: runtime, pluginID: status.Manifest.ID, generation: status.Generation,
		digest: status.Digest, installedAt: status.InstalledAt, source: source, connectionType: connectionType,
		sessionID: base64.RawURLEncoding.EncodeToString(secret), validateReadOnly: validator,
		pending: make(map[uint64]context.CancelFunc), connectTimeout: 30 * time.Second, closeDone: make(chan struct{})}
	if !database.runtimeCurrent() {
		return nil, ErrPluginDatabaseUnavailable
	}
	return database, nil
}

// PluginGeneration exposes the immutable generation for host-owned cache keys.
func (p *PluginDatabase) PluginGeneration() uint64 { return p.generation }

// IsCurrent checks local closure and the installed source identity without starting
// a runtime. False means callers must evict this handle, never reconnect it.
func (p *PluginDatabase) IsCurrent() bool {
	p.mu.Lock()
	closed := p.state == pluginDatabaseClosed
	p.mu.Unlock()
	return !closed && p.runtimeCurrent()
}

func (p *PluginDatabase) runtimeCurrent() bool {
	for _, status := range p.runtime.List() {
		if status.Manifest.ID != p.pluginID {
			continue
		}
		return status.Generation == p.generation && status.Digest == p.digest && status.InstalledAt == p.installedAt &&
			pluginDatabaseSourceDeclared(status, p.source)
	}
	return false
}

func pluginDatabaseSourceDeclared(status plugin.Status, source plugin.DataSource) bool {
	if status.State != plugin.StateRunning || !status.DesiredEnabled || status.Manifest.Backend == nil {
		return false
	}
	permission, command := false, false
	for _, name := range status.Manifest.Permissions {
		if name == "data.sources" {
			permission = true
		}
	}
	for _, item := range status.Manifest.Contributes.Commands {
		if item.ID == source.Command {
			command = true
		}
	}
	if !permission || !command {
		return false
	}
	for _, declared := range status.Manifest.Contributes.DataSources {
		if declared == source {
			return true
		}
	}
	return false
}

type pluginDatabaseOperationError struct {
	operation string
	cause     error
}

func (e *pluginDatabaseOperationError) Error() string {
	return "plugin database " + e.operation + " failed"
}
func (e *pluginDatabaseOperationError) Unwrap() error { return e.cause }

func pluginDatabaseFailure(operation string, cause error) error {
	// Plugin diagnostics may contain selected credentials or SQL. Preserve error
	// classification without allowing arbitrary backend text into host logs/UI.
	return &pluginDatabaseOperationError{operation: operation, cause: cause}
}
