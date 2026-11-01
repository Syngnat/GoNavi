package app

import (
	"context"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

const (
	pluginPageQueryDefaultRows = 100
	pluginPageQueryMaxRows     = 1000
	pluginPageQueryAuditSource = "plugin_page"
)

type pluginPageQueryArguments struct {
	ConnectionID string `json:"connectionId"`
	SQL          string `json:"sql"`
	MaxRows      int    `json:"maxRows,omitempty"`
}

type pluginPageQueryColumn struct {
	Name string `json:"name"`
}

type pluginPageQueryResult struct {
	Columns   []pluginPageQueryColumn `json:"columns"`
	Rows      [][]any                 `json:"rows"`
	Truncated bool                    `json:"truncated"`
	ElapsedMS int64                   `json:"elapsedMs"`
}

// pluginPageQueryRead executes one read-only statement through the existing
// query path, so read-only connection policy, execution timeout and SQL audit
// all apply exactly as they do for an application-owned query. Pages cannot
// choose a database, send credentials or submit more than one statement.
func pluginPageQueryRead(ctx context.Context, a *App, request pluginPageRequest) (any, string) {
	var arguments pluginPageQueryArguments
	if !decodePluginPageArguments(request.arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	maxRows := arguments.MaxRows
	if maxRows == 0 {
		maxRows = pluginPageQueryDefaultRows
	}
	if maxRows < 1 || maxRows > pluginPageQueryMaxRows {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	statement, ok := pluginPageReadOnlyStatement(resolveDDLDBType(config), arguments.SQL)
	if !ok {
		return nil, "invalid_arguments"
	}
	started := time.Now()
	// Bind a scan-layer budget. maxRows+1 distinguishes "exactly maxRows" from
	// "more rows exist" without reading the whole result set. Byte and field
	// ceilings stop a huge cell/BLOB from being materialized before the 256 KiB
	// response check runs; drivers that do not understand db.RowBudget still fall
	// back to response truncation below.
	budget := db.NewRowBudgetWithOptions(db.RowBudgetOptions{
		MaxRowsPerResult: maxRows + 1,
		MaxTotalBytes:    4 << 20,
		MaxFieldBytes:    1 << 20,
	})
	result := a.dbQueryWithCancel(config, config.Database, statement, "", dbQueryAuditOptions{
		auditAll:         true,
		auditWrites:      true,
		source:           pluginPageQueryAuditSource,
		executionContext: db.ContextWithRowBudget(ctx, budget),
	})
	if !result.Success {
		logger.Warnf("Plugin page query failed: %s", formatConnSummary(config))
		return nil, "internal"
	}
	shaped, ok := pluginPageShapeQueryResult(result, maxRows)
	if !ok {
		return nil, "internal"
	}
	if budget.Truncated() {
		shaped.Truncated = true
	}
	shaped.ElapsedMS = time.Since(started).Milliseconds()
	return shaped, ""
}

// pluginPageReadOnlyStatement accepts exactly one statement whose first
// keyword is a read keyword and whose body the shared classifier still proves
// read-only (including CTE bodies and executable-comment checks).
func pluginPageReadOnlyStatement(dbType, query string) (string, bool) {
	statements := splitSQLStatementsForDialect(dbType, strings.TrimSpace(query))
	trimmed := make([]string, 0, len(statements))
	for _, statement := range statements {
		if text := strings.TrimSpace(statement); text != "" {
			trimmed = append(trimmed, text)
		}
	}
	if len(trimmed) != 1 {
		return "", false
	}
	statement := trimmed[0]
	keyword, withHasWrite := sqlDataOperationInfo(statement, dbType)
	if withHasWrite {
		return "", false
	}
	switch keyword {
	case "select", "with", "show", "describe", "desc", "explain":
	default:
		return "", false
	}
	if !isReadOnlySQLQuery(dbType, statement) {
		return "", false
	}
	// A read-only classifier only proves "does not write". Lock clauses and a
	// few server-side functions still have observable effects, so the page
	// bridge rejects the common cases explicitly.
	if pluginPageSQLHasSideEffects(statement, dbType) {
		return "", false
	}
	return statement, true
}

func pluginPageShapeQueryResult(result connection.QueryResult, maxRows int) (pluginPageQueryResult, bool) {
	shaped := pluginPageQueryResult{Columns: []pluginPageQueryColumn{}, Rows: [][]any{}}
	rows, ok := result.Data.([]map[string]interface{})
	if !ok {
		if result.Data != nil {
			return pluginPageQueryResult{}, false
		}
		shaped.Truncated = result.Truncated
		return shaped, true
	}
	fields := append([]string(nil), result.Fields...)
	if len(fields) == 0 {
		fields = pluginPageRowFields(rows)
	}
	for _, field := range fields {
		shaped.Columns = append(shaped.Columns, pluginPageQueryColumn{Name: field})
	}
	truncated := result.Truncated
	if len(rows) > maxRows {
		rows = rows[:maxRows]
		truncated = true
	}
	for _, row := range rows {
		values := make([]any, 0, len(fields))
		for _, field := range fields {
			values = append(values, row[field])
		}
		shaped.Rows = append(shaped.Rows, values)
	}
	shaped.Truncated = truncated
	return shaped, true
}

// pluginPageRowFields keeps the JSON shape stable when a driver omits field
// metadata; keys are sorted so repeated calls stay deterministic.
func pluginPageRowFields(rows []map[string]interface{}) []string {
	if len(rows) == 0 {
		return nil
	}
	fields := make([]string, 0, len(rows[0]))
	for field := range rows[0] {
		fields = append(fields, field)
	}
	sort.Strings(fields)
	return fields
}
