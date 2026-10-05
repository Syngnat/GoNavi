package mcpserver

import (
	"context"
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/connection"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestExecuteSQLAllowsDMLWhenAISafetyIsReadWriteWithoutAllowMutating(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID: "mysql-main",
			Config: connection.ConnectionConfig{
				Type:     "mysql",
				Database: "app",
			},
		},
		inspection: appcore.SQLInspection{
			StatementCount: 1,
			ReadOnly:       false,
			Statements: []appcore.SQLStatementInspection{
				{Index: 1, Keyword: "delete", ReadOnly: false},
			},
		},
		safetyLevel: ai.PermissionReadWrite,
		queryResult: connection.QueryResult{
			Success: true,
			Data:    []connection.ResultSetData{},
		},
	}

	service := NewService(backend)
	result, _, err := service.ExecuteSQL(context.Background(), nil, executeSQLArgs{
		ConnectionID: "mysql-main",
		SQL:          "delete from users where id = 1",
	})
	if err != nil {
		t.Fatalf("ExecuteSQL returned error: %v", err)
	}
	if result == nil || result.IsError {
		t.Fatalf("expected success without allowMutating, got %#v", result)
	}
	if !backend.queryCalled {
		t.Fatal("expected SQL to execute under readwrite safety")
	}
}

func TestExecuteSQLRejectsMutatingStatementsWhenAISafetyIsReadOnly(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID: "mysql-main",
			Config: connection.ConnectionConfig{
				Type:     "mysql",
				Database: "app",
			},
		},
		inspection: appcore.SQLInspection{
			StatementCount: 1,
			ReadOnly:       false,
			Statements: []appcore.SQLStatementInspection{
				{Index: 1, Keyword: "delete", ReadOnly: false},
			},
		},
		safetyLevel: ai.PermissionReadOnly,
	}

	service := NewService(backend)
	result, _, err := service.ExecuteSQL(context.Background(), nil, executeSQLArgs{
		ConnectionID:  "mysql-main",
		SQL:           "delete from users where id = 1",
		AllowMutating: true,
	})
	if err != nil {
		t.Fatalf("ExecuteSQL returned error: %v", err)
	}
	if result == nil || !result.IsError {
		t.Fatalf("expected tool error, got %#v", result)
	}
	if !strings.Contains(firstTextContent(result), "只读模式") {
		t.Fatalf("unexpected error text: %q", firstTextContent(result))
	}
	if backend.queryCalled {
		t.Fatalf("expected SQL not to execute when AI safety is readonly")
	}
}

func TestExecuteSQLRejectsDDLWhenAISafetyIsReadWrite(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID: "mysql-main",
			Config: connection.ConnectionConfig{
				Type:     "mysql",
				Database: "app",
			},
		},
		inspection: appcore.SQLInspection{
			StatementCount: 1,
			ReadOnly:       false,
			Statements: []appcore.SQLStatementInspection{
				{Index: 1, Keyword: "drop", ReadOnly: false},
			},
		},
		safetyLevel: ai.PermissionReadWrite,
	}

	service := NewService(backend)
	result, _, err := service.ExecuteSQL(context.Background(), nil, executeSQLArgs{
		ConnectionID:  "mysql-main",
		SQL:           "drop table users",
		AllowMutating: true,
	})
	if err != nil {
		t.Fatalf("ExecuteSQL returned error: %v", err)
	}
	if result == nil || !result.IsError {
		t.Fatalf("expected tool error, got %#v", result)
	}
	text := firstTextContent(result)
	if !strings.Contains(text, "读写模式") || !strings.Contains(text, "DDL") {
		t.Fatalf("unexpected error text: %q", text)
	}
	if backend.queryCalled {
		t.Fatalf("expected SQL not to execute when AI safety blocks DDL")
	}
}

