package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/utils"

	_ "github.com/marcboeker/go-duckdb"
)

type DuckDB struct {
	conn        *sql.DB
	pingTimeout time.Duration
}

func (d *DuckDB) Connect(config connection.ConnectionConfig) error {
	dsn := strings.TrimSpace(config.Host)
	if dsn == "" {
		dsn = strings.TrimSpace(config.Database)
	}
	if dsn == "" {
		dsn = ":memory:"
	}

	db, err := sql.Open("duckdb", dsn)
	if err != nil {
		return fmt.Errorf("打开数据库连接失败：%w", err)
	}
	d.conn = db
	d.pingTimeout = getConnectTimeout(config)

	if err := d.Ping(); err != nil {
		return fmt.Errorf("连接建立后验证失败：%w", err)
	}
	return nil
}

func (d *DuckDB) Close() error {
	if d.conn != nil {
		return d.conn.Close()
	}
	return nil
}

func (d *DuckDB) Ping() error {
	if d.conn == nil {
		return fmt.Errorf("connection not open")
	}
	timeout := d.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	return d.conn.PingContext(ctx)
}

func (d *DuckDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if d.conn == nil {
		return nil, nil, fmt.Errorf("connection not open")
	}
	rows, err := d.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (d *DuckDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if d.conn == nil {
		return nil, nil, fmt.Errorf("connection not open")
	}
	rows, err := d.conn.Query(query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (d *DuckDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if d.conn == nil {
		return 0, fmt.Errorf("connection not open")
	}
	res, err := d.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (d *DuckDB) Exec(query string) (int64, error) {
	if d.conn == nil {
		return 0, fmt.Errorf("connection not open")
	}
	res, err := d.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (d *DuckDB) GetDatabases() ([]string, error) {
	data, _, err := d.Query("PRAGMA database_list")
	if err != nil {
		return []string{"main"}, nil
	}

	seen := map[string]struct{}{}
	var names []string
	for _, row := range data {
		name := strings.TrimSpace(duckDBRowString(row, "name", "database_name", "database"))
		if name == "" {
			continue
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}
	if len(names) == 0 {
		return []string{"main"}, nil
	}
	return names, nil
}

func (d *DuckDB) GetTables(dbName string) ([]string, error) {
	query := `
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_type = 'BASE TABLE'
  AND table_schema NOT IN ('information_schema', 'pg_catalog')
ORDER BY table_schema, table_name`

	data, _, err := d.Query(query)
	if err != nil {
		return nil, err
	}

	seen := map[string]struct{}{}
	var tables []string
	for _, row := range data {
		schema := strings.TrimSpace(duckDBRowString(row, "table_schema"))
		name := strings.TrimSpace(duckDBRowString(row, "table_name"))
		if name == "" {
			continue
		}
		qualified := name
		if schema != "" && !strings.EqualFold(schema, "main") {
			qualified = schema + "." + name
		}
		if _, exists := seen[qualified]; exists {
			continue
		}
		seen[qualified] = struct{}{}
		tables = append(tables, qualified)
	}
	return tables, nil
}

func (d *DuckDB) GetCreateStatement(dbName, tableName string) (string, error) {
	schema, pureTable := normalizeDuckDBSchemaAndTable(dbName, tableName)
	if pureTable == "" {
		return "", fmt.Errorf("table name required")
	}

	escapedTable := escapeDuckDBLiteral(pureTable)
	escapedSchema := escapeDuckDBLiteral(schema)

	queryCandidates := []string{
		fmt.Sprintf("SELECT sql FROM duckdb_tables() WHERE table_name = '%s' AND schema_name = '%s' LIMIT 1", escapedTable, escapedSchema),
		fmt.Sprintf("SELECT sql FROM duckdb_tables() WHERE table_name = '%s' LIMIT 1", escapedTable),
		fmt.Sprintf("SHOW CREATE TABLE %s", quoteDuckDBQualifiedTable(schema, pureTable)),
	}

	for _, query := range queryCandidates {
		data, _, err := d.Query(query)
		if err != nil || len(data) == 0 {
			continue
		}

		createSQL := strings.TrimSpace(duckDBRowString(data[0], "sql", "create_table", "Create Table", "create_statement"))
		if createSQL != "" {
			return createSQL, nil
		}
		for _, value := range data[0] {
			text := strings.TrimSpace(fmt.Sprintf("%v", value))
			if text != "" && text != "<nil>" {
				return text, nil
			}
		}
	}

	return "", fmt.Errorf("create statement not found")
}

func (d *DuckDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	schema, pureTable := normalizeDuckDBSchemaAndTable(dbName, tableName)
	if pureTable == "" {
		return nil, fmt.Errorf("table name required")
	}

	query := fmt.Sprintf(`
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = '%s' AND table_schema = '%s'
ORDER BY ordinal_position`, escapeDuckDBLiteral(pureTable), escapeDuckDBLiteral(schema))

	data, _, err := d.Query(query)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 && schema != "main" {
		fallbackQuery := fmt.Sprintf(`
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = '%s'
ORDER BY ordinal_position`, escapeDuckDBLiteral(pureTable))
		data, _, err = d.Query(fallbackQuery)
		if err != nil {
			return nil, err
		}
	}

	var columns []connection.ColumnDefinition
	for _, row := range data {
		column := connection.ColumnDefinition{
			Name:     duckDBRowString(row, "column_name"),
			Type:     duckDBRowString(row, "data_type"),
			Nullable: strings.ToUpper(strings.TrimSpace(duckDBRowString(row, "is_nullable"))),
			Key:      "",
			Extra:    "",
			Comment:  "",
		}
		if column.Nullable == "" {
			column.Nullable = "YES"
		}
		if defaultVal := strings.TrimSpace(duckDBRowString(row, "column_default")); defaultVal != "" && defaultVal != "<nil>" {
			def := defaultVal
			column.Default = &def
		}
		columns = append(columns, column)
	}
	return columns, nil
}

func (d *DuckDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	query := `
SELECT table_schema, table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
ORDER BY table_schema, table_name, ordinal_position`

	data, _, err := d.Query(query)
	if err != nil {
		return nil, err
	}

	columns := make([]connection.ColumnDefinitionWithTable, 0, len(data))
	for _, row := range data {
		schema := strings.TrimSpace(duckDBRowString(row, "table_schema"))
		tableName := strings.TrimSpace(duckDBRowString(row, "table_name"))
		if tableName == "" {
			continue
		}
		if schema != "" && !strings.EqualFold(schema, "main") {
			tableName = schema + "." + tableName
		}

		columns = append(columns, connection.ColumnDefinitionWithTable{
			TableName: tableName,
			Name:      duckDBRowString(row, "column_name"),
			Type:      duckDBRowString(row, "data_type"),
		})
	}
	return columns, nil
}

func (d *DuckDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return []connection.IndexDefinition{}, nil
}

func (d *DuckDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

func (d *DuckDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}

func (d *DuckDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	if d.conn == nil {
		return fmt.Errorf("connection not open")
	}

	tx, err := d.conn.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	quoteIdent := func(name string) string {
		n := strings.TrimSpace(name)
		n = strings.Trim(n, "\"")
		n = strings.ReplaceAll(n, "\"", "\"\"")
		if n == "" {
			return "\"\""
		}
		return `"` + n + `"`
	}

	schema := ""
	table := strings.TrimSpace(tableName)
	if parts := strings.SplitN(table, ".", 2); len(parts) == 2 {
		schema = strings.TrimSpace(parts[0])
		table = strings.TrimSpace(parts[1])
	}

	qualifiedTable := quoteIdent(table)
	if schema != "" {
		qualifiedTable = fmt.Sprintf("%s.%s", quoteIdent(schema), quoteIdent(table))
	}

	for _, pk := range changes.Deletes {
		var wheres []string
		var args []interface{}
		for k, v := range pk {
			wheres = append(wheres, fmt.Sprintf("%s = ?", quoteIdent(k)))
			args = append(args, v)
		}
		if len(wheres) == 0 {
			continue
		}
		query := fmt.Sprintf("DELETE FROM %s WHERE %s", qualifiedTable, strings.Join(wheres, " AND "))
		if _, err := tx.Exec(query, args...); err != nil {
			return fmt.Errorf("delete error: %v", err)
		}
	}

	for _, update := range changes.Updates {
		var sets []string
		var args []interface{}
		for k, v := range update.Values {
			sets = append(sets, fmt.Sprintf("%s = ?", quoteIdent(k)))
			args = append(args, v)
		}
		if len(sets) == 0 {
			continue
		}

		var wheres []string
		for k, v := range update.Keys {
			wheres = append(wheres, fmt.Sprintf("%s = ?", quoteIdent(k)))
			args = append(args, v)
		}
		if len(wheres) == 0 {
			return fmt.Errorf("update requires keys")
		}

		query := fmt.Sprintf("UPDATE %s SET %s WHERE %s", qualifiedTable, strings.Join(sets, ", "), strings.Join(wheres, " AND "))
		if _, err := tx.Exec(query, args...); err != nil {
			return fmt.Errorf("update error: %v", err)
		}
	}

	for _, row := range changes.Inserts {
		var cols []string
		var placeholders []string
		var args []interface{}

		for k, v := range row {
			cols = append(cols, quoteIdent(k))
			placeholders = append(placeholders, "?")
			args = append(args, v)
		}
		if len(cols) == 0 {
			continue
		}

		query := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", qualifiedTable, strings.Join(cols, ", "), strings.Join(placeholders, ", "))
		if _, err := tx.Exec(query, args...); err != nil {
			return fmt.Errorf("insert error: %v", err)
		}
	}

	return tx.Commit()
}

func normalizeDuckDBSchemaAndTable(dbName string, tableName string) (string, string) {
	schema := strings.TrimSpace(dbName)
	table := strings.TrimSpace(tableName)
	if table == "" {
		if schema == "" {
			schema = "main"
		}
		return schema, table
	}

	if parts := strings.SplitN(table, ".", 2); len(parts) == 2 {
		left := strings.TrimSpace(parts[0])
		right := strings.TrimSpace(parts[1])
		if left != "" && right != "" {
			return normalizeDuckDBIdentifier(left), normalizeDuckDBIdentifier(right)
		}
	}

	if schema == "" {
		schema = "main"
	}
	return normalizeDuckDBIdentifier(schema), normalizeDuckDBIdentifier(table)
}

func normalizeDuckDBIdentifier(raw string) string {
	text := strings.TrimSpace(raw)
	if len(text) >= 2 {
		first := text[0]
		last := text[len(text)-1]
		if (first == '"' && last == '"') || (first == '`' && last == '`') {
			text = strings.TrimSpace(text[1 : len(text)-1])
		}
	}
	return text
}

func quoteDuckDBIdentifier(raw string) string {
	text := normalizeDuckDBIdentifier(raw)
	return `"` + strings.ReplaceAll(text, `"`, `""`) + `"`
}

func quoteDuckDBQualifiedTable(schema string, table string) string {
	s := strings.TrimSpace(schema)
	t := strings.TrimSpace(table)
	if s == "" {
		return quoteDuckDBIdentifier(t)
	}
	return quoteDuckDBIdentifier(s) + "." + quoteDuckDBIdentifier(t)
}

func duckDBRowString(row map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		for rowKey, value := range row {
			if !strings.EqualFold(rowKey, key) || value == nil {
				continue
			}
			return fmt.Sprintf("%v", value)
		}
	}
	return ""
}

func escapeDuckDBLiteral(raw string) string {
	return strings.ReplaceAll(raw, "'", "''")
}
