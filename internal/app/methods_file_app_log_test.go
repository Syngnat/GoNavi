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
func TestReadAppLogTailRedactsRedisCommandLogFields(t *testing.T) {
	tests := []struct {
		name     string
		content  string
		secrets  []string
		wantPart string
	}{
		{
			name:     "auth",
			content:  "2026/09/15 10:00:00.000000 [ERROR] RedisExecuteCommand 执行失败：command=AUTH default auth-secret；错误链：WRONGPASS invalid username-password pair\n",
			secrets:  []string{"default", "auth-secret"},
			wantPart: "AUTH ? ?",
		},
		{
			name:     "hello auth",
			content:  "2026/09/15 10:00:01.000000 [ERROR] RedisExecuteCommand 执行失败：command=HELLO 3 AUTH app hello-secret SETNAME client-secret；错误链：ERR Protocol error\n",
			secrets:  []string{"app", "hello-secret", "client-secret"},
			wantPart: "HELLO 3 AUTH ? ? SETNAME ?",
		},
		{
			name:     "quoted auth",
			content:  "2026/09/15 10:00:02.000000 [ERROR] RedisExecuteCommand 执行失败：command=\"AUTH default quoted-secret\"；错误链：WRONGPASS\n",
			secrets:  []string{"default", "quoted-secret"},
			wantPart: "AUTH ? ?",
		},
		{
			name:     "set keeps key",
			content:  "2026/09/15 10:00:03.000000 [ERROR] RedisExecuteCommand 执行失败：command=SET session:key set-secret EX 60；错误链：READONLY You can't write against a read only replica\n",
			secrets:  []string{"set-secret", "60"},
			wantPart: "SET session:key ?",
		},
		{
			name:     "unparseable omits payload",
			content:  "2026/09/15 10:00:04.000000 [ERROR] RedisExecuteCommand 执行失败：command=SET key \"unterminated-secret；错误链：ERR syntax\n",
			secrets:  []string{"unterminated-secret"},
			wantPart: "SET",
		},
		{
			name:     "unknown command echo in error chain",
			content:  "2026/09/15 10:00:05.000000 [ERROR] RedisExecuteCommand 执行失败：command=AUUTH default auth-secret；错误链：ERR unknown command 'AUUTH', with args beginning with: 'default' 'auth-secret'\n",
			secrets:  []string{"auth-secret"},
			wantPart: "command=AUUTH",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			logPath := filepath.Join(dir, "gonavi.log")
			if err := os.WriteFile(logPath, []byte(tt.content), 0o644); err != nil {
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
			got := snapshot.Lines[0]
			for _, secret := range tt.secrets {
				if strings.Contains(got, secret) {
					t.Fatalf("log tail leaked %q in %q", secret, got)
				}
			}
			if !strings.Contains(got, tt.wantPart) {
				t.Fatalf("log tail missing %q in %q", tt.wantPart, got)
			}
			if !strings.Contains(got, "错误链") {
				t.Fatalf("log tail dropped error chain: %q", got)
			}
		})
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
