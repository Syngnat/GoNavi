package app

import (
	"context"
	"errors"
	"fmt"
)

type sqlFileExecutionProgress struct {
	Status     string
	Executed   int
	Failed     int
	Total      int
	BytesRead  int64
	CurrentSQL string
	Error      string
}

type sqlFileExecutionOptions struct {
	DBType                 string
	BatchMaxStatements     int
	BatchMaxBytes          int
	MaxStatementBytes      int64
	ContinueOnError        bool
	PreflightEachStatement bool
	TransactionMode        sqlFileTransactionMode
	StatementGuard         func(index int, stmt string) error
	SkipStatement          func(index int, stmt string) bool
	Text                   fileBackendTextFunc
	OnProgress             func(sqlFileExecutionProgress)
}

type sqlFileTransactionMode string

const (
	sqlFileTransactionModeOff    sqlFileTransactionMode = "off"
	sqlFileTransactionModeSingle sqlFileTransactionMode = "single"
)

type sqlFileExecutionPolicy struct {
	TransactionMode    sqlFileTransactionMode
	ForceFullPreflight bool
	StatementGuard     func(index int, stmt string) error
	SkipStatement      func(index int, stmt string) bool
	MySQLGTIDMode      mysqlGTIDImportMode
}

type sqlFileExecutionResult struct {
	Executed       int
	Failed         int
	Errors         []string
	OutcomeUnknown bool
}

type sqlFilePendingStatement struct {
	Index int
	SQL   string
}

var errSQLFileStoppedOnError = errors.New("sql file execution stopped on error")

type sqlFileCancelledError struct{}

func (sqlFileCancelledError) Error() string { return "已取消" }

func (sqlFileCancelledError) Unwrap() error { return context.Canceled }

var errSQLFileCancelled error = sqlFileCancelledError{}

type sqlFileStoppedOnError struct {
	detail string
}

type sqlFilePreflightRejectedError struct {
	reason              SQLImportPreflightReason
	executed            int
	failed              int
	possibleSideEffects bool
	outcomeUnknown      bool
}

// sqlFilePolicyRejectedError marks a statement guard denial found while the
// source is still being preflighted. The outer runner can then report it as a
// pre-execution failure rather than an open-file error.
type sqlFilePolicyRejectedError struct {
	err error
}

func (err *sqlFilePolicyRejectedError) Error() string {
	if err == nil || err.err == nil {
		return "SQL file execution policy rejected the source"
	}
	return err.err.Error()
}

func (err *sqlFilePolicyRejectedError) Unwrap() error {
	if err == nil {
		return nil
	}
	return err.err
}

func (err *sqlFilePreflightRejectedError) Error() string {
	if err == nil {
		return ""
	}
	reason := string(err.reason.Code)
	if err.reason.Directive != "" {
		reason += ": " + err.reason.Directive
	}
	if !err.possibleSideEffects && err.executed == 0 && err.failed == 0 {
		return fmt.Sprintf("SQL import preflight rejected unsupported client script (%s); no database statement was executed", reason)
	}
	return fmt.Sprintf("SQL import preflight rejected unsupported client script (%s); %d preceding statement(s) may already have completed", reason, err.executed+err.failed)
}

func buildSQLFilePreflightFailurePayload(err *sqlFilePreflightRejectedError) map[string]interface{} {
	executed := 0
	failed := 0
	reason := ""
	directive := ""
	if err != nil {
		executed = err.executed
		failed = err.failed
		reason = string(err.reason.Code)
		directive = err.reason.Directive
	}
	payload := buildSQLFileExecutionPayload(executed, failed, "failed")
	payload["preflightRejected"] = true
	payload["preflightReason"] = reason
	payload["preflightDirective"] = directive
	payload["previousStatementsMayHaveCompleted"] = err != nil && (err.possibleSideEffects || executed > 0 || failed > 0)
	payload["outcomeUnknown"] = err != nil && err.outcomeUnknown
	return payload
}

func isSQLFilePreExecutionValidationError(err error) bool {
	var preflightErr *sqlFilePreflightRejectedError
	var policyErr *sqlFilePolicyRejectedError
	var statementLimitErr *SQLStatementTooLargeError
	var sourceLimitErr *SQLImportSourceLimitError
	return errors.As(err, &preflightErr) || errors.As(err, &policyErr) || errors.As(err, &statementLimitErr) || errors.As(err, &sourceLimitErr)
}

func (e *sqlFileStoppedOnError) Error() string {
	if e == nil {
		return ""
	}
	return e.detail
}

func (e *sqlFileStoppedOnError) Unwrap() error {
	return errSQLFileStoppedOnError
}

type sqlFileStatementExecer interface {
	Exec(query string) (int64, error)
}

type sqlFileContextStatementExecer interface {
	ExecContext(ctx context.Context, query string) (int64, error)
}

type sqlFileBatchStatementExecer interface {
	ExecBatchContext(ctx context.Context, query string) (int64, error)
}
