package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"

	"github.com/google/uuid"
)

type scriptWorkbenchTransaction struct {
	mu             sync.Mutex
	id             string
	underlyingID   string
	alias          string
	database       string
	poisoned       bool
	poisonReason   string
	outcomeUnknown bool
}

type scriptWorkbenchTransactionRequest struct {
	TransactionID string         `json:"transactionId"`
	SQL           string         `json:"sql,omitempty"`
	Params        map[string]any `json:"params,omitempty"`
}

func (h *scriptWorkbenchHost) handleTransaction(
	ctx context.Context,
	method string,
	raw json.RawMessage,
) (any, error) {
	if err := h.recordDBCall(); err != nil {
		return nil, err
	}
	switch method {
	case "tx.begin":
		var payload struct {
			Alias    string `json:"alias"`
			Database string `json:"database,omitempty"`
		}
		if err := decodeScriptHostParams(raw, &payload); err != nil {
			return nil, err
		}
		return h.beginTransaction(payload.Alias, payload.Database)
	case "tx.query":
		var payload scriptWorkbenchTransactionRequest
		if err := decodeScriptHostParams(raw, &payload); err != nil {
			return nil, err
		}
		return h.queryTransaction(ctx, payload)
	case "tx.execute":
		var payload scriptWorkbenchTransactionRequest
		if err := decodeScriptHostParams(raw, &payload); err != nil {
			return nil, err
		}
		return h.executeTransaction(ctx, payload)
	case "tx.commit":
		var payload scriptWorkbenchTransactionRequest
		if err := decodeScriptHostParams(raw, &payload); err != nil {
			return nil, err
		}
		return h.finishTransaction(ctx, payload.TransactionID, true)
	case "tx.rollback":
		var payload scriptWorkbenchTransactionRequest
		if err := decodeScriptHostParams(raw, &payload); err != nil {
			return nil, err
		}
		return h.finishTransaction(ctx, payload.TransactionID, false)
	default:
		return nil, fmt.Errorf("unsupported transaction method %q", method)
	}
}

func (h *scriptWorkbenchHost) beginTransaction(alias, database string) (map[string]any, error) {
	if h.prepared == nil || !h.prepared.allowWrite {
		return nil, errors.New("script writes are disabled for this run; enable write mode explicitly")
	}
	alias = strings.TrimSpace(alias)
	prepared, exists := h.prepared.connections[alias]
	if !exists {
		return nil, fmt.Errorf("connection alias %q is not bound", alias)
	}
	if prepared.readOnly || isConnectionForcedReadOnly(prepared.config) {
		return nil, errors.New("script writes are disabled by the saved connection protection")
	}
	if isManagedSQLTransactionUnsupportedType(prepared.dbType) {
		return nil, fmt.Errorf("data source %q does not support managed transactions", prepared.dbType)
	}
	database = strings.TrimSpace(database)
	if database == "" {
		database = prepared.database
	}
	transaction := &scriptWorkbenchTransaction{
		id:       "script-tx-" + uuid.NewString(),
		alias:    alias,
		database: database,
	}
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return nil, errors.New("script host is closed")
	}
	if h.transactions == nil {
		h.transactions = make(map[string]*scriptWorkbenchTransaction)
	}
	h.transactions[transaction.id] = transaction
	h.mu.Unlock()
	return map[string]any{"transactionId": transaction.id}, nil
}

