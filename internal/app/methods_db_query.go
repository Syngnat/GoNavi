package app

import (
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

func (a *App) DBQuery(config connection.ConnectionConfig, dbName string, query string) connection.QueryResult {
	return a.dbQueryWithCancel(config, dbName, query, "", dbQueryAuditOptions{
		auditAll:    a.webRuntime,
		auditWrites: true,
		source:      "application_api",
	})
}

// DBQueryApplicationWithCancel exposes DBQuery's cancellation support without
// classifying an application-owned read as query-editor execution history.
func (a *App) DBQueryApplicationWithCancel(config connection.ConnectionConfig, dbName string, query string, queryID string) connection.QueryResult {
	return a.dbQueryWithCancel(config, dbName, query, queryID, dbQueryAuditOptions{
		auditAll:    a.webRuntime,
		auditWrites: true,
		source:      "application_api",
	})
}

func (a *App) DBQueryWithCancel(config connection.ConnectionConfig, dbName string, query string, queryID string) connection.QueryResult {
	explicitQuery := strings.TrimSpace(queryID) != ""
	auditSource := "query_editor"
	if !explicitQuery {
		auditSource = "application_api"
	}
	return a.dbQueryWithCancel(config, dbName, query, queryID, dbQueryAuditOptions{
		trackHistory: explicitQuery,
		auditAll:     explicitQuery || a.webRuntime,
		auditWrites:  true,
		source:       auditSource,
	})
}

func (a *App) dbQueryWithCancel(
	config connection.ConnectionConfig,
	dbName string,
	query string,
	queryID string,
	auditOptions dbQueryAuditOptions,
) (result connection.QueryResult) {
	runConfig := normalizeRunConfig(config, dbName)
	if queryID == "" {
		queryID = requestTraceIDFromContext(auditOptions.executionContext)
	}
	if queryID == "" {
		queryID = generateQueryID()
	}
	traceContext, requestTrace, ownsRequestTrace := a.beginQueryRequestTrace(
		auditOptions.executionContext,
		runConfig,
		queryID,
		auditOptions.source,
		"database.query",
	)
	auditOptions.executionContext = traceContext
	defer func() {
		a.recordQueryRequestTraceOutcome(requestTrace, result, ownsRequestTrace)
	}()
	requestTrace.AddEvent("query.accepted", nil)

	trackQueryHistory := auditOptions.trackHistory
	auditStartedAt := time.Now()
	var queryExecutionDuration time.Duration
	defer func() {
		result.DurationMs = durationMilliseconds(queryExecutionDuration)
	}()
	query = sanitizeSQLForPgLike(resolveDDLDBType(config), query)
	trackSQLAudit := auditOptions.auditAll || (auditOptions.auditWrites && containsSQLAuditWrite(resolveDDLDBType(runConfig), query))
	if trackSQLAudit {
		defer func() {
			a.recordSQLAuditQuery(sqlAuditQueryInput{
				Config:     runConfig,
				Database:   dbName,
				DBType:     resolveDDLDBType(runConfig),
				QueryID:    queryID,
				SQL:        query,
				Source:     normalizeSQLAuditSource(auditOptions.source),
				CommitMode: "auto",
				Duration:   time.Since(auditStartedAt),
				Result:     result,
			})
		}()
	}
	if trackQueryHistory {
		defer func() {
			if !result.Success {
				return
			}
			durationMs := queryExecutionDuration.Milliseconds()
			a.recordQueryExecution(config, dbName, resolveDDLDBType(runConfig), query, durationMs, 0, queryResultRowsReturned(result))
		}()
	}

	if err := a.ensureDataSourceQueryCapability(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error(), QueryID: queryID}
	}
	if err := ensureConnectionAllowsQuery(config, query); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error(), QueryID: queryID}
	}

	ctx, cancel := newQueryExecutionContextWithParent(auditOptions.executionContext, runConfig)
	if deadline, ok := ctx.Deadline(); ok {
		requestTrace.SetRequestMetadata("", "", deadline)
	}
	requestTrace.AddEvent("driver.dispatched", nil)
	cleanupRunningQuery, setRunningQueryCancellable := a.registerRunningQueryWithCancellationCapability(
		queryID,
		cancel,
		true,
		optionalDriverTypeForConnectionConfig(runConfig),
	)
	lifecycle := a.beginQueryExecutionLifecycleWithConnection(queryID)
	defer func() {
		lifecycle.complete(result)
		cancel()
		cleanupRunningQuery()
	}()

	var dbInst db.Database
	var err error
	if auditOptions.synchronousConnectionWait {
		dbInst, err = a.getDatabaseSynchronouslyWithContext(ctx, runConfig, false)
	} else {
		dbInst, err = a.getDatabaseWithContext(ctx, runConfig, false)
	}
	if err != nil {
		logger.Error(err, "DBQuery 获取连接失败：%s", formatConnSummary(runConfig))
		return buildQueryConnectionFailure(err, queryID, auditOptions.classifyConnectionErrors)
	}
	lifecycle.markExecuting()

	isReadQuery := isReadOnlySQLQuery(runConfig.Type, query)
	tryQueryFirst := shouldTryQueryResultFirst(runConfig.Type, query)
	legacyCancellationUnsupported := false

	runReadQuery := func(inst db.Database) ([]map[string]interface{}, []string, error) {
		startedAt := time.Now()
		defer func() { queryExecutionDuration += time.Since(startedAt) }()
		if q, ok := inst.(db.QueryContexter); ok {
			setRunningQueryCancellable(true)
			return q.QueryContext(ctx, query)
		}
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		setRunningQueryCancellable(false)
		if err := ctx.Err(); err != nil {
			setRunningQueryCancellable(true)
			return nil, nil, err
		}
		data, columns, err := inst.Query(query)
		legacyCancellationUnsupported = ctx.Err() != nil
		return data, columns, err
	}

	runReadQueryWithMessages := func(inst db.Database) ([]map[string]interface{}, []string, []string, error) {
		if q, ok := inst.(db.QueryMessageExecer); ok {
			setRunningQueryCancellable(true)
			startedAt := time.Now()
			data, columns, messages, err := q.QueryContextWithMessages(ctx, query)
			queryExecutionDuration += time.Since(startedAt)
			return data, columns, messages, err
		}
		data, columns, err := runReadQuery(inst)
		return data, columns, nil, err
	}

	runExecQuery := func(inst db.Database) (int64, error) {
		startedAt := time.Now()
		defer func() { queryExecutionDuration += time.Since(startedAt) }()
		if e, ok := inst.(db.ExecContexter); ok {
			setRunningQueryCancellable(true)
			return e.ExecContext(ctx, query)
		}
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		setRunningQueryCancellable(false)
		if err := ctx.Err(); err != nil {
			setRunningQueryCancellable(true)
			return 0, err
		}
		affected, err := inst.Exec(query)
		legacyCancellationUnsupported = ctx.Err() != nil
		return affected, err
	}

	if isReadQuery || tryQueryFirst {
		data, columns, messages, err := runReadQueryWithMessages(dbInst)
		if legacyCancellationUnsupported {
			return a.buildCancellationUnsupportedExecutionResult(connection.QueryResult{
				Data: data, Fields: columns, Messages: messages, QueryID: queryID,
			}, err)
		}
		if err != nil && isReadQuery && shouldRefreshCachedConnection(err) {
			if a.invalidateCachedDatabase(runConfig, err) {
				requestTrace.MarkRetry("cached connection refresh")
				setRunningQueryCancellable(true)
				var retryInst db.Database
				var retryErr error
				if auditOptions.synchronousConnectionWait {
					retryInst, retryErr = a.getDatabaseSynchronouslyWithContext(ctx, runConfig, true)
				} else {
					retryInst, retryErr = a.getDatabaseWithContext(ctx, runConfig, true)
				}
				if retryErr != nil {
					logger.Error(retryErr, "DBQuery 重建连接失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
					return buildQueryConnectionFailure(retryErr, queryID, auditOptions.classifyConnectionErrors)
				}
				data, columns, messages, err = runReadQueryWithMessages(retryInst)
				if legacyCancellationUnsupported {
					return a.buildCancellationUnsupportedExecutionResult(connection.QueryResult{
						Data: data, Fields: columns, Messages: messages, QueryID: queryID,
					}, err)
				}
			}
		}
		if err == nil {
			return connection.QueryResult{Success: true, Data: data, Fields: columns, Messages: messages, QueryID: queryID}
		}
		if isReadQuery {
			logger.Error(err, "DBQuery 查询失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
			return buildQueryExecutionFailure(ctx, err, err.Error(), queryID)
		}
		if shouldRefreshCachedConnection(err) {
			a.invalidateCachedDatabase(runConfig, err)
		}
		err = classifyDispatchedWriteError(err)
		logger.Error(err, "DBQuery 写入查询失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
		return buildWriteExecutionFailure(ctx, err, queryID)
	}

	affected, err := runExecQuery(dbInst)
	if legacyCancellationUnsupported {
		return a.buildCancellationUnsupportedExecutionResult(connection.QueryResult{
			Data: map[string]int64{"affectedRows": affected}, QueryID: queryID,
		}, err)
	}
	if err != nil {
		if shouldRefreshCachedConnection(err) {
			a.invalidateCachedDatabase(runConfig, err)
		}
		err = classifyDispatchedWriteError(err)
		logger.Error(err, "DBQuery 执行失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
		return buildWriteExecutionFailure(ctx, err, queryID)
	}
	return connection.QueryResult{Success: true, Data: map[string]int64{"affectedRows": affected}, QueryID: queryID}
}
