package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/sqlaudit"
	"github.com/google/uuid"
)

const sqlEditorTransactionFinishTimeout = 30 * time.Second

type managedSQLStatementObservation struct {
	Statement      string
	StatementIndex int
	StatementCount int
	StartedAt      time.Time
	CompletedAt    time.Time
	Duration       time.Duration
	RowsAffected   int64
	RowsReturned   int64
	Err            error
}

type managedSQLStatementObserver func(managedSQLStatementObservation)

func withManagedSQLStatementAuditTimestamp(
	observer managedSQLStatementObserver,
	events *[]sqlaudit.Event,
) managedSQLStatementObserver {
	if observer == nil {
		return nil
	}
	return func(observation managedSQLStatementObservation) {
		before := 0
		if events != nil {
			before = len(*events)
		}
		observer(observation)
		if events == nil || observation.CompletedAt.IsZero() {
			return
		}
		for index := before; index < len(*events); index++ {
			(*events)[index].Timestamp = observation.CompletedAt.UnixMilli()
		}
	}
}

// DBQueryMultiTransactional executes SQL editor DML in a managed transaction.
// The transaction stays open until DBCommitTransaction or DBRollbackTransaction
// is called by the SQL editor UI.
func (a *App) DBQueryMultiTransactional(config connection.ConnectionConfig, dbName string, query string, queryID string) (result connection.QueryResult) {
	runConfig := normalizeRunConfig(config, dbName)
	transactionDBType := resolveDDLDBType(runConfig)
	transactionConfig := runConfig
	transactionConfig.Type = transactionDBType
	buildManagedTransactionUnsupportedMessage := func() string {
		return a.appText("db.backend.error.managed_transaction_unsupported", map[string]any{
			"dbType": transactionDBType,
		})
	}
	appendRollbackFailureMessage := func(baseErr error, rollbackErr error) error {
		if rollbackErr == nil {
			return baseErr
		}
		rollbackMessage := a.appText("db.backend.error.transaction_rollback_failed", map[string]any{
			"detail": rollbackErr.Error(),
		})
		if baseErr == nil {
			return fmt.Errorf("%s", rollbackMessage)
		}
		return fmt.Errorf("%s; %s", baseErr.Error(), rollbackMessage)
	}

	if queryID == "" {
		queryID = generateQueryID()
	}

	query = sanitizeSQLForPgLike(transactionDBType, query)
	if !shouldUseManagedSQLTransaction(transactionDBType, query) {
		return a.DBQueryMulti(config, dbName, query, queryID)
	}
	transactionID := "sql-editor-" + uuid.NewString()
	transactionAuditOpened := false
	transactionBoundaryMode := "unknown"
	defer func() {
		if transactionAuditOpened {
			return
		}
		a.recordSQLAuditTransactionEvent(sqlAuditTransactionEventInput{
			Config:         transactionConfig,
			Database:       dbName,
			DBType:         transactionDBType,
			QueryID:        queryID,
			TransactionID:  transactionID,
			EventType:      "transaction_begin",
			Status:         sqlAuditStatusFromResult(result),
			Source:         "query_editor",
			CommitMode:     "pending",
			BoundaryMode:   transactionBoundaryMode,
			SQL:            query,
			StatementCount: countSQLAuditStatements(transactionDBType, query),
			Err:            sqlAuditErrorFromResult(result),
		})
	}()
	if err := a.ensureDataSourceQueryCapability(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error(), QueryID: queryID}
	}
	if err := ensureConnectionAllowsQuery(config, query); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error(), QueryID: queryID}
	}
	var queryExecutionDuration time.Duration
	defer func() {
		if !result.Success {
			return
		}
		durationMs := queryExecutionDuration.Milliseconds()
		a.recordQueryExecution(config, dbName, transactionDBType, query, durationMs, 0, queryResultRowsReturned(result))
	}()

	beginSQL, commitSQL, rollbackSQL, hasTextTransaction := sqlFileBatchTransactionSQL(transactionDBType)
	implicitTextTransaction := false
	if implicitCommitSQL, implicitRollbackSQL, ok := sqlEditorImplicitTransactionSQL(transactionDBType); ok {
		commitSQL = implicitCommitSQL
		rollbackSQL = implicitRollbackSQL
		hasTextTransaction = true
		implicitTextTransaction = true
	}

	ctx, cancel := newQueryExecutionContext(runConfig)
	cleanupRunningQuery := a.registerRunningQuery(queryID, cancel, true)
	defer func() {
		cancel()
		cleanupRunningQuery()
	}()

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBQueryMultiTransactional 获取连接失败：%s", formatConnSummary(runConfig))
		return connection.QueryResult{Success: false, Message: err.Error(), QueryID: queryID}
	}

	var (
		sessionExecer        db.StatementExecer
		transactor           db.TransactionExecer
		transactionCancel    context.CancelFunc
		startTextTransaction bool
	)
	if provider, ok := dbInst.(db.TransactionExecerProvider); ok {
		transactionBoundaryMode = "driver_api"
		// database/sql rolls back a BeginTx transaction when its context is cancelled.
		// SQL editor transactions must outlive the execution RPC and be ended only by
		// explicit commit, rollback, or shutdown cleanup.
		transactionContext := context.Background()
		transactionContext, transactionCancel = context.WithCancel(transactionContext)
		transactionExecer, err := provider.OpenTransactionExecer(transactionContext)
		if err != nil {
			transactionCancel()
			logger.Error(err, "DBQueryMultiTransactional 打开驱动事务失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
			return connection.QueryResult{Success: false, Message: err.Error(), QueryID: queryID}
		}
		sessionExecer = transactionExecer
		transactor = transactionExecer
	} else if implicitTextTransaction {
		transactionBoundaryMode = "implicit"
		provider, ok := dbInst.(db.SessionExecerProvider)
		if !ok {
			return connection.QueryResult{
				Success: false,
				Message: buildManagedTransactionUnsupportedMessage(),
				QueryID: queryID,
			}
		}
		sessionExecer, err = provider.OpenSessionExecer(ctx)
		if err != nil {
			logger.Error(err, "DBQueryMultiTransactional 打开隐式事务会话失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
			return connection.QueryResult{Success: false, Message: err.Error(), QueryID: queryID}
		}
	} else {
		transactionBoundaryMode = "text_sql"
		if !hasTextTransaction {
			return connection.QueryResult{
				Success: false,
				Message: buildManagedTransactionUnsupportedMessage(),
				QueryID: queryID,
			}
		}
		provider, ok := dbInst.(db.SessionExecerProvider)
		if !ok {
			return connection.QueryResult{
				Success: false,
				Message: buildManagedTransactionUnsupportedMessage(),
				QueryID: queryID,
			}
		}
		sessionExecer, err = provider.OpenSessionExecer(ctx)
		if err != nil {
			logger.Error(err, "DBQueryMultiTransactional 打开事务会话失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
			return connection.QueryResult{Success: false, Message: err.Error(), QueryID: queryID}
		}
		startTextTransaction = true
	}

	closeSession := true
	defer func() {
		if closeSession {
			if err := sessionExecer.Close(); err != nil {
				logger.Warnf("DBQueryMultiTransactional 关闭事务会话失败：%v", err)
			}
			if transactionCancel != nil {
				transactionCancel()
			}
		}
	}()

	if startTextTransaction {
		if _, err := sessionExecer.ExecContext(ctx, beginSQL); err != nil {
			logger.Error(err, "DBQueryMultiTransactional 开启事务失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
			return connection.QueryResult{Success: false, Message: err.Error(), QueryID: queryID}
		}
	}
	transactionAuditOpened = true
	a.recordSQLAuditTransactionEvent(sqlAuditTransactionEventInput{
		Config:        transactionConfig,
		Database:      dbName,
		DBType:        transactionDBType,
		QueryID:       queryID,
		TransactionID: transactionID,
		EventType:     "transaction_begin",
		Status:        "success",
		Source:        "query_editor",
		CommitMode:    "pending",
		BoundaryMode:  transactionBoundaryMode,
	})

	statements := splitSQLStatementsForDialect(transactionDBType, query)
	queryStartedAt := time.Now()
	statementAuditEvents := make([]sqlaudit.Event, 0, len(statements))
	resultSets, err := executeManagedSQLTransactionStatementsWithObserver(
		ctx,
		sessionExecer,
		transactionConfig,
		statements,
		a.appText,
		withManagedSQLStatementAuditTimestamp(
			a.sqlAuditTransactionStatementObserver(transactionConfig, dbName, transactionDBType, queryID, transactionID, transactionBoundaryMode, &statementAuditEvents),
			&statementAuditEvents,
		),
	)
	queryExecutionDuration += time.Since(queryStartedAt)
	a.appendSQLAuditEvents(statementAuditEvents)
	if err != nil {
		a.recordSQLAuditTransactionEvent(sqlAuditTransactionEventInput{
			Config:        transactionConfig,
			Database:      dbName,
			DBType:        transactionDBType,
			QueryID:       queryID,
			TransactionID: transactionID,
			EventType:     "transaction_rollback_requested",
			Status:        "success",
			Source:        "query_editor",
			CommitMode:    "auto",
			BoundaryMode:  transactionBoundaryMode,
		})
		var rollbackErr error
		if transactor != nil {
			rollbackErr = transactor.Rollback()
		} else if strings.TrimSpace(rollbackSQL) != "" {
			_, rollbackErr = sessionExecer.ExecContext(context.Background(), rollbackSQL)
		}
		if rollbackErr != nil {
			logger.Error(rollbackErr, "DBQueryMultiTransactional 执行失败后回滚失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
			err = appendRollbackFailureMessage(err, rollbackErr)
		}
		a.recordSQLAuditTransactionEvent(sqlAuditTransactionEventInput{
			Config:        transactionConfig,
			Database:      dbName,
			DBType:        transactionDBType,
			QueryID:       queryID,
			TransactionID: transactionID,
			EventType:     "transaction_auto_rollback",
			Status:        sqlAuditStatusFromError(rollbackErr),
			Source:        "query_editor",
			CommitMode:    "auto",
			BoundaryMode:  transactionBoundaryMode,
			Err:           rollbackErr,
		})
		logger.Error(err, "DBQueryMultiTransactional 执行失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
		return connection.QueryResult{Success: false, Message: err.Error(), QueryID: queryID}
	}

	a.sqlTransactionMu.Lock()
	if a.sqlTransactions == nil {
		a.sqlTransactions = make(map[string]*managedSQLTransaction)
	}
	a.sqlTransactions[transactionID] = &managedSQLTransaction{
		id:           transactionID,
		execer:       sessionExecer,
		transactor:   transactor,
		cancel:       transactionCancel,
		config:       runConfig,
		dbType:       transactionDBType,
		boundaryMode: transactionBoundaryMode,
		commitSQL:    commitSQL,
		rollbackSQL:  rollbackSQL,
		createdAt:    time.Now(),
	}
	a.sqlTransactionMu.Unlock()

	closeSession = false
	return connection.QueryResult{
		Success:            true,
		Data:               resultSets,
		QueryID:            queryID,
		TransactionID:      transactionID,
		TransactionPending: true,
	}
}

// DBQueryMultiInTransaction executes follow-up SQL in an existing SQL editor managed transaction.
// The transaction remains open until DBCommitTransaction or DBRollbackTransaction is called.
func (a *App) DBQueryMultiInTransaction(transactionID string, query string, queryID string) (result connection.QueryResult) {
	transactionID = strings.TrimSpace(transactionID)
	if transactionID == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.transaction_id_required", nil), QueryID: queryID}
	}
	if queryID == "" {
		queryID = generateQueryID()
	}

	a.sqlTransactionMu.Lock()
	tx, ok := a.sqlTransactions[transactionID]
	a.sqlTransactionMu.Unlock()
	if !ok || tx == nil || tx.execer == nil {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.transaction_not_found", nil), QueryID: queryID}
	}

	runConfig := tx.config
	if strings.TrimSpace(runConfig.Type) == "" {
		runConfig.Type = tx.dbType
	}
	ctx, cancel := newQueryExecutionContext(runConfig)
	cleanupRunningQuery := a.registerRunningQuery(queryID, cancel, true)
	defer func() {
		cancel()
		cleanupRunningQuery()
	}()

	tx.mu.Lock()
	defer tx.mu.Unlock()
	if tx.finished || tx.execer == nil {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.transaction_not_found", nil), QueryID: queryID}
	}

	var queryExecutionDuration time.Duration
	defer func() {
		if !result.Success {
			return
		}
		durationMs := queryExecutionDuration.Milliseconds()
		a.recordQueryExecution(runConfig, "", tx.dbType, query, durationMs, 0, queryResultRowsReturned(result))
	}()
	query = sanitizeSQLForPgLike(tx.dbType, query)
	statements := splitSQLStatementsForDialect(tx.dbType, query)

	queryStartedAt := time.Now()
	statementAuditEvents := make([]sqlaudit.Event, 0, len(statements))
	resultSets, err := executeManagedSQLTransactionStatementsWithObserver(
		ctx,
		tx.execer,
		runConfig,
		statements,
		a.appText,
		withManagedSQLStatementAuditTimestamp(
			a.sqlAuditTransactionStatementObserver(runConfig, runConfig.Database, tx.dbType, queryID, transactionID, tx.boundaryMode, &statementAuditEvents),
			&statementAuditEvents,
		),
	)
	queryExecutionDuration += time.Since(queryStartedAt)
	a.appendSQLAuditEvents(statementAuditEvents)
	if err != nil {
		logger.Error(err, "DBQueryMultiInTransaction 执行失败：id=%s dbType=%s SQL片段=%q", transactionID, tx.dbType, sqlSnippet(query))
		return connection.QueryResult{
			Success:            false,
			Message:            err.Error(),
			QueryID:            queryID,
			TransactionID:      transactionID,
			TransactionPending: true,
		}
	}

	return connection.QueryResult{
		Success:            true,
		Data:               resultSets,
		QueryID:            queryID,
		TransactionID:      transactionID,
		TransactionPending: true,
	}
}

func executeManagedSQLTransactionStatements(ctx context.Context, session db.StatementExecer, runConfig connection.ConnectionConfig, statements []string, text func(string, map[string]any) string) ([]connection.ResultSetData, error) {
	return executeManagedSQLTransactionStatementsWithObserver(ctx, session, runConfig, statements, text, nil)
}

func executeManagedSQLTransactionStatementsWithObserver(
	ctx context.Context,
	session db.StatementExecer,
	runConfig connection.ConnectionConfig,
	statements []string,
	text func(string, map[string]any) string,
	observer managedSQLStatementObserver,
) ([]connection.ResultSetData, error) {
	if text == nil {
		text = defaultDBBackendText
	}
	resolvedDBType := resolveDDLDBType(runConfig)
	buildStatementExecutionFailedError := func(index int, err error) error {
		return fmt.Errorf("%s", text("db.backend.error.multi_statement_execution_failed", map[string]any{
			"index":  index,
			"detail": err.Error(),
		}))
	}
	buildTransactionQueryUnsupportedError := func() error {
		return fmt.Errorf("%s", text("db.backend.error.transaction_query_unsupported", nil))
	}

	var resultSets []connection.ResultSetData
	sessionQueryTarget, _ := session.(db.StatementQueryExecer)
	sessionQueryMessageTarget, _ := session.(db.StatementQueryMessageExecer)
	sessionMultiQueryTarget, _ := session.(db.StatementMultiResultQueryExecer)
	sessionMultiQueryMessageTarget, _ := session.(db.StatementMultiResultQueryMessageExecer)

	statementCount := 0
	for _, statement := range statements {
		if strings.TrimSpace(statement) != "" {
			statementCount++
		}
	}
	statementIndex := 0
	for _, stmt := range statements {
		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			continue
		}
		statementIndex++
		statementStartedAt := time.Now()
		emitObservation := func(rowsAffected, rowsReturned int64, err error) {
			if observer == nil {
				return
			}
			completedAt := time.Now()
			observer(managedSQLStatementObservation{
				Statement:      stmt,
				StatementIndex: statementIndex,
				StatementCount: statementCount,
				StartedAt:      statementStartedAt,
				CompletedAt:    completedAt,
				Duration:       completedAt.Sub(statementStartedAt),
				RowsAffected:   rowsAffected,
				RowsReturned:   rowsReturned,
				Err:            err,
			})
		}

		isReadStmt := isReadOnlySQLQuery(runConfig.Type, stmt)
		tryQueryStmtFirst := shouldTryQueryResultFirst(runConfig.Type, stmt)
		if isReadStmt || tryQueryStmtFirst {
			var (
				data             []map[string]interface{}
				columns          []string
				messages         []string
				statementResults []connection.ResultSetData
				usedMultiResult  bool
				err              error
			)
			if isReadStmt && shouldPreferPlainReadQueryResult(resolvedDBType) {
				if sessionQueryMessageTarget != nil {
					data, columns, messages, err = sessionQueryMessageTarget.QueryContextWithMessages(ctx, stmt)
				} else if sessionQueryTarget != nil {
					data, columns, err = sessionQueryTarget.QueryContext(ctx, stmt)
				} else {
					err = buildTransactionQueryUnsupportedError()
				}
			} else if sessionMultiQueryMessageTarget != nil {
				statementResults, messages, err = sessionMultiQueryMessageTarget.QueryMultiContextWithMessages(ctx, stmt)
				usedMultiResult = true
			} else if sessionMultiQueryTarget != nil {
				statementResults, err = sessionMultiQueryTarget.QueryMultiContext(ctx, stmt)
				usedMultiResult = true
			} else if sessionQueryMessageTarget != nil {
				data, columns, messages, err = sessionQueryMessageTarget.QueryContextWithMessages(ctx, stmt)
			} else if sessionQueryTarget != nil {
				data, columns, err = sessionQueryTarget.QueryContext(ctx, stmt)
			} else {
				err = buildTransactionQueryUnsupportedError()
			}
			if err == nil && usedMultiResult && shouldFallbackToPlainQueryAfterMultiResult(isReadStmt, statementResults, messages) {
				logger.Warnf("托管事务多结果集返回空结果，将回退普通查询（第 %d/%d 条）：类型=%s SQL片段=%q", statementIndex, statementCount, resolvedDBType, sqlSnippet(stmt))
				usedMultiResult = false
				statementResults = nil
				data = nil
				columns = nil
				messages = nil
				if sessionQueryMessageTarget != nil {
					data, columns, messages, err = sessionQueryMessageTarget.QueryContextWithMessages(ctx, stmt)
				} else if sessionQueryTarget != nil {
					data, columns, err = sessionQueryTarget.QueryContext(ctx, stmt)
				} else {
					err = buildTransactionQueryUnsupportedError()
				}
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
						statementResult.StatementIndex = statementIndex
						affected, returned := summarizeManagedSQLResultSet(statementResult)
						rowsAffected += affected
						rowsReturned += returned
						resultSets = append(resultSets, statementResult)
					}
					emitObservation(rowsAffected, rowsReturned, nil)
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
					StatementIndex: statementIndex,
				})
				emitObservation(0, int64(len(data)), nil)
				continue
			}
			if isReadStmt {
				statementErr := buildStatementExecutionFailedError(statementIndex, err)
				emitObservation(0, 0, statementErr)
				return nil, statementErr
			}
			// Query-first writes may already have reached the server. Falling
			// through to Exec would replay the same statement in this transaction.
			statementErr := buildStatementExecutionFailedError(statementIndex, classifyDispatchedWriteError(err))
			emitObservation(0, 0, statementErr)
			return nil, statementErr
		}

		affected, err := session.ExecContext(ctx, stmt)
		if err != nil {
			statementErr := buildStatementExecutionFailedError(statementIndex, err)
			emitObservation(0, 0, statementErr)
			return nil, statementErr
		}
		resultSets = append(resultSets, connection.ResultSetData{
			Rows:           []map[string]interface{}{{"affectedRows": affected}},
			Columns:        []string{"affectedRows"},
			StatementIndex: statementIndex,
		})
		emitObservation(affected, 0, nil)
	}

	if resultSets == nil {
		resultSets = []connection.ResultSetData{}
	}
	return resultSets, nil
}

