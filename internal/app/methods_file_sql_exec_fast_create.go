package app

import (
	"context"
	"io"
	"strings"

	"GoNavi-Wails/internal/db"
)

// executeSQLFileFastCreateBatch is a narrow, opt-in path for MySQL-family
// files that only create objects. MySQL's multiStatements mode executes the
// whole batch in one round trip instead of paying one DDL round trip per table.
// Every statement is still preflighted individually, and any unclassified
// statement falls back to the ordinary sequential path.
func executeSQLFileFastCreateBatch(
	ctx context.Context,
	dbInst db.Database,
	reader io.Reader,
	options sqlFileExecutionOptions,
	bytesRead func() int64,
) (sqlFileExecutionResult, error) {
	if !isFastSQLFileCreateDialect(options.DBType) {
		return executeSQLFileFastCreateSequential(ctx, dbInst, reader, options, bytesRead, nil)
	}
	var statements []sqlFilePendingStatement
	unsupported := false
	_, err := StreamSQLFileWithOptions(reader, SQLStreamOptions{
		DBType:            options.DBType,
		MaxStatementBytes: options.MaxStatementBytes,
	}, func(index int, stmt string) error {
		stmt = pinSQLFileImportDatabase(options.DBType, strings.TrimSpace(stmt), options.PinDatabase)
		if stmt == "" {
			return nil
		}
		if options.PreflightEachStatement {
			preflight := PreflightSQLStatement(stmt, options.DBType, index)
			if !preflight.Safe && preflight.Reason != nil {
				return &sqlFilePreflightRejectedError{reason: *preflight.Reason}
			}
		}
		if options.StatementGuard != nil {
			if err := options.StatementGuard(index, stmt); err != nil {
				return err
			}
		}
		if options.SkipStatement != nil && options.SkipStatement(index, stmt) {
			return nil
		}
		if !isFastSQLFileCreateStatement(options.DBType, stmt) {
			unsupported = true
		}
		statements = append(statements, sqlFilePendingStatement{Index: index, SQL: stmt})
		return nil
	})
	if err != nil {
		return sqlFileExecutionResult{}, err
	}
	if unsupported {
		return executeSQLFileFastCreateSequential(ctx, dbInst, reader, options, bytesRead, statements)
	}
	if len(statements) == 0 {
		return sqlFileExecutionResult{}, nil
	}
	return executeSQLFileFastCreateInOneBatch(ctx, dbInst, statements, options, bytesRead)
}

func executeSQLFileFastCreateInOneBatch(
	ctx context.Context,
	dbInst db.Database,
	statements []sqlFilePendingStatement,
	options sqlFileExecutionOptions,
	bytesRead func() int64,
) (sqlFileExecutionResult, error) {
	result := sqlFileExecutionResult{}
	if capability, ok := dbInst.(db.BatchWriteCapability); !ok || !capability.SupportsBatchWrites() {
		return executeSQLFileFastCreateStatementsSequential(ctx, dbInst, statements, options, bytesRead)
	}
	if len(statements) > options.BatchMaxStatements || sqlFileBatchByteSize(statements) > options.BatchMaxBytes {
		return executeSQLFileFastCreateStatementsSequential(ctx, dbInst, statements, options, bytesRead)
	}
	execer := sqlFileStatementExecer(dbInst)
	batcher, ok := dbInst.(sqlFileBatchStatementExecer)
	var cleanup func()
	if provider, ok := dbInst.(db.SessionExecerProvider); ok && runtimeSupportsSessionExecer(dbInst) {
		session, err := provider.OpenSessionExecer(ctx)
		if err != nil {
			return result, err
		}
		execer = session
		batcher, ok = session.(sqlFileBatchStatementExecer)
		cleanup = func() {
			if discarder, ok := session.(db.StatementExecerDiscarter); ok {
				_ = discarder.Discard()
			}
			_ = session.Close()
		}
	}
	if cleanup != nil {
		defer cleanup()
	}
	if !ok {
		return executeSQLFileFastCreateStatementsSequential(ctx, dbInst, statements, options, bytesRead)
	}
	batchSQL := joinSQLFileBatchStatements(statements)
	_, outcomeUnknown, err := executeSQLFileBatchWithOutcome(ctx, execer, batcher, options.DBType, batchSQL, false, options.Text)
	if err != nil {
		result.Failed = 1
		result.OutcomeUnknown = true // 多语句批失败时无法判定哪些 DDL 已落地
		_ = outcomeUnknown
		result.Errors = append(result.Errors, fileBackendText(options.Text, "file.backend.message.statement_failed", map[string]any{
			"index":  statements[0].Index + 1,
			"detail": sanitizeSQLFileExecutionError(err.Error()),
			"sql":    sqlFileStatementSnippet(batchSQL, 200),
		}))
		emitFastCreateProgress(options, result, statements[len(statements)-1].SQL, bytesRead)
		return result, err
	}
	result.Executed = len(statements)
	emitFastCreateProgress(options, result, statements[len(statements)-1].SQL, bytesRead)
	return result, nil
}

