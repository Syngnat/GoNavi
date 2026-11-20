// Package scriptlib owns saved JavaScript scripts and folders.
//
// The package deliberately has no dependency on Wails, database drivers, or
// the script runtime. It stores only script source and non-secret binding
// metadata. Shared scripts are sanitized before they leave the owner boundary.
package scriptlib

import "time"

const (
	VisibilityPrivate Visibility = "private"
	VisibilityShared  Visibility = "shared"
)

const (
	MaxScriptBytes = 256 << 10
	MaxNameRunes   = 120
	MaxDescRunes   = 500
	MaxBindings    = 32
	MaxAliasRunes  = 64
	MaxItems       = 5000
	MaxDiskBytes   = 64 << 20
)

// Visibility controls who can discover and run a saved script.
type Visibility string

// ScriptVisibility is kept as a descriptive alias for App integration code.
type ScriptVisibility = Visibility

// Actor is the authenticated owner of one script-library operation.
//
// Desktop uses Owner "desktop:local". Web uses "web:<normalized-login>".
// Legacy stored owners are migrated on load. A shared administrator may curate
// shared scripts but can never read another user's private scripts.
type Actor struct {
	Owner           string
	CanManageShared bool
	ReadOnly        bool
}

// ConnectionBinding maps a stable script alias to a saved connection.
type ConnectionBinding struct {
	Alias        string `json:"alias"`
	ConnectionID string `json:"connectionId,omitempty"`
	Database     string `json:"database,omitempty"`
}

// InputBinding maps a stable script alias to a local file or web upload.
//
// Path is intentionally the only location-shaped field. It is removed when a
// script is shared; the receiving user must explicitly bind a new file.
type InputBinding struct {
	Alias     string `json:"alias"`
	Path      string `json:"path,omitempty"`
	Reference string `json:"reference,omitempty"`
	Name      string `json:"name,omitempty"`
	SheetName string `json:"sheetName,omitempty"`
	Encoding  string `json:"encoding,omitempty"`
	Delimiter string `json:"delimiter,omitempty"`
	HeaderRow int    `json:"headerRow,omitempty"`
}

// RunLimits stores optional script-level execution limits. Zero values defer
// to the active runtime default instead of persisting a potentially incorrect
// desktop or web default.
type RunLimits struct {
	TimeoutMs        int64 `json:"timeoutMs,omitempty"`
	MaxDBCalls       int   `json:"maxDBCalls,omitempty"`
	MaxOutputRows    int   `json:"maxOutputRows,omitempty"`
	MemoryLimitBytes int64 `json:"memoryLimitBytes,omitempty"`
}

// Script is one saved JavaScript program.
type Script struct {
	ID          string              `json:"id"`
	Name        string              `json:"name"`
	Description string              `json:"description,omitempty"`
	Code        string              `json:"code"`
	Owner       string              `json:"owner"`
	Visibility  Visibility          `json:"visibility"`
	FolderID    string              `json:"folderId,omitempty"`
	Connections []ConnectionBinding `json:"connections,omitempty"`
	Inputs      []InputBinding      `json:"inputs,omitempty"`
	AllowWrite  bool                `json:"allowWrite"`
	BatchSize   int                 `json:"batchSize"`
	INListLimit int                 `json:"inListLimit"`
	RunLimits   RunLimits           `json:"runLimits,omitempty"`
	CanEdit     bool                `json:"canEdit"`
	CanShare    bool                `json:"canShare"`
	Revision    uint64              `json:"revision"`
	CreatedAt   int64               `json:"createdAt"`
	UpdatedAt   int64               `json:"updatedAt"`
}

// ScriptRecord is kept as a descriptive alias for App integration code.
type ScriptRecord = Script

// Folder groups scripts in the sidebar tree.
type Folder struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	ParentID   string     `json:"parentId,omitempty"`
	Owner      string     `json:"owner"`
	Visibility Visibility `json:"visibility"`
	CanEdit    bool       `json:"canEdit"`
	CanShare   bool       `json:"canShare"`
	Revision   uint64     `json:"revision"`
	CreatedAt  int64      `json:"createdAt"`
	UpdatedAt  int64      `json:"updatedAt"`
}

// ScriptFolder is kept as a descriptive alias for App integration code.
type ScriptFolder = Folder

// Snapshot is the complete view returned to one caller.
type Snapshot struct {
	// Owner is the display principal ("local" for desktop or the web login).
	// Persisted owners use desktop:/web: namespaces internally.
	Owner      string   `json:"owner"`
	Scripts    []Script `json:"scripts"`
	Folders    []Folder `json:"folders"`
	CanWrite   bool     `json:"canWrite"`
	CanShare   bool     `json:"canShare"`
	SharedOnly bool     `json:"sharedOnly"`
	ReadOnly   bool     `json:"readOnly"`
}

// SaveScriptInput is a create-or-update request. A zero Revision creates a new
// script after checking that ID is empty.
type SaveScriptInput struct {
	ID          string              `json:"id,omitempty"`
	Name        string              `json:"name"`
	Description string              `json:"description,omitempty"`
	Code        string              `json:"code"`
	Visibility  Visibility          `json:"visibility"`
	FolderID    string              `json:"folderId,omitempty"`
	Connections []ConnectionBinding `json:"connections,omitempty"`
	Inputs      []InputBinding      `json:"inputs,omitempty"`
	AllowWrite  bool                `json:"allowWrite"`
	BatchSize   int                 `json:"batchSize"`
	INListLimit int                 `json:"inListLimit"`
	RunLimits   RunLimits           `json:"runLimits,omitempty"`
	Revision    uint64              `json:"revision"`
}

// SaveFolderInput is a create-or-update request for a script folder.
type SaveFolderInput struct {
	ID         string     `json:"id,omitempty"`
	Name       string     `json:"name"`
	ParentID   string     `json:"parentId,omitempty"`
	Visibility Visibility `json:"visibility"`
	Revision   uint64     `json:"revision"`
}

// DeleteInput carries the optimistic-lock revision for destructive actions.
type DeleteInput struct {
	ID       string `json:"id"`
	Revision uint64 `json:"revision"`
}

// ShareInput changes a script or folder visibility.
type ShareInput struct {
	ID         string     `json:"id"`
	Revision   uint64     `json:"revision"`
	Visibility Visibility `json:"visibility"`
}

func nowMillis() int64 {
	return time.Now().UnixMilli()
}