func summarizeManagedSQLResultSet(resultSet connection.ResultSetData) (rowsAffected, rowsReturned int64) {
	if !isAffectedRowsResultSet(resultSet) {
		return 0, int64(len(resultSet.Rows))
	}
	for _, row := range resultSet.Rows {
		value, ok := row["affectedRows"]
		if !ok {
			for key, candidate := range row {
				if strings.EqualFold(strings.TrimSpace(key), "affectedRows") {
					value = candidate
					ok = true
					break
				}
			}
		}
		if !ok {
			continue
		}
		switch typed := value.(type) {
		case int:
			rowsAffected += int64(typed)
		case int32:
			rowsAffected += int64(typed)
		case int64:
			rowsAffected += typed
		case uint:
			rowsAffected += int64(typed)
		case uint32:
			rowsAffected += int64(typed)
		case uint64:
			if typed <= uint64(^uint64(0)>>1) {
				rowsAffected += int64(typed)
			}
		case float64:
			rowsAffected += int64(typed)
		}
	}
	return rowsAffected, 0
}

func shouldUseManagedSQLTransaction(dbType string, query string) bool {
	if isManagedSQLTransactionUnsupportedType(dbType) {
		return false
	}
	statements := splitSQLStatementsForDialect(dbType, query)
	hasManagedWrite := false
	for _, stmt := range statements {
		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			continue
		}
		if isSQLTransactionControlStatement(stmt) {
			return false
		}
		if isReadOnlySQLQuery(dbType, stmt) {
			continue
		}
		if isManagedSQLBlockWrite(dbType, stmt) {
			hasManagedWrite = true
			continue
		}
		if isBatchableWriteSQLStatement(dbType, stmt) {
			hasManagedWrite = true
			continue
		}
		return false
	}
	return hasManagedWrite
}

