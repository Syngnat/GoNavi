package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/ai/runharness"
	appcore "GoNavi-Wails/internal/app"
)

func workspaceCatalogTestSnapshot() runharness.WorkspaceSnapshot {
	return runharness.WorkspaceSnapshot{
		SchemaVersion:    1,
		SourceKind:       runharness.WorkspaceDesktop,
		SourceID:         "desktop-main",
		SourceInstanceID: "instance-42",
		Revision:         42,
		ContentHash:      "snapshot-hash-42",
		CapturedAt:       time.Date(2026, time.September, 2, 10, 30, 0, 0, time.UTC),
		Tabs: []runharness.WorkspaceTab{
			{
				ID:           "tab-background",
				Title:        "Background query",
				Kind:         "query",
				ConnectionID: "conn-background",
				Database:     "analytics",
				Object:       "events",
				Draft:        "SELECT * FROM events",
			},
			{
				ID:           "tab-active",
				Title:        "Active orders",
				Kind:         "query",
				ConnectionID: "conn-active",
				Database:     "app",
				Object:       "orders",
				Draft:        "SELECT * FROM orders WHERE status = 'open'",
			},
			{
				ID:    "tab-long",
				Title: "Long draft",
				Kind:  "query",
				Draft: strings.Repeat("x", maxWorkspaceTabContentRunes+1),
			},
		},
		ActiveTabID: "tab-active",
		SQLActivity: []runharness.WorkspaceSQLActivity{
			{ID: "log-read", Statement: "-- comment\nSELECT * FROM orders", Status: "success", CreatedAt: time.Date(2026, time.September, 2, 10, 0, 0, 0, time.UTC)},
			{ID: "log-write", Statement: "INSERT INTO orders(id) VALUES (1)", Status: "error", CreatedAt: time.Date(2026, time.September, 2, 10, 1, 0, 0, time.UTC)},
			{ID: "log-ddl", Statement: "CREATE TABLE scratch(id int)", Status: "success", CreatedAt: time.Date(2026, time.September, 2, 10, 2, 0, 0, time.UTC)},
		},
		SavedQueries: []runharness.WorkspaceQuery{
			{ID: "query-orders", Name: "Open orders", Content: "SELECT * FROM orders WHERE status = 'open'"},
			{ID: "query-users", Name: "Users", Content: "SELECT * FROM users"},
		},
		Snippets: []runharness.WorkspaceQuery{
			{ID: "snippet-select", Name: "Select by id", Content: "SELECT * FROM records WHERE id = :id"},
			{ID: "snippet-write", Name: "Update status", Content: "UPDATE orders SET status = :status"},
		},
		Shortcuts: map[string]string{
			"runQuery.mac.combo":       "Cmd+Enter",
			"runQuery.mac.enabled":     "true",
			"runQuery.windows.combo":   "Ctrl+Enter",
			"runQuery.windows.enabled": "false",
			"togglePanel.mac.combo":    "Cmd+Shift+P",
			"togglePanel.mac.enabled":  "true",
			"not-a-shortcut-setting":   "ignored",
		},
		TransactionState: map[string]any{
			"pending": map[string]any{
				"transaction-1": map[string]any{"tabId": "tab-active"},
			},
			"editor": map[string]any{"commitMode": "manual"},
		},
		Capabilities: map[string]bool{
			"desktopTabs":  true,
			"sqlActivity":  true,
			"transactions": true,
			"savedQueries": true,
			"snippets":     true,
			"shortcuts":    true,
		},
		Availability: map[string]string{
			"desktopTabs":  "available",
			"sqlActivity":  "available",
			"transactions": "available",
			"savedQueries": "available",
			"snippets":     "available",
			"shortcuts":    "available",
		},
	}
}

func workspaceCatalogExecute(t *testing.T, catalog *WorkspaceSnapshotToolCatalog, name, arguments string, snapshot runharness.WorkspaceSnapshot) (runharness.ToolExecutionResult, error) {
	t.Helper()
	_, executor, err := catalog.Resolve(context.Background(), name)
	if err != nil {
		t.Fatalf("Resolve(%q): %v", name, err)
	}
	return executor.Execute(context.Background(), runharness.ToolExecutionRequest{
		ToolName:  name,
		Effect:    runharness.ToolEffectReadOnly,
		Arguments: json.RawMessage(arguments),
		Context:   snapshot,
	})
}

