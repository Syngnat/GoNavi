package app

import (
	"context"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/sqlaudit"

	"github.com/google/uuid"
)

// DBQueryMultiTransactional executes SQL editor DML in a managed transaction.
// The transaction stays open until DBCommitTransaction or DBRollbackTransaction
// is called by the SQL editor UI.
func (a *App) DBQueryMultiTransactional(config connection.ConnectionConfig, dbName string, query string, queryID string) connection.QueryResult {
	return a.dbQueryMultiTransactionalWithBindings(config, dbName, query, queryID, nil, nil)
}

// DBQueryMultiTransactionalWithParams 在托管事务启动时按名绑定参数执行首条 SQL。
func (a *App) DBQueryMultiTransactionalWithParams(config connection.ConnectionConfig, dbName string, query string, queryID string, bindings []connection.QueryParamBinding) connection.QueryResult {
	return a.dbQueryMultiTransactionalWithBindings(config, dbName, query, queryID, bindings, nil)
}

func (a *App) dbQueryMultiTransactionalWithBindings(config connection.ConnectionConfig, dbName string, query string, queryID string, bindings []connection.QueryParamBinding, budgetOptions *db.RowBudgetOptions) (result connection.QueryResult) {
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
		if budgetOptions != nil {
			options := dbQueryMultiAuditOptions{
				auditAll:     true,
				auditWrites:  true,
				source:       "query_editor",
				ResultBudget: budgetOptions,
			}
			if len(bindings) > 0 {
				return a.dbQueryMultiWithParams(config, dbName, query, queryID, bindings, options)
			}
			return a.dbQueryMulti(config, dbName, query, queryID, options)
		}
		if len(bindings) > 0 {
			return a.dbQueryMultiWithParams(config, dbName, query, queryID, bindings, dbQueryMultiAuditOptions{
				auditAll:    true,
				auditWrites: true,
				source:      "query_editor",
			})
		}
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
		result.DurationMs = durationMilliseconds(queryExecutionDuration)
	}()
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
	if budget := db.NewRowBudgetWithOptions(valueOrZero(budgetOptions)); budget != nil {
		ctx = db.ContextWithRowBudget(ctx, budget)
	}
	cleanupRunningQuery := a.registerRunningQuery(queryID, cancel, true, optionalDriverTypeForConnectionConfig(runConfig))
	lifecycle := a.beginQueryExecutionLifecycleWithConnection(queryID)
	defer func() {
		lifecycle.complete(result)
		cancel()
		cleanupRunningQuery()
	}()

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBQueryMultiTransactional 获取连接失败：%s", formatConnSummary(runConfig))
		return connection.QueryResult{Success: false, Message: err.Error(), QueryID: queryID}
	}
	lifecycle.markExecuting()

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
		if !ok || !runtimeSupportsSessionExecer(dbInst) {
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
		if !ok || !runtimeSupportsSessionExecer(dbInst) {
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

	statements, executionOptions, bindErr := prepareManagedTransactionStatements(transactionDBType, query, sessionExecer, bindings)
	if bindErr != nil {
		return connection.QueryResult{Success: false, Message: a.translateParameterBindingError(bindErr), QueryID: queryID}
	}
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
		executionOptions,
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
	return a.dbQueryMultiInTransaction(transactionID, query, queryID, nil)
}

func (a *App) dbQueryMultiInTransaction(transactionID string, query string, queryID string, budgetOptions *db.RowBudgetOptions) (result connection.QueryResult) {
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
	// 附加/卸载指令在托管事务中无语义（由连接级拦截执行），直接给出明确报错，
	// 避免指令原文透传到引擎产生难懂的语法错误（Web RPC 公开入口的防御）。
	if strings.EqualFold(runConfig.Type, "duckdb") && queryContainsDuckDBSavedConnectionDirective(query) {
		return connection.QueryResult{
			Success:            false,
			Message:            a.appText("db.backend.error.duckdb_attach.directive_in_transaction", nil),
			QueryID:            queryID,
			TransactionID:      transactionID,
			TransactionPending: true,
		}
	}
	ctx, cancel := newQueryExecutionContext(runConfig)
	if budget := db.NewRowBudgetWithOptions(valueOrZero(budgetOptions)); budget != nil {
		ctx = db.ContextWithRowBudget(ctx, budget)
	}
	cleanupRunningQuery := a.registerRunningQuery(queryID, cancel, true, optionalDriverTypeForConnectionConfig(runConfig))
	lifecycle := a.beginQueryExecutionLifecycle(queryID)
	defer func() {
		lifecycle.complete(result)
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
		result.DurationMs = durationMilliseconds(queryExecutionDuration)
	}()
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
