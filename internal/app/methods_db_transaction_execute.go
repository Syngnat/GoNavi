package app

import (
	"context"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

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
	options ...managedTransactionStatementOptions,
) ([]connection.ResultSetData, error) {
	if text == nil {
		text = defaultDBBackendText
	}
	var executionOptions managedTransactionStatementOptions
	if len(options) > 0 {
		executionOptions = options[0]
	}
	resolvedDBType := resolveDDLDBType(runConfig)
	rowBudget := db.RowBudgetFromContext(ctx)
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
		if !rowBudget.CanMaterializeRow(0) {
			applyRowBudgetTruncation(resultSets, rowBudget)
			break
		}
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

		executableStmt := stmt
		if executionOptions.ExecutableTexts != nil && statementIndex-1 < len(executionOptions.ExecutableTexts) {
			executableStmt = executionOptions.ExecutableTexts[statementIndex-1]
		}
		var stmtArgs []any
		if executionOptions.ArgsByStatement != nil && statementIndex-1 < len(executionOptions.ArgsByStatement) {
			stmtArgs = executionOptions.ArgsByStatement[statementIndex-1]
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
			if len(stmtArgs) > 0 {
				if argsTarget, ok := session.(db.StatementQueryArgsExecer); ok {
					data, columns, err = argsTarget.QueryContextWithArgs(ctx, executableStmt, stmtArgs)
				} else {
					err = errParameterBindingSessionUnsupported
				}
			} else if isReadStmt && shouldPreferPlainReadQueryResult(resolvedDBType) {
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
					applyRowBudgetTruncation(resultSets, rowBudget)
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
				applyRowBudgetTruncation(resultSets, rowBudget)
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

		var affected int64
		var err error
		if len(stmtArgs) > 0 {
			if argsTarget, ok := session.(db.StatementExecArgsExecer); ok {
				affected, err = argsTarget.ExecContextWithArgs(ctx, executableStmt, stmtArgs)
			} else {
				err = errParameterBindingSessionUnsupported
			}
		} else {
			affected, err = session.ExecContext(ctx, stmt)
		}
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
