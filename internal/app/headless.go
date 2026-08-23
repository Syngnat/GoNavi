package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/sqlaudit"
)

// HeadlessRuntimeOptions configures the narrow runtime used by command-line
// callers. An empty DataRoot follows the normal GoNavi root resolution rules.
type HeadlessRuntimeOptions struct {
	DataRoot string
}

// HeadlessQueryOptions contains the explicit policy acknowledgement required
// before a command-line query may contain mutating statements.
type HeadlessQueryOptions struct {
	AllowMutating bool
}

const (
	headlessResultErrorKindPolicy     = "policy"
	headlessResultErrorKindConnection = "connection"
)

func headlessPolicyFailure(err error) connection.QueryResult {
	message := "headless SQL policy denied the request"
	if err != nil {
		message = err.Error()
	}
	return connection.QueryResult{
		Success: false,
		Message: message,
		Data:    map[string]any{"errorKind": headlessResultErrorKindPolicy},
	}
}

func headlessConnectionFailure(err error) connection.QueryResult {
	message := "headless database connection failed"
	if err != nil {
		message = err.Error()
	}
	data := map[string]any{"errorKind": headlessResultErrorKindConnection}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		data["cancelled"] = true
	}
	return connection.QueryResult{
		Success: false,
		Message: message,
		Data:    data,
	}
}

// HeadlessSQLTransactionMode controls how a CLI SQL file is applied. The
// default is single so a batch is rejected unless its atomicity can be proven.
type HeadlessSQLTransactionMode string

const (
	HeadlessSQLTransactionModeSingle HeadlessSQLTransactionMode = "single"
	HeadlessSQLTransactionModeOff    HeadlessSQLTransactionMode = "off"
)

// HeadlessSQLFileOptions controls a streaming SQL-file execution.
type HeadlessSQLFileOptions struct {
	AllowMutating    bool
	ContinueOnError  bool
	TransactionMode  HeadlessSQLTransactionMode
	JobID            string
	MaxStatementSize int64
}

// AmbiguousConnectionNameError tells a command-line caller to retry with one
// of the stable connection IDs instead of guessing which matching name to use.
type AmbiguousConnectionNameError struct {
	Name string
	IDs  []string
}

func (err *AmbiguousConnectionNameError) Error() string {
	if err == nil {
		return "connection name is ambiguous"
	}
	return fmt.Sprintf("connection name %q is ambiguous; use one of: %s", err.Name, strings.Join(err.IDs, ", "))
}

// HeadlessRuntime owns only the backend resources needed for CLI work. It
// deliberately does not start Wails, connection keep-alives, cloud backup, or
// data-sync schedulers.
type HeadlessRuntime struct {
	app      *App
	executor *CLIQueryExecutor
}

func NewHeadlessRuntime(ctx context.Context, options HeadlessRuntimeOptions) (*HeadlessRuntime, error) {
	if ctx == nil {
		ctx = context.Background()
	}

	root := strings.TrimSpace(options.DataRoot)
	var err error
	if root == "" {
		root, err = appdata.ResolveActiveRoot()
	} else {
		root, err = appdata.ResolveRoot(root)
	}
	if err != nil {
		return nil, err
	}
	a, err := NewHeadlessApp(ctx, root)
	if err != nil {
		return nil, err
	}

	return &HeadlessRuntime{app: a, executor: NewCLIQueryExecutor(a)}, nil
}

func (runtime *HeadlessRuntime) Close() {
	if runtime == nil || runtime.app == nil {
		return
	}
	runtime.app.Shutdown()
}

func (runtime *HeadlessRuntime) GetSavedConnections() ([]connection.SavedConnectionView, error) {
	if runtime == nil || runtime.app == nil {
		return nil, errors.New("headless runtime is unavailable")
	}
	return runtime.app.GetSavedConnections()
}

// GetRequestDiagnostic returns the process-local, redacted trace for a CLI
// request. It intentionally shares the desktop retention boundary and never
// writes diagnostic data to the connection store.
func (runtime *HeadlessRuntime) GetRequestDiagnostic(requestID string) connection.QueryResult {
	if runtime == nil || runtime.app == nil {
		return connection.QueryResult{Success: false, Message: "headless runtime is unavailable"}
	}
	return runtime.app.GetRequestDiagnostic(requestID)
}

