package app

import (
	"context"
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
	DurationMs        int64  `json:"durationMs,omitempty"`
	HasDurationMs     bool   `json:"hasDurationMs,omitempty"`
	Cancellable       bool   `json:"cancellable"`
	AffectedRows      int64  `json:"affectedRows,omitempty"`
	HasAffectedRows   bool   `json:"hasAffectedRows,omitempty"`
	Message           string `json:"message,omitempty"`
	OutcomeUnknown    bool   `json:"outcomeUnknown,omitempty"`
	CancellationState string `json:"cancellationState,omitempty"`
}

type queryExecutionLifecycle struct {
	app *App
	// ctx 是产生本次查询的请求上下文。Web 模式下它可能带会话级 emitter，
	// 让进度事件只回发给发起查询的会话；桌面/后台调用为 nil 时走全局 emitter。
	ctx       context.Context
	queryID   string
	started   time.Time
	stopCh    chan struct{}
	stopOnce  sync.Once
	completed atomic.Bool
	// mu 仅保护以下纯 SQL 计时状态，调用 emit 或锁外方法前必须先释放。
	mu              sync.Mutex
	connecting      bool
	hasExecuted     bool
	execStartedAt   time.Time
	accumulatedExec time.Duration
}

func (a *App) beginQueryExecutionLifecycle(queryID string) *queryExecutionLifecycle {
	return a.newQueryExecutionLifecycle(nil, queryID, false)
}

// beginQueryExecutionLifecycleWithConnection 用于执行前还需要获取连接的入口，
// 拿到连接后必须调用 markExecuting，否则心跳会一直停在 starting 阶段。
func (a *App) beginQueryExecutionLifecycleWithConnection(queryID string) *queryExecutionLifecycle {
	return a.newQueryExecutionLifecycle(nil, queryID, true)
}

// beginQueryExecutionLifecycleWithConnectionAndContext 为 Web 请求保留会话上下文。
func (a *App) beginQueryExecutionLifecycleWithConnectionAndContext(ctx context.Context, queryID string) *queryExecutionLifecycle {
	return a.newQueryExecutionLifecycle(ctx, queryID, true)
}

func (a *App) newQueryExecutionLifecycle(ctx context.Context, queryID string, connecting bool) *queryExecutionLifecycle {
	queryID = strings.TrimSpace(queryID)
	now := time.Now()
	lifecycle := &queryExecutionLifecycle{
		app:        a,
		ctx:        ctx,
		queryID:    queryID,
		started:    now,
		stopCh:     make(chan struct{}),
		connecting: connecting,
	}
	if !connecting {
		lifecycle.hasExecuted = true
		lifecycle.execStartedAt = now
	}
	if queryID == "" || a == nil {
		return lifecycle
	}
	lifecycle.emit(queryExecutionStatusRunning, queryExecutionStageStarting, connection.QueryResult{}, 0, false)
	go lifecycle.heartbeatLoop(queryExecutionHeartbeatInterval)
	return lifecycle
}

// markExecuting 标记连接已就绪、SQL 即将交给驱动执行，并立即通知前端开始/恢复 SQL 计时。
func (l *queryExecutionLifecycle) markExecuting() {
	if l == nil || l.completed.Load() {
		return
	}
	l.mu.Lock()
	if !l.connecting {
		l.mu.Unlock()
		return
	}
	l.connecting = false
	l.hasExecuted = true
	l.execStartedAt = time.Now()
	elapsed := l.accumulatedExec
	l.mu.Unlock()
	l.emit(queryExecutionStatusRunning, queryExecutionStageExecuting, connection.QueryResult{}, elapsed, false)
}

// markConnecting 标记重建连接等重连等待期间暂停 SQL 计时，保留此前已累加的 SQL 耗时。
func (l *queryExecutionLifecycle) markConnecting() {
	if l == nil || l.completed.Load() {
		return
	}
	l.mu.Lock()
	if l.connecting {
		l.mu.Unlock()
		return
	}
	if !l.execStartedAt.IsZero() {
		l.accumulatedExec += time.Since(l.execStartedAt)
		l.execStartedAt = time.Time{}
	}
	l.connecting = true
	elapsed := l.accumulatedExec
	l.mu.Unlock()
	l.emit(queryExecutionStatusRunning, queryExecutionStageStarting, connection.QueryResult{}, elapsed, false)
}

