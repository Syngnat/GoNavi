package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func (m *MySQLDB) GetTables(dbName string) ([]string, error) {
	query := "SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"
	if dbName != "" {
		query = fmt.Sprintf(
			"SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = '%s' AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
			strings.ReplaceAll(dbName, "'", "''"),
		)
	}

	data, _, err := m.Query(query)
	if err != nil {
		return nil, err
	}

	tables := make([]string, 0, len(data))
	for _, row := range data {
		for _, v := range row {
			tables = append(tables, fmt.Sprintf("%v", v))
			break
		}
	}
	return resolveShardingSphereLogicalTables(dedupeExactTableMetadataNames(tables), m.Query), nil
}

func dedupeExactTableMetadataNames(tables []string) []string {
	if len(tables) == 0 {
		return tables
	}
	seen := make(map[string]struct{}, len(tables))
	result := make([]string, 0, len(tables))
	for _, table := range tables {
		if strings.TrimSpace(table) == "" {
			continue
		}
		if _, exists := seen[table]; exists {
			continue
		}
		seen[table] = struct{}{}
		result = append(result, table)
	}
	return result
}

func normalizeMySQLIdentifierPart(ident string) string {
	value := strings.TrimSpace(ident)
	for i := 0; i < 4; i++ {
		next := normalizeSQLIdentPartWithBracketMode(value, false, false)
		if next == value {
			break
		}
		value = next
	}
	if len(value) >= 2 {
		first := value[0]
		last := value[len(value)-1]
		switch {
		case first == '\'' && last == '\'':
			return strings.TrimSpace(strings.ReplaceAll(value[1:len(value)-1], `''`, `'`))
		case (first == '\'' && last == '"') || (first == '"' && last == '\''):
			return strings.TrimSpace(value[1 : len(value)-1])
		}
	}
	return strings.TrimSpace(value)
}

func quoteMySQLIdentifier(ident string) string {
	return "`" + strings.ReplaceAll(normalizeMySQLIdentifierPart(ident), "`", "``") + "`"
}

func mysqlMetadataTableParts(dbName, tableName string) (string, string) {
	schema := normalizeMySQLIdentifierPart(dbName)
	table := strings.TrimSpace(tableName)
	if parsedSchema, parsedTable := SplitSQLQualifiedNamePreserveTableQuoteForDialect(table, "mysql"); parsedTable != "" {
		if parsedSchema != "" {
			schema = normalizeMySQLIdentifierPart(parsedSchema)
		}
		table = normalizeMySQLIdentifierPart(parsedTable)
	} else {
		table = normalizeMySQLIdentifierPart(table)
	}
	return schema, table
}

func mysqlQualifiedTableIdentifier(dbName, tableName string) string {
	schema, table := mysqlMetadataTableParts(dbName, tableName)
	if schema != "" {
		return quoteMySQLIdentifier(schema) + "." + quoteMySQLIdentifier(table)
	}
	return quoteMySQLIdentifier(table)
}

func buildMySQLShowCreateTableQuery(dbName, tableName string) string {
	return "SHOW CREATE TABLE " + mysqlQualifiedTableIdentifier(dbName, tableName)
}

func buildMySQLShowFullColumnsQuery(dbName, tableName string) string {
	return "SHOW FULL COLUMNS FROM " + mysqlQualifiedTableIdentifier(dbName, tableName)
}

func buildMySQLShowIndexQuery(dbName, tableName string) string {
	return "SHOW INDEX FROM " + mysqlQualifiedTableIdentifier(dbName, tableName)
}

func buildMySQLForeignKeysQuery() string {
	return `SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
              FROM information_schema.KEY_COLUMN_USAGE
              WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`
}

func buildMySQLShowTriggersQuery(dbName string) string {
	schema := normalizeMySQLIdentifierPart(dbName)
	query := "SHOW TRIGGERS"
	if schema != "" {
		query += " FROM " + quoteMySQLIdentifier(schema)
	}
	return query + " WHERE `Table` = ?"
}

func queryMetadataRowsWithArgs(conn *sql.DB, ctx context.Context, dialect, query string, args ...interface{}) ([]map[string]interface{}, []string, error) {
	if conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}
	rows, err := conn.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRowsForDialect(rows, dialect)
}

func (m *MySQLDB) GetCreateStatement(dbName, tableName string) (string, error) {
	data, _, err := m.Query(buildMySQLShowCreateTableQuery(dbName, tableName))
	if err != nil {
		return "", err
	}

	if len(data) > 0 {
		if val, ok := data[0]["Create Table"]; ok {
			return fmt.Sprintf("%v", val), nil
		}
	}
	return "", localizedDatabaseRuntimeError("db.backend.error.create_table_statement_not_found", nil)
}

