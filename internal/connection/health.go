package connection

// ConnectionHealthStatus is deliberately a small, transport-safe vocabulary.
// The client localizes labels and recommendations instead of receiving raw
// driver errors, connection strings, or metadata values from the probe.
type ConnectionHealthStatus string

const (
	ConnectionHealthStatusPassed      ConnectionHealthStatus = "passed"
	ConnectionHealthStatusFailed      ConnectionHealthStatus = "failed"
	ConnectionHealthStatusUnsupported ConnectionHealthStatus = "unsupported"
)

const (
	ConnectionHealthCheckPing             = "ping"
	ConnectionHealthCheckVersion          = "version"
	ConnectionHealthCheckTLS              = "tls"
	ConnectionHealthCheckPermissions      = "permissions"
	ConnectionHealthCheckSchemaVisibility = "schema_visibility"
	ConnectionHealthCheckPagination       = "pagination"
	ConnectionHealthCheckResponse         = "response"
)

// ConnectionHealthCheck is one non-mutating probe result. Detail is reserved
// for safe server version text only; it must never contain a driver error,
// connection endpoint, credential, query result, or metadata name.
type ConnectionHealthCheck struct {
	Key            string                 `json:"key"`
	Status         ConnectionHealthStatus `json:"status"`
	DurationMs     int64                  `json:"durationMs,omitempty"`
	Detail         string                 `json:"detail,omitempty"`
	Recommendation string                 `json:"recommendation,omitempty"`
}

// ConnectionHealthReport contains a saved connection's health summary. It
// intentionally excludes ConnectionConfig; exporters must omit its saved
// connection identity fields before sharing a report.
type ConnectionHealthReport struct {
	ConnectionID   string                  `json:"connectionId"`
	ConnectionName string                  `json:"connectionName,omitempty"`
	ConnectionType string                  `json:"connectionType,omitempty"`
	OverallStatus  ConnectionHealthStatus  `json:"overallStatus"`
	DurationMs     int64                   `json:"durationMs"`
	Checks         []ConnectionHealthCheck `json:"checks"`
}

// ConnectionHealthRunStatus 描述批量健康检查任务的生命周期。取消请求不会丢弃
// 已完成的报告。
type ConnectionHealthRunStatus string

const (
	ConnectionHealthRunStatusRunning    ConnectionHealthRunStatus = "running"
	ConnectionHealthRunStatusCancelling ConnectionHealthRunStatus = "cancelling"
	ConnectionHealthRunStatusCompleted  ConnectionHealthRunStatus = "completed"
	ConnectionHealthRunStatusCancelled  ConnectionHealthRunStatus = "cancelled"
	ConnectionHealthRunStatusRejected   ConnectionHealthRunStatus = "rejected"
)

// ConnectionHealthRun 是异步批量健康检查的安全传输快照。
// RemainingConnectionIDs 会列出所有尚未产出完成报告的连接，其中包含取消请求后
// 可能仍在结束的当前探测。
type ConnectionHealthRun struct {
	RunID                  string                    `json:"runId"`
	Status                 ConnectionHealthRunStatus `json:"status"`
	Total                  int                       `json:"total"`
	Completed              int                       `json:"completed"`
	Reports                []ConnectionHealthReport  `json:"reports"`
	CurrentConnectionID    string                    `json:"currentConnectionId,omitempty"`
	RemainingConnectionIDs []string                  `json:"remainingConnectionIds"`
	CancelRequested        bool                      `json:"cancelRequested"`
}
