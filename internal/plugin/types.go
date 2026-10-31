// Package plugin installs trusted local packages and supervises isolated processes.
// Process isolation is a reliability boundary, not an operating-system sandbox.
package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

// Manifest is the version-one immutable package declaration.
type Manifest struct {
	SchemaVersion   int               `json:"schemaVersion"`
	APIVersion      int               `json:"apiVersion"`
	ID              string            `json:"id"`
	Name            string            `json:"name"`
	Version         string            `json:"version"`
	Description     string            `json:"description,omitempty"`
	Author          string            `json:"author,omitempty"`
	License         string            `json:"license,omitempty"`
	Icon            string            `json:"icon,omitempty"`
	MinHostVersion  string            `json:"minHostVersion,omitempty"`
	Permissions     []string          `json:"permissions"`
	PermissionNotes map[string]string `json:"permissionNotes,omitempty"`
	Requires        []Dependency      `json:"requires,omitempty"`
	Backend         *Backend          `json:"backend,omitempty"`
	Contributes     Contributions     `json:"contributes,omitempty"`
	Window          *Window           `json:"window,omitempty"`
	ConfigSchema    json.RawMessage   `json:"configSchema,omitempty"`
}

// Dependency declares an installed dependency; dependencies are never downloaded implicitly.
type Dependency struct {
	ID         string `json:"id"`
	MinVersion string `json:"minVersion,omitempty"`
	Optional   bool   `json:"optional,omitempty"`
}

// Backend selects a package executable without shell interpretation.
type Backend struct {
	Default   *Entry           `json:"default,omitempty"`
	Platforms map[string]Entry `json:"platforms,omitempty"`
}

// Entry identifies a native executable or a script for a discovered interpreter.
type Entry struct {
	Executable string   `json:"executable"`
	Args       []string `json:"args,omitempty"`
	Runtime    string   `json:"runtime,omitempty"`
}

// Contributions are bounded declarations; backend extensions use declared commands.
type Contributions struct {
	Commands          []Command          `json:"commands,omitempty"`
	Panels            []Panel            `json:"panels,omitempty"`
	DataSources       []DataSource       `json:"dataSources,omitempty"`
	Skills            []Skill            `json:"skills,omitempty"`
	AIProviders       []AIProvider       `json:"aiProviders,omitempty"`
	Exporters         []Exporter         `json:"exporters,omitempty"`
	Pages             []Page             `json:"pages,omitempty"`
	Navigation        []Navigation       `json:"navigation,omitempty"`
	ConnectionActions []ConnectionAction `json:"connectionActions,omitempty"`
}

// ConnectionAction is a generic host surface entry rendered in connection, database
// or collection context menus. The host owns the click target and launch context.
type ConnectionAction struct {
	ID              string       `json:"id"`
	Title           string       `json:"title"`
	Description     string       `json:"description,omitempty"`
	ConnectionTypes []string     `json:"connectionTypes"`
	Scopes          []string     `json:"scopes,omitempty"`
	Target          LaunchTarget `json:"target"`
}

// LaunchTarget selects the host surface opened for one contribution.
type LaunchTarget struct {
	Type string `json:"type"`
	Page string `json:"page,omitempty"`
}