func TestExecuteSQLRejectsMixedStatementsWhenAISafetyBlocksLaterStatement(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID: "mysql-main",
			Config: connection.ConnectionConfig{
				Type:     "mysql",
				Database: "app",
			},
		},
		inspection: appcore.SQLInspection{
			StatementCount: 2,
			ReadOnly:       false,
			Statements: []appcore.SQLStatementInspection{
				{Index: 1, Keyword: "select", ReadOnly: true},
				{Index: 2, Keyword: "delete", ReadOnly: false},
			},
		},
		safetyLevel: ai.PermissionReadOnly,
	}

	service := NewService(backend)
	result, _, err := service.ExecuteSQL(context.Background(), nil, executeSQLArgs{
		ConnectionID:  "mysql-main",
		SQL:           "select * from users; delete from users where id = 1",
		AllowMutating: true,
	})
	if err != nil {
		t.Fatalf("ExecuteSQL returned error: %v", err)
	}
	if result == nil || !result.IsError {
		t.Fatalf("expected tool error, got %#v", result)
	}
	if !strings.Contains(firstTextContent(result), "#2 delete") {
		t.Fatalf("unexpected error text: %q", firstTextContent(result))
	}
	if backend.queryCalled {
		t.Fatalf("expected SQL not to execute when a later statement is blocked")
	}
}

func TestExecuteSQLAllowsDMLWhenAISafetyIsReadWriteAndAllowMutating(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID: "mysql-main",
			Config: connection.ConnectionConfig{
				Type:     "mysql",
				Database: "app",
			},
		},
		inspection: appcore.SQLInspection{
			StatementCount: 1,
			ReadOnly:       false,
			Statements: []appcore.SQLStatementInspection{
				{Index: 1, Keyword: "insert", ReadOnly: false},
			},
		},
		safetyLevel: ai.PermissionReadWrite,
		queryResult: connection.QueryResult{
			Success: true,
			Data:    []connection.ResultSetData{},
		},
	}

	service := NewService(backend)
	result, out, err := service.ExecuteSQL(context.Background(), nil, executeSQLArgs{
		ConnectionID:  "mysql-main",
		SQL:           "insert into users(id) values (1)",
		AllowMutating: true,
	})
	if err != nil {
		t.Fatalf("ExecuteSQL returned error: %v", err)
	}
	if result == nil || result.IsError {
		t.Fatalf("expected success result, got %#v", result)
	}
	if !backend.queryCalled {
		t.Fatalf("expected SQL to be executed")
	}
	if out.ReadOnly {
		t.Fatalf("expected mutating SQL result, got %#v", out)
	}
}

func TestExecuteSQLRejectsConnectionWriteProtection(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID:     "mysql-main",
			Config: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		},
		inspection: appcore.SQLInspection{
			StatementCount: 1,
			ReadOnly:       false,
			Statements:     []appcore.SQLStatementInspection{{Index: 1, Keyword: "update", ReadOnly: false}},
		},
		safetyLevel:  ai.PermissionReadWrite,
		authorizeErr: errors.New("data editing is disabled for this connection"),
	}

	result, _, err := NewService(backend).ExecuteSQL(context.Background(), nil, executeSQLArgs{
		ConnectionID:  "mysql-main",
		SQL:           "UPDATE users SET active = 1",
		AllowMutating: true,
	})
	if err != nil {
		t.Fatalf("ExecuteSQL returned error: %v", err)
	}
	if result == nil || !result.IsError || backend.queryCalled {
		t.Fatalf("connection protection should stop execution: result=%#v called=%t", result, backend.queryCalled)
	}
	if !strings.Contains(firstTextContent(result), "data editing is disabled") {
		t.Fatalf("unexpected protection error: %q", firstTextContent(result))
	}
	if backend.authorizeCalls != 1 {
		t.Fatalf("connection authorization calls = %d, want 1", backend.authorizeCalls)
	}
}

