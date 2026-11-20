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
	"GoNavi-Wails/internal/scriptlib"

	"github.com/google/jsonschema-go/jsonschema"
)

func TestGetScriptLibrarySummarizesWithoutSource(t *testing.T) {
	backend := &fakeBackend{
		scriptLibraryResult: connection.QueryResult{
			Success: true,
			Data: appcore.ScriptWorkbenchLibrarySnapshot{
				Snapshot: scriptlib.Snapshot{
					Owner: "local",
					Scripts: []scriptlib.Script{{
						ID:          "script-1",
						Name:        "Batch IDs",
						Description: "Lookup ids in batches",
						Code:        "const secret = 'should-not-leak';",
						Visibility:  scriptlib.VisibilityPrivate,
						Connections: []scriptlib.ConnectionBinding{{Alias: "prod", ConnectionID: "conn-1"}},
						Inputs:      []scriptlib.InputBinding{{Alias: "ids", Name: "ids.xlsx"}},
						AllowWrite:  false,
						Revision:    3,
					}},
					Folders:  []scriptlib.Folder{{ID: "folder-1", Name: "Ops"}},
					CanWrite: true,
				},
			},
		},
	}

	result := callServerTool(t, NewServer(backend), "get_script_library", map[string]any{})
	if result.IsError {
		t.Fatalf("get_script_library returned error: %#v", result.Content)
	}
	payload := marshalStructuredContent(t, result.StructuredContent)
	for _, expected := range []string{`"id":"script-1"`, `"alias":"prod"`, `"alias":"ids"`} {
		if !strings.Contains(payload, expected) {
			t.Fatalf("structured library missing %s: %s", expected, payload)
		}
	}
	if strings.Contains(payload, "should-not-leak") {
		t.Fatalf("script source leaked into library summary: %s", payload)
	}
	if !strings.Contains(payload, `"id":"folder-1"`) {
		t.Fatalf("structured library missing folder: %s", payload)
	}
}

func TestGetScriptReturnsFullSource(t *testing.T) {
	backend := &fakeBackend{
		scriptLibraryResult: connection.QueryResult{
			Success: true,
			Data: appcore.ScriptWorkbenchLibrarySnapshot{
				Snapshot: scriptlib.Snapshot{
					Scripts: []scriptlib.Script{{
						ID:         "script-1",
						Name:       "Batch IDs",
						Code:       "gonavi.output('rows', [{id: 1}]);",
						Revision:   2,
						Visibility: scriptlib.VisibilityPrivate,
					}},
				},
			},
		},
	}

	result := callServerTool(t, NewServer(backend), "get_script", map[string]any{"scriptId": "script-1"})
	if result.IsError {
		t.Fatalf("get_script returned error: %#v", result.Content)
	}
	payload := marshalStructuredContent(t, result.StructuredContent)
	if !strings.Contains(payload, "gonavi.output") || !strings.Contains(payload, `"revision":2`) {
		t.Fatalf("get_script did not return full source: %s", payload)
	}
}

func TestPrepareScriptWriteReturnsBoundToken(t *testing.T) {
	backend := &fakeBackend{
		scriptPrepareResult: connection.QueryResult{
			Success: true,
			Data: appcore.ScriptWorkbenchWriteApproval{
				Required:  true,
				Token:     "approval-token",
				ExpiresAt: 123456,
			},
		},
	}

	result := callServerTool(t, NewServer(backend), "prepare_script_write", map[string]any{
		"scriptId":   "script-1",
		"allowWrite": true,
		"connections": []any{
			map[string]any{"alias": "prod", "connectionId": "conn-1", "database": "app"},
		},
		"inputs": []any{
			map[string]any{"alias": "ids", "path": "/tmp/ids.xlsx", "sheetName": "IDs"},
		},
		"timeoutMs": 120000,
	})
	if result.IsError {
		t.Fatalf("prepare_script_write returned error: %#v", result.Content)
	}
	if len(backend.scriptPrepareRequests) != 1 {
		t.Fatalf("prepare requests = %d, want 1", len(backend.scriptPrepareRequests))
	}
	request := backend.scriptPrepareRequests[0]
	if request.ScriptID != "script-1" || !request.AllowWrite || request.TimeoutMs != 120000 {
		t.Fatalf("prepare request = %#v", request)
	}
	if len(request.Connections) != 1 || request.Connections[0].Alias != "prod" {
		t.Fatalf("prepare connections = %#v", request.Connections)
	}
	if len(request.Inputs) != 1 || request.Inputs[0].SheetName != "IDs" {
		t.Fatalf("prepare inputs = %#v", request.Inputs)
	}
	text := firstTextContent(result)
	if !strings.Contains(text, "approval-token") || !strings.Contains(text, "expiresAt=123456") {
		t.Fatalf("prepare text = %q", text)
	}
}

