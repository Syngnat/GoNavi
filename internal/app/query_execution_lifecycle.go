package app

import (
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/uievents"
)

const queryProgressEventName = "query:progress"

const (
	queryExecutionStatusRunning    = "running"
	queryExecutionStatusCancelling = "cancelling"
	queryExecutionStatusDone       = "done"
	queryExecutionStatusCancelled  = "cancelled"
	queryExecutionStatusError      = "error"
)

const (
	queryExecutionStageStarting   = "starting"
	queryExecutionStageExecuting  = "executing"
	queryExecutionStageCancelling = "cancelling"
	queryExecutionStageCompleted  = "completed"
	queryExecutionStageCancelled  = "cancelled"
	queryExecutionStageFailed     = "failed"
)

// queryExecutionHeartbeatInterval is the cadence for "still running" events so
// the editor can distinguish a live DELETE from a frozen UI. Tests may shorten it.
var queryExecutionHeartbeatInterval = time.Second

type queryExecutionProgressEvent struct {
	QueryID           string `json:"queryId"`
	Status            string `json:"status"`
	Stage             string `json:"stage"`
	ElapsedMs         int64  `json:"elapsedMs"`
	Cancellable       bool   `json:"cancellable"`
	AffectedRows      int64  `json:"affectedRows,omitempty"`
	HasAffectedRows   bool   `json:"hasAffectedRows,omitempty"`
	Message           string `json:"message,omitempty"`
	OutcomeUnknown    bool   `json:"outcomeUnknown,omitempty"`
	CancellationState string `json:"cancellationState,omitempty"`
}

type queryExecutionLifecycle struct {
	app       *App
	queryID   string
	started   time.Time
	stopCh    chan struct{}
	stopOnce  sync.Once
	completed atomic.Bool
	// connecting 为 true 期间心跳仍上报 starting 阶段：前端据此暂停计时，
	// 避免把建连/隧道等待算进 SQL 执行耗时（driver 侧 DurationMs 不含建连）。
	connecting atomic.Bool
}

func (a *App) beginQueryExecutionLifecycle(queryID string) *queryExecutionLifecycle {
	return a.newQueryExecutionLifecycle(queryID, false)
}

// beginQueryExecutionLifecycleWithConnection 用于执行前还需要获取连接的入口，
// 拿到连接后必须调用 markExecuting，否则心跳会一直停在 starting 阶段。
func (a *App) beginQueryExecutionLifecycleWithConnection(queryID string) *queryExecutionLifecycle {
	return a.newQueryExecutionLifecycle(queryID, true)
}

func (a *App) newQueryExecutionLifecycle(queryID string, connecting bool) *queryExecutionLifecycle {
	queryID = strings.TrimSpace(queryID)
	lifecycle := &queryExecutionLifecycle{
		app:     a,
		queryID: queryID,
		started: time.Now(),
		stopCh:  make(chan struct{}),
	}
	lifecycle.connecting.Store(connecting)
	if queryID == "" || a == nil {
		return lifecycle
	}
	lifecycle.emit(queryExecutionStatusRunning, queryExecutionStageStarting, connection.QueryResult{})
	go lifecycle.heartbeatLoop()
	return lifecycle
}

// markExecuting 标记连接已就绪、SQL 即将交给驱动执行，并立即通知前端开始计时。
func (l *queryExecutionLifecycle) markExecuting() {
	if l == nil || !l.connecting.CompareAndSwap(true, false) {
		return
	}
	l.emit(queryExecutionStatusRunning, queryExecutionStageExecuting, connection.QueryResult{})
}

func (l *queryExecutionLifecycle) complete(result connection.QueryResult) {
	if l == nil {
		return
	}
	l.stopOnce.Do(func() {
		l.completed.Store(true)
		close(l.stopCh)
		status, stage := queryExecutionTerminalStatus(result)
		l.emit(status, stage, result)
	})
}

func (l *queryExecutionLifecycle) heartbeatLoop() {
	if l == nil || l.queryID == "" {
		return
	}
	interval := queryExecutionHeartbeatInterval
	if interval <= 0 {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-l.stopCh:
			return
		case <-ticker.C:
			if l.completed.Load() {
				return
			}
			stage := queryExecutionStageExecuting
			if l.connecting.Load() {
				stage = queryExecutionStageStarting
			}
			l.emit(queryExecutionStatusRunning, stage, connection.QueryResult{})
		}
	}
}