func workspaceCatalogValue(t *testing.T, result runharness.ToolExecutionResult, err error) map[string]any {
	t.Helper()
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if result.Status != "completed" || result.ErrorCode != "" {
		t.Fatalf("unexpected tool result: %#v", result)
	}
	value, ok := result.Value.(map[string]any)
	if !ok {
		t.Fatalf("result value = %#v (%T), want map", result.Value, result.Value)
	}
	return value
}

func workspaceCatalogExecuteValue(t *testing.T, catalog *WorkspaceSnapshotToolCatalog, name, arguments string, snapshot runharness.WorkspaceSnapshot) map[string]any {
	t.Helper()
	result, err := workspaceCatalogExecute(t, catalog, name, arguments, snapshot)
	return workspaceCatalogValue(t, result, err)
}

func workspaceCatalogResultSlice(t *testing.T, value any, field string) []map[string]any {
	t.Helper()
	items, ok := value.([]map[string]any)
	if !ok {
		t.Fatalf("%s = %#v (%T), want []map[string]any", field, value, value)
	}
	return items
}

func assertWorkspaceCatalogSnapshotReference(t *testing.T, value map[string]any, snapshot runharness.WorkspaceSnapshot) {
	t.Helper()
	reference, ok := value["snapshot"].(map[string]any)
	if !ok {
		t.Fatalf("snapshot reference = %#v (%T)", value["snapshot"], value["snapshot"])
	}
	if reference["sourceKind"] != snapshot.SourceKind || reference["sourceId"] != snapshot.SourceID || reference["sourceInstanceId"] != snapshot.SourceInstanceID || reference["revision"] != snapshot.Revision || reference["contentHash"] != snapshot.ContentHash {
		t.Fatalf("snapshot reference = %#v, want source/revision/hash from %#v", reference, snapshot)
	}
	if reference["capturedAt"] != snapshot.CapturedAt.UTC().Format(time.RFC3339Nano) {
		t.Fatalf("snapshot capturedAt = %#v", reference["capturedAt"])
	}
}

func TestWorkspaceSnapshotToolCatalogListsReadOnlyWorkspaceDescriptors(t *testing.T) {
	catalog := NewWorkspaceSnapshotToolCatalog()
	items, err := catalog.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	wantNames := []string{
		workspaceActiveTabToolName,
		workspaceTabsToolName,
		workspaceRecentSQLLogsToolName,
		workspaceRecentSQLActivityToolName,
		workspaceTransactionToolName,
		workspaceSavedQueriesToolName,
		workspaceSnippetsToolName,
		workspaceShortcutsToolName,
	}
	if len(items) != len(wantNames) {
		t.Fatalf("descriptor count = %d, want %d", len(items), len(wantNames))
	}
	for index, name := range wantNames {
		descriptor := items[index]
		if descriptor.Name != name || descriptor.Effect != runharness.ToolEffectReadOnly {
			t.Fatalf("descriptor[%d] = %#v", index, descriptor)
		}
		if !containsString(descriptor.Capabilities, "workspace") || len(descriptor.Capabilities) != 2 {
			t.Fatalf("descriptor %q capabilities = %#v", name, descriptor.Capabilities)
		}
		if descriptor.MaxResultBytes != 1<<20 || !json.Valid(descriptor.InputSchema) {
			t.Fatalf("descriptor %q schema/result limit = %s / %d", name, descriptor.InputSchema, descriptor.MaxResultBytes)
		}
		var schema map[string]any
		if err := json.Unmarshal(descriptor.InputSchema, &schema); err != nil || schema["type"] != "object" || schema["additionalProperties"] != false {
			t.Fatalf("descriptor %q schema = %s, err=%v", name, descriptor.InputSchema, err)
		}
	}

	items[0].InputSchema[0] = 'X'
	items[0].Capabilities[0] = "changed"
	fresh, err := catalog.List(context.Background())
	if err != nil || fresh[0].InputSchema[0] == 'X' || fresh[0].Capabilities[0] == "changed" {
		t.Fatalf("List exposed mutable descriptor state: fresh=%#v err=%v", fresh[0], err)
	}
}