func TestExecuteSQLAuthorizesExactlyOnceBeforeExecution(t *testing.T) {
	tests := []struct {
		name          string
		sql           string
		keyword       string
		readOnly      bool
		safetyLevel   ai.SQLPermissionLevel
		allowMutating bool
	}{
		{name: "query", sql: "SELECT 1", keyword: "select", readOnly: true, safetyLevel: ai.PermissionReadOnly},
		{name: "DML", sql: "UPDATE users SET active = 1", keyword: "update", safetyLevel: ai.PermissionReadWrite, allowMutating: true},
		{name: "DDL", sql: "CREATE TABLE audit_probe(id INT)", keyword: "create", safetyLevel: ai.PermissionFull, allowMutating: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			config := connection.ConnectionConfig{ID: "postgres-main", Type: "postgres", Database: "app"}
			backend := &fakeBackend{
				editableConnection: connection.SavedConnectionView{ID: config.ID, Config: config},
				inspection: appcore.SQLInspection{
					StatementCount: 1,
					ReadOnly:       test.readOnly,
					Statements:     []appcore.SQLStatementInspection{{Index: 1, Keyword: test.keyword, ReadOnly: test.readOnly}},
				},
				safetyLevel: test.safetyLevel,
				queryResult: connection.QueryResult{Success: true, Data: []connection.ResultSetData{}},
			}

			result, _, err := NewService(backend).ExecuteSQL(context.Background(), nil, executeSQLArgs{
				ConnectionID:  config.ID,
				SQL:           test.sql,
				AllowMutating: test.allowMutating,
			})
			if err != nil || result == nil || result.IsError {
				t.Fatalf("ExecuteSQL result=%#v err=%v", result, err)
			}
			if backend.authorizeCalls != 1 || backend.authorizedConfig.ID != config.ID || backend.authorizedSQL != test.sql {
				t.Fatalf("authorization calls=%d config=%#v sql=%q", backend.authorizeCalls, backend.authorizedConfig, backend.authorizedSQL)
			}
			if strings.Join(backend.events, ",") != "authorize,query" {
				t.Fatalf("execution order = %v, want authorize before query", backend.events)
			}
		})
	}
}

func TestExecuteSQLRejectsInconsistentSafetyInspection(t *testing.T) {
	tests := []struct {
		name       string
		inspection appcore.SQLInspection
	}{
		{
			name: "statement count mismatch",
			inspection: appcore.SQLInspection{
				StatementCount: 1,
				ReadOnly:       true,
			},
		},
		{
			name: "aggregate read-only mismatch",
			inspection: appcore.SQLInspection{
				StatementCount: 1,
				ReadOnly:       true,
				Statements:     []appcore.SQLStatementInspection{{Index: 1, Keyword: "update", ReadOnly: false}},
			},
		},
		{
			name: "non-sequential statement index",
			inspection: appcore.SQLInspection{
				StatementCount: 1,
				ReadOnly:       false,
				Statements:     []appcore.SQLStatementInspection{{Index: 2, Keyword: "update", ReadOnly: false}},
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			backend := &fakeBackend{
				editableConnection: connection.SavedConnectionView{
					ID:     "postgres-main",
					Config: connection.ConnectionConfig{Type: "postgres", Database: "app"},
				},
				inspection:  test.inspection,
				safetyLevel: ai.PermissionFull,
				queryResult: connection.QueryResult{Success: true, Data: []connection.ResultSetData{}},
			}

			result, _, err := NewService(backend).ExecuteSQL(context.Background(), nil, executeSQLArgs{
				ConnectionID:  "postgres-main",
				SQL:           "UPDATE users SET active = 1",
				AllowMutating: true,
			})
			if err != nil {
				t.Fatalf("ExecuteSQL returned error: %v", err)
			}
			if result == nil || !result.IsError || backend.authorizeCalls != 0 || backend.queryCalled {
				t.Fatalf("inconsistent inspection crossed execution boundary: result=%#v authorize=%d query=%t", result, backend.authorizeCalls, backend.queryCalled)
			}
			if !strings.Contains(firstTextContent(result), "安全检查结果无效") {
				t.Fatalf("unexpected error text: %q", firstTextContent(result))
			}
		})
	}
}

func TestExecuteSQLForwardsRequestContextToBackend(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID: "postgres-main",
			Config: connection.ConnectionConfig{
				Type:     "postgres",
				Database: "app",
			},
		},
		inspection: appcore.SQLInspection{
			StatementCount: 1,
			ReadOnly:       true,
			Statements: []appcore.SQLStatementInspection{
				{Index: 1, Keyword: "select", ReadOnly: true},
			},
		},
		queryResult: connection.QueryResult{Success: true, Data: []connection.ResultSetData{}},
	}

	requestCtx, cancel := context.WithCancel(context.Background())
	cancel()
	result, _, err := NewService(backend).ExecuteSQL(requestCtx, nil, executeSQLArgs{
		ConnectionID: "postgres-main",
		SQL:          "SELECT 1",
	})
	if err != nil {
		t.Fatalf("ExecuteSQL returned error: %v", err)
	}
	if result == nil || result.IsError || !backend.queryCalled {
		t.Fatalf("ExecuteSQL did not reach the backend: result=%#v called=%t", result, backend.queryCalled)
	}
	if backend.queryContext == nil || backend.queryContext.Err() != context.Canceled {
		t.Fatalf("backend request context = %v, want cancelled request context", backend.queryContext)
	}
}

