package app

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestAnalyzeQueryParametersEchoesFullStatementsBelowThreshold(t *testing.T) {
	app := &App{}
	sql := "SELECT * FROM users WHERE id = :id;\nSELECT 1;"
	result := app.AnalyzeQueryParameters(connection.ConnectionConfig{Type: "mysql"}, "main", sql, true)

	if len(result.Statements) != 2 {
		t.Fatalf("expected 2 statements, got %d", len(result.Statements))
	}
	if result.Statements[0].Text != "SELECT * FROM users WHERE id = :id" {
		t.Fatalf("unexpected first statement text: %q", result.Statements[0].Text)
	}
	if result.Statements[1].Text != "SELECT 1" {
		t.Fatalf("unexpected second statement text: %q", result.Statements[1].Text)
	}
}

// 10MB 级文档原样回显等于每次「分析」都把整篇 SQL 再传一遍；这里锁定
// 超过阈值后不再回显无参数语句，且带参数语句只给预览。
func TestAnalyzeQueryParametersTrimsStatementEchoForOversizedSQL(t *testing.T) {
	app := &App{}
	var builder strings.Builder
	builder.WriteString("SELECT * FROM users WHERE id = :id;\n")
	filler := strings.Repeat("SELECT 1;\n", 200_000)
	builder.WriteString(filler)
	sql := builder.String()
	if len(sql) <= queryParameterAnalysisEchoThresholdBytes {
		t.Fatalf("fixture too small: %d bytes", len(sql))
	}

	result := app.AnalyzeQueryParameters(connection.ConnectionConfig{Type: "mysql"}, "main", sql, true)

	if len(result.ParameterNames) != 1 || result.ParameterNames[0] != "id" {
		t.Fatalf("parameter names must still be discovered: %v", result.ParameterNames)
	}
	totalEcho := 0
	for _, statement := range result.Statements {
		if len(statement.Parameters) == 0 && statement.Text != "" {
			t.Fatalf("param-less statement should not echo text, got %d bytes", len(statement.Text))
		}
		totalEcho += len(statement.Text)
	}
	if totalEcho > queryParameterAnalysisEchoBudgetBytes {
		t.Fatalf("echo budget exceeded: %d bytes", totalEcho)
	}
	if len(result.Statements) == 0 || result.Statements[0].Parameters[0] != "id" {
		t.Fatalf("first statement must keep its parameters")
	}
	if result.Statements[0].Text == "" || len(result.Statements[0].Text) > queryParameterStatementPreviewMaxBytes {
		t.Fatalf("parameterized statement preview out of bounds: %d bytes", len(result.Statements[0].Text))
	}
}

func TestAnalyzeQueryParametersSkipsScanWhenNoPlaceholderCharacters(t *testing.T) {
	app := &App{}
	sql := strings.Repeat("SELECT 1 FROM dual;\n", 100_000)
	result := app.AnalyzeQueryParameters(connection.ConnectionConfig{Type: "mongodb"}, "", sql, true)
	if result.Supported {
		t.Fatalf("mongodb must not declare parameter binding support")
	}
	if len(result.ParameterNames) != 0 {
		t.Fatalf("expected no parameter names, got %v", result.ParameterNames)
	}
	if len(result.Statements) != 0 {
		t.Fatalf("unsupported-driver fast path must not build statements, got %d", len(result.Statements))
	}
}
