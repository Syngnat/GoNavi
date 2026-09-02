package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/runharness"
	aiservice "GoNavi-Wails/internal/ai/service"
)

// MCPToolClient is the small, context-aware surface needed to bridge the
// persisted AI Service MCP configuration into the Harness ToolCatalog.  It is
// intentionally independent of Service so CLI and tests can provide the same
// discovery/execution behavior without starting a second Harness.
type MCPToolClient interface {
	ListMCPTools(context.Context) ([]ai.MCPToolDescriptor, error)
	CallMCPTool(context.Context, string, string) (ai.MCPToolCallResult, error)
}

// MCPToolClientFuncs adapts package-level functions to MCPToolClient.
type MCPToolClientFuncs struct {
	ListFunc func(context.Context) ([]ai.MCPToolDescriptor, error)
	CallFunc func(context.Context, string, string) (ai.MCPToolCallResult, error)
}

func (f MCPToolClientFuncs) ListMCPTools(ctx context.Context) ([]ai.MCPToolDescriptor, error) {
	if f.ListFunc == nil {
		return nil, errors.New("MCP tool discovery is unavailable")
	}
	return f.ListFunc(ctx)
}

func (f MCPToolClientFuncs) CallMCPTool(ctx context.Context, alias, arguments string) (ai.MCPToolCallResult, error) {
	if f.CallFunc == nil {
		return ai.MCPToolCallResult{}, errors.New("MCP tool execution is unavailable")
	}
	return f.CallFunc(ctx, alias, arguments)
}

// NewServiceMCPSource adapts an already configured AI Service.  Desktop uses
// the long-lived Wails Service; the CLI uses a lightweight MCP-only Service.
// Both paths therefore share the exact same discovery and execution code.
func NewServiceMCPSource(service *aiservice.Service) DynamicMCPSource {
	return NewDynamicMCPSource(MCPToolClientFuncs{
		ListFunc: func(ctx context.Context) ([]ai.MCPToolDescriptor, error) {
			return aiservice.ListMCPTools(ctx, service)
		},
		CallFunc: func(ctx context.Context, alias, arguments string) (ai.MCPToolCallResult, error) {
			return aiservice.CallMCPTool(ctx, service, alias, arguments)
		},
	})
}

// NewDynamicMCPSource creates a source that caches the latest discovery
// snapshot only for alias resolution.  List is still called by the Harness on
// each model turn, so changes to MCP settings become visible without a
// process restart.  Resolve refreshes once when a caller asks for an alias
// that is not present in the current cache.
func NewDynamicMCPSource(client MCPToolClient) DynamicMCPSource {
	return &dynamicMCPSource{client: client, descriptors: make(map[string]DynamicMCPTool)}
}

type dynamicMCPSource struct {
	client MCPToolClient

	mu          sync.RWMutex
	descriptors map[string]DynamicMCPTool
}

var _ DynamicMCPSource = (*dynamicMCPSource)(nil)

