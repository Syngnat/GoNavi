package app

import (
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// applyRowBudgetTruncation 把当前结果的停读或字段预览标记落到最后物化的结果集上。
// 多结果集扫描路径已在结果集内自带标记，此处覆盖单结果集接口。
func applyRowBudgetTruncation(results []connection.ResultSetData, budget *db.RowBudget) {
	if budget == nil || !budget.TakeResultTruncated() || len(results) == 0 {
		return
	}
	results[len(results)-1].Truncated = true
}

func normalizeNativeResultStatementIndexes(dbType string, statements []string, results []connection.ResultSetData) {
	if len(results) == 0 {
		return
	}
	hasExplicitStatementIndex := false
	for _, result := range results {
		if result.StatementIndex > 0 {
			hasExplicitStatementIndex = true
			break
		}
	}
	if hasExplicitStatementIndex {
		return
	}

	if supportsSequentialNativeSelectIndexes(dbType) {
		if len(results) > len(statements) {
			return
		}
		for _, statement := range statements {
			if sqlDataOperationKeyword(statement, dbType) != "select" {
				return
			}
		}
		// MySQL-family native batches are used only for read-only statements.
		// A regular SELECT contributes one result set, and a row budget may stop
		// scanning at any leading prefix, so prefix indexes remain exact.
		for idx := range results {
			results[idx].StatementIndex = idx + 1
		}
		return
	}

	if !isSQLServerDBType(dbType) {
		return
	}

	switch {
	case len(statements) <= 1:
		for idx := range results {
			results[idx].StatementIndex = 1
		}
	case len(results) == len(statements):
		for idx := range results {
			results[idx].StatementIndex = idx + 1
		}
	case len(results) == len(statements)*2:
		// go-mssqldb 会在每个 SELECT 数据结果后再发送一条 MsgRowsAffected。
		// 仅在整个批次严格呈现 [数据结果, affectedRows] 成对结构时补索引，
		// 避免把存储过程返回的多个真实结果集错误归并到不同语句。
		for statementIdx := range statements {
			resultIdx := statementIdx * 2
			if isAffectedRowsResultSet(results[resultIdx]) || !isAffectedRowsResultSet(results[resultIdx+1]) {
				return
			}
		}
		for statementIdx := range statements {
			resultIdx := statementIdx * 2
			results[resultIdx].StatementIndex = statementIdx + 1
			results[resultIdx+1].StatementIndex = statementIdx + 1
		}
	}
}

func supportsSequentialNativeSelectIndexes(dbType string) bool {
	switch normalizeExplainLexicalDBType(dbType) {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "goldendb", "sphinx", "tidb":
		return true
	default:
		return false
	}
}

// nativeResultExecutedStatementCount reports a completed leading statement
// prefix only when result-set indexes prove that mapping. A stored procedure
// can emit multiple result sets, so result-set count alone is not evidence of
// how many statements completed.
func nativeResultExecutedStatementCount(statements []string, results []connection.ResultSetData) (int, bool) {
	if len(results) == 0 {
		return 0, true
	}
	completed := make(map[int]struct{}, len(results))
	for _, result := range results {
		if result.StatementIndex < 1 || result.StatementIndex > len(statements) {
			return 0, false
		}
		completed[result.StatementIndex] = struct{}{}
	}
	for index := 1; index <= len(statements); index++ {
		if _, ok := completed[index]; !ok {
			for later := index + 1; later <= len(statements); later++ {
				if _, found := completed[later]; found {
					return 0, false
				}
			}
			return index - 1, true
		}
	}
	return len(statements), true
}

func nativeReadOnlyResultsMissingTabularPayload(allReadOnly bool, results []connection.ResultSetData) bool {
	if !allReadOnly || results == nil {
		return false
	}
	if len(results) == 0 {
		return true
	}
	for _, result := range results {
		if isAffectedRowsResultSet(result) {
			continue
		}
		if len(result.Columns) > 0 || len(result.Rows) > 0 {
			return false
		}
	}
	return true
}

func shouldFallbackToPlainQueryAfterMultiResult(readOnly bool, results []connection.ResultSetData, messages []string) bool {
	if !readOnly {
		return false
	}
	// Optional driver agents use nil results with no messages to signal that the
	// native multi-result method is unsupported. Retrying is only safe for reads;
	// query-first writes and stored procedures may already have side effects.
	if results == nil && len(messages) == 0 {
		return true
	}
	return nativeReadOnlyResultsMissingTabularPayload(true, results)
}

func shouldUseNativeMultiResultBatch(dbType string, statements []string, allReadOnly bool) bool {
	if allReadOnly {
		return !shouldPreferPlainReadQueryResult(dbType)
	}
	if !strings.EqualFold(strings.TrimSpace(dbType), "sqlserver") {
		return false
	}
	for _, stmt := range statements {
		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			continue
		}
		if isReadOnlySQLQuery(dbType, stmt) || shouldTryQueryResultFirst(dbType, stmt) {
			continue
		}
		return false
	}
	return true
}

