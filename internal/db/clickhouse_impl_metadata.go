//go:build gonavi_full_drivers || gonavi_clickhouse_driver

package db

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func (c *ClickHouseDB) GetDatabases() ([]string, error) {
	data, _, err := c.Query("SELECT name FROM system.databases ORDER BY name")
	if err == nil {
		result := make([]string, 0, len(data))
		for _, row := range data {
			if val, ok := getClickHouseValueFromRow(row, "name", "database"); ok {
				result = append(result, fmt.Sprintf("%v", val))
				continue
			}
			for _, value := range row {
				result = append(result, fmt.Sprintf("%v", value))
				break
			}
		}
		if len(result) > 0 {
			return result, nil
		}
	}

	fallbackData, _, fallbackErr := c.Query("SELECT currentDatabase() AS name")
	if fallbackErr != nil {
		if err != nil {
			return nil, err
		}
		return nil, fallbackErr
	}

	result := make([]string, 0, len(fallbackData))
	for _, row := range fallbackData {
		if val, ok := getClickHouseValueFromRow(row, "name", "database", "currentDatabase"); ok {
			name := strings.TrimSpace(fmt.Sprintf("%v", val))
			if name != "" {
				result = append(result, name)
			}
			continue
		}
		for _, value := range row {
			name := strings.TrimSpace(fmt.Sprintf("%v", value))
			if name != "" {
				result = append(result, name)
			}
			break
		}
	}
	if len(result) > 0 {
		return result, nil
	}
	if current := strings.TrimSpace(c.database); current != "" {
		return []string{current}, nil
	}
	if err != nil {
		return nil, err
	}
	return nil, fmt.Errorf("未获取到 ClickHouse 数据库列表")
}

func (c *ClickHouseDB) GetTables(dbName string) ([]string, error) {
	targetDB := strings.TrimSpace(dbName)
	if targetDB == "" {
		targetDB = strings.TrimSpace(c.database)
	}

	var query string
	if targetDB != "" {
		query = fmt.Sprintf(
			"SELECT name FROM system.tables WHERE database = '%s' ORDER BY name",
			escapeClickHouseSQLLiteral(targetDB),
		)
	} else {
		query = "SELECT database, name FROM system.tables ORDER BY database, name"
	}

	data, _, err := c.Query(query)
	if err != nil {
		return nil, err
	}

	result := make([]string, 0, len(data))
	for _, row := range data {
		if targetDB != "" {
			if val, ok := getClickHouseValueFromRow(row, "name", "table", "table_name"); ok {
				result = append(result, fmt.Sprintf("%v", val))
				continue
			}
		} else {
			databaseValue, hasDB := getClickHouseValueFromRow(row, "database", "schema_name")
			tableValue, hasTable := getClickHouseValueFromRow(row, "name", "table", "table_name")
			if hasDB && hasTable {
				result = append(result, fmt.Sprintf("%v.%v", databaseValue, tableValue))
				continue
			}
		}
		for _, value := range row {
			result = append(result, fmt.Sprintf("%v", value))
			break
		}
	}
	return result, nil
}

func (c *ClickHouseDB) GetCreateStatement(dbName, tableName string) (string, error) {
	database, table, err := c.resolveDatabaseAndTable(dbName, tableName)
	if err != nil {
		return "", err
	}

	query := fmt.Sprintf("SHOW CREATE TABLE %s.%s", quoteClickHouseIdentifier(database), quoteClickHouseIdentifier(table))
	data, _, err := c.Query(query)
	if err != nil {
		return "", err
	}
	if len(data) == 0 {
		return "", localizedDatabaseRuntimeError("db.backend.error.create_table_statement_not_found", nil)
	}
	row := data[0]
	if val, ok := getClickHouseValueFromRow(row, "statement", "create_statement", "sql", "query"); ok {
		text := strings.TrimSpace(fmt.Sprintf("%v", val))
		if text != "" {
			return text, nil
		}
	}

	longest := ""
	for _, value := range row {
		text := strings.TrimSpace(fmt.Sprintf("%v", value))
		if text == "" {
			continue
		}
		if strings.Contains(strings.ToUpper(text), "CREATE ") && len(text) > len(longest) {
			longest = text
		}
	}
	if longest != "" {
		return longest, nil
	}
	return "", localizedDatabaseRuntimeError("db.backend.error.create_table_statement_not_found", nil)
}