func TestExecuteSQLExposesUnsupportedCancellationState(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID: "legacy-main",
			Config: connection.ConnectionConfig{
				Type:     "custom",
				Database: "app",
			},
		},
		inspection: appcore.SQLInspection{
			StatementCount: 1,
			ReadOnly:       true,
			Statements: []appcore.SQLStatementInspection{
				{Index: 1, Keyword: "select", ReadOnly: true},
			},
		},
		queryResult: connection.QueryResult{
			Success:           true,
			Message:           "driver cannot stop the underlying SQL",
			CancellationState: connection.QueryCancellationStateUnsupported,
			Data:              []connection.ResultSetData{},
		},
	}

	result, out, err := NewService(backend).ExecuteSQL(context.Background(), nil, executeSQLArgs{
		ConnectionID: "legacy-main",
		SQL:          "SELECT 1",
	})
	if err != nil {
		t.Fatalf("ExecuteSQL returned error: %v", err)
	}
	if result == nil || result.IsError {
		t.Fatalf("expected the completed SQL result with explicit cancellation state, got %#v", result)
	}
	if out.CancellationState != connection.QueryCancellationStateUnsupported {
		t.Fatalf("unsupported cancellation state was lost from structured MCP output: %#v", out)
	}
	if text := firstTextContent(result); !strings.Contains(text, "取消状态：unsupported") {
		t.Fatalf("unsupported cancellation state was lost at the MCP boundary: %q", text)
	}
}

func TestExecuteSQLAllowsDDLWhenAISafetyIsFullAndAllowMutating(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID: "mysql-main",
			Config: connection.ConnectionConfig{
				Type:     "mysql",
				Database: "app",
			},
		},
		inspection: appcore.SQLInspection{
			StatementCount: 1,
			ReadOnly:       false,
			Statements: []appcore.SQLStatementInspection{
				{Index: 1, Keyword: "drop", ReadOnly: false},
			},
		},
		safetyLevel: ai.PermissionFull,
		queryResult: connection.QueryResult{
			Success: true,
			Data:    []connection.ResultSetData{},
		},
	}

	service := NewService(backend)
	result, _, err := service.ExecuteSQL(context.Background(), nil, executeSQLArgs{
		ConnectionID:  "mysql-main",
		SQL:           "drop table users",
		AllowMutating: true,
	})
	if err != nil {
		t.Fatalf("ExecuteSQL returned error: %v", err)
	}
	if result == nil || result.IsError {
		t.Fatalf("expected success result, got %#v", result)
	}
	if !backend.queryCalled {
		t.Fatalf("expected SQL to be executed")
	}
}

func TestExecuteSQLAllowsOtherStatementsWhenAISafetyIsFullAndAllowMutating(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID: "oracle-main",
			Config: connection.ConnectionConfig{
				Type:     "oracle",
				Database: "app",
			},
		},
		inspection: appcore.SQLInspection{
			StatementCount: 1,
			ReadOnly:       false,
			Statements: []appcore.SQLStatementInspection{
				{Index: 1, Keyword: "call", ReadOnly: false},
			},
		},
		safetyLevel: ai.PermissionFull,
		queryResult: connection.QueryResult{
			Success: true,
			Data:    []connection.ResultSetData{},
		},
	}

	service := NewService(backend)
	result, _, err := service.ExecuteSQL(context.Background(), nil, executeSQLArgs{
		ConnectionID:  "oracle-main",
		SQL:           "CALL bulk_insert_users(100000)",
		AllowMutating: true,
	})
	if err != nil {
		t.Fatalf("ExecuteSQL returned error: %v", err)
	}
	if result == nil || result.IsError {
		t.Fatalf("expected success result, got %#v", result)
	}
	if !backend.queryCalled {
		t.Fatalf("expected SQL to be executed")
	}
}