func isManagedSQLTransactionUnsupportedType(dbType string) bool {
	return !db.ResolveDataSourceCapability(dbType).Transaction.Supported
}

func sqlEditorImplicitTransactionSQL(dbType string) (commitSQL string, rollbackSQL string, ok bool) {
	switch strings.ToLower(strings.TrimSpace(dbType)) {
	case "oracle":
		// Oracle starts a transaction implicitly on the first DML statement.
		// Keeping SQL editor DML on one physical connection avoids database/sql
		// Tx context lifecycle ending the transaction before the UI commits it.
		return "COMMIT", "ROLLBACK", true
	default:
		return "", "", false
	}
}

func isSQLTransactionControlStatement(stmt string) bool {
	keyword, keywordEnd := nextSQLKeyword(stmt, 0)
	switch keyword {
	case "begin", "commit", "rollback", "savepoint", "release":
		if keyword != "begin" {
			return true
		}
		return isBeginTransactionControlStatement(stmt, keywordEnd)
	case "start":
		return strings.Contains(strings.ToLower(stmt), "transaction")
	default:
		return false
	}
}

func isBeginTransactionControlStatement(stmt string, keywordEnd int) bool {
	switch nextSQLSignificantByte(stmt, keywordEnd) {
	case 0, ';':
		return true
	}

	switch nextSQLSignificantToken(stmt, keywordEnd) {
	case "transaction", "tran", "work", "isolation", "read", "write", "deferred", "immediate", "exclusive", "distributed":
		return true
	default:
		return false
	}
}