func TestWorkspaceSnapshotToolCatalogProjectsOnlyRequestSnapshot(t *testing.T) {
	catalog := NewWorkspaceSnapshotToolCatalog()
	snapshot := workspaceCatalogTestSnapshot()

	active := workspaceCatalogExecuteValue(t, catalog, workspaceActiveTabToolName, `{"includeContent":false}`, snapshot)
	if active["hasActiveTab"] != true {
		t.Fatalf("active result = %#v", active)
	}
	activeTab, ok := active["activeTab"].(map[string]any)
	if !ok || activeTab["id"] != "tab-active" || activeTab["database"] != "app" {
		t.Fatalf("active tab = %#v", active["activeTab"])
	}
	if _, exists := activeTab["content"]; exists {
		t.Fatalf("active tab content leaked despite includeContent=false: %#v", activeTab)
	}
	assertWorkspaceCatalogSnapshotReference(t, active, snapshot)

	tabs := workspaceCatalogExecuteValue(t, catalog, workspaceTabsToolName, `{"includeContent":true,"limit":2}`, snapshot)
	projectedTabs := workspaceCatalogResultSlice(t, tabs["tabs"], "tabs")
	if tabs["totalTabs"] != 3 || tabs["returnedTabs"] != 2 || tabs["truncated"] != true || projectedTabs[0]["id"] != "tab-active" {
		t.Fatalf("tabs result = %#v", tabs)
	}
	if projectedTabs[0]["content"] != snapshot.Tabs[1].Draft {
		t.Fatalf("active tab content = %#v", projectedTabs[0])
	}
	assertWorkspaceCatalogSnapshotReference(t, tabs, snapshot)

	longTabs := workspaceCatalogExecuteValue(t, catalog, workspaceTabsToolName, `{"includeContent":true,"limit":30}`, snapshot)
	longProjectedTabs := workspaceCatalogResultSlice(t, longTabs["tabs"], "tabs")
	var longTab map[string]any
	for _, item := range longProjectedTabs {
		if item["id"] == "tab-long" {
			longTab = item
			break
		}
	}
	if longTab == nil || longTab["contentTruncated"] != true || len(longTab["content"].(string)) != maxWorkspaceTabContentRunes {
		t.Fatalf("long tab projection = %#v", longTab)
	}
}

