package app

import (
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/sqlaudit"
)

// DBQueryMulti 执行可能包含多条 SQL 语句的查询，返回多个结果集。
// 如果底层驱动支持 MultiResultQuerier，一次性执行所有语句；
// 否则按分号拆分后逐条执行，模拟多结果集。
func (a *App) DBQueryMulti(config connection.ConnectionConfig, dbName string, query string, queryID string) connection.QueryResult {
	explicitQuery := strings.TrimSpace(queryID) != ""
	auditSource := "query_editor"
	if !explicitQuery {
		auditSource = "application_api"
	}
	return a.dbQueryMulti(config, dbName, query, queryID, dbQueryMultiAuditOptions{
		auditAll:    explicitQuery || a.webRuntime,
		auditWrites: true,
		source:      auditSource,
	})
}

func (a *App) dbQueryMulti(
	config connection.ConnectionConfig,
	dbName string,
	query string,
	queryID string,
	auditOptions dbQueryMultiAuditOptions,
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
		"database.query_multi",
	)
	auditOptions.executionContext = traceContext
	defer func() {
		a.recordQueryRequestTraceOutcome(requestTrace, result, ownsRequestTrace)
	}()
	requestTrace.AddEvent("query.accepted", nil)

	resolvedDBType := resolveDDLDBType(runConfig)
	trackSQLAudit := auditOptions.auditAll || (auditOptions.auditWrites && containsSQLAuditWrite(resolvedDBType, query))
	auditSource := normalizeSQLAuditSource(auditOptions.source)
	// 审计与历史记录使用用户原始提交文本；附加指令改写只影响实际下发引擎的语句
	originalQuery := query
	auditStartedAt := time.Now()
	var statementAuditEvents []sqlaudit.Event
	if trackSQLAudit {
		defer func() {
			a.recordSQLAuditQuery(sqlAuditQueryInput{
				Config:     runConfig,
				Database:   dbName,
				DBType:     resolvedDBType,
				QueryID:    queryID,
				SQL:        originalQuery,
				Source:     auditSource,
				CommitMode: result.CommitMode,
				Duration:   time.Since(auditStartedAt),
				Result:     result,
			})
		}()
		defer func() {
			a.appendSQLAuditEvents(statementAuditEvents)
		}()
	}
	// 慢 SQL 埋点：成功执行后记录（低于阈值 500ms 自动跳过）。
	// 用 named return + defer 覆盖所有 return path，避免遗漏。
	var queryExecutionDuration time.Duration
	queryExecuted := false
	defer func() {
		result.DurationMs = durationMilliseconds(queryExecutionDuration)
	}()
	defer func() {
		if !result.Success {
			return
		}
		durationMs := queryExecutionDuration.Milliseconds()
		a.recordQueryExecution(config, dbName, resolvedDBType, originalQuery, durationMs, 0, queryResultRowsReturned(result))
	}()
	measureQueryExecution := func(run func()) {
		startedAt := time.Now()
		queryExecuted = true
		run()
		queryExecutionDuration += time.Since(startedAt)
	}

	buildStatementExecutionFailedMessage := func(index int, err error, previousSuccessCount int) string {
		message := a.appText("db.backend.error.multi_statement_execution_failed", map[string]any{
			"index":  index,
			"detail": err.Error(),
		})
		if previousSuccessCount > 0 {
			message += a.appText("db.backend.error.multi_statement_previous_success", map[string]any{
				"count": previousSuccessCount,
			})
		}
		return message
	}
	buildSequentialFallbackMessage := func(statementCount int) string {
		return a.appText("db.backend.message.multi_statement_sequential_fallback", map[string]any{
			"dbType": runConfig.Type,
			"count":  statementCount,
		})
	}

	query = sanitizeSQLForPgLike(resolveDDLDBType(config), query)
	if err := a.ensureDataSourceQueryCapability(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error(), QueryID: queryID}
	}
	if err := ensureConnectionAllowsQuery(config, query); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error(), QueryID: queryID}
	}

	ctx, cancel := newQueryExecutionContextWithParent(auditOptions.executionContext, runConfig)
	// 行预算通过 context 下传到 db 层扫描函数：达到上限后扫描停止 rows.Next，
	// 由方言层既有的 rows.Close 释放 Rows 与连接，而不是物化后再截断。
	ctx, rowBudget := bindQueryResultBudget(ctx, auditOptions)
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
		logger.Error(err, "DBQueryMulti 获取连接失败：%s", formatConnSummary(runConfig))
		return buildQueryConnectionFailure(err, queryID, auditOptions.classifyConnectionErrors)
	}
	lifecycle.markExecuting()
	defer func() {
		// A successful SQL round trip is at least as strong a health signal as Ping.
		if result.Success && queryExecuted {
			a.markCachedDatabaseHealthy(dbInst, time.Now())
		}
	}()
	legacyCancellationUnsupported := false

	// DuckDB 保存连接附加指令（issue #1270）：在本层拦截执行并改写为合成 SELECT。
	// 密钥仅在 Go 侧解析，指令文本不进入 DuckDB 解析器；见 duckdb_saved_attach.go。
	if resolvedDBType == "duckdb" {
		rewrittenQuery, directiveErr := a.applyDuckDBSavedConnectionDirectives(ctx, dbInst, query)
		if directiveErr != nil {
			return connection.QueryResult{Success: false, Message: directiveErr.Error(), QueryID: queryID}
		}
		query = rewrittenQuery
	}

	// 尝试使用驱动原生多结果集支持。普通 database/sql 驱动仅在安全的
	// 读取场景使用该路径；Navicat ntunnel_mysql.php 则可用一个请求的
	// 多个 q[] 同时保留会话状态和每条写语句的 affectedRows。
	statements := splitSQLStatementsForDialect(resolvedDBType, query)
	// 指令改写保持语句一一对应：语句级审计记录用户原始文本（合成 SELECT
	// 只是执行载体，无审计价值）；数量不一致时放弃映射，回退记录改写文本。
	auditStatements := statements
	if query != originalQuery {
		if originals := splitSQLStatementsForDialect(resolvedDBType, originalQuery); len(originals) == len(statements) {
			auditStatements = originals
		}
	}
	statementCount := 0
	for _, statement := range statements {
		if strings.TrimSpace(statement) != "" {
			statementCount++
		}
	}
	auditSequentialStatements := trackSQLAudit && statementCount > 1
	appendStatementAudit := func(
		statement string,
		statementIndex int,
		startedAt time.Time,
		rowsAffected int64,
		rowsReturned int64,
		boundaryMode string,
		commitMode string,
		statementErr error,
	) {
		if !auditSequentialStatements {
			return
		}
		completedAt := time.Now()
		event := buildSQLAuditTransactionEvent(sqlAuditTransactionEventInput{
			Config:         runConfig,
			Database:       dbName,
			DBType:         resolvedDBType,
			QueryID:        queryID,
			EventType:      "query_statement",
			Status:         sqlAuditStatusFromError(statementErr),
			Source:         auditSource,
			CommitMode:     commitMode,
			BoundaryMode:   boundaryMode,
			SQL:            statement,
			StatementIndex: statementIndex,
			StatementCount: statementCount,
			ExecutedCount:  executedStatementCount(statementErr),
			FailedIndex:    failedStatementIndex(statementIndex, statementErr),
			OutcomeUnknown: writeExecutionOutcomeUnknown(ctx, statementErr),
			Duration:       completedAt.Sub(startedAt),
			RowsAffected:   rowsAffected,
			RowsReturned:   rowsReturned,
			Err:            statementErr,
		})
		event.Timestamp = completedAt.UnixMilli()
		statementAuditEvents = append(statementAuditEvents, event)
	}
	allReadOnly := true
	for _, stmt := range statements {
		if strings.TrimSpace(stmt) != "" && !isReadOnlySQLQuery(runConfig.Type, stmt) {
			allReadOnly = false
			break
		}
	}
	supportsStatementBatch := func(inst db.Database) bool {
		querier, ok := inst.(db.StatementBatchMultiResultQuerierContext)
		return ok && querier.SupportsStatementBatchMultiResult()
	}
	useNativeMultiResult := shouldUseNativeMultiResultBatch(resolvedDBType, statements, allReadOnly) || supportsStatementBatch(dbInst)

	runMultiQuery := func(inst db.Database) ([]connection.ResultSetData, []string, error) {
		if q, ok := inst.(db.StatementBatchMultiResultQuerierContext); ok && q.SupportsStatementBatchMultiResult() {
			setRunningQueryCancellable(true)
			var (
				results []connection.ResultSetData
				err     error
			)
			measureQueryExecution(func() {
				results, err = q.QueryStatementsMultiContext(ctx, statements)
			})
			return results, nil, err
		}
		if !useNativeMultiResult {
			return nil, nil, nil // 包含写操作，走逐条执行路径
		}
		var (
			results  []connection.ResultSetData
			messages []string
			err      error
		)
		if q, ok := inst.(db.MultiResultQueryMessageExecer); ok {
			setRunningQueryCancellable(true)
			measureQueryExecution(func() {
				results, messages, err = q.QueryMultiContextWithMessages(ctx, query)
			})
			return results, messages, err
		}
		if q, ok := inst.(db.MultiResultQuerierContext); ok {
			setRunningQueryCancellable(true)
			measureQueryExecution(func() {
				results, err = q.QueryMultiContext(ctx, query)
			})
			return results, nil, err
		}
		if q, ok := inst.(db.MultiResultQuerier); ok {
			if err := ctx.Err(); err != nil {
				return nil, nil, err
			}
			setRunningQueryCancellable(false)
			if err := ctx.Err(); err != nil {
				setRunningQueryCancellable(true)
				return nil, nil, err
			}
			measureQueryExecution(func() {
				results, err = q.QueryMulti(query)
			})
			legacyCancellationUnsupported = ctx.Err() != nil
			return results, nil, err
		}
		return nil, nil, nil // 返回 nil 表示不支持
	}

	results, resultMessages, err := runMultiQuery(dbInst)
	if legacyCancellationUnsupported {
		return a.buildCancellationUnsupportedExecutionResult(connection.QueryResult{
			Data: results, Messages: resultMessages, QueryID: queryID,
		}, err)
	}
	// A native multi-result call may have already returned one or more result
	// sets before the driver reports an error. Retrying that batch could replay
	// query-first writes, so only refresh a cached connection before any result
	// has been observed.
	if err != nil && allReadOnly && len(results) == 0 && shouldRefreshCachedConnection(err) {
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
				logger.Error(retryErr, "DBQueryMulti 重建连接失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
				return buildQueryConnectionFailure(retryErr, queryID, auditOptions.classifyConnectionErrors)
			}
			dbInst = retryInst
			results, resultMessages, err = runMultiQuery(retryInst)
			if legacyCancellationUnsupported {
				return a.buildCancellationUnsupportedExecutionResult(connection.QueryResult{
					Data: results, Messages: resultMessages, QueryID: queryID,
				}, err)
			}
		}
	}
	if err != nil {
		logger.Error(err, "DBQueryMulti 执行失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
		normalizeNativeResultStatementIndexes(runConfig.Type, statements, results)
		executedCount, exactPrefix := nativeResultExecutedStatementCount(statements, results)
		// A query-first write can have reached the server even when a native
		// result-stream error leaves no result set for the failing statement.
		outcomeUnknown := containsSQLAuditWrite(resolvedDBType, query)
		if exactPrefix {
			for index := 1; index <= executedCount; index++ {
				var rowsAffected, rowsReturned int64
				for _, resultSet := range results {
					if resultSet.StatementIndex != index {
						continue
					}
					affected, returned := summarizeManagedSQLResultSet(resultSet)
					rowsAffected += affected
					rowsReturned += returned
				}
				appendStatementAudit(auditStatements[index-1], index, auditStartedAt, rowsAffected, rowsReturned, sqlaudit.BoundaryModeDriverAPI, sqlaudit.CommitModeAuto, nil)
			}
		}
		failedIndex := 0
		if exactPrefix && executedCount < statementCount {
			failedIndex = executedCount + 1
			appendStatementAudit(auditStatements[failedIndex-1], failedIndex, auditStartedAt, 0, 0, sqlaudit.BoundaryModeDriverAPI, sqlaudit.CommitModeAuto, err)
			if outcomeUnknown && len(statementAuditEvents) > 0 {
				statementAuditEvents[len(statementAuditEvents)-1].OutcomeUnknown = true
			}
		}
		failure := buildQueryExecutionFailure(ctx, err, err.Error(), queryID)
		failure.Data = results
		failure.Messages = resultMessages
		failure.Partial = len(results) > 0
		// For query-first writes, a scanner/transport error after native results
		// cannot prove the outcome of the failing statement. Preserve the known
		// prefix and surface the remaining uncertainty to callers and the audit.
		return summarizeMultiStatementResult(failure, executedCount, failedIndex, sqlaudit.BoundaryModeDriverAPI, outcomeUnknown)
	}

	// 某些 optional driver-agent 的原生多结果集路径会异常返回“成功但无可展示列/行”。
	// 对只读查询这是不可信信号，回退到逐条执行可以避免普通 SELECT 在结果面板中被吃空。
	if useNativeMultiResult && nativeReadOnlyResultsMissingTabularPayload(allReadOnly, results) {
		logger.Warnf("DBQueryMulti 原生多结果集返回空结果，将回退逐条执行：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
		results = nil
	}
	if useNativeMultiResult && results != nil {
		normalizeNativeResultStatementIndexes(runConfig.Type, statements, results)
	}

	// 驱动支持多结果集，直接返回
	if results != nil {
		for index, statement := range statements {
			if strings.TrimSpace(statement) != "" {
				appendStatementAudit(auditStatements[index], index+1, auditStartedAt, 0, 0, sqlaudit.BoundaryModeDriverAPI, sqlaudit.CommitModeAuto, nil)
			}
		}
		applyRowBudgetTruncation(results, rowBudget)
		return summarizeMultiStatementResult(connection.QueryResult{Success: true, Data: results, Messages: resultMessages, QueryID: queryID}, statementCount, 0, sqlaudit.BoundaryModeDriverAPI, false)
	}

	// 驱动不支持多结果集，回退到逐条执行
	if len(statements) == 0 {
		return connection.QueryResult{
			Success: true,
			Data:    []connection.ResultSetData{},
			QueryID: queryID,
		}
	}

	var sessionQueryTarget db.StatementQueryExecer
	var sessionQueryMessageTarget db.StatementQueryMessageExecer
	var sessionMultiQueryTarget db.StatementMultiResultQueryExecer
	var sessionMultiQueryMessageTarget db.StatementMultiResultQueryMessageExecer
	var sessionExecTarget db.StatementExecer
	var sessionBatchTarget db.BatchWriteExecer
	closeExecTarget := func() {}
	if provider, ok := dbInst.(db.SessionExecerProvider); ok && runtimeSupportsSessionExecer(dbInst) {
		setRunningQueryCancellable(true)
		sessionExecer, sessionErr := provider.OpenSessionExecer(ctx)
		if sessionErr != nil {
			logger.Warnf("DBQueryMulti 打开会话级执行器失败，将回退共享连接：%s SQL片段=%q err=%v", formatConnSummary(runConfig), sqlSnippet(query), sessionErr)
		} else {
			if statementQueryExecer, ok := sessionExecer.(db.StatementQueryExecer); ok {
				sessionQueryTarget = statementQueryExecer
			}
			if statementQueryMessageExecer, ok := sessionExecer.(db.StatementQueryMessageExecer); ok {
				sessionQueryMessageTarget = statementQueryMessageExecer
			}
			if statementMultiResultQueryExecer, ok := sessionExecer.(db.StatementMultiResultQueryExecer); ok {
				sessionMultiQueryTarget = statementMultiResultQueryExecer
			}
			if statementMultiResultQueryMessageExecer, ok := sessionExecer.(db.StatementMultiResultQueryMessageExecer); ok {
				sessionMultiQueryMessageTarget = statementMultiResultQueryMessageExecer
			}
			sessionExecTarget = sessionExecer
			if batcher, ok := sessionExecer.(db.BatchWriteExecer); ok {
				sessionBatchTarget = batcher
			}
			closeExecTarget = func() {
				if err := sessionExecer.Close(); err != nil {
					logger.Warnf("DBQueryMulti 关闭会话级执行器失败：%v", err)
				}
			}
		}
	}
	defer closeExecTarget()

	// 单条写语句且驱动支持批量 Exec 时，可复用批量路径。
	// 多条写语句必须逐条返回结果；部分驱动对多语句 Exec 仅暴露最后一条 RowsAffected，
	// 会导致前面语句已成功执行但结果页只剩一个写入结果。
	if !allReadOnly {
		allWrite := true
		containsPLSQLBlock := false
		containsQueryFirstWrite := false
		for _, stmt := range statements {
			stmt = strings.TrimSpace(stmt)
			if stmt == "" {
				continue
			}
			if !isBatchableWriteSQLStatement(runConfig.Type, stmt) {
				allWrite = false
			}
			if shouldTryQueryResultFirst(runConfig.Type, stmt) {
				containsQueryFirstWrite = true
			}
			if isPLSQLBlockStatementForDialect(resolvedDBType, stmt) {
				containsPLSQLBlock = true
			}
		}
		if allWrite && !containsPLSQLBlock && !containsQueryFirstWrite && len(statements) == 1 {
			batcher := sessionBatchTarget
			if batcher == nil {
				if fallbackBatcher, ok := dbInst.(db.BatchWriteExecer); ok {
					batcher = fallbackBatcher
				}
			}
			if batcher != nil {
				var (
					affected int64
					batchErr error
				)
				measureQueryExecution(func() {
					setRunningQueryCancellable(true)
					affected, batchErr = batcher.ExecBatchContext(ctx, query)
				})
				if batchErr != nil {
					if shouldRefreshCachedConnection(batchErr) {
						a.invalidateCachedDatabase(runConfig, batchErr)
					}
					batchErr = classifyDispatchedWriteError(batchErr)
					logger.Error(batchErr, "DBQueryMulti 批量写执行失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
					return summarizeMultiStatementResult(buildWriteExecutionFailure(ctx, batchErr, queryID), 0, 1, sqlaudit.BoundaryModeImplicit, writeExecutionOutcomeUnknown(ctx, batchErr))
				}
				logger.Infof("DBQueryMulti 批量写执行成功：%s 语句数=%d affectedRows=%d", formatConnSummary(runConfig), len(statements), affected)
				return summarizeMultiStatementResult(connection.QueryResult{
					Success: true,
					Data: []connection.ResultSetData{{
						Rows:    []map[string]interface{}{{"affectedRows": affected}},
						Columns: []string{"affectedRows"},
					}},
					QueryID: queryID,
				}, 1, 0, sqlaudit.BoundaryModeImplicit, false)
			}
		}
	}

	var resultSets []connection.ResultSetData
	executedCount := 0
	textTransactionOpen := false
	summaryBoundaryMode := sqlaudit.BoundaryModeImplicit
	summaryCommitMode := sqlaudit.CommitModeAuto
	for idx, stmt := range statements {
		if !rowBudget.CanMaterializeRow(0) {
			applyRowBudgetTruncation(resultSets, rowBudget)
			// 前一语句已达结果预算并停止读取，剩余语句不再执行。
			break
		}
		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			continue
		}
		statementStartedAt := time.Now()
		statementBoundaryMode, statementCommitMode := sqlAuditTextTransactionMetadata(stmt, textTransactionOpen)
		summaryBoundaryMode = statementBoundaryMode
		summaryCommitMode = statementCommitMode

		isReadStmt := isReadOnlySQLQuery(runConfig.Type, stmt)
		tryQueryStmtFirst := shouldTryQueryResultFirst(runConfig.Type, stmt)
		if isReadStmt || tryQueryStmtFirst {
			preferPlainReadQuery := isReadStmt && shouldPreferPlainReadQueryResult(resolvedDBType)
			var (
				data             []map[string]interface{}
				columns          []string
				messages         []string
				statementResults []connection.ResultSetData
				usedMultiResult  bool
			)
			runStatementQuery := func() error {
				measureQueryExecution(func() {
					if sessionQueryMessageTarget != nil {
						setRunningQueryCancellable(true)
						data, columns, messages, err = sessionQueryMessageTarget.QueryContextWithMessages(ctx, stmt)
					} else if sessionQueryTarget != nil {
						setRunningQueryCancellable(true)
						data, columns, err = sessionQueryTarget.QueryContext(ctx, stmt)
					} else if q, ok := dbInst.(db.QueryMessageExecer); ok {
						setRunningQueryCancellable(true)
						data, columns, messages, err = q.QueryContextWithMessages(ctx, stmt)
					} else if q, ok := dbInst.(db.QueryContexter); ok {
						setRunningQueryCancellable(true)
						data, columns, err = q.QueryContext(ctx, stmt)
					} else {
						if ctxErr := ctx.Err(); ctxErr != nil {
							err = ctxErr
							return
						}
						setRunningQueryCancellable(false)
						if ctxErr := ctx.Err(); ctxErr != nil {
							setRunningQueryCancellable(true)
							err = ctxErr
							return
						}
						data, columns, err = dbInst.Query(stmt)
						legacyCancellationUnsupported = ctx.Err() != nil
					}
				})
				return err
			}
			if preferPlainReadQuery {
				err = runStatementQuery()
			} else if sessionMultiQueryMessageTarget != nil {
				setRunningQueryCancellable(true)
				measureQueryExecution(func() {
					statementResults, messages, err = sessionMultiQueryMessageTarget.QueryMultiContextWithMessages(ctx, stmt)
				})
				usedMultiResult = true
			} else if sessionMultiQueryTarget != nil {
				setRunningQueryCancellable(true)
				measureQueryExecution(func() {
					statementResults, err = sessionMultiQueryTarget.QueryMultiContext(ctx, stmt)
				})
				usedMultiResult = true
			} else if q, ok := dbInst.(db.MultiResultQueryMessageExecer); ok {
				setRunningQueryCancellable(true)
				measureQueryExecution(func() {
					statementResults, messages, err = q.QueryMultiContextWithMessages(ctx, stmt)
				})
				usedMultiResult = true
			} else if q, ok := dbInst.(db.MultiResultQuerierContext); ok {
				setRunningQueryCancellable(true)
				measureQueryExecution(func() {
					statementResults, err = q.QueryMultiContext(ctx, stmt)
				})
				usedMultiResult = true
			} else if q, ok := dbInst.(db.MultiResultQuerier); ok {
				if ctxErr := ctx.Err(); ctxErr != nil {
					err = ctxErr
				} else {
					setRunningQueryCancellable(false)
					if ctxErr := ctx.Err(); ctxErr != nil {
						setRunningQueryCancellable(true)
						err = ctxErr
					} else {
						measureQueryExecution(func() {
							statementResults, err = q.QueryMulti(stmt)
						})
						legacyCancellationUnsupported = ctx.Err() != nil
					}
				}
				usedMultiResult = true
			} else {
				err = runStatementQuery()
			}
			if legacyCancellationUnsupported {
				cancellationResults := append([]connection.ResultSetData(nil), resultSets...)
				if err == nil {
					if usedMultiResult {
						for resultIndex := range statementResults {
							statementResults[resultIndex].StatementIndex = idx + 1
						}
						cancellationResults = append(cancellationResults, statementResults...)
					} else {
						cancellationResults = append(cancellationResults, connection.ResultSetData{
							Rows: data, Columns: columns, Messages: messages, StatementIndex: idx + 1,
						})
					}
				}
				return a.buildCancellationUnsupportedExecutionResult(connection.QueryResult{
					Data: cancellationResults, QueryID: queryID,
				}, err)
			}
			if err == nil && usedMultiResult && shouldFallbackToPlainQueryAfterMultiResult(isReadStmt, statementResults, messages) {
				logger.Warnf("DBQueryMulti 逐条多结果集返回空结果，将回退普通查询（第 %d/%d 条）：%s SQL片段=%q", idx+1, len(statements), formatConnSummary(runConfig), sqlSnippet(stmt))
				usedMultiResult = false
				statementResults = nil
				data = nil
				columns = nil
				messages = nil
				err = runStatementQuery()
			}
			if err == nil {
				if usedMultiResult {
					var rowsAffected, rowsReturned int64
					if len(statementResults) == 0 && len(messages) > 0 {
						statementResults = []connection.ResultSetData{{
							Rows:     []map[string]interface{}{},
							Columns:  []string{},
							Messages: append([]string(nil), messages...),
						}}
					}
					for _, statementResult := range statementResults {
						if statementResult.Rows == nil {
							statementResult.Rows = []map[string]interface{}{}
						}
						if statementResult.Columns == nil {
							statementResult.Columns = []string{}
						}
						statementResult.StatementIndex = idx + 1
						affected, returned := summarizeManagedSQLResultSet(statementResult)
						rowsAffected += affected
						rowsReturned += returned
						resultSets = append(resultSets, statementResult)
					}
					applyRowBudgetTruncation(resultSets, rowBudget)
					appendStatementAudit(auditStatements[idx], idx+1, statementStartedAt, rowsAffected, rowsReturned, statementBoundaryMode, statementCommitMode, nil)
					executedCount++
					textTransactionOpen = advancesSQLAuditTextTransaction(stmt, textTransactionOpen)
					continue
				}
				if data == nil {
					data = make([]map[string]interface{}, 0)
				}
				if columns == nil {
					columns = []string{}
				}
				resultSets = append(resultSets, connection.ResultSetData{
					Rows:           data,
					Columns:        columns,
					Messages:       messages,
					StatementIndex: idx + 1,
				})
				applyRowBudgetTruncation(resultSets, rowBudget)
				appendStatementAudit(auditStatements[idx], idx+1, statementStartedAt, 0, int64(len(data)), statementBoundaryMode, statementCommitMode, nil)
				executedCount++
				textTransactionOpen = advancesSQLAuditTextTransaction(stmt, textTransactionOpen)
				continue
			}
			if isReadStmt {
				logger.Error(err, "DBQueryMulti 逐条查询失败（第 %d/%d 条）：%s SQL片段=%q", idx+1, len(statements), formatConnSummary(runConfig), sqlSnippet(stmt))
				errMsg := buildStatementExecutionFailedMessage(idx+1, err, len(resultSets))
				appendStatementAudit(auditStatements[idx], idx+1, statementStartedAt, 0, 0, statementBoundaryMode, statementCommitMode, err)
				return summarizeMultiStatementResultWithCommitMode(buildQueryExecutionFailure(ctx, err, errMsg, queryID), executedCount, idx+1, statementBoundaryMode, statementCommitMode, false)
			}
			if shouldRefreshCachedConnection(err) {
				a.invalidateCachedDatabase(runConfig, err)
			}
			err = classifyDispatchedWriteError(err)
			logger.Error(err, "DBQueryMulti 写入查询失败（第 %d/%d 条）：%s SQL片段=%q", idx+1, len(statements), formatConnSummary(runConfig), sqlSnippet(stmt))
			errMsg := buildStatementExecutionFailedMessage(idx+1, err, len(resultSets))
			appendStatementAudit(auditStatements[idx], idx+1, statementStartedAt, 0, 0, statementBoundaryMode, statementCommitMode, err)
			failure := buildWriteExecutionFailure(ctx, err, queryID)
			failure.Message = errMsg
			return summarizeMultiStatementResultWithCommitMode(failure, executedCount, idx+1, statementBoundaryMode, statementCommitMode, writeExecutionOutcomeUnknown(ctx, err))
		}

		var affected int64
		measureQueryExecution(func() {
			if sessionExecTarget != nil {
				setRunningQueryCancellable(true)
				affected, err = sessionExecTarget.ExecContext(ctx, stmt)
			} else if e, ok := dbInst.(db.ExecContexter); ok {
				setRunningQueryCancellable(true)
				affected, err = e.ExecContext(ctx, stmt)
			} else {
				if ctxErr := ctx.Err(); ctxErr != nil {
					err = ctxErr
					return
				}
				setRunningQueryCancellable(false)
				if ctxErr := ctx.Err(); ctxErr != nil {
					setRunningQueryCancellable(true)
					err = ctxErr
					return
				}
				affected, err = dbInst.Exec(stmt)
				legacyCancellationUnsupported = ctx.Err() != nil
			}
		})
		if legacyCancellationUnsupported {
			cancellationResults := append([]connection.ResultSetData(nil), resultSets...)
			if err == nil {
				cancellationResults = append(cancellationResults, connection.ResultSetData{
					Rows: []map[string]interface{}{{"affectedRows": affected}}, Columns: []string{"affectedRows"}, StatementIndex: idx + 1,
				})
			}
			return a.buildCancellationUnsupportedExecutionResult(connection.QueryResult{
				Data: cancellationResults, QueryID: queryID,
			}, err)
		}
		if err != nil {
			if shouldRefreshCachedConnection(err) {
				a.invalidateCachedDatabase(runConfig, err)
			}
			err = classifyDispatchedWriteError(err)
			logger.Error(err, "DBQueryMulti 逐条执行失败（第 %d/%d 条）：%s SQL片段=%q", idx+1, len(statements), formatConnSummary(runConfig), sqlSnippet(stmt))
			errMsg := buildStatementExecutionFailedMessage(idx+1, err, len(resultSets))
			appendStatementAudit(auditStatements[idx], idx+1, statementStartedAt, 0, 0, statementBoundaryMode, statementCommitMode, err)
			if writeExecutionOutcomeUnknown(ctx, err) {
				return summarizeMultiStatementResultWithCommitMode(connection.QueryResult{Success: false, Message: errMsg, Data: map[string]any{"outcomeUnknown": true}, QueryID: queryID}, executedCount, idx+1, statementBoundaryMode, statementCommitMode, true)
			}
			return summarizeMultiStatementResultWithCommitMode(connection.QueryResult{Success: false, Message: errMsg, QueryID: queryID}, executedCount, idx+1, statementBoundaryMode, statementCommitMode, false)
		}
		resultSets = append(resultSets, connection.ResultSetData{
			Rows:           []map[string]interface{}{{"affectedRows": affected}},
			Columns:        []string{"affectedRows"},
			StatementIndex: idx + 1,
		})
		appendStatementAudit(auditStatements[idx], idx+1, statementStartedAt, affected, 0, statementBoundaryMode, statementCommitMode, nil)
		executedCount++
		textTransactionOpen = advancesSQLAuditTextTransaction(stmt, textTransactionOpen)
	}

	if resultSets == nil {
		resultSets = []connection.ResultSetData{}
	}
	// 回退到逐条执行且有多条语句时，附加提示信息
	var fallbackMsg string
	if len(statements) > 1 {
		fallbackMsg = buildSequentialFallbackMessage(len(statements))
	}
	applyRowBudgetTruncation(resultSets, rowBudget)
	return summarizeMultiStatementResultWithCommitMode(connection.QueryResult{Success: true, Data: resultSets, QueryID: queryID, Message: fallbackMsg}, executedCount, 0, summaryBoundaryMode, summaryCommitMode, false)
}
