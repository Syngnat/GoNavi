package mcpserver

import (
	"encoding/json"
	"fmt"
	"strings"

	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/scriptlib"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func (a prepareScriptWriteArgs) toRequest() appcore.ScriptWorkbenchRunRequest {
	return appcore.ScriptWorkbenchRunRequest{
		ScriptID:         strings.TrimSpace(a.ScriptID),
		Script:           a.Script,
		Title:            strings.TrimSpace(a.Title),
		Connections:      toScriptWorkbenchConnections(a.Connections),
		Inputs:           toScriptWorkbenchInputs(a.Inputs),
		AllowWrite:       a.AllowWrite,
		BatchSize:        a.BatchSize,
		INListLimit:      a.INListLimit,
		TimeoutMs:        a.TimeoutMs,
		MaxDBCalls:       a.MaxDBCalls,
		MaxOutputRows:    a.MaxOutputRows,
		MemoryLimitBytes: a.MemoryLimitBytes,
	}
}

func (a runScriptArgs) toRequest() appcore.ScriptWorkbenchRunRequest {
	return appcore.ScriptWorkbenchRunRequest{
		ScriptID:           strings.TrimSpace(a.ScriptID),
		Script:             a.Script,
		Title:              strings.TrimSpace(a.Title),
		Connections:        toScriptWorkbenchConnections(a.Connections),
		Inputs:             toScriptWorkbenchInputs(a.Inputs),
		AllowWrite:         a.AllowWrite,
		BatchSize:          a.BatchSize,
		INListLimit:        a.INListLimit,
		TimeoutMs:          a.TimeoutMs,
		MaxDBCalls:         a.MaxDBCalls,
		MaxOutputRows:      a.MaxOutputRows,
		MemoryLimitBytes:   a.MemoryLimitBytes,
		WriteApprovalToken: strings.TrimSpace(a.WriteApprovalToken),
	}
}

func toScriptWorkbenchConnections(items []scriptConnectionBindingArgs) []appcore.ScriptWorkbenchConnection {
	result := make([]appcore.ScriptWorkbenchConnection, 0, len(items))
	for _, item := range items {
		result = append(result, appcore.ScriptWorkbenchConnection{
			Alias:        strings.TrimSpace(item.Alias),
			ConnectionID: strings.TrimSpace(item.ConnectionID),
			Database:     strings.TrimSpace(item.Database),
		})
	}
	return result
}

func toScriptWorkbenchInputs(items []scriptInputBindingArgs) []appcore.ScriptWorkbenchInput {
	result := make([]appcore.ScriptWorkbenchInput, 0, len(items))
	for _, item := range items {
		result = append(result, appcore.ScriptWorkbenchInput{
			Alias:     strings.TrimSpace(item.Alias),
			Path:      strings.TrimSpace(item.Path),
			Reference: strings.TrimSpace(item.Reference),
			Name:      strings.TrimSpace(item.Name),
			SheetName: strings.TrimSpace(item.SheetName),
			Encoding:  strings.TrimSpace(item.Encoding),
			Delimiter: strings.TrimSpace(item.Delimiter),
			HeaderRow: item.HeaderRow,
		})
	}
	return result
}

func toScriptLibraryConnections(items []scriptConnectionBindingArgs) []scriptlib.ConnectionBinding {
	result := make([]scriptlib.ConnectionBinding, 0, len(items))
	for _, item := range items {
		result = append(result, scriptlib.ConnectionBinding{
			Alias:        strings.TrimSpace(item.Alias),
			ConnectionID: strings.TrimSpace(item.ConnectionID),
			Database:     strings.TrimSpace(item.Database),
		})
	}
	return result
}

func toScriptLibraryInputs(items []scriptInputBindingArgs) []scriptlib.InputBinding {
	result := make([]scriptlib.InputBinding, 0, len(items))
	for _, item := range items {
		result = append(result, scriptlib.InputBinding{
			Alias:     strings.TrimSpace(item.Alias),
			Path:      strings.TrimSpace(item.Path),
			Reference: strings.TrimSpace(item.Reference),
			Name:      strings.TrimSpace(item.Name),
			SheetName: strings.TrimSpace(item.SheetName),
			Encoding:  strings.TrimSpace(item.Encoding),
			Delimiter: strings.TrimSpace(item.Delimiter),
			HeaderRow: item.HeaderRow,
		})
	}
	return result
}