func TestExecuteSQLNormalizesAndTruncatesResultSets(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID: "mysql-main",
			Config: connection.ConnectionConfig{
				Type:     "mysql",
				Database: "app",
			},
		},
		inspection: appcore.SQLInspection{
			StatementCount: 1,
			ReadOnly:       true,
			Statements: []appcore.SQLStatementInspection{
				{Index: 1, Keyword: "select", ReadOnly: true},
			},
		},
		queryResult: connection.QueryResult{
			Success: true,
			QueryID: "query-1",
			Data: []connection.ResultSetData{
				{
					StatementIndex: 1,
					Columns:        []string{"id"},
					Rows: []map[string]interface{}{
						{"id": 1},
						{"id": 2},
						{"id": 3},
					},
				},
			},
		},
	}

	service := NewService(backend)
	result, out, err := service.ExecuteSQL(context.Background(), nil, executeSQLArgs{
		ConnectionID:     "mysql-main",
		SQL:              "select id from users",
		MaxRowsPerResult: 2,
	})
	if err != nil {
		t.Fatalf("ExecuteSQL returned error: %v", err)
	}
	if result == nil || result.IsError {
		t.Fatalf("expected success result, got %#v", result)
	}
	if !backend.queryCalled {
		t.Fatalf("expected SQL to be executed")
	}
	if out.StatementCount != 1 || len(out.Results) != 1 {
		t.Fatalf("unexpected output: %#v", out)
	}
	if out.QueryID != "query-1" {
		t.Fatalf("unexpected query id: %q", out.QueryID)
	}
	if !out.Truncated || !out.Results[0].Truncated {
		t.Fatalf("expected truncated result, got %#v", out.Results[0])
	}
	if out.Results[0].RowCount != 3 {
		t.Fatalf("expected rowCount 3, got %d", out.Results[0].RowCount)
	}
	if len(out.Results[0].Rows) != 2 {
		t.Fatalf("expected 2 returned rows, got %d", len(out.Results[0].Rows))
	}
}

func TestExecuteSQLFailsClosedWhenResultMaskingConfigCannotLoad(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{ID: "mysql-main", Config: connection.ConnectionConfig{Type: "mysql", Database: "app"}},
		inspection:         appcore.SQLInspection{StatementCount: 1, ReadOnly: true, Statements: []appcore.SQLStatementInspection{{Index: 1, Keyword: "select", ReadOnly: true}}},
		maskingSettingsErr: errors.New("invalid ai_config.json"),
	}
	result, _, err := NewService(backend).ExecuteSQL(context.Background(), nil, executeSQLArgs{ConnectionID: "mysql-main", SQL: "select phone from users"})
	if err != nil || result == nil || !result.IsError {
		t.Fatalf("expected standard MCP error, result=%#v err=%v", result, err)
	}
	if backend.queryCalled {
		t.Fatal("SQL must not execute when result masking configuration cannot load")
	}
}

func TestExecuteSQLMasksStructuredAndMarkdownResults(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{ID: "mysql-main", Config: connection.ConnectionConfig{Type: "mysql", Database: "app"}},
		inspection:         appcore.SQLInspection{StatementCount: 1, ReadOnly: true, Statements: []appcore.SQLStatementInspection{{Index: 1, Keyword: "select", ReadOnly: true}}},
		maskingSettings:    ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}},
		queryResult:        connection.QueryResult{Success: true, Data: []connection.ResultSetData{{StatementIndex: 1, Columns: []string{"mobile"}, Rows: []map[string]interface{}{{"mobile": "13800138000"}}}}},
	}
	result, output, err := NewService(backend).ExecuteSQL(context.Background(), nil, executeSQLArgs{ConnectionID: "mysql-main", SQL: "select u.phone as mobile from users u"})
	if err != nil || result == nil || result.IsError {
		t.Fatalf("expected success, result=%#v err=%v", result, err)
	}
	if got := output.Results[0].Rows[0]["mobile"]; got != "***********" {
		t.Fatalf("structured output leaked value: %#v", got)
	}
	if text := firstTextContent(result); strings.Contains(text, "13800138000") || !strings.Contains(text, "***********") {
		t.Fatalf("markdown output was not masked: %q", text)
	}
}

