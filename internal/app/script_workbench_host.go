package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/scriptengine"
	"GoNavi-Wails/internal/sqlparam"
)

type scriptWorkbenchHost struct {
	app      *App
	run      *scriptWorkbenchRun
	prepared *scriptWorkbenchPrepared
	ctx      context.Context

	mu           sync.Mutex
	readers      map[string]*scriptWorkbenchFileReader
	transactions map[string]*scriptWorkbenchTransaction
	closed       bool
}

type scriptWorkbenchFileOpenOptions struct {
	SheetName string `json:"sheetName,omitempty"`
	HeaderRow int    `json:"headerRow,omitempty"`
	BatchSize int    `json:"batchSize,omitempty"`
}

type scriptWorkbenchDBRequest struct {
	Alias    string         `json:"alias"`
	Database string         `json:"database,omitempty"`
	SQL      string         `json:"sql"`
	Params   map[string]any `json:"params,omitempty"`
	MaxRows  int            `json:"maxRows,omitempty"`
}

func newScriptWorkbenchHost(
	app *App,
	run *scriptWorkbenchRun,
	prepared *scriptWorkbenchPrepared,
) *scriptWorkbenchHost {
	return &scriptWorkbenchHost{
		app:          app,
		run:          run,
		prepared:     prepared,
		ctx:          run.ctx,
		readers:      make(map[string]*scriptWorkbenchFileReader),
		transactions: make(map[string]*scriptWorkbenchTransaction),
	}
}