func TestWorkspaceSnapshotToolCatalogInspectsSQLTransactionQueriesAndShortcuts(t *testing.T) {
	catalog := NewWorkspaceSnapshotToolCatalog()
	snapshot := workspaceCatalogTestSnapshot()

	logs := workspaceCatalogExecuteValue(t, catalog, workspaceRecentSQLLogsToolName, `{"status":"ERROR","limit":1}`, snapshot)
	projectedLogs := workspaceCatalogResultSlice(t, logs["logs"], "logs")
	if logs["status"] != "error" || logs["totalMatched"] != 1 || logs["errorCount"] != 1 || len(projectedLogs) != 1 || projectedLogs[0]["id"] != "log-write" {
		t.Fatalf("logs result = %#v", logs)
	}
	assertWorkspaceCatalogSnapshotReference(t, logs, snapshot)

	activity := workspaceCatalogExecuteValue(t, catalog, workspaceRecentSQLActivityToolName, `{"status":"success","keyword":"orders","activityKind":"read","limit":1}`, snapshot)
	entries := workspaceCatalogResultSlice(t, activity["entries"], "entries")
	if activity["status"] != "success" || activity["keyword"] != "orders" || activity["activityKind"] != "read" || activity["totalMatched"] != 1 || len(entries) != 1 || entries[0]["statementType"] != "select" || entries[0]["activityKind"] != "read" {
		t.Fatalf("activity result = %#v", activity)
	}
	assertWorkspaceCatalogSnapshotReference(t, activity, snapshot)

	transaction := workspaceCatalogExecuteValue(t, catalog, workspaceTransactionToolName, `{"includeSqlPreview":false}`, snapshot)
	if transaction["pendingTransactionCount"] != 1 {
		t.Fatalf("transaction result = %#v", transaction)
	}
	transactionState, ok := transaction["transactionState"].(map[string]any)
	if !ok || transactionState["editor"] == nil {
		t.Fatalf("transaction state = %#v", transaction["transactionState"])
	}
	transactionTab, ok := transaction["activeTab"].(map[string]any)
	if !ok {
		t.Fatalf("transaction active tab = %#v", transaction["activeTab"])
	}
	if _, exists := transactionTab["content"]; exists {
		t.Fatalf("transaction tool included SQL despite includeSqlPreview=false: %#v", transactionTab)
	}
	assertWorkspaceCatalogSnapshotReference(t, transaction, snapshot)

	queries := workspaceCatalogExecuteValue(t, catalog, workspaceSavedQueriesToolName, `{"keyword":"orders","includeSql":false,"limit":1}`, snapshot)
	projectedQueries := workspaceCatalogResultSlice(t, queries["queries"], "queries")
	if queries["totalMatched"] != 1 || len(projectedQueries) != 1 || projectedQueries[0]["id"] != "query-orders" {
		t.Fatalf("saved queries result = %#v", queries)
	}
	if _, exists := projectedQueries[0]["content"]; exists {
		t.Fatalf("saved query content leaked despite includeSql=false: %#v", projectedQueries[0])
	}
	assertWorkspaceCatalogSnapshotReference(t, queries, snapshot)

	snippets := workspaceCatalogExecuteValue(t, catalog, workspaceSnippetsToolName, `{"keyword":"update","includeBody":true,"limit":1}`, snapshot)
	projectedSnippets := workspaceCatalogResultSlice(t, snippets["snippets"], "snippets")
	if snippets["totalMatched"] != 1 || len(projectedSnippets) != 1 || projectedSnippets[0]["id"] != "snippet-write" || projectedSnippets[0]["content"] != snapshot.Snippets[1].Content {
		t.Fatalf("snippet result = %#v", snippets)
	}
	assertWorkspaceCatalogSnapshotReference(t, snippets, snapshot)

	shortcuts := workspaceCatalogExecuteValue(t, catalog, workspaceShortcutsToolName, `{"action":"runQuery","includeDisabled":false}`, snapshot)
	projectedShortcuts := workspaceCatalogResultSlice(t, shortcuts["shortcuts"], "shortcuts")
	if shortcuts["matchedActionCount"] != 1 || len(projectedShortcuts) != 1 || projectedShortcuts[0]["action"] != "runQuery" {
		t.Fatalf("shortcut result = %#v", shortcuts)
	}
	platforms, ok := projectedShortcuts[0]["platforms"].(map[string]any)
	if !ok || platforms["mac"] == nil {
		t.Fatalf("shortcut platforms = %#v", projectedShortcuts[0]["platforms"])
	}
	if _, exists := platforms["windows"]; exists {
		t.Fatalf("disabled shortcut was included: %#v", platforms)
	}
	assertWorkspaceCatalogSnapshotReference(t, shortcuts, snapshot)
}

