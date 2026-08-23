package app

import (
	"context"

	"GoNavi-Wails/internal/connection"
)

// CLIQueryExecutor is the dedicated headless query entry point. Its audit
// source is backend-owned so command-line arguments cannot impersonate it.
type CLIQueryExecutor struct {
	app *App
}

func NewCLIQueryExecutor(app *App) *CLIQueryExecutor {
	return &CLIQueryExecutor{app: app}
}

func (executor *CLIQueryExecutor) DBQueryMulti(
	ctx context.Context,
	config connection.ConnectionConfig,
	dbName string,
	query string,
	queryID string,
) connection.QueryResult {
	if executor == nil || executor.app == nil {
		return connection.QueryResult{Success: false, Message: "CLI query executor is unavailable"}
	}
	return executor.app.dbQueryMulti(config, dbName, query, queryID, dbQueryMultiAuditOptions{
		auditAll:                 true,
		auditWrites:              true,
		source:                   "cli",
		executionContext:         ctx,
		classifyConnectionErrors: true,
	})
}