func buildMySQLColumnDefinition(row map[string]interface{}) connection.ColumnDefinition {
	col := connection.ColumnDefinition{
		Name:     fmt.Sprintf("%v", row["Field"]),
		Type:     fmt.Sprintf("%v", row["Type"]),
		Nullable: fmt.Sprintf("%v", row["Null"]),
		Key:      fmt.Sprintf("%v", row["Key"]),
		Extra:    fmt.Sprintf("%v", row["Extra"]),
		Comment:  fmt.Sprintf("%v", row["Comment"]),
	}

	if row["Default"] != nil {
		defaultValue := fmt.Sprintf("%v", row["Default"])
		col.Default = &defaultValue
		col.HasDefault = true
	}
	if row["Collation"] != nil {
		col.Collation = fmt.Sprintf("%v", row["Collation"])
		if separator := strings.IndexByte(col.Collation, '_'); separator > 0 {
			col.Charset = col.Collation[:separator]
		}
	}

	return col
}

func (m *MySQLDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	data, _, err := m.Query(buildMySQLShowFullColumnsQuery(dbName, tableName))
	if err != nil {
		return nil, err
	}

	columns := make([]connection.ColumnDefinition, 0, len(data))
	for _, row := range data {
		columns = append(columns, buildMySQLColumnDefinition(row))
	}
	return columns, nil
}

func (m *MySQLDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	data, _, err := m.Query(buildMySQLShowIndexQuery(dbName, tableName))
	if err != nil {
		return nil, err
	}

	var indexes []connection.IndexDefinition
	for _, row := range data {
		nonUnique := 0
		if val, ok := row["Non_unique"]; ok {
			if f, ok := val.(float64); ok {
				nonUnique = int(f)
			} else if i, ok := val.(int64); ok {
				nonUnique = int(i)
			}
		}

		seq := 0
		if val, ok := row["Seq_in_index"]; ok {
			if f, ok := val.(float64); ok {
				seq = int(f)
			} else if i, ok := val.(int64); ok {
				seq = int(i)
			}
		}

		subPart := 0
		if val, ok := row["Sub_part"]; ok && val != nil {
			if f, ok := val.(float64); ok {
				subPart = int(f)
			} else if i, ok := val.(int64); ok {
				subPart = int(i)
			}
		}

		idx := connection.IndexDefinition{
			Name:       fmt.Sprintf("%v", row["Key_name"]),
			ColumnName: fmt.Sprintf("%v", row["Column_name"]),
			NonUnique:  nonUnique,
			SeqInIndex: seq,
			IndexType:  fmt.Sprintf("%v", row["Index_type"]),
			SubPart:    subPart,
		}
		indexes = append(indexes, idx)
	}
	return indexes, nil
}

func (m *MySQLDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	schema, table := mysqlMetadataTableParts(dbName, tableName)
	data, _, err := queryMetadataRowsWithArgs(m.conn, metadataContextFor(m), "mysql", buildMySQLForeignKeysQuery(), schema, table)
	if err != nil {
		return nil, err
	}

	var fks []connection.ForeignKeyDefinition
	for _, row := range data {
		fk := connection.ForeignKeyDefinition{
			Name:           fmt.Sprintf("%v", row["CONSTRAINT_NAME"]),
			ColumnName:     fmt.Sprintf("%v", row["COLUMN_NAME"]),
			RefTableName:   fmt.Sprintf("%v", row["REFERENCED_TABLE_NAME"]),
			RefColumnName:  fmt.Sprintf("%v", row["REFERENCED_COLUMN_NAME"]),
			ConstraintName: fmt.Sprintf("%v", row["CONSTRAINT_NAME"]),
		}
		fks = append(fks, fk)
	}
	return fks, nil
}

func (m *MySQLDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	schema, table := mysqlMetadataTableParts(dbName, tableName)
	data, _, err := queryMetadataRowsWithArgs(m.conn, metadataContextFor(m), "mysql", buildMySQLShowTriggersQuery(schema), table)
	if err != nil {
		return nil, err
	}

	var triggers []connection.TriggerDefinition
	for _, row := range data {
		trig := connection.TriggerDefinition{
			Name:      fmt.Sprintf("%v", row["Trigger"]),
			Timing:    fmt.Sprintf("%v", row["Timing"]),
			Event:     fmt.Sprintf("%v", row["Event"]),
			Statement: fmt.Sprintf("%v", row["Statement"]),
		}
		triggers = append(triggers, trig)
	}
	return triggers, nil
}

func (m *MySQLDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	if dbName == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.database_name_required", nil)
	}
	query := fmt.Sprintf("SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '%s'", strings.ReplaceAll(dbName, "'", "''"))

	data, _, err := m.Query(query)
	if err != nil {
		return nil, err
	}

	var cols []connection.ColumnDefinitionWithTable
	for _, row := range data {
		col := connection.ColumnDefinitionWithTable{
			TableName: fmt.Sprintf("%v", row["TABLE_NAME"]),
			Name:      fmt.Sprintf("%v", row["COLUMN_NAME"]),
			Type:      fmt.Sprintf("%v", row["COLUMN_TYPE"]),
			Comment:   fmt.Sprintf("%v", row["COLUMN_COMMENT"]),
		}
		cols = append(cols, col)
	}
	return cols, nil
}
