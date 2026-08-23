package syncjob

import "encoding/json"

const CurrentDefinitionVersion = 1

type JobLifecycle string

const (
	JobLifecycleDraft    JobLifecycle = "draft"
	JobLifecycleReady    JobLifecycle = "ready"
	JobLifecycleEnabled  JobLifecycle = "enabled"
	JobLifecyclePaused   JobLifecycle = "paused"
	JobLifecycleArchived JobLifecycle = "archived"
)

type JobKind string

const (
	JobKindMigration JobKind = "migration"
	JobKindReconcile JobKind = "reconcile"
	JobKindQuerySink JobKind = "query_sink"
	JobKindCompare   JobKind = "compare"
)

type IncrementalMode string

const (
	IncrementalSnapshot  IncrementalMode = "snapshot"
	IncrementalWatermark IncrementalMode = "watermark"
	IncrementalCDC       IncrementalMode = "cdc"
)

type ScheduleKind string

const (
	ScheduleManual     ScheduleKind = "manual"
	ScheduleOnce       ScheduleKind = "once"
	ScheduleInterval   ScheduleKind = "interval"
	ScheduleCron       ScheduleKind = "cron"
	ScheduleContinuous ScheduleKind = "continuous"
)

type ErrorPolicy string

const (
	ErrorPolicyStop    ErrorPolicy = "stop"
	ErrorPolicySkipRow ErrorPolicy = "skip_row"
)

type EndpointRef struct {
	ConnectionID   string `json:"connectionId"`
	ConnectionType string `json:"connectionType,omitempty"`
	ConnectionName string `json:"connectionName,omitempty"`
	Database       string `json:"database,omitempty"`
	Schema         string `json:"schema,omitempty"`
	Fingerprint    string `json:"fingerprint,omitempty"`
}

type ExecutionApproval struct {
	DefinitionHash    string `json:"definitionHash"`
	TargetFingerprint string `json:"targetFingerprint"`
	ApprovedAt        int64  `json:"approvedAt"`
	ApprovedByRuntime string `json:"approvedByRuntime"`
}

type TransformSpec struct {
	Kind     string          `json:"kind,omitempty"`
	Argument json.RawMessage `json:"argument,omitempty"`
}

type ColumnMapping struct {
	Source       string          `json:"source,omitempty"`
	Target       string          `json:"target"`
	Transform    TransformSpec   `json:"transform,omitempty"`
	DefaultValue json.RawMessage `json:"defaultValue,omitempty"`
	Required     bool            `json:"required,omitempty"`
}

type WatermarkSpec struct {
	Column            string          `json:"column"`
	InitialValue      json.RawMessage `json:"initialValue,omitempty"`
	TieBreakerColumns []string        `json:"tieBreakerColumns,omitempty"`
}

type TableMapping struct {
	SourceSchema        string          `json:"sourceSchema,omitempty"`
	SourceTable         string          `json:"sourceTable"`
	TargetSchema        string          `json:"targetSchema,omitempty"`
	TargetTable         string          `json:"targetTable"`
	TargetTableStrategy string          `json:"targetTableStrategy,omitempty"`
	Filter              string          `json:"filter,omitempty"`
	KeyColumns          []string        `json:"keyColumns,omitempty"`
	Columns             []ColumnMapping `json:"columns,omitempty"`
	Watermark           *WatermarkSpec  `json:"watermark,omitempty"`
	Enabled             bool            `json:"enabled"`
}

type ExecutionOptions struct {
	Content             string      `json:"content,omitempty"`
	SyncMode            string      `json:"syncMode,omitempty"`
	TargetTableStrategy string      `json:"targetTableStrategy,omitempty"`
	AutoAddColumns      bool        `json:"autoAddColumns,omitempty"`
	CreateIndexes       bool        `json:"createIndexes,omitempty"`
	PropagateDeletes    bool        `json:"propagateDeletes,omitempty"`
	BatchSize           int         `json:"batchSize,omitempty"`
	ErrorPolicy         ErrorPolicy `json:"errorPolicy,omitempty"`
	MaxRetries          int         `json:"maxRetries,omitempty"`
	RetryBackoffMillis  int         `json:"retryBackoffMillis,omitempty"`
	CaptureErrorPayload bool        `json:"captureErrorPayload,omitempty"`
}

