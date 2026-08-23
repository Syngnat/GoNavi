package sqlaudit

const (
	CaptureModeRedacted = "redacted"
	CaptureModeMetadata = "metadata"

	BoundaryModeDriverAPI = "driver_api"
	BoundaryModeTextSQL   = "text_sql"
	BoundaryModeImplicit  = "implicit"
	BoundaryModeUnknown   = "unknown"

	CommitModeAuto    = "auto"
	CommitModeManual  = "manual"
	CommitModePending = "pending"
)

const (
	defaultPageSize      = 50
	maxPageSize          = 500
	defaultRetentionDays = 30
	defaultMaxRecords    = 100_000
)

// Event is one immutable SQL audit fact. SQLText is always sanitized again by
// Store.Append; callers cannot use this type to persist raw SQL.
type Event struct {
	ID                    string `json:"id"`
	Sequence              int64  `json:"sequence"`
	Timestamp             int64  `json:"timestamp"`
	EventType             string `json:"eventType"`
	Status                string `json:"status"`
	ConnectionID          string `json:"connectionId"`
	ConnectionFingerprint string `json:"connectionFingerprint"`
	DBType                string `json:"dbType"`
	Database              string `json:"database"`
	QueryID               string `json:"queryId"`
	TransactionID         string `json:"transactionId"`
	Source                string `json:"source"`
	BoundaryMode          string `json:"boundaryMode"`
	CommitMode            string `json:"commitMode"`
	SQLText               string `json:"sqlText"`
	SQLRedacted           bool   `json:"sqlRedacted"`
	SQLFingerprint        string `json:"sqlFingerprint"`
	StatementIndex        int    `json:"statementIndex"`
	StatementCount        int    `json:"statementCount"`
	ExecutedCount         int    `json:"executedCount,omitempty"`
	FailedIndex           int    `json:"failedIndex,omitempty"`
	OutcomeUnknown        bool   `json:"outcomeUnknown,omitempty"`
	DurationMs            int64  `json:"durationMs"`
	RowsAffected          int64  `json:"rowsAffected"`
	RowsReturned          int64  `json:"rowsReturned"`
	Error                 string `json:"error"`
	PrevHash              string `json:"prevHash"`
	Hash                  string `json:"hash"`
}

type Filter struct {
	Search        string `json:"search"`
	ConnectionID  string `json:"connectionId"`
	Database      string `json:"database"`
	DBType        string `json:"dbType"`
	EventType     string `json:"eventType"`
	Status        string `json:"status"`
	TransactionID string `json:"transactionId"`
	Source        string `json:"source"`
	FromTimestamp int64  `json:"fromTimestamp"`
	ToTimestamp   int64  `json:"toTimestamp"`
	// ExecutionHistory limits results to user-triggered SQL editor executions.
	// It deliberately excludes transaction lifecycle/control events while still
	// including per-statement managed-transaction executions and failed opens.
	ExecutionHistory bool `json:"executionHistory"`
	Page             int  `json:"page"`
	PageSize         int  `json:"pageSize"`
}

type Summary struct {
	TotalEvents      int64 `json:"totalEvents"`
	SuccessCount     int64 `json:"successCount"`
	ErrorCount       int64 `json:"errorCount"`
	TransactionCount int64 `json:"transactionCount"`
}

type Page struct {
	Items    []Event `json:"items"`
	Total    int64   `json:"total"`
	Page     int     `json:"page"`
	PageSize int     `json:"pageSize"`
	Summary  Summary `json:"summary"`
}

type Settings struct {
	Enabled       bool   `json:"enabled"`
	CaptureMode   string `json:"captureMode"`
	RetentionDays int    `json:"retentionDays"`
	MaxRecords    int    `json:"maxRecords"`
}

func DefaultSettings() Settings {
	return Settings{
		Enabled:       true,
		CaptureMode:   CaptureModeRedacted,
		RetentionDays: defaultRetentionDays,
		MaxRecords:    defaultMaxRecords,
	}
}

// IntegrityReport reports local SHA-256 chain consistency. WeakValidation is
// always true because an unkeyed chain detects accidental/local edits but does
// not stop an attacker who can rewrite both records and hashes.
type IntegrityReport struct {
	Valid           bool   `json:"valid"`
	WeakValidation  bool   `json:"weakValidation"`
	PartialChain    bool   `json:"partialChain"`
	TruncatedPrefix bool   `json:"truncatedPrefix"`
	Algorithm       string `json:"algorithm"`
	CheckedRecords  int64  `json:"checkedRecords"`
	FirstSequence   int64  `json:"firstSequence,omitempty"`
	LastSequence    int64  `json:"lastSequence,omitempty"`
	InvalidSequence int64  `json:"invalidSequence,omitempty"`
	Message         string `json:"message"`
}
