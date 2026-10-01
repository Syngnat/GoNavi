package app

import (
	"context"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// 可选驱动代理（如 KingBase）不支持原生多结果集时，数据库层用 nil 结果表示“不支持”
// （见 OptionalDriverAgentDB.QueryMultiContextWithMessages）。EXPLAIN 必须像普通查询一样
// 退回单结果查询，而不是报「未返回 EXPLAIN 结果集」。
func TestExecuteExplainStatementsFallsBackWhenNativeMultiResultUnsupported(t *testing.T) {
	const wrapped = "EXPLAIN (FORMAT JSON) SELECT 1"
	const plan = `[{"Plan":{"Node Type":"Result","Startup Cost":0.0,"Total Cost":0.01,"Plan Rows":1,"Plan Width":4}}]`
	database := &fakeUnsupportedMultiResultDB{fakeBatchWriteDB: &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{wrapped: {{"QUERY PLAN": plan}}},
		fieldMap: map[string][]string{wrapped: {"QUERY PLAN"}},
	}}

	raw, format, err := executeExplainStatementsWithText(
		context.Background(), database, "kingbase", wrapped, nil,
		connection.ExplainFormatJSON, defaultExplainBackendText,
	)
	if err != nil {
		t.Fatalf("native multi-result unsupported should fall back to single-result query, got error: %v", err)
	}
	if database.multiCalls != 1 {
		t.Fatalf("multiCalls = %d, want 1 (probe the native multi-result API once)", database.multiCalls)
	}
	if database.queryCalls != 1 || len(database.queryQueries) != 1 || database.queryQueries[0] != wrapped {
		t.Fatalf("fallback queries = %v (calls=%d), want exactly the EXPLAIN statement once", database.queryQueries, database.queryCalls)
	}
	if raw != plan || format != connection.ExplainFormatJSON {
		t.Fatalf("raw/format = %q/%q, want the JSON plan", raw, format)
	}

	result, err := parseExplainRawWithText("kingbase", "SELECT 1", raw, format, defaultExplainBackendText)
	if err != nil {
		t.Fatalf("parse fallback plan: %v", err)
	}
	if result.DBType != "kingbase" {
		t.Fatalf("result.DBType = %q, want kingbase", result.DBType)
	}
}

// 带后置查询的方言（Oracle 的 DBMS_XPLAN）无法靠单结果查询还原，保持原有的“未返回结果集”错误，
// 不能悄悄丢掉后置查询返回一份残缺的计划。
func TestExecuteExplainStatementsKeepsMissingErrorWhenPostQueriesPresent(t *testing.T) {
	const wrapped = "EXPLAIN PLAN FOR SELECT 1"
	database := &fakeUnsupportedMultiResultDB{fakeBatchWriteDB: &fakeBatchWriteDB{}}

	_, _, err := executeExplainStatementsWithText(
		context.Background(), database, "oracle", wrapped, []string{"SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY)"},
		connection.ExplainFormatTable, defaultExplainBackendText,
	)
	if err == nil {
		t.Fatal("expected missing-result error when post queries cannot be replayed through single-result fallback")
	}
	if want := defaultExplainBackendText("sql_analysis.backend.error.explain_result_missing", nil); !strings.Contains(err.Error(), want) {
		t.Fatalf("error = %q, want it to contain %q", err.Error(), want)
	}
	if database.queryCalls != 0 {
		t.Fatalf("queryCalls = %d, want 0: must not run a partial single-result fallback", database.queryCalls)
	}
}
