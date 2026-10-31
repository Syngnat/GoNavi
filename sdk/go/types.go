package plugin

import "encoding/json"

// APIVersion is the supported GoNavi plugin wire protocol version.
const APIVersion = 1

// Manifest describes an immutable plugin package; the host validates it.
// Icon optionally names the installed-plugin logo: a package-relative raster path
// the host reads without starting the plugin. A plugin without one falls back to
// its first AI provider icon.
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
	Requires        []Requirement     `json:"requires,omitempty"`
	Backend         *Backend          `json:"backend,omitempty"`
	Contributes     *Contributions    `json:"contributes,omitempty"`
	Window          *Window           `json:"window,omitempty"`
	ConfigSchema    json.RawMessage   `json:"configSchema,omitempty"`
}

// Requirement declares a plugin dependency rather than an implicit install.
type Requirement struct {
	ID         string `json:"id"`
	MinVersion string `json:"minVersion,omitempty"`
	Optional   bool   `json:"optional,omitempty"`
}

// Backend selects a package-relative entry point for the host platform.
type Backend struct {
	Default   *Entry           `json:"default,omitempty"`
	Platforms map[string]Entry `json:"platforms,omitempty"`
}

// Entry names a native executable or a script with an explicit runtime.
type Entry struct {
	Executable string   `json:"executable"`
	Args       []string `json:"args,omitempty"`
	Runtime    string   `json:"runtime,omitempty"`
}

// Contributions contains only supported declarative extension points.
// Pages and Navigation are host-rendered surfaces that require the ui.pages permission.
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

// ConnectionAction is a generic connection/database/collection context-menu
// contribution. The host renders the target surface and owns the launch context.
type ConnectionAction struct {
	ID              string       `json:"id"`
	Title           string       `json:"title"`
	Description     string       `json:"description,omitempty"`
	ConnectionTypes []string     `json:"connectionTypes"`
	Scopes          []string     `json:"scopes,omitempty"`
	Target          LaunchTarget `json:"target"`
}

// LaunchTarget selects the window or page opened for a contribution.
type LaunchTarget struct {
	Type string `json:"type"`
	Page string `json:"page,omitempty"`
}

// Skill declares an immutable UTF-8 SKILL.md document loaded only on explicit use.
// Skills require ai.skills permission, but do not grant tools, hooks, or system-prompt authority.
type Skill struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Entry       string   `json:"entry"`
	Resources   []string `json:"resources,omitempty"`
}

// SkillContent is explicit-load text with its host-authenticated package provenance.
// It is a tool-result resource, not a system instruction or permission grant.
type SkillContent struct {
	PluginID    string `json:"pluginId"`
	SkillID     string `json:"skillId"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Version     string `json:"version"`
	Digest      string `json:"digest"`
	Generation  uint64 `json:"generation"`
	Content     string `json:"content"`
}

// DataSource declares a read-only SQL-family driver using a declared backend command.
// ID is lowercase ASCII, starts with a letter, and is at most 64 characters.
// Dialect is mysql, postgres, or sqlite; DefaultPort zero omits the default.
// ReadOnly must be true, and the manifest must request data.sources permission.
type DataSource struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Dialect     string `json:"dialect"`
	Command     string `json:"command"`
	DefaultPort int    `json:"defaultPort,omitempty"`
	ReadOnly    bool   `json:"readOnly"`
}

// Command describes an invokable command local to one plugin.
type Command struct {
	ID          string          `json:"id"`
	Title       string          `json:"title"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
	Effect      string          `json:"effect,omitempty"`
}

// Panel is host-rendered data, never executable HTML or JavaScript.
type Panel struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Body  UINode `json:"body"`
}

// UINode uses text, alert, column, row, button or table as Type.
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

// Column describes one declarative table column.
type Column struct {
	Key   string `json:"key"`
	Title string `json:"title"`
}

// Window requests a separate plugin UI process, not a host-page script.
type Window struct {
	Entry  string `json:"entry"`
	Title  string `json:"title,omitempty"`
	Width  int    `json:"width,omitempty"`
	Height int    `json:"height,omitempty"`
}

// InitializeParams identifies the host-approved instance and generation.
type InitializeParams struct {
	APIVersion  int             `json:"apiVersion"`
	PluginID    string          `json:"pluginId"`
	Version     string          `json:"version"`
	Generation  uint64          `json:"generation"`
	Config      json.RawMessage `json:"config"`
	HostVersion string          `json:"hostVersion"`
	Locale      string          `json:"locale"`
	Permissions []string        `json:"permissions"`
}

// InvokeParams carries one command and its untrusted JSON arguments.
type InvokeParams struct {
	CommandID string          `json:"commandId"`
	Arguments json.RawMessage `json:"arguments"`
}