func shouldPreferPlainReadQueryResult(dbType string) bool {
	switch strings.ToLower(strings.TrimSpace(dbType)) {
	case "sqlite",
		"postgres", "postgresql",
		"oracle",
		"kingbase", "kingbase8", "kingbasees", "kingbasev8",
		"highgo", "vastbase",
		"opengauss", "open_gauss", "open-gauss",
		"gaussdb", "gauss_db", "gauss-db",
		"dameng", "dm", "dm8":
		return true
	case "tdengine", "kafka", "rocketmq", "pulsar":
		// These only implement the plain query API. The optional driver-agent
		// exposes a transport-level multi-result method, but reports it unsupported.
		// Skipping that probe prevents a successful SELECT from becoming an empty result.
		return true
	case "trino":
		// Trino（以及借用其方言的 Presto）一条语句就是一次 HTTP 查询，驱动没有多结果集接口；
		// 带结果预算时代理会直接拒绝多结果集调用，只读语句必须走普通查询接口。
		return true
	case "iotdb", "apache-iotdb", "apache_iotdb",
		"clickhouse",
		"elasticsearch", "elastic",
		"duckdb",
		"mongodb":
		// 这些可选驱动的具体实现只有普通查询接口。查询编辑器会附带结果预算，
		// 只读语句走 QueryContext，预算才能在扫描时生效。
		return true
	default:
		return registryPrefersPlainReadQuery(dbType)
	}
}

func shouldTryQueryResultFirst(dbType string, query string) bool {
	isSQLServer := isSQLServerDBType(dbType)
	if sqlWriteStatementReturnsRows(dbType, query) {
		return true
	}
	keyword := leadingSQLKeyword(query)
	if normalizeSQLClassifierDBType(dbType) == "mqtt" && keyword == "unsubscribe" {
		// MQTT models UNSUBSCRIBE as a query command because it returns the
		// released topic filter. Route it through QueryContext instead of the
		// JSON-only publish Exec path.
		return true
	}
	switch keyword {
	case "explain", "pragma":
		return true
	case "exec", "execute", "call":
		return true
	case "set", "print":
		return isSQLServer
	case "dbcc":
		return isSQLServer
	case "do":
		return isPostgresNoticeCapableDBType(dbType) && strings.Contains(strings.ToLower(query), "raise")
	default:
		if isSQLServer {
			if strings.HasPrefix(keyword, "sp_") || strings.HasPrefix(keyword, "xp_") {
				return true
			}
			if sqlServerControlFlowMayReturnMessages(query) {
				return true
			}
			return looksLikeSQLServerProcedureInvocation(query)
		}
		return false
	}
}

func looksLikeSQLServerProcedureInvocation(query string) bool {
	switch leadingSQLKeyword(query) {
	case "select", "with", "insert", "update", "delete", "merge", "replace", "upsert",
		"if", "begin", "declare", "while", "create", "alter", "drop", "truncate", "grant", "revoke",
		"use", "set", "print", "dbcc", "commit", "rollback", "save", "return", "throw", "raiserror",
		"waitfor", "open", "fetch", "close", "deallocate":
		return false
	}

	pos := skipSQLTrivia(query, 0)
	if pos >= len(query) {
		return false
	}

	next, ok := skipSQLIdentifierToken(query, pos, "sqlserver")
	if !ok || next <= pos {
		return false
	}
	pos = skipSQLTrivia(query, next)
	for pos < len(query) && query[pos] == '.' {
		pos = skipSQLTrivia(query, pos+1)
		next, ok = skipSQLIdentifierToken(query, pos, "sqlserver")
		if !ok || next <= pos {
			return false
		}
		pos = skipSQLTrivia(query, next)
	}

	if pos >= len(query) {
		return true
	}
	switch ch := query[pos]; {
	case ch == ';' || ch == ',' || ch == '@' || ch == '\'' || ch == '"' || ch == '[' || ch == '(':
		return true
	case ch == '+' || ch == '-':
		return true
	case ch >= '0' && ch <= '9':
		return true
	default:
		keyword, _ := nextSQLKeyword(query, pos)
		return keyword != ""
	}
}
