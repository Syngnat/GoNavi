package app

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/sqlaudit"
)

func (a *App) recordSQLAuditQuery(input sqlAuditQueryInput) {
	status := sqlAuditStatusFromResult(input.Result)
	statementCount := input.StatementCount
	if statementCount <= 0 {
		statementCount = countSQLAuditStatements(input.DBType, input.SQL)
	}
	event := sqlaudit.Event{
		EventType:             "query",
		Status:                status,
		ConnectionID:          strings.TrimSpace(input.Config.ID),
		ConnectionFingerprint: buildSQLAuditConnectionFingerprint(input.Config, input.Database),
		DBType:                strings.ToLower(strings.TrimSpace(input.DBType)),
		Database:              resolveSQLAuditDatabase(input.Config, input.Database),
		QueryID:               strings.TrimSpace(input.QueryID),
		Source:                normalizeSQLAuditSource(input.Source),
		CommitMode:            normalizeSQLAuditCommitMode(input.CommitMode),
		BoundaryMode:          normalizeSQLAuditBoundaryMode(input.Result.BoundaryMode),
		SQLText:               input.SQL,
		StatementCount:        statementCount,
		ExecutedCount:         input.Result.ExecutedCount,
		FailedIndex:           input.Result.FailedIndex,
		OutcomeUnknown:        input.Result.OutcomeUnknown,
		DurationMs:            durationMilliseconds(input.Duration),
		RowsAffected:          sqlAuditRowsAffected(input.Result),
		RowsReturned:          queryResultRowsReturned(input.Result),
	}
	if status != "success" {
		event.Error = strings.TrimSpace(input.Result.Message)
	}
	a.appendSQLAuditEvent(event)
}

func (a *App) sqlAuditTransactionStatementObserver(
	config connection.ConnectionConfig,
	database string,
	dbType string,
	queryID string,
	transactionID string,
	boundaryMode string,
	events *[]sqlaudit.Event,
) managedSQLStatementObserver {
	return func(observation managedSQLStatementObservation) {
		input := sqlAuditTransactionEventInput{
			Config:         config,
			Database:       database,
			DBType:         dbType,
			QueryID:        queryID,
			TransactionID:  transactionID,
			EventType:      "transaction_statement",
			Status:         sqlAuditStatusFromError(observation.Err),
			Source:         "query_editor",
			CommitMode:     "pending",
			BoundaryMode:   boundaryMode,
			SQL:            observation.Statement,
			StatementIndex: observation.StatementIndex,
			StatementCount: observation.StatementCount,
			Duration:       observation.Duration,
			RowsAffected:   observation.RowsAffected,
			RowsReturned:   observation.RowsReturned,
			Err:            observation.Err,
		}
		event := buildSQLAuditTransactionEvent(input)
		if events == nil {
			a.appendSQLAuditEvent(event)
			return
		}
		*events = append(*events, event)
	}
}

func (a *App) recordSQLAuditTransactionEvent(input sqlAuditTransactionEventInput) {
	a.appendSQLAuditEvent(buildSQLAuditTransactionEvent(input))
}

func buildSQLAuditTransactionEvent(input sqlAuditTransactionEventInput) sqlaudit.Event {
	event := sqlaudit.Event{
		EventType:             strings.TrimSpace(input.EventType),
		Status:                normalizeSQLAuditStatus(input.Status),
		ConnectionID:          strings.TrimSpace(input.Config.ID),
		ConnectionFingerprint: buildSQLAuditConnectionFingerprint(input.Config, input.Database),
		DBType:                strings.ToLower(strings.TrimSpace(input.DBType)),
		Database:              resolveSQLAuditDatabase(input.Config, input.Database),
		QueryID:               strings.TrimSpace(input.QueryID),
		TransactionID:         strings.TrimSpace(input.TransactionID),
		Source:                normalizeSQLAuditSource(input.Source),
		CommitMode:            normalizeSQLAuditCommitMode(input.CommitMode),
		BoundaryMode:          normalizeSQLAuditBoundaryMode(input.BoundaryMode),
		SQLText:               input.SQL,
		StatementIndex:        input.StatementIndex,
		StatementCount:        input.StatementCount,
		ExecutedCount:         input.ExecutedCount,
		FailedIndex:           input.FailedIndex,
		OutcomeUnknown:        input.OutcomeUnknown,
		DurationMs:            durationMilliseconds(input.Duration),
		RowsAffected:          input.RowsAffected,
		RowsReturned:          input.RowsReturned,
	}
	if input.Err != nil {
		event.Error = input.Err.Error()
	}
	return event
}

func (a *App) appendSQLAuditEvent(event sqlaudit.Event) {
	a.appendSQLAuditEvents([]sqlaudit.Event{event})
}