func summarizeScript(script scriptlib.Script) scriptSummary {
	connections := make([]scriptSummaryConnection, 0, len(script.Connections))
	for _, item := range script.Connections {
		connections = append(connections, scriptSummaryConnection{
			Alias:        item.Alias,
			ConnectionID: item.ConnectionID,
			Database:     item.Database,
		})
	}
	inputs := make([]scriptSummaryInput, 0, len(script.Inputs))
	for _, item := range script.Inputs {
		inputs = append(inputs, scriptSummaryInput{
			Alias:     item.Alias,
			Name:      item.Name,
			SheetName: item.SheetName,
		})
	}
	return scriptSummary{
		ID:          script.ID,
		Name:        script.Name,
		Description: script.Description,
		Visibility:  script.Visibility,
		FolderID:    script.FolderID,
		AllowWrite:  script.AllowWrite,
		Connections: connections,
		Inputs:      inputs,
		CanEdit:     script.CanEdit,
		CanShare:    script.CanShare,
		Revision:    script.Revision,
		UpdatedAt:   script.UpdatedAt,
	}
}

func scriptSummaryMatches(summary scriptSummary, query string) bool {
	values := []string{
		summary.ID,
		summary.Name,
		summary.Description,
		summary.FolderID,
	}
	for _, item := range summary.Connections {
		values = append(values, item.Alias, item.ConnectionID, item.Database)
	}
	for _, item := range summary.Inputs {
		values = append(values, item.Alias, item.Name, item.SheetName)
	}
	for _, value := range values {
		if strings.Contains(strings.ToLower(value), query) {
			return true
		}
	}
	return false
}

func normalizeScriptLibraryLimit(value int) int {
	if value <= 0 {
		return defaultScriptLibraryLimit
	}
	if value > maxScriptLibraryLimit {
		return maxScriptLibraryLimit
	}
	return value
}

func normalizeScriptRunWaitSeconds(value *int) int {
	if value == nil {
		return defaultScriptRunWaitSecond
	}
	result := *value
	if result < 0 {
		return 0
	}
	if result > maxScriptRunWaitSecond {
		return maxScriptRunWaitSecond
	}
	return result
}

func scriptRunTerminal(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "succeeded", "failed", "cancelled", "timed_out":
		return true
	default:
		return false
	}
}

func scriptToolFailure(prefix string, result connection.QueryResult) *mcp.CallToolResult {
	message := strings.TrimSpace(result.Message)
	if message == "" {
		message = "unknown error"
	}
	if code := strings.TrimSpace(result.Code); code != "" {
		return toolError("%s [%s]: %s", prefix, code, message)
	}
	return toolError("%s: %s", prefix, message)
}

func scriptLibrarySnapshotFromResult(data any) (appcore.ScriptWorkbenchLibrarySnapshot, bool) {
	switch typed := data.(type) {
	case appcore.ScriptWorkbenchLibrarySnapshot:
		return typed, true
	case *appcore.ScriptWorkbenchLibrarySnapshot:
		if typed != nil {
			return *typed, true
		}
	}
	return appcore.ScriptWorkbenchLibrarySnapshot{}, false
}

func scriptRunSnapshotFromResult(data any) (appcore.ScriptWorkbenchRunSnapshot, bool) {
	switch typed := data.(type) {
	case appcore.ScriptWorkbenchRunSnapshot:
		return typed, true
	case *appcore.ScriptWorkbenchRunSnapshot:
		if typed != nil {
			return *typed, true
		}
	}
	return appcore.ScriptWorkbenchRunSnapshot{}, false
}

func scriptOutputPageFromResult(data any) (appcore.ScriptWorkbenchOutputPage, bool) {
	switch typed := data.(type) {
	case appcore.ScriptWorkbenchOutputPage:
		return typed, true
	case *appcore.ScriptWorkbenchOutputPage:
		if typed != nil {
			return *typed, true
		}
	}
	return appcore.ScriptWorkbenchOutputPage{}, false
}

func scriptWriteApprovalFromResult(data any) (appcore.ScriptWorkbenchWriteApproval, bool) {
	switch typed := data.(type) {
	case appcore.ScriptWorkbenchWriteApproval:
		return typed, true
	case *appcore.ScriptWorkbenchWriteApproval:
		if typed != nil {
			return *typed, true
		}
	}
	return appcore.ScriptWorkbenchWriteApproval{}, false
}

func scriptFromResult(data any) (scriptlib.Script, bool) {
	switch typed := data.(type) {
	case scriptlib.Script:
		return typed, true
	case *scriptlib.Script:
		if typed != nil {
			return *typed, true
		}
	}
	return scriptlib.Script{}, false
}

func scriptInputSheetsFromResult(data any) ([]string, error) {
	encoded, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	var payload struct {
		Sheets []string `json:"sheets"`
	}
	if err := json.Unmarshal(encoded, &payload); err != nil {
		return nil, err
	}
	return payload.Sheets, nil
}