func (h *scriptWorkbenchHost) queryTransaction(
	ctx context.Context,
	request scriptWorkbenchTransactionRequest,
) (scriptengineHostQueryResult, error) {
	transaction, prepared, sql, err := h.transactionStatement(request)
	if err != nil {
		return scriptengineHostQueryResult{}, err
	}
	transaction.mu.Lock()
	defer transaction.mu.Unlock()
	if transaction.poisoned {
		return scriptengineHostQueryResult{}, transactionPoisonedError(transaction)
	}
	if transaction.underlyingID == "" {
		return scriptengineHostQueryResult{}, errors.New("the first statement in a managed transaction must be a write")
	}
	if !isReadOnlySQLQuery(prepared.dbType, sql) {
		return scriptengineHostQueryResult{}, errors.New("tx.query accepts one read-only statement; use tx.execute for writes")
	}
	if err := ensureConnectionAllowsQuery(prepared.config, sql); err != nil {
		return scriptengineHostQueryResult{}, err
	}
	bindings, err := scriptWorkbenchBindings(request.Params, h.prepared.inListLimit)
	if err != nil {
		return scriptengineHostQueryResult{}, err
	}
	maxRows, _ := h.queryRowLimit(0)
	budget := db.RowBudgetOptions{
		MaxRowsPerResult: maxRows,
		MaxTotalRows:     maxRows,
		MaxTotalBytes:    scriptWorkbenchMaxOutputBytes,
		MaxFieldBytes:    8 << 20,
	}
	var result connection.QueryResult
	if len(bindings) > 0 {
		result = h.app.dbQueryMultiWithParamsInTransactionSource(
			ctx,
			transaction.underlyingID,
			sql,
			"",
			bindings,
			true,
			&budget,
			"script",
		)
	} else {
		result = h.app.dbQueryMultiInTransactionContext(ctx, transaction.underlyingID, sql, "", &budget)
	}
	converted, queryErr := convertScriptQueryResult(result, maxRows)
	if queryErr != nil {
		transaction.markPoisonedLocked(queryErr.Error(), result.OutcomeUnknown)
	}
	return converted, queryErr
}

func (h *scriptWorkbenchHost) executeTransaction(
	ctx context.Context,
	request scriptWorkbenchTransactionRequest,
) (any, error) {
	transaction, prepared, sql, err := h.transactionStatement(request)
	if err != nil {
		return nil, err
	}
	transaction.mu.Lock()
	defer transaction.mu.Unlock()
	if transaction.poisoned {
		return nil, transactionPoisonedError(transaction)
	}
	if err := h.ensureWriteAllowed(prepared, sql); err != nil {
		return nil, err
	}
	if err := validateManagedTransactionStatement(prepared.dbType, sql); err != nil {
		return nil, err
	}
	bindings, err := scriptWorkbenchBindings(request.Params, h.prepared.inListLimit)
	if err != nil {
		return nil, err
	}
	if transaction.underlyingID == "" {
		started := h.app.dbQueryMultiTransactionalWithBindingsSource(
			ctx,
			prepared.config,
			transaction.database,
			sql,
			"",
			bindings,
			true,
			scriptWorkbenchExecuteResultBudget(),
			"script",
		)
		if underlyingID := strings.TrimSpace(started.TransactionID); underlyingID != "" {
			transaction.underlyingID = underlyingID
		}
		if !started.Success {
			transaction.markPoisonedLocked(started.Message, started.OutcomeUnknown)
			if started.OutcomeUnknown {
				return nil, fmt.Errorf("%s (write outcome is unknown)", started.Message)
			}
			return nil, errors.New(started.Message)
		}
		if strings.TrimSpace(started.TransactionID) == "" {
			message := "the first managed transaction statement completed without a transaction handle"
			transaction.markPoisonedLocked(message, true)
			return nil, errors.New(message)
		}
		return map[string]any{"affectedRows": sqlAuditRowsAffected(started)}, nil
	}
	var result connection.QueryResult
	if len(bindings) > 0 {
		result = h.app.dbQueryMultiWithParamsInTransactionSource(
			ctx,
			transaction.underlyingID,
			sql,
			"",
			bindings,
			true,
			scriptWorkbenchExecuteResultBudget(),
			"script",
		)
	} else {
		result = h.app.dbQueryMultiInTransactionContext(
			ctx,
			transaction.underlyingID,
			sql,
			"",
			scriptWorkbenchExecuteResultBudget(),
		)
	}
	if !result.Success {
		transaction.markPoisonedLocked(result.Message, result.OutcomeUnknown)
		if result.OutcomeUnknown {
			return nil, fmt.Errorf("%s (write outcome is unknown)", result.Message)
		}
		return nil, errors.New(result.Message)
	}
	return map[string]any{"affectedRows": sqlAuditRowsAffected(result)}, nil
}

