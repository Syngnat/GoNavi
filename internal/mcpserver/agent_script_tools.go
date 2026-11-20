package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/runharness"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func (c *AgentToolCatalog) resolveScriptEffect(
	ctx context.Context,
	name string,
	arguments json.RawMessage,
) (runharness.ToolEffect, bool, error) {
	if name != "run_script" {
		return "", false, nil
	}
	var args runScriptArgs
	if err := decodeAgentToolArguments(arguments, &args); err != nil {
		return "", true, err
	}
	if !args.AllowWrite {
		return runharness.ToolEffectReadOnly, true, nil
	}
	if c == nil || c.service == nil || c.service.backend == nil {
		return "", true, errors.New("MCP backend is unavailable")
	}
	if normalizeSQLSafetyLevel(c.service.backend.GetSQLSafetyLevel()) == ai.PermissionReadOnly {
		return "", true, fmt.Errorf("%w: the current AI safety level is read-only; set allowWrite=false or run this script in the Script Workbench", ErrAgentToolPolicyDenied)
	}
	return runharness.ToolEffectSideEffect, true, nil
}

func (e *agentToolExecutor) executeScriptTool(
	ctx context.Context,
	name string,
	request runharness.ToolExecutionRequest,
) (runharness.ToolExecutionResult, bool, error) {
	switch name {
	case "get_script_library":
		var args getScriptLibraryArgs
		if err := decodeAgentToolArguments(request.Arguments, &args); err != nil {
			return failedAgentToolResult("malformed_tool_call"), true, err
		}
		result, err := e.call(ctx, func() (*mcp.CallToolResult, any, error) {
			result, output, callErr := e.catalog.service.GetScriptLibrary(ctx, nil, args)
			return result, output, callErr
		})
		return result, true, err
	case "get_script":
		var args scriptIDArgs
		if err := decodeAgentToolArguments(request.Arguments, &args); err != nil {
			return failedAgentToolResult("malformed_tool_call"), true, err
		}
		result, err := e.call(ctx, func() (*mcp.CallToolResult, any, error) {
			result, output, callErr := e.catalog.service.GetScript(ctx, nil, args)
			return result, output, callErr
		})
		return result, true, err
	case "save_script":
		var args saveScriptArgs
		if err := decodeAgentToolArguments(request.Arguments, &args); err != nil {
			return failedAgentToolResult("malformed_tool_call"), true, err
		}
		result, err := e.call(ctx, func() (*mcp.CallToolResult, any, error) {
			result, output, callErr := e.catalog.service.SaveScript(ctx, nil, args)
			return result, output, callErr
		})
		return result, true, err
	case "list_script_input_sheets":
		var args scriptInputSheetsArgs
		if err := decodeAgentToolArguments(request.Arguments, &args); err != nil {
			return failedAgentToolResult("malformed_tool_call"), true, err
		}
		result, err := e.call(ctx, func() (*mcp.CallToolResult, any, error) {
			result, output, callErr := e.catalog.service.ListScriptInputSheets(ctx, nil, args)
			return result, output, callErr
		})
		return result, true, err
	case "prepare_script_write":
		var args prepareScriptWriteArgs
		if err := decodeAgentToolArguments(request.Arguments, &args); err != nil {
			return failedAgentToolResult("malformed_tool_call"), true, err
		}
		result, err := e.call(ctx, func() (*mcp.CallToolResult, any, error) {
			result, output, callErr := e.catalog.service.PrepareScriptWrite(ctx, nil, args)
			return result, output, callErr
		})
		return result, true, err
	case "run_script":
		result, err := e.executeRunScript(ctx, request)
		return result, true, err
	case "get_script_run":
		var args scriptRunIDArgs
		if err := decodeAgentToolArguments(request.Arguments, &args); err != nil {
			return failedAgentToolResult("malformed_tool_call"), true, err
		}
		result, err := e.call(ctx, func() (*mcp.CallToolResult, any, error) {
			result, output, callErr := e.catalog.service.GetScriptRun(ctx, nil, args)
			return result, output, callErr
		})
		return result, true, err
	case "get_script_output":
		var args scriptOutputArgs
		if err := decodeAgentToolArguments(request.Arguments, &args); err != nil {
			return failedAgentToolResult("malformed_tool_call"), true, err
		}
		result, err := e.call(ctx, func() (*mcp.CallToolResult, any, error) {
			result, output, callErr := e.catalog.service.GetScriptOutput(ctx, nil, args)
			return result, output, callErr
		})
		return result, true, err
	case "cancel_script_run":
		var args scriptRunIDArgs
		if err := decodeAgentToolArguments(request.Arguments, &args); err != nil {
			return failedAgentToolResult("malformed_tool_call"), true, err
		}
		result, err := e.call(ctx, func() (*mcp.CallToolResult, any, error) {
			result, output, callErr := e.catalog.service.CancelScriptRun(ctx, nil, args)
			return result, output, callErr
		})
		return result, true, err
	default:
		return runharness.ToolExecutionResult{}, false, nil
	}
}

