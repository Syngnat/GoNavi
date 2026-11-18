package app

import (
	"strings"

	"GoNavi-Wails/internal/connection"
)

// DBQueryMulti 执行可能包含多条 SQL 语句的查询，返回多个结果集。
// 如果底层驱动支持 MultiResultQuerier，一次性执行所有语句；
// 否则按分号拆分后逐条执行，模拟多结果集。
func (a *App) DBQueryMulti(config connection.ConnectionConfig, dbName string, query string, queryID string) connection.QueryResult {
	explicitQuery := strings.TrimSpace(queryID) != ""
	auditSource := "query_editor"
	if !explicitQuery {
		auditSource = "application_api"
	}
	return a.dbQueryMulti(config, dbName, query, queryID, dbQueryMultiAuditOptions{
		auditAll:    explicitQuery || a.webRuntime,
		auditWrites: true,
		source:      auditSource,
	})
}

func (a *App) buildDBQueryMultiStatementFailureMessage(index int, err error, previousSuccessCount int) string {
	message := a.appText("db.backend.error.multi_statement_execution_failed", map[string]any{
		"index":  index,
		"detail": err.Error(),
	})
	if previousSuccessCount > 0 {
		message += a.appText("db.backend.error.multi_statement_previous_success", map[string]any{
			"count": previousSuccessCount,
		})
	}
	return message
}