func isManagedSQLBlockWrite(dbType string, stmt string) bool {
	keyword, keywordEnd := nextSQLKeyword(stmt, 0)
	switch {
	case isOracleLikeDBType(dbType):
		if keyword != "begin" && keyword != "declare" {
			return false
		}
	case isSQLServerDBType(dbType):
		if keyword != "begin" || isBeginTransactionControlStatement(stmt, keywordEnd) {
			return false
		}
	default:
		return false
	}

	return sqlContainsKeyword(stmt, "insert", dbType) ||
		sqlContainsKeyword(stmt, "update", dbType) ||
		sqlContainsKeyword(stmt, "delete", dbType) ||
		sqlContainsKeyword(stmt, "merge", dbType) ||
		sqlContainsKeyword(stmt, "replace", dbType) ||
		sqlContainsKeyword(stmt, "upsert", dbType)
}

func (a *App) DBCommitTransaction(transactionID string) connection.QueryResult {
	return a.finishManagedSQLTransaction(transactionID, true, "manual")
}

func (a *App) DBRollbackTransaction(transactionID string) connection.QueryResult {
	return a.finishManagedSQLTransaction(transactionID, false, "manual")
}

func (a *App) DBCommitTransactionWithTrigger(transactionID string, trigger string) connection.QueryResult {
	return a.finishManagedSQLTransaction(transactionID, true, trigger)
}

