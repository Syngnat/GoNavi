// Package cli implements the standalone GoNavi command-line interface.
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
	// ExitActionRequired indicates that a run was accepted but needs a
	// follow-up command (approval, resume, recovery, or an owner to consume
	// a queued input) before it can reach a terminal state.
	ExitActionRequired = 8
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
	// Keep the caller's lifecycle context for the Agent route.  Legacy CLI
	// commands historically tolerated a nil context, so they continue to use a
	// synthesized background context below; Agent commands must instead reject
	// a missing root rather than creating work detached from the process
	// lifetime.
	agentLifecycleCtx := ctx
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
	case "agent":
		return runAgent(agentLifecycleCtx, commandArgs, stdout, stderr)
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
