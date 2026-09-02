package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"GoNavi-Wails/internal/ai/runharness"
)

const (
	workspaceActiveTabToolName         = "inspect_active_tab"
	workspaceTabsToolName              = "inspect_workspace_tabs"
	workspaceRecentSQLLogsToolName     = "inspect_recent_sql_logs"
	workspaceRecentSQLActivityToolName = "inspect_recent_sql_activity"
	workspaceTransactionToolName       = "inspect_sql_editor_transaction"
	workspaceSavedQueriesToolName      = "inspect_saved_queries"
	workspaceSnippetsToolName          = "inspect_sql_snippets"
	workspaceShortcutsToolName         = "inspect_shortcuts"

	defaultWorkspaceSQLLogLimit      = 20
	defaultWorkspaceSQLActivityLimit = 30
	defaultWorkspaceSavedQueryLimit  = 12
	defaultWorkspaceSnippetLimit     = 20
	defaultWorkspaceTabsLimit        = 12
	maxWorkspaceInspectionLimit      = 100
	maxWorkspaceTabLimit             = 30
	maxActiveTabContentRunes         = 12000
	maxWorkspaceTabContentRunes      = 4000
	maxSavedQueryContentRunes        = 4000
	maxSnippetContentRunes           = 2000
)

// WorkspaceSnapshotToolCatalog exposes only data already captured in the
// workspace snapshot bound by the Harness. It deliberately does not read
// frontend stores, local files, diagnostics, or process state: those require
// separate capabilities and security policy rather than an implicit escape
// from the encrypted snapshot boundary.
type WorkspaceSnapshotToolCatalog struct {
	descriptors []runharness.ToolDescriptor
}

// NewWorkspaceSnapshotToolCatalog creates the read-only catalog for desktop
// and CLI-native workspace context. The Harness supplies the newest live
// snapshot to every execution, so this catalog has no direct Ledger dependency.
func NewWorkspaceSnapshotToolCatalog() *WorkspaceSnapshotToolCatalog {
	return &WorkspaceSnapshotToolCatalog{descriptors: workspaceSnapshotToolDescriptors()}
}

var _ runharness.ToolCatalog = (*WorkspaceSnapshotToolCatalog)(nil)
var _ runharness.ToolEffectResolver = (*WorkspaceSnapshotToolCatalog)(nil)

