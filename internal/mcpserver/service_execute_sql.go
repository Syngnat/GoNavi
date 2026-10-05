package mcpserver

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"GoNavi-Wails/internal/connection"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func (s *Service) ExecuteSQL(ctx context.Context, req *mcp.CallToolRequest, args executeSQLArgs) (*mcp.CallToolResult, executeSQLResult, error) {
	_ = req

	view, errResult := s.resolveConnection(args.ConnectionID)
	if errResult != nil {
		return errResult, executeSQLResult{}, nil
	}

	sqlText := strings.TrimSpace(args.SQL)
	if sqlText == "" {
		return toolError("sql 不能为空"), executeSQLResult{}, nil
	}

	inspection := s.backend.InspectSQL(view.Config.Type, sqlText)
	if inspection.StatementCount == 0 {
		return toolError("未识别到可执行的 SQL 语句"), executeSQLResult{}, nil
	}
	if !isConsistentSQLInspection(inspection) {
		return toolError("SQL 安全检查结果无效，已拒绝执行"), executeSQLResult{}, nil
	}

	safetyLevel := normalizeSQLSafetyLevel(s.backend.GetSQLSafetyLevel())
	mutatingAck, denyMessage := applyExecuteSQLSafety(safetyLevel, inspection)
	if denyMessage != "" {
		return toolError("%s", denyMessage), executeSQLResult{}, nil
	}
	if err := s.backend.AuthorizeSQLConnection(view.Config, sqlText); err != nil {
		return toolError("连接写保护拒绝 SQL 执行: %s", strings.TrimSpace(err.Error())), executeSQLResult{}, nil
	}
	maskingSettings, err := s.backend.GetResultMaskingSettings()
	if err != nil {
		return toolError("加载 SQL 结果脱敏配置失败: %s", strings.TrimSpace(err.Error())), executeSQLResult{}, nil
	}

	// 行预算在执行前下传到 db 层：达到上限后停止读取行并释放连接，
	// 而不是把完整结果物化后再截断。
	maxRowsPerResult := normalizeMaxRowsPerResult(args.MaxRowsPerResult)
	dbName := effectiveDBName(args.DBName, view.Config)
	queryResult, effectiveDialect := s.executeAuthorizedSQL(ctx, view, dbName, sqlText, mutatingAck || args.AllowMutating, maxRowsPerResult)
	if !queryResult.Success {
		failure := executeSQLResult{
			RequestID:         mcpRequestID(ctx),
			ConnectionID:      view.ID,
			DBName:            dbName,
			StatementCount:    inspection.StatementCount,
			ReadOnly:          inspection.ReadOnly,
			QueryID:           strings.TrimSpace(queryResult.QueryID),
			CancellationState: strings.TrimSpace(queryResult.CancellationState),
			Message:           strings.TrimSpace(queryResult.Message),
			OutcomeUnknown:    queryResult.OutcomeUnknown,
			Statements:        toStatementSummaries(inspection.Statements),
		}
		var failureText string
		if queryResult.CancellationState != "" {
			failureText = fmt.Sprintf("SQL 执行失败（cancellationState=%s）: %s", queryResult.CancellationState, strings.TrimSpace(queryResult.Message))
		} else {
			failureText = fmt.Sprintf("SQL 执行失败: %s", strings.TrimSpace(queryResult.Message))
		}
		if queryResult.OutcomeUnknown {
			// 结果未知的错误对 Agent 不是普通失败：底层语句可能已生效，
			// 自动重试非幂等写入会造成重复数据。错误文本必须显式传达
			// 禁止重试契约；结构化输出同时携带 outcomeUnknown 标记。
			failureText += "\n" + unknownSQLOutcomeGuidance
		}
		return toolError("%s", failureText), failure, nil
	}

	resultSets, err := decodeResultSets(queryResult.Data)
	if err != nil {
		return toolError("解析 SQL 执行结果失败: %v", err), executeSQLResult{}, nil
	}
	if strings.TrimSpace(effectiveDialect) == "" {
		effectiveDialect = view.Config.Type
	}
	resultSets = maskResultSets(maskingSettings, effectiveDialect, sqlText, resultSets)

	normalizedResults, truncated := normalizeResultSets(resultSets, maxRowsPerResult)
	message := strings.TrimSpace(queryResult.Message)
	// 逐条执行路径达到行预算后停止读取并不再执行剩余语句；原生多语句批次
	// 的语句已在服务端全部执行（ExecutedCount 等于语句总数），不产生该说明。
	if truncated && queryResult.ExecutedCount > 0 && queryResult.ExecutedCount < inspection.StatementCount {
		budgetNote := fmt.Sprintf(
			"已达到每结果集行数上限 %d，剩余 %d 条语句未执行",
			maxRowsPerResult,
			inspection.StatementCount-queryResult.ExecutedCount,
		)
		if message != "" {
			message += "；" + budgetNote
		} else {
			message = budgetNote
		}
	}
	output := executeSQLResult{
		RequestID:         mcpRequestID(ctx),
		ConnectionID:      view.ID,
		DBName:            dbName,
		StatementCount:    inspection.StatementCount,
		ReadOnly:          inspection.ReadOnly,
		QueryID:           strings.TrimSpace(queryResult.QueryID),
		CancellationState: strings.TrimSpace(queryResult.CancellationState),
		Message:           message,
		OutcomeUnknown:    queryResult.OutcomeUnknown,
		Truncated:         truncated,
		Statements:        toStatementSummaries(inspection.Statements),
		Results:           normalizedResults,
	}
	return textResult(formatExecuteSQLResultContent(output)), output, nil
}

