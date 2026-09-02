package importjob

type Kind string

const (
	KindTable Kind = "table"
	KindSQL   Kind = "sql"
)

type Status string

const (
	StatusPreparing   Status = "preparing"
	StatusRunning     Status = "running"
	StatusStopping    Status = "stopping"
	StatusCompleted   Status = "completed"
	StatusPartial     Status = "partial"
	StatusFailed      Status = "failed"
	StatusCancelled   Status = "cancelled"
	StatusUnknown     Status = "unknown"
	StatusInterrupted Status = "interrupted"
)

type Checkpoint struct {
	Safe             bool  `json:"safe"`
	SourceRow        int64 `json:"sourceRow,omitempty"`
	ByteOffset       int64 `json:"byteOffset,omitempty"`
	StatementIndex   int64 `json:"statementIndex,omitempty"`
	TransactionStart int64 `json:"transactionStart,omitempty"`
}

// TableImportOptions is the replayable, non-secret part of a table-import
// request. Runtime identifiers and source identity live on Job so a recovery
// attempt cannot replace either through this persisted recipe.
type TableImportOptions struct {
	ColumnMappings     map[string]string `json:"columnMappings,omitempty"`
	ContinueOnError    *bool             `json:"continueOnError,omitempty"`
	Encoding           string            `json:"encoding,omitempty"`
	Delimiter          string            `json:"delimiter,omitempty"`
	HeaderRow          int               `json:"headerRow,omitempty"`
	NullToken          *string           `json:"nullToken,omitempty"`
	EmptyStringAsNull  bool              `json:"emptyStringAsNull,omitempty"`
	SheetName          string            `json:"sheetName,omitempty"`
	ConflictPolicy     string            `json:"conflictPolicy,omitempty"`
	ConflictKeyColumns []string          `json:"conflictKeyColumns,omitempty"`
}

type Job struct {
	ID                            string              `json:"id"`
	Kind                          Kind                `json:"kind"`
	Status                        Status              `json:"status"`
	Stage                         string              `json:"stage,omitempty"`
	SourcePath                    string              `json:"sourcePath,omitempty"`
	SourceIdentityToken           string              `json:"sourceIdentityToken"`
	SourceContentSHA256           string              `json:"sourceContentSha256,omitempty"`
	TargetFingerprint             string              `json:"targetFingerprint"`
	ConnectionID                  string              `json:"connectionId,omitempty"`
	DatabaseName                  string              `json:"databaseName,omitempty"`
	TableName                     string              `json:"tableName,omitempty"`
	OptionsHash                   string              `json:"optionsHash"`
	Current                       int64               `json:"current,omitempty"`
	Total                         int64               `json:"total,omitempty"`
	Succeeded                     int64               `json:"succeeded,omitempty"`
	Skipped                       int64               `json:"skipped,omitempty"`
	Failed                        int64               `json:"failed,omitempty"`
	BytesRead                     int64               `json:"bytesRead,omitempty"`
	SourceBytesTotal              int64               `json:"sourceBytesTotal,omitempty"`
	ByteProgressKind              string              `json:"byteProgressKind,omitempty"`
	TableImportOptions            *TableImportOptions `json:"tableImportOptions,omitempty"`
	ParentJobID                   string              `json:"parentJobId,omitempty"`
	RecoveryAction                string              `json:"recoveryAction,omitempty"`
	OutcomeUnknown                bool                `json:"outcomeUnknown,omitempty"`
	Resumable                     bool                `json:"resumable,omitempty"`
	Checkpoint                    Checkpoint          `json:"checkpoint"`
	ErrorArtifactID               string              `json:"errorArtifactId,omitempty"`
	ErrorArtifactCount            int64               `json:"errorArtifactCount,omitempty"`
	ErrorArtifactBytes            int64               `json:"errorArtifactBytes,omitempty"`
	ErrorArtifactOmittedCount     int64               `json:"errorArtifactOmittedCount,omitempty"`
	ErrorArtifactTruncated        bool                `json:"errorArtifactTruncated,omitempty"`
	ErrorArtifactRetryableCount   int64               `json:"errorArtifactRetryableCount,omitempty"`
	ErrorArtifactUnretryableCount int64               `json:"errorArtifactUnretryableCount,omitempty"`
	ErrorArtifactScopeKnown       bool                `json:"errorArtifactScopeKnown,omitempty"`
	ErrorArtifactMaxRows          int64               `json:"errorArtifactMaxRows,omitempty"`
	ErrorArtifactMaxBytes         int64               `json:"errorArtifactMaxBytes,omitempty"`
	Message                       string              `json:"message,omitempty"`
	Revision                      int64               `json:"revision"`
	CreatedAt                     int64               `json:"createdAt"`
	UpdatedAt                     int64               `json:"updatedAt"`
}
