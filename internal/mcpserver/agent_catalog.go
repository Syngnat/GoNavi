package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/ai/runharness"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

var (
	ErrAgentToolNotFound     = errors.New("agent tool not found")
	ErrAgentToolArguments    = errors.New("agent tool arguments are invalid")
	ErrAgentToolEffect       = errors.New("agent tool effect is invalid")
	ErrAgentToolPolicyDenied = errors.New("agent tool execution is denied by policy")
)

const agentSQLToolName = "execute_sql"

const dynamicMCPAliasPrefix = "mcp__"

const defaultDynamicMCPMaxResultBytes int64 = 1 << 20

// DynamicMCPTool is the provider-facing description of a tool owned by a
// configured MCP server.  Keeping the server/original names alongside the
// runharness descriptor lets a host derive the stable mcp__<server>__<tool>
// alias without importing the AI service package into this adapter.
//
// A source may instead return an already-normalized descriptor (with Name set
// to the alias); the catalog accepts that form for hosts that keep MCP
// discovery in another package.
type DynamicMCPTool struct {
	Descriptor   runharness.ToolDescriptor
	ServerID     string
	ServerName   string
	OriginalName string
}

// DynamicMCPSource is the optional seam for host-owned MCP discovery and
// execution.  The source owns connection/session setup and returns an
// executor for the exact alias requested by the model.  The catalog still
// applies the conservative effect and argument checks around that executor.
//
// Implementations must honor ctx in both methods.  In particular, Resolve
// must not replace it with context.Background: the harness uses cancellation
// and deadlines to fence late MCP callbacks after a run is canceled.
type DynamicMCPSource interface {
	List(context.Context) ([]DynamicMCPTool, error)
	Resolve(context.Context, string) (runharness.ToolDescriptor, runharness.ToolExecutor, error)
}

// DynamicMCPSourceFuncs is a small function adapter useful to desktop and
// CLI hosts.  It also makes the source seam straightforward to test without
// introducing a dependency from mcpserver back to an application service.
type DynamicMCPSourceFuncs struct {
	ListFunc    func(context.Context) ([]DynamicMCPTool, error)
	ResolveFunc func(context.Context, string) (runharness.ToolDescriptor, runharness.ToolExecutor, error)
}

func (f DynamicMCPSourceFuncs) List(ctx context.Context) ([]DynamicMCPTool, error) {
	if f.ListFunc == nil {
		return nil, nil
	}
	return f.ListFunc(ctx)
}

func (f DynamicMCPSourceFuncs) Resolve(ctx context.Context, name string) (runharness.ToolDescriptor, runharness.ToolExecutor, error) {
	if f.ResolveFunc == nil {
		return runharness.ToolDescriptor{}, nil, ErrAgentToolNotFound
	}
	return f.ResolveFunc(ctx, name)
}

// AgentToolCatalog adapts GoNavi's built-in database MCP service to the
// provider-independent runharness ToolCatalog contract. The MCP server still
// owns the typed request/response implementation; this adapter is the only
// place where model tool calls are decoded and routed to that service.
type AgentToolCatalog struct {
	service       *Service
	descriptors   []runharness.ToolDescriptor
	dynamicSource DynamicMCPSource
}

// NewAgentToolCatalog creates the built-in database catalog. A nil backend is
// accepted so callers can inspect the catalog and schemas before wiring a
// runtime; resolving or executing a tool then returns a stable error.
func NewAgentToolCatalog(backend Backend) *AgentToolCatalog {
	return NewAgentToolCatalogWithDynamicSource(backend, nil)
}

// NewAgentToolCatalogWithDynamicSource creates the built-in database catalog
// and optionally appends tools discovered from a host-owned MCP source.  The
// old NewAgentToolCatalog constructor intentionally remains a no-source
// shorthand for the CLI and for callers that only need database tools.
func NewAgentToolCatalogWithDynamicSource(backend Backend, source DynamicMCPSource) *AgentToolCatalog {
	return &AgentToolCatalog{
		service:       NewService(backend),
		descriptors:   agentToolDescriptors(),
		dynamicSource: source,
	}
}