func (h *scriptWorkbenchHost) Handle(ctx context.Context, request scriptengine.HostRequest) (any, error) {
	if h == nil || h.app == nil {
		return nil, errScriptWorkbenchUnavailable
	}
	if ctx == nil {
		ctx = h.ctx
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	switch request.Method {
	case "file.open":
		var payload struct {
			Alias     string `json:"alias"`
			SheetName string `json:"sheetName,omitempty"`
			HeaderRow int    `json:"headerRow,omitempty"`
			BatchSize int    `json:"batchSize,omitempty"`
		}
		if err := decodeScriptHostParams(request.Params, &payload); err != nil {
			return nil, err
		}
		return h.openFile(ctx, payload.Alias, scriptWorkbenchFileOpenOptions{
			SheetName: payload.SheetName,
			HeaderRow: payload.HeaderRow,
			BatchSize: payload.BatchSize,
		})
	case "file.next":
		var payload struct {
			ReaderID string `json:"readerId"`
		}
		if err := decodeScriptHostParams(request.Params, &payload); err != nil {
			return nil, err
		}
		return h.nextFile(payload.ReaderID)
	case "file.close":
		var payload struct {
			ReaderID string `json:"readerId"`
		}
		if err := decodeScriptHostParams(request.Params, &payload); err != nil {
			return nil, err
		}
		h.closeFile(payload.ReaderID)
		return map[string]any{"ok": true}, nil
	case "db.query":
		if err := h.recordDBCall(); err != nil {
			return nil, err
		}
		var payload scriptWorkbenchDBRequest
		if err := decodeScriptHostParams(request.Params, &payload); err != nil {
			return nil, err
		}
		return h.query(ctx, payload)
	case "db.execute":
		if err := h.recordDBCall(); err != nil {
			return nil, err
		}
		var payload scriptWorkbenchDBRequest
		if err := decodeScriptHostParams(request.Params, &payload); err != nil {
			return nil, err
		}
		return h.execute(ctx, payload)
	case "tx.begin", "tx.query", "tx.execute", "tx.commit", "tx.rollback":
		return h.handleTransaction(ctx, request.Method, request.Params)
	default:
		return nil, fmt.Errorf("unsupported script host method %q", request.Method)
	}
}

func (h *scriptWorkbenchHost) query(ctx context.Context, request scriptWorkbenchDBRequest) (scriptengineHostQueryResult, error) {
	prepared, database, sql, _, err := h.prepareConnectionStatement(request)
	if err != nil {
		return scriptengineHostQueryResult{}, err
	}
	if !isReadOnlySQLQuery(prepared.dbType, sql) {
		return scriptengineHostQueryResult{}, errors.New("db.query accepts one read-only statement; use db.execute for writes")
	}
	if err := ensureConnectionAllowsQuery(prepared.config, sql); err != nil {
		return scriptengineHostQueryResult{}, err
	}
	bindings, err := scriptWorkbenchBindings(request.Params, h.prepared.inListLimit)
	if err != nil {
		return scriptengineHostQueryResult{}, err
	}
	maxRows, _ := h.queryRowLimit(request.MaxRows)
	budget := db.RowBudgetOptions{
		MaxRowsPerResult: maxRows,
		MaxTotalRows:     maxRows,
		MaxTotalBytes:    scriptWorkbenchMaxOutputBytes,
		MaxFieldBytes:    8 << 20,
	}
	options := dbQueryMultiAuditOptions{
		auditAll:         true,
		auditWrites:      true,
		source:           "script",
		executionContext: ctx,
		ResultBudget:     &budget,
	}
	var result connection.QueryResult
	if len(bindings) > 0 {
		result = h.app.dbQueryMultiWithParams(
			prepared.config,
			database,
			sql,
			"",
			bindings,
			true,
			options,
		)
	} else {
		result = h.app.dbQueryMulti(prepared.config, database, sql, "", options)
	}
	return convertScriptQueryResult(result, maxRows)
}

func (h *scriptWorkbenchHost) queryRowLimit(requested int) (int, int) {
	maxRows := scriptWorkbenchMaxQueryRows
	defaultRows := scriptWorkbenchDefaultQueryRows
	if h != nil && h.prepared != nil {
		if h.prepared.maxQueryRows > 0 {
			maxRows = h.prepared.maxQueryRows
		}
		if h.prepared.defaultQueryRows > 0 {
			defaultRows = h.prepared.defaultQueryRows
		}
	}
	if defaultRows > maxRows {
		defaultRows = maxRows
	}
	return clampScriptWorkbenchInt(
		requested,
		1,
		maxRows,
		defaultRows,
	), maxRows
}

func (h *scriptWorkbenchHost) execute(ctx context.Context, request scriptWorkbenchDBRequest) (any, error) {
	prepared, database, sql, _, err := h.prepareConnectionStatement(request)
	if err != nil {
		return nil, err
	}
	if err := h.ensureWriteAllowed(prepared, sql); err != nil {
		return nil, err
	}
	bindings, err := scriptWorkbenchBindings(request.Params, h.prepared.inListLimit)
	if err != nil {
		return nil, err
	}
	options := dbQueryMultiAuditOptions{
		auditAll:         true,
		auditWrites:      true,
		source:           "script",
		executionContext: scriptWorkbenchExecuteContext(ctx),
		ResultBudget:     scriptWorkbenchExecuteResultBudget(),
	}
	var result connection.QueryResult
	if len(bindings) > 0 {
		result = h.app.dbQueryMultiWithParams(
			prepared.config,
			database,
			sql,
			"",
			bindings,
			true,
			options,
		)
	} else {
		result = h.app.dbQueryMulti(prepared.config, database, sql, "", options)
	}
	if !result.Success {
		if result.OutcomeUnknown {
			return nil, fmt.Errorf("%s (write outcome is unknown)", result.Message)
		}
		return nil, errors.New(result.Message)
	}
	return map[string]any{"affectedRows": sqlAuditRowsAffected(result)}, nil
}

func scriptWorkbenchExecuteResultBudget() *db.RowBudgetOptions {
	// execute only consumes affected-row metadata. A DML statement with
	// RETURNING/OUTPUT must not be allowed to materialize a full result set in
	// the host process.
	return &db.RowBudgetOptions{
		MaxRowsPerResult: 1,
		MaxTotalRows:     1,
		MaxTotalBytes:    1 << 20,
		MaxFieldBytes:    256 << 10,
	}
}

func scriptWorkbenchExecuteContext(ctx context.Context) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	budget := scriptWorkbenchExecuteResultBudget()
	return db.ContextWithRowBudget(ctx, db.NewRowBudgetWithOptions(*budget))
}

