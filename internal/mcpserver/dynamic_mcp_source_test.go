package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/runharness"
)

type fakeMCPToolClient struct {
	tools       []ai.MCPToolDescriptor
	result      ai.MCPToolCallResult
	listErr     error
	callErr     error
	listContext context.Context
	callContext context.Context
	callAlias   string
	callArgs    string
}

func (f *fakeMCPToolClient) ListMCPTools(ctx context.Context) ([]ai.MCPToolDescriptor, error) {
	f.listContext = ctx
	return append([]ai.MCPToolDescriptor(nil), f.tools...), f.listErr
}

func (f *fakeMCPToolClient) CallMCPTool(ctx context.Context, alias, arguments string) (ai.MCPToolCallResult, error) {
	f.callContext = ctx
	f.callAlias = alias
	f.callArgs = arguments
	return f.result, f.callErr
}

func TestDynamicMCPSourceConvertsAndRoutesServiceDescriptors(t *testing.T) {
	client := &fakeMCPToolClient{
		tools: []ai.MCPToolDescriptor{
			{Alias: "mcp__server__read", ServerID: "server", ServerName: "Local", OriginalName: "read", Description: "read data", InputSchema: map[string]any{"type": "object"}},
			{Alias: "", ServerID: "server", OriginalName: "write", Title: "write data"},
			{Alias: "not-an-mcp-alias", ServerID: "server", OriginalName: "ignored"},
		},
		result: ai.MCPToolCallResult{Alias: "mcp__server__read", ServerID: "server", Content: "ok"},
	}
	source := NewDynamicMCPSource(client)
	ctx := context.WithValue(context.Background(), struct{}{}, "list")
	tools, err := source.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if client.listContext != ctx {
		t.Fatal("List did not receive the caller context")
	}
	if len(tools) != 2 {
		t.Fatalf("normalized tools = %d, want 2: %#v", len(tools), tools)
	}
	if tools[0].Descriptor.Name != "mcp__server__read" || tools[1].Descriptor.Name != "mcp__server__write" {
		t.Fatalf("aliases = %#v", tools)
	}
	if tools[0].Descriptor.Effect != runharness.ToolEffectSideEffectUnknown {
		t.Fatalf("effect = %q", tools[0].Descriptor.Effect)
	}
	var schema map[string]any
	if err := json.Unmarshal(tools[0].Descriptor.InputSchema, &schema); err != nil || schema["type"] != "object" {
		t.Fatalf("schema = %s, err=%v", tools[0].Descriptor.InputSchema, err)
	}

	_, executor, err := source.Resolve(context.Background(), "mcp__server__read")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	execCtx := context.WithValue(context.Background(), struct{ name string }{"exec"}, true)
	result, err := executor.Execute(execCtx, runharness.ToolExecutionRequest{
		ToolName:  "mcp__server__read",
		Arguments: json.RawMessage(`{"path":"/tmp/a"}`),
	})
	if err != nil || result.Status != "completed" {
		t.Fatalf("Execute = %#v, err=%v", result, err)
	}
	if client.callContext != execCtx || client.callAlias != "mcp__server__read" || client.callArgs != `{"path":"/tmp/a"}` {
		t.Fatalf("call forwarding context=%v alias=%q args=%q", client.callContext, client.callAlias, client.callArgs)
	}
	if got, ok := result.Value.(ai.MCPToolCallResult); !ok || got.Content != "ok" {
		t.Fatalf("result value = %#v", result.Value)
	}
}

func TestDynamicMCPSourceRefreshesOnUnknownAlias(t *testing.T) {
	client := &fakeMCPToolClient{}
	source := NewDynamicMCPSource(client)
	if _, _, err := source.Resolve(context.Background(), "mcp__server__missing"); !errors.Is(err, ErrAgentToolNotFound) {
		t.Fatalf("missing alias error = %v", err)
	}
	client.tools = []ai.MCPToolDescriptor{{Alias: "mcp__server__new", ServerID: "server", OriginalName: "new"}}
	if _, _, err := source.Resolve(context.Background(), "mcp__server__new"); err != nil {
		t.Fatalf("Resolve after refresh: %v", err)
	}
}

func TestDynamicMCPSourcePropagatesDiscoveryAndCallErrors(t *testing.T) {
	client := &fakeMCPToolClient{listErr: context.DeadlineExceeded}
	source := NewDynamicMCPSource(client)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if _, err := source.List(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("discovery error = %v", err)
	}
	client.listErr = nil
	client.tools = []ai.MCPToolDescriptor{{Alias: "mcp__server__tool", ServerID: "server", OriginalName: "tool"}}
	client.callErr = context.Canceled
	if _, executor, err := source.Resolve(ctx, "mcp__server__tool"); err != nil {
		t.Fatalf("Resolve: %v", err)
	} else {
		result, callErr := executor.Execute(ctx, runharness.ToolExecutionRequest{ToolName: "mcp__server__tool", Arguments: json.RawMessage(`{}`)})
		if !errors.Is(callErr, context.Canceled) || result.ErrorCode != "canceled" {
			t.Fatalf("call error = %#v, %v", result, callErr)
		}
	}
}

func TestDynamicMCPSourceRequiresLifecycleContext(t *testing.T) {
	client := &fakeMCPToolClient{tools: []ai.MCPToolDescriptor{{Alias: "mcp__server__tool", ServerID: "server", OriginalName: "tool"}}}
	source := NewDynamicMCPSource(client)
	if _, err := source.List(nil); !errors.Is(err, runharness.ErrRootContextRequired) {
		t.Fatalf("List(nil) error = %v, want ErrRootContextRequired", err)
	}
	if _, _, err := source.Resolve(nil, "mcp__server__tool"); !errors.Is(err, runharness.ErrRootContextRequired) {
		t.Fatalf("Resolve(nil) error = %v, want ErrRootContextRequired", err)
	}

	if _, err := source.List(context.Background()); err != nil {
		t.Fatal(err)
	}
	_, executor, err := source.Resolve(context.Background(), "mcp__server__tool")
	if err != nil {
		t.Fatal(err)
	}
	result, err := executor.Execute(nil, runharness.ToolExecutionRequest{ToolName: "mcp__server__tool", Arguments: json.RawMessage(`{}`)})
	if !errors.Is(err, runharness.ErrRootContextRequired) || result.ErrorCode != "context_required" {
		t.Fatalf("Execute(nil) = %#v, %v", result, err)
	}
	if client.callContext != nil {
		t.Fatal("MCP client was called without a lifecycle context")
	}
}