// NewAgentToolCatalogWithDynamicMCPSource is a descriptive alias retained for
// hosts that prefer to spell out that the optional source is MCP-specific.
func NewAgentToolCatalogWithDynamicMCPSource(backend Backend, source DynamicMCPSource) *AgentToolCatalog {
	return NewAgentToolCatalogWithDynamicSource(backend, source)
}

var _ runharness.ToolCatalog = (*AgentToolCatalog)(nil)

// List returns a defensive copy. Adapters may attach a frozen copy of the
// catalog to a model request without allowing a provider to mutate future
// runs' schemas.
func (c *AgentToolCatalog) List(ctx context.Context) ([]runharness.ToolDescriptor, error) {
	if c == nil {
		return nil, ErrAgentToolNotFound
	}
	if ctx == nil {
		return nil, runharness.ErrRootContextRequired
	}
	items := cloneAgentToolDescriptors(c.descriptors)
	if c.dynamicSource == nil {
		return items, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	dynamicTools, err := c.dynamicSource.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list dynamic MCP tools: %w", err)
	}
	seen := make(map[string]struct{}, len(items)+len(dynamicTools))
	for _, item := range items {
		seen[item.Name] = struct{}{}
	}
	for _, dynamic := range dynamicTools {
		descriptor, ok := normalizeDynamicMCPDescriptor(dynamic, "")
		if !ok {
			// A server can advertise malformed metadata.  Do not expose a
			// non-addressable tool to the provider; a valid source can still
			// expose its other tools in the same response.
			continue
		}
		if _, exists := seen[descriptor.Name]; exists {
			// Built-in names win, and duplicate aliases from two source
			// snapshots must not produce ambiguous tool routing.
			continue
		}
		seen[descriptor.Name] = struct{}{}
		items = append(items, descriptor)
	}
	return items, nil
}

// Resolve returns an executor for one built-in tool. Tool names are matched
// exactly; accepting aliases here would make the provider-facing catalog and
// the audit/tool ledger disagree about which capability was invoked.
func (c *AgentToolCatalog) Resolve(ctx context.Context, name string) (runharness.ToolDescriptor, runharness.ToolExecutor, error) {
	if c == nil {
		return runharness.ToolDescriptor{}, nil, ErrAgentToolNotFound
	}
	if ctx == nil {
		return runharness.ToolDescriptor{}, nil, runharness.ErrRootContextRequired
	}
	name = strings.TrimSpace(name)
	for _, descriptor := range c.descriptors {
		if descriptor.Name != name {
			continue
		}
		return descriptor, &agentToolExecutor{catalog: c, name: name}, nil
	}
	if c.dynamicSource != nil && isDynamicMCPAlias(name) {
		if err := ctx.Err(); err != nil {
			return runharness.ToolDescriptor{}, nil, err
		}
		descriptor, executor, err := c.dynamicSource.Resolve(ctx, name)
		if err != nil {
			return runharness.ToolDescriptor{}, nil, err
		}
		if executor == nil {
			return runharness.ToolDescriptor{}, nil, fmt.Errorf("%w: dynamic MCP executor is nil for %s", ErrAgentToolNotFound, name)
		}
		descriptor, ok := normalizeDynamicMCPDescriptor(DynamicMCPTool{Descriptor: descriptor}, name)
		if !ok {
			return runharness.ToolDescriptor{}, nil, fmt.Errorf("%w: invalid dynamic MCP descriptor for %s", ErrAgentToolArguments, name)
		}
		return descriptor, &dynamicMCPToolExecutor{name: name, descriptor: descriptor, delegate: executor}, nil
	}
	return runharness.ToolDescriptor{}, nil, fmt.Errorf("%w: %s", ErrAgentToolNotFound, name)
}

func cloneAgentToolDescriptors(source []runharness.ToolDescriptor) []runharness.ToolDescriptor {
	items := make([]runharness.ToolDescriptor, len(source))
	copy(items, source)
	for i := range items {
		items[i].InputSchema = append(json.RawMessage(nil), items[i].InputSchema...)
		items[i].Capabilities = append([]string(nil), items[i].Capabilities...)
	}
	return items
}