func TestExecuteSQLUsesResolvedConnectionSQLModeForDuplicateAliases(t *testing.T) {
	base := &fakeBackend{
		// The editable view intentionally has no DSN: production strips opaque
		// connection strings before exposing saved connection metadata.
		editableConnection: connection.SavedConnectionView{ID: "mysql-main", Config: connection.ConnectionConfig{Type: "mysql", Database: "app"}},
		inspection:         appcore.SQLInspection{StatementCount: 1, ReadOnly: true, Statements: []appcore.SQLStatementInspection{{Index: 1, Keyword: "select", ReadOnly: true}}},
		maskingSettings:    ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}},
		queryResult: connection.QueryResult{Success: true, Data: []connection.ResultSetData{{
			StatementIndex: 1,
			Columns:        []string{"label", "mobile", "mobile_2"},
			Rows:           []map[string]interface{}{{"label": "public", "mobile": "secret", "mobile_2": "secret2"}},
		}}},
	}
	backend := &resolvedDialectBackend{fakeBackend: base, effectiveDialect: "mysql"}
	result, output, err := NewService(backend).ExecuteSQL(context.Background(), nil, executeSQLArgs{
		ConnectionID: "mysql-main",
		SQL:          `SELECT 'a\' AS label, phone AS mobile, phone AS mobile FROM users`,
	})
	if err != nil || result == nil || result.IsError {
		t.Fatalf("expected success, result=%#v err=%v", result, err)
	}
	row := output.Results[0].Rows[0]
	if row["mobile"] != "******" || row["mobile_2"] != "*******" {
		t.Fatalf("resolved NO_BACKSLASH_ESCAPES mode leaked duplicate aliases: %#v", row)
	}
	if text := firstTextContent(result); strings.Contains(text, "secret") {
		t.Fatalf("markdown output leaked duplicate aliases: %q", text)
	}
}

func TestExecuteSQLUsesEffectiveOceanBaseOracleDialect(t *testing.T) {
	base := &fakeBackend{
		editableConnection: connection.SavedConnectionView{ID: "oceanbase-main", Config: connection.ConnectionConfig{Type: "oceanbase", Database: "app"}},
		inspection:         appcore.SQLInspection{StatementCount: 1, ReadOnly: true, Statements: []appcore.SQLStatementInspection{{Index: 1, Keyword: "select", ReadOnly: true}}},
		maskingSettings:    ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}},
		queryResult: connection.QueryResult{Success: true, Data: []connection.ResultSetData{{
			StatementIndex: 1,
			Columns:        []string{"label", "mobile"},
			Rows:           []map[string]interface{}{{"label": "public", "mobile": "secret"}},
		}}},
	}
	backend := &resolvedDialectBackend{fakeBackend: base, effectiveDialect: "oracle"}
	result, output, err := NewService(backend).ExecuteSQL(context.Background(), nil, executeSQLArgs{
		ConnectionID: "oceanbase-main",
		SQL:          `SELECT q'[Bob's phone, from sales]' AS label, phone AS mobile FROM users`,
	})
	if err != nil || result == nil || result.IsError {
		t.Fatalf("expected success, result=%#v err=%v", result, err)
	}
	if got := output.Results[0].Rows[0]["mobile"]; got != "******" {
		t.Fatalf("OceanBase Oracle projection leaked value: %#v", got)
	}
}

func firstTextContent(result *mcp.CallToolResult) string {
	if result == nil || len(result.Content) == 0 {
		return ""
	}
	text, _ := result.Content[0].(*mcp.TextContent)
	if text == nil {
		return ""
	}
	return text.Text
}

func TestExecuteSQLReportsUnknownOutcomeAndForbidsRetry(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID:     "mysql-main",
			Config: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		},
		safetyLevel: ai.PermissionFull,
		inspection: appcore.SQLInspection{
			StatementCount: 1,
			ReadOnly:       false,
			Statements:     []appcore.SQLStatementInspection{{Index: 1, Keyword: "insert", ReadOnly: false}},
		},
		queryResult: connection.QueryResult{
			Success:        false,
			QueryID:        "query-unknown",
			Message:        "write failed: connection lost",
			OutcomeUnknown: true,
		},
	}

	result, out, err := NewService(backend).ExecuteSQL(context.Background(), nil, executeSQLArgs{
		ConnectionID:  "mysql-main",
		SQL:           "INSERT INTO users(id) VALUES (1)",
		AllowMutating: true,
	})
	if err != nil {
		t.Fatalf("ExecuteSQL returned error: %v", err)
	}
	if result == nil || !result.IsError {
		t.Fatalf("expected tool error, got %#v", result)
	}
	text := firstTextContent(result)
	if !strings.Contains(text, "结果未知") {
		t.Fatalf("expected unknown-outcome statement in error text, got %q", text)
	}
	if !strings.Contains(text, "请勿自动重试") {
		t.Fatalf("expected no-retry contract in error text, got %q", text)
	}
	if !strings.Contains(text, "connection lost") {
		t.Fatalf("expected original backend message preserved, got %q", text)
	}
	if !out.OutcomeUnknown {
		t.Fatalf("expected structured outcomeUnknown=true, got %#v", out)
	}
	if out.QueryID != "query-unknown" {
		t.Fatalf("expected queryId preserved for later verification, got %q", out.QueryID)
	}
}

