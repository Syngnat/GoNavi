package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/runharness"
	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/connection"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func catalogBackend() *fakeBackend {
	return &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID:     "conn-1",
			Name:   "Primary",
			Config: connection.ConnectionConfig{ID: "conn-1", Type: "postgres", Database: "app"},
		},
		safetyLevel: ai.PermissionReadWrite,
		queryResult: connection.QueryResult{Success: true, Data: []connection.ResultSetData{}},
	}
}

func TestAgentToolCatalogListIsBuiltInAndSchemaComplete(t *testing.T) {
	catalog := NewAgentToolCatalog(catalogBackend())
	items, err := catalog.List(context.Background())
	if err != nil {
		t.Fatalf("List returned error: %v", err)
	}
	wantNames := []string{"get_connections", "get_databases", "get_tables", "get_views", "get_objects", "get_all_columns", "get_columns", "get_indexes", "get_foreign_keys", "get_triggers", "get_table_ddl", "execute_sql"}
	if len(items) != len(wantNames) {
		t.Fatalf("catalog length = %d, want %d", len(items), len(wantNames))
	}
	for index, want := range wantNames {
		if items[index].Name != want {
			t.Fatalf("catalog[%d] = %q, want %q", index, items[index].Name, want)
		}
		if len(items[index].InputSchema) == 0 || !json.Valid(items[index].InputSchema) {
			t.Fatalf("catalog[%q] has invalid input schema: %s", want, items[index].InputSchema)
		}
	}
	if items[len(items)-1].Effect != runharness.ToolEffectSideEffectUnknown {
		t.Fatalf("execute_sql fallback effect = %q, want conservative unknown", items[len(items)-1].Effect)
	}
	for _, item := range items {
		if strings.Contains(item.Name, "mcp") {
			t.Fatalf("dynamic MCP tool leaked into built-in catalog: %q", item.Name)
		}
	}
	// Verify the defensive copy contract.
	items[0].InputSchema[0] = 'X'
	items[0].Capabilities[0] = "mutated"
	fresh, err := catalog.List(context.Background())
	if err != nil || fresh[0].InputSchema[0] == 'X' || fresh[0].Capabilities[0] == "mutated" {
		t.Fatalf("List returned mutable catalog state: err=%v fresh=%#v", err, fresh[0])
	}
}

func TestAgentToolCatalogRequiresLifecycleContext(t *testing.T) {
	catalog := NewAgentToolCatalog(catalogBackend())
	if _, err := catalog.List(nil); !errors.Is(err, runharness.ErrRootContextRequired) {
		t.Fatalf("List(nil) error = %v, want ErrRootContextRequired", err)
	}
	if _, _, err := catalog.Resolve(nil, "get_tables"); !errors.Is(err, runharness.ErrRootContextRequired) {
		t.Fatalf("Resolve(nil) error = %v, want ErrRootContextRequired", err)
	}
	if _, err := catalog.ResolveEffect(nil, agentSQLToolName, json.RawMessage(`{"connectionId":"conn-1","sql":"SELECT 1"}`)); !errors.Is(err, runharness.ErrRootContextRequired) {
		t.Fatalf("ResolveEffect(nil) error = %v, want ErrRootContextRequired", err)
	}

	_, executor, err := catalog.Resolve(context.Background(), "get_tables")
	if err != nil {
		t.Fatal(err)
	}
	result, err := executor.Execute(nil, runharness.ToolExecutionRequest{ToolName: "get_tables", Arguments: json.RawMessage(`{"connectionId":"conn-1","dbName":"app"}`)})
	if !errors.Is(err, runharness.ErrRootContextRequired) || result.ErrorCode != "context_required" {
		t.Fatalf("Execute(nil) = %#v, %v", result, err)
	}
}

