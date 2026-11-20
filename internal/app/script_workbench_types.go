package app

import (
	"context"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/scriptengine"
	"GoNavi-Wails/internal/scriptlib"
	"GoNavi-Wails/internal/scriptlimits"
)

const (
	scriptWorkbenchEventLog      = "log"
	scriptWorkbenchEventProgress = "progress"
	scriptWorkbenchEventOutput   = "output"
	scriptWorkbenchEventDone     = "done"
)

const (
	scriptWorkbenchStatusQueued    = "queued"
	scriptWorkbenchStatusRunning   = "running"
	scriptWorkbenchStatusSucceeded = "succeeded"
	scriptWorkbenchStatusFailed    = "failed"
	scriptWorkbenchStatusCancelled = "cancelled"
	scriptWorkbenchStatusTimedOut  = "timed_out"
)

const (
	scriptWorkbenchDesktopConcurrency = 1
	scriptWorkbenchWebConcurrency     = 2
	scriptWorkbenchWebUserConcurrency = 1
	scriptWorkbenchDesktopTimeout     = time.Duration(scriptlimits.DefaultDesktopTimeoutMs) * time.Millisecond
	scriptWorkbenchWebTimeout         = time.Duration(scriptlimits.DefaultWebTimeoutMs) * time.Millisecond
	scriptWorkbenchMinTimeout         = time.Duration(scriptlimits.MinTimeoutMs) * time.Millisecond
	scriptWorkbenchDesktopMaxTimeout  = time.Duration(scriptlimits.MaxDesktopTimeoutMs) * time.Millisecond
	scriptWorkbenchWebMaxTimeout      = time.Duration(scriptlimits.MaxWebTimeoutMs) * time.Millisecond
	scriptWorkbenchDefaultQueryRows   = scriptlimits.DefaultQueryRows
	scriptWorkbenchMaxQueryRows       = scriptlimits.MaxQueryRows
	scriptWorkbenchMaxLogs            = 500
	scriptWorkbenchMaxLogBytes        = 256 << 10
	scriptWorkbenchDefaultOutputRows  = scriptlimits.DefaultMaxOutputRows
	scriptWorkbenchMaxOutputRows      = scriptlimits.MaxOutputRows
	scriptWorkbenchMaxOutputs         = 32
	scriptWorkbenchMaxOutputBytes     = 24 << 20
	scriptWorkbenchDefaultBatchRows   = 500
	scriptWorkbenchMaxBatchRows       = 5_000
	scriptWorkbenchDefaultINList      = 1_000
	scriptWorkbenchDefaultDBCalls     = scriptlimits.DefaultMaxDBCalls
	scriptWorkbenchMaxDBCalls         = scriptlimits.MaxDBCalls
	scriptWorkbenchDefaultMemoryLimit = scriptlimits.DefaultMemoryLimitBytes
	scriptWorkbenchMinMemoryLimit     = scriptlimits.MinMemoryLimitBytes
	scriptWorkbenchDesktopMaxMemory   = scriptlimits.MaxDesktopMemoryLimitBytes
	scriptWorkbenchWebMaxMemory       = scriptlimits.MaxWebMemoryLimitBytes

	scriptWorkbenchInputCellBytes         = 4 << 20
	scriptWorkbenchInputRowBytes          = 8 << 20
	scriptWorkbenchInputPageBytes         = 8 << 20
	scriptWorkbenchInputFieldLimit        = 4_096
	scriptWorkbenchInputEntryBytes        = 64 << 20
	scriptWorkbenchInputArchiveBytes      = 128 << 20
	scriptWorkbenchInputCompressionRate   = 100
	scriptWorkbenchInputSharedStrings     = 50_000
	scriptWorkbenchInputSharedStringBytes = 32 << 20
)

// ScriptWorkbenchConnection maps one script alias to a saved connection.
type ScriptWorkbenchConnection struct {
	Alias        string `json:"alias"`
	ConnectionID string `json:"connectionId"`
	Database     string `json:"database,omitempty"`
}

// ScriptWorkbenchInput maps one script alias to a CSV, JSON, or XLSX input.
type ScriptWorkbenchInput struct {
	Alias     string `json:"alias"`
	Path      string `json:"path,omitempty"`
	Reference string `json:"reference,omitempty"`
	Name      string `json:"name,omitempty"`
	SheetName string `json:"sheetName,omitempty"`
	Encoding  string `json:"encoding,omitempty"`
	Delimiter string `json:"delimiter,omitempty"`
	HeaderRow int    `json:"headerRow,omitempty"`
}

// ScriptWorkbenchRunRequest is the only frontend input that can start a run.
// Connection passwords and DSNs are never accepted here.
type ScriptWorkbenchRunRequest struct {
	ScriptID         string                      `json:"scriptId,omitempty"`
	Script           string                      `json:"script,omitempty"`
	Title            string                      `json:"title,omitempty"`
	Connections      []ScriptWorkbenchConnection `json:"connections,omitempty"`
	Inputs           []ScriptWorkbenchInput      `json:"inputs,omitempty"`
	AllowWrite       bool                        `json:"allowWrite"`
	BatchSize        int                         `json:"batchSize,omitempty"`
	INListLimit      int                         `json:"inListLimit,omitempty"`
	TimeoutMs        int64                       `json:"timeoutMs,omitempty"`
	MaxDBCalls       int                         `json:"maxDbCalls,omitempty"`
	MaxOutputRows    int                         `json:"maxOutputRows,omitempty"`
	MemoryLimitBytes int64                       `json:"memoryLimitBytes,omitempty"`
	// WriteApprovalToken 必须来自 PrepareScriptWorkbenchWrite，只能用于一次
	// 完全相同的生产写运行；非生产写保持为空。
	WriteApprovalToken string `json:"writeApprovalToken,omitempty"`
}