func formatScriptInputSheetsContent(sheets []string) string {
	if len(sheets) == 0 {
		return "该输入文件没有工作表；CSV、JSON 等文本输入可直接使用。"
	}
	return "工作表列表：\n- " + strings.Join(sheets, "\n- ")
}

func formatScriptWriteApprovalContent(approval appcore.ScriptWorkbenchWriteApproval) string {
	if !approval.Required {
		return "当前脚本没有未受保护的生产库写目标，不需要写入审批 token。"
	}
	return fmt.Sprintf(
		"该脚本需要在生产库写入，请使用完全相同的 script/scriptId、connections、inputs 和运行限制调用 run_script，并传入：\nwriteApprovalToken=%s\nexpiresAt=%d",
		approval.Token,
		approval.ExpiresAt,
	)
}

func formatScriptRunContent(snapshot appcore.ScriptWorkbenchRunSnapshot) string {
	var builder strings.Builder
	builder.WriteString("脚本运行：")
	builder.WriteString(snapshot.Status)
	if snapshot.Stage != "" && snapshot.Stage != snapshot.Status {
		builder.WriteString("（")
		builder.WriteString(snapshot.Stage)
		builder.WriteString("）")
	}
	builder.WriteString("\nrunId=")
	builder.WriteString(snapshot.RunID)
	if snapshot.ScriptID != "" {
		builder.WriteString("\nscriptId=")
		builder.WriteString(snapshot.ScriptID)
	}
	if snapshot.Title != "" {
		builder.WriteString("\n标题：")
		builder.WriteString(snapshot.Title)
	}
	builder.WriteString(fmt.Sprintf("\n数据库调用：%d/%d，allowWrite=%t", snapshot.DBCalls, snapshot.MaxDBCalls, snapshot.AllowWrite))
	if snapshot.FinishedAt > snapshot.StartedAt && snapshot.StartedAt > 0 {
		builder.WriteString(fmt.Sprintf("，耗时 %dms", snapshot.FinishedAt-snapshot.StartedAt))
	}
	if snapshot.Error != "" {
		builder.WriteString("\n错误")
		if snapshot.ErrorKind != "" {
			builder.WriteString("（")
			builder.WriteString(snapshot.ErrorKind)
			builder.WriteString("）")
		}
		builder.WriteString("：")
		builder.WriteString(snapshot.Error)
	}
	if len(snapshot.Logs) > 0 {
		builder.WriteString("\n最近日志：")
		start := 0
		if len(snapshot.Logs) > 12 {
			start = len(snapshot.Logs) - 12
		}
		for _, item := range snapshot.Logs[start:] {
			builder.WriteString(fmt.Sprintf("\n- [%s] %s", item.Level, item.Message))
		}
	}
	if len(snapshot.Outputs) == 0 {
		if !scriptRunTerminal(snapshot.Status) {
			builder.WriteString("\n脚本仍在运行，请调用 get_script_run 轮询状态。")
		} else {
			builder.WriteString("\n没有 gonavi.output 输出。")
		}
		return builder.String()
	}
	builder.WriteString("\n输出流：")
	for _, output := range snapshot.Outputs {
		builder.WriteString(fmt.Sprintf("\n- index=%d name=%s rows=%d", output.Index, output.Name, output.RowCount))
		if output.Truncated {
			builder.WriteString("（已截断）")
		}
		if len(output.Columns) > 0 {
			builder.WriteString(" columns=")
			builder.WriteString(strings.Join(output.Columns, ","))
		}
	}
	if !scriptRunTerminal(snapshot.Status) {
		builder.WriteString("\n脚本仍在运行，可继续调用 get_script_run；已完成输出可先用 get_script_output 读取。")
	} else {
		builder.WriteString("\n使用 get_script_output（outputIndex 从 0 开始）读取行数据。")
	}
	return builder.String()
}

func formatScriptOutputContent(output appcore.ScriptWorkbenchOutputPage) string {
	columns := output.Columns
	if len(columns) == 0 && len(output.Rows) > 0 {
		columns = inferColumnsFromRows(output.Rows)
	}
	var builder strings.Builder
	builder.WriteString(fmt.Sprintf(
		"脚本输出 %q：第 %d 页，共 %d 行，每页 %d 行",
		output.Name,
		output.Page,
		output.Total,
		output.PageSize,
	))
	if output.Truncated {
		builder.WriteString("，输出流已截断")
	}
	if len(columns) == 0 {
		builder.WriteString("\n\n无行数据。")
		return builder.String()
	}
	builder.WriteString("\n\n")
	builder.WriteString(formatMarkdownTable(columns, output.Rows))
	return builder.String()
}