func (a *App) DBRollbackTransactionWithTrigger(transactionID string, trigger string) connection.QueryResult {
	return a.finishManagedSQLTransaction(transactionID, false, trigger)
}

func (a *App) finishManagedSQLTransaction(transactionID string, commit bool, trigger string) connection.QueryResult {
	transactionID = strings.TrimSpace(transactionID)
	trigger = normalizeSQLTransactionFinishTrigger(trigger)
	if transactionID == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.transaction_id_required", nil)}
	}

	a.sqlTransactionMu.Lock()
	tx, ok := a.sqlTransactions[transactionID]
	if ok {
		delete(a.sqlTransactions, transactionID)
	}
	a.sqlTransactionMu.Unlock()
	if !ok || tx == nil || tx.execer == nil {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.transaction_not_found", nil)}
	}
	tx.mu.Lock()
	defer tx.mu.Unlock()
	if tx.finished || tx.execer == nil {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.transaction_not_found", nil)}
	}
	tx.finished = true
	if tx.cancel != nil {
		defer tx.cancel()
	}

	actionCode := "rollback"
	sqlText := tx.rollbackSQL
	eventType := "transaction_rollback"
	if commit {
		actionCode = "commit"
		sqlText = tx.commitSQL
		eventType = "transaction_commit"
	} else if trigger == "tab_close" || trigger == "auto" {
		eventType = "transaction_auto_rollback"
	}
	auditSource := "query_editor"
	if trigger == "tab_close" {
		auditSource = "tab_close"
	}
	commitMode := "manual"
	if trigger == "auto" {
		commitMode = "auto"
	}

	ctx, cancel := context.WithTimeout(context.Background(), sqlEditorTransactionFinishTimeout)
	defer cancel()
	requestedEventType := "transaction_rollback_requested"
	if commit {
		requestedEventType = "transaction_commit_requested"
	}
	a.recordSQLAuditTransactionEvent(sqlAuditTransactionEventInput{
		Config:        tx.config,
		Database:      tx.config.Database,
		DBType:        tx.dbType,
		TransactionID: transactionID,
		EventType:     requestedEventType,
		Status:        "success",
		Source:        auditSource,
		CommitMode:    commitMode,
		BoundaryMode:  tx.boundaryMode,
	})
	startedAt := time.Now()

	var execErr error
	if tx.transactor != nil {
		if commit {
			execErr = tx.transactor.Commit()
		} else {
			execErr = tx.transactor.Rollback()
		}
	} else if strings.TrimSpace(sqlText) != "" {
		_, execErr = tx.execer.ExecContext(ctx, sqlText)
	}
	closeErr := tx.execer.Close()
	if execErr != nil {
		if closeErr != nil {
			execErr = errors.Join(execErr, closeErr)
		}
		a.recordSQLAuditTransactionEvent(sqlAuditTransactionEventInput{
			Config:        tx.config,
			Database:      tx.config.Database,
			DBType:        tx.dbType,
			TransactionID: transactionID,
			EventType:     eventType,
			Status:        "error",
			Source:        auditSource,
			CommitMode:    commitMode,
			BoundaryMode:  tx.boundaryMode,
			Duration:      time.Since(startedAt),
			Err:           execErr,
		})
		logger.Error(execErr, "SQL 编辑器事务%s失败：id=%s dbType=%s", actionCode, transactionID, tx.dbType)
		key := "db.backend.error.transaction_rollback_failed"
		if commit {
			key = "db.backend.error.transaction_commit_failed"
		}
		return connection.QueryResult{
			Success:        false,
			Message:        a.appText(key, map[string]any{"detail": execErr.Error()}),
			OutcomeUnknown: true,
		}
	}
	if closeErr != nil {
		// Commit/Rollback has already succeeded at the database boundary. Record that
		// outcome as success while retaining the local session cleanup error.
		a.recordSQLAuditTransactionEvent(sqlAuditTransactionEventInput{
			Config:        tx.config,
			Database:      tx.config.Database,
			DBType:        tx.dbType,
			TransactionID: transactionID,
			EventType:     eventType,
			Status:        "success",
			Source:        auditSource,
			CommitMode:    commitMode,
			BoundaryMode:  tx.boundaryMode,
			Duration:      time.Since(startedAt),
			Err:           closeErr,
		})
		logger.Error(closeErr, "SQL 编辑器事务%s后关闭会话失败：id=%s dbType=%s", actionCode, transactionID, tx.dbType)
		key := "db.backend.error.transaction_rollback_close_failed"
		if commit {
			key = "db.backend.error.transaction_commit_close_failed"
		}
		return connection.QueryResult{Success: false, Message: a.appText(key, map[string]any{"detail": closeErr.Error()})}
	}
	a.recordSQLAuditTransactionEvent(sqlAuditTransactionEventInput{
		Config:        tx.config,
		Database:      tx.config.Database,
		DBType:        tx.dbType,
		TransactionID: transactionID,
		EventType:     eventType,
		Status:        "success",
		Source:        auditSource,
		CommitMode:    commitMode,
		BoundaryMode:  tx.boundaryMode,
		Duration:      time.Since(startedAt),
	})

	if commit {
		return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.transaction_committed", nil)}
	}
	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.transaction_rolled_back", nil)}
}