func (h *scriptWorkbenchHost) transactionStatement(
	request scriptWorkbenchTransactionRequest,
) (*scriptWorkbenchTransaction, scriptPreparedConnection, string, error) {
	transactionID := strings.TrimSpace(request.TransactionID)
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return nil, scriptPreparedConnection{}, "", errors.New("script host is closed")
	}
	transaction := h.transactions[transactionID]
	h.mu.Unlock()
	if transaction == nil {
		return nil, scriptPreparedConnection{}, "", errors.New("script transaction not found")
	}
	prepared, exists := h.prepared.connections[transaction.alias]
	if !exists {
		return nil, scriptPreparedConnection{}, "", fmt.Errorf("connection alias %q is no longer bound", transaction.alias)
	}
	sql := strings.TrimSpace(request.SQL)
	if sql == "" {
		return nil, scriptPreparedConnection{}, "", errors.New("SQL is required")
	}
	statements := splitSQLStatementsForDialect(prepared.dbType, sql)
	nonEmpty := make([]string, 0, len(statements))
	for _, statement := range statements {
		if trimmed := strings.TrimSpace(statement); trimmed != "" {
			nonEmpty = append(nonEmpty, trimmed)
		}
	}
	if len(nonEmpty) != 1 {
		return nil, scriptPreparedConnection{}, "", fmt.Errorf("script transaction accepts exactly one SQL statement, got %d", len(nonEmpty))
	}
	if isSQLTransactionControlStatement(nonEmpty[0]) {
		return nil, scriptPreparedConnection{}, "", errors.New("managed transaction SQL must not contain explicit transaction control or transaction settings")
	}
	return transaction, prepared, nonEmpty[0], nil
}

func validateManagedTransactionStatement(dbType, sql string) error {
	if isManagedSQLTransactionUnsupportedType(dbType) {
		return fmt.Errorf("data source %q does not support managed transactions", dbType)
	}
	if shouldUseManagedSQLTransaction(dbType, sql) {
		return nil
	}
	if isMetadataAffectingDDL(sql) {
		return errors.New("managed transactions do not support DDL because it may commit the active transaction")
	}
	return errors.New("statement is not supported inside a managed transaction")
}

func transactionPoisonedError(transaction *scriptWorkbenchTransaction) error {
	reason := "a previous statement failed"
	if transaction != nil && strings.TrimSpace(transaction.poisonReason) != "" {
		reason = transaction.poisonReason
	}
	if transaction != nil && transaction.outcomeUnknown {
		return fmt.Errorf("transaction is unusable after an outcome-unknown failure and must be rolled back: %s", reason)
	}
	return fmt.Errorf("transaction is unusable after a failed statement and must be rolled back: %s", reason)
}

func (transaction *scriptWorkbenchTransaction) markPoisonedLocked(reason string, outcomeUnknown bool) {
	if transaction == nil {
		return
	}
	transaction.poisoned = true
	transaction.poisonReason = strings.TrimSpace(reason)
	transaction.outcomeUnknown = outcomeUnknown
}