func (e *agentToolExecutor) executeRunScript(ctx context.Context, request runharness.ToolExecutionRequest) (runharness.ToolExecutionResult, error) {
	var args runScriptArgs
	if err := decodeAgentToolArguments(request.Arguments, &args); err != nil {
		return failedAgentToolResult("malformed_tool_call"), err
	}
	effect, _, err := e.catalog.resolveScriptEffect(ctx, "run_script", request.Arguments)
	if err != nil {
		return failedAgentToolResult("policy_denied"), err
	}
	if !effect.Valid() {
		return failedAgentToolResult("invalid_effect"), fmt.Errorf("%w: %s", ErrAgentToolEffect, effect)
	}
	if effect == runharness.ToolEffectSideEffect && request.Effect == runharness.ToolEffectReadOnly {
		return failedAgentToolResult("effect_mismatch"), fmt.Errorf("%w: mutating script was classified as read_only", ErrAgentToolEffect)
	}
	return e.call(ctx, func() (*mcp.CallToolResult, any, error) {
		result, output, callErr := e.catalog.service.RunScript(ctx, nil, args)
		return result, output, callErr
	})
}

func scriptToolDescriptors() []runharness.ToolDescriptor {
	scriptCapabilities := []string{"database", "script"}
	readOnlyScript := func(name, description string, schema json.RawMessage) runharness.ToolDescriptor {
		return runharness.ToolDescriptor{Name: name, Description: description, InputSchema: schema,
			Effect: runharness.ToolEffectReadOnly, Capabilities: append([]string(nil), scriptCapabilities...), MaxResultBytes: 2 << 20}
	}
	scriptConnectionBindings := map[string]any{
		"type": "array",
		"items": map[string]any{
			"type":                 "object",
			"additionalProperties": false,
			"required":             []string{"alias", "connectionId"},
			"properties": map[string]any{
				"alias":        schemaString("script connection alias"),
				"connectionId": schemaString("saved connection ID"),
				"database":     schemaString("optional database or schema"),
			},
		},
	}
	scriptInputBindings := map[string]any{
		"type": "array",
		"items": map[string]any{
			"type":                 "object",
			"additionalProperties": false,
			"required":             []string{"alias"},
			"properties": map[string]any{
				"alias":     schemaString("script input alias"),
				"path":      schemaString("desktop CSV, JSON or XLSX path"),
				"reference": schemaString("web upload reference"),
				"name":      schemaString("optional display name"),
				"sheetName": schemaString("optional XLSX worksheet name"),
				"encoding":  schemaString("optional text encoding"),
				"delimiter": schemaString("optional CSV delimiter"),
				"headerRow": map[string]any{"type": "integer", "minimum": 1},
			},
		},
	}
	scriptRunProperties := func(includeApproval bool) map[string]any {
		properties := map[string]any{
			"scriptId":         schemaString("saved script ID; script or scriptId is required"),
			"script":           schemaString("inline JavaScript source; script or scriptId is required"),
			"title":            schemaString("optional run title"),
			"connections":      scriptConnectionBindings,
			"inputs":           scriptInputBindings,
			"allowWrite":       map[string]any{"type": "boolean", "description": "allow gonavi.db.execute and transactions; read-only safety denies writes, read/write denies DDL, full allows DDL"},
			"batchSize":        map[string]any{"type": "integer", "minimum": 1, "maximum": 5000},
			"inListLimit":      map[string]any{"type": "integer", "minimum": 1, "maximum": 1000},
			"timeoutMs":        map[string]any{"type": "integer", "minimum": 1},
			"maxDbCalls":       map[string]any{"type": "integer", "minimum": 1},
			"maxOutputRows":    map[string]any{"type": "integer", "minimum": 1},
			"memoryLimitBytes": map[string]any{"type": "integer", "minimum": 1},
		}
		if includeApproval {
			properties["writeApprovalToken"] = schemaString("one-time token from prepare_script_write for production writes")
			properties["waitSeconds"] = map[string]any{"type": "integer", "minimum": 0, "maximum": maxScriptRunWaitSecond, "description": "wait for terminal state; default 15 seconds, 0 returns immediately"}
		}
		return properties
	}
	return []runharness.ToolDescriptor{
		readOnlyScript("get_script_library", "List saved GoNavi scripts and folders, including script IDs, names, descriptions, connection aliases, input aliases and revisions. Source code is omitted; call get_script for the full source.", schemaObject(nil, map[string]any{
			"query": schemaString("optional keyword filter over script id, name, description, connection alias or input alias"),
			"limit": map[string]any{"type": "integer", "minimum": 0, "maximum": maxScriptLibraryLimit, "description": "maximum scripts to return; default 200"},
		})),
		readOnlyScript("get_script", "Read the full JavaScript source, connection/input bindings, write flag, run limits and revision of one saved GoNavi script.", schemaObject([]string{"scriptId"}, map[string]any{
			"scriptId": schemaString("saved script ID"),
		})),
		{
			Name:        "save_script",
			Description: "Create or update a saved GoNavi script. Updating an existing script requires the revision returned by get_script. This only saves source and bindings; it does not run the script.",
			InputSchema: schemaObject([]string{"name", "code"}, map[string]any{
				"id":               schemaString("optional script ID; empty creates a new script"),
				"name":             schemaString("script name"),
				"description":      schemaString("optional description"),
				"code":             schemaString("JavaScript source"),
				"visibility":       map[string]any{"type": "string", "enum": []string{"private", "shared"}},
				"folderId":         schemaString("optional script folder ID"),
				"connections":      scriptConnectionBindings,
				"inputs":           scriptInputBindings,
				"allowWrite":       map[string]any{"type": "boolean"},
				"batchSize":        map[string]any{"type": "integer", "minimum": 1, "maximum": 5000},
				"inListLimit":      map[string]any{"type": "integer", "minimum": 1, "maximum": 1000},
				"timeoutMs":        map[string]any{"type": "integer", "minimum": 1},
				"maxDbCalls":       map[string]any{"type": "integer", "minimum": 1},
				"maxOutputRows":    map[string]any{"type": "integer", "minimum": 1},
				"memoryLimitBytes": map[string]any{"type": "integer", "minimum": 1},
				"revision":         map[string]any{"type": "integer", "minimum": 0},
			}),
			Effect:         runharness.ToolEffectSideEffect,
			Capabilities:   append([]string(nil), scriptCapabilities...),
			MaxResultBytes: 1 << 20,
		},
		readOnlyScript("list_script_input_sheets", "List worksheet names in a CSV, JSON or XLSX script input. Use it before run_script when an XLSX workbook has multiple sheets.", schemaObject(nil, map[string]any{
			"path":      schemaString("desktop CSV, JSON or XLSX path"),
			"reference": schemaString("web upload reference"),
		})),
		readOnlyScript("prepare_script_write", "Create a one-time writeApprovalToken for a script that writes to an unprotected production connection. Reuse the exact same script, connections, inputs and limits in run_script.", schemaObject(nil, scriptRunProperties(false))),
		{
			Name:           "run_script",
			Description:    "Run a GoNavi Script Workbench JavaScript by scriptId or inline source with connection aliases, CSV/JSON/XLSX inputs, batching and resource limits. Use get_script_run and get_script_output to collect long-running results. Read-only safety blocks allowWrite; read/write blocks DDL; full allows DDL.",
			InputSchema:    schemaObject(nil, scriptRunProperties(true)),
			Effect:         runharness.ToolEffectSideEffectUnknown,
			Capabilities:   []string{"database", "script", "side_effect_dynamic"},
			MaxResultBytes: 2 << 20,
		},
		readOnlyScript("get_script_run", "Read the current status, stage, progress, recent logs, error and output summaries of a script run.", schemaObject([]string{"runId"}, map[string]any{
			"runId": schemaString("run ID returned by run_script"),
		})),
		readOnlyScript("get_script_output", "Read a page of rows from one gonavi.output stream. Use the outputIndex returned in the run snapshot.", schemaObject([]string{"runId", "outputIndex"}, map[string]any{
			"runId":       schemaString("run ID returned by run_script"),
			"outputIndex": map[string]any{"type": "integer", "minimum": 0},
			"page":        map[string]any{"type": "integer", "minimum": 1},
			"pageSize":    map[string]any{"type": "integer", "minimum": 1, "maximum": 200},
		})),
		{
			Name:        "cancel_script_run",
			Description: "Cancel a queued or running script and return its final snapshot.",
			InputSchema: schemaObject([]string{"runId"}, map[string]any{
				"runId": schemaString("run ID returned by run_script"),
			}),
			Effect:         runharness.ToolEffectSideEffect,
			Capabilities:   append([]string(nil), scriptCapabilities...),
			MaxResultBytes: 1 << 20,
		},
	}
}