func normalizeSQLTransactionFinishTrigger(trigger string) string {
	switch strings.ToLower(strings.TrimSpace(trigger)) {
	case "auto", "tab_close":
		return strings.ToLower(strings.TrimSpace(trigger))
	default:
		return "manual"
	}
}

func (a *App) rollbackPendingSQLTransactionsOnShutdown() {
	a.rollbackAllPendingSQLTransactions("app_shutdown", "关闭应用时")
}

// rollbackAbandonedSQLTransactionsOnReload 回滚前端重载后已无法再被引用的托管事务。
//
// SQL 编辑器的待提交事务 ID 只存在于 React 组件内存（useSqlEditorTransactionController 的
// useState/useRef），持久化状态里只有 commitMode/autoCommitDelayMs 这类设置。
// 因此前端一旦重载，残留在 a.sqlTransactions 中的条目必然是不可能再被提交或回滚的孤儿：
// 它们会一直占着 pinned 连接与数据库行锁，直到应用退出。
//
// 实测后果：执行 DELETE 进入托管事务后不点提交、直接刷新，再执行同一条 DELETE 就会卡满
// innodb_lock_wait_timeout（默认 50 秒）并报 Error 1205 Lock wait timeout exceeded，
// 只能重启应用才能恢复。
func (a *App) rollbackAbandonedSQLTransactionsOnReload() {
	a.rollbackAllPendingSQLTransactions("frontend_reload", "前端重载后")
}