func TestAgentToolCatalogResolvesMetadataUsingConnectionID(t *testing.T) {
	backend := catalogBackend()
	backend.tablesResult = connection.QueryResult{Success: true, Data: []map[string]string{{"Table": "orders"}}}
	backend.viewsResult = connection.QueryResult{Success: true, Data: []map[string]string{{"View": "order_view"}}}
	catalog := NewAgentToolCatalog(backend)
	descriptor, executor, err := catalog.Resolve(context.Background(), "get_tables")
	if err != nil || executor == nil {
		t.Fatalf("Resolve get_tables = %#v, %v", descriptor, err)
	}
	if descriptor.Effect != runharness.ToolEffectReadOnly {
		t.Fatalf("metadata effect = %q", descriptor.Effect)
	}
	result, err := executor.Execute(context.Background(), runharness.ToolExecutionRequest{
		ToolName:  "get_tables",
		Arguments: json.RawMessage(`{"connectionId":"conn-1","dbName":"app"}`),
		Effect:    runharness.ToolEffectReadOnly,
	})
	if err != nil || result.Status != "completed" {
		t.Fatalf("get_tables execution = %#v, %v", result, err)
	}
	output, ok := result.Value.(getTablesResult)
	if !ok || len(output.Tables) != 1 || output.Tables[0] != "orders" || len(output.Views) != 1 {
		t.Fatalf("get_tables output = %#v (%T)", result.Value, result.Value)
	}
	if backend.editableConnection.Config.ID != "conn-1" {
		t.Fatal("test backend connection ID changed unexpectedly")
	}
}

func TestAgentToolCatalogResolvesSQLEffectFromInspection(t *testing.T) {
	backend := catalogBackend()
	catalog := NewAgentToolCatalog(backend)
	readOnlyInspection := appcore.SQLInspection{StatementCount: 1, ReadOnly: true, Statements: []appcore.SQLStatementInspection{{Index: 1, Keyword: "select", ReadOnly: true}}}
	mutatingInspection := appcore.SQLInspection{StatementCount: 1, ReadOnly: false, Statements: []appcore.SQLStatementInspection{{Index: 1, Keyword: "insert", ReadOnly: false}}}
	tests := []struct {
		name       string
		inspection appcore.SQLInspection
		want       runharness.ToolEffect
	}{
		{name: "read only", inspection: readOnlyInspection, want: runharness.ToolEffectReadOnly},
		{name: "mutating", inspection: mutatingInspection, want: runharness.ToolEffectSideEffect},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			backend.inspection = test.inspection
			effect, err := catalog.ResolveEffect(context.Background(), "execute_sql", json.RawMessage(`{"connectionId":"conn-1","sql":"SELECT 1"}`))
			if err != nil || effect != test.want {
				t.Fatalf("effect = %q, %v; want %q", effect, err, test.want)
			}
		})
	}
}

func TestAgentToolCatalogSQLExecutorRechecksPolicyAndDoesNotBypassGuard(t *testing.T) {
	backend := catalogBackend()
	backend.inspection = appcore.SQLInspection{StatementCount: 1, ReadOnly: false, Statements: []appcore.SQLStatementInspection{{Index: 1, Keyword: "insert", ReadOnly: false}}}
	backend.safetyLevel = ai.PermissionReadOnly
	catalog := NewAgentToolCatalog(backend)
	_, executor, err := catalog.Resolve(context.Background(), "execute_sql")
	if err != nil {
		t.Fatal(err)
	}
	result, err := executor.Execute(context.Background(), runharness.ToolExecutionRequest{
		ToolName:  "execute_sql",
		Arguments: json.RawMessage(`{"connectionId":"conn-1","sql":"INSERT INTO users(id) VALUES (1)"}`),
		Effect:    runharness.ToolEffectSideEffect,
	})
	if err == nil || result.Status != "failed" || result.ErrorCode != "tool_execution_failed" && result.ErrorCode != "policy_denied" {
		t.Fatalf("policy result = %#v, %v", result, err)
	}
	if backend.queryCalled {
		t.Fatal("policy-denied SQL reached backend execution")
	}
}

func TestAgentToolCatalogPreservesUnknownSQLOutcome(t *testing.T) {
	backend := catalogBackend()
	backend.inspection = appcore.SQLInspection{StatementCount: 1, ReadOnly: false, Statements: []appcore.SQLStatementInspection{{Index: 1, Keyword: "insert", ReadOnly: false}}}
	backend.queryResult = connection.QueryResult{Success: false, Message: "response lost", OutcomeUnknown: true}
	catalog := NewAgentToolCatalog(backend)
	_, executor, err := catalog.Resolve(context.Background(), agentSQLToolName)
	if err != nil {
		t.Fatal(err)
	}
	result, err := executor.Execute(context.Background(), runharness.ToolExecutionRequest{
		ToolName:  agentSQLToolName,
		Effect:    runharness.ToolEffectSideEffect,
		Arguments: json.RawMessage(`{"connectionId":"conn-1","sql":"INSERT INTO users(id) VALUES (1)"}`),
	})
	if err == nil || result.Status != "failed" || !result.UnknownOutcome {
		t.Fatalf("unknown outcome = %#v, %v", result, err)
	}
}

