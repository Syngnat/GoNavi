package mcpserver

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/connection"
)

func formatExecuteSQLResultContent(result executeSQLResult) string {
	var builder strings.Builder
	builder.WriteString("SQL 执行成功")
	if result.QueryID != "" {
		builder.WriteString("，queryId=")
		builder.WriteString(result.QueryID)
	}
	builder.WriteString("\n")
	builder.WriteString(fmt.Sprintf("语句数：%d，结果集：%d", result.StatementCount, len(result.Results)))
	if result.Truncated {
		builder.WriteString("，结果已截断")
	}
	if result.CancellationState != "" {
		builder.WriteString("\n取消状态：")
		builder.WriteString(result.CancellationState)
	}
	if result.Message != "" {
		builder.WriteString("\n消息：")
		builder.WriteString(result.Message)
	}
	if len(result.Results) == 0 {
		builder.WriteString("\n无结果集返回。")
		return builder.String()
	}

	for index, resultSet := range result.Results {
		builder.WriteString("\n\n")
		builder.WriteString(fmt.Sprintf("结果集 %d", index+1))
		if resultSet.StatementIndex > 0 {
			builder.WriteString(fmt.Sprintf("（语句 #%d）", resultSet.StatementIndex))
		}
		builder.WriteString(fmt.Sprintf("：%d 行", resultSet.RowCount))
		if resultSet.Truncated {
			builder.WriteString(fmt.Sprintf("，已达每结果集行数上限（返回前 %d 行），其余行未返回", len(resultSet.Rows)))
		}
		if len(resultSet.Messages) > 0 {
			builder.WriteString("\n消息：")
			builder.WriteString(strings.Join(resultSet.Messages, "\n"))
		}
		if len(resultSet.Columns) == 0 {
			if len(resultSet.Rows) == 0 {
				builder.WriteString("\n无列/行数据。")
				continue
			}
			resultSet.Columns = inferColumnsFromRows(resultSet.Rows)
		}
		if len(resultSet.Columns) == 0 {
			continue
		}
		builder.WriteString("\n")
		builder.WriteString(formatMarkdownTable(resultSet.Columns, resultSet.Rows))
	}
	return builder.String()
}

func inferColumnsFromRows(rows []map[string]interface{}) []string {
	seen := make(map[string]struct{})
	columns := []string{}
	for _, row := range rows {
		keys := make([]string, 0, len(row))
		for key := range row {
			if _, ok := seen[key]; ok {
				continue
			}
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			seen[key] = struct{}{}
			columns = append(columns, key)
		}
	}
	return columns
}

func formatMarkdownTable(columns []string, rows []map[string]interface{}) string {
	var builder strings.Builder
	builder.WriteString("|")
	for _, column := range columns {
		builder.WriteString(" ")
		builder.WriteString(escapeMarkdownTableCell(column))
		builder.WriteString(" |")
	}
	builder.WriteString("\n|")
	for range columns {
		builder.WriteString(" --- |")
	}
	for _, row := range rows {
		builder.WriteString("\n|")
		for _, column := range columns {
			builder.WriteString(" ")
			builder.WriteString(escapeMarkdownTableCell(formatSQLValue(row[column])))
			builder.WriteString(" |")
		}
	}
	return builder.String()
}

func formatSQLValue(value interface{}) string {
	if value == nil {
		return "NULL"
	}
	switch typed := value.(type) {
	case string:
		return typed
	case []byte:
		return string(typed)
	case fmt.Stringer:
		return typed.String()
	}
	data, err := json.Marshal(value)
	if err == nil {
		return string(data)
	}
	return fmt.Sprint(value)
}

func escapeMarkdownTableCell(value string) string {
	value = strings.ReplaceAll(value, "\\", "\\\\")
	value = strings.ReplaceAll(value, "|", "\\|")
	value = strings.ReplaceAll(value, "\r\n", "\n")
	value = strings.ReplaceAll(value, "\r", "\n")
	value = strings.ReplaceAll(value, "\n", "<br>")
	return value
}

func toStatementSummaries(items []appcore.SQLStatementInspection) []sqlStatementSummary {
	result := make([]sqlStatementSummary, 0, len(items))
	for _, item := range items {
		result = append(result, sqlStatementSummary{
			Index:    item.Index,
			Keyword:  item.Keyword,
			ReadOnly: item.ReadOnly,
		})
	}
	return result
}

func ensureNonNilStrings(items []string) []string {
	if items == nil {
		return []string{}
	}
	return items
}

func ensureNonNilColumns(items []connection.ColumnDefinition) []connection.ColumnDefinition {
	if items == nil {
		return []connection.ColumnDefinition{}
	}
	return items
}

func ensureNonNilColumnsWithTable(items []connection.ColumnDefinitionWithTable) []connection.ColumnDefinitionWithTable {
	if items == nil {
		return []connection.ColumnDefinitionWithTable{}
	}
	return items
}

func ensureNonNilIndexes(items []connection.IndexDefinition) []connection.IndexDefinition {
	if items == nil {
		return []connection.IndexDefinition{}
	}
	return items
}

func ensureNonNilForeignKeys(items []connection.ForeignKeyDefinition) []connection.ForeignKeyDefinition {
	if items == nil {
		return []connection.ForeignKeyDefinition{}
	}
	return items
}

func ensureNonNilTriggers(items []connection.TriggerDefinition) []connection.TriggerDefinition {
	if items == nil {
		return []connection.TriggerDefinition{}
	}
	return items
}

func ensureNonNilRows(items []map[string]interface{}) []map[string]interface{} {
	if items == nil {
		return []map[string]interface{}{}
	}
	return items
}

func ensureNonNilResultSets(items []connection.ResultSetData) []connection.ResultSetData {
	if items == nil {
		return []connection.ResultSetData{}
	}
	return items
}

func ensureNonNilDatabaseObjects(items []connection.DatabaseObject) []connection.DatabaseObject {
	if items == nil {
		return []connection.DatabaseObject{}
	}
	return items
}