func (c *ClickHouseDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	database, table, err := c.resolveDatabaseAndTable(dbName, tableName)
	if err != nil {
		return nil, err
	}

	query := fmt.Sprintf(`
SELECT
    name,
    type,
    default_kind,
    default_expression,
    is_in_primary_key,
    is_in_sorting_key,
    comment
FROM system.columns
WHERE database = '%s' AND table = '%s'
ORDER BY position`,
		escapeClickHouseSQLLiteral(database),
		escapeClickHouseSQLLiteral(table),
	)
	data, _, err := c.Query(query)
	if err != nil {
		return nil, err
	}

	columns := make([]connection.ColumnDefinition, 0, len(data))
	for _, row := range data {
		nameValue, _ := getClickHouseValueFromRow(row, "name", "column_name")
		typeValue, _ := getClickHouseValueFromRow(row, "type", "data_type")
		defaultKind, _ := getClickHouseValueFromRow(row, "default_kind")
		defaultExpr, hasDefault := getClickHouseValueFromRow(row, "default_expression", "column_default")
		commentValue, _ := getClickHouseValueFromRow(row, "comment")
		inPrimary, _ := getClickHouseValueFromRow(row, "is_in_primary_key")
		inSorting, _ := getClickHouseValueFromRow(row, "is_in_sorting_key")

		colType := strings.TrimSpace(fmt.Sprintf("%v", typeValue))
		nullable := "NO"
		if strings.HasPrefix(strings.ToLower(colType), "nullable(") {
			nullable = "YES"
		}

		key := ""
		if isClickHouseTruthy(inPrimary) {
			key = "PRI"
		} else if isClickHouseTruthy(inSorting) {
			key = "MUL"
		}

		extra := ""
		kindText := strings.ToUpper(strings.TrimSpace(fmt.Sprintf("%v", defaultKind)))
		if kindText != "" && kindText != "DEFAULT" {
			extra = kindText
		}

		col := connection.ColumnDefinition{
			Name:     strings.TrimSpace(fmt.Sprintf("%v", nameValue)),
			Type:     colType,
			Nullable: nullable,
			Key:      key,
			Extra:    extra,
			Comment:  strings.TrimSpace(fmt.Sprintf("%v", commentValue)),
		}
		if hasDefault && defaultExpr != nil {
			text := strings.TrimSpace(fmt.Sprintf("%v", defaultExpr))
			if text != "" {
				col.Default = &text
			}
		}
		columns = append(columns, col)
	}
	return columns, nil
}

func (c *ClickHouseDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	targetDB := strings.TrimSpace(dbName)
	if targetDB == "" {
		targetDB = strings.TrimSpace(c.database)
	}

	var query string
	if targetDB != "" {
		query = fmt.Sprintf(`
SELECT
    database,
    table,
    name,
    type,
    comment
FROM system.columns
WHERE database = '%s'
ORDER BY table, position`,
			escapeClickHouseSQLLiteral(targetDB),
		)
	} else {
		query = `
SELECT
    database,
    table,
    name,
    type,
    comment
FROM system.columns
WHERE database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA')
ORDER BY database, table, position`
	}

	data, _, err := c.Query(query)
	if err != nil {
		return nil, err
	}

	result := make([]connection.ColumnDefinitionWithTable, 0, len(data))
	for _, row := range data {
		databaseValue, _ := getClickHouseValueFromRow(row, "database")
		tableValue, hasTable := getClickHouseValueFromRow(row, "table", "table_name")
		nameValue, hasName := getClickHouseValueFromRow(row, "name", "column_name")
		typeValue, _ := getClickHouseValueFromRow(row, "type", "data_type")
		commentValue, _ := getClickHouseValueFromRow(row, "comment")
		if !hasTable || !hasName {
			continue
		}

		tableName := strings.TrimSpace(fmt.Sprintf("%v", tableValue))
		if targetDB == "" {
			dbText := strings.TrimSpace(fmt.Sprintf("%v", databaseValue))
			if dbText != "" {
				tableName = dbText + "." + tableName
			}
		}

		result = append(result, connection.ColumnDefinitionWithTable{
			TableName: tableName,
			Name:      strings.TrimSpace(fmt.Sprintf("%v", nameValue)),
			Type:      strings.TrimSpace(fmt.Sprintf("%v", typeValue)),
			Comment:   strings.TrimSpace(fmt.Sprintf("%v", commentValue)),
		})
	}
	return result, nil
}