func (c *WorkspaceSnapshotToolCatalog) List(ctx context.Context) ([]runharness.ToolDescriptor, error) {
	if c == nil {
		return nil, ErrAgentToolNotFound
	}
	if ctx == nil {
		return nil, runharness.ErrRootContextRequired
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return cloneAgentToolDescriptors(c.descriptors), nil
}

func (c *WorkspaceSnapshotToolCatalog) Resolve(ctx context.Context, name string) (runharness.ToolDescriptor, runharness.ToolExecutor, error) {
	if c == nil {
		return runharness.ToolDescriptor{}, nil, ErrAgentToolNotFound
	}
	if ctx == nil {
		return runharness.ToolDescriptor{}, nil, runharness.ErrRootContextRequired
	}
	if err := ctx.Err(); err != nil {
		return runharness.ToolDescriptor{}, nil, err
	}
	name = strings.TrimSpace(name)
	for _, descriptor := range c.descriptors {
		if descriptor.Name == name {
			return cloneAgentToolDescriptors([]runharness.ToolDescriptor{descriptor})[0], &workspaceSnapshotToolExecutor{name: name, descriptor: descriptor}, nil
		}
	}
	return runharness.ToolDescriptor{}, nil, fmt.Errorf("%w: %s", ErrAgentToolNotFound, name)
}

// ResolveEffect keeps the composite catalog contract uniform. All tools here
// are strictly read-only, independent of their arguments.
func (c *WorkspaceSnapshotToolCatalog) ResolveEffect(ctx context.Context, name string, _ json.RawMessage) (runharness.ToolEffect, error) {
	descriptor, _, err := c.Resolve(ctx, name)
	if err != nil {
		return "", err
	}
	return descriptor.Effect, nil
}

func workspaceSnapshotToolDescriptors() []runharness.ToolDescriptor {
	readOnly := func(name, description, capability string, schema json.RawMessage) runharness.ToolDescriptor {
		return runharness.ToolDescriptor{
			Name:           name,
			Description:    description,
			InputSchema:    schema,
			Effect:         runharness.ToolEffectReadOnly,
			Capabilities:   []string{"workspace", capability},
			MaxResultBytes: 1 << 20,
		}
	}
	return []runharness.ToolDescriptor{
		readOnly(workspaceActiveTabToolName, "Inspect the currently active workspace tab from the bound workspace snapshot.", "current_tab", schemaObject(nil, map[string]any{
			"includeContent": map[string]any{"type": "boolean", "description": "include the active tab draft or editor content"},
		})),
		readOnly(workspaceTabsToolName, "List open workspace tabs from the bound workspace snapshot.", "editor", schemaObject(nil, map[string]any{
			"includeContent": map[string]any{"type": "boolean", "description": "include each tab draft or editor content"},
			"limit":          map[string]any{"type": "integer", "minimum": 1, "maximum": maxWorkspaceTabLimit},
		})),
		readOnly(workspaceRecentSQLLogsToolName, "List recent SQL log entries captured in the bound workspace snapshot.", "sql_activity", schemaObject(nil, map[string]any{
			"limit":  map[string]any{"type": "integer", "minimum": 1, "maximum": maxWorkspaceInspectionLimit},
			"status": schemaString("optional SQL log status filter"),
		})),
		readOnly(workspaceRecentSQLActivityToolName, "Summarize recent SQL activity captured in the bound workspace snapshot.", "sql_activity", schemaObject(nil, map[string]any{
			"limit":        map[string]any{"type": "integer", "minimum": 1, "maximum": maxWorkspaceInspectionLimit},
			"status":       schemaString("optional SQL log status filter"),
			"keyword":      schemaString("optional statement or status search"),
			"activityKind": schemaString("optional activity kind filter: read, write, ddl, transaction, session, or other"),
		})),
		readOnly(workspaceTransactionToolName, "Inspect SQL editor transaction state from the bound workspace snapshot.", "editor", schemaObject(nil, map[string]any{
			"includeSqlPreview": map[string]any{"type": "boolean", "description": "include the active SQL editor draft"},
		})),
		readOnly(workspaceSavedQueriesToolName, "List saved SQL queries captured in the bound workspace snapshot.", "saved_queries", schemaObject(nil, map[string]any{
			"keyword":    schemaString("optional query name or SQL search"),
			"limit":      map[string]any{"type": "integer", "minimum": 1, "maximum": 50},
			"includeSql": map[string]any{"type": "boolean", "description": "include saved SQL content"},
		})),
		readOnly(workspaceSnippetsToolName, "List SQL snippets captured in the bound workspace snapshot.", "snippets", schemaObject(nil, map[string]any{
			"keyword":     schemaString("optional snippet name or content search"),
			"limit":       map[string]any{"type": "integer", "minimum": 1, "maximum": 80},
			"includeBody": map[string]any{"type": "boolean", "description": "include snippet body content"},
		})),
		readOnly(workspaceShortcutsToolName, "Inspect shortcut bindings captured in the bound workspace snapshot.", "shortcuts", schemaObject(nil, map[string]any{
			"action":          schemaString("optional exact shortcut action filter"),
			"keyword":         schemaString("optional action or key binding search"),
			"includeDisabled": map[string]any{"type": "boolean", "description": "include disabled bindings"},
		})),
	}
}

type workspaceSnapshotToolExecutor struct {
	name       string
	descriptor runharness.ToolDescriptor
}

var _ runharness.ToolExecutor = (*workspaceSnapshotToolExecutor)(nil)

func (e *workspaceSnapshotToolExecutor) Execute(ctx context.Context, request runharness.ToolExecutionRequest) (runharness.ToolExecutionResult, error) {
	if e == nil {
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

	value, err := executeWorkspaceSnapshotTool(e.name, request.Context, request.Arguments)
	if err != nil {
		return failedAgentToolResult("malformed_tool_call"), err
	}
	return runharness.ToolExecutionResult{Status: "completed", Value: value}, nil
}

func executeWorkspaceSnapshotTool(name string, snapshot runharness.WorkspaceSnapshot, raw json.RawMessage) (map[string]any, error) {
	switch name {
	case workspaceActiveTabToolName:
		var args workspaceActiveTabArgs
		if err := decodeAgentToolArguments(raw, &args); err != nil {
			return nil, err
		}
		if result, unavailable := workspaceUnavailableResult(snapshot, "desktopTabs"); unavailable {
			return result, nil
		}
		return inspectWorkspaceActiveTab(snapshot, boolOrDefault(args.IncludeContent, true)), nil
	case workspaceTabsToolName:
		var args workspaceTabsArgs
		if err := decodeAgentToolArguments(raw, &args); err != nil {
			return nil, err
		}
		if result, unavailable := workspaceUnavailableResult(snapshot, "desktopTabs"); unavailable {
			return result, nil
		}
		return inspectWorkspaceTabs(snapshot, boolOrDefault(args.IncludeContent, false), normalizeWorkspaceLimit(args.Limit, defaultWorkspaceTabsLimit, maxWorkspaceTabLimit)), nil
	case workspaceRecentSQLLogsToolName:
		var args workspaceRecentSQLArgs
		if err := decodeAgentToolArguments(raw, &args); err != nil {
			return nil, err
		}
		if result, unavailable := workspaceUnavailableResult(snapshot, "sqlActivity"); unavailable {
			return result, nil
		}
		return inspectWorkspaceRecentSQLLogs(snapshot, args.Status, normalizeWorkspaceLimit(args.Limit, defaultWorkspaceSQLLogLimit, maxWorkspaceInspectionLimit)), nil
	case workspaceRecentSQLActivityToolName:
		var args workspaceRecentSQLActivityArgs
		if err := decodeAgentToolArguments(raw, &args); err != nil {
			return nil, err
		}
		if result, unavailable := workspaceUnavailableResult(snapshot, "sqlActivity"); unavailable {
			return result, nil
		}
		return inspectWorkspaceRecentSQLActivity(snapshot, args.Status, args.Keyword, args.ActivityKind, normalizeWorkspaceLimit(args.Limit, defaultWorkspaceSQLActivityLimit, maxWorkspaceInspectionLimit)), nil
	case workspaceTransactionToolName:
		var args workspaceTransactionArgs
		if err := decodeAgentToolArguments(raw, &args); err != nil {
			return nil, err
		}
		if result, unavailable := workspaceUnavailableResult(snapshot, "transactions"); unavailable {
			return result, nil
		}
		return inspectWorkspaceTransaction(snapshot, boolOrDefault(args.IncludeSQLPreview, true)), nil
	case workspaceSavedQueriesToolName:
		var args workspaceSavedQueryArgs
		if err := decodeAgentToolArguments(raw, &args); err != nil {
			return nil, err
		}
		if result, unavailable := workspaceUnavailableResult(snapshot, "savedQueries"); unavailable {
			return result, nil
		}
		return inspectWorkspaceQueries(snapshot, snapshot.SavedQueries, "queries", args.Keyword, boolOrDefault(args.IncludeSQL, true), normalizeWorkspaceLimit(args.Limit, defaultWorkspaceSavedQueryLimit, 50), maxSavedQueryContentRunes), nil
	case workspaceSnippetsToolName:
		var args workspaceSnippetArgs
		if err := decodeAgentToolArguments(raw, &args); err != nil {
			return nil, err
		}
		if result, unavailable := workspaceUnavailableResult(snapshot, "snippets"); unavailable {
			return result, nil
		}
		return inspectWorkspaceQueries(snapshot, snapshot.Snippets, "snippets", args.Keyword, boolOrDefault(args.IncludeBody, true), normalizeWorkspaceLimit(args.Limit, defaultWorkspaceSnippetLimit, 80), maxSnippetContentRunes), nil
	case workspaceShortcutsToolName:
		var args workspaceShortcutArgs
		if err := decodeAgentToolArguments(raw, &args); err != nil {
			return nil, err
		}
		if result, unavailable := workspaceUnavailableResult(snapshot, "shortcuts"); unavailable {
			return result, nil
		}
		return inspectWorkspaceShortcuts(snapshot, args.Action, args.Keyword, boolOrDefault(args.IncludeDisabled, true)), nil
	default:
		return nil, fmt.Errorf("%w: %s", ErrAgentToolNotFound, name)
	}
}

type workspaceActiveTabArgs struct {
	IncludeContent *bool `json:"includeContent,omitempty"`
}

type workspaceTabsArgs struct {
	IncludeContent *bool `json:"includeContent,omitempty"`
	Limit          int   `json:"limit,omitempty"`
}

type workspaceRecentSQLArgs struct {
	Limit  int    `json:"limit,omitempty"`
	Status string `json:"status,omitempty"`
}

type workspaceRecentSQLActivityArgs struct {
	Limit        int    `json:"limit,omitempty"`
	Status       string `json:"status,omitempty"`
	Keyword      string `json:"keyword,omitempty"`
	ActivityKind string `json:"activityKind,omitempty"`
}

type workspaceTransactionArgs struct {
	IncludeSQLPreview *bool `json:"includeSqlPreview,omitempty"`
}

type workspaceSavedQueryArgs struct {
	Keyword    string `json:"keyword,omitempty"`
	Limit      int    `json:"limit,omitempty"`
	IncludeSQL *bool  `json:"includeSql,omitempty"`
}

type workspaceSnippetArgs struct {
	Keyword     string `json:"keyword,omitempty"`
	Limit       int    `json:"limit,omitempty"`
	IncludeBody *bool  `json:"includeBody,omitempty"`
}

type workspaceShortcutArgs struct {
	Action          string `json:"action,omitempty"`
	Keyword         string `json:"keyword,omitempty"`
	IncludeDisabled *bool  `json:"includeDisabled,omitempty"`
}

func boolOrDefault(value *bool, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return *value
}

func normalizeWorkspaceLimit(value, fallback, maximum int) int {
	if value < 1 {
		value = fallback
	}
	if value > maximum {
		return maximum
	}
	return value
}

func workspaceUnavailableResult(snapshot runharness.WorkspaceSnapshot, capability string) (map[string]any, bool) {
	if !workspaceCapabilityUnavailable(snapshot, capability) {
		return nil, false
	}
	return workspaceResult(snapshot, map[string]any{
		"errorCode":  "capability_unavailable",
		"capability": capability,
	}), true
}

func workspaceCapabilityUnavailable(snapshot runharness.WorkspaceSnapshot, capability string) bool {
	if available, present := snapshot.Capabilities[capability]; present && !available {
		return true
	}
	availability, present := snapshot.Availability[capability]
	if !present {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(availability)) {
	case "unavailable", "unsupported", "disabled", "not_available", "not-supported":
		return true
	default:
		return false
	}
}

func workspaceResult(snapshot runharness.WorkspaceSnapshot, value map[string]any) map[string]any {
	value["snapshot"] = workspaceSnapshotReference(snapshot)
	return value
}

func workspaceSnapshotReference(snapshot runharness.WorkspaceSnapshot) map[string]any {
	result := map[string]any{
		"sourceKind":       snapshot.SourceKind,
		"sourceId":         snapshot.SourceID,
		"sourceInstanceId": snapshot.SourceInstanceID,
		"revision":         snapshot.Revision,
		"contentHash":      snapshot.ContentHash,
	}
	if !snapshot.CapturedAt.IsZero() {
		result["capturedAt"] = snapshot.CapturedAt.UTC().Format(time.RFC3339Nano)
	}
	return result
}

func inspectWorkspaceActiveTab(snapshot runharness.WorkspaceSnapshot, includeContent bool) map[string]any {
	for _, tab := range snapshot.Tabs {
		if tab.ID == snapshot.ActiveTabID {
			return workspaceResult(snapshot, map[string]any{
				"hasActiveTab": true,
				"activeTab":    workspaceTabProjection(tab, true, includeContent, maxActiveTabContentRunes),
			})
		}
	}
	return workspaceResult(snapshot, map[string]any{
		"hasActiveTab": false,
		"activeTabId":  snapshot.ActiveTabID,
	})
}

func inspectWorkspaceTabs(snapshot runharness.WorkspaceSnapshot, includeContent bool, limit int) map[string]any {
	ordered := append([]runharness.WorkspaceTab(nil), snapshot.Tabs...)
	sort.SliceStable(ordered, func(left, right int) bool {
		return ordered[left].ID == snapshot.ActiveTabID && ordered[right].ID != snapshot.ActiveTabID
	})
	visible := ordered
	if len(visible) > limit {
		visible = visible[:limit]
	}
	tabs := make([]map[string]any, 0, len(visible))
	for _, tab := range visible {
		tabs = append(tabs, workspaceTabProjection(tab, tab.ID == snapshot.ActiveTabID, includeContent, maxWorkspaceTabContentRunes))
	}
	return workspaceResult(snapshot, map[string]any{
		"activeTabId":  snapshot.ActiveTabID,
		"limit":        limit,
		"totalTabs":    len(ordered),
		"returnedTabs": len(tabs),
		"truncated":    len(ordered) > len(tabs),
		"tabs":         tabs,
	})
}

func workspaceTabProjection(tab runharness.WorkspaceTab, active, includeContent bool, contentLimit int) map[string]any {
	draft := strings.TrimSpace(tab.Draft)
	result := map[string]any{
		"id":           tab.ID,
		"isActive":     active,
		"title":        tab.Title,
		"kind":         tab.Kind,
		"connectionId": tab.ConnectionID,
		"database":     tab.Database,
		"object":       tab.Object,
		"contentChars": utf8.RuneCountInString(draft),
	}
	if includeContent {
		content, truncated := truncateWorkspaceText(draft, contentLimit)
		result["content"] = content
		result["contentTruncated"] = truncated
	}
	return result
}

func inspectWorkspaceRecentSQLLogs(snapshot runharness.WorkspaceSnapshot, status string, limit int) map[string]any {
	filter := normalizeWorkspaceFilter(status)
	logs := make([]map[string]any, 0, len(snapshot.SQLActivity))
	matched := 0
	successCount := 0
	errorCount := 0
	for _, item := range snapshot.SQLActivity {
		itemStatus := normalizeWorkspaceFilter(item.Status)
		if filter != "" && filter != "all" && itemStatus != filter {
			continue
		}
		matched++
		if itemStatus == "success" {
			successCount++
		}
		if itemStatus == "error" || itemStatus == "failed" {
			errorCount++
		}
		if len(logs) < limit {
			logs = append(logs, workspaceSQLActivityProjection(item, "", ""))
		}
	}
	if filter == "" {
		filter = "all"
	}
	return workspaceResult(snapshot, map[string]any{
		"status":       filter,
		"limit":        limit,
		"totalMatched": matched,
		"successCount": successCount,
		"errorCount":   errorCount,
		"logs":         logs,
	})
}

func inspectWorkspaceRecentSQLActivity(snapshot runharness.WorkspaceSnapshot, status, keyword, activityKind string, limit int) map[string]any {
	statusFilter := normalizeWorkspaceFilter(status)
	keywordFilter := normalizeWorkspaceFilter(keyword)
	kindFilter := normalizeWorkspaceFilter(activityKind)
	entries := make([]map[string]any, 0, len(snapshot.SQLActivity))
	statementCounts := map[string]int{}
	activityCounts := map[string]int{}
	successCount := 0
	errorCount := 0
	for _, item := range snapshot.SQLActivity {
		statementType, resolvedKind := workspaceSQLClassification(item.Statement)
		itemStatus := normalizeWorkspaceFilter(item.Status)
		if statusFilter != "" && statusFilter != "all" && itemStatus != statusFilter {
			continue
		}
		if kindFilter != "" && kindFilter != "all" && resolvedKind != kindFilter {
			continue
		}
		if keywordFilter != "" {
			haystack := strings.ToLower(strings.Join([]string{item.ID, item.Statement, item.Status, statementType, resolvedKind}, "\n"))
			if !strings.Contains(haystack, keywordFilter) {
				continue
			}
		}
		statementCounts[statementType]++
		activityCounts[resolvedKind]++
		if itemStatus == "success" {
			successCount++
		}
		if itemStatus == "error" || itemStatus == "failed" {
			errorCount++
		}
		if len(entries) < limit {
			entries = append(entries, workspaceSQLActivityProjection(item, statementType, resolvedKind))
		}
	}
	if statusFilter == "" {
		statusFilter = "all"
	}
	if kindFilter == "" {
		kindFilter = "all"
	}
	return workspaceResult(snapshot, map[string]any{
		"status":                 statusFilter,
		"keyword":                keywordFilter,
		"activityKind":           kindFilter,
		"limit":                  limit,
		"totalMatched":           sumWorkspaceCountMap(statementCounts),
		"successCount":           successCount,
		"errorCount":             errorCount,
		"statementTypeBreakdown": statementCounts,
		"activityKindBreakdown":  activityCounts,
		"entries":                entries,
	})
}

func workspaceSQLActivityProjection(item runharness.WorkspaceSQLActivity, statementType, activityKind string) map[string]any {
	result := map[string]any{
		"id":        item.ID,
		"statement": item.Statement,
		"status":    item.Status,
	}
	if !item.CreatedAt.IsZero() {
		result["createdAt"] = item.CreatedAt.UTC().Format(time.RFC3339Nano)
	}
	if statementType != "" {
		result["statementType"] = statementType
	}
	if activityKind != "" {
		result["activityKind"] = activityKind
	}
	return result
}

func workspaceSQLClassification(statement string) (string, string) {
	normalized := strings.ToLower(strings.TrimSpace(workspaceSQLWithoutLeadingComments(statement)))
	first := "other"
	if fields := strings.Fields(normalized); len(fields) > 0 {
		first = strings.Trim(fields[0], ";")
	}
	if first == "with" {
		for _, candidate := range []string{"insert", "update", "delete", "replace", "merge", "create", "alter", "drop", "truncate", "rename", "select"} {
			if strings.Contains(normalized, candidate) {
				first = candidate
				break
			}
		}
	}
	switch first {
	case "select", "show", "describe", "desc", "explain":
		return first, "read"
	case "insert", "update", "delete", "replace", "merge":
		return first, "write"
	case "create", "alter", "drop", "truncate", "rename":
		return first, "ddl"
	case "begin", "commit", "rollback":
		return first, "transaction"
	case "use", "set":
		return first, "session"
	default:
		return first, "other"
	}
}

func workspaceSQLWithoutLeadingComments(value string) string {
	remaining := strings.TrimSpace(value)
	for remaining != "" {
		switch {
		case strings.HasPrefix(remaining, "--") || strings.HasPrefix(remaining, "#"):
			if newline := strings.IndexByte(remaining, '\n'); newline >= 0 {
				remaining = strings.TrimSpace(remaining[newline+1:])
				continue
			}
			return ""
		case strings.HasPrefix(remaining, "/*"):
			if end := strings.Index(remaining[2:], "*/"); end >= 0 {
				remaining = strings.TrimSpace(remaining[end+4:])
				continue
			}
			return ""
		default:
			return remaining
		}
	}
	return ""
}

func inspectWorkspaceTransaction(snapshot runharness.WorkspaceSnapshot, includeSQLPreview bool) map[string]any {
	result := map[string]any{
		"transactionState":        cloneWorkspaceMap(snapshot.TransactionState),
		"pendingTransactionCount": workspacePendingTransactionCount(snapshot.TransactionState),
	}
	for _, tab := range snapshot.Tabs {
		if tab.ID == snapshot.ActiveTabID {
			result["activeTab"] = workspaceTabProjection(tab, true, includeSQLPreview, maxActiveTabContentRunes)
			break
		}
	}
	return workspaceResult(snapshot, result)
}

func workspacePendingTransactionCount(state map[string]any) int {
	if state == nil {
		return 0
	}
	for _, key := range []string{"pending", "pendingTransactions"} {
		value, ok := state[key]
		if !ok {
			continue
		}
		switch typed := value.(type) {
		case map[string]any:
			return len(typed)
		case []any:
			return len(typed)
		}
	}
	return 0
}

func inspectWorkspaceQueries(snapshot runharness.WorkspaceSnapshot, values []runharness.WorkspaceQuery, field, keyword string, includeContent bool, limit, contentLimit int) map[string]any {
	keywordFilter := normalizeWorkspaceFilter(keyword)
	matched := make([]runharness.WorkspaceQuery, 0, len(values))
	for _, query := range values {
		if keywordFilter == "" || strings.Contains(strings.ToLower(strings.Join([]string{query.ID, query.Name, query.Content}, "\n")), keywordFilter) {
			matched = append(matched, query)
		}
	}
	visible := matched
	if len(visible) > limit {
		visible = visible[:limit]
	}
	items := make([]map[string]any, 0, len(visible))
	for _, query := range visible {
		content := strings.TrimSpace(query.Content)
		item := map[string]any{
			"id":           query.ID,
			"name":         query.Name,
			"contentChars": utf8.RuneCountInString(content),
		}
		if includeContent {
			preview, truncated := truncateWorkspaceText(content, contentLimit)
			item["content"] = preview
			item["contentTruncated"] = truncated
		}
		items = append(items, item)
	}
	return workspaceResult(snapshot, map[string]any{
		"keyword":        keywordFilter,
		"includeContent": includeContent,
		"limit":          limit,
		"totalMatched":   len(matched),
		"returned":       len(items),
		"truncated":      len(matched) > len(items),
		field:            items,
	})
}

type workspaceShortcutBinding struct {
	combo   string
	enabled bool
}

func inspectWorkspaceShortcuts(snapshot runharness.WorkspaceSnapshot, action, keyword string, includeDisabled bool) map[string]any {
	bindings := map[string]map[string]*workspaceShortcutBinding{}
	for key, value := range snapshot.Shortcuts {
		parts := strings.Split(key, ".")
		if len(parts) != 3 || (parts[1] != "mac" && parts[1] != "windows") {
			continue
		}
		if parts[2] != "combo" && parts[2] != "enabled" {
			continue
		}
		byPlatform := bindings[parts[0]]
		if byPlatform == nil {
			byPlatform = map[string]*workspaceShortcutBinding{}
			bindings[parts[0]] = byPlatform
		}
		binding := byPlatform[parts[1]]
		if binding == nil {
			binding = &workspaceShortcutBinding{enabled: true}
			byPlatform[parts[1]] = binding
		}
		if parts[2] == "combo" {
			binding.combo = value
		} else if parsed, err := strconv.ParseBool(strings.TrimSpace(value)); err == nil {
			binding.enabled = parsed
		}
	}

	actionFilter := normalizeWorkspaceFilter(action)
	keywordFilter := normalizeWorkspaceFilter(keyword)
	actions := make([]string, 0, len(bindings))
	for candidate := range bindings {
		actions = append(actions, candidate)
	}
	sort.Strings(actions)
	items := make([]map[string]any, 0, len(actions))
	for _, candidate := range actions {
		if actionFilter != "" && !strings.EqualFold(candidate, actionFilter) {
			continue
		}
		platforms := map[string]any{}
		for _, platform := range []string{"mac", "windows"} {
			binding := bindings[candidate][platform]
			if binding == nil || (!includeDisabled && !binding.enabled) {
				continue
			}
			if keywordFilter != "" && !strings.Contains(strings.ToLower(candidate+" "+binding.combo), keywordFilter) {
				continue
			}
			platforms[platform] = map[string]any{"combo": binding.combo, "enabled": binding.enabled}
		}
		if len(platforms) == 0 {
			continue
		}
		items = append(items, map[string]any{"action": candidate, "platforms": platforms})
	}
	return workspaceResult(snapshot, map[string]any{
		"filters": map[string]any{
			"action":          actionFilter,
			"keyword":         keywordFilter,
			"includeDisabled": includeDisabled,
		},
		"totalActionCount":   len(actions),
		"matchedActionCount": len(items),
		"shortcuts":          items,
	})
}

func normalizeWorkspaceFilter(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func sumWorkspaceCountMap(values map[string]int) int {
	total := 0
	for _, value := range values {
		total += value
	}
	return total
}

func truncateWorkspaceText(value string, limit int) (string, bool) {
	if limit < 1 || utf8.RuneCountInString(value) <= limit {
		return value, false
	}
	runes := []rune(value)
	return string(runes[:limit]), true
}

func cloneWorkspaceMap(source map[string]any) map[string]any {
	if len(source) == 0 {
		return map[string]any{}
	}
	encoded, err := json.Marshal(source)
	if err != nil {
		return map[string]any{}
	}
	var result map[string]any
	if err := json.Unmarshal(encoded, &result); err != nil || result == nil {
		return map[string]any{}
	}
	return result
}