func (h *scriptWorkbenchHost) finishTransaction(
	ctx context.Context,
	transactionID string,
	commit bool,
) (map[string]any, error) {
	transactionID = strings.TrimSpace(transactionID)
	if ctx == nil {
		ctx = context.Background()
	}
	if commit {
		if err := ctx.Err(); err != nil {
			return nil, fmt.Errorf("transaction commit was not attempted: %w", err)
		}
	}
	h.mu.Lock()
	transaction := h.transactions[transactionID]
	delete(h.transactions, transactionID)
	h.mu.Unlock()
	if transaction == nil {
		return nil, errors.New("script transaction not found")
	}
	transaction.mu.Lock()
	defer transaction.mu.Unlock()

	if transaction.poisoned {
		if transaction.underlyingID == "" {
			return nil, fmt.Errorf("%s; no database transaction was started", transactionPoisonedError(transaction))
		}
		rollbackErr := h.finishUnderlyingTransaction(
			transactionCleanupContext(ctx),
			transaction.underlyingID,
			false,
			"auto",
		)
		transaction.underlyingID = ""
		if rollbackErr != nil {
			return nil, fmt.Errorf("%s; automatic rollback failed: %v", transactionPoisonedError(transaction), rollbackErr)
		}
		if commit {
			return nil, fmt.Errorf("%s; the transaction was rolled back instead", transactionPoisonedError(transaction))
		}
		return map[string]any{"rolledBack": true, "recoveredFromFailure": true}, nil
	}
	if transaction.underlyingID == "" {
		action := "commit"
		if !commit {
			action = "rollback"
		}
		return nil, fmt.Errorf("transaction %s was not started; no %s was sent to the database", transactionID, action)
	}

	finishCtx := ctx
	if !commit {
		finishCtx = transactionCleanupContext(ctx)
	}
	trigger := "manual"
	if err := h.finishUnderlyingTransaction(finishCtx, transaction.underlyingID, commit, trigger); err != nil {
		transaction.underlyingID = ""
		return nil, err
	}
	transaction.underlyingID = ""
	if commit {
		return map[string]any{"committed": true}, nil
	}
	return map[string]any{"rolledBack": true}, nil
}

func transactionCleanupContext(ctx context.Context) context.Context {
	if ctx == nil {
		return context.Background()
	}
	return context.WithoutCancel(ctx)
}

func (h *scriptWorkbenchHost) finishUnderlyingTransaction(
	ctx context.Context,
	transactionID string,
	commit bool,
	trigger string,
) error {
	if h == nil || h.app == nil {
		return errScriptWorkbenchUnavailable
	}
	transactionID = strings.TrimSpace(transactionID)
	if transactionID == "" {
		return errors.New("transaction ID is required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		timeoutErr := fmt.Errorf("transaction finish was not attempted: %w", err)
		h.reportTransactionCleanupFailure(timeoutErr)
		return timeoutErr
	}
	timeout := sqlEditorTransactionFinishTimeout
	if trigger == "auto" {
		timeout = scriptWorkbenchAutoRollbackTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	resultCh := make(chan connection.QueryResult, 1)
	_, finish := registerManagedTransactionFinish()
	go func() {
		defer finish()
		resultCh <- h.app.finishManagedSQLTransactionContext(ctx, transactionID, commit, trigger)
	}()
	select {
	case result := <-resultCh:
		if result.Success {
			return nil
		}
		if result.OutcomeUnknown {
			outcomeErr := fmt.Errorf("%s (transaction outcome is unknown; do not retry automatically)", result.Message)
			h.reportTransactionCleanupFailure(outcomeErr)
			return outcomeErr
		}
		finishErr := errors.New(result.Message)
		h.reportTransactionCleanupFailure(finishErr)
		return finishErr
	case <-ctx.Done():
		timeoutErr := fmt.Errorf("transaction finish did not complete before the deadline: %w; outcome is unknown", ctx.Err())
		h.reportTransactionCleanupFailure(timeoutErr)
		return timeoutErr
	}
}

// Keep automatic cleanup inside the application's five-second shutdown window.
const scriptWorkbenchAutoRollbackTimeout = 4 * time.Second

func (h *scriptWorkbenchHost) rollbackTransaction(
	ctx context.Context,
	transaction *scriptWorkbenchTransaction,
) error {
	if h == nil || transaction == nil {
		return nil
	}
	transaction.mu.Lock()
	defer transaction.mu.Unlock()
	if transaction.underlyingID == "" {
		return nil
	}
	if ctx == nil {
		ctx = transactionCleanupContext(h.ctx)
	}
	err := h.finishUnderlyingTransaction(ctx, transaction.underlyingID, false, "auto")
	transaction.underlyingID = ""
	return err
}
