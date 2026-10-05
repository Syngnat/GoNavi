package app

import (
	"context"
	"errors"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/sqlaudit"
)

func (a *App) MySQLConnect(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "mysql"
	return a.DBConnect(config)
}

func (a *App) MySQLQuery(config connection.ConnectionConfig, dbName string, query string) connection.QueryResult {
	config.Type = "mysql"
	return a.DBQuery(config, dbName, query)
}

func (a *App) MySQLGetDatabases(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "mysql"
	return a.DBGetDatabases(config)
}

func (a *App) MySQLGetTables(config connection.ConnectionConfig, dbName string) connection.QueryResult {
	config.Type = "mysql"
	return a.DBGetTables(config, dbName)
}

func (a *App) MySQLShowCreateTable(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	config.Type = "mysql"
	return a.DBShowCreateTable(config, dbName, tableName)
}

type dbQueryAuditOptions struct {
	trackHistory              bool
	auditAll                  bool
	auditWrites               bool
	source                    string
	executionContext          context.Context
	synchronousConnectionWait bool
	classifyConnectionErrors  bool
}

type dbQueryMultiAuditOptions struct {
	auditAll                  bool
	auditWrites               bool
	source                    string
	executionContext          context.Context
	synchronousConnectionWait bool
	classifyConnectionErrors  bool
	// RowBudget 为每个结果集的物化行数上限，0 表示不限制。
	// 保留给只按行限制的无界面调用方（如 MCP）。
	RowBudget int
	// ResultBudget 为桌面查询等交互式入口提供复合预算。
	ResultBudget *db.RowBudgetOptions
}

func buildQueryConnectionFailure(err error, queryID string, classify bool) connection.QueryResult {
	result := connection.QueryResult{Success: false, Message: err.Error(), QueryID: queryID}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		result.Data = map[string]any{"cancelled": true}
		return result
	}
	if classify {
		result.Data = map[string]any{"errorKind": headlessResultErrorKindConnection}
	}
	return result
}

// buildQueryExecutionFailure preserves cancellation provenance when a driver
// returns context.Canceled or context.DeadlineExceeded from an in-flight read.
// The query context may already have been cleaned up by the time the CLI maps
// the result, so the marker must travel with the QueryResult itself.
func buildQueryExecutionFailure(ctx context.Context, err error, message string, queryID string) connection.QueryResult {
	if message == "" && err != nil {
		message = err.Error()
	}
	result := connection.QueryResult{Success: false, Message: message, QueryID: queryID}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) ||
		(ctx != nil && (errors.Is(ctx.Err(), context.Canceled) || errors.Is(ctx.Err(), context.DeadlineExceeded))) {
		result.Data = map[string]any{"cancelled": true}
	}
	return result
}

func (a *App) buildCancellationUnsupportedExecutionResult(result connection.QueryResult, err error) connection.QueryResult {
	result.Success = err == nil
	result.CancellationState = connection.QueryCancellationStateUnsupported
	result.Message = a.appText("query_editor.message.cancel_unsupported", nil)
	if err != nil {
		result.Message += ": " + err.Error()
	}
	return result
}

// writeExecutionOutcomeUnknown covers both a driver-level ambiguous response
// and a caller cancellation observed while a write was in flight. The latter
// must be treated as unknown even when a driver returns an opaque error rather
// than context.Canceled after it may already have dispatched the statement.
func writeExecutionOutcomeUnknown(ctx context.Context, err error) bool {
	return db.IsWriteOutcomeUnknown(err) || db.IsAmbiguousWriteResponse(err) || (ctx != nil && ctx.Err() != nil)
}

// classifyDispatchedWriteError treats opaque connection-loss messages as an
// unknown write outcome. Once a write has been dispatched, reconnecting and
// replaying it is unsafe even when the driver did not return a typed network
// error.
func classifyDispatchedWriteError(err error) error {
	if err == nil || db.IsWriteOutcomeUnknown(err) || !shouldRefreshCachedConnection(err) {
		return err
	}
	return db.MarkWriteOutcomeUnknown(err)
}

// buildWriteExecutionFailure keeps the no-retry/unknown-outcome contract
// visible to headless callers. Drivers normally attach WriteOutcomeUnknown
// themselves; transport failures and a cancelled in-flight context are
// conservatively treated the same way so a statement that may have reached
// the server is never reported as rejected.
func buildWriteExecutionFailure(ctx context.Context, err error, queryID string) connection.QueryResult {
	data := map[string]any{}
	if writeExecutionOutcomeUnknown(ctx, err) {
		data["outcomeUnknown"] = true
	}
	result := connection.QueryResult{Success: false, Message: err.Error(), QueryID: queryID}
	if len(data) > 0 {
		result.Data = data
	}
	return result
}

func summarizeMultiStatementResult(result connection.QueryResult, executedCount, failedIndex int, boundaryMode string, outcomeUnknown bool) connection.QueryResult {
	return summarizeMultiStatementResultWithCommitMode(result, executedCount, failedIndex, boundaryMode, sqlaudit.CommitModeAuto, outcomeUnknown)
}

func summarizeMultiStatementResultWithCommitMode(result connection.QueryResult, executedCount, failedIndex int, boundaryMode string, commitMode string, outcomeUnknown bool) connection.QueryResult {
	result.ExecutedCount = executedCount
	result.FailedIndex = failedIndex
	result.BoundaryMode = boundaryMode
	result.CommitMode = commitMode
	result.OutcomeUnknown = result.OutcomeUnknown || outcomeUnknown
	result.Partial = result.Partial || executedCount > 0 && failedIndex > 0
	return result
}

func sqlAuditTextTransactionMetadata(statement string, transactionOpen bool) (boundaryMode string, commitMode string) {
	if !isSQLTransactionControlStatement(statement) {
		if transactionOpen {
			return sqlaudit.BoundaryModeTextSQL, sqlaudit.CommitModePending
		}
		return sqlaudit.BoundaryModeImplicit, sqlaudit.CommitModeAuto
	}

	keyword, keywordEnd := nextSQLKeyword(statement, 0)
	switch keyword {
	case "begin":
		if isBeginTransactionControlStatement(statement, keywordEnd) {
			return sqlaudit.BoundaryModeTextSQL, sqlaudit.CommitModePending
		}
	case "start", "savepoint", "release":
		return sqlaudit.BoundaryModeTextSQL, sqlaudit.CommitModePending
	case "commit", "rollback":
		return sqlaudit.BoundaryModeTextSQL, sqlaudit.CommitModeManual
	}
	return sqlaudit.BoundaryModeTextSQL, sqlaudit.CommitModePending
}

func advancesSQLAuditTextTransaction(statement string, transactionOpen bool) bool {
	keyword, keywordEnd := nextSQLKeyword(statement, 0)
	switch keyword {
	case "begin":
		return transactionOpen || isBeginTransactionControlStatement(statement, keywordEnd)
	case "start":
		return transactionOpen || strings.Contains(strings.ToLower(statement), "transaction")
	case "commit":
		return false
	case "rollback":
		// ROLLBACK TO SAVEPOINT preserves the surrounding transaction.
		return strings.Contains(strings.ToLower(statement), " to ")
	default:
		return transactionOpen
	}
}

func executedStatementCount(err error) int {
	if err == nil {
		return 1
	}
	return 0
}

func failedStatementIndex(index int, err error) int {
	if err != nil {
		return index
	}
	return 0
}
