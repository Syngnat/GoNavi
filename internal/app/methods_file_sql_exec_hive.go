package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"GoNavi-Wails/internal/db"
)

func executeHiveSQLFileStream(ctx context.Context, instance db.Database, reader io.Reader, options sqlFileExecutionOptions, bytesRead func() int64) (result sqlFileExecutionResult, runErr error) {
	if options.TransactionMode == sqlFileTransactionModeSingle {
		return result, fmt.Errorf("Hive SQL files do not support client-managed transactions")
	}
	provider, ok := instance.(db.SessionExecerProvider)
	if !ok || !runtimeSupportsSessionExecer(instance) {
		return result, errors.New(fileBackendText(options.Text, "data_import.capability.reason.pinned_session_unavailable", nil))
	}
	session, err := provider.OpenSessionExecer(ctx)
	if err != nil {
		return result, fmt.Errorf("open Hive SQL import session: %w", err)
	}
	defer func() {
		if discarder, ok := session.(db.StatementExecerDiscarter); ok {
			if err := discarder.Discard(); err != nil {
				runErr = errors.Join(runErr, fmt.Errorf("discard Hive SQL import session: %w", err))
			}
		}
		if err := session.Close(); err != nil {
			runErr = errors.Join(runErr, fmt.Errorf("close Hive SQL import session: %w", err))
		}
	}()
	// A pinned session is mandatory for USE, SET and temporary objects. Never
	// concatenate statements or borrow MySQL's BEGIN/FK/rollback machinery.
	runner := hiveSQLFileRunner{ctx: ctx, execer: session, options: options, bytesRead: bytesRead}
	_, err = StreamSQLFileWithOptions(reader, SQLStreamOptions{
		DBType: "hive", MaxStatementBytes: options.MaxStatementBytes,
	}, runner.consume)
	return runner.result, err
}

type hiveSQLFileRunner struct {
	ctx            context.Context
	execer         sqlFileStatementExecer
	options        sqlFileExecutionOptions
	bytesRead      func() int64
	result         sqlFileExecutionResult
	lastProgressAt time.Time
}

func (runner *hiveSQLFileRunner) consume(index int, statement string) error {
	if err := runner.ctx.Err(); err != nil {
		return errSQLFileCancelled
	}
	statement = pinSQLFileImportDatabase("hive", strings.TrimSpace(statement), runner.options.PinDatabase)
	if strings.TrimSpace(statement) == "" {
		return nil
	}
	preflight := PreflightSQLStatement(statement, "hive", index)
	if !preflight.Safe && preflight.Reason != nil {
		return &sqlFilePreflightRejectedError{
			reason: *preflight.Reason, executed: runner.result.Executed, failed: runner.result.Failed,
			possibleSideEffects: runner.result.Executed+runner.result.Failed > 0,
			outcomeUnknown:      runner.result.OutcomeUnknown,
		}
	}
	if guard := runner.options.StatementGuard; guard != nil {
		if err := guard(index, statement); err != nil {
			return err
		}
	}
	if skip := runner.options.SkipStatement; skip != nil && skip(index, statement) {
		return nil
	}
	_, err := execSQLFileStatement(runner.ctx, runner.execer, statement)
	if err == nil {
		runner.result.Executed++
		runner.progress(statement, "")
		return nil
	}
	runner.result.Failed++
	unknown := db.IsWriteOutcomeUnknown(err) || db.IsAmbiguousWriteResponse(err) || runner.ctx.Err() != nil
	runner.result.OutcomeUnknown = runner.result.OutcomeUnknown || unknown
	detail := fileBackendText(runner.options.Text, "file.backend.message.statement_failed", map[string]any{
		"index": index + 1, "detail": sanitizeSQLFileExecutionErr(err), "sql": sqlFileStatementSnippet(statement, 200),
	})
	if len(runner.result.Errors) < sqlFileMaxErrorDetails {
		runner.result.Errors = append(runner.result.Errors, detail)
	}
	runner.progress(statement, detail)
	if runner.ctx.Err() != nil {
		return errSQLFileCancelled
	}
	if unknown || !runner.options.ContinueOnError {
		return &sqlFileStoppedOnError{detail: detail}
	}
	return nil
}

func (runner *hiveSQLFileRunner) progress(statement, detail string) {
	if runner.options.OnProgress == nil {
		return
	}
	total := runner.result.Executed + runner.result.Failed
	if total > 10 && total%sqlFileProgressStatementInterval != 0 && !runner.lastProgressAt.IsZero() && time.Since(runner.lastProgressAt) < sqlFileProgressTimeInterval {
		return
	}
	runner.lastProgressAt = time.Now()
	var bytesRead int64
	if runner.bytesRead != nil {
		bytesRead = runner.bytesRead()
	}
	runner.options.OnProgress(sqlFileExecutionProgress{
		Status: "running", Executed: runner.result.Executed, Failed: runner.result.Failed,
		Total: runner.result.Executed + runner.result.Failed, BytesRead: bytesRead,
		CurrentSQL: sqlFileStatementSnippet(statement, 100), Error: detail,
	})
}
