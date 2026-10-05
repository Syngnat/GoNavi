package app

import (
	"errors"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/sqlaudit"
)

const sqlAuditFingerprintVersion = "sql-audit-connection-v1"

var errSQLAuditTemporarilyUnavailable = errors.New("SQL audit store is temporarily unavailable during data-root switching")

var replaceSQLAuditFile = atomicReplaceSQLAuditFile

var closeSQLAuditStoreHandle = func(store *sqlaudit.Store) error {
	return store.Close()
}

const (
	sqlAuditHealthStatusHealthy  = "healthy"
	sqlAuditHealthStatusDegraded = "degraded"
	webSQLAuditExportMaxRecords  = int64(10_000)
	webSQLAuditExportMaxBytes    = 8 * 1024 * 1024
)

type sqlAuditHealthState struct {
	Status         string `json:"status"`
	DroppedEvents  int64  `json:"droppedEvents"`
	FirstFailureAt int64  `json:"firstFailureAt"`
	LastFailureAt  int64  `json:"lastFailureAt"`
	LastSuccessAt  int64  `json:"lastSuccessAt"`
	LastError      string `json:"lastError"`
	// CaptureEnabled and CaptureMode are populated only for the API response.
	// Pointer + omitempty keeps the durable health sidecar independent from
	// settings while still representing an explicitly disabled capture state.
	CaptureEnabled *bool  `json:"captureEnabled,omitempty"`
	CaptureMode    string `json:"captureMode,omitempty"`
}

type sqlAuditPendingGap struct {
	DroppedEvents  int64
	FirstFailureAt int64
	LastFailureAt  int64
	LastError      string
}

type sqlAuditQueryInput struct {
	Config         connection.ConnectionConfig
	Database       string
	DBType         string
	QueryID        string
	SQL            string
	Source         string
	CommitMode     string
	Duration       time.Duration
	StatementCount int
	Result         connection.QueryResult
}

type sqlAuditTransactionEventInput struct {
	Config         connection.ConnectionConfig
	Database       string
	DBType         string
	QueryID        string
	TransactionID  string
	EventType      string
	Status         string
	Source         string
	CommitMode     string
	BoundaryMode   string
	SQL            string
	StatementIndex int
	StatementCount int
	ExecutedCount  int
	FailedIndex    int
	OutcomeUnknown bool
	Duration       time.Duration
	RowsAffected   int64
	RowsReturned   int64
	Err            error
}

type sqlAuditExportPayload struct {
	FileName string `json:"fileName"`
	MimeType string `json:"mimeType"`
	Content  string `json:"content"`
}