func (a *App) rollbackAllPendingSQLTransactions(auditSource string, logPrefix string) {
	a.sqlTransactionMu.Lock()
	pending := make([]*managedSQLTransaction, 0, len(a.sqlTransactions))
	for id, tx := range a.sqlTransactions {
		if tx != nil {
			pending = append(pending, tx)
		}
		delete(a.sqlTransactions, id)
	}
	a.sqlTransactionMu.Unlock()

	for _, tx := range pending {
		tx.mu.Lock()
		if tx.finished {
			tx.mu.Unlock()
			continue
		}
		tx.finished = true
		ctx, cancel := context.WithTimeout(context.Background(), sqlEditorTransactionFinishTimeout)
		a.recordSQLAuditTransactionEvent(sqlAuditTransactionEventInput{
			Config:        tx.config,
			Database:      tx.config.Database,
			DBType:        tx.dbType,
			TransactionID: tx.id,
			EventType:     "transaction_rollback_requested",
			Status:        "success",
			Source:        auditSource,
			CommitMode:    "auto",
			BoundaryMode:  tx.boundaryMode,
		})
		startedAt := time.Now()
		var rollbackErr error
		if tx.transactor != nil {
			if err := tx.transactor.Rollback(); err != nil {
				rollbackErr = err
				logger.Warnf("%s回滚 SQL 编辑器事务失败：id=%s dbType=%s err=%v", logPrefix, tx.id, tx.dbType, err)
			}
		} else if strings.TrimSpace(tx.rollbackSQL) != "" && tx.execer != nil {
			if _, err := tx.execer.ExecContext(ctx, tx.rollbackSQL); err != nil {
				rollbackErr = err
				logger.Warnf("%s回滚 SQL 编辑器事务失败：id=%s dbType=%s err=%v", logPrefix, tx.id, tx.dbType, err)
			}
		}
		cancel()
		if tx.cancel != nil {
			tx.cancel()
		}
		var closeErr error
		if tx.execer != nil {
			if err := tx.execer.Close(); err != nil {
				closeErr = err
				logger.Warnf("%s关闭 SQL 编辑器事务会话失败：id=%s dbType=%s err=%v", logPrefix, tx.id, tx.dbType, err)
			}
		}
		auditErr := rollbackErr
		status := sqlAuditStatusFromError(rollbackErr)
		if auditErr == nil && closeErr != nil {
			// The database rollback succeeded; retain only the cleanup warning.
			auditErr = closeErr
		}
		a.recordSQLAuditTransactionEvent(sqlAuditTransactionEventInput{
			Config:        tx.config,
			Database:      tx.config.Database,
			DBType:        tx.dbType,
			TransactionID: tx.id,
			EventType:     "transaction_auto_rollback",
			Status:        status,
			Source:        auditSource,
			CommitMode:    "auto",
			BoundaryMode:  tx.boundaryMode,
			Duration:      time.Since(startedAt),
			Err:           auditErr,
		})
		tx.mu.Unlock()
	}
}