func executeSQLFileFastCreateSequential(
	ctx context.Context,
	dbInst db.Database,
	reader io.Reader,
	options sqlFileExecutionOptions,
	bytesRead func() int64,
	collected []sqlFilePendingStatement,
) (sqlFileExecutionResult, error) {
	if collected == nil {
		var statements []sqlFilePendingStatement
		_, err := StreamSQLFileWithOptions(reader, SQLStreamOptions{
			DBType:            options.DBType,
			MaxStatementBytes: options.MaxStatementBytes,
		}, func(index int, stmt string) error {
			stmt = pinSQLFileImportDatabase(options.DBType, strings.TrimSpace(stmt), options.PinDatabase)
			if stmt != "" {
				statements = append(statements, sqlFilePendingStatement{Index: index, SQL: stmt})
			}
			return nil
		})
		if err != nil {
			return sqlFileExecutionResult{}, err
		}
		collected = statements
	}
	return executeSQLFileFastCreateStatementsSequential(ctx, dbInst, collected, options, bytesRead)
}

func executeSQLFileFastCreateStatementsSequential(
	ctx context.Context,
	dbInst db.Database,
	statements []sqlFilePendingStatement,
	options sqlFileExecutionOptions,
	bytesRead func() int64,
) (sqlFileExecutionResult, error) {
	result := sqlFileExecutionResult{}
	execer := sqlFileStatementExecer(dbInst)
	for _, statement := range statements {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		if _, err := execSQLFileStatement(ctx, execer, statement.SQL); err != nil {
			result.Failed++
			result.OutcomeUnknown = db.IsWriteOutcomeUnknown(err) || db.IsAmbiguousWriteResponse(err)
			result.Errors = append(result.Errors, fileBackendText(options.Text, "file.backend.message.statement_failed", map[string]any{
				"index":  statement.Index + 1,
				"detail": sanitizeSQLFileExecutionError(err.Error()),
				"sql":    sqlFileStatementSnippet(statement.SQL, 200),
			}))
			emitFastCreateProgress(options, result, statement.SQL, bytesRead)
			return result, &sqlFileStoppedOnError{detail: result.Errors[len(result.Errors)-1]}
		}
		result.Executed++
		emitFastCreateProgress(options, result, statement.SQL, bytesRead)
	}
	return result, nil
}

func emitFastCreateProgress(options sqlFileExecutionOptions, result sqlFileExecutionResult, currentSQL string, bytesRead func() int64) {
	if options.OnProgress == nil {
		return
	}
	read := int64(0)
	if bytesRead != nil {
		read = bytesRead()
	}
	options.OnProgress(sqlFileExecutionProgress{
		Status:     "running",
		Executed:   result.Executed,
		Failed:     result.Failed,
		Total:      result.Executed + result.Failed,
		BytesRead:  read,
		CurrentSQL: sqlFileStatementSnippet(currentSQL, 100),
	})
}

func isFastSQLFileCreateDialect(dbType string) bool {
	switch normalizeSQLClassifierDBType(dbType) {
	case "mysql", "mariadb", "diros", "starrocks", "oceanbase":
		return true
	default:
		return false
	}
}

func isFastSQLFileCreateStatement(dbType, statement string) bool {
	keyword, position := nextSQLKeyword(statement, 0)
	switch keyword {
	case "set", "use":
		return true
	case "create":
		next, _ := nextSQLKeyword(statement, position)
		switch next {
		case "table", "database", "schema", "view", "index", "unique", "fulltext", "spatial", "temporary":
			return true
		default:
			return false
		}
	default:
		return false
	}
}

func sqlFileBatchByteSize(statements []sqlFilePendingStatement) int {
	size := 0
	for _, statement := range statements {
		size += len(statement.SQL) + 2
	}
	return size
}