type ScheduleSpec struct {
	Kind            ScheduleKind `json:"kind"`
	RunAt           int64        `json:"runAt,omitempty"`
	IntervalSeconds int64        `json:"intervalSeconds,omitempty"`
	CronExpression  string       `json:"cronExpression,omitempty"`
	Timezone        string       `json:"timezone,omitempty"`
	AnchorAt        int64        `json:"anchorAt,omitempty"`
	MisfirePolicy   string       `json:"misfirePolicy,omitempty"`
}

type CDCSpec struct {
	Adapter         string `json:"adapter,omitempty"`
	StartPosition   string `json:"startPosition,omitempty"`
	InitialSnapshot bool   `json:"initialSnapshot,omitempty"`
	SlotName        string `json:"slotName,omitempty"`
	PublicationName string `json:"publicationName,omitempty"`
}

type JobDefinition struct {
	Version           int                `json:"version"`
	ID                string             `json:"id"`
	Name              string             `json:"name"`
	Description       string             `json:"description,omitempty"`
	Lifecycle         JobLifecycle       `json:"lifecycle"`
	Enabled           bool               `json:"enabled"`
	Kind              JobKind            `json:"kind"`
	IncrementalMode   IncrementalMode    `json:"incrementalMode"`
	Source            EndpointRef        `json:"source"`
	Target            EndpointRef        `json:"target"`
	SourceQuery       string             `json:"sourceQuery,omitempty"`
	Mappings          []TableMapping     `json:"mappings"`
	Options           ExecutionOptions   `json:"options"`
	Schedule          ScheduleSpec       `json:"schedule"`
	CDC               *CDCSpec           `json:"cdc,omitempty"`
	Approval          *ExecutionApproval `json:"approval,omitempty"`
	ConcurrencyPolicy string             `json:"concurrencyPolicy,omitempty"`
	ResumePolicy      string             `json:"resumePolicy,omitempty"`
	Revision          int64              `json:"revision"`
	CreatedAt         int64              `json:"createdAt"`
	UpdatedAt         int64              `json:"updatedAt"`
	NextRunAt         int64              `json:"nextRunAt,omitempty"`
	LastScheduledAt   int64              `json:"lastScheduledAt,omitempty"`
	ArchivedAt        int64              `json:"archivedAt,omitempty"`
}

type RunStatus string

const (
	RunStatusQueued      RunStatus = "queued"
	RunStatusRunning     RunStatus = "running"
	RunStatusCancelling  RunStatus = "cancelling"
	RunStatusPaused      RunStatus = "paused"
	RunStatusSucceeded   RunStatus = "succeeded"
	RunStatusPartial     RunStatus = "partial"
	RunStatusFailed      RunStatus = "failed"
	RunStatusCanceled    RunStatus = "canceled"
	RunStatusInterrupted RunStatus = "interrupted"
)

type RunTrigger string

const (
	RunTriggerManual   RunTrigger = "manual"
	RunTriggerSchedule RunTrigger = "schedule"
	RunTriggerResume   RunTrigger = "resume"
	RunTriggerRetry    RunTrigger = "retry"
)

type RunRecord struct {
	ID                 string          `json:"id"`
	JobID              string          `json:"jobId"`
	OwnerToken         string          `json:"-"`
	JobRevision        int64           `json:"jobRevision"`
	Trigger            RunTrigger      `json:"trigger"`
	Status             RunStatus       `json:"status"`
	ParentRunID        string          `json:"parentRunId,omitempty"`
	Attempt            int             `json:"attempt"`
	QueuedAt           int64           `json:"queuedAt"`
	StartedAt          int64           `json:"startedAt,omitempty"`
	FinishedAt         int64           `json:"finishedAt,omitempty"`
	HeartbeatAt        int64           `json:"heartbeatAt,omitempty"`
	Current            int             `json:"current"`
	Total              int             `json:"total"`
	Table              string          `json:"table,omitempty"`
	Stage              string          `json:"stage,omitempty"`
	RowsInserted       int64           `json:"rowsInserted"`
	RowsUpdated        int64           `json:"rowsUpdated"`
	RowsDeleted        int64           `json:"rowsDeleted"`
	RowsFailed         int64           `json:"rowsFailed"`
	Message            string          `json:"message,omitempty"`
	Resumable          bool            `json:"resumable"`
	DefinitionSnapshot json.RawMessage `json:"definitionSnapshot,omitempty"`
	SourceFingerprint  string          `json:"sourceFingerprint,omitempty"`
	TargetFingerprint  string          `json:"targetFingerprint,omitempty"`
	CreatedAt          int64           `json:"createdAt"`
	UpdatedAt          int64           `json:"updatedAt"`
}