func TestExecuteSQLUnknownOutcomeWithCancellationStillForbidsRetry(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID:     "mysql-main",
			Config: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		},
		safetyLevel: ai.PermissionFull,
		inspection: appcore.SQLInspection{
			StatementCount: 1,
			ReadOnly:       false,
			Statements:     []appcore.SQLStatementInspection{{Index: 1, Keyword: "update", ReadOnly: false}},
		},
		queryResult: connection.QueryResult{
			Success:           false,
			Message:           "write failed: context canceled",
			CancellationState: "cancelled",
			OutcomeUnknown:    true,
		},
	}

	result, out, err := NewService(backend).ExecuteSQL(context.Background(), nil, executeSQLArgs{
		ConnectionID:  "mysql-main",
		SQL:           "UPDATE users SET name = 'x' WHERE id = 1",
		AllowMutating: true,
	})
	if err != nil {
		t.Fatalf("ExecuteSQL returned error: %v", err)
	}
	if result == nil || !result.IsError {
		t.Fatalf("expected tool error, got %#v", result)
	}
	text := firstTextContent(result)
	if !strings.Contains(text, "cancellationState=cancelled") {
		t.Fatalf("expected cancellation state preserved in error text, got %q", text)
	}
	if !strings.Contains(text, "请勿自动重试") {
		t.Fatalf("expected no-retry contract in error text, got %q", text)
	}
	if !out.OutcomeUnknown {
		t.Fatalf("expected structured outcomeUnknown=true, got %#v", out)
	}
}

func TestExecuteSQLDeterministicFailureNotMarkedUnknown(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID:     "mysql-main",
			Config: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		},
		safetyLevel: ai.PermissionFull,
		inspection: appcore.SQLInspection{
			StatementCount: 1,
			ReadOnly:       false,
			Statements:     []appcore.SQLStatementInspection{{Index: 1, Keyword: "insert", ReadOnly: false}},
		},
		queryResult: connection.QueryResult{
			Success: false,
			Message: "You have an error in your SQL syntax near 'FORM'",
		},
	}

	result, out, err := NewService(backend).ExecuteSQL(context.Background(), nil, executeSQLArgs{
		ConnectionID:  "mysql-main",
		SQL:           "INSERT INTO users(id) VALEUS (1)",
		AllowMutating: true,
	})
	if err != nil {
		t.Fatalf("ExecuteSQL returned error: %v", err)
	}
	if result == nil || !result.IsError {
		t.Fatalf("expected tool error, got %#v", result)
	}
	text := firstTextContent(result)
	if strings.Contains(text, "结果未知") || strings.Contains(text, "请勿自动重试") {
		t.Fatalf("deterministic failure must not carry unknown-outcome guidance, got %q", text)
	}
	if out.OutcomeUnknown {
		t.Fatalf("deterministic failure must not be marked outcomeUnknown, got %#v", out)
	}
}

func TestExecuteSQLForwardsNormalizedMaxRowsPerResult(t *testing.T) {
	cases := []struct {
		name string
		arg  int
		want int
	}{
		{name: "unset falls back to default", arg: 0, want: defaultMaxRowsPerResult},
		{name: "above limit clamps to limit", arg: 5000, want: maxRowsPerResultLimit},
		{name: "explicit value passes through", arg: 120, want: 120},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			backend := &fakeBackend{
				editableConnection: connection.SavedConnectionView{
					ID:     "mysql-main",
					Config: connection.ConnectionConfig{Type: "mysql", Database: "app"},
				},
				inspection: appcore.SQLInspection{
					StatementCount: 1,
					ReadOnly:       true,
					Statements:     []appcore.SQLStatementInspection{{Index: 1, Keyword: "select", ReadOnly: true}},
				},
				queryResult: connection.QueryResult{Success: true, Data: []connection.ResultSetData{}},
			}
			service := NewService(backend)
			result, _, err := service.ExecuteSQL(context.Background(), nil, executeSQLArgs{
				ConnectionID:     "mysql-main",
				SQL:              "select 1",
				MaxRowsPerResult: tc.arg,
			})
			if err != nil {
				t.Fatalf("ExecuteSQL returned error: %v", err)
			}
			if result == nil || result.IsError {
				t.Fatalf("expected success result, got %#v", result)
			}
			if backend.queryMaxRowsPerResult != tc.want {
				t.Fatalf("backend received maxRowsPerResult=%d, want %d", backend.queryMaxRowsPerResult, tc.want)
			}
		})
	}
}