// normalizeDynamicMCPDescriptor converts both source forms (metadata-rich or
// already aliased) into one immutable provider-facing descriptor.  Dynamic MCP
// tools are untrusted: absent/invalid effect metadata is deliberately mapped
// to side_effect_unknown so the Harness will request approval for every call.
func normalizeDynamicMCPDescriptor(tool DynamicMCPTool, requestedName string) (runharness.ToolDescriptor, bool) {
	descriptor := tool.Descriptor
	name := strings.TrimSpace(requestedName)
	serverID := strings.TrimSpace(tool.ServerID)
	originalName := strings.TrimSpace(tool.OriginalName)
	if name == "" && serverID != "" && originalName != "" {
		name = buildMCPToolAlias(serverID, originalName)
	}
	if name == "" {
		name = strings.TrimSpace(descriptor.Name)
	}
	if name == "" {
		return runharness.ToolDescriptor{}, false
	}
	if serverID != "" && originalName != "" {
		canonical := buildMCPToolAlias(serverID, originalName)
		if canonical == "" {
			return runharness.ToolDescriptor{}, false
		}
		name = canonical
	}
	if !isDynamicMCPAlias(name) {
		return runharness.ToolDescriptor{}, false
	}
	descriptor.Name = name
	if !descriptor.Effect.Valid() {
		descriptor.Effect = runharness.ToolEffectSideEffectUnknown
	}
	if len(descriptor.InputSchema) == 0 || !json.Valid(descriptor.InputSchema) {
		descriptor.InputSchema = schemaObject(nil, nil)
	}
	if descriptor.MaxResultBytes <= 0 {
		descriptor.MaxResultBytes = defaultDynamicMCPMaxResultBytes
	}
	descriptor.Capabilities = appendUniqueStrings(descriptor.Capabilities, "mcp", "dynamic")
	descriptor.InputSchema = append(json.RawMessage(nil), descriptor.InputSchema...)
	descriptor.Capabilities = append([]string(nil), descriptor.Capabilities...)
	return descriptor, true
}

