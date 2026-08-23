package mcpserver

import (
	"context"
	"testing"

	"GoNavi-Wails/internal/requesttrace"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPRequestTraceMiddlewareCarriesAndReturnsRequestID(t *testing.T) {
	store := requesttrace.NewStore(4)
	middleware := newMCPRequestTraceMiddleware(store)
	handler := middleware(func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
		if method != "tools/call" {
			t.Fatalf("method = %q", method)
		}
		if requesttrace.FromContext(ctx) == nil {
			t.Fatal("expected trace handle in tool context")
		}
		return &mcp.CallToolResult{}, nil
	})

	result, err := handler(context.Background(), "tools/call", &mcp.CallToolRequest{
		Params: &mcp.CallToolParamsRaw{Name: "get_tables"},
	})
	if err != nil {
		t.Fatal(err)
	}
	toolResult, ok := result.(*mcp.CallToolResult)
	if !ok {
		t.Fatalf("result type = %T", result)
	}
	requestID, _ := toolResult.GetMeta()[mcpRequestIDMetaKey].(string)
	if requestID == "" {
		t.Fatal("MCP result did not include request ID metadata")
	}
	trace, found := store.Get(requestID)
	if !found || trace.Entry != "mcp" || trace.Operation != "mcp.get_tables" || trace.Status != "success" {
		t.Fatalf("unexpected trace: found=%v trace=%#v", found, trace)
	}
}