func (runtime *HeadlessRuntime) SaveConnection(input connection.SavedConnectionInput) (connection.SavedConnectionView, error) {
	if runtime == nil || runtime.app == nil {
		return connection.SavedConnectionView{}, errors.New("headless runtime is unavailable")
	}
	return runtime.app.SaveConnection(input)
}

func (runtime *HeadlessRuntime) ImportLegacyConnections(items []connection.LegacySavedConnection) ([]connection.SavedConnectionView, error) {
	if runtime == nil || runtime.app == nil {
		return nil, errors.New("headless runtime is unavailable")
	}
	return runtime.app.ImportLegacyConnections(items)
}

// ResolveSavedConnection accepts a stable ID first, then an exact unique name.
// It never resolves or returns the stored secret bundle.
func (runtime *HeadlessRuntime) ResolveSavedConnection(selector string) (connection.SavedConnectionView, error) {
	selector = strings.TrimSpace(selector)
	if selector == "" {
		return connection.SavedConnectionView{}, errors.New("connection selector is required")
	}
	connections, err := runtime.GetSavedConnections()
	if err != nil {
		return connection.SavedConnectionView{}, err
	}
	for _, item := range connections {
		if item.ID == selector {
			item.Config.ID = item.ID
			return item, nil
		}
	}

	matches := make([]connection.SavedConnectionView, 0, 1)
	for _, item := range connections {
		if item.Name == selector {
			matches = append(matches, item)
		}
	}
	switch len(matches) {
	case 0:
		return connection.SavedConnectionView{}, fmt.Errorf("saved connection not found: %s", selector)
	case 1:
		matches[0].Config.ID = matches[0].ID
		return matches[0], nil
	default:
		ids := make([]string, 0, len(matches))
		for _, item := range matches {
			ids = append(ids, item.ID)
		}
		return connection.SavedConnectionView{}, &AmbiguousConnectionNameError{Name: selector, IDs: ids}
	}
}

func (runtime *HeadlessRuntime) InspectSQL(config connection.ConnectionConfig, sql string) SQLInspection {
	return InspectSQL(resolveDDLDBType(config), sql)
}

func (runtime *HeadlessRuntime) Query(ctx context.Context, config connection.ConnectionConfig, dbName string, sql string, options HeadlessQueryOptions) (result connection.QueryResult) {
	if runtime == nil || runtime.app == nil || runtime.executor == nil {
		return connection.QueryResult{Success: false, Message: "headless runtime is unavailable"}
	}
	sql = strings.TrimSpace(sql)
	if sql == "" {
		return connection.QueryResult{Success: false, Message: "SQL is required"}
	}
	queryID := runtime.app.GenerateQueryID()
	traceCtx, requestTrace, ownsRequestTrace := runtime.app.beginQueryRequestTrace(
		ctx,
		config,
		queryID,
		"cli",
		"cli.query",
	)
	if ownsRequestTrace {
		defer func() {
			if result.QueryID == "" {
				result.QueryID = queryID
			}
			runtime.app.completeQueryRequestTrace(requestTrace, result)
		}()
	}
	requestTrace.AddEvent("cli.command.accepted", nil)
	var err error
	config, err = runtime.app.resolveConnectionSecrets(config)
	if err != nil {
		return headlessConnectionFailure(err)
	}
	if err := runtime.authorizeHeadlessSQL(config, sql, options.AllowMutating, false); err != nil {
		return headlessPolicyFailure(err)
	}
	return runtime.executor.DBQueryMulti(traceCtx, config, dbName, sql, queryID)
}