func (l *queryExecutionLifecycle) currentExecutionState() (string, time.Duration) {
	if l == nil {
		return queryExecutionStageExecuting, 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	elapsed := l.accumulatedExec
	if l.connecting {
		return queryExecutionStageStarting, elapsed
	}
	if !l.execStartedAt.IsZero() {
		elapsed += time.Since(l.execStartedAt)
	}
	return queryExecutionStageExecuting, elapsed
}

func (l *queryExecutionLifecycle) complete(result connection.QueryResult) {
	if l == nil {
		return
	}
	if result.DurationMs > 0 {
		l.finish(result, time.Duration(result.DurationMs)*time.Millisecond, true)
		return
	}
	l.mu.Lock()
	elapsed := l.accumulatedExec
	if !l.connecting && !l.execStartedAt.IsZero() {
		elapsed += time.Since(l.execStartedAt)
	}
	hasExecuted := l.hasExecuted
	l.mu.Unlock()
	l.finish(result, elapsed, elapsed > 0 || hasExecuted)
}

// completeWithDuration 在结果编码与 IPC 回传前立即上报纯 SQL 执行耗时，供前端定格计时。
func (l *queryExecutionLifecycle) completeWithDuration(result connection.QueryResult, sqlDuration time.Duration) {
	if l == nil {
		return
	}
	l.mu.Lock()
	hasExecuted := l.hasExecuted
	l.mu.Unlock()
	hasDuration := sqlDuration > 0 || hasExecuted
	l.finish(result, sqlDuration, hasDuration)
}

func (l *queryExecutionLifecycle) finish(result connection.QueryResult, sqlDuration time.Duration, hasDuration bool) {
	if l == nil {
		return
	}
	l.stopOnce.Do(func() {
		l.completed.Store(true)
		close(l.stopCh)
		status, stage := queryExecutionTerminalStatus(result)
		l.emit(status, stage, result, sqlDuration, hasDuration)
	})
}

func (l *queryExecutionLifecycle) heartbeatLoop(interval time.Duration) {
	if l == nil || l.queryID == "" {
		return
	}
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
			stage, elapsed := l.currentExecutionState()
			l.emit(queryExecutionStatusRunning, stage, connection.QueryResult{}, elapsed, false)
		}
	}
}

func (l *queryExecutionLifecycle) emit(status string, stage string, result connection.QueryResult, sqlDuration time.Duration, hasDuration bool) {
	if l == nil || l.app == nil || l.queryID == "" {
		return
	}
	if status == queryExecutionStatusRunning && l.completed.Load() {
		return
	}
	if sqlDuration < 0 {
		sqlDuration = 0
	}
	elapsedMs := sqlDuration.Milliseconds()
	if hasDuration {
		elapsedMs = durationMilliseconds(sqlDuration)
	}
	event := queryExecutionProgressEvent{
		QueryID:           l.queryID,
		Status:            status,
		Stage:             stage,
		ElapsedMs:         elapsedMs,
		Cancellable:       l.app.queryExecutionCancellable(l.queryID),
		Message:           strings.TrimSpace(result.Message),
		OutcomeUnknown:    queryExecutionOutcomeUnknown(result),
		CancellationState: strings.TrimSpace(result.CancellationState),
	}
	if hasDuration {
		event.DurationMs = elapsedMs
		event.HasDurationMs = true
	}
	if affected, ok := queryExecutionAffectedRows(result); ok {
		event.AffectedRows = affected
		event.HasAffectedRows = true
	}
	l.app.emitQueryExecutionProgressWithContext(l.ctx, event)
}

func (a *App) emitQueryExecutionProgress(event queryExecutionProgressEvent) {
	a.emitQueryExecutionProgressWithContext(nil, event)
}

func (a *App) emitQueryExecutionProgressWithContext(ctx context.Context, event queryExecutionProgressEvent) {
	if a == nil || strings.TrimSpace(event.QueryID) == "" {
		return
	}
	uievents.EmitWith(ctx, a.ctx, queryProgressEventName, event)
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