func TestWorkspaceSnapshotToolCatalogReportsUnavailableCapabilities(t *testing.T) {
	tests := []struct {
		name       string
		toolName   string
		arguments  string
		capability string
		configure  func(*runharness.WorkspaceSnapshot)
	}{
		{
			name: "desktop tabs capability false", toolName: workspaceActiveTabToolName, arguments: `{}`,
			capability: "desktopTabs", configure: func(snapshot *runharness.WorkspaceSnapshot) { snapshot.Capabilities["desktopTabs"] = false },
		},
		{
			name: "sql activity availability unsupported", toolName: workspaceRecentSQLLogsToolName, arguments: `{}`,
			capability: "sqlActivity", configure: func(snapshot *runharness.WorkspaceSnapshot) { snapshot.Availability["sqlActivity"] = "unsupported" },
		},
		{
			name: "transactions disabled", toolName: workspaceTransactionToolName, arguments: `{}`,
			capability: "transactions", configure: func(snapshot *runharness.WorkspaceSnapshot) { snapshot.Availability["transactions"] = "disabled" },
		},
		{
			name: "saved queries unavailable", toolName: workspaceSavedQueriesToolName, arguments: `{}`,
			capability: "savedQueries", configure: func(snapshot *runharness.WorkspaceSnapshot) { snapshot.Capabilities["savedQueries"] = false },
		},
		{
			name: "snippets not available", toolName: workspaceSnippetsToolName, arguments: `{}`,
			capability: "snippets", configure: func(snapshot *runharness.WorkspaceSnapshot) { snapshot.Availability["snippets"] = "not_available" },
		},
		{
			name: "shortcuts unavailable", toolName: workspaceShortcutsToolName, arguments: `{}`,
			capability: "shortcuts", configure: func(snapshot *runharness.WorkspaceSnapshot) { snapshot.Capabilities["shortcuts"] = false },
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			catalog := NewWorkspaceSnapshotToolCatalog()
			snapshot := workspaceCatalogTestSnapshot()
			test.configure(&snapshot)
			value := workspaceCatalogExecuteValue(t, catalog, test.toolName, test.arguments, snapshot)
			if value["errorCode"] != "capability_unavailable" || value["capability"] != test.capability {
				t.Fatalf("unavailable result = %#v", value)
			}
			assertWorkspaceCatalogSnapshotReference(t, value, snapshot)
		})
	}
}

func TestWorkspaceSnapshotToolCatalogRejectsMalformedCallsAndCanceledContexts(t *testing.T) {
	catalog := NewWorkspaceSnapshotToolCatalog()
	_, executor, err := catalog.Resolve(context.Background(), workspaceActiveTabToolName)
	if err != nil {
		t.Fatal(err)
	}
	for _, arguments := range []json.RawMessage{
		json.RawMessage(`{"includeContent":`),
		json.RawMessage(`[]`),
		json.RawMessage(`{"unknown":true}`),
	} {
		result, err := executor.Execute(context.Background(), runharness.ToolExecutionRequest{
			ToolName:  workspaceActiveTabToolName,
			Arguments: arguments,
			Context:   workspaceCatalogTestSnapshot(),
		})
		if err == nil || !errors.Is(err, ErrAgentToolArguments) || result.Status != "failed" || result.ErrorCode != "malformed_tool_call" {
			t.Fatalf("arguments %s result = %#v, err=%v", arguments, result, err)
		}
	}

	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	result, err := executor.Execute(canceled, runharness.ToolExecutionRequest{ToolName: workspaceActiveTabToolName, Arguments: json.RawMessage(`{}`)})
	if !errors.Is(err, context.Canceled) || result.Status != "failed" || result.ErrorCode != "canceled" {
		t.Fatalf("canceled Execute = %#v, %v", result, err)
	}
}

func TestCompositeToolCatalogPreservesDatabaseEffectResolutionAndRejectsDuplicates(t *testing.T) {
	backend := catalogBackend()
	backend.inspection = appcore.SQLInspection{
		StatementCount: 1,
		ReadOnly:       false,
		Statements:     []appcore.SQLStatementInspection{{Index: 1, Keyword: "insert", ReadOnly: false}},
	}
	catalog := NewCompositeToolCatalog(NewAgentToolCatalog(backend), NewWorkspaceSnapshotToolCatalog())
	effect, err := catalog.ResolveEffect(context.Background(), agentSQLToolName, json.RawMessage(`{"connectionId":"conn-1","sql":"INSERT INTO orders(id) VALUES (1)"}`))
	if err != nil || effect != runharness.ToolEffectSideEffect {
		t.Fatalf("composite execute_sql effect = %q, err=%v", effect, err)
	}

	workspaceDescriptor, _, err := catalog.Resolve(context.Background(), workspaceActiveTabToolName)
	if err != nil || workspaceDescriptor.Effect != runharness.ToolEffectReadOnly {
		t.Fatalf("composite workspace resolution = %#v, err=%v", workspaceDescriptor, err)
	}

	duplicates := NewCompositeToolCatalog(NewWorkspaceSnapshotToolCatalog(), NewWorkspaceSnapshotToolCatalog())
	if _, err := duplicates.List(context.Background()); !errors.Is(err, ErrAgentToolArguments) {
		t.Fatalf("duplicate catalog List error = %v, want ErrAgentToolArguments", err)
	}
}
