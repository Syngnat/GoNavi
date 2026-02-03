package sync

const (
	EventSyncStart    = "sync:start"
	EventSyncProgress = "sync:progress"
	EventSyncLog      = "sync:log"
	EventSyncDone     = "sync:done"
)

type SyncLogEvent struct {
	JobID   string `json:"jobId"`
	Level   string `json:"level"` // info/warn/error
	Message string `json:"message"`
	Ts      int64  `json:"ts"` // Unix milli
}

type SyncProgressEvent struct {
	JobID   string `json:"jobId"`
	Percent int    `json:"percent"`
	Current int    `json:"current"` // 已完成表数
	Total   int    `json:"total"`   // 总表数
	Table   string `json:"table,omitempty"`
	Stage   string `json:"stage,omitempty"`
}

type Reporter struct {
	OnLog      func(event SyncLogEvent)
	OnProgress func(event SyncProgressEvent)
}