// ScriptWorkbenchLogEntry is a bounded, display-only log line.
type ScriptWorkbenchLogEntry struct {
	Sequence  int64  `json:"sequence"`
	Timestamp int64  `json:"timestamp"`
	Level     string `json:"level"`
	Message   string `json:"message"`
}

// ScriptWorkbenchOutputInfo describes one named result stream.
type ScriptWorkbenchOutputInfo struct {
	Index     int      `json:"index"`
	Name      string   `json:"name"`
	Columns   []string `json:"columns"`
	RowCount  int      `json:"rowCount"`
	Truncated bool     `json:"truncated"`
}

// ScriptWorkbenchOutputPage is a bounded page of one output stream.
type ScriptWorkbenchOutputPage struct {
	OutputIndex int              `json:"outputIndex"`
	Name        string           `json:"name"`
	Columns     []string         `json:"columns"`
	Rows        []map[string]any `json:"rows"`
	Total       int              `json:"total"`
	Page        int              `json:"page"`
	PageSize    int              `json:"pageSize"`
	Truncated   bool             `json:"truncated"`
}

// ScriptWorkbenchRunSnapshot is safe to return through Wails and Web RPC.
type ScriptWorkbenchRunSnapshot struct {
	RunID            string                      `json:"runId"`
	ScriptID         string                      `json:"scriptId,omitempty"`
	Title            string                      `json:"title,omitempty"`
	Status           string                      `json:"status"`
	Stage            string                      `json:"stage,omitempty"`
	StartedAt        int64                       `json:"startedAt"`
	FinishedAt       int64                       `json:"finishedAt,omitempty"`
	AllowWrite       bool                        `json:"allowWrite"`
	Cancelled        bool                        `json:"cancelled,omitempty"`
	TimedOut         bool                        `json:"timedOut,omitempty"`
	MemoryExceeded   bool                        `json:"memoryExceeded,omitempty"`
	Error            string                      `json:"error,omitempty"`
	ErrorKind        string                      `json:"errorKind,omitempty"`
	DBCalls          int                         `json:"dbCalls"`
	MaxDBCalls       int                         `json:"maxDbCalls"`
	Progress         map[string]any              `json:"progress,omitempty"`
	Logs             []ScriptWorkbenchLogEntry   `json:"logs"`
	LogsTruncated    bool                        `json:"logsTruncated,omitempty"`
	Outputs          []ScriptWorkbenchOutputInfo `json:"outputs"`
	OutputsTruncated bool                        `json:"outputsTruncated,omitempty"`
}

// ScriptWorkbenchLibrarySnapshot extends the script library snapshot with the
// current actor so the workbench can apply UI-level affordances.
type ScriptWorkbenchLibrarySnapshot struct {
	scriptlib.Snapshot
	SharedScriptingDisabled bool `json:"sharedScriptingDisabled,omitempty"`
	CanManageShared         bool `json:"canManageShared,omitempty"`
}

type scriptWorkbenchOutput struct {
	name      string
	columns   []string
	rows      []map[string]any
	truncated bool
}

type scriptWorkbenchPrepared struct {
	request               ScriptWorkbenchRunRequest
	code                  string
	title                 string
	scriptID              string
	actor                 scriptlib.Actor
	webActor              webScriptActor
	allowWrite            bool
	batchSize             int
	inListLimit           int
	timeout               time.Duration
	maxDBCalls            int
	maxOutputRows         int
	defaultQueryRows      int
	maxQueryRows          int
	memoryLimitBytes      int64
	connections           map[string]scriptPreparedConnection
	inputs                map[string]scriptPreparedInput
	workerRequest         scriptengine.RunRequest
	requiresWriteApproval bool
}

type scriptPreparedConnection struct {
	alias           string
	config          connection.ConnectionConfig
	database        string
	readOnly        bool
	dbType          string
	environmentType string
}

type scriptPreparedInput struct {
	alias     string
	path      string
	reference string
	name      string
	sheetName string
	encoding  string
	delimiter string
	headerRow int
	batchSize int
}

type webScriptActor struct {
	username             string
	role                 string
	allowedConnectionIDs map[string]struct{}
}

type scriptWorkbenchRunContextKey struct{}
type scriptWorkbenchRunHandleContextKey struct{}

func scriptWorkbenchContextWithRun(ctx context.Context, runID string) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, scriptWorkbenchRunContextKey{}, strings.TrimSpace(runID))
}

func scriptWorkbenchRunIDFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	value, _ := ctx.Value(scriptWorkbenchRunContextKey{}).(string)
	return strings.TrimSpace(value)
}

func scriptWorkbenchContextWithRunHandle(
	ctx context.Context,
	run *scriptWorkbenchRun,
) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	if run == nil {
		return ctx
	}
	return context.WithValue(ctx, scriptWorkbenchRunHandleContextKey{}, run)
}

func scriptWorkbenchRunFromContext(ctx context.Context) *scriptWorkbenchRun {
	if ctx == nil {
		return nil
	}
	run, _ := ctx.Value(scriptWorkbenchRunHandleContextKey{}).(*scriptWorkbenchRun)
	return run
}