func TestRunScriptWaitsForTerminalSnapshot(t *testing.T) {
	backend := &fakeBackend{
		scriptRunResult: connection.QueryResult{
			Success: true,
			Data: appcore.ScriptWorkbenchRunSnapshot{
				RunID:  "run-1",
				Title:  "Batch IDs",
				Status: "running",
			},
		},
		scriptGetRunResult: connection.QueryResult{
			Success: true,
			Data: appcore.ScriptWorkbenchRunSnapshot{
				RunID:      "run-1",
				Title:      "Batch IDs",
				Status:     "succeeded",
				FinishedAt: 20,
				StartedAt:  10,
				Logs: []appcore.ScriptWorkbenchLogEntry{
					{Level: "info", Message: "done"},
				},
				Outputs: []appcore.ScriptWorkbenchOutputInfo{
					{Index: 0, Name: "rows", Columns: []string{"id"}, RowCount: 1},
				},
			},
		},
	}

	result := callServerTool(t, NewServer(backend), "run_script", map[string]any{
		"script":        "gonavi.output('rows', [{id: 1}]);",
		"title":         "Batch IDs",
		"allowWrite":    false,
		"waitSeconds":   1,
		"maxDbCalls":    10,
		"maxOutputRows": 100,
	})
	if result.IsError {
		t.Fatalf("run_script returned error: %s", firstTextContent(result))
	}
	if len(backend.scriptRunRequests) != 1 {
		t.Fatalf("run requests = %d, want 1", len(backend.scriptRunRequests))
	}
	request := backend.scriptRunRequests[0]
	if request.Script != "gonavi.output('rows', [{id: 1}]);" || request.Title != "Batch IDs" {
		t.Fatalf("run request = %#v", request)
	}
	payload := marshalStructuredContent(t, result.StructuredContent)
	if !strings.Contains(payload, `"status":"succeeded"`) || !strings.Contains(payload, `"runId":"run-1"`) {
		t.Fatalf("run result did not wait for terminal state: %s", payload)
	}
	text := firstTextContent(result)
	if !strings.Contains(text, "脚本运行：succeeded") || !strings.Contains(text, "outputIndex") {
		t.Fatalf("run text = %q", text)
	}
}

func TestGetScriptOutputReturnsPagedRows(t *testing.T) {
	backend := &fakeBackend{
		scriptOutputResult: connection.QueryResult{
			Success: true,
			Data: appcore.ScriptWorkbenchOutputPage{
				OutputIndex: 0,
				Name:        "rows",
				Columns:     []string{"id"},
				Rows:        []map[string]any{{"id": 2}},
				Total:       3,
				Page:        2,
				PageSize:    1,
			},
		},
	}

	result := callServerTool(t, NewServer(backend), "get_script_output", map[string]any{
		"runId":       "run-1",
		"outputIndex": 0,
		"page":        2,
		"pageSize":    1,
	})
	if result.IsError {
		t.Fatalf("get_script_output returned error: %#v", result.Content)
	}
	payload := marshalStructuredContent(t, result.StructuredContent)
	if !strings.Contains(payload, `"page":2`) || !strings.Contains(payload, `"id":2`) {
		t.Fatalf("output payload = %s", payload)
	}
	text := firstTextContent(result)
	if !strings.Contains(text, "第 2 页") || !strings.Contains(text, "| 2 |") {
		t.Fatalf("output text = %q", text)
	}
}