func (s *Service) executeAuthorizedSQL(ctx context.Context, view connection.SavedConnectionView, dbName string, sqlText string, allowMutating bool, maxRowsPerResult int) (connection.QueryResult, string) {
	if backend, ok := s.backend.(executionAuthorizingBackend); ok {
		return backend.ExecuteAuthorizedSQLFromMCP(ctx, view.ID, view.Config, dbName, sqlText, allowMutating, maxRowsPerResult)
	}
	return s.backend.ExecuteSQLFromMCP(ctx, view.Config, dbName, sqlText, maxRowsPerResult), view.Config.Type
}

func successResult() *mcp.CallToolResult {
	return &mcp.CallToolResult{}
}

func textResult(text string) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		Content: []mcp.Content{
			&mcp.TextContent{Text: text},
		},
	}
}

// unknownSQLOutcomeGuidance 把 QueryResult.OutcomeUnknown 的禁止重试契约
// 转达给 MCP 客户端：结果未知意味着语句可能已生效，与可安全重试的
// 确定性失败（如语法错误、约束冲突）不同。
const unknownSQLOutcomeGuidance = "执行结果未知：连接中断、超时、执行被取消或提交响应丢失，无法确认语句是否已在服务端生效。请勿自动重试该语句（尤其是非幂等写入），请先查询核实实际结果后再决定后续操作。"

func toolError(format string, args ...interface{}) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		IsError: true,
		Content: []mcp.Content{
			&mcp.TextContent{Text: fmt.Sprintf(format, args...)},
		},
	}
}

func (s *Service) resolveConnection(connectionID string) (connection.SavedConnectionView, *mcp.CallToolResult) {
	id := strings.TrimSpace(connectionID)
	if id == "" {
		return connection.SavedConnectionView{}, toolError("connectionId 不能为空")
	}
	view, err := s.backend.GetEditableSavedConnection(id)
	if err != nil {
		return connection.SavedConnectionView{}, toolError("加载连接 %s 失败: %v", id, err)
	}
	return view, nil
}

func effectiveDBName(input string, config connection.ConnectionConfig) string {
	if trimmed := strings.TrimSpace(input); trimmed != "" {
		return trimmed
	}
	return strings.TrimSpace(config.Database)
}

func describeConnectionTarget(config connection.ConnectionConfig) string {
	dbType := strings.ToLower(strings.TrimSpace(config.Type))
	switch dbType {
	case "sqlite", "duckdb":
		if path := strings.TrimSpace(config.Database); path != "" {
			return path
		}
	}
	if len(config.Hosts) > 0 {
		return strings.Join(config.Hosts, ",")
	}
	if host := strings.TrimSpace(config.Host); host != "" {
		if config.Port > 0 {
			return fmt.Sprintf("%s:%d", host, config.Port)
		}
		return host
	}
	if uri := strings.TrimSpace(config.URI); uri != "" {
		return redactConnectionTarget(uri)
	}
	if dsn := strings.TrimSpace(config.DSN); dsn != "" {
		return redactConnectionTarget(dsn)
	}
	return strings.TrimSpace(config.Database)
}

func redactConnectionTarget(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}

	if parsed, err := url.Parse(trimmed); err == nil && parsed.Scheme != "" && parsed.Host != "" {
		parsed.User = nil
		parsed.RawQuery = ""
		parsed.Fragment = ""
		return parsed.String()
	}

	if looksLikeOpaqueConnectionString(trimmed) {
		return redactedOpaqueTarget
	}
	return trimmed
}

func looksLikeOpaqueConnectionString(value string) bool {
	lower := strings.ToLower(strings.TrimSpace(value))
	if lower == "" {
		return false
	}
	return strings.Contains(lower, "@") ||
		strings.Contains(lower, "password=") ||
		strings.Contains(lower, "pwd=") ||
		strings.Contains(lower, "user=") ||
		strings.Contains(lower, "uid=") ||
		strings.Contains(lower, "token=") ||
		strings.Contains(lower, "secret=") ||
		strings.Contains(lower, "access_key=") ||
		strings.Contains(lower, "api_key=")
}