type Checkpoint struct {
	Version            int             `json:"version"`
	Kind               string          `json:"kind"`
	JobID              string          `json:"jobId"`
	RunID              string          `json:"runId"`
	DefinitionRevision int64           `json:"definitionRevision"`
	Table              string          `json:"table"`
	Phase              string          `json:"phase"`
	CursorType         string          `json:"cursorType"`
	Cursor             json.RawMessage `json:"cursor,omitempty"`
	Watermark          json.RawMessage `json:"watermark,omitempty"`
	BatchSequence      int64           `json:"batchSequence"`
	SchemaHash         string          `json:"schemaHash,omitempty"`
	UpdatedAt          int64           `json:"updatedAt"`
}

type ErrorRowStatus string

const (
	ErrorRowPending   ErrorRowStatus = "pending"
	ErrorRowRetrying  ErrorRowStatus = "retrying"
	ErrorRowResolved  ErrorRowStatus = "resolved"
	ErrorRowDiscarded ErrorRowStatus = "discarded"
)

type ErrorRow struct {
	ID                  string          `json:"id"`
	RunID               string          `json:"runId"`
	JobID               string          `json:"jobId"`
	SourceTable         string          `json:"sourceTable,omitempty"`
	TargetTable         string          `json:"targetTable,omitempty"`
	Operation           string          `json:"operation,omitempty"`
	SourceKey           json.RawMessage `json:"sourceKey,omitempty"`
	Payload             json.RawMessage `json:"payload,omitempty"`
	PayloadPolicy       string          `json:"payloadPolicy,omitempty"`
	PayloadHash         string          `json:"payloadHash,omitempty"`
	PayloadSize         int64           `json:"payloadSize,omitempty"`
	Error               string          `json:"error"`
	ErrorCode           string          `json:"errorCode,omitempty"`
	ErrorClass          string          `json:"errorClass,omitempty"`
	Attempts            int             `json:"attempts"`
	Status              ErrorRowStatus  `json:"status"`
	RetryOwner          string          `json:"-"`
	RetryLeaseExpiresAt int64           `json:"-"`
	CreatedAt           int64           `json:"createdAt"`
	UpdatedAt           int64           `json:"updatedAt"`
}

type ExecutionOutcome struct {
	RowsInserted int64  `json:"rowsInserted"`
	RowsUpdated  int64  `json:"rowsUpdated"`
	RowsDeleted  int64  `json:"rowsDeleted"`
	RowsFailed   int64  `json:"rowsFailed"`
	Message      string `json:"message,omitempty"`
	Resumable    bool   `json:"resumable"`
}

type RunProgress struct {
	Current int    `json:"current"`
	Total   int    `json:"total"`
	Table   string `json:"table,omitempty"`
	Stage   string `json:"stage,omitempty"`
	Message string `json:"message,omitempty"`
}

type RunEventType string

const (
	RunEventQueued      RunEventType = "queued"
	RunEventStarted     RunEventType = "started"
	RunEventProgress    RunEventType = "progress"
	RunEventCheckpoint  RunEventType = "checkpoint"
	RunEventErrorRow    RunEventType = "error_row"
	RunEventLog         RunEventType = "log"
	RunEventCancelling  RunEventType = "cancelling"
	RunEventCanceled    RunEventType = "canceled"
	RunEventSucceeded   RunEventType = "succeeded"
	RunEventPartial     RunEventType = "partial"
	RunEventFailed      RunEventType = "failed"
	RunEventInterrupted RunEventType = "interrupted"
)

type RunEvent struct {
	RunID     string          `json:"runId"`
	JobID     string          `json:"jobId"`
	Sequence  int64           `json:"sequence"`
	Type      RunEventType    `json:"type"`
	Status    RunStatus       `json:"status,omitempty"`
	Current   int             `json:"current,omitempty"`
	Total     int             `json:"total,omitempty"`
	Table     string          `json:"table,omitempty"`
	Stage     string          `json:"stage,omitempty"`
	Message   string          `json:"message,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
	CreatedAt int64           `json:"createdAt"`
}
