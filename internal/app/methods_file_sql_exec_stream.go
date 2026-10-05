package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

func executeSQLFileSingleTransactionStream(ctx context.Context, dbInst db.Database, reader io.Reader, options sqlFileExecutionOptions, bytesRead func() int64) (result sqlFileExecutionResult, runErr error) {
	if options.ContinueOnError {
		return result, errors.New("single-transaction SQL-file execution does not support continue-on-error")
	}
	if !isSQLFileSingleTransactionDialectSupported(options.DBType) {
		return result, fmt.Errorf("single-transaction SQL-file execution cannot prove atomicity for database type %q", normalizeSQLClassifierDBType(options.DBType))
	}

	var execer sqlFileStatementExecer
	var closeHandle func() error
	var discardHandle func() error
	var rollbackTransaction func() error
	var commitTransaction func() error
	transactionActive := false
	discardOnCleanup := false

	if provider, ok := dbInst.(db.TransactionExecerProvider); ok {
		transaction, err := provider.OpenTransactionExecer(ctx)
		if err != nil {
			return result, err
		}
		execer = transaction
		transactionActive = true
		closeHandle = transaction.Close
		if discarder, ok := transaction.(db.StatementExecerDiscarter); ok {
			discardHandle = discarder.Discard
		}
		rollbackTransaction = func() error {
			transactionActive = false
			return transaction.Rollback()
		}
		commitTransaction = func() error {
			err := transaction.Commit()
			if err == nil {
				transactionActive = false
			}
			return err
		}
	} else {
		if sqlFileSingleTransactionRequiresDriverExecer(options.DBType) {
			return result, errors.New("single-transaction SQL-file execution requires a driver-backed transaction handle for this database type")
		}
		provider, ok := dbInst.(db.SessionExecerProvider)
		if !ok || !runtimeSupportsSessionExecer(dbInst) {
			return result, errors.New("single-transaction SQL-file execution requires a pinned database session")
		}
		session, err := provider.OpenSessionExecer(ctx)
		if err != nil {
			return result, err
		}
		execer = session
		closeHandle = session.Close
		if discarder, ok := session.(db.StatementExecerDiscarter); ok {
			discardHandle = discarder.Discard
		}
		beginSQL, commitSQL, rollbackSQL, ok := sqlFileSingleTransactionSQL(options.DBType)
		if !ok {
			_ = session.Close()
			return result, errors.New("single-transaction SQL-file execution cannot open a dialect transaction")
		}
		if _, err := execSQLFileStatement(ctx, execer, beginSQL); err != nil {
			discardOnCleanup = true
			if discardHandle != nil {
				_ = discardHandle()
			}
			_ = session.Close()
			return result, err
		}
		transactionActive = true
		rollbackTransaction = func() error {
			transactionActive = false
			return rollbackSQLFileTransaction(execer, rollbackSQL)
		}
		commitTransaction = func() error {
			_, err := execSQLFileStatement(ctx, execer, commitSQL)
			if err == nil {
				transactionActive = false
			}
			return err
		}
	}

	defer func() {
		if transactionActive && rollbackTransaction != nil {
			if err := rollbackTransaction(); err != nil {
				result.OutcomeUnknown = true
				discardOnCleanup = true
				logger.Warnf("ExecuteSQLFile single transaction rollback failed: type=%s err=%s", options.DBType, sanitizeSQLFileExecutionErr(err))
			}
		}
		if discardOnCleanup && discardHandle != nil {
			if err := discardHandle(); err != nil {
				logger.Warnf("ExecuteSQLFile single transaction discard failed: type=%s err=%s", options.DBType, sanitizeSQLFileExecutionErr(err))
			}
		}
		if closeHandle != nil {
			if err := closeHandle(); err != nil {
				if discardHandle != nil {
					_ = discardHandle()
				}
				logger.Warnf("ExecuteSQLFile single transaction session close failed: type=%s err=%s", options.DBType, sanitizeSQLFileExecutionErr(err))
			}
		}
	}()

	readBytes := func() int64 {
		if bytesRead == nil {
			return 0
		}
		return bytesRead()
	}
	var lastProgressAt time.Time
	emitProgress := func(currentSQL string) {
		if options.OnProgress == nil {
			return
		}
		total := result.Executed + result.Failed
		options.OnProgress(sqlFileExecutionProgress{
			Status:     "running",
			Executed:   result.Executed,
			Failed:     result.Failed,
			Total:      total,
			BytesRead:  readBytes(),
			CurrentSQL: currentSQL,
		})
		lastProgressAt = time.Now()
	}
	shouldEmitProgress := func() bool {
		total := result.Executed + result.Failed
		if total <= 10 || total%sqlFileProgressStatementInterval == 0 {
			return true
		}
		return !lastProgressAt.IsZero() && time.Since(lastProgressAt) >= sqlFileProgressTimeInterval
	}
	recordError := func(index int, stmt string, err error) string {
		result.Failed++
		detail := fileBackendText(options.Text, "file.backend.message.statement_failed", map[string]any{
			"index":  index + 1,
			"detail": sanitizeSQLFileExecutionError(err.Error()),
			"sql":    sqlFileStatementSnippet(stmt, 200),
		})
		if len(result.Errors) < sqlFileMaxErrorDetails {
			result.Errors = append(result.Errors, detail)
		}
		logger.Warnf("ExecuteSQLFile %s", detail)
		return detail
	}

	_, streamErr := StreamSQLFileWithOptions(reader, SQLStreamOptions{
		DBType:            options.DBType,
		MaxStatementBytes: options.MaxStatementBytes,
	}, func(index int, stmt string) error {
		if err := ctx.Err(); err != nil {
			return errSQLFileCancelled
		}
		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			return nil
		}
		if options.PreflightEachStatement {
			preflightResult := PreflightSQLStatement(stmt, options.DBType, index)
			if !preflightResult.Safe && preflightResult.Reason != nil {
				return &sqlFilePreflightRejectedError{reason: *preflightResult.Reason}
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
		if err := validateSQLFileSingleTransactionStatement(options.DBType, stmt); err != nil {
			return err
		}

		if _, err := execSQLFileStatement(ctx, execer, stmt); err != nil {
			if db.IsWriteOutcomeUnknown(err) || db.IsAmbiguousWriteResponse(err) {
				// A driver can lose the response after dispatch without the
				// context being cancelled. Do not flatten that into an ordinary
				// statement failure: the transaction's server-side state is not
				// knowable from the client.
				result.OutcomeUnknown = true
			}
			if ctx.Err() != nil {
				// The driver may have sent the statement before cancellation was
				// observed, so a later rollback result cannot prove the outcome.
				result.OutcomeUnknown = true
				return errSQLFileCancelled
			}
			detail := recordError(index, stmt, err)
			if shouldEmitProgress() {
				emitProgress(sqlFileStatementSnippet(stmt, 100))
			}
			return &sqlFileStoppedOnError{detail: detail}
		}
		result.Executed++
		if shouldEmitProgress() {
			emitProgress(sqlFileStatementSnippet(stmt, 100))
		}
		return nil
	})
	if streamErr != nil {
		return result, streamErr
	}
	if err := ctx.Err(); err != nil {
		return result, errSQLFileCancelled
	}
	if err := commitTransaction(); err != nil {
		// A commit response can be lost after the server has committed. Retain
		// the ambiguity even when a best-effort rollback succeeds during cleanup.
		result.OutcomeUnknown = true
		discardOnCleanup = true
		return result, fmt.Errorf("single-transaction SQL-file commit failed: %w", err)
	}
	return result, nil
}

func executeSQLFileStream(ctx context.Context, dbInst db.Database, reader io.Reader, options sqlFileExecutionOptions, bytesRead func() int64) (sqlFileExecutionResult, error) {
	options = normalizeSQLFileExecutionOptions(options)
	if options.TransactionMode == sqlFileTransactionModeSingle {
		return executeSQLFileSingleTransactionStream(ctx, dbInst, reader, options, bytesRead)
	}
	var result sqlFileExecutionResult
	var batch []sqlFilePendingStatement
	var batchBytes int
	var lastProgressAt time.Time
	var userTransactionDepth int
	var sqlServerTransaction sqlFileSQLServerTransactionTracker
	var mysqlAutocommitDisabled bool
	var mysqlAutocommitTransactionActive bool
	var mysqlAutocommitStateUnknown bool
	var mysqlTablesLocked bool
	var useTransactionalBatch bool
	safeSequentialContinue := options.ContinueOnError && isSQLFileMySQLCompatibleDialect(options.DBType)
	var hasPinnedSession bool
	execer := sqlFileStatementExecer(dbInst)
	batcher, supportsBatch := dbInst.(sqlFileBatchStatementExecer)
	if capability, ok := dbInst.(db.BatchWriteCapability); ok && !capability.SupportsBatchWrites() {
		supportsBatch = false
		batcher = nil
	}
	if provider, ok := dbInst.(db.SessionExecerProvider); ok && runtimeSupportsSessionExecer(dbInst) {
		sessionExecer, err := provider.OpenSessionExecer(ctx)
		if err != nil {
			return result, err
		}
		defer sessionExecer.Close()
		hasPinnedSession = true
		execer = sessionExecer
		if supportsBatch {
			var ok bool
			batcher, ok = sessionExecer.(sqlFileBatchStatementExecer)
			supportsBatch = ok
		}
		useTransactionalBatch = supportsBatch
	}
	defer func() {
		if userTransactionDepth > 0 || mysqlAutocommitTransactionActive {
			_, _, rollbackSQL, ok := sqlFileBatchTransactionSQL(options.DBType)
			if !ok {
				rollbackSQL = "ROLLBACK"
			}
			if err := rollbackSQLFileTransaction(execer, rollbackSQL); err != nil {
				logger.Warnf("ExecuteSQLFile 未结束事务清理失败，连接已尝试淘汰：type=%s err=%s", options.DBType, sanitizeSQLFileExecutionErr(err))
			}
		}
		if hasPinnedSession {
			if discarder, ok := execer.(db.StatementExecerDiscarter); ok {
				if err := discarder.Discard(); err != nil {
					logger.Warnf("ExecuteSQLFile 淘汰专用会话失败：type=%s err=%s", options.DBType, sanitizeSQLFileExecutionErr(err))
				}
			}
		}
	}()

	readBytes := func() int64 {
		if bytesRead == nil {
			return 0
		}
		return bytesRead()
	}

	emitProgress := func(currentSQL string) {
		if options.OnProgress == nil {
			return
		}
		total := result.Executed + result.Failed
		options.OnProgress(sqlFileExecutionProgress{
			Status:     "running",
			Executed:   result.Executed,
			Failed:     result.Failed,
			Total:      total,
			BytesRead:  readBytes(),
			CurrentSQL: currentSQL,
		})
		lastProgressAt = time.Now()
	}

	shouldEmitProgress := func() bool {
		total := result.Executed + result.Failed
		if total <= 10 {
			return true
		}
		if total%sqlFileProgressStatementInterval == 0 {
			return true
		}
		return !lastProgressAt.IsZero() && time.Since(lastProgressAt) >= sqlFileProgressTimeInterval
	}
	appendErrorDetail := func(detail string) {
		if len(result.Errors) < sqlFileMaxErrorDetails {
			result.Errors = append(result.Errors, detail)
		}
	}

	recordError := func(index int, stmt string, err error) string {
		result.Failed++
		errLog := fileBackendText(options.Text, "file.backend.message.statement_failed", map[string]any{
			"index":  index + 1,
			"detail": sanitizeSQLFileExecutionError(err.Error()),
			"sql":    sqlFileStatementSnippet(stmt, 200),
		})
		appendErrorDetail(errLog)
		if result.Failed <= sqlFileMaxErrorDetails || result.Failed%1000 == 0 {
			logger.Warnf("ExecuteSQLFile %s", errLog)
		}
		return errLog
	}

	executeSingle := func(item sqlFilePendingStatement) (bool, error) {
		if sqlFileMySQLImplicitCommitBeforeStatement(options.DBType, item.SQL) {
			// MySQL-family engines commit the current transaction before attempting
			// these statements. This state transition happens even when the DDL or
			// administrative statement itself subsequently fails.
			userTransactionDepth = 0
			mysqlAutocommitTransactionActive = false
		}
		if ctx.Err() != nil {
			return false, errSQLFileCancelled
		}
		if _, err := execSQLFileStatement(ctx, execer, item.SQL); err != nil {
			unknown := db.IsWriteOutcomeUnknown(err) || db.IsAmbiguousWriteResponse(err)
			if unknown {
				// A lost response must stop the file even in transaction=off
				// continue mode; replaying the statement could duplicate a write.
				result.OutcomeUnknown = true
			}
			if sqlFileStatementFinishesTransaction(item.SQL) {
				// A user-authored COMMIT/ROLLBACK may have reached the server even
				// when its result (including cancellation) was not observed.
				result.OutcomeUnknown = true
			}
			if ctx.Err() != nil {
				result.OutcomeUnknown = true
				return false, errSQLFileCancelled
			}
			errLog := recordError(item.Index, item.SQL, err)
			if unknown {
				if shouldEmitProgress() {
					emitProgress(sqlFileStatementSnippet(item.SQL, 100))
				}
				return false, &sqlFileStoppedOnError{detail: errLog}
			}
			if !options.ContinueOnError {
				if shouldEmitProgress() {
					emitProgress(sqlFileStatementSnippet(item.SQL, 100))
				}
				return false, &sqlFileStoppedOnError{detail: errLog}
			}
			if shouldEmitProgress() {
				emitProgress(sqlFileStatementSnippet(item.SQL, 100))
			}
			return false, nil
		}
		result.Executed++
		if shouldEmitProgress() {
			emitProgress(sqlFileStatementSnippet(item.SQL, 100))
		}
		return true, nil
	}

	executeBatchSequentially := func(items []sqlFilePendingStatement) error {
		for _, item := range items {
			if _, err := executeSingle(item); err != nil {
				return err
			}
		}
		return nil
	}

	var executeIsolationBatch func([]sqlFilePendingStatement) error
	var isolateFailedBatch func([]sqlFilePendingStatement, error) error
	isolateFailedBatch = func(items []sqlFilePendingStatement, observedErr error) error {
		if len(items) == 0 {
			return nil
		}
		if ctx.Err() != nil {
			return errSQLFileCancelled
		}
		if len(items) == 1 {
			recordError(items[0].Index, items[0].SQL, observedErr)
			emitProgress(sqlFileStatementSnippet(items[0].SQL, 100))
			logger.Warnf("ExecuteSQLFile 已定位失败语句，未重复执行：第 %d 条: %s", items[0].Index+1, sanitizeSQLFileExecutionErr(observedErr))
			return nil
		}
		if len(items) <= sqlFileBatchIsolationSequentialThreshold {
			logger.Warnf("ExecuteSQLFile 失败子批已缩小到 %d 条，将逐条定位：第 %d 条起", len(items), items[0].Index+1)
			return executeBatchSequentially(items)
		}

		middle := len(items) / 2
		if err := executeIsolationBatch(items[:middle]); err != nil {
			return err
		}
		return executeIsolationBatch(items[middle:])
	}
	executeIsolationBatch = func(items []sqlFilePendingStatement) error {
		if ctx.Err() != nil {
			return errSQLFileCancelled
		}
		batchSQL := joinSQLFileBatchStatements(items)
		canFallback, outcomeUnknown, err := executeSQLFileBatchWithOutcome(ctx, execer, batcher, options.DBType, batchSQL, useTransactionalBatch, options.Text)
		if outcomeUnknown {
			result.OutcomeUnknown = true
			// Never bisect or replay a batch after a response whose server-side
			// outcome cannot be established.
			if err != nil {
				return errors.New(fileBackendText(options.Text, "file.backend.error.sql_file_batch_execution_failed", map[string]any{
					"index":  items[0].Index + 1,
					"detail": sanitizeSQLFileExecutionErr(err),
				}))
			}
		}
		if err == nil {
			result.Executed += len(items)
			if shouldEmitProgress() {
				emitProgress(sqlFileStatementSnippet(items[len(items)-1].SQL, 100))
			}
			return nil
		}
		if ctx.Err() != nil {
			if !useTransactionalBatch || !canFallback {
				result.OutcomeUnknown = true
			}
			return errSQLFileCancelled
		}
		if !canFallback {
			return errors.New(fileBackendText(options.Text, "file.backend.error.sql_file_batch_execution_failed", map[string]any{
				"index":  items[0].Index + 1,
				"detail": sanitizeSQLFileExecutionErr(err),
			}))
		}
		return isolateFailedBatch(items, err)
	}

	flushBatch := func() error {
		if len(batch) == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return errSQLFileCancelled
		default:
		}

		startIndex := batch[0].Index
		batchSQL := joinSQLFileBatchStatements(batch)
		canFallback, outcomeUnknown, err := executeSQLFileBatchWithOutcome(ctx, execer, batcher, options.DBType, batchSQL, useTransactionalBatch, options.Text)
		if outcomeUnknown {
			result.OutcomeUnknown = true
		}
		if err != nil {
			if ctx.Err() != nil {
				if !useTransactionalBatch || !canFallback {
					result.OutcomeUnknown = true
				}
				return errSQLFileCancelled
			}
			pending := append([]sqlFilePendingStatement(nil), batch...)
			batch = batch[:0]
			batchBytes = 0
			if !canFallback {
				return errors.New(fileBackendText(options.Text, "file.backend.error.sql_file_batch_execution_failed", map[string]any{
					"index":  startIndex + 1,
					"detail": sanitizeSQLFileExecutionErr(err),
				}))
			}
			if !options.ContinueOnError {
				errLog := fileBackendText(options.Text, "file.backend.error.sql_file_batch_execution_failed", map[string]any{
					"index":  startIndex + 1,
					"detail": sanitizeSQLFileExecutionErr(err),
				})
				result.Failed++
				appendErrorDetail(errLog)
				logger.Warnf("ExecuteSQLFile 批量执行失败并已停止，未逐条重放：第 %d 条起，共 %d 条: %s", startIndex+1, len(pending), sanitizeSQLFileExecutionErr(err))
				emitProgress(sqlFileStatementSnippet(pending[0].SQL, 100))
				return &sqlFileStoppedOnError{detail: errLog}
			}
			logger.Warnf("ExecuteSQLFile 批量执行 %d 条语句失败，将自适应拆分定位错误：第 %d 条起: %s", len(pending), startIndex+1, sanitizeSQLFileExecutionErr(err))
			return isolateFailedBatch(pending, err)
		}
		result.Executed += len(batch)
		if shouldEmitProgress() {
			emitProgress(sqlFileStatementSnippet(batch[len(batch)-1].SQL, 100))
		}
		batch = batch[:0]
		batchBytes = 0
		return nil
	}

	_, streamErr := StreamSQLFileWithOptions(reader, SQLStreamOptions{
		DBType:            options.DBType,
		MaxStatementBytes: options.MaxStatementBytes,
	}, func(index int, stmt string) error {
		select {
		case <-ctx.Done():
			return errSQLFileCancelled
		default:
		}

		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			return nil
		}
		if options.PreflightEachStatement {
			preflightResult := PreflightSQLStatement(stmt, options.DBType, index)
			if !preflightResult.Safe && preflightResult.Reason != nil {
				return &sqlFilePreflightRejectedError{
					reason:              *preflightResult.Reason,
					executed:            result.Executed,
					failed:              result.Failed,
					possibleSideEffects: result.Executed > 0 || result.Failed > 0,
					outcomeUnknown:      result.Failed > 0,
				}
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

		if supportsBatch && !safeSequentialContinue && userTransactionDepth == 0 && !mysqlAutocommitDisabled && !mysqlTablesLocked && isSQLFileBatchableWriteStatement(options.DBType, stmt) {
			stmtBytes := len(stmt)
			if len(batch) > 0 && (len(batch) >= options.BatchMaxStatements || batchBytes+2+stmtBytes > options.BatchMaxBytes) {
				if err := flushBatch(); err != nil {
					return err
				}
			}
			if stmtBytes > options.BatchMaxBytes {
				if err := flushBatch(); err != nil {
					return err
				}
				canFallback, outcomeUnknown, err := executeSQLFileBatchWithOutcome(ctx, execer, batcher, options.DBType, stmt, useTransactionalBatch, options.Text)
				if outcomeUnknown {
					result.OutcomeUnknown = true
				}
				if err != nil {
					if ctx.Err() != nil {
						return errSQLFileCancelled
					}
					if !canFallback {
						return errors.New(fileBackendText(options.Text, "file.backend.error.sql_file_statement_execution_failed", map[string]any{
							"index":  index + 1,
							"detail": sanitizeSQLFileExecutionErr(err),
						}))
					}
					// This batch contains exactly one oversized statement. The failed
					// transactional attempt already executed that statement and rolled it
					// back, so calling executeSingle here would repeat the same SQL for no
					// diagnostic value and may duplicate writes on non-transactional tables.
					errLog := recordError(index, stmt, err)
					emitProgress(sqlFileStatementSnippet(stmt, 100))
					if !options.ContinueOnError {
						return &sqlFileStoppedOnError{detail: errLog}
					}
					logger.Warnf("ExecuteSQLFile 超大语句执行失败，已记录并继续，未重复执行：第 %d 条: %s", index+1, sanitizeSQLFileExecutionErr(err))
					return nil
				}
				result.Executed++
				if shouldEmitProgress() {
					emitProgress(sqlFileStatementSnippet(stmt, 100))
				}
				return nil
			}
			batch = appendSQLFileBatchStatement(batch, index, stmt)
			if batchBytes == 0 {
				batchBytes = stmtBytes
			} else {
				batchBytes += 2 + stmtBytes
			}
			return nil
		}

		if err := flushBatch(); err != nil {
			return err
		}
		succeeded, err := executeSingle(sqlFilePendingStatement{Index: index, SQL: stmt})
		if err != nil {
			return err
		}
		if succeeded {
			if normalizeSQLClassifierDBType(options.DBType) == "sqlserver" {
				sqlServerTransaction = updateSQLFileSQLServerTransactionTracker(sqlServerTransaction, stmt)
				userTransactionDepth = sqlServerTransaction.depth
			} else {
				userTransactionDepth = updateSQLFileTransactionDepth(options.DBType, userTransactionDepth, stmt)
			}
			if disabled, known, assigned := sqlFileMySQLAutocommitAssignment(options.DBType, stmt); assigned {
				wasKnownDisabled := mysqlAutocommitDisabled && !mysqlAutocommitStateUnknown
				mysqlAutocommitStateUnknown = !known
				if known {
					mysqlAutocommitDisabled = disabled
				} else {
					// A server-side variable can restore autocommit to either value.
					// Disable batching conservatively and discard this session at EOF.
					mysqlAutocommitDisabled = true
				}
				if known && !disabled {
					mysqlAutocommitTransactionActive = false
					if wasKnownDisabled {
						// In the MySQL family, changing autocommit from 0 to 1
						// commits an active explicit transaction as well.
						userTransactionDepth = 0
					}
				}
			} else if mysqlAutocommitDisabled {
				if mysqlAutocommitTransactionActive {
					mysqlAutocommitTransactionActive = updateSQLFileTransactionState(options.DBType, true, stmt)
				}
				if isBatchableWriteSQLStatement(options.DBType, stmt) {
					mysqlAutocommitTransactionActive = true
				}
			}
			if locksTables, unlocksTables := sqlFileMySQLTableLockCommand(options.DBType, stmt); locksTables {
				mysqlTablesLocked = true
			} else if unlocksTables && mysqlTablesLocked {
				// UNLOCK TABLES commits only when this session actually acquired
				// table locks. The tracked LOCK makes that conditional transition known.
				userTransactionDepth = 0
				mysqlAutocommitTransactionActive = false
				mysqlTablesLocked = false
			}
		}
		return nil
	})
	if streamErr != nil {
		return result, streamErr
	}
	if err := flushBatch(); err != nil {
		return result, err
	}
	if userTransactionDepth > 0 || mysqlAutocommitTransactionActive {
		detail := fileBackendText(options.Text, "file.backend.error.sql_file_unclosed_transaction", nil)
		result.Failed++
		appendErrorDetail(detail)
		return result, &sqlFileStoppedOnError{detail: detail}
	}
	return result, nil
}
