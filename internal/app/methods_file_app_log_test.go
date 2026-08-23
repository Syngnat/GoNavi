package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadAppLogTailByPathReturnsLatestLinesAndLevelBreakdown(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "gonavi.log")
	content := "" +
		"2026/06/09 10:00:00.000000 [INFO] boot ok\n" +
		"2026/06/09 10:00:01.000000 [WARN] slow mcp start\n" +
		"2026/06/09 10:00:02.000000 [ERROR] mysql dial failed\n"
	if err := os.WriteFile(logPath, []byte(content), 0o644); err != nil {
		t.Fatalf("write log failed: %v", err)
	}

	result := readAppLogTailByPath(logPath, 2, "")
	if !result.Success {
		t.Fatalf("expected success, got failure: %s", result.Message)
	}

	snapshot, ok := result.Data.(appLogTailSnapshot)
	if !ok {
		t.Fatalf("expected appLogTailSnapshot, got %T", result.Data)
	}
	if snapshot.ReturnedLineCount != 2 {
		t.Fatalf("expected 2 returned lines, got %d", snapshot.ReturnedLineCount)
	}
	if !snapshot.MatchedLinesTruncated {
		t.Fatal("expected matched lines to be truncated when requesting fewer lines than available")
	}
	if snapshot.LevelBreakdown["WARN"] != 1 || snapshot.LevelBreakdown["ERROR"] != 1 {
		t.Fatalf("unexpected level breakdown: %#v", snapshot.LevelBreakdown)
	}
	if snapshot.Lines[0] != "2026/06/09 10:00:01.000000 [WARN] slow mcp start" {
		t.Fatalf("unexpected first returned line: %s", snapshot.Lines[0])
	}
	if snapshot.Lines[1] != "2026/06/09 10:00:02.000000 [ERROR] mysql dial failed" {
		t.Fatalf("unexpected second returned line: %s", snapshot.Lines[1])
	}
}

func TestReadAppLogTailByPathRedactsSQLLiterals(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "gonavi.log")
	content := "2026/08/17 10:00:00.000000 [ERROR] DBQuery 查询失败 SQL片段=\"SELECT * FROM users WHERE phone = '13800138000' AND token = 'raw-token'\"\n"
	if err := os.WriteFile(logPath, []byte(content), 0o644); err != nil {
		t.Fatalf("write log failed: %v", err)
	}

	result := readAppLogTailByPath(logPath, 10, "")
	if !result.Success {
		t.Fatalf("expected success, got failure: %s", result.Message)
	}
	snapshot, ok := result.Data.(appLogTailSnapshot)
	if !ok || len(snapshot.Lines) != 1 {
		t.Fatalf("expected one log line, got %#v", result.Data)
	}
	if strings.Contains(snapshot.Lines[0], "13800138000") || strings.Contains(snapshot.Lines[0], "raw-token") {
		t.Fatalf("log tail returned raw SQL literal: %q", snapshot.Lines[0])
	}
}
func TestReadAppLogTailByPathRedactsUnquotedSQLLiterals(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "gonavi.log")
	content := "2026/08/17 10:00:00.000000 [ERROR] DBQuery 查询失败 SQL片段=SELECT * FROM users WHERE id = 42 AND token = raw-token\n"
	if err := os.WriteFile(logPath, []byte(content), 0o644); err != nil {
		t.Fatalf("write log failed: %v", err)
	}

	result := readAppLogTailByPath(logPath, 10, "")
	if !result.Success {
		t.Fatalf("expected success, got failure: %s", result.Message)
	}
	snapshot := result.Data.(appLogTailSnapshot)
	if strings.Contains(snapshot.Lines[0], "42") || strings.Contains(snapshot.Lines[0], "raw-token") {
		t.Fatalf("log tail returned unquoted SQL literal: %q", snapshot.Lines[0])
	}
}
func TestReadAppLogTailByPathFiltersByKeywordCaseInsensitively(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "gonavi.log")
	content := "" +
		"2026/06/09 10:00:00.000000 [INFO] bootstrap ok\n" +
		"2026/06/09 10:00:01.000000 [ERROR] MCP start failed\n" +
		"2026/06/09 10:00:02.000000 [WARN] retry mcp connection\n"
	if err := os.WriteFile(logPath, []byte(content), 0o644); err != nil {
		t.Fatalf("write log failed: %v", err)
	}

	result := readAppLogTailByPath(logPath, 10, "mCp")
	if !result.Success {
		t.Fatalf("expected success, got failure: %s", result.Message)
	}

	snapshot, ok := result.Data.(appLogTailSnapshot)
	if !ok {
		t.Fatalf("expected appLogTailSnapshot, got %T", result.Data)
	}
	if snapshot.ReturnedLineCount != 2 {
		t.Fatalf("expected 2 matched lines, got %d", snapshot.ReturnedLineCount)
	}
	if snapshot.Keyword != "mCp" {
		t.Fatalf("expected original keyword to be preserved, got %q", snapshot.Keyword)
	}
	if snapshot.LevelBreakdown["ERROR"] != 1 || snapshot.LevelBreakdown["WARN"] != 1 {
		t.Fatalf("unexpected level breakdown after keyword filter: %#v", snapshot.LevelBreakdown)
	}
}

func TestReadAppLogTailByPathUsesLocalizedMissingLogMessage(t *testing.T) {
	result := readAppLogTailByPath("", 10, "")
	if result.Success {
		t.Fatalf("expected missing log path to fail")
	}
	if result.Message != "file.backend.error.app_log_file_not_found" {
		t.Fatalf("expected localized missing log key, got %q", result.Message)
	}
}
