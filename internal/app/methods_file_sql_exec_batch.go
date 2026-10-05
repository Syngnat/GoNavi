package app

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/sqlaudit"
)

func normalizeSQLFileExecutionOptions(options sqlFileExecutionOptions) sqlFileExecutionOptions {
	if options.BatchMaxStatements <= 0 {
		options.BatchMaxStatements = sqlFileBatchMaxStatements
	}
	if options.BatchMaxBytes <= 0 {
		options.BatchMaxBytes = sqlFileBatchMaxBytes
	}
	if options.MaxStatementBytes <= 0 {
		options.MaxStatementBytes = DefaultSQLImportMaxStatementBytes
	}
	if options.TransactionMode != sqlFileTransactionModeSingle {
		options.TransactionMode = sqlFileTransactionModeOff
	}
	return options
}

func appendSQLFileBatchStatement(batch []sqlFilePendingStatement, index int, stmt string) []sqlFilePendingStatement {
	return append(batch, sqlFilePendingStatement{
		Index: index,
		SQL:   stmt,
	})
}

func joinSQLFileBatchStatements(batch []sqlFilePendingStatement) string {
	if len(batch) == 0 {
		return ""
	}
	totalLen := 0
	for _, item := range batch {
		totalLen += len(item.SQL) + 2
	}
	var builder strings.Builder
	builder.Grow(totalLen)
	for i, item := range batch {
		if i > 0 {
			builder.WriteString(";\n")
		}
		builder.WriteString(item.SQL)
	}
	return builder.String()
}

func sqlFileStatementSnippet(stmt string, maxLen int) string {
	snippet := strings.TrimSpace(sqlaudit.RedactSQL(stmt))
	if maxLen > 0 && len(snippet) > maxLen {
		return snippet[:maxLen] + "..."
	}
	return snippet
}

func sanitizeSQLFileExecutionError(message string) string {
	return sqlaudit.RedactError(message)
}

func sanitizeSQLFileExecutionErr(err error) string {
	if err == nil {
		return ""
	}
	return sanitizeSQLFileExecutionError(err.Error())
}

func execSQLFileStatement(ctx context.Context, execer sqlFileStatementExecer, stmt string) (int64, error) {
	if ctxErr := ctx.Err(); ctxErr != nil {
		return 0, ctxErr
	}
	if e, ok := execer.(sqlFileContextStatementExecer); ok {
		return e.ExecContext(ctx, stmt)
	}
	return execer.Exec(stmt)
}

func rollbackSQLFileTransaction(execer sqlFileStatementExecer, rollbackSQL string) error {
	cleanupCtx, cancel := context.WithTimeout(context.Background(), sqlFileSessionCleanupTimeout)
	defer cancel()
	if _, err := execSQLFileStatement(cleanupCtx, execer, rollbackSQL); err != nil {
		if discarder, ok := execer.(db.StatementExecerDiscarter); ok {
			if discardErr := discarder.Discard(); discardErr != nil {
				return fmt.Errorf("%w; discard contaminated session: %v", err, discardErr)
			}
		}
		return err
	}
	return nil
}

func isSQLFileBatchableWriteStatement(dbType string, stmt string) bool {
	if isReadOnlySQLQuery(dbType, stmt) {
		return false
	}
	if isPLSQLBlockStatementForDialect(dbType, stmt) {
		return false
	}
	if shouldTryQueryResultFirst(dbType, stmt) {
		return false
	}
	return isBatchableWriteSQLStatement(dbType, stmt)
}

func sqlFileBatchTransactionSQL(dbType string) (beginSQL string, commitSQL string, rollbackSQL string, ok bool) {
	switch normalizeSQLClassifierDBType(dbType) {
	case "mysql", "mariadb", "diros", "starrocks", "sphinx", "oceanbase":
		return "START TRANSACTION", "COMMIT", "ROLLBACK", true
	case "sqlserver":
		return "BEGIN TRANSACTION", "COMMIT TRANSACTION", "ROLLBACK TRANSACTION", true
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "sqlite", "duckdb", "iris":
		return "BEGIN", "COMMIT", "ROLLBACK", true
	default:
		return "", "", "", false
	}
}

func updateSQLFileTransactionState(dbType string, inTransaction bool, stmt string) bool {
	depth := 0
	if inTransaction {
		depth = 1
	}
	return updateSQLFileTransactionDepth(dbType, depth, stmt) > 0
}

func executeSQLFileBatch(ctx context.Context, execer sqlFileStatementExecer, batcher sqlFileBatchStatementExecer, dbType string, batchSQL string, useTransaction bool, text fileBackendTextFunc) (bool, error) {
	canFallback, _, err := executeSQLFileBatchWithOutcome(ctx, execer, batcher, dbType, batchSQL, useTransaction, text)
	return canFallback, err
}