func TestAgentToolCatalogRejectsMalformedAndStaleEffectArguments(t *testing.T) {
	backend := catalogBackend()
	backend.inspection = appcore.SQLInspection{StatementCount: 1, ReadOnly: false, Statements: []appcore.SQLStatementInspection{{Index: 1, Keyword: "update", ReadOnly: false}}}
	catalog := NewAgentToolCatalog(backend)
	_, executor, err := catalog.Resolve(context.Background(), "execute_sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name   string
		args   json.RawMessage
		effect runharness.ToolEffect
	}{
		{name: "truncated JSON", args: json.RawMessage(`{"connectionId":"conn-1"`), effect: runharness.ToolEffectSideEffectUnknown},
		{name: "unknown argument", args: json.RawMessage(`{"connectionId":"conn-1","sql":"UPDATE t SET v=1","unexpected":true}`), effect: runharness.ToolEffectSideEffectUnknown},
		{name: "stale read-only effect", args: json.RawMessage(`{"connectionId":"conn-1","sql":"UPDATE t SET v=1"}`), effect: runharness.ToolEffectReadOnly},
	} {
		t.Run(test.name, func(t *testing.T) {
			result, err := executor.Execute(context.Background(), runharness.ToolExecutionRequest{ToolName: "execute_sql", Arguments: test.args, Effect: test.effect})
			if err == nil || result.Status != "failed" {
				t.Fatalf("result = %#v, err=%v", result, err)
			}
			if backend.queryCalled {
				t.Fatal("malformed/stale call reached backend")
			}
		})
	}
	if _, _, err := catalog.Resolve(context.Background(), "dynamic_mcp_tool"); !errors.Is(err, ErrAgentToolNotFound) {
		t.Fatalf("unknown tool error = %v", err)
	}
}

type dynamicCatalogExecutor struct {
	seenContext context.Context
	request     runharness.ToolExecutionRequest
	result      runharness.ToolExecutionResult
	err         error
}

func (e *dynamicCatalogExecutor) Execute(ctx context.Context, request runharness.ToolExecutionRequest) (runharness.ToolExecutionResult, error) {
	e.seenContext = ctx
	e.request = request
	return e.result, e.err
}

func TestAgentToolCatalogMergesDynamicMCPToolsWithStableAliases(t *testing.T) {
	executor := &dynamicCatalogExecutor{result: runharness.ToolExecutionResult{Status: "completed", Value: map[string]any{"ok": true}}}
	source := DynamicMCPSourceFuncs{
		ListFunc: func(context.Context) ([]DynamicMCPTool, error) {
			return []DynamicMCPTool{
				{ServerID: "local server", ServerName: "Local", OriginalName: "read-file", Descriptor: runharness.ToolDescriptor{
					Description: "read a file",
					InputSchema: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"}}}`),
				}},
				{ServerID: "local server", OriginalName: "write-file", Descriptor: runharness.ToolDescriptor{
					InputSchema: json.RawMessage(`{"type":"object"}`),
				}},
			}, nil
		},
		ResolveFunc: func(_ context.Context, name string) (runharness.ToolDescriptor, runharness.ToolExecutor, error) {
			if name != "mcp__local_server__read-file" {
				return runharness.ToolDescriptor{}, nil, ErrAgentToolNotFound
			}
			return runharness.ToolDescriptor{
				Name:        name,
				InputSchema: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"}}}`),
			}, executor, nil
		},
	}
	catalog := NewAgentToolCatalogWithDynamicSource(catalogBackend(), source)
	items, err := catalog.List(context.Background())
	if err != nil {
		t.Fatalf("List returned error: %v", err)
	}
	var found runharness.ToolDescriptor
	for _, item := range items {
		if item.Name == "mcp__local_server__read-file" {
			found = item
			break
		}
	}
	if found.Name == "" {
		t.Fatalf("dynamic alias not present in catalog: %#v", items)
	}
	if found.Effect != runharness.ToolEffectSideEffectUnknown {
		t.Fatalf("missing effect = %q, want side_effect_unknown", found.Effect)
	}
	if found.MaxResultBytes != defaultDynamicMCPMaxResultBytes {
		t.Fatalf("max result bytes = %d, want %d", found.MaxResultBytes, defaultDynamicMCPMaxResultBytes)
	}
	if !containsString(found.Capabilities, "mcp") || !containsString(found.Capabilities, "dynamic") {
		t.Fatalf("dynamic capabilities = %#v", found.Capabilities)
	}

	descriptor, resolved, err := catalog.Resolve(context.Background(), found.Name)
	if err != nil {
		t.Fatalf("Resolve dynamic tool: %v", err)
	}
	if descriptor.Effect != runharness.ToolEffectSideEffectUnknown {
		t.Fatalf("resolved effect = %q", descriptor.Effect)
	}
	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), dynamicContextKey{}, "marker"))
	defer cancel()
	result, err := resolved.Execute(ctx, runharness.ToolExecutionRequest{
		ToolName:  found.Name,
		Effect:    runharness.ToolEffectSideEffectUnknown,
		Arguments: json.RawMessage(`{"path":"/tmp/example"}`),
	})
	if err != nil || result.Status != "completed" {
		t.Fatalf("dynamic execution = %#v, %v", result, err)
	}
	if executor.seenContext != ctx || executor.seenContext.Value(dynamicContextKey{}) != "marker" {
		t.Fatalf("executor did not receive exact context")
	}
}