func TestExecuteSQLSurfacesBudgetTruncation(t *testing.T) {
	rows := make([]map[string]interface{}, 0, 50)
	for i := 1; i <= 50; i++ {
		rows = append(rows, map[string]interface{}{"id": int64(i)})
	}
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID:     "mysql-main",
			Config: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		},
		inspection: appcore.SQLInspection{
			StatementCount: 1,
			ReadOnly:       true,
			Statements:     []appcore.SQLStatementInspection{{Index: 1, Keyword: "select", ReadOnly: true}},
		},
		queryResult: connection.QueryResult{
			Success:       true,
			QueryID:       "query-budget",
			ExecutedCount: 1,
			Data: []connection.ResultSetData{{
				StatementIndex: 1,
				Columns:        []string{"id"},
				Rows:           rows,
				Truncated:      true,
			}},
		},
	}

	service := NewService(backend)
	result, out, err := service.ExecuteSQL(context.Background(), nil, executeSQLArgs{
		ConnectionID: "mysql-main",
		SQL:          "select id from users",
	})
	if err != nil {
		t.Fatalf("ExecuteSQL returned error: %v", err)
	}
	if result == nil || result.IsError {
		t.Fatalf("expected success result, got %#v", result)
	}
	if !out.Truncated || len(out.Results) != 1 || !out.Results[0].Truncated {
		t.Fatalf("expected truncated output, got %#v", out)
	}
	if out.Results[0].RowCount != 50 || len(out.Results[0].Rows) != 50 {
		t.Fatalf("unexpected row counts: rowCount=%d rows=%d", out.Results[0].RowCount, len(out.Results[0].Rows))
	}
	foundBudgetNote := false
	for _, message := range out.Results[0].Messages {
		if strings.Contains(message, "剩余行未读取") {
			foundBudgetNote = true
		}
	}
	if !foundBudgetNote {
		t.Fatalf("expected budget truncation note in messages: %#v", out.Results[0].Messages)
	}
	if text := firstTextContent(result); !strings.Contains(text, "已达每结果集行数上限") {
		t.Fatalf("expected budget truncation wording in content: %q", text)
	}
}

func TestExecuteSQLNotesStatementsSkippedByRowBudget(t *testing.T) {
	rows := make([]map[string]interface{}, 0, 50)
	for i := 1; i <= 50; i++ {
		rows = append(rows, map[string]interface{}{"id": int64(i)})
	}
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID:     "mysql-main",
			Config: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		},
		inspection: appcore.SQLInspection{
			StatementCount: 3,
			ReadOnly:       true,
			Statements: []appcore.SQLStatementInspection{
				{Index: 1, Keyword: "select", ReadOnly: true},
				{Index: 2, Keyword: "select", ReadOnly: true},
				{Index: 3, Keyword: "select", ReadOnly: true},
			},
		},
		queryResult: connection.QueryResult{
			Success:       true,
			QueryID:       "query-skip",
			ExecutedCount: 1,
			Data: []connection.ResultSetData{{
				StatementIndex: 1,
				Columns:        []string{"id"},
				Rows:           rows,
				Truncated:      true,
			}},
		},
	}

	service := NewService(backend)
	result, out, err := service.ExecuteSQL(context.Background(), nil, executeSQLArgs{
		ConnectionID: "mysql-main",
		SQL:          "select id from users; select id from orders; select id from items",
	})
	if err != nil {
		t.Fatalf("ExecuteSQL returned error: %v", err)
	}
	if result == nil || result.IsError {
		t.Fatalf("expected success result, got %#v", result)
	}
	if !out.Truncated {
		t.Fatalf("expected truncated output, got %#v", out)
	}
	if !strings.Contains(out.Message, "剩余 2 条语句未执行") {
		t.Fatalf("expected skipped-statement note in message: %q", out.Message)
	}
	if text := firstTextContent(result); !strings.Contains(text, "剩余 2 条语句未执行") {
		t.Fatalf("expected skipped-statement note in content: %q", text)
	}
}