func executeSQLFileBatchWithOutcome(ctx context.Context, execer sqlFileStatementExecer, batcher sqlFileBatchStatementExecer, dbType string, batchSQL string, useTransaction bool, text fileBackendTextFunc) (canFallback bool, outcomeUnknown bool, err error) {
	if !useTransaction {
		_, err = batcher.ExecBatchContext(ctx, batchSQL)
		return false, db.IsWriteOutcomeUnknown(err) || db.IsAmbiguousWriteResponse(err), err
	}

	beginSQL, commitSQL, rollbackSQL, ok := sqlFileBatchTransactionSQL(dbType)
	if !ok {
		_, err = batcher.ExecBatchContext(ctx, batchSQL)
		return false, db.IsWriteOutcomeUnknown(err) || db.IsAmbiguousWriteResponse(err), err
	}

	if _, err := execSQLFileStatement(ctx, execer, beginSQL); err != nil {
		unknown := db.IsWriteOutcomeUnknown(err) || db.IsAmbiguousWriteResponse(err)
		if rollbackErr := rollbackSQLFileTransaction(execer, rollbackSQL); rollbackErr != nil {
			return false, true, errors.New(fileBackendText(text, "file.backend.error.sql_file_batch_rollback_failed", map[string]any{
				"detail":         sanitizeSQLFileExecutionErr(err),
				"rollbackDetail": sanitizeSQLFileExecutionErr(rollbackErr),
			}))
		}
		return false, unknown, err
	}
	if _, err := batcher.ExecBatchContext(ctx, batchSQL); err != nil {
		unknown := db.IsWriteOutcomeUnknown(err) || db.IsAmbiguousWriteResponse(err)
		if rollbackErr := rollbackSQLFileTransaction(execer, rollbackSQL); rollbackErr != nil {
			return false, true, errors.New(fileBackendText(text, "file.backend.error.sql_file_batch_rollback_failed", map[string]any{
				"detail":         sanitizeSQLFileExecutionErr(err),
				"rollbackDetail": sanitizeSQLFileExecutionErr(rollbackErr),
			}))
		}
		// MySQL-family tables can use non-transactional engines. A successful
		// ROLLBACK therefore cannot prove that a partially executed batch left no
		// writes behind. Stop and surface the uncertainty instead of inviting a
		// blind replay.
		if unknown {
			return false, true, err
		}
		return true, isSQLFileMySQLCompatibleDialect(dbType), err
	}
	if _, err := execSQLFileStatement(ctx, execer, commitSQL); err != nil {
		if rollbackErr := rollbackSQLFileTransaction(execer, rollbackSQL); rollbackErr != nil {
			return false, true, errors.New(fileBackendText(text, "file.backend.error.sql_file_batch_rollback_failed", map[string]any{
				"detail":         sanitizeSQLFileExecutionErr(err),
				"rollbackDetail": sanitizeSQLFileExecutionErr(rollbackErr),
			}))
		}
		// Once COMMIT has been dispatched, an error does not prove whether the
		// server committed before the connection/context failure was observed.
		return false, true, err
	}
	return false, false, nil
}

func isSQLFileSingleTransactionDialectSupported(dbType string) bool {
	switch normalizeSQLClassifierDBType(dbType) {
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "sqlite", "duckdb", "iris", "cache", "sqlserver", "oracle", "dameng":
		return true
	default:
		return false
	}
}

func sqlFileSingleTransactionRequiresDriverExecer(dbType string) bool {
	switch normalizeSQLClassifierDBType(dbType) {
	case "oracle", "dameng":
		return true
	default:
		return false
	}
}

func sqlFileSingleTransactionSQL(dbType string) (beginSQL string, commitSQL string, rollbackSQL string, ok bool) {
	switch normalizeSQLClassifierDBType(dbType) {
	case "sqlserver":
		return "BEGIN TRANSACTION", "COMMIT TRANSACTION", "ROLLBACK TRANSACTION", true
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "sqlite", "duckdb", "iris", "cache":
		return "BEGIN", "COMMIT", "ROLLBACK", true
	default:
		return "", "", "", false
	}
}

func isSQLFileSingleTransactionControlStatement(dbType, stmt string) bool {
	if isSQLTransactionControlStatement(stmt) {
		return true
	}
	keyword, keywordEnd := nextSQLKeyword(stmt, 0)
	switch keyword {
	case "end":
		return sqlFileStatementIsTransactionEndAlias(dbType, stmt, keywordEnd)
	case "abort":
		switch normalizeSQLClassifierDBType(dbType) {
		case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "duckdb":
			return true
		}
	case "set":
		// Session and transaction settings can alter the outer transaction's
		// semantics. Other SET statements are rejected below as unknown too.
		return sqlContainsKeyword(stmt, "autocommit", dbType) || sqlContainsKeyword(stmt, "transaction", dbType) || sqlContainsKeyword(stmt, "isolation", dbType)
	}
	return false
}

func validateSQLFileSingleTransactionStatement(dbType, stmt string) error {
	dbType = normalizeSQLClassifierDBType(dbType)
	if !isSQLFileSingleTransactionDialectSupported(dbType) {
		return fmt.Errorf("single-transaction SQL-file execution cannot prove atomicity for database type %q", dbType)
	}
	if isSQLFileMySQLCompatibleDialect(dbType) || sqlFileMySQLImplicitCommitBeforeStatement(dbType, stmt) {
		return errors.New("single-transaction SQL-file execution rejects MySQL-family implicit commits")
	}
	if isSQLFileSingleTransactionControlStatement(dbType, stmt) {
		return errors.New("single-transaction SQL-file execution rejects explicit transaction control or transaction settings")
	}
	if isReadOnlySQLQuery(dbType, stmt) || isBatchableWriteSQLStatement(dbType, stmt) {
		return nil
	}
	return errors.New("single-transaction SQL-file execution rejects statements whose atomicity cannot be proven")
}