// ExportQueryToPath performs a SELECT/WITH export without any desktop dialog.
// The temporary file is synced and atomically replaced only after the query and
// writer have both completed successfully.
func (runtime *HeadlessRuntime) ExportQueryToPath(ctx context.Context, config connection.ConnectionConfig, dbName string, sql string, filePath string, options ExportFileOptions, overwrite bool) (result connection.QueryResult) {
	if runtime == nil || runtime.app == nil {
		return connection.QueryResult{Success: false, Message: "headless runtime is unavailable"}
	}
	if ctx == nil {
		ctx = context.Background()
	}
	queryID := runtime.app.GenerateQueryID()
	traceCtx, requestTrace, ownsRequestTrace := runtime.app.beginQueryRequestTrace(
		ctx,
		config,
		queryID,
		"cli",
		"cli.export",
	)
	ctx = traceCtx
	if ownsRequestTrace {
		defer func() {
			if result.QueryID == "" {
				result.QueryID = queryID
			}
			runtime.app.completeQueryRequestTrace(requestTrace, result)
		}()
	}
	requestTrace.AddEvent("export.accepted", nil)
	sql = strings.TrimSpace(sql)
	options = normalizeExportFileOptions("", options)
	if sql == "" {
		return connection.QueryResult{Success: false, Message: runtime.app.appText("file.backend.error.query_required", nil)}
	}
	config, err := runtime.app.resolveConnectionSecrets(config)
	if err != nil {
		return headlessConnectionFailure(err)
	}
	inspection := runtime.InspectSQL(config, sql)
	if !looksLikeSelectOrWith(sql) || inspection.StatementCount != 1 || !inspection.ReadOnly {
		return headlessPolicyFailure(errors.New(runtime.app.appText("file.backend.error.select_with_query_required", nil)))
	}
	if err := validateExportColumnsSelection(options); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if options.Format == "" {
		return connection.QueryResult{Success: false, Message: "export format is required"}
	}
	if options.Format != "sql" {
		if err := verifyOptionalDriverAgentReadyForExport(config); err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}
	target, err := resolveHeadlessExportTarget(filePath, options.Format, overwrite)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := ctx.Err(); err != nil {
		return buildQueryExecutionFailure(ctx, err, err.Error(), "")
	}

	runConfig := normalizeRunConfig(config, dbName)
	startedAt := time.Now()
	defer func() {
		result.QueryID = queryID
		runtime.app.recordSQLAuditQuery(sqlAuditQueryInput{
			Config:     runConfig,
			Database:   dbName,
			DBType:     resolveDDLDBType(runConfig),
			QueryID:    queryID,
			SQL:        sql,
			Source:     "cli",
			CommitMode: "auto",
			Duration:   time.Since(startedAt),
			Result:     result,
		})
	}()

	requestTrace.AddEvent("driver.dispatched", nil)
	dbInst, err := runtime.app.getDatabaseWithContext(ctx, runConfig, false)
	if err != nil {
		return headlessConnectionFailure(err)
	}

	directory := filepath.Dir(target)
	temporary, err := os.CreateTemp(directory, ".gonavi-export-*.tmp")
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	temporaryPath := temporary.Name()
	cleanupTemporary := true
	defer func() {
		if temporary != nil {
			_ = temporary.Close()
		}
		if cleanupTemporary {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	rows, columns, err := exportQueryResultToFileWithContext(ctx, temporary, dbInst, runConfig, sql, options, nil)
	if err != nil {
		return buildQueryExecutionFailure(ctx, err, err.Error(), queryID)
	}
	if err := temporary.Sync(); err != nil {
		return buildQueryExecutionFailure(ctx, err, err.Error(), queryID)
	}
	if err := closeExportFile(temporary); err != nil {
		return buildQueryExecutionFailure(ctx, err, err.Error(), queryID)
	}
	temporary = nil
	publish := atomicReplaceSQLAuditFile
	if !overwrite {
		publish = atomicCreateSQLAuditFile
	}
	if err := publish(temporaryPath, target); err != nil {
		return buildQueryExecutionFailure(ctx, err, err.Error(), queryID)
	}
	cleanupTemporary = false
	return connection.QueryResult{
		Success: true,
		Data: map[string]any{
			"path":    target,
			"rows":    rows,
			"columns": columns,
		},
	}
}

func (runtime *HeadlessRuntime) ExecuteSQLFile(ctx context.Context, config connection.ConnectionConfig, dbName string, filePath string, options HeadlessSQLFileOptions) (result connection.QueryResult) {
	if runtime == nil || runtime.app == nil {
		return connection.QueryResult{Success: false, Message: "headless runtime is unavailable"}
	}
	queryID := runtime.app.GenerateQueryID()
	traceCtx, requestTrace, ownsRequestTrace := runtime.app.beginQueryRequestTrace(
		ctx,
		config,
		queryID,
		"cli",
		"cli.batch",
	)
	ctx = traceCtx
	if ownsRequestTrace {
		defer func() {
			if result.QueryID == "" {
				result.QueryID = queryID
			}
			runtime.app.completeQueryRequestTrace(requestTrace, result)
		}()
	}
	requestTrace.AddEvent("batch.accepted", nil)
	transactionMode, err := normalizeHeadlessSQLTransactionMode(options.TransactionMode)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if !options.AllowMutating {
		return headlessPolicyFailure(errors.New("SQL-file execution requires --allow-write"))
	}
	config, err = runtime.app.resolveConnectionSecrets(config)
	if err != nil {
		return headlessConnectionFailure(err)
	}
	if transactionMode == HeadlessSQLTransactionModeSingle && !isSQLFileSingleTransactionDialectSupported(resolveDDLDBType(config)) {
		return headlessPolicyFailure(errors.New("single-transaction SQL-file execution cannot prove atomicity for this database type; use --transaction=off"))
	}
	if options.ContinueOnError && transactionMode != HeadlessSQLTransactionModeOff {
		return connection.QueryResult{Success: false, Message: "--continue-on-error requires --transaction=off"}
	}
	for _, protection := range []connectionProtectionKey{
		connectionProtectionScriptExecution,
		connectionProtectionDataImport,
	} {
		if err := ensureConnectionAllowsActionWithText(
			config,
			protection,
			"connection.backend.action.import_data",
			runtime.app.appText,
		); err != nil {
			return headlessPolicyFailure(err)
		}
	}
	safetyLevel := runtime.GetSQLSafetyLevel()
	statementGuard := func(_ int, statement string) error {
		if err := runtime.authorizeHeadlessSQLAtSafetyLevel(config, statement, true, false, safetyLevel); err != nil {
			return err
		}
		if transactionMode == HeadlessSQLTransactionModeSingle {
			if err := validateSQLFileSingleTransactionStatement(resolveDDLDBType(config), statement); err != nil {
				return &HeadlessSQLPolicyError{Message: err.Error()}
			}
		}
		return nil
	}
	requestTrace.AddEvent("driver.dispatched", nil)
	return runtime.app.executeSQLFileWithStatementLimitPolicyContextWithPolicy(
		ctx,
		config,
		dbName,
		filePath,
		options.JobID,
		options.ContinueOnError,
		options.MaxStatementSize,
		false,
		"cli",
		sqlFileExecutionPolicy{
			TransactionMode: sqlFileTransactionMode(transactionMode),
			// Headless policy must reject every disallowed statement before the
			// database is opened, including when transaction mode is off.
			ForceFullPreflight: true,
			StatementGuard:     statementGuard,
		},
	)
}

func normalizeHeadlessSQLTransactionMode(mode HeadlessSQLTransactionMode) (HeadlessSQLTransactionMode, error) {
	switch HeadlessSQLTransactionMode(strings.ToLower(strings.TrimSpace(string(mode)))) {
	case "", HeadlessSQLTransactionModeSingle:
		return HeadlessSQLTransactionModeSingle, nil
	case HeadlessSQLTransactionModeOff:
		return HeadlessSQLTransactionModeOff, nil
	default:
		return "", fmt.Errorf("unsupported SQL-file transaction mode %q", mode)
	}
}

func (runtime *HeadlessRuntime) ExportSQLAuditToPath(filter sqlaudit.Filter, format string, filePath string, overwrite bool) connection.QueryResult {
	if runtime == nil || runtime.app == nil {
		return connection.QueryResult{Success: false, Message: "headless runtime is unavailable"}
	}
	content, normalizedFormat, err := runtime.app.buildSQLAuditExport(filter, format)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	target, err := resolveHeadlessExportTarget(filePath, normalizedFormat, overwrite)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := runtime.app.validateSQLAuditExportTarget(target); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	var writeErr error
	if overwrite {
		writeErr = writeSQLAuditExportAtomically(target, content)
	} else {
		writeErr = writeSQLAuditExportAtomicallyNoReplace(target, content)
	}
	if err := writeErr; err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: map[string]string{"path": target}}
}

func resolveHeadlessExportTarget(filePath string, format string, overwrite bool) (string, error) {
	target := normalizeExportTargetPath(filePath, format)
	if target == "" {
		return "", errors.New("output file path is required")
	}
	if info, err := os.Stat(target); err == nil {
		if info.IsDir() {
			return "", fmt.Errorf("output path is a directory: %s", target)
		}
		if !overwrite {
			return "", fmt.Errorf("output file already exists: %s (use --force to replace it)", target)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	return target, nil
}