func appendUniqueStrings(values []string, additions ...string) []string {
	result := append([]string(nil), values...)
	seen := make(map[string]struct{}, len(result)+len(additions))
	for _, value := range result {
		seen[value] = struct{}{}
	}
	for _, value := range additions {
		if strings.TrimSpace(value) == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func isDynamicMCPAlias(name string) bool {
	trimmed := strings.TrimSpace(name)
	if !strings.HasPrefix(trimmed, dynamicMCPAliasPrefix) {
		return false
	}
	parts := strings.SplitN(strings.TrimPrefix(trimmed, dynamicMCPAliasPrefix), "__", 2)
	return len(parts) == 2 && strings.TrimSpace(parts[0]) != "" && strings.TrimSpace(parts[1]) != ""
}

// buildMCPToolAlias mirrors the alias contract used by the existing Wails
// MCP APIs.  It intentionally lives in this package too: importing the AI
// service here would create a dependency cycle through AppBackend.
func buildMCPToolAlias(serverID, originalName string) string {
	return dynamicMCPAliasPrefix + sanitizeMCPAliasPart(serverID) + "__" + sanitizeMCPAliasPart(originalName)
}

func sanitizeMCPAliasPart(raw string) string {
	var builder strings.Builder
	builder.Grow(len(raw))
	for _, r := range strings.TrimSpace(raw) {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			builder.WriteRune(r)
		case r == '_', r == '-', r == '.':
			builder.WriteRune(r)
		default:
			builder.WriteByte('_')
		}
	}
	return strings.Trim(builder.String(), "_")
}

// dynamicMCPToolExecutor validates the final request at the execution
// boundary and delegates with the exact context supplied by the Harness.
// This prevents a source implementation from accidentally accepting a stale
// read-only classification or a malformed argument payload.
type dynamicMCPToolExecutor struct {
	name       string
	descriptor runharness.ToolDescriptor
	delegate   runharness.ToolExecutor
}

var _ runharness.ToolExecutor = (*dynamicMCPToolExecutor)(nil)

func (e *dynamicMCPToolExecutor) Execute(ctx context.Context, request runharness.ToolExecutionRequest) (runharness.ToolExecutionResult, error) {
	if e == nil || e.delegate == nil {
		return failedAgentToolResult("tool_catalog_unavailable"), ErrAgentToolNotFound
	}
	if ctx == nil {
		return failedAgentToolResult("context_required"), runharness.ErrRootContextRequired
	}
	if err := ctx.Err(); err != nil {
		return failedAgentToolResult("canceled"), err
	}
	if requestName := strings.TrimSpace(request.ToolName); requestName != "" && requestName != e.name {
		return failedAgentToolResult("tool_name_mismatch"), fmt.Errorf("%w: request=%q catalog=%q", ErrAgentToolArguments, requestName, e.name)
	}
	if request.Effect != "" && !request.Effect.Valid() {
		return failedAgentToolResult("invalid_effect"), fmt.Errorf("%w: %q", ErrAgentToolEffect, request.Effect)
	}
	if !dynamicEffectCompatible(e.descriptor.Effect, request.Effect) {
		return failedAgentToolResult("effect_mismatch"), fmt.Errorf("%w: dynamic MCP tool %s cannot be downgraded from %s to %s", ErrAgentToolEffect, e.name, e.descriptor.Effect, request.Effect)
	}
	if err := decodeAgentToolArguments(request.Arguments, nil); err != nil {
		return failedAgentToolResult("malformed_tool_call"), err
	}

	result, err := e.delegate.Execute(ctx, request)
	if result.Status == "" {
		if err != nil {
			result.Status = "failed"
		} else {
			result.Status = "completed"
		}
	}
	if err != nil && result.ErrorCode == "" {
		result.ErrorCode = agentToolErrorCode(err)
		if result.ErrorCode == "" || result.ErrorCode == "tool_execution_failed" {
			result.ErrorCode = "mcp_tool_failed"
		}
	}
	// A source may expose the raw SDK result as Value. Preserve it (including
	// text and structuredContent), while honoring MCP's IsError bit in the
	// Harness result status.
	if callResult, ok := dynamicCallToolResult(result.Value); ok && callResult != nil && callResult.IsError {
		if result.Status == "completed" {
			result.Status = "failed"
		}
		if result.ErrorCode == "" {
			result.ErrorCode = "mcp_tool_error"
		}
	}
	return result, err
}

func dynamicEffectCompatible(declared, requested runharness.ToolEffect) bool {
	if requested == "" || declared == "" {
		return true
	}
	if !declared.Valid() || !requested.Valid() {
		return false
	}
	// A caller may strengthen an effect (for example, unknown -> side_effect),
	// but never weaken an untrusted dynamic declaration into a non-approving
	// effect.  Pure/read-only are the only mutually interchangeable safe class.
	if declared == runharness.ToolEffectSideEffectUnknown {
		return requested == runharness.ToolEffectSideEffectUnknown || requested == runharness.ToolEffectSideEffect
	}
	if declared == runharness.ToolEffectSideEffect {
		return requested == runharness.ToolEffectSideEffect || requested == runharness.ToolEffectSideEffectUnknown
	}
	if declared == runharness.ToolEffectIdempotent {
		return requested == runharness.ToolEffectIdempotent || requested == runharness.ToolEffectSideEffect || requested == runharness.ToolEffectSideEffectUnknown
	}
	if declared == runharness.ToolEffectReadOnly {
		return requested == runharness.ToolEffectPure || requested == runharness.ToolEffectReadOnly || requested == runharness.ToolEffectIdempotent || requested == runharness.ToolEffectSideEffect || requested == runharness.ToolEffectSideEffectUnknown
	}
	return true
}

func dynamicCallToolResult(value any) (*mcp.CallToolResult, bool) {
	switch typed := value.(type) {
	case *mcp.CallToolResult:
		return typed, true
	case mcp.CallToolResult:
		return &typed, true
	default:
		return nil, false
	}
}

// ResolveEffect computes the effect after decoding the actual arguments. It
// is intentionally an optional extension to runharness.ToolCatalog: older
// harnesses can conservatively use the descriptor's
// side_effect_unknown value, while newer harnesses can call this method before
// creating an approval and avoid prompting for read-only SELECT statements.
func (c *AgentToolCatalog) ResolveEffect(ctx context.Context, name string, arguments json.RawMessage) (runharness.ToolEffect, error) {
	if ctx == nil {
		return "", runharness.ErrRootContextRequired
	}
	if c == nil {
		return "", ErrAgentToolNotFound
	}
	name = strings.TrimSpace(name)
	descriptor, _, err := c.Resolve(ctx, name)
	if err != nil {
		return "", err
	}
	if name != agentSQLToolName {
		return descriptor.Effect, nil
	}
	var args executeSQLArgs
	if err := decodeAgentToolArguments(arguments, &args); err != nil {
		return "", err
	}
	if c.service == nil || c.service.backend == nil {
		return "", errors.New("MCP backend is unavailable")
	}
	view, errResult := c.service.resolveConnection(args.ConnectionID)
	if errResult != nil {
		return "", errors.New(agentToolResultMessage(errResult))
	}
	inspection := c.service.backend.InspectSQL(view.Config.Type, strings.TrimSpace(args.SQL))
	if inspection.StatementCount == 0 || !isConsistentSQLInspection(inspection) {
		return "", fmt.Errorf("%w: SQL inspection failed", ErrAgentToolPolicyDenied)
	}
	if inspection.ReadOnly {
		return runharness.ToolEffectReadOnly, nil
	}
	// Apply the same AI safety decision and saved-connection protection before
	// advertising a mutation to the approval layer. A denied operation must
	// never be turned into an approval prompt; the executor repeats these checks
	// immediately before dispatch to cover changes made while approval waited.
	safetyDecision := evaluateSQLSafety(normalizeSQLSafetyLevel(c.service.backend.GetSQLSafetyLevel()), inspection)
	if len(safetyDecision.disallowed) > 0 {
		return "", fmt.Errorf("%w: SQL is blocked by the current safety level (%s)", ErrAgentToolPolicyDenied, formatSafetyStatements(safetyDecision.disallowed))
	}
	if err := c.service.backend.AuthorizeSQLConnection(view.Config, strings.TrimSpace(args.SQL)); err != nil {
		return "", fmt.Errorf("%w: connection write protection denied SQL: %v", ErrAgentToolPolicyDenied, err)
	}
	// A mutating statement that passed the guard is still side-effecting. The
	// Harness must obtain an exact-argument approval before its executor runs.
	return runharness.ToolEffectSideEffect, nil
}

type agentToolExecutor struct {
	catalog *AgentToolCatalog
	name    string
}

var _ runharness.ToolExecutor = (*agentToolExecutor)(nil)

func (e *agentToolExecutor) Execute(ctx context.Context, request runharness.ToolExecutionRequest) (runharness.ToolExecutionResult, error) {
	if e == nil || e.catalog == nil {
		return failedAgentToolResult("tool_catalog_unavailable"), ErrAgentToolNotFound
	}
	if ctx == nil {
		return failedAgentToolResult("context_required"), runharness.ErrRootContextRequired
	}
	if err := ctx.Err(); err != nil {
		return failedAgentToolResult("canceled"), err
	}
	name := strings.TrimSpace(e.name)
	if strings.TrimSpace(request.ToolName) != "" && strings.TrimSpace(request.ToolName) != name {
		return failedAgentToolResult("tool_name_mismatch"), fmt.Errorf("%w: request=%q catalog=%q", ErrAgentToolArguments, request.ToolName, name)
	}
	if request.Effect != "" && !request.Effect.Valid() {
		return failedAgentToolResult("invalid_effect"), fmt.Errorf("%w: %q", ErrAgentToolEffect, request.Effect)
	}
	if err := decodeAgentToolArguments(request.Arguments, nil); err != nil {
		return failedAgentToolResult("malformed_tool_call"), err
	}

	switch name {
	case "get_connections":
		var args emptyArgs
		return e.call(ctx, func() (*mcp.CallToolResult, any, error) {
			result, output, err := e.catalog.service.GetConnections(ctx, nil, args)
			return result, output, err
		})
	case "get_databases":
		var args connectionIDArgs
		if err := decodeAgentToolArguments(request.Arguments, &args); err != nil {
			return failedAgentToolResult("malformed_tool_call"), err
		}
		return e.call(ctx, func() (*mcp.CallToolResult, any, error) {
			result, output, err := e.catalog.service.GetDatabases(ctx, nil, args)
			return result, output, err
		})
	case "get_tables":
		var args databaseArgs
		if err := decodeAgentToolArguments(request.Arguments, &args); err != nil {
			return failedAgentToolResult("malformed_tool_call"), err
		}
		return e.call(ctx, func() (*mcp.CallToolResult, any, error) {
			result, output, err := e.catalog.service.GetTables(ctx, nil, args)
			return result, output, err
		})
	case "get_views":
		var args databaseArgs
		if err := decodeAgentToolArguments(request.Arguments, &args); err != nil {
			return failedAgentToolResult("malformed_tool_call"), err
		}
		return e.call(ctx, func() (*mcp.CallToolResult, any, error) {
			result, output, err := e.catalog.service.GetViews(ctx, nil, args)
			return result, output, err
		})
	case "get_objects":
		var args objectsArgs
		if err := decodeAgentToolArguments(request.Arguments, &args); err != nil {
			return failedAgentToolResult("malformed_tool_call"), err
		}
		return e.call(ctx, func() (*mcp.CallToolResult, any, error) {
			result, output, err := e.catalog.service.GetObjects(ctx, nil, args)
			return result, output, err
		})
	case "get_all_columns":
		var args databaseArgs
		if err := decodeAgentToolArguments(request.Arguments, &args); err != nil {
			return failedAgentToolResult("malformed_tool_call"), err
		}
		return e.call(ctx, func() (*mcp.CallToolResult, any, error) {
			result, output, err := e.catalog.service.GetAllColumns(ctx, nil, args)
			return result, output, err
		})
	case "get_columns":
		var args tableArgs
		if err := decodeAgentToolArguments(request.Arguments, &args); err != nil {
			return failedAgentToolResult("malformed_tool_call"), err
		}
		return e.call(ctx, func() (*mcp.CallToolResult, any, error) {
			result, output, err := e.catalog.service.GetColumns(ctx, nil, args)
			return result, output, err
		})
	case "get_indexes":
		var args tableArgs
		if err := decodeAgentToolArguments(request.Arguments, &args); err != nil {
			return failedAgentToolResult("malformed_tool_call"), err
		}
		return e.call(ctx, func() (*mcp.CallToolResult, any, error) {
			result, output, err := e.catalog.service.GetIndexes(ctx, nil, args)
			return result, output, err
		})
	case "get_foreign_keys":
		var args tableArgs
		if err := decodeAgentToolArguments(request.Arguments, &args); err != nil {
			return failedAgentToolResult("malformed_tool_call"), err
		}
		return e.call(ctx, func() (*mcp.CallToolResult, any, error) {
			result, output, err := e.catalog.service.GetForeignKeys(ctx, nil, args)
			return result, output, err
		})
	case "get_triggers":
		var args tableArgs
		if err := decodeAgentToolArguments(request.Arguments, &args); err != nil {
			return failedAgentToolResult("malformed_tool_call"), err
		}
		return e.call(ctx, func() (*mcp.CallToolResult, any, error) {
			result, output, err := e.catalog.service.GetTriggers(ctx, nil, args)
			return result, output, err
		})
	case "get_table_ddl":
		var args tableArgs
		if err := decodeAgentToolArguments(request.Arguments, &args); err != nil {
			return failedAgentToolResult("malformed_tool_call"), err
		}
		return e.call(ctx, func() (*mcp.CallToolResult, any, error) {
			result, output, err := e.catalog.service.GetTableDDL(ctx, nil, args)
			return result, output, err
		})
	case agentSQLToolName:
		return e.executeSQL(ctx, request)
	default:
		return failedAgentToolResult("tool_not_found"), fmt.Errorf("%w: %s", ErrAgentToolNotFound, name)
	}
}

func (e *agentToolExecutor) executeSQL(ctx context.Context, request runharness.ToolExecutionRequest) (runharness.ToolExecutionResult, error) {
	var args executeSQLArgs
	if err := decodeAgentToolArguments(request.Arguments, &args); err != nil {
		return failedAgentToolResult("malformed_tool_call"), err
	}
	effect, err := e.catalog.ResolveEffect(ctx, agentSQLToolName, request.Arguments)
	if err != nil {
		return failedAgentToolResult("policy_denied"), err
	}
	if !effect.Valid() {
		return failedAgentToolResult("invalid_effect"), fmt.Errorf("%w: %s", ErrAgentToolEffect, effect)
	}
	// A caller that has already classified this call as read-only cannot use
	// that stale classification to smuggle a mutating statement through. An
	// empty or side_effect_unknown effect is accepted for compatibility with a
	// harness that performs dynamic classification after Resolve.
	if effect == runharness.ToolEffectSideEffect && request.Effect == runharness.ToolEffectReadOnly {
		return failedAgentToolResult("effect_mismatch"), fmt.Errorf("%w: mutating SQL was classified as read_only", ErrAgentToolEffect)
	}
	allowMutating := effect == runharness.ToolEffectSideEffect
	return e.call(ctx, func() (*mcp.CallToolResult, any, error) {
		result, output, callErr := e.catalog.service.ExecuteSQL(ctx, nil, executeSQLArgs{
			ConnectionID: args.ConnectionID, DBName: args.DBName, SQL: args.SQL,
			// Harness approval is the authorization boundary for this execution.
			// The service still re-checks the shared safety level and connection
			// protection immediately before dispatch.
			AllowMutating:    allowMutating,
			MaxRowsPerResult: args.MaxRowsPerResult,
		})
		return result, output, callErr
	})
}

func (e *agentToolExecutor) call(ctx context.Context, fn func() (*mcp.CallToolResult, any, error)) (runharness.ToolExecutionResult, error) {
	if e == nil || e.catalog == nil || e.catalog.service == nil || e.catalog.service.backend == nil {
		return failedAgentToolResult("tool_catalog_unavailable"), errors.New("MCP backend is unavailable")
	}
	if err := ctx.Err(); err != nil {
		return failedAgentToolResult("canceled"), err
	}
	callResult, value, err := fn()
	if err != nil {
		return failedAgentToolResult(agentToolErrorCode(err)), err
	}
	if callResult != nil && callResult.IsError {
		message := agentToolResultMessage(callResult)
		if message == "" {
			message = "built-in agent tool failed"
		}
		failure := failedAgentToolResult(agentToolErrorCode(errors.New(message)))
		failure.Value = value
		failure.UnknownOutcome = agentToolValueUnknown(value)
		return failure, errors.New(message)
	}
	return runharness.ToolExecutionResult{Status: "completed", Value: value}, nil
}

func agentToolValueUnknown(value any) bool {
	switch typed := value.(type) {
	case executeSQLResult:
		return typed.OutcomeUnknown
	case *executeSQLResult:
		return typed != nil && typed.OutcomeUnknown
	default:
		return false
	}
}

func failedAgentToolResult(code string) runharness.ToolExecutionResult {
	return runharness.ToolExecutionResult{Status: "failed", ErrorCode: code}
}

func agentToolErrorCode(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, context.Canceled) {
		return "canceled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "deadline"
	}
	if errors.Is(err, ErrAgentToolPolicyDenied) {
		return "policy_denied"
	}
	if errors.Is(err, ErrAgentToolArguments) {
		return "malformed_tool_call"
	}
	return "tool_execution_failed"
}