func (h *scriptWorkbenchHost) prepareConnectionStatement(
	request scriptWorkbenchDBRequest,
) (scriptPreparedConnection, string, string, []string, error) {
	alias := strings.TrimSpace(request.Alias)
	if alias == "" {
		return scriptPreparedConnection{}, "", "", nil, errors.New("connection alias is required")
	}
	prepared, exists := h.prepared.connections[alias]
	if !exists {
		return scriptPreparedConnection{}, "", "", nil, fmt.Errorf("connection alias %q is not bound", alias)
	}
	database := strings.TrimSpace(request.Database)
	if database == "" {
		database = prepared.database
	}
	sql := strings.TrimSpace(request.SQL)
	if sql == "" {
		return scriptPreparedConnection{}, "", "", nil, errors.New("SQL is required")
	}
	statements := splitSQLStatementsForDialect(prepared.dbType, sql)
	nonEmpty := make([]string, 0, len(statements))
	for _, statement := range statements {
		if trimmed := strings.TrimSpace(statement); trimmed != "" {
			nonEmpty = append(nonEmpty, trimmed)
		}
	}
	if len(nonEmpty) != 1 {
		return scriptPreparedConnection{}, "", "", nil, fmt.Errorf("script host accepts exactly one SQL statement, got %d", len(nonEmpty))
	}
	if isSQLTransactionControlStatement(nonEmpty[0]) {
		return scriptPreparedConnection{}, "", "", nil, errors.New("script SQL must not contain explicit transaction control or transaction settings")
	}
	return prepared, database, nonEmpty[0], nonEmpty, nil
}

func (h *scriptWorkbenchHost) ensureWriteAllowed(prepared scriptPreparedConnection, sql string) error {
	if h == nil || h.prepared == nil || !h.prepared.allowWrite {
		return errors.New("script writes are disabled for this run; enable write mode explicitly")
	}
	if err := h.ensureExecutionPolicyAllows(sql); err != nil {
		return err
	}
	if prepared.readOnly || isConnectionForcedReadOnly(prepared.config) {
		return errors.New("script writes are disabled by the saved connection protection")
	}
	if isReadOnlySQLQuery(prepared.dbType, sql) {
		return errors.New("db.execute requires a write statement; use db.query for reads")
	}
	if isMetadataAffectingDDL(sql) {
		if err := ensureConnectionAllowsStructureEdit(prepared.config, "script_execute_ddl"); err != nil {
			return err
		}
	} else if err := ensureConnectionAllowsDataEdit(prepared.config, "script_execute_dml"); err != nil {
		return err
	}
	if err := ensureConnectionAllowsQuery(prepared.config, sql); err != nil {
		return err
	}
	return nil
}

func (h *scriptWorkbenchHost) ensureExecutionPolicyAllows(sql string) error {
	if h == nil || h.prepared == nil || h.prepared.executionPolicy == nil {
		return nil
	}
	policy := h.prepared.executionPolicy
	if !policy.AllowWrites {
		return errors.New("script writes are blocked by the current AI safety level")
	}
	if isMetadataAffectingDDL(sql) && !policy.AllowDDL {
		return errors.New("script DDL is blocked by the current AI safety level")
	}
	return nil
}

func (h *scriptWorkbenchHost) recordDBCall() error {
	if h == nil || h.run == nil {
		return errScriptWorkbenchUnavailable
	}
	return h.run.addDBCall()
}

func (h *scriptWorkbenchHost) Close() {
	if h == nil {
		return
	}
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return
	}
	h.closed = true
	readers := make([]*scriptWorkbenchFileReader, 0, len(h.readers))
	for _, reader := range h.readers {
		readers = append(readers, reader)
	}
	h.readers = nil
	transactions := make([]*scriptWorkbenchTransaction, 0, len(h.transactions))
	for _, transaction := range h.transactions {
		transactions = append(transactions, transaction)
	}
	h.transactions = nil
	h.mu.Unlock()
	var readerWG sync.WaitGroup
	for _, reader := range readers {
		if reader == nil {
			continue
		}
		readerWG.Add(1)
		go func(reader *scriptWorkbenchFileReader) {
			defer readerWG.Done()
			reader.Close()
		}(reader)
	}
	var cleanupErr error
	cleanupCtx, cancelCleanup := context.WithTimeout(
		transactionCleanupContext(h.ctx),
		scriptWorkbenchAutoRollbackTimeout,
	)
	defer cancelCleanup()
	for _, transaction := range transactions {
		if err := h.rollbackTransaction(cleanupCtx, transaction); err != nil {
			cleanupErr = errors.Join(cleanupErr, err)
		}
	}
	readerWG.Wait()
	// A legacy TransactionExecer.Commit/Rollback has no context. If its
	// deadline expired, the finalizer is still tracked globally; do not let
	// Host.Close report success while it can still touch the database.
	waitForManagedTransactionFinishes()
	if cleanupErr != nil {
		h.reportTransactionCleanupFailure(cleanupErr)
	}
}

