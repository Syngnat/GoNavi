package mcpserver

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/connection"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestNewServerWithOptionsOmitsExecuteSQLInSchemaOnlyMode(t *testing.T) {
	toolNames := listServerToolNames(t, NewServerWithOptions(&fakeBackend{}, ServerOptions{SchemaOnly: true}))

	assertToolPresent(t, toolNames, "get_connections")
	assertToolPresent(t, toolNames, "get_views")
	assertToolPresent(t, toolNames, "get_objects")
	assertToolPresent(t, toolNames, "get_table_ddl")
	assertToolAbsent(t, toolNames, "execute_sql")
}

func TestNewServerIncludesExecuteSQLByDefault(t *testing.T) {
	toolNames := listServerToolNames(t, NewServer(&fakeBackend{}))

	assertToolPresent(t, toolNames, "execute_sql")
}

func TestExecuteSQLCallToolReturnsSelectResultContent(t *testing.T) {
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
		safetyLevel: ai.PermissionReadOnly,
		queryResult: connection.QueryResult{
			Success: true,
			QueryID: "query-select-1",
			Data: []connection.ResultSetData{
				{
					StatementIndex: 1,
					Columns:        []string{"1"},
					Rows:           []map[string]interface{}{{"1": 1}},
				},
			},
		},
	}

	result := callServerTool(t, NewServer(backend), "execute_sql", map[string]any{
		"connectionId": "mysql-main",
		"sql":          "select 1",
	})

	if result.IsError {
		t.Fatalf("expected execute_sql success, got error content: %#v", result.Content)
	}
	text := firstTextContent(result)
	if strings.TrimSpace(text) == "" {
		t.Fatalf("expected execute_sql to return text content for MCP clients, got %#v", result.Content)
	}
	if !strings.Contains(text, "SQL 执行成功") || !strings.Contains(text, "结果集 1") {
		t.Fatalf("expected readable SQL result summary, got %s", text)
	}
	if !strings.Contains(text, "| 1 |") || !strings.Contains(text, "| --- |") {
		t.Fatalf("expected select result table in MCP text content, got %s", text)
	}
	structured, err := json.Marshal(result.StructuredContent)
	if err != nil {
		t.Fatalf("failed to marshal structuredContent: %v", err)
	}
	if !strings.Contains(string(structured), `"results"`) || !strings.Contains(string(structured), `"rows"`) {
		t.Fatalf("expected structuredContent to retain SQL result JSON, got %s", string(structured))
	}
}

func TestGetObjectsCallToolRetainsStructuredBaseMetadataFailure(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID:     "mysql-main",
			Config: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		},
		objectsResult: connection.QueryResult{
			Success:           false,
			Partial:           true,
			Retryable:         true,
			Message:           "读取 table 对象元数据失败: permission denied",
			Warnings:          []string{"读取 table 对象元数据失败: permission denied"},
			FailedObjectTypes: []string{"table"},
		},
	}

	result := callServerTool(t, NewServer(backend), "get_objects", map[string]any{
		"connectionId": "mysql-main",
		"dbName":       "app",
	})
	if !result.IsError {
		t.Fatalf("expected base metadata failure tool result, got %#v", result)
	}
	structured, err := json.Marshal(result.StructuredContent)
	if err != nil {
		t.Fatalf("failed to marshal structuredContent: %v", err)
	}
	for _, expected := range []string{`"partial":true`, `"retryable":true`, `"failedObjectTypes":["table"]`, `"warnings":["读取 table 对象元数据失败: permission denied"]`} {
		if !strings.Contains(string(structured), expected) {
			t.Fatalf("expected structured base metadata failure to contain %s, got %s", expected, string(structured))
		}
	}
}

func listServerToolNames(t *testing.T, server *mcp.Server) map[string]bool {
	t.Helper()

	ctx := context.Background()
	clientTransport, serverTransport := mcp.NewInMemoryTransports()
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatalf("server.Connect returned error: %v", err)
	}
	defer serverSession.Close()

	client := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "v0.0.1"}, nil)
	clientSession, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatalf("client.Connect returned error: %v", err)
	}
	defer clientSession.Close()

	result, err := clientSession.ListTools(ctx, &mcp.ListToolsParams{})
	if err != nil {
		t.Fatalf("ListTools returned error: %v", err)
	}

	names := make(map[string]bool, len(result.Tools))
	for _, tool := range result.Tools {
		names[tool.Name] = true
	}
	return names
}

func callServerTool(t *testing.T, server *mcp.Server, name string, args map[string]any) *mcp.CallToolResult {
	t.Helper()

	ctx := context.Background()
	clientTransport, serverTransport := mcp.NewInMemoryTransports()
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatalf("server.Connect returned error: %v", err)
	}
	defer serverSession.Close()

	client := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "v0.0.1"}, nil)
	clientSession, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatalf("client.Connect returned error: %v", err)
	}
	defer clientSession.Close()

	payload, err := json.Marshal(args)
	if err != nil {
		t.Fatalf("json.Marshal returned error: %v", err)
	}
	result, err := clientSession.CallTool(ctx, &mcp.CallToolParams{
		Name:      name,
		Arguments: json.RawMessage(payload),
	})
	if err != nil {
		t.Fatalf("CallTool returned error: %v", err)
	}
	return result
}

func assertToolPresent(t *testing.T, names map[string]bool, name string) {
	t.Helper()
	if !names[name] {
		t.Fatalf("expected tool %q to be registered; got %#v", name, names)
	}
}

func assertToolAbsent(t *testing.T, names map[string]bool, name string) {
	t.Helper()
	if names[name] {
		t.Fatalf("expected tool %q to be omitted; got %#v", name, names)
	}
}
