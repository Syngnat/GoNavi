// Package cli implements the standalone GoNavi command-line interface.
package cli

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"

	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/mcpserver"
	"GoNavi-Wails/internal/sqlaudit"
)

const (
	ExitSuccess        = 0
	ExitUsage          = 2
	ExitConnection     = 3
	ExitPolicyDenied   = 4
	ExitExecution      = 5
	ExitCancelled      = 6
	ExitUnknownOutcome = 7
)

// Version is set by release builds with -ldflags.
var Version = "dev"

type globalOptions struct {
	dataRoot string
}

var (
	errConnectionSourceConflict = errors.New("use either --conn or --connection-file")
	errConnectionSourceMissing  = errors.New("one of --conn or --connection-file is required")

	runMCPStdioServer = mcpserver.RunAppStdioServer
	runMCPHTTPServer  = mcpserver.RunAppStreamableHTTPServer
)

// backend is intentionally small: command parsing does not need access to the
// desktop App or to any connection secret material.
type backend interface {
	Close()
	GetSavedConnections() ([]connection.SavedConnectionView, error)
	SaveConnection(connection.SavedConnectionInput) (connection.SavedConnectionView, error)
	ImportLegacyConnections([]connection.LegacySavedConnection) ([]connection.SavedConnectionView, error)
	ResolveSavedConnection(string) (connection.SavedConnectionView, error)
	Query(context.Context, connection.ConnectionConfig, string, string, appcore.HeadlessQueryOptions) connection.QueryResult
	ExportQueryToPath(context.Context, connection.ConnectionConfig, string, string, string, appcore.ExportFileOptions, bool) connection.QueryResult
	ExecuteSQLFile(context.Context, connection.ConnectionConfig, string, string, appcore.HeadlessSQLFileOptions) connection.QueryResult
	ExportSQLAuditToPath(sqlaudit.Filter, string, string, bool) connection.QueryResult
}

// requestDiagnosticBackend is deliberately optional so the CLI's narrow
// command backend remains compatible with integrations that do not retain
// local request traces.
type requestDiagnosticBackend interface {
	GetRequestDiagnostic(string) connection.QueryResult
}

var newBackend = func(ctx context.Context, options appcore.HeadlessRuntimeOptions) (backend, error) {
	return appcore.NewHeadlessRuntime(ctx, options)
}