func (c *ClickHouseDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return []connection.IndexDefinition{}, nil
}

func (c *ClickHouseDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

func (c *ClickHouseDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}

func (c *ClickHouseDB) resolveDatabaseAndTable(dbName, tableName string) (string, string, error) {
	rawTable := strings.TrimSpace(tableName)
	if rawTable == "" {
		return "", "", localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}

	resolvedDB := strings.TrimSpace(dbName)
	resolvedTable := rawTable
	segments := SplitSQLIdentifierPathForDialect(rawTable, "clickhouse")
	if len(segments) >= 2 {
		if dbPart := normalizeClickHouseIdentifierPart(segments[0].Raw); dbPart != "" {
			resolvedDB = dbPart
		}
		last := segments[len(segments)-1]
		resolvedTable = normalizeClickHouseIdentifierPart(last.Raw)
	} else if len(segments) == 1 {
		resolvedTable = normalizeClickHouseIdentifierPart(segments[0].Raw)
	}

	if resolvedDB == "" {
		resolvedDB = strings.TrimSpace(c.database)
	}
	if resolvedDB == "" {
		resolvedDB = defaultClickHouseDatabase
	}
	if resolvedTable == "" {
		return "", "", localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}
	return resolvedDB, resolvedTable, nil
}

func normalizeClickHouseIdentifierPart(raw string) string {
	segments := SplitSQLIdentifierPathForDialect(raw, "clickhouse")
	if len(segments) == 1 {
		return strings.TrimSpace(segments[0].Value)
	}
	return strings.TrimSpace(raw)
}

func quoteClickHouseIdentifier(raw string) string {
	return "`" + strings.ReplaceAll(strings.TrimSpace(raw), "`", "``") + "`"
}

func escapeClickHouseSQLLiteral(raw string) string {
	return strings.ReplaceAll(strings.TrimSpace(raw), "'", "''")
}

func getClickHouseValueFromRow(row map[string]interface{}, keys ...string) (interface{}, bool) {
	if len(row) == 0 {
		return nil, false
	}
	for _, key := range keys {
		if value, ok := row[key]; ok {
			return value, true
		}
	}
	for existingKey, value := range row {
		for _, key := range keys {
			if strings.EqualFold(existingKey, key) {
				return value, true
			}
		}
	}
	return nil, false
}

func isClickHouseTruthy(value interface{}) bool {
	switch val := value.(type) {
	case bool:
		return val
	case int:
		return val != 0
	case int8:
		return val != 0
	case int16:
		return val != 0
	case int32:
		return val != 0
	case int64:
		return val != 0
	case uint:
		return val != 0
	case uint8:
		return val != 0
	case uint16:
		return val != 0
	case uint32:
		return val != 0
	case uint64:
		return val != 0
	case string:
		normalized := strings.ToLower(strings.TrimSpace(val))
		return normalized == "1" || normalized == "true" || normalized == "yes" || normalized == "y"
	default:
		normalized := strings.ToLower(strings.TrimSpace(fmt.Sprintf("%v", value)))
		return normalized == "1" || normalized == "true" || normalized == "yes" || normalized == "y"
	}
}
