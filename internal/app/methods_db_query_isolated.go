package app

import (
	"context"
	"net/url"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/sqlaudit"
)

func (a *App) DBQueryIsolated(config connection.ConnectionConfig, dbName string, query string) connection.QueryResult {
	return a.dbQueryIsolatedContext(context.Background(), config, dbName, query)
}

func (a *App) dbQueryIsolatedContext(parent context.Context, config connection.ConnectionConfig, dbName string, query string) connection.QueryResult {
	if parent == nil {
		parent = context.Background()
	}
	if err := parent.Err(); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error(), Data: map[string]any{"cancelled": true}}
	}
	runConfig := normalizeRunConfig(config, dbName)

	query = sanitizeSQLForPgLike(resolveDDLDBType(config), query)
	if err := a.ensureDataSourceQueryCapability(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := ensureConnectionAllowsQuery(config, query); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	dbInst, err := a.openDatabaseIsolated(runConfig)
	if err != nil {
		logger.Error(err, "DBQueryIsolated 获取连接失败：%s", formatConnSummary(runConfig))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer func() {
		if closeErr := dbInst.Close(); closeErr != nil {
			logger.Error(closeErr, "DBQueryIsolated 关闭临时连接失败：%s", formatConnSummary(runConfig))
		}
	}()
	if err := parent.Err(); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error(), Data: map[string]any{"cancelled": true}}
	}

	ctx, cancel := newQueryExecutionContextWithParent(parent, runConfig)
	defer cancel()

	isReadQuery := isReadOnlySQLQuery(runConfig.Type, query)
	tryQueryFirst := shouldTryQueryResultFirst(runConfig.Type, query)

	if isReadQuery || tryQueryFirst {
		var (
			data     []map[string]interface{}
			columns  []string
			messages []string
		)
		if q, ok := dbInst.(db.QueryMessageExecer); ok {
			data, columns, messages, err = q.QueryContextWithMessages(ctx, query)
		} else if q, ok := dbInst.(interface {
			QueryContext(context.Context, string) ([]map[string]interface{}, []string, error)
		}); ok {
			data, columns, err = q.QueryContext(ctx, query)
		} else {
			if contextErr := ctx.Err(); contextErr != nil {
				return buildQueryExecutionFailure(ctx, contextErr, contextErr.Error(), "")
			}
			data, columns, err = dbInst.Query(query)
			if ctx.Err() != nil {
				return a.buildCancellationUnsupportedExecutionResult(connection.QueryResult{
					Data: data, Fields: columns, Messages: messages,
				}, err)
			}
		}
		if err == nil {
			return connection.QueryResult{Success: true, Data: data, Fields: columns, Messages: messages}
		}
		if isReadQuery {
			logger.Error(err, "DBQueryIsolated 查询失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		err = classifyDispatchedWriteError(err)
		logger.Error(err, "DBQueryIsolated 写入查询失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
		return buildWriteExecutionFailure(ctx, err, "")
	}

	var affected int64
	if e, ok := dbInst.(interface {
		ExecContext(context.Context, string) (int64, error)
	}); ok {
		affected, err = e.ExecContext(ctx, query)
	} else {
		if contextErr := ctx.Err(); contextErr != nil {
			return buildQueryExecutionFailure(ctx, contextErr, contextErr.Error(), "")
		}
		affected, err = dbInst.Exec(query)
		if ctx.Err() != nil {
			return a.buildCancellationUnsupportedExecutionResult(connection.QueryResult{
				Data: map[string]int64{"affectedRows": affected},
			}, err)
		}
	}
	if err != nil {
		err = classifyDispatchedWriteError(err)
		logger.Error(err, "DBQueryIsolated 执行失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
		return buildWriteExecutionFailure(ctx, err, "")
	}
	return connection.QueryResult{Success: true, Data: map[string]int64{"affectedRows": affected}}
}

func sqlSnippet(query string) string {
	q := strings.TrimSpace(sqlaudit.RedactSQL(query))
	const max = 200
	if len([]rune(q)) <= max {
		return q
	}
	return string([]rune(q)[:max]) + "..."
}

func ensureNonNilSlice[T any](items []T) []T {
	if items == nil {
		return make([]T, 0)
	}
	return items
}

func resolveConfiguredMongoDatabase(config connection.ConnectionConfig) string {
	if !strings.EqualFold(strings.TrimSpace(config.Type), "mongodb") {
		return ""
	}
	if database := strings.TrimSpace(config.Database); database != "" {
		return database
	}

	rawURI := strings.TrimSpace(config.URI)
	lowerURI := strings.ToLower(rawURI)
	if !strings.HasPrefix(lowerURI, "mongodb://") && !strings.HasPrefix(lowerURI, "mongodb+srv://") {
		return ""
	}
	parsed, err := url.Parse(rawURI)
	if err != nil {
		return ""
	}
	database := strings.Trim(strings.TrimSpace(parsed.Path), "/")
	if database == "" || strings.Contains(database, "/") {
		return ""
	}
	return database
}