type errorReport struct {
	OK      bool   `json:"ok"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type jsonlResultSetEvent struct {
	Type      string   `json:"type"`
	ResultSet int      `json:"resultSet"`
	Columns   []string `json:"columns"`
	RowCount  int      `json:"rowCount"`
}

type jsonlRowEvent struct {
	Type      string         `json:"type"`
	ResultSet int            `json:"resultSet"`
	Data      map[string]any `json:"data"`
}

type jsonlSummaryEvent struct {
	Type       string   `json:"type"`
	Success    bool     `json:"success"`
	QueryID    string   `json:"queryId,omitempty"`
	Message    string   `json:"message,omitempty"`
	Messages   []string `json:"messages,omitempty"`
	Data       any      `json:"data,omitempty"`
	ResultSets int      `json:"resultSets"`
	Rows       int      `json:"rows"`
}

// Run executes one CLI invocation. Successful command data is written to
// stdout; machine-readable diagnostics are written to stderr.
func Run(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer) int {
	if ctx == nil {
		ctx = context.Background()
	}
	if stdout == nil {
		stdout = io.Discard
	}
	if stderr == nil {
		stderr = io.Discard
	}
	if isVersionInvocation(args) {
		return emitOutput(stdout, stderr, map[string]string{"version": Version})
	}

	options, remaining, showHelp, err := parseGlobalOptions(args)
	if err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	if showHelp {
		writeRootUsage(stdout)
		return ExitSuccess
	}
	if len(remaining) == 0 {
		writeRootUsage(stderr)
		return ExitUsage
	}

	restoreDataRoot, err := applyDataRootOverride(options.dataRoot)
	if err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	defer restoreDataRoot()

	command := strings.ToLower(strings.TrimSpace(remaining[0]))
	commandArgs := remaining[1:]
	switch command {
	case "help", "--help", "-h":
		writeRootUsage(stdout)
		return ExitSuccess
	case "version", "--version", "-version":
		if len(commandArgs) != 0 {
			return fail(stderr, ExitUsage, "usage", errors.New("version does not accept arguments"))
		}
		return emitOutput(stdout, stderr, map[string]string{"version": Version})
	case "mcp":
		return runMCP(ctx, commandArgs, stdout, stderr)
	case "list-connections", "connections":
		if commandHelpRequested(command, commandArgs) {
			return runListConnections(commandArgs, nil, stdout, stderr)
		}
		return withBackend(ctx, options, stderr, func(runtime backend) int {
			return runListConnections(commandArgs, runtime, stdout, stderr)
		})
	case "connection":
		if commandHelpRequested(command, commandArgs) {
			return runConnection(commandArgs, nil, stdout, stderr)
		}
		return withBackend(ctx, options, stderr, func(runtime backend) int {
			return runConnection(commandArgs, runtime, stdout, stderr)
		})
	case "query":
		if commandHelpRequested(command, commandArgs) {
			return runQuery(ctx, commandArgs, nil, stdout, stderr)
		}
		return withBackend(ctx, options, stderr, func(runtime backend) int {
			return runQuery(ctx, commandArgs, runtime, stdout, stderr)
		})
	case "export":
		if commandHelpRequested(command, commandArgs) {
			return runExport(ctx, commandArgs, nil, stdout, stderr)
		}
		return withBackend(ctx, options, stderr, func(runtime backend) int {
			return runExport(ctx, commandArgs, runtime, stdout, stderr)
		})
	case "batch", "exec-file":
		if commandHelpRequested(command, commandArgs) {
			return runBatch(ctx, commandArgs, nil, stdout, stderr)
		}
		return withBackend(ctx, options, stderr, func(runtime backend) int {
			return runBatch(ctx, commandArgs, runtime, stdout, stderr)
		})
	case "audit":
		// Validate the subcommand before starting the headless runtime. A bare
		// `audit` and unknown subcommands are usage errors, while explicit help
		// remains available without loading configuration or drivers.
		if len(commandArgs) == 0 || commandHelpRequested(command, commandArgs) || !strings.EqualFold(strings.TrimSpace(commandArgs[0]), "export") {
			return runAudit(commandArgs, nil, stdout, stderr)
		}
		return withBackend(ctx, options, stderr, func(runtime backend) int {
			return runAudit(commandArgs, runtime, stdout, stderr)
		})
	default:
		return fail(stderr, ExitUsage, "usage", fmt.Errorf("unknown command %q", command))
	}
}

func commandHelpRequested(command string, args []string) bool {
	for _, arg := range args {
		if arg == "--help" || arg == "-h" {
			return true
		}
	}
	if len(args) == 0 {
		return false
	}
	switch command {
	case "connection", "audit":
		return strings.EqualFold(strings.TrimSpace(args[0]), "help")
	default:
		return false
	}
}

func withBackend(ctx context.Context, _ globalOptions, stderr io.Writer, run func(backend) int) int {
	// Run has already mapped --data-root to GONAVI_DATA_ROOT for this process.
	// Keep every CLI runtime on ResolveActiveRoot rather than creating a second
	// root-resolution path here.
	runtime, err := newBackend(ctx, appcore.HeadlessRuntimeOptions{})
	if err != nil {
		return fail(stderr, ExitConnection, "runtime_unavailable", err)
	}
	defer runtime.Close()
	return run(runtime)
}

func parseGlobalOptions(args []string) (globalOptions, []string, bool, error) {
	var options globalOptions
	fs := newFlagSet("gonavi")
	fs.StringVar(&options.dataRoot, "data-root", "", "GoNavi data root")
	help := fs.Bool("help", false, "show help")
	if err := fs.Parse(args); err != nil {
		return globalOptions{}, nil, false, err
	}
	return options, fs.Args(), *help, nil
}

func isVersionInvocation(args []string) bool {
	if len(args) != 1 {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(args[0])) {
	case "version", "--version", "-version":
		return true
	default:
		return false
	}
}

func applyDataRootOverride(root string) (func(), error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return func() {}, nil
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	previous, existed := os.LookupEnv("GONAVI_DATA_ROOT")
	if err := os.Setenv("GONAVI_DATA_ROOT", abs); err != nil {
		return nil, err
	}
	return func() {
		if existed {
			_ = os.Setenv("GONAVI_DATA_ROOT", previous)
			return
		}
		_ = os.Unsetenv("GONAVI_DATA_ROOT")
	}, nil
}

func runListConnections(args []string, runtime backend, stdout io.Writer, stderr io.Writer) int {
	fs := newFlagSet("list-connections")
	help := fs.Bool("help", false, "show help")
	if err := fs.Parse(args); err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	if *help {
		writeListConnectionsUsage(stdout)
		return ExitSuccess
	}
	if fs.NArg() != 0 {
		return fail(stderr, ExitUsage, "usage", errors.New("list-connections does not accept positional arguments"))
	}
	connections, err := runtime.GetSavedConnections()
	if err != nil {
		return fail(stderr, ExitConnection, "connections_unavailable", err)
	}
	for _, item := range connections {
		if code := emitOutput(stdout, stderr, item); code != ExitSuccess {
			return code
		}
	}
	return ExitSuccess
}

func runConnection(args []string, runtime backend, stdout io.Writer, stderr io.Writer) int {
	if len(args) == 0 {
		return fail(stderr, ExitUsage, "usage", errors.New("connection requires a subcommand"))
	}
	switch strings.ToLower(strings.TrimSpace(args[0])) {
	case "list":
		return runListConnections(args[1:], runtime, stdout, stderr)
	case "add":
		return runConnectionAdd(args[1:], runtime, stdout, stderr)
	case "import":
		return runConnectionImport(args[1:], runtime, stdout, stderr)
	case "help", "--help", "-h":
		writeConnectionUsage(stdout)
		return ExitSuccess
	default:
		return fail(stderr, ExitUsage, "usage", fmt.Errorf("unknown connection command %q", args[0]))
	}
}

func runConnectionAdd(args []string, runtime backend, stdout io.Writer, stderr io.Writer) int {
	fs := newFlagSet("connection add")
	var (
		inputFile   string
		name        string
		id          string
		environment string
		dbType      string
		host        string
		port        int
		user        string
		database    string
		params      string
		paramsEnv   string
		passwordEnv string
		dsnEnv      string
		uriEnv      string
		readOnly    bool
	)
	fs.StringVar(&inputFile, "file", "", "JSON SavedConnectionInput file")
	fs.StringVar(&id, "id", "", "connection ID")
	fs.StringVar(&name, "name", "", "connection name")
	fs.StringVar(&environment, "environment", "", "connection environment")
	fs.StringVar(&dbType, "type", "", "database type")
	fs.StringVar(&host, "host", "", "database host")
	fs.IntVar(&port, "port", 0, "database port")
	fs.StringVar(&user, "user", "", "database user")
	fs.StringVar(&database, "database", "", "default database")
	fs.StringVar(&params, "connection-params", "", "connection parameters")
	fs.StringVar(&paramsEnv, "connection-params-env", "", "environment variable containing complete connection parameters")
	fs.StringVar(&passwordEnv, "password-env", "", "environment variable containing the password")
	fs.StringVar(&dsnEnv, "dsn-env", "", "environment variable containing the DSN")
	fs.StringVar(&uriEnv, "uri-env", "", "environment variable containing the URI")
	fs.BoolVar(&readOnly, "read-only", false, "save the connection as read-only")
	help := fs.Bool("help", false, "show help")
	if err := fs.Parse(args); err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	if *help {
		writeConnectionAddUsage(stdout)
		return ExitSuccess
	}
	if fs.NArg() != 0 {
		return fail(stderr, ExitUsage, "usage", errors.New("connection add does not accept positional arguments"))
	}

	input := connection.SavedConnectionInput{}
	if strings.TrimSpace(inputFile) != "" {
		loaded, err := loadSingleConnectionInput(inputFile)
		if err != nil {
			return fail(stderr, ExitUsage, "invalid_connection_input", err)
		}
		input = loaded
	}
	visited := visitedFlags(fs)
	if visited["id"] {
		input.ID = strings.TrimSpace(id)
		input.Config.ID = input.ID
	}
	if visited["name"] {
		input.Name = strings.TrimSpace(name)
	}
	if visited["environment"] {
		input.EnvironmentType = strings.TrimSpace(environment)
	}
	if visited["type"] {
		input.Config.Type = strings.TrimSpace(dbType)
	}
	if visited["host"] {
		input.Config.Host = strings.TrimSpace(host)
	}
	if visited["port"] {
		input.Config.Port = port
	}
	if visited["user"] {
		input.Config.User = strings.TrimSpace(user)
	}
	if visited["database"] {
		input.Config.Database = strings.TrimSpace(database)
	}
	if visited["connection-params"] && visited["connection-params-env"] {
		return fail(stderr, ExitUsage, "usage", errors.New("use either --connection-params or --connection-params-env"))
	}
	if visited["connection-params"] {
		if appcore.HasSensitiveConnectionParams(params) {
			return fail(stderr, ExitUsage, "usage", errors.New("sensitive connection parameters must be supplied with --connection-params-env"))
		}
		input.Config.ConnectionParams = strings.TrimSpace(params)
	}
	if visited["connection-params-env"] {
		if err := assignConnectionEnvSecret(&input.Config.ConnectionParams, paramsEnv); err != nil {
			return fail(stderr, ExitUsage, "missing_secret_environment", err)
		}
	}
	if visited["read-only"] {
		input.Config.ReadOnly = readOnly
	}
	if err := assignConnectionEnvSecret(&input.Config.Password, passwordEnv); err != nil {
		return fail(stderr, ExitUsage, "missing_secret_environment", err)
	}
	if err := assignConnectionEnvSecret(&input.Config.DSN, dsnEnv); err != nil {
		return fail(stderr, ExitUsage, "missing_secret_environment", err)
	}
	if err := assignConnectionEnvSecret(&input.Config.URI, uriEnv); err != nil {
		return fail(stderr, ExitUsage, "missing_secret_environment", err)
	}
	if strings.TrimSpace(input.Name) == "" {
		return fail(stderr, ExitUsage, "usage", errors.New("connection name is required"))
	}
	if strings.TrimSpace(input.Config.Type) == "" {
		return fail(stderr, ExitUsage, "usage", errors.New("connection type is required"))
	}

	saved, err := runtime.SaveConnection(input)
	if err != nil {
		return fail(stderr, ExitConnection, "connection_save_failed", err)
	}
	return emitOutput(stdout, stderr, saved)
}

func runConnectionImport(args []string, runtime backend, stdout io.Writer, stderr io.Writer) int {
	fs := newFlagSet("connection import")
	filePath := fs.String("file", "", "JSON file containing connection inputs")
	help := fs.Bool("help", false, "show help")
	if err := fs.Parse(args); err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	if *help {
		writeConnectionImportUsage(stdout)
		return ExitSuccess
	}
	if fs.NArg() != 0 || strings.TrimSpace(*filePath) == "" {
		return fail(stderr, ExitUsage, "usage", errors.New("connection import requires --file"))
	}
	inputs, err := loadConnectionInputs(*filePath)
	if err != nil {
		return fail(stderr, ExitUsage, "invalid_connection_input", err)
	}
	if len(inputs) == 0 {
		return fail(stderr, ExitUsage, "invalid_connection_input", errors.New("connection import file is empty"))
	}
	saved, err := runtime.ImportLegacyConnections(inputs)
	if err != nil {
		return fail(stderr, ExitConnection, "connection_import_failed", err)
	}
	for _, item := range saved {
		if code := emitOutput(stdout, stderr, item); code != ExitSuccess {
			return code
		}
	}
	return ExitSuccess
}

func runQuery(ctx context.Context, args []string, runtime backend, stdout io.Writer, stderr io.Writer) int {
	fs := newFlagSet("query")
	connectionSelector := fs.String("conn", "", "connection ID or exact name")
	connectionFile := fs.String("connection-file", "", "temporary ConnectionConfig JSON file")
	database := fs.String("database", "", "database or schema")
	sqlText := fs.String("sql", "", "SQL text")
	sqlFile := fs.String("sql-file", "", "SQL file")
	format := fs.String("format", "jsonl", "jsonl, json, csv, or md")
	allowWrite := false
	fs.BoolVar(&allowWrite, "allow-write", false, "allow non-read-only SQL")
	fs.BoolVar(&allowWrite, "allow-mutating", false, "deprecated alias for --allow-write")
	queryTimeout := fs.Int("query-timeout", 0, "query timeout in seconds")
	requestTrace := fs.Bool("request-trace", false, "write the redacted request trace to stderr")
	help := fs.Bool("help", false, "show help")
	if err := fs.Parse(args); err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	if *help {
		writeQueryUsage(stdout)
		return ExitSuccess
	}
	if *queryTimeout < 0 {
		return fail(stderr, ExitUsage, "usage", errors.New("query timeout must not be negative"))
	}
	queryFormat := strings.ToLower(strings.TrimSpace(*format))
	if !isCLIQueryFormat(queryFormat) {
		return fail(stderr, ExitUsage, "usage", fmt.Errorf("unsupported query format %q", *format))
	}
	sql, err := resolveSQLInput(*sqlText, *sqlFile, fs.Args())
	if err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	config, err := resolveCommandConnection(runtime, *connectionSelector, *connectionFile)
	if err != nil {
		return failCommandConnection(stderr, err)
	}
	if *queryTimeout > 0 {
		config.QueryTimeout = *queryTimeout
	}
	result := runtime.Query(ctx, config, *database, sql, appcore.HeadlessQueryOptions{AllowMutating: allowWrite})
	if *requestTrace {
		emitRequestTrace(stderr, runtime, result)
	}
	if !result.Success {
		return failResult(ctx, stderr, result)
	}
	return renderQueryResult(stdout, stderr, result, queryFormat)
}

func runExport(ctx context.Context, args []string, runtime backend, stdout io.Writer, stderr io.Writer) int {
	fs := newFlagSet("export")
	connectionSelector := fs.String("conn", "", "connection ID or exact name")
	connectionFile := fs.String("connection-file", "", "temporary ConnectionConfig JSON file")
	database := fs.String("database", "", "database or schema")
	sqlText := fs.String("sql", "", "SELECT/WITH SQL text")
	sqlFile := fs.String("sql-file", "", "SQL file")
	output := fs.String("output", "", "output file path")
	format := fs.String("format", "", "csv, json, md, html, or xlsx")
	columns := fs.String("columns", "", "comma-separated output columns")
	xlsxRows := fs.Int("xlsx-max-rows-per-sheet", 0, "maximum XLSX data rows per worksheet")
	force := fs.Bool("force", false, "replace an existing output file")
	queryTimeout := fs.Int("query-timeout", 0, "query timeout in seconds")
	requestTrace := fs.Bool("request-trace", false, "write the redacted request trace to stderr")
	help := fs.Bool("help", false, "show help")
	if err := fs.Parse(args); err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	if *help {
		writeExportUsage(stdout)
		return ExitSuccess
	}
	if strings.TrimSpace(*output) == "" {
		return fail(stderr, ExitUsage, "usage", errors.New("export requires --output"))
	}
	if *queryTimeout < 0 {
		return fail(stderr, ExitUsage, "usage", errors.New("query timeout must not be negative"))
	}
	sql, err := resolveSQLInput(*sqlText, *sqlFile, fs.Args())
	if err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	resolvedFormat := strings.ToLower(strings.TrimSpace(*format))
	if resolvedFormat == "" {
		resolvedFormat = strings.TrimPrefix(strings.ToLower(filepath.Ext(*output)), ".")
	}
	if !isCLIExportFormat(resolvedFormat) {
		return fail(stderr, ExitUsage, "usage", fmt.Errorf("unsupported export format %q", resolvedFormat))
	}
	config, err := resolveCommandConnection(runtime, *connectionSelector, *connectionFile)
	if err != nil {
		return failCommandConnection(stderr, err)
	}
	if *queryTimeout > 0 {
		config.QueryTimeout = *queryTimeout
	}
	result := runtime.ExportQueryToPath(ctx, config, *database, sql, *output, appcore.ExportFileOptions{
		Format:              resolvedFormat,
		Columns:             splitCSVList(*columns),
		XLSXMaxRowsPerSheet: *xlsxRows,
	}, *force)
	if *requestTrace {
		emitRequestTrace(stderr, runtime, result)
	}
	if !result.Success {
		return failResult(ctx, stderr, result)
	}
	return emitOutput(stdout, stderr, sanitizeQueryResult(result))
}

func runBatch(ctx context.Context, args []string, runtime backend, stdout io.Writer, stderr io.Writer) int {
	fs := newFlagSet("batch")
	connectionSelector := fs.String("conn", "", "connection ID or exact name")
	connectionFile := fs.String("connection-file", "", "temporary ConnectionConfig JSON file")
	database := fs.String("database", "", "database or schema")
	filePath := fs.String("file", "", "SQL or SQL.GZ file")
	aliasFilePath := fs.String("sql-file", "", "SQL or SQL.GZ file")
	allowWrite := false
	fs.BoolVar(&allowWrite, "allow-write", false, "allow SQL-file execution")
	fs.BoolVar(&allowWrite, "allow-mutating", false, "deprecated alias for --allow-write")
	transaction := fs.String("transaction", string(appcore.HeadlessSQLTransactionModeSingle), "single or off")
	continueOnError := fs.Bool("continue-on-error", false, "continue after statement errors")
	stopOnError := fs.Bool("stop-on-error", false, "stop after the first statement error (default)")
	jobID := fs.String("job-id", "", "durable job ID")
	maxStatementBytes := fs.Int64("max-statement-bytes", 0, "maximum decoded bytes in one statement")
	requestTrace := fs.Bool("request-trace", false, "write the redacted request trace to stderr")
	help := fs.Bool("help", false, "show help")
	if err := fs.Parse(args); err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	if *help {
		writeBatchUsage(stdout)
		return ExitSuccess
	}
	if !allowWrite {
		return fail(stderr, ExitPolicyDenied, "policy_denied", errors.New("batch requires --allow-write"))
	}
	transactionMode, err := parseBatchTransactionMode(*transaction)
	if err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	if *continueOnError && *stopOnError {
		return fail(stderr, ExitUsage, "usage", errors.New("use either --continue-on-error or --stop-on-error"))
	}
	if *continueOnError && transactionMode != appcore.HeadlessSQLTransactionModeOff {
		return fail(stderr, ExitUsage, "usage", errors.New("--continue-on-error requires --transaction=off"))
	}
	if strings.TrimSpace(*filePath) != "" && strings.TrimSpace(*aliasFilePath) != "" {
		return fail(stderr, ExitUsage, "usage", errors.New("use either --file or --sql-file"))
	}
	if strings.TrimSpace(*filePath) == "" {
		*filePath = *aliasFilePath
	}
	if strings.TrimSpace(*filePath) == "" {
		return fail(stderr, ExitUsage, "usage", errors.New("batch requires --file"))
	}
	if fs.NArg() != 0 {
		return fail(stderr, ExitUsage, "usage", errors.New("batch does not accept positional arguments"))
	}
	if *maxStatementBytes < 0 {
		return fail(stderr, ExitUsage, "usage", errors.New("max statement bytes must not be negative"))
	}
	if _, err := os.Stat(*filePath); err != nil {
		return fail(stderr, ExitUsage, "sql_file_unavailable", err)
	}
	config, err := resolveCommandConnection(runtime, *connectionSelector, *connectionFile)
	if err != nil {
		return failCommandConnection(stderr, err)
	}
	result := runtime.ExecuteSQLFile(ctx, config, *database, *filePath, appcore.HeadlessSQLFileOptions{
		AllowMutating:    allowWrite,
		ContinueOnError:  *continueOnError && !*stopOnError,
		TransactionMode:  transactionMode,
		JobID:            strings.TrimSpace(*jobID),
		MaxStatementSize: *maxStatementBytes,
	})
	if *requestTrace {
		emitRequestTrace(stderr, runtime, result)
	}
	if !result.Success {
		return failResult(ctx, stderr, result)
	}
	return emitOutput(stdout, stderr, sanitizeQueryResult(result))
}

func parseBatchTransactionMode(value string) (appcore.HeadlessSQLTransactionMode, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", string(appcore.HeadlessSQLTransactionModeSingle):
		return appcore.HeadlessSQLTransactionModeSingle, nil
	case string(appcore.HeadlessSQLTransactionModeOff):
		return appcore.HeadlessSQLTransactionModeOff, nil
	default:
		return "", fmt.Errorf("unsupported transaction mode %q (use single or off)", value)
	}
}

func runAudit(args []string, runtime backend, stdout io.Writer, stderr io.Writer) int {
	if len(args) == 0 {
		return fail(stderr, ExitUsage, "usage", errors.New("audit requires a subcommand (export)"))
	}
	if strings.EqualFold(strings.TrimSpace(args[0]), "help") || strings.EqualFold(strings.TrimSpace(args[0]), "--help") {
		writeAuditUsage(stdout)
		return ExitSuccess
	}
	if !strings.EqualFold(strings.TrimSpace(args[0]), "export") {
		return fail(stderr, ExitUsage, "usage", fmt.Errorf("unknown audit command %q", args[0]))
	}

	fs := newFlagSet("audit export")
	output := fs.String("output", "", "output file path")
	format := fs.String("format", "json", "json or csv")
	force := fs.Bool("force", false, "replace an existing output file")
	connectionID := fs.String("connection-id", "", "audit connection ID filter")
	database := fs.String("database", "", "audit database filter")
	dbType := fs.String("db-type", "", "audit database type filter")
	status := fs.String("status", "", "audit status filter")
	source := fs.String("source", "", "audit source filter")
	search := fs.String("search", "", "audit search filter")
	from := fs.String("from", "", "RFC3339 or Unix milliseconds")
	to := fs.String("to", "", "RFC3339 or Unix milliseconds")
	help := fs.Bool("help", false, "show help")
	if err := fs.Parse(args[1:]); err != nil {
		return fail(stderr, ExitUsage, "usage", err)
	}
	if *help {
		writeAuditUsage(stdout)
		return ExitSuccess
	}
	if fs.NArg() != 0 || strings.TrimSpace(*output) == "" {
		return fail(stderr, ExitUsage, "usage", errors.New("audit export requires --output"))
	}
	resolvedFormat := strings.ToLower(strings.TrimSpace(*format))
	if !isCLIAuditFormat(resolvedFormat) {
		return fail(stderr, ExitUsage, "usage", fmt.Errorf("unsupported audit export format %q", *format))
	}
	fromTimestamp, err := parseTimestamp(*from)
	if err != nil {
		return fail(stderr, ExitUsage, "usage", fmt.Errorf("invalid --from: %w", err))
	}
	toTimestamp, err := parseTimestamp(*to)
	if err != nil {
		return fail(stderr, ExitUsage, "usage", fmt.Errorf("invalid --to: %w", err))
	}
	result := runtime.ExportSQLAuditToPath(sqlaudit.Filter{
		Search:        strings.TrimSpace(*search),
		ConnectionID:  strings.TrimSpace(*connectionID),
		Database:      strings.TrimSpace(*database),
		DBType:        strings.TrimSpace(*dbType),
		Status:        strings.TrimSpace(*status),
		Source:        strings.TrimSpace(*source),
		FromTimestamp: fromTimestamp,
		ToTimestamp:   toTimestamp,
	}, resolvedFormat, *output, *force)
	if !result.Success {
		return failResult(context.Background(), stderr, result)
	}
	return emitOutput(stdout, stderr, sanitizeQueryResult(result))
}

func runMCP(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer) int {
	if len(args) == 0 {
		return finishMCPInvocation(ctx, stderr, runMCPStdioServer(ctx))
	}
	switch strings.ToLower(strings.TrimSpace(args[0])) {
	case "stdio", "--stdio":
		return finishMCPInvocation(ctx, stderr, runMCPStdioServer(ctx))
	case "http", "--http", "streamable-http", "--streamable-http":
		options, err := mcpserver.ParseHTTPServerOptions(args[1:])
		if err != nil {
			return fail(stderr, ExitUsage, "usage", err)
		}
		return finishMCPInvocation(ctx, stderr, runMCPHTTPServer(ctx, options))
	case "remote-config", "--remote-config":
		if err := mcpserver.WriteRemoteMCPClientConfig(stdout, args[1:]); err != nil {
			return fail(stderr, ExitUsage, "usage", err)
		}
		return ExitSuccess
	case "help", "--help", "-h":
		writeMCPUsage(stdout)
		return ExitSuccess
	default:
		return fail(stderr, ExitUsage, "usage", fmt.Errorf("unknown mcp mode %q", args[0]))
	}
}

func finishMCPInvocation(ctx context.Context, stderr io.Writer, err error) int {
	// The HTTP server treats a context-triggered graceful shutdown as a clean
	// server return. The command invocation still ended by cancellation, so its
	// process-level status must remain distinct from a successful server exit.
	if ctx != nil && ctx.Err() != nil {
		return fail(stderr, ExitCancelled, "cancelled", ctx.Err())
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return fail(stderr, ExitCancelled, "cancelled", err)
	}
	if err != nil {
		return fail(stderr, ExitExecution, "mcp_failed", err)
	}
	return ExitSuccess
}

func resolveCommandConnection(runtime backend, selector string, filePath string) (connection.ConnectionConfig, error) {
	selector = strings.TrimSpace(selector)
	filePath = strings.TrimSpace(filePath)
	if selector != "" && filePath != "" {
		return connection.ConnectionConfig{}, errConnectionSourceConflict
	}
	if filePath != "" {
		return loadTemporaryConnectionConfig(filePath)
	}
	if selector == "" {
		return connection.ConnectionConfig{}, errConnectionSourceMissing
	}
	view, err := runtime.ResolveSavedConnection(selector)
	if err != nil {
		return connection.ConnectionConfig{}, err
	}
	return view.Config, nil
}

func resolveSQLInput(sqlText string, sqlFile string, positional []string) (string, error) {
	provided := 0
	if strings.TrimSpace(sqlText) != "" {
		provided++
	}
	if strings.TrimSpace(sqlFile) != "" {
		provided++
	}
	if len(positional) > 0 {
		provided++
	}
	if provided != 1 {
		return "", errors.New("provide SQL with one of --sql, --sql-file, or a single positional argument")
	}
	if strings.TrimSpace(sqlText) != "" {
		return strings.TrimSpace(sqlText), nil
	}
	if strings.TrimSpace(sqlFile) != "" {
		return readSQLFile(sqlFile)
	}
	if len(positional) != 1 {
		return "", errors.New("SQL must be one positional argument")
	}
	return strings.TrimSpace(positional[0]), nil
}

func readSQLFile(filePath string) (string, error) {
	const maxSQLTextBytes = 64 << 20
	file, err := os.Open(strings.TrimSpace(filePath))
	if err != nil {
		return "", err
	}
	defer file.Close()
	reader := io.LimitReader(file, maxSQLTextBytes+1)
	contents, err := io.ReadAll(reader)
	if err != nil {
		return "", err
	}
	if len(contents) > maxSQLTextBytes {
		return "", fmt.Errorf("SQL text file exceeds %d bytes", maxSQLTextBytes)
	}
	text := strings.TrimSpace(string(contents))
	if text == "" {
		return "", errors.New("SQL text is empty")
	}
	return text, nil
}

func loadSingleConnectionInput(filePath string) (connection.SavedConnectionInput, error) {
	data, err := os.ReadFile(strings.TrimSpace(filePath))
	if err != nil {
		return connection.SavedConnectionInput{}, err
	}
	var input connection.SavedConnectionInput
	if err := json.Unmarshal(data, &input); err != nil {
		return connection.SavedConnectionInput{}, err
	}
	return input, nil
}

func loadConnectionInputs(filePath string) ([]connection.LegacySavedConnection, error) {
	data, err := os.ReadFile(strings.TrimSpace(filePath))
	if err != nil {
		return nil, err
	}
	var list []connection.LegacySavedConnection
	if err := json.Unmarshal(data, &list); err == nil {
		return list, nil
	}
	var wrapped struct {
		Connections []connection.LegacySavedConnection `json:"connections"`
	}
	if err := json.Unmarshal(data, &wrapped); err != nil {
		return nil, err
	}
	if wrapped.Connections == nil {
		return nil, errors.New("expected a JSON array or an object with a connections array")
	}
	return wrapped.Connections, nil
}

func assignConnectionEnvSecret(target *string, envName string) error {
	envName = strings.TrimSpace(envName)
	if envName == "" {
		return nil
	}
	value, ok := os.LookupEnv(envName)
	if !ok {
		return fmt.Errorf("environment variable %s is not set", envName)
	}
	if target == nil {
		return errors.New("secret target is unavailable")
	}
	*target = value
	return nil
}

func renderQueryResult(stdout io.Writer, stderr io.Writer, result connection.QueryResult, format string) int {
	format = strings.ToLower(strings.TrimSpace(format))
	if format == "" {
		format = "jsonl"
	}
	if format == "json" {
		return emitOutput(stdout, stderr, sanitizeQueryResult(result))
	}
	sets, err := queryResultSets(result)
	switch format {
	case "jsonl":
		// Writes and other successful non-tabular actions return metadata such
		// as affectedRows instead of result sets. They still use the stable
		// JSONL summary contract; only tabular data emits result_set/row events.
		if err != nil {
			sanitized := sanitizeQueryResult(result)
			return emitOutput(stdout, stderr, jsonlSummaryEvent{
				Type:       "summary",
				Success:    sanitized.Success,
				QueryID:    sanitized.QueryID,
				Message:    sanitized.Message,
				Messages:   sanitized.Messages,
				Data:       sanitized.Data,
				ResultSets: 0,
				Rows:       0,
			})
		}
		rows := 0
		for index, set := range sets {
			if code := emitOutput(stdout, stderr, jsonlResultSetEvent{
				Type:      "result_set",
				ResultSet: index + 1,
				Columns:   set.Columns,
				RowCount:  len(set.Rows),
			}); code != ExitSuccess {
				return code
			}
			for _, row := range set.Rows {
				if code := emitOutput(stdout, stderr, jsonlRowEvent{Type: "row", ResultSet: index + 1, Data: row}); code != ExitSuccess {
					return code
				}
				rows++
			}
		}
		sanitized := sanitizeQueryResult(result)
		return emitOutput(stdout, stderr, jsonlSummaryEvent{
			Type:       "summary",
			Success:    sanitized.Success,
			QueryID:    sanitized.QueryID,
			Message:    sanitized.Message,
			Messages:   sanitized.Messages,
			ResultSets: len(sets),
			Rows:       rows,
		})
	case "csv", "md", "markdown":
		if err != nil {
			return fail(stderr, ExitExecution, "invalid_result", err)
		}
		if len(sets) != 1 {
			return fail(stderr, ExitUsage, "unsupported_result_shape", errors.New("csv and markdown require exactly one result set"))
		}
		switch format {
		case "csv":
			writer := csv.NewWriter(stdout)
			if err := writer.Write(sets[0].Columns); err != nil {
				return fail(stderr, ExitExecution, "output_failed", err)
			}
			for _, row := range sets[0].Rows {
				record := make([]string, len(sets[0].Columns))
				for index, column := range sets[0].Columns {
					record[index] = formatOutputValue(row[column])
				}
				if err := writer.Write(record); err != nil {
					return fail(stderr, ExitExecution, "output_failed", err)
				}
			}
			writer.Flush()
			if err := writer.Error(); err != nil {
				return fail(stderr, ExitExecution, "output_failed", err)
			}
			return ExitSuccess
		case "md", "markdown":
			if _, err := fmt.Fprintf(stdout, "| %s |\n", strings.Join(sets[0].Columns, " | ")); err != nil {
				return fail(stderr, ExitExecution, "output_failed", err)
			}
			separator := make([]string, len(sets[0].Columns))
			for index := range separator {
				separator[index] = "---"
			}
			if _, err := fmt.Fprintf(stdout, "| %s |\n", strings.Join(separator, " | ")); err != nil {
				return fail(stderr, ExitExecution, "output_failed", err)
			}
			for _, row := range sets[0].Rows {
				record := make([]string, len(sets[0].Columns))
				for index, column := range sets[0].Columns {
					value := strings.ReplaceAll(formatOutputValue(row[column]), "|", "\\|")
					record[index] = strings.ReplaceAll(value, "\n", "<br>")
				}
				if _, err := fmt.Fprintf(stdout, "| %s |\n", strings.Join(record, " | ")); err != nil {
					return fail(stderr, ExitExecution, "output_failed", err)
				}
			}
			return ExitSuccess
		}
	default:
		return fail(stderr, ExitUsage, "usage", fmt.Errorf("unsupported query format %q", format))
	}
	return ExitExecution
}

func isCLIQueryFormat(format string) bool {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "json", "jsonl", "csv", "md", "markdown":
		return true
	default:
		return false
	}
}

func queryResultSets(result connection.QueryResult) ([]connection.ResultSetData, error) {
	if result.Data == nil {
		return []connection.ResultSetData{{Columns: result.Fields, Rows: []map[string]any{}}}, nil
	}
	if sets, ok := result.Data.([]connection.ResultSetData); ok {
		return sets, nil
	}
	if rows, ok := result.Data.([]map[string]any); ok {
		return []connection.ResultSetData{{Columns: result.Fields, Rows: rows}}, nil
	}
	return nil, fmt.Errorf("query result is not tabular")
}

func emitRequestTrace(stderr io.Writer, runtime backend, result connection.QueryResult) {
	if stderr == nil || runtime == nil || strings.TrimSpace(result.QueryID) == "" {
		return
	}
	reader, ok := runtime.(requestDiagnosticBackend)
	if !ok {
		return
	}
	diagnostic := reader.GetRequestDiagnostic(result.QueryID)
	if !diagnostic.Success || diagnostic.Data == nil {
		return
	}
	// Diagnostic capture is observability only: a local stderr write must not
	// change the outcome of the database command that just completed.
	_ = encode(stderr, map[string]any{
		"type":  "request_trace",
		"trace": diagnostic.Data,
	})
}

func sanitizeQueryResult(result connection.QueryResult) connection.QueryResult {
	result.Message = sqlaudit.RedactError(result.Message)
	if len(result.Messages) > 0 {
		messages := make([]string, 0, len(result.Messages))
		for _, message := range result.Messages {
			messages = append(messages, sqlaudit.RedactError(message))
		}
		result.Messages = messages
	}
	return result
}

func formatOutputValue(value any) string {
	if value == nil {
		return ""
	}
	switch value.(type) {
	case map[string]any, []any, []string, []byte:
		if encoded, err := json.Marshal(value); err == nil {
			return string(encoded)
		}
	}
	return fmt.Sprint(value)
}

func splitCSVList(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if normalized := strings.TrimSpace(part); normalized != "" {
			result = append(result, normalized)
		}
	}
	return result
}

func isCLIExportFormat(format string) bool {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "csv", "json", "md", "html", "xlsx":
		return true
	default:
		return false
	}
}

func isCLIAuditFormat(format string) bool {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "json", "csv":
		return true
	default:
		return false
	}
}

func parseTimestamp(value string) (int64, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, nil
	}
	if milliseconds, err := strconv.ParseInt(value, 10, 64); err == nil {
		return milliseconds, nil
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return 0, err
	}
	return parsed.UnixMilli(), nil
}

func resultDataBool(result connection.QueryResult, key string) bool {
	data, ok := result.Data.(map[string]any)
	if !ok {
		return false
	}
	value, _ := data[key].(bool)
	return value
}

func resultHasUnknownOutcome(result connection.QueryResult) bool {
	return resultDataBool(result, "outcomeUnknown")
}

func resultWasCancelled(result connection.QueryResult) bool {
	return resultDataBool(result, "cancelled")
}

func resultErrorKind(result connection.QueryResult) string {
	data, ok := result.Data.(map[string]any)
	if !ok {
		return ""
	}
	kind, _ := data["errorKind"].(string)
	return strings.ToLower(strings.TrimSpace(kind))
}

func failResult(ctx context.Context, stderr io.Writer, result connection.QueryResult) int {
	if resultHasUnknownOutcome(result) {
		return fail(stderr, ExitUnknownOutcome, "outcome_unknown", errors.New(result.Message))
	}
	if resultWasCancelled(result) {
		return fail(stderr, ExitCancelled, "cancelled", errors.New(result.Message))
	}
	if ctx != nil && ctx.Err() != nil {
		return fail(stderr, ExitCancelled, "cancelled", ctx.Err())
	}
	if resultErrorKind(result) == "connection" {
		return fail(stderr, ExitConnection, "connection_failed", errors.New(result.Message))
	}
	if resultErrorKind(result) == "policy" {
		return fail(stderr, ExitPolicyDenied, "policy_denied", errors.New(result.Message))
	}
	if hasCancellationToken(result.Message) {
		return fail(stderr, ExitCancelled, "cancelled", errors.New(result.Message))
	}
	if strings.Contains(strings.ToLower(result.Message), "allow-write") || strings.Contains(strings.ToLower(result.Message), "allow-mutating") || strings.Contains(strings.ToLower(result.Message), "read-only") || strings.Contains(result.Message, "只读") {
		return fail(stderr, ExitPolicyDenied, "policy_denied", errors.New(result.Message))
	}
	return fail(stderr, ExitExecution, "execution_failed", errors.New(result.Message))
}

// hasCancellationToken deliberately matches standalone cancellation words.
// Substrings such as "cancellation_reason" are ordinary database identifiers,
// not evidence that an operation was cancelled.
func hasCancellationToken(message string) bool {
	for _, token := range strings.FieldsFunc(strings.ToLower(message), func(r rune) bool {
		return !unicode.IsLetter(r)
	}) {
		switch token {
		case "cancel", "canceled", "cancelled":
			return true
		}
	}
	return false
}

func failResolveSavedConnection(stderr io.Writer, err error) int {
	var ambiguous *appcore.AmbiguousConnectionNameError
	if errors.As(err, &ambiguous) {
		return fail(stderr, ExitConnection, "connection_ambiguous", err)
	}
	return fail(stderr, ExitConnection, "connection_not_found", err)
}

func failCommandConnection(stderr io.Writer, err error) int {
	if errors.Is(err, errConnectionSourceConflict) || errors.Is(err, errConnectionSourceMissing) {
		return fail(stderr, ExitUsage, "usage", err)
	}
	var ambiguous *appcore.AmbiguousConnectionNameError
	if errors.As(err, &ambiguous) {
		return failResolveSavedConnection(stderr, err)
	}
	if strings.Contains(strings.ToLower(err.Error()), "saved connection not found") {
		return failResolveSavedConnection(stderr, err)
	}
	return fail(stderr, ExitConnection, "connection_file_invalid", err)
}

func newFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet("gonavi "+name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs
}

func visitedFlags(fs *flag.FlagSet) map[string]bool {
	result := make(map[string]bool)
	fs.Visit(func(item *flag.Flag) {
		result[item.Name] = true
	})
	return result
}

func emit(writer io.Writer, value any) int {
	if err := encode(writer, value); err != nil {
		return ExitExecution
	}
	return ExitSuccess
}

func emitOutput(stdout io.Writer, stderr io.Writer, value any) int {
	if err := encode(stdout, value); err != nil {
		return fail(stderr, ExitExecution, "output_failed", err)
	}
	return ExitSuccess
}

func encode(writer io.Writer, value any) error {
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}

func fail(writer io.Writer, exitCode int, code string, err error) int {
	message := "operation failed"
	if err != nil {
		message = sqlaudit.RedactError(err.Error())
	}
	_ = emit(writer, errorReport{OK: false, Code: code, Message: message})
	return exitCode
}

func writeRootUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, `GoNavi CLI

Usage:
  gonavi [--data-root PATH] list-connections
  gonavi [--data-root PATH] connection <list|add|import>
  gonavi [--data-root PATH] query (--conn ID_OR_NAME|--connection-file FILE) [--sql SQL|--sql-file FILE|SQL]
  gonavi [--data-root PATH] export (--conn ID_OR_NAME|--connection-file FILE) --output FILE [--sql SQL|--sql-file FILE|SQL]
  gonavi [--data-root PATH] batch (--conn ID_OR_NAME|--connection-file FILE) --file FILE --allow-write
  gonavi [--data-root PATH] audit export --output FILE
  gonavi [--data-root PATH] mcp <stdio|http|remote-config>
`)
}

func writeListConnectionsUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi list-connections\n")
}

func writeConnectionUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi connection <list|add|import>\n")
}

func writeConnectionAddUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi connection add --name NAME --type TYPE [--host HOST --port PORT --user USER --database DB] [--connection-params PARAMS|--connection-params-env NAME] [--password-env NAME] [--file INPUT.json]\n")
}

func writeConnectionImportUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi connection import --file CONNECTIONS.json\n")
}

func writeQueryUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi query (--conn ID_OR_NAME|--connection-file FILE) [--database DB] [--allow-write] [--request-trace] [--format jsonl|json|csv|md] (--sql SQL|--sql-file FILE|SQL)\n")
}

func writeExportUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi export (--conn ID_OR_NAME|--connection-file FILE) --output FILE [--request-trace] [--format csv|json|md|html|xlsx] (--sql SQL|--sql-file FILE|SQL)\n")
}

func writeBatchUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi batch (--conn ID_OR_NAME|--connection-file FILE) --file FILE --allow-write [--request-trace] [--transaction single|off] [--stop-on-error|--continue-on-error]\n")
}

func writeAuditUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi audit export --output FILE [--format json|csv]\n")
}

func writeMCPUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi mcp <stdio|http|remote-config>\n")
}