func TestListScriptInputSheetsReturnsWorkbookOrder(t *testing.T) {
	backend := &fakeBackend{
		scriptSheetsResult: connection.QueryResult{
			Success: true,
			Data:    map[string]any{"sheets": []string{"Summary", "IDs"}},
		},
	}
	result := callServerTool(t, NewServer(backend), "list_script_input_sheets", map[string]any{
		"path": "/tmp/ids.xlsx",
	})
	if result.IsError {
		t.Fatalf("list_script_input_sheets returned error: %#v", result.Content)
	}
	text := firstTextContent(result)
	if !strings.Contains(text, "Summary") || !strings.Contains(text, "IDs") {
		t.Fatalf("sheet text = %q", text)
	}
}

func TestSaveScriptReturnsRevision(t *testing.T) {
	backend := &fakeBackend{
		scriptSaveResult: connection.QueryResult{
			Success: true,
			Data: scriptlib.Script{
				ID:         "script-2",
				Name:       "Saved",
				Revision:   4,
				Visibility: scriptlib.VisibilityPrivate,
			},
		},
	}
	result := callServerTool(t, NewServer(backend), "save_script", map[string]any{
		"name": "Saved",
		"code": "gonavi.log('ok');",
	})
	if result.IsError {
		t.Fatalf("save_script returned error: %#v", result.Content)
	}
	text := firstTextContent(result)
	if !strings.Contains(text, "scriptId=script-2") || !strings.Contains(text, "revision=4") {
		t.Fatalf("save text = %q", text)
	}
}

func TestAgentRunScriptEffectFollowsAllowWriteAndSafety(t *testing.T) {
	backend := catalogBackend()
	catalog := NewAgentToolCatalog(backend)
	ctx := context.Background()

	readOnly, err := catalog.ResolveEffect(ctx, "run_script", json.RawMessage(`{"script":"1+1","allowWrite":false}`))
	if err != nil || readOnly != runharness.ToolEffectReadOnly {
		t.Fatalf("read-only run effect = %q, %v", readOnly, err)
	}

	backend.safetyLevel = ai.PermissionReadOnly
	if _, err := catalog.ResolveEffect(ctx, "run_script", json.RawMessage(`{"script":"1+1","allowWrite":true}`)); !errors.Is(err, ErrAgentToolPolicyDenied) {
		t.Fatalf("read-only safety write error = %v, want policy denied", err)
	}

	backend.safetyLevel = ai.PermissionReadWrite
	sideEffect, err := catalog.ResolveEffect(ctx, "run_script", json.RawMessage(`{"script":"1+1","allowWrite":true}`))
	if err != nil || sideEffect != runharness.ToolEffectSideEffect {
		t.Fatalf("read-write run effect = %q, %v", sideEffect, err)
	}
}

func TestRunScriptArgsSchemaIncludesRunLimits(t *testing.T) {
	schema, err := jsonschema.For[runScriptArgs](nil)
	if err != nil {
		t.Fatalf("infer runScriptArgs schema: %v", err)
	}
	for _, name := range []string{
		"scriptId", "script", "connections", "inputs", "allowWrite", "batchSize", "inListLimit",
		"timeoutMs", "maxDbCalls", "maxOutputRows", "memoryLimitBytes", "writeApprovalToken", "waitSeconds",
	} {
		if schema.Properties[name] == nil {
			t.Fatalf("schema missing %q; properties=%v", name, schemaPropertyNames(schema))
		}
	}
}

func schemaPropertyNames(schema *jsonschema.Schema) []string {
	names := make([]string, 0, len(schema.Properties))
	for name := range schema.Properties {
		names = append(names, name)
	}
	return names
}

func marshalStructuredContent(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal structured content: %v", err)
	}
	return string(encoded)
}
