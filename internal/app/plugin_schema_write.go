package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/plugin"
)

const (
	schemaWritePlanTTL      = 5 * time.Minute
	schemaWritePlanMax      = 16
	schemaWriteStatements   = 8
	schemaWriteStatementMax = 32 << 10
	// 确认框必须把语句摆到用户面前：只报数量等于让用户为看不见的 DROP/ALTER 签字。
	schemaWriteConfirmStatementRunes = 200
	schemaWriteConfirmMessageMax     = 1200
)

type schemaWritePlan struct {
	connectionID string
	database     string
	statements   []string
	expiresAt    time.Time
}

type schemaWritePlanStore struct {
	mu    sync.Mutex
	plans map[string]schemaWritePlan
}

func (store *schemaWritePlanStore) put(plan schemaWritePlan) string {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.plans == nil {
		store.plans = make(map[string]schemaWritePlan)
	}
	now := time.Now()
	for id, existing := range store.plans {
		if !existing.expiresAt.After(now) {
			delete(store.plans, id)
		}
	}
	for len(store.plans) >= schemaWritePlanMax {
		var oldestID string
		var oldest time.Time
		for id, existing := range store.plans {
			if oldestID == "" || existing.expiresAt.Before(oldest) {
				oldestID, oldest = id, existing.expiresAt
			}
		}
		delete(store.plans, oldestID)
	}
	id := make([]byte, 24)
	if _, err := rand.Read(id); err != nil {
		return ""
	}
	planID := hex.EncodeToString(id)
	store.plans[planID] = plan
	return planID
}

func (store *schemaWritePlanStore) take(id string) (schemaWritePlan, bool) {
	store.mu.Lock()
	defer store.mu.Unlock()
	plan, ok := store.plans[id]
	if !ok {
		return schemaWritePlan{}, false
	}
	delete(store.plans, id)
	if !plan.expiresAt.After(time.Now()) {
		return schemaWritePlan{}, false
	}
	return plan, true
}

type pluginCapabilitySchemaPreviewArguments struct {
	ConnectionID string   `json:"connectionId"`
	Database     string   `json:"database,omitempty"`
	Statements   []string `json:"statements"`
}

type pluginCapabilitySchemaPreviewResult struct {
	PlanID       string   `json:"planId"`
	Database     string   `json:"database,omitempty"`
	Statements   []string `json:"statements"`
	ExpiresAt    string   `json:"expiresAt"`
	RequiresHost bool     `json:"requiresHostConfirmation"`
}

type pluginCapabilitySchemaApplyArguments struct {
	PlanID string `json:"planId"`
}

type pluginCapabilitySchemaStatementResult struct {
	Statement string `json:"statement"`
	Success   bool   `json:"success"`
	Message   string `json:"message,omitempty"`
}

type pluginCapabilitySchemaApplyResult struct {
	Applied int `json:"applied"`
	Failed  int `json:"failed"`
	// Pending 是确认之后被主机拒绝执行的语句数：失权可能发生在部分语句已经落库之后，
	// 调用方必须知道这批 DDL 只跑了一部分，不能当整批失败去重试。
	Pending    int                                     `json:"pending"`
	Stopped    string                                  `json:"stopped,omitempty"`
	Statements []pluginCapabilitySchemaStatementResult `json:"statements"`
}

func schemaWriteConfigAllowed(config connection.ConnectionConfig) bool {
	return !config.ReadOnly &&
		!pluginPageConnectionReadOnly(config) &&
		!config.Protection.RestrictStructureEdit &&
		!config.Protection.RestrictScriptExecution
}

func schemaWriteDdlAllowed(statement string) bool {
	upper := strings.ToUpper(strings.TrimSpace(statement))
	if strings.HasPrefix(upper, "TRUNCATE") {
		return false
	}
	fields := strings.Fields(upper)
	if len(fields) < 2 {
		return false
	}
	switch fields[0] {
	case "CREATE", "ALTER", "DROP":
	default:
		return false
	}
	switch fields[1] {
	case "TABLE", "INDEX", "VIEW":
		return true
	default:
		return false
	}
}