// Command declares one backend invocation and its claimed effect.
type Command struct {
	ID          string          `json:"id"`
	Title       string          `json:"title"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
	Effect      string          `json:"effect,omitempty"`
}

// Panel declares exactly one body: a host-rendered bounded tree or a custom HTML
// document that the host only ever shows inside a sandboxed cross-origin frame.
type Panel struct {
	ID    string     `json:"id"`
	Title string     `json:"title"`
	Body  UINode     `json:"body,omitzero"`
	HTML  *HTMLPanel `json:"html,omitempty"`
}

// HTMLPanel carries bounded custom markup as inert data. The host never parses,
// rewrites or inlines it into the main window; only an opaque-origin sandbox
// renders it, without host filesystem, network, storage or bindings access.
type HTMLPanel struct {
	Source string `json:"source"`
}

// Page declares one host-rendered surface: a bounded declarative tree or a
// sandboxed custom HTML document. Exactly one body is present. Body is a
// pointer so an html page omits the key instead of echoing an empty tree.
type Page struct {
	ID    string     `json:"id"`
	Title string     `json:"title"`
	Body  *UINode    `json:"body,omitempty"`
	HTML  *HTMLPanel `json:"html,omitempty"`
}

// Navigation attaches a declared page or the plugin's own window to a host
// location. Target stays an enumeration: "page" (the default) opens the page in
// a workbench tab, "window" opens the window declared by the manifest. Location
// stays an enumeration, and order only reorders entries of the same plugin.
type Navigation struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Target   string `json:"target,omitempty"`
	Page     string `json:"page,omitempty"`
	Location string `json:"location"`
	Order    int    `json:"order,omitempty"`
}

// UINode is a declarative element; HTML, scripts, expressions and styles are unsupported.
type UINode struct {
	Type      string                       `json:"type"`
	Text      string                       `json:"text,omitempty"`
	Title     string                       `json:"title,omitempty"`
	Children  []UINode                     `json:"children,omitempty"`
	Command   string                       `json:"command,omitempty"`
	Arguments json.RawMessage              `json:"arguments,omitempty"`
	Columns   []Column                     `json:"columns,omitempty"`
	Rows      []map[string]json.RawMessage `json:"rows,omitempty"`
}

// Column names one data column in a declarative table.
type Column struct {
	Key   string `json:"key"`
	Title string `json:"title"`
}

// Window requests an independent native UI process.
type Window struct {
	Entry  string `json:"entry"`
	Title  string `json:"title,omitempty"`
	Width  int    `json:"width,omitempty"`
	Height int    `json:"height,omitempty"`
}

// Inspection is a no-execution view of exact package contents, not archive transport bytes.
type Inspection struct {
	Manifest   Manifest `json:"manifest"`
	Digest     string   `json:"digest"`
	SourcePath string   `json:"sourcePath"`
	SizeBytes  int64    `json:"sizeBytes"`
}

// InstallRequest records explicit trust of the exact inspected digest.
type InstallRequest struct {
	Path    string `json:"path"`
	Digest  string `json:"digest"`
	Trusted bool   `json:"trusted"`
}

// State reports the lifecycle state independently of durable user intent.
type State string

// Lifecycle states only expose contributions when StateRunning and desired enabled.
const (
	StateDisabled State = "disabled"
	StateStarting State = "starting"
	StateRunning  State = "running"
	StateStopping State = "stopping"
	StateFaulted  State = "faulted"
	StateBlocked  State = "blocked"
)

// Status is the persistent status of an installed package. Callers own returned values.
type Status struct {
	Manifest       Manifest `json:"manifest"`
	Digest         string   `json:"digest"`
	State          State    `json:"state"`
	DesiredEnabled bool     `json:"desiredEnabled"`
	Generation     uint64   `json:"generation"`
	LastError      string   `json:"lastError,omitempty"`
	InstalledAt    string   `json:"installedAt"`
}

// Options configures the owner and bounded request/lifecycle timings. Zero values use defaults.
type Options struct {
	Root                     string
	HostVersion              string
	Disabled                 bool
	Locale                   string
	HandshakeTimeout         time.Duration
	HeartbeatInterval        time.Duration
	HeartbeatTimeout         time.Duration
	MissedHeartbeats         int
	ShutdownTimeout          time.Duration
	InvocationTimeout        time.Duration
	ReconcileInterval        time.Duration
	MaxConcurrentInvocations int
	// HostCapability forwards a caller-bound host capability request to the
	// embedding application. A nil callback disables host.capability without
	// affecting host.log or host.describe.
	HostCapability func(ctx context.Context, pluginID string, generation uint64, params json.RawMessage) (json.RawMessage, error)
	// ProxyEnvironment reports extra proxy variables ("NAME=value") for every
	// backend process this manager launches. The embedding host returns its
	// configured proxy while the global proxy is enabled and nil otherwise, so a
	// disabled proxy leaves the child on the host environment. It is evaluated at
	// each launch, so a later change applies to plugins started afterwards. Only
	// proxy variable names are accepted, so the callback cannot widen what a
	// plugin process reads.
	ProxyEnvironment func() []string
}

// ErrLocked means another runtime owner or a busy state writer holds the OS lock.
var ErrLocked = errors.New("plugin state or runtime is locked")

// ErrDisabled means the plugin is disabled, fenced, or unavailable in safe mode.
var ErrDisabled = errors.New("plugin is not enabled and running")

// ErrNotFound means an installed package or declared command does not exist.
var ErrNotFound = errors.New("plugin or command not found")

// ErrEnabled rejects removal while the record still wants to run: the caller must stop the
// plugin first so no live process keeps executing a package that is being deleted.
var ErrEnabled = errors.New("plugin is still enabled; disable it before removal")

// ErrBusy means the bounded invocation budget is exhausted.
var ErrBusy = errors.New("plugin invocation capacity exhausted")

// ErrClosed means the manager has already closed.
var ErrClosed = errors.New("plugin manager is closed")

// ErrDigestMismatch rejects changed packages after inspection.
var ErrDigestMismatch = errors.New("plugin package digest mismatch")