func (s *dynamicMCPSource) List(ctx context.Context) ([]DynamicMCPTool, error) {
	if s == nil || s.client == nil {
		return nil, errors.New("MCP tool source is unavailable")
	}
	if ctx == nil {
		return nil, runharness.ErrRootContextRequired
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	tools, err := s.client.ListMCPTools(ctx)
	if err != nil {
		return nil, fmt.Errorf("list MCP tools: %w", err)
	}

	normalized := make([]DynamicMCPTool, 0, len(tools))
	index := make(map[string]DynamicMCPTool, len(tools))
	for _, tool := range tools {
		converted, ok := normalizeMCPClientTool(tool)
		if !ok {
			// Discovery metadata is untrusted.  Do not expose an alias that
			// cannot be routed back to one concrete MCP server.
			continue
		}
		if _, duplicate := index[converted.Descriptor.Name]; duplicate {
			continue
		}
		index[converted.Descriptor.Name] = converted
		normalized = append(normalized, converted)
	}

	s.mu.Lock()
	s.descriptors = index
	s.mu.Unlock()
	return normalized, nil
}

func (s *dynamicMCPSource) Resolve(ctx context.Context, name string) (runharness.ToolDescriptor, runharness.ToolExecutor, error) {
	if s == nil || s.client == nil {
		return runharness.ToolDescriptor{}, nil, ErrAgentToolNotFound
	}
	if ctx == nil {
		return runharness.ToolDescriptor{}, nil, runharness.ErrRootContextRequired
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return runharness.ToolDescriptor{}, nil, ErrAgentToolNotFound
	}

	s.mu.RLock()
	tool, found := s.descriptors[name]
	s.mu.RUnlock()
	if !found {
		if _, err := s.List(ctx); err != nil {
			return runharness.ToolDescriptor{}, nil, err
		}
		s.mu.RLock()
		tool, found = s.descriptors[name]
		s.mu.RUnlock()
	}
	if !found {
		return runharness.ToolDescriptor{}, nil, fmt.Errorf("%w: %s", ErrAgentToolNotFound, name)
	}

	return tool.Descriptor, &dynamicMCPClientExecutor{client: s.client, alias: name}, nil
}

func normalizeMCPClientTool(tool ai.MCPToolDescriptor) (DynamicMCPTool, bool) {
	alias := strings.TrimSpace(tool.Alias)
	if alias == "" && strings.TrimSpace(tool.ServerID) != "" && strings.TrimSpace(tool.OriginalName) != "" {
		alias = buildMCPToolAlias(tool.ServerID, tool.OriginalName)
	}
	if !isDynamicMCPAlias(alias) {
		return DynamicMCPTool{}, false
	}

	schema := json.RawMessage(`{"type":"object","properties":{}}`)
	if tool.InputSchema != nil {
		if encoded, err := json.Marshal(tool.InputSchema); err == nil && json.Valid(encoded) {
			schema = append(json.RawMessage(nil), encoded...)
		}
	}
	description := strings.TrimSpace(tool.Description)
	if description == "" {
		description = strings.TrimSpace(tool.Title)
	}

	return DynamicMCPTool{
		Descriptor: runharness.ToolDescriptor{
			Name:           alias,
			Description:    description,
			InputSchema:    schema,
			Effect:         runharness.ToolEffectSideEffectUnknown,
			Capabilities:   []string{"mcp", "dynamic"},
			MaxResultBytes: defaultDynamicMCPMaxResultBytes,
		},
		ServerID:     strings.TrimSpace(tool.ServerID),
		ServerName:   strings.TrimSpace(tool.ServerName),
		OriginalName: strings.TrimSpace(tool.OriginalName),
	}, true
}

type dynamicMCPClientExecutor struct {
	client MCPToolClient
	alias  string
}

var _ runharness.ToolExecutor = (*dynamicMCPClientExecutor)(nil)

func (e *dynamicMCPClientExecutor) Execute(ctx context.Context, request runharness.ToolExecutionRequest) (runharness.ToolExecutionResult, error) {
	if e == nil || e.client == nil {
		return failedAgentToolResult("tool_catalog_unavailable"), ErrAgentToolNotFound
	}
	if ctx == nil {
		return failedAgentToolResult("context_required"), runharness.ErrRootContextRequired
	}
	if err := ctx.Err(); err != nil {
		return failedAgentToolResult(agentToolErrorCode(err)), err
	}
	if requestName := strings.TrimSpace(request.ToolName); requestName != "" && requestName != e.alias {
		return failedAgentToolResult("tool_name_mismatch"), fmt.Errorf("%w: request=%q catalog=%q", ErrAgentToolArguments, requestName, e.alias)
	}
	if err := decodeAgentToolArguments(request.Arguments, nil); err != nil {
		return failedAgentToolResult("malformed_tool_call"), err
	}

	callResult, err := e.client.CallMCPTool(ctx, e.alias, string(request.Arguments))
	if err != nil {
		code := agentToolErrorCode(err)
		if code == "" || code == "tool_execution_failed" {
			code = "mcp_tool_failed"
		}
		return failedAgentToolResult(code), err
	}
	if err := ctx.Err(); err != nil {
		return failedAgentToolResult(agentToolErrorCode(err)), err
	}
	if callResult.IsError {
		message := strings.TrimSpace(callResult.Content)
		if message == "" {
			message = "MCP tool returned an error"
		}
		return runharness.ToolExecutionResult{Status: "failed", Value: callResult, ErrorCode: "mcp_tool_error"}, errors.New(message)
	}
	return runharness.ToolExecutionResult{Status: "completed", Value: callResult}, nil
}