func (a *App) validateSchemaStatements(config connection.ConnectionConfig, statements []string) ([]string, string) {
	if !schemaWriteConfigAllowed(config) {
		return nil, "read_only"
	}
	if len(statements) == 0 || len(statements) > schemaWriteStatements {
		return nil, "invalid_arguments"
	}
	dbType := strings.ToLower(strings.TrimSpace(config.Type))
	if dbType == "" {
		return nil, "invalid_arguments"
	}
	normalized := make([]string, 0, len(statements))
	for _, raw := range statements {
		statement := strings.TrimSpace(raw)
		if statement == "" || len(statement) > schemaWriteStatementMax {
			return nil, "invalid_arguments"
		}
		parts := splitSQLStatementsForDialect(dbType, statement)
		one := ""
		for _, part := range parts {
			if strings.TrimSpace(part) != "" {
				if one != "" {
					return nil, "invalid_arguments"
				}
				one = strings.TrimSpace(part)
			}
		}
		if one == "" || !schemaWriteDdlAllowed(one) {
			return nil, "invalid_arguments"
		}
		inspection := inspectStatement(dbType, one, 0)
		if classifyHeadlessSQLOperation(dbType, one, inspection) != ai.SQLOpDDL {
			return nil, "invalid_arguments"
		}
		normalized = append(normalized, one)
	}
	return normalized, ""
}

