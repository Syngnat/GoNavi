package mcpserver

import (
	"encoding/json"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func decodeNamedStringSlice(data interface{}, keys ...string) ([]string, error) {
	switch items := data.(type) {
	case nil:
		return []string{}, nil
	case []string:
		return ensureNonNilStrings(append([]string(nil), items...)), nil
	case []map[string]string:
		result := make([]string, 0, len(items))
		for _, item := range items {
			result = append(result, pickNamedStringFromStringMap(item, keys...))
		}
		return result, nil
	case []map[string]interface{}:
		result := make([]string, 0, len(items))
		for _, item := range items {
			result = append(result, pickNamedStringFromAnyMap(item, keys...))
		}
		return result, nil
	default:
		var decoded []map[string]interface{}
		if err := remarshal(data, &decoded); err != nil {
			return nil, err
		}
		return decodeNamedStringSlice(decoded, keys...)
	}
}

func pickNamedStringFromStringMap(item map[string]string, keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(item[key]); value != "" {
			return value
		}
	}
	for _, value := range item {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func pickNamedStringFromAnyMap(item map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		if value, ok := item[key]; ok {
			if text := strings.TrimSpace(fmt.Sprint(value)); text != "" {
				return text
			}
		}
	}
	for _, value := range item {
		if text := strings.TrimSpace(fmt.Sprint(value)); text != "" {
			return text
		}
	}
	return ""
}

func decodeColumns(data interface{}) ([]connection.ColumnDefinition, error) {
	switch cols := data.(type) {
	case nil:
		return []connection.ColumnDefinition{}, nil
	case []connection.ColumnDefinition:
		return ensureNonNilColumns(append([]connection.ColumnDefinition(nil), cols...)), nil
	default:
		var decoded []connection.ColumnDefinition
		if err := remarshal(data, &decoded); err != nil {
			return nil, err
		}
		return ensureNonNilColumns(decoded), nil
	}
}

func decodeColumnsWithTable(data interface{}) ([]connection.ColumnDefinitionWithTable, error) {
	switch cols := data.(type) {
	case nil:
		return []connection.ColumnDefinitionWithTable{}, nil
	case []connection.ColumnDefinitionWithTable:
		return ensureNonNilColumnsWithTable(append([]connection.ColumnDefinitionWithTable(nil), cols...)), nil
	default:
		var decoded []connection.ColumnDefinitionWithTable
		if err := remarshal(data, &decoded); err != nil {
			return nil, err
		}
		return ensureNonNilColumnsWithTable(decoded), nil
	}
}

func decodeIndexes(data interface{}) ([]connection.IndexDefinition, error) {
	switch indexes := data.(type) {
	case nil:
		return []connection.IndexDefinition{}, nil
	case []connection.IndexDefinition:
		return ensureNonNilIndexes(append([]connection.IndexDefinition(nil), indexes...)), nil
	default:
		var decoded []connection.IndexDefinition
		if err := remarshal(data, &decoded); err != nil {
			return nil, err
		}
		return ensureNonNilIndexes(decoded), nil
	}
}

func decodeForeignKeys(data interface{}) ([]connection.ForeignKeyDefinition, error) {
	switch foreignKeys := data.(type) {
	case nil:
		return []connection.ForeignKeyDefinition{}, nil
	case []connection.ForeignKeyDefinition:
		return ensureNonNilForeignKeys(append([]connection.ForeignKeyDefinition(nil), foreignKeys...)), nil
	default:
		var decoded []connection.ForeignKeyDefinition
		if err := remarshal(data, &decoded); err != nil {
			return nil, err
		}
		return ensureNonNilForeignKeys(decoded), nil
	}
}

func decodeTriggers(data interface{}) ([]connection.TriggerDefinition, error) {
	switch triggers := data.(type) {
	case nil:
		return []connection.TriggerDefinition{}, nil
	case []connection.TriggerDefinition:
		return ensureNonNilTriggers(append([]connection.TriggerDefinition(nil), triggers...)), nil
	default:
		var decoded []connection.TriggerDefinition
		if err := remarshal(data, &decoded); err != nil {
			return nil, err
		}
		return ensureNonNilTriggers(decoded), nil
	}
}

func decodeString(data interface{}) (string, error) {
	switch value := data.(type) {
	case nil:
		return "", nil
	case string:
		return value, nil
	default:
		return fmt.Sprint(value), nil
	}
}

func decodeResultSets(data interface{}) ([]connection.ResultSetData, error) {
	switch items := data.(type) {
	case nil:
		return []connection.ResultSetData{}, nil
	case []connection.ResultSetData:
		return ensureNonNilResultSets(append([]connection.ResultSetData(nil), items...)), nil
	default:
		var decoded []connection.ResultSetData
		if err := remarshal(data, &decoded); err != nil {
			return nil, err
		}
		return ensureNonNilResultSets(decoded), nil
	}
}

func decodeDatabaseObjects(data interface{}) ([]connection.DatabaseObject, error) {
	switch items := data.(type) {
	case nil:
		return []connection.DatabaseObject{}, nil
	case []connection.DatabaseObject:
		return ensureNonNilDatabaseObjects(append([]connection.DatabaseObject(nil), items...)), nil
	default:
		var decoded []connection.DatabaseObject
		if err := remarshal(data, &decoded); err != nil {
			return nil, err
		}
		return ensureNonNilDatabaseObjects(decoded), nil
	}
}

func filterDatabaseObjects(items []connection.DatabaseObject, objectTypes []string) []connection.DatabaseObject {
	if len(objectTypes) == 0 {
		return ensureNonNilDatabaseObjects(items)
	}
	allowed := make(map[string]struct{}, len(objectTypes))
	for _, objectType := range objectTypes {
		normalized := strings.ToLower(strings.TrimSpace(objectType))
		if normalized == "" {
			continue
		}
		switch normalized {
		case "routine", "routines":
			allowed["function"] = struct{}{}
			allowed["procedure"] = struct{}{}
		case "functions":
			allowed["function"] = struct{}{}
		case "procedures":
			allowed["procedure"] = struct{}{}
		case "views":
			allowed["view"] = struct{}{}
		case "tables":
			allowed["table"] = struct{}{}
		case "queues":
			allowed["queue"] = struct{}{}
		case "topics":
			allowed["topic"] = struct{}{}
		case "exchanges":
			allowed["exchange"] = struct{}{}
		case "packages":
			allowed["package"] = struct{}{}
		default:
			allowed[normalized] = struct{}{}
		}
	}
	if len(allowed) == 0 {
		return ensureNonNilDatabaseObjects(items)
	}
	result := make([]connection.DatabaseObject, 0, len(items))
	for _, item := range items {
		if _, ok := allowed[strings.ToLower(strings.TrimSpace(item.Type))]; ok {
			result = append(result, item)
		}
	}
	return ensureNonNilDatabaseObjects(result)
}

func remarshal(from interface{}, to interface{}) error {
	payload, err := json.Marshal(from)
	if err != nil {
		return err
	}
	return json.Unmarshal(payload, to)
}

func normalizeMaxRowsPerResult(input int) int {
	if input <= 0 {
		return defaultMaxRowsPerResult
	}
	if input > maxRowsPerResultLimit {
		return maxRowsPerResultLimit
	}
	return input
}

func normalizeResultSets(resultSets []connection.ResultSetData, maxRows int) ([]sqlResultSet, bool) {
	normalized := make([]sqlResultSet, 0, len(resultSets))
	truncatedAny := false
	for _, resultSet := range resultSets {
		rows := ensureNonNilRows(resultSet.Rows)
		rowCount := len(rows)
		// Truncated 为 true 表示 db 层达到行预算后停止读取，返回的行是
		// 服务器端数据的下界；否则只在超出 maxRows 时做响应侧裁剪。
		truncatedByBudget := resultSet.Truncated
		truncated := truncatedByBudget
		if maxRows > 0 && len(rows) > maxRows {
			rows = append([]map[string]interface{}(nil), rows[:maxRows]...)
			truncated = true
		}
		if truncated {
			truncatedAny = true
		}
		messages := ensureNonNilStrings(append([]string(nil), resultSet.Messages...))
		if truncatedByBudget {
			messages = append(messages, fmt.Sprintf("结果集达到每结果集行数上限 %d，剩余行未读取", maxRows))
		}
		normalized = append(normalized, sqlResultSet{
			StatementIndex: resultSet.StatementIndex,
			Columns:        ensureNonNilStrings(append([]string(nil), resultSet.Columns...)),
			Rows:           rows,
			Messages:       messages,
			RowCount:       rowCount,
			Truncated:      truncated,
		})
	}
	return normalized, truncatedAny
}