type dynamicContextKey struct{}

func TestAgentToolCatalogDynamicMCPRequiresConservativeEffect(t *testing.T) {
	executor := &dynamicCatalogExecutor{result: runharness.ToolExecutionResult{Status: "completed"}}
	source := DynamicMCPSourceFuncs{
		ListFunc: func(context.Context) ([]DynamicMCPTool, error) {
			return []DynamicMCPTool{{Descriptor: runharness.ToolDescriptor{Name: "mcp__server__tool"}}}, nil
		},
		ResolveFunc: func(context.Context, string) (runharness.ToolDescriptor, runharness.ToolExecutor, error) {
			return runharness.ToolDescriptor{Name: "mcp__server__tool"}, executor, nil
		},
	}
	catalog := NewAgentToolCatalogWithDynamicSource(catalogBackend(), source)
	_, resolved, err := catalog.Resolve(context.Background(), "mcp__server__tool")
	if err != nil {
		t.Fatal(err)
	}
	result, err := resolved.Execute(context.Background(), runharness.ToolExecutionRequest{
		ToolName:  "mcp__server__tool",
		Effect:    runharness.ToolEffectReadOnly,
		Arguments: json.RawMessage(`{}`),
	})
	if err == nil || result.ErrorCode != "effect_mismatch" {
		t.Fatalf("downgraded effect result = %#v, err=%v", result, err)
	}
	if executor.seenContext != nil {
		t.Fatal("delegate called after effect downgrade")
	}
}

func TestAgentToolCatalogDynamicMCPMapsCallToolError(t *testing.T) {
	executor := &dynamicCatalogExecutor{result: runharness.ToolExecutionResult{
		Value: &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: "denied"}}},
	}}
	source := DynamicMCPSourceFuncs{
		ListFunc: func(context.Context) ([]DynamicMCPTool, error) {
			return []DynamicMCPTool{{Descriptor: runharness.ToolDescriptor{Name: "mcp__server__tool"}}}, nil
		},
		ResolveFunc: func(context.Context, string) (runharness.ToolDescriptor, runharness.ToolExecutor, error) {
			return runharness.ToolDescriptor{Name: "mcp__server__tool"}, executor, nil
		},
	}
	catalog := NewAgentToolCatalogWithDynamicSource(catalogBackend(), source)
	_, resolved, err := catalog.Resolve(context.Background(), "mcp__server__tool")
	if err != nil {
		t.Fatal(err)
	}
	result, err := resolved.Execute(context.Background(), runharness.ToolExecutionRequest{ToolName: "mcp__server__tool", Arguments: json.RawMessage(`{}`), Effect: runharness.ToolEffectSideEffectUnknown})
	if err != nil {
		t.Fatalf("MCP error result returned executor error: %v", err)
	}
	if result.Status != "failed" || result.ErrorCode != "mcp_tool_error" {
		t.Fatalf("MCP error mapping = %#v", result)
	}
	callResult, ok := result.Value.(*mcp.CallToolResult)
	if !ok || len(callResult.Content) != 1 {
		t.Fatalf("MCP content was not preserved: %#v", result.Value)
	}
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