func (h *scriptWorkbenchHost) reportTransactionCleanupFailure(err error) {
	if h == nil || h.run == nil || err == nil {
		return
	}
	message := truncateUTF8Bytes(
		"script transaction cleanup failed: "+err.Error(),
		scriptengine.MaxErrorMessageBytes,
	)
	h.run.appendLog("error", message)
	h.run.mu.Lock()
	if strings.TrimSpace(h.run.err) == "" {
		h.run.err = message
	} else {
		h.run.err = truncateUTF8Bytes(h.run.err+"; "+message, scriptengine.MaxErrorMessageBytes)
	}
	h.run.errorKind = "backend"
	h.run.mu.Unlock()
	h.run.emit("log", map[string]any{"level": "error", "message": message})
}

func decodeScriptHostParams(raw json.RawMessage, target any) error {
	if len(raw) == 0 {
		return errors.New("script host parameters are required")
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return fmt.Errorf("decode script host parameters: %w", err)
	}
	return nil
}

func scriptWorkbenchBindings(params map[string]any, inListLimit int) ([]connection.QueryParamBinding, error) {
	if len(params) == 0 {
		return nil, nil
	}
	names := make([]string, 0, len(params))
	for name := range params {
		if trimmed := strings.TrimSpace(name); trimmed != "" {
			names = append(names, trimmed)
		}
	}
	sort.Strings(names)
	bindings := make([]connection.QueryParamBinding, 0, len(names))
	for _, name := range names {
		value := params[name]
		typ, converted, err := scriptWorkbenchParamType(value, inListLimit)
		if err != nil {
			return nil, fmt.Errorf("parameter %s: %w", name, err)
		}
		bindings = append(bindings, connection.QueryParamBinding{
			Name:  name,
			Type:  typ,
			Value: converted,
		})
	}
	return bindings, nil
}

func scriptWorkbenchParamType(value any, inListLimit int) (string, any, error) {
	switch typed := value.(type) {
	case nil:
		return sqlparam.TypeNull, nil, nil
	case string:
		return sqlparam.TypeString, typed, nil
	case bool:
		return sqlparam.TypeBoolean, typed, nil
	case float64:
		return sqlparam.TypeNumber, typed, nil
	case int:
		return sqlparam.TypeNumber, int64(typed), nil
	case int64:
		return sqlparam.TypeNumber, typed, nil
	case json.Number:
		return sqlparam.TypeNumber, typed.String(), nil
	case []any:
		if len(typed) == 0 {
			return "", nil, sqlparam.ErrEmptyList
		}
		if len(typed) > inListLimit {
			return "", nil, fmt.Errorf("list parameter has %d items, above the %d-item limit", len(typed), inListLimit)
		}
		return sqlparam.TypeList, typed, nil
	default:
		return "", nil, fmt.Errorf("unsupported parameter value type %T", value)
	}
}

type scriptengineHostQueryResult struct {
	Columns   []string         `json:"columns"`
	Rows      []map[string]any `json:"rows"`
	RowCount  int              `json:"rowCount"`
	Truncated bool             `json:"truncated"`
}

func convertScriptQueryResult(result connection.QueryResult, maxRows int) (scriptengineHostQueryResult, error) {
	if !result.Success {
		if result.OutcomeUnknown {
			return scriptengineHostQueryResult{}, fmt.Errorf("%s (query outcome is unknown)", result.Message)
		}
		return scriptengineHostQueryResult{}, errors.New(result.Message)
	}
	sets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		return scriptengineHostQueryResult{}, errors.New("script query returned an unsupported result shape")
	}
	if len(sets) == 0 {
		return scriptengineHostQueryResult{
			Columns: append([]string(nil), result.Fields...),
			Rows:    []map[string]any{},
		}, nil
	}
	set := sets[0]
	rows := set.Rows
	truncated := set.Truncated || result.Truncated
	if len(rows) > maxRows {
		rows = rows[:maxRows]
		truncated = true
	}
	columns := set.Columns
	if len(columns) == 0 {
		columns = result.Fields
	}
	return scriptengineHostQueryResult{
		Columns:   append([]string(nil), columns...),
		Rows:      rows,
		RowCount:  len(rows),
		Truncated: truncated,
	}, nil
}
