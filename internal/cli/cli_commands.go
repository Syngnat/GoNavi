package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/mcpserver"
	"GoNavi-Wails/internal/sqlaudit"
)

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