func decodeAgentToolArguments(raw json.RawMessage, target any) error {
	if len(strings.TrimSpace(string(raw))) == 0 {
		raw = json.RawMessage(`{}`)
	}
	if !json.Valid(raw) {
		return fmt.Errorf("%w: arguments are not valid JSON", ErrAgentToolArguments)
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		if err == nil {
			err = errors.New("arguments must be a JSON object")
		}
		return fmt.Errorf("%w: %v", ErrAgentToolArguments, err)
	}
	if target == nil {
		return nil
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("%w: %v", ErrAgentToolArguments, err)
	}
	return nil
}

func agentToolResultMessage(result *mcp.CallToolResult) string {
	if result == nil {
		return ""
	}
	for _, content := range result.Content {
		switch item := content.(type) {
		case *mcp.TextContent:
			if text := strings.TrimSpace(item.Text); text != "" {
				return text
			}
		}
	}
	return ""
}

func agentToolDescriptors() []runharness.ToolDescriptor {
	metadataCapabilities := []string{"database", "metadata"}
	readOnly := func(name, description string, schema json.RawMessage) runharness.ToolDescriptor {
		return runharness.ToolDescriptor{Name: name, Description: description, InputSchema: schema,
			Effect: runharness.ToolEffectReadOnly, Capabilities: append([]string(nil), metadataCapabilities...), MaxResultBytes: 1 << 20}
	}
	return []runharness.ToolDescriptor{
		readOnly("get_connections", "List saved GoNavi database connections. Use the returned connectionId for subsequent calls.", schemaObject(nil, nil)),
		readOnly("get_databases", "List databases or schemas for a saved connection.", schemaObject([]string{"connectionId"}, map[string]any{"connectionId": schemaString("saved connection ID")})),
		readOnly("get_tables", "List tables and views for a saved connection and optional database.", schemaObject([]string{"connectionId"}, map[string]any{"connectionId": schemaString("saved connection ID"), "dbName": schemaString("optional database or schema")})),
		readOnly("get_views", "List views for a saved connection and optional database.", schemaObject([]string{"connectionId"}, map[string]any{"connectionId": schemaString("saved connection ID"), "dbName": schemaString("optional database or schema")})),
		readOnly("get_objects", "List database objects for a saved connection and optional database.", schemaObject([]string{"connectionId"}, map[string]any{"connectionId": schemaString("saved connection ID"), "dbName": schemaString("optional database or schema"), "objectTypes": map[string]any{"type": "array", "items": map[string]any{"type": "string"}}})),
		readOnly("get_all_columns", "List column definitions for every table in a database.", schemaObject([]string{"connectionId", "dbName"}, map[string]any{"connectionId": schemaString("saved connection ID"), "dbName": schemaString("database or schema")})),
		readOnly("get_columns", "List columns for one table or view.", schemaObject([]string{"connectionId", "tableName"}, map[string]any{"connectionId": schemaString("saved connection ID"), "dbName": schemaString("optional database or schema"), "tableName": schemaString("table or view name")})),
		readOnly("get_indexes", "List indexes for one table.", schemaObject([]string{"connectionId", "tableName"}, map[string]any{"connectionId": schemaString("saved connection ID"), "dbName": schemaString("optional database or schema"), "tableName": schemaString("table name")})),
		readOnly("get_foreign_keys", "List foreign keys for one table.", schemaObject([]string{"connectionId", "tableName"}, map[string]any{"connectionId": schemaString("saved connection ID"), "dbName": schemaString("optional database or schema"), "tableName": schemaString("table name")})),
		readOnly("get_triggers", "List triggers for one table.", schemaObject([]string{"connectionId", "tableName"}, map[string]any{"connectionId": schemaString("saved connection ID"), "dbName": schemaString("optional database or schema"), "tableName": schemaString("table name")})),
		readOnly("get_table_ddl", "Return the CREATE statement for one table or view.", schemaObject([]string{"connectionId", "tableName"}, map[string]any{"connectionId": schemaString("saved connection ID"), "dbName": schemaString("optional database or schema"), "tableName": schemaString("table or view name")})),
		{
			Name:        agentSQLToolName,
			Description: "Execute SQL against a saved connection. Read-only statements run directly; mutating statements are classified from SQL inspection and require an explicit Harness approval before dispatch.",
			InputSchema: schemaObject([]string{"connectionId", "sql"}, map[string]any{
				"connectionId":     schemaString("saved connection ID"),
				"dbName":           schemaString("optional database or schema"),
				"sql":              schemaString("SQL text"),
				"allowMutating":    map[string]any{"type": "boolean", "description": "legacy hint; Harness approval remains required"},
				"maxRowsPerResult": map[string]any{"type": "integer", "minimum": 0, "maximum": maxRowsPerResultLimit},
			}),
			// Static fallback is conservative. ResolveEffect supplies the exact
			// read_only/side_effect classification when the Harness supports it.
			Effect:         runharness.ToolEffectSideEffectUnknown,
			Capabilities:   []string{"database", "sql", "side_effect_dynamic"},
			MaxResultBytes: 1 << 20,
		},
	}
}

func schemaString(description string) map[string]any {
	return map[string]any{"type": "string", "description": description}
}

func schemaObject(required []string, properties map[string]any) json.RawMessage {
	if properties == nil {
		properties = map[string]any{}
	}
	payload := map[string]any{"type": "object", "properties": properties, "additionalProperties": false}
	if len(required) > 0 {
		payload["required"] = required
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		// All values above are JSON primitives/maps; retaining a valid schema is
		// preferable to panicking during package initialization if that ever
		// changes.
		return json.RawMessage(`{"type":"object"}`)
	}
	return encoded
}