func (l *queryExecutionLifecycle) emit(status string, stage string, result connection.QueryResult) {
	if l == nil || l.app == nil || l.queryID == "" {
		return
	}
	if status == queryExecutionStatusRunning && l.completed.Load() {
		return
	}
	event := queryExecutionProgressEvent{
		QueryID:           l.queryID,
		Status:            status,
		Stage:             stage,
		ElapsedMs:         time.Since(l.started).Milliseconds(),
		Cancellable:       l.app.queryExecutionCancellable(l.queryID),
		Message:           strings.TrimSpace(result.Message),
		OutcomeUnknown:    queryExecutionOutcomeUnknown(result),
		CancellationState: strings.TrimSpace(result.CancellationState),
	}
	if affected, ok := queryExecutionAffectedRows(result); ok {
		event.AffectedRows = affected
		event.HasAffectedRows = true
	}
	l.app.emitQueryExecutionProgress(event)
}

func (a *App) emitQueryExecutionProgress(event queryExecutionProgressEvent) {
	if a == nil || strings.TrimSpace(event.QueryID) == "" {
		return
	}
	uievents.Emit(a.ctx, queryProgressEventName, event)
}

func (a *App) emitQueryExecutionCancelling(queryID string) {
	queryID = strings.TrimSpace(queryID)
	if a == nil || queryID == "" {
		return
	}
	a.emitQueryExecutionProgress(queryExecutionProgressEvent{
		QueryID:     queryID,
		Status:      queryExecutionStatusCancelling,
		Stage:       queryExecutionStageCancelling,
		Cancellable: false,
	})
}

func (a *App) queryExecutionCancellable(queryID string) bool {
	if a == nil || strings.TrimSpace(queryID) == "" {
		return false
	}
	a.queryMu.RLock()
	current, exists := a.runningQueries[queryID]
	a.queryMu.RUnlock()
	return exists && !current.cancellationUnsupported
}

func queryExecutionTerminalStatus(result connection.QueryResult) (status string, stage string) {
	if result.Success {
		return queryExecutionStatusDone, queryExecutionStageCompleted
	}
	if result.CancellationState == connection.QueryCancellationStateUnsupported {
		return queryExecutionStatusError, queryExecutionStageFailed
	}
	if queryExecutionCancelled(result) {
		return queryExecutionStatusCancelled, queryExecutionStageCancelled
	}
	return queryExecutionStatusError, queryExecutionStageFailed
}

func queryExecutionCancelled(result connection.QueryResult) bool {
	if data, ok := result.Data.(map[string]any); ok {
		if cancelled, ok := data["cancelled"].(bool); ok && cancelled {
			return true
		}
	}
	message := strings.ToLower(strings.TrimSpace(result.Message))
	return strings.Contains(message, "context canceled") || strings.Contains(message, "context cancelled")
}

func queryExecutionOutcomeUnknown(result connection.QueryResult) bool {
	if result.OutcomeUnknown {
		return true
	}
	data, ok := result.Data.(map[string]any)
	if !ok {
		return false
	}
	unknown, _ := data["outcomeUnknown"].(bool)
	return unknown
}

func queryExecutionAffectedRows(result connection.QueryResult) (int64, bool) {
	switch data := result.Data.(type) {
	case map[string]int64:
		if affected, ok := data["affectedRows"]; ok {
			return affected, true
		}
	case map[string]any:
		if affected, ok := int64FromAny(data["affectedRows"]); ok {
			return affected, true
		}
	case []connection.ResultSetData:
		return affectedRowsFromResultSets(data)
	case []any:
		sets := make([]connection.ResultSetData, 0, len(data))
		for _, item := range data {
			set, ok := item.(connection.ResultSetData)
			if !ok {
				return 0, false
			}
			sets = append(sets, set)
		}
		return affectedRowsFromResultSets(sets)
	}
	return 0, false
}

func affectedRowsFromResultSets(sets []connection.ResultSetData) (int64, bool) {
	var total int64
	found := false
	for _, set := range sets {
		if !isAffectedRowsResultSet(set) {
			continue
		}
		affected, _ := summarizeManagedSQLResultSet(set)
		total += affected
		found = true
	}
	return total, found
}

func int64FromAny(value any) (int64, bool) {
	switch typed := value.(type) {
	case int:
		return int64(typed), true
	case int32:
		return int64(typed), true
	case int64:
		return typed, true
	case uint:
		return int64(typed), true
	case uint32:
		return int64(typed), true
	case uint64:
		if typed > uint64(^uint64(0)>>1) {
			return 0, false
		}
		return int64(typed), true
	case float64:
		return int64(typed), true
	default:
		return 0, false
	}
}