func pluginCapabilitySchemaPreview(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilitySchemaPreviewArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	if strings.TrimSpace(arguments.ConnectionID) == "" || len(strings.TrimSpace(arguments.Database)) > 256 {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	statements, code := a.validateSchemaStatements(config, arguments.Statements)
	if code != "" {
		return nil, code
	}
	expiresAt := time.Now().Add(schemaWritePlanTTL)
	planID := a.schemaWritePlans.put(schemaWritePlan{
		connectionID: strings.TrimSpace(arguments.ConnectionID),
		database:     strings.TrimSpace(arguments.Database),
		statements:   statements,
		expiresAt:    expiresAt,
	})
	if planID == "" {
		return nil, "internal"
	}
	return pluginCapabilitySchemaPreviewResult{
		PlanID:       planID,
		Database:     strings.TrimSpace(arguments.Database),
		Statements:   statements,
		ExpiresAt:    expiresAt.UTC().Format(time.RFC3339),
		RequiresHost: true,
	}, ""
}

// schemaWriteExecutionConfig rechecks authority after the dialog and before each
// statement: confirmation must not extend a revoked generation or connection policy.
func (a *App) schemaWriteExecutionConfig(ctx context.Context, request pluginCapabilityRequest, connectionID string) (connection.ConnectionConfig, string) {
	if ctx.Err() != nil {
		return connection.ConnectionConfig{}, "internal"
	}
	if request.Caller.Generation == 0 {
		return connection.ConnectionConfig{}, "not_running"
	}
	status, code := a.pluginCapabilityStatus(ctx, request.Caller.PluginID, request.Caller.Generation)
	if code != "" {
		return connection.ConnectionConfig{}, code
	}
	if !pluginCapabilityPermissionGranted(status.Manifest.Permissions, plugin.SchemaWritePermission) {
		return connection.ConnectionConfig{}, "permission_denied"
	}
	config, code := a.pluginPageConnectionConfig(connectionID)
	if code != "" {
		return connection.ConnectionConfig{}, code
	}
	if !schemaWriteConfigAllowed(config) {
		return connection.ConnectionConfig{}, "read_only"
	}
	if ctx.Err() != nil {
		return connection.ConnectionConfig{}, "internal"
	}
	return config, ""
}

// schemaWriteConfirmationMessage renders the statements the user is about to
// approve. The native dialog is the last human checkpoint before irreversible
// DDL, so the payload lists the SQL itself, bounded by rune-safe truncation.
func schemaWriteConfirmationMessage(plan schemaWritePlan) string {
	header := fmt.Sprintf("%d DDL statement(s) will run on %s", len(plan.statements), plan.database)
	if strings.TrimSpace(plan.database) == "" {
		header = fmt.Sprintf("%d DDL statement(s) will run on the saved connection", len(plan.statements))
	}
	var builder strings.Builder
	builder.WriteString(header)
	for index, statement := range plan.statements {
		line := fmt.Sprintf("\n%d. %s", index+1, schemaWriteConfirmationStatement(statement))
		if builder.Len()+len(line) > schemaWriteConfirmMessageMax {
			builder.WriteString("\n…")
			break
		}
		builder.WriteString(line)
	}
	return builder.String()
}

// schemaWriteConfirmationStatement collapses whitespace to one line and cuts by
// rune so a multi-byte identifier is never split in half.
func schemaWriteConfirmationStatement(statement string) string {
	compact := strings.Join(strings.Fields(statement), " ")
	runes := []rune(compact)
	if len(runes) <= schemaWriteConfirmStatementRunes {
		return compact
	}
	return string(runes[:schemaWriteConfirmStatementRunes]) + "…"
}

func pluginCapabilitySchemaApply(ctx context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilitySchemaApplyArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	plan, ok := a.schemaWritePlans.take(strings.TrimSpace(arguments.PlanID))
	if !ok {
		return nil, "plan_expired"
	}
	config, code := a.pluginPageConnectionConfig(plan.connectionID)
	if code != "" {
		return nil, code
	}
	if !schemaWriteConfigAllowed(config) {
		return nil, "read_only"
	}
	if ctx == nil || a.ctx == nil || a.headlessRuntime || a.webRuntime {
		return nil, "confirmation_unavailable"
	}
	message := schemaWriteConfirmationMessage(plan)
	confirmed := false
	if a.schemaConfirm != nil {
		var err error
		confirmed, err = a.schemaConfirm(ctx, message)
		if err != nil {
			return nil, "confirmation_denied"
		}
	} else {
		answer, err := wailsruntime.MessageDialog(a.ctx, wailsruntime.MessageDialogOptions{
			Type:          wailsruntime.QuestionDialog,
			Title:         "Confirm DDL",
			Message:       message,
			Buttons:       []string{"Cancel", "Apply"},
			DefaultButton: "Cancel",
			CancelButton:  "Cancel",
		})
		if err != nil || answer != "Apply" {
			return nil, "confirmation_denied"
		}
		confirmed = true
	}
	if ctx.Err() != nil {
		return nil, "internal"
	}
	if !confirmed {
		return nil, "confirmation_denied"
	}
	result := pluginCapabilitySchemaApplyResult{}
	budget := normalizeQueryResultBudgetOptions(QueryResultBudgetOptions{})
	for _, statement := range plan.statements {
		if ctx.Err() != nil {
			return nil, "internal"
		}
		config, code := a.schemaWriteExecutionConfig(ctx, request, plan.connectionID)
		if code != "" {
			// 一条都没执行：保持「整批拒绝」的原有契约，调用方拿到明确错误码。
			if result.Applied == 0 && result.Failed == 0 {
				return nil, code
			}
			// 已经有语句落库：把已执行的结果连同中断原因一起回传，
			// 否则调用方以为整批都没跑，重试会把不可逆 DDL 再执行一遍。
			result.Stopped = code
			result.Pending = len(plan.statements) - (result.Applied + result.Failed)
			return result, ""
		}
		queryResult := a.dbQueryMulti(config, plan.database, statement, "", dbQueryMultiAuditOptions{
			auditAll:         true,
			auditWrites:      true,
			source:           "plugin_schema_write",
			ResultBudget:     &budget,
			executionContext: ctx,
		})
		item := pluginCapabilitySchemaStatementResult{Statement: statement, Success: queryResult.Success, Message: queryResult.Message}
		result.Statements = append(result.Statements, item)
		if queryResult.Success {
			result.Applied++
		} else {
			result.Failed++
		}
	}
	return result, ""
}
