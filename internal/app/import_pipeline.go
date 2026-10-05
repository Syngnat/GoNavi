package app

import (
	"context"
	"errors"
	"io"
	"time"
)

const (
	defaultImportPreviewLimit   = 5
	defaultImportApplyBatchSize = 1000
	maxImportErrorDetails       = 20
	maxImportCellBytes          = 16 * 1024 * 1024
	maxImportRowBytes           = 64 * 1024 * 1024
	maxImportBatchBytes         = 64 * 1024 * 1024
	importProgressRowInterval   = 100
	importProgressTimeInterval  = 250 * time.Millisecond
)

var errImportStoppedOnError = errors.New("import stopped on error")
var errImportPreviewLimitReached = errors.New("import preview limit reached")

type importStoppedOnError struct {
	detail string
	cause  error
}

func (e *importStoppedOnError) Error() string {
	if e == nil {
		return errImportStoppedOnError.Error()
	}
	return e.detail
}

func (e *importStoppedOnError) Unwrap() error {
	if e != nil && e.cause != nil {
		return errors.Join(errImportStoppedOnError, e.cause)
	}
	return errImportStoppedOnError
}

type importFileConsumer interface {
	SetColumns(columns []string) error
	ConsumeRow(row map[string]interface{}) error
}

type contextImportFileConsumer struct {
	ctx      context.Context
	delegate importFileConsumer
}

func (c *contextImportFileConsumer) SetColumns(columns []string) error {
	if err := c.ctx.Err(); err != nil {
		return err
	}
	return c.delegate.SetColumns(columns)
}

func (c *contextImportFileConsumer) ConsumeRow(row map[string]interface{}) error {
	if err := c.ctx.Err(); err != nil {
		return err
	}
	return c.delegate.ConsumeRow(row)
}

func (c *contextImportFileConsumer) SetImportSourceProgress(bytesRead int64, totalBytes int64, stage string) {
	if progress, ok := c.delegate.(importSourceProgressConsumer); ok {
		progress.SetImportSourceProgress(bytesRead, totalBytes, stage)
	}
}

type importSourceProgressConsumer interface {
	SetImportSourceProgress(bytesRead int64, totalBytes int64, stage string)
}

type importByteCountingReader struct {
	reader    io.Reader
	bytesRead int64
}

func (r *importByteCountingReader) Read(buffer []byte) (int, error) {
	read, err := r.reader.Read(buffer)
	r.bytesRead += int64(read)
	return read, err
}

func reportImportSourceProgress(consumer importFileConsumer, bytesRead int64, totalBytes int64) {
	if progressConsumer, ok := consumer.(importSourceProgressConsumer); ok {
		progressConsumer.SetImportSourceProgress(bytesRead, totalBytes, "parse")
	}
}

type importPreviewData struct {
	Columns        []string
	TotalRows      int
	TotalRowsKnown bool
	PreviewRows    []map[string]interface{}
}

// ImportFileOptions controls how a selected import file is applied to the target table.
// A nil ColumnMappings value preserves the legacy behavior where file headers are used
// directly as database column names. A non-nil map enables explicit source-to-target
// mapping; entries with an empty target are skipped.
type ImportFileOptions struct {
	ColumnMappings      map[string]string `json:"columnMappings,omitempty"`
	JobID               string            `json:"jobId,omitempty"`
	ContinueOnError     *bool             `json:"continueOnError,omitempty"`
	Encoding            string            `json:"encoding,omitempty"`
	Delimiter           string            `json:"delimiter,omitempty"`
	HeaderRow           int               `json:"headerRow,omitempty"`
	NullToken           *string           `json:"nullToken,omitempty"`
	EmptyStringAsNull   bool              `json:"emptyStringAsNull,omitempty"`
	SheetName           string            `json:"sheetName,omitempty"`
	SourceIdentityToken string            `json:"sourceIdentityToken,omitempty"`
	ConflictPolicy      string            `json:"conflictPolicy,omitempty"`
	ConflictKeyColumns  []string          `json:"conflictKeyColumns,omitempty"`
	ResumeJobID         string            `json:"resumeJobId,omitempty"`
}

func resolveImportContinueOnError(options ImportFileOptions) bool {
	// Keep the public compatibility entrypoint's historical continue behavior
	// when the field is omitted. The workbench always sends an explicit value
	// and defaults to fail-fast.
	return options.ContinueOnError == nil || *options.ContinueOnError
}

type importProgressState struct {
	JobID          string `json:"jobId,omitempty"`
	Current        int    `json:"current"`
	Total          int    `json:"total,omitempty"`
	Success        int    `json:"success"`
	Skipped        int    `json:"skipped,omitempty"`
	Errors         int    `json:"errors"`
	TotalRowsKnown bool   `json:"totalRowsKnown,omitempty"`
	BytesRead      int64  `json:"bytesRead,omitempty"`
	TotalBytes     int64  `json:"totalBytes,omitempty"`
	Stage          string `json:"stage,omitempty"`
	CheckpointSafe bool   `json:"checkpointSafe,omitempty"`
}

type importExecutionResult struct {
	Success                       int
	Skipped                       int
	Failed                        int
	Total                         int
	ErrorLogs                     []string
	ErrorArtifactID               string
	ErrorArtifactCount            int64
	ErrorArtifactBytes            int64
	ErrorArtifactOmittedCount     int64
	ErrorArtifactTruncated        bool
	ErrorArtifactRetryableCount   int64
	ErrorArtifactUnretryableCount int64
	ErrorArtifactScopeKnown       bool
	ErrorArtifactMaxRows          int64
	ErrorArtifactMaxBytes         int64
	StoppedOnError                bool
	OutcomeUnknown                bool
}
