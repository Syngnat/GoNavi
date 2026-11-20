// Package scriptengine defines GoNavi's isolated JavaScript execution protocol.
//
// The JavaScript runtime always runs in a separate process. The parent sends
// only script source, aliases, and non-secret descriptors; database
// credentials and local paths stay in the authenticated host process.
package scriptengine

import (
	"context"
	"encoding/json"
	"time"
	"unicode/utf8"

	"GoNavi-Wails/internal/scriptlimits"
)

const (
	WorkerModeArg = "script-worker"

	DefaultDesktopTimeout = time.Duration(scriptlimits.DefaultDesktopTimeoutMs) * time.Millisecond
	DefaultWebTimeout     = time.Duration(scriptlimits.DefaultWebTimeoutMs) * time.Millisecond
	DefaultMaxDBCalls     = scriptlimits.DefaultMaxDBCalls
	MaxDBCalls            = scriptlimits.MaxDBCalls
	DefaultBatchSize      = 500
	MaxBatchSize          = 5_000
	DefaultINListLimit    = 1_000
	MaxINListLimit        = 1_000
	DefaultQueryRows      = scriptlimits.DefaultQueryRows
	MaxQueryRows          = scriptlimits.MaxQueryRows
	DefaultOutputRows     = scriptlimits.DefaultMaxOutputRows
	MaxOutputRows         = scriptlimits.MaxOutputRows
	MaxOutputBytes        = 24 << 20
	MaxOutputChunkBytes   = 8 << 20
	MaxOutputNameBytes    = 256
	MaxLogEntries         = 500
	MaxLogBytes           = 256 << 10
	MaxLogMessageBytes    = 8 << 10
	MaxProgressBytes      = 64 << 10
	MaxErrorMessageBytes  = 8 << 10
	MaxTitleBytes         = 4 << 10
	MaxFrameBytes         = 32 << 20
	MaxScriptBytes        = 256 << 10
	DefaultMemoryLimit    = scriptlimits.DefaultMemoryLimitBytes
	MinMemoryLimit        = scriptlimits.MinMemoryLimitBytes
	MaxMemoryLimit        = scriptlimits.MaxDesktopMemoryLimitBytes
)

// Limits are fixed by the parent before a worker starts.
type Limits struct {
	Timeout          time.Duration `json:"-"`
	TimeoutMs        int64         `json:"timeoutMs"`
	MaxDBCalls       int           `json:"maxDbCalls"`
	MaxOutputRows    int           `json:"maxOutputRows"`
	DefaultBatch     int           `json:"defaultBatch"`
	MaxBatch         int           `json:"maxBatch"`
	DefaultINList    int           `json:"defaultInList"`
	MaxINList        int           `json:"maxInList"`
	DefaultQueryRows int           `json:"defaultQueryRows"`
	MaxQueryRows     int           `json:"maxQueryRows"`
	MemoryLimitBytes int64         `json:"memoryLimitBytes"`
}

func NormalizeLimits(input Limits, timeout time.Duration) Limits {
	if timeout <= 0 {
		timeout = DefaultDesktopTimeout
	}
	if input.Timeout > 0 && input.Timeout < timeout {
		timeout = input.Timeout
	}
	input.Timeout = timeout
	input.TimeoutMs = timeout.Milliseconds()
	input.MaxDBCalls = clamp(input.MaxDBCalls, 1, MaxDBCalls, DefaultMaxDBCalls)
	input.MaxOutputRows = clamp(input.MaxOutputRows, 1, MaxOutputRows, DefaultOutputRows)
	input.DefaultBatch = clamp(input.DefaultBatch, 1, MaxBatchSize, DefaultBatchSize)
	input.MaxBatch = clamp(input.MaxBatch, input.DefaultBatch, MaxBatchSize, MaxBatchSize)
	input.DefaultINList = clamp(input.DefaultINList, 1, MaxINListLimit, DefaultINListLimit)
	input.MaxINList = clamp(input.MaxINList, 1, MaxINListLimit, input.DefaultINList)
	input.DefaultQueryRows = clamp(input.DefaultQueryRows, 1, MaxQueryRows, DefaultQueryRows)
	input.MaxQueryRows = clamp(input.MaxQueryRows, input.DefaultQueryRows, MaxQueryRows, MaxQueryRows)
	input.MemoryLimitBytes = clampInt64(input.MemoryLimitBytes, MinMemoryLimit, MaxMemoryLimit, DefaultMemoryLimit)
	return input
}

// ConnectionSpec is the only connection-shaped value sent to a worker.
type ConnectionSpec struct {
	Alias    string `json:"alias"`
	Database string `json:"database,omitempty"`
	Type     string `json:"type,omitempty"`
	ReadOnly bool   `json:"readOnly"`
}

// FileSpec describes one already-authorized input stream.
type FileSpec struct {
	Alias     string `json:"alias"`
	FileName  string `json:"fileName"`
	SheetName string `json:"sheetName,omitempty"`
	Encoding  string `json:"encoding,omitempty"`
	Delimiter string `json:"delimiter,omitempty"`
	HeaderRow int    `json:"headerRow"`
	BatchSize int    `json:"batchSize"`
}

// RunRequest is the first frame written to a worker.
type RunRequest struct {
	RunID       string           `json:"runId"`
	Script      string           `json:"script"`
	Connections []ConnectionSpec `json:"connections"`
	Files       []FileSpec       `json:"files"`
	Limits      Limits           `json:"limits"`
}

// HostRequest asks the trusted parent to perform one privileged operation.
type HostRequest struct {
	ID     int64           `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

// Event is a non-privileged worker update consumed by the workbench.
type Event struct {
	Type    string          `json:"type"`
	Level   string          `json:"level,omitempty"`
	Message string          `json:"message,omitempty"`
	Name    string          `json:"name,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// RunResult is the final worker result before host-side accounting is added.
type RunResult struct {
	Success        bool   `json:"success"`
	Message        string `json:"message,omitempty"`
	DurationMs     int64  `json:"durationMs,omitempty"`
	Cancelled      bool   `json:"cancelled,omitempty"`
	TimedOut       bool   `json:"timedOut,omitempty"`
	MemoryExceeded bool   `json:"memoryExceeded,omitempty"`
}

// Host handles privileged requests for one run.
type Host interface {
	Handle(ctx context.Context, request HostRequest) (any, error)
}

// Observer receives log, progress, and output events from the worker.
// Returning an error rejects the event and fails the script run.
type Observer func(Event) error

func clamp(value, minimum, maximum, fallback int) int {
	if value <= 0 {
		return fallback
	}
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func clampInt64(value, minimum, maximum, fallback int64) int64 {
	if value <= 0 {
		return fallback
	}
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func truncateUTF8Text(value string, maxBytes int) string {
	if maxBytes <= 0 || value == "" {
		return ""
	}
	if len(value) <= maxBytes {
		return value
	}
	end := maxBytes
	for end > 0 && !utf8.ValidString(value[:end]) {
		end--
	}
	return value[:end]
}