func (a *App) appendSQLAuditEvents(events []sqlaudit.Event) {
	if len(events) == 0 {
		return
	}
	a.sqlAuditAppendMu.Lock()
	defer a.sqlAuditAppendMu.Unlock()

	health := a.sqlAuditHealthSnapshot()
	wasDegraded := health.Status == sqlAuditHealthStatusDegraded
	var gapEvent *sqlaudit.Event
	if wasDegraded {
		gap := buildSQLAuditGapEvent(health)
		gapEvent = &gap
	}

	auditDisabled := false
	gapWriteFailed := false
	err := a.withSQLAuditStore(true, func(store *sqlaudit.Store) error {
		if wasDegraded {
			settings, settingsErr := store.GetSettings()
			if settingsErr != nil {
				return settingsErr
			}
			if !settings.Enabled {
				auditDisabled = true
				return nil
			}
		}
		if appendErr := store.AppendBatch(events); appendErr != nil {
			return appendErr
		}
		if gapEvent != nil {
			// Keep the gap marker as the newest record. AppendBatch intentionally
			// retains only the configured tail, so prepending the marker to a large
			// transaction batch could otherwise evict it and falsely report recovery.
			if appendErr := store.Append(*gapEvent); appendErr != nil {
				gapWriteFailed = true
				return appendErr
			}
		}
		return nil
	})
	if err != nil {
		first := events[0]
		logger.Warnf(
			"写入 SQL 审计失败（已按 fail-open 保留数据库操作结果）：count=%d event=%s tx=%s query=%s err=%v",
			len(events),
			first.EventType,
			first.TransactionID,
			first.QueryID,
			err,
		)
		dropped := int64(len(events))
		if gapWriteFailed {
			// The current events were durable; only the marker failed. Preserve the
			// existing unresolved gap count without counting these events as lost.
			dropped = 0
		}
		a.markSQLAuditFailure(dropped, err)
		return
	}
	if auditDisabled {
		return
	}
	a.markSQLAuditSuccess(wasDegraded)
}

func buildSQLAuditGapEvent(health sqlAuditHealthState) sqlaudit.Event {
	message := "SQL audit storage recovered after a writer failure; no dropped-event count was available"
	if health.DroppedEvents > 0 {
		message = fmt.Sprintf(
			"SQL audit storage recovered after a persistence gap; %d event(s) were not persisted",
			health.DroppedEvents,
		)
	}
	return sqlaudit.Event{
		Timestamp: time.Now().UnixMilli(),
		EventType: "audit_gap",
		Status:    "error",
		Source:    "system",
		Error:     message,
	}
}

func (a *App) markSQLAuditFailure(dropped int64, auditErr error) {
	now := time.Now().UnixMilli()
	a.sqlAuditHealthMu.Lock()
	state := normalizeSQLAuditHealth(a.sqlAuditHealth)
	if state.Status != sqlAuditHealthStatusDegraded {
		state.Status = sqlAuditHealthStatusDegraded
		state.DroppedEvents = 0
		state.FirstFailureAt = now
	}
	if dropped > 0 {
		state.DroppedEvents += dropped
	}
	state.LastFailureAt = now
	if auditErr != nil {
		state.LastError = sqlaudit.RedactError(auditErr.Error())
	}
	if errors.Is(auditErr, errSQLAuditTemporarilyUnavailable) && dropped > 0 {
		// appendSQLAuditEvents and lifecycle transitions share sqlAuditAppendMu,
		// so these fields are a linear count of only the events lost while the
		// audit store was suspended for a data-root switch.
		if a.sqlAuditSuspensionDropped == 0 {
			a.sqlAuditSuspensionFirstAt = now
		}
		a.sqlAuditSuspensionDropped += dropped
		a.sqlAuditSuspensionLastAt = now
		a.sqlAuditSuspensionLastError = state.LastError
	}
	path := a.sqlAuditHealthPath
	if strings.TrimSpace(path) == "" {
		path = filepath.Clean(a.sqlAuditHealthFilePath())
	}
	a.sqlAuditHealth = state
	a.sqlAuditHealthPath = path
	a.sqlAuditHealthRevision++
	if !errors.Is(auditErr, errSQLAuditTemporarilyUnavailable) {
		a.persistSQLAuditHealth(state, path)
	}
	a.sqlAuditHealthMu.Unlock()
}

func (a *App) markSQLAuditSuccess(recovered bool) {
	now := time.Now().UnixMilli()
	a.sqlAuditHealthMu.Lock()
	state := normalizeSQLAuditHealth(a.sqlAuditHealth)
	state.LastSuccessAt = now
	if recovered {
		state.Status = sqlAuditHealthStatusHealthy
		state.LastError = ""
	}
	path := a.sqlAuditHealthPath
	if strings.TrimSpace(path) == "" {
		path = filepath.Clean(a.sqlAuditHealthFilePath())
		a.sqlAuditHealthPath = path
	}
	a.sqlAuditHealth = state
	if recovered {
		a.sqlAuditHealthRevision++
	}
	if recovered {
		a.persistSQLAuditHealth(state, path)
	}
	a.sqlAuditHealthMu.Unlock()
}
