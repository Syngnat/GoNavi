package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/utils"
)

type CustomDB struct {
	conn        *sql.DB
	driver      string
	pingTimeout time.Duration
}

func (c *CustomDB) Connect(config connection.ConnectionConfig) error {
	driver := strings.TrimSpace(config.Driver)
	dsn := strings.TrimSpace(config.DSN)
	if driver == "" || dsn == "" {
		return fmt.Errorf("driver and dsn are required for custom connection")
	}
	if strings.EqualFold(driver, "mysql") {
		dsn = normalizeMySQLRawDSNCompatibilityParams(dsn)
	}

	// Verify driver is registered (implicit check by sql.Open)
	// We might not need explicit check, sql.Open will fail or Ping will fail if driver not found.

	db, err := sql.Open(driver, dsn)
	if err != nil {
		return formatCustomDriverOpenError(driver, err)
	}
	configureSQLConnectionPool(db, driver)
	c.conn = db
	c.driver = driver
	c.pingTimeout = getConnectTimeout(config)
	if err := c.Ping(); err != nil {
		_ = db.Close()
		c.conn = nil
		return wrapDatabaseConnectionVerifyError(err)
	}
	return nil
}

func formatCustomDriverOpenError(driver string, err error) error {
	if err == nil {
		return nil
	}
	if strings.Contains(strings.ToLower(err.Error()), "unknown driver") {
		if isLikelySystemODBCDriverName(driver) {
			return fmt.Errorf("%s%w", localizedDriverRuntimeText("db.backend.error.custom_driver_system_odbc_unsupported_prefix", map[string]any{
				"driver": driver,
			}), err)
		}
		return fmt.Errorf("%s%w", localizedDriverRuntimeText("db.backend.error.custom_driver_unregistered_prefix", map[string]any{
			"driver": driver,
		}), err)
	}
	return wrapDatabaseConnectionOpenError(err)
}

func isLikelySystemODBCDriverName(driver string) bool {
	normalized := strings.ToLower(strings.TrimSpace(driver))
	return strings.Contains(normalized, "odbc") ||
		strings.Contains(normalized, "jdbc") ||
		strings.Contains(normalized, "intersystems") ||
		strings.Contains(normalized, "iris")
}

func (c *CustomDB) Close() error {
	if c.conn != nil {
		return c.conn.Close()
	}
	return nil
}

func (c *CustomDB) Ping() error {
	if c.conn == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	timeout := c.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	return c.conn.PingContext(ctx)
}

func (c *CustomDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if c.conn == nil {
		return nil, nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}

	rows, err := c.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	return scanRowsForDialect(rows, c.scanDialect())
}

func (c *CustomDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if c.conn == nil {
		return nil, nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}

	rows, err := c.conn.QueryContext(metadataContextFor(c), query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRowsForDialect(rows, c.scanDialect())
}

func (c *CustomDB) StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error {
	if c.conn == nil {
		return fmt.Errorf("连接未打开")
	}

	rows, err := c.conn.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	defer rows.Close()

	return streamRowsForDialect(rows, c.scanDialect(), consumer)
}

func (c *CustomDB) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return c.StreamQueryContext(context.Background(), query, consumer)
}

func (c *CustomDB) scanDialect() string {
	if strings.EqualFold(strings.TrimSpace(c.driver), "mysql") {
		return "mysql"
	}
	return ""
}

func (c *CustomDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if c.conn == nil {
		return 0, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	res, err := c.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (c *CustomDB) Exec(query string) (int64, error) {
	if c.conn == nil {
		return 0, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	res, err := c.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (c *CustomDB) GetDatabases() ([]string, error) {
	// Try standard information_schema or some known patterns if we can't guess
	// For "custom", we can't easily know.
	// But many DBs support SHOW DATABASES or SELECT datname FROM pg_database
	// We'll try a generic query or return empty.
	// Users using custom might know their DB context is single.

	if c.driver == "mysql" {
		data, _, err := c.Query("SHOW DATABASES")
		if err == nil {
			var dbs []string
			for _, row := range data {
				for _, v := range row {
					name := strings.TrimSpace(fmt.Sprintf("%v", v))
					if name != "" {
						dbs = append(dbs, name)
					}
					break
				}
			}
			if len(dbs) > 0 {
				return dbs, nil
			}
		}

		// Fallback for restricted accounts: at least expose current database.
		data, _, fallbackErr := c.Query("SELECT DATABASE() AS database_name")
		if fallbackErr == nil {
			for _, row := range data {
				for _, v := range row {
					name := strings.TrimSpace(fmt.Sprintf("%v", v))
					if name != "" && !strings.EqualFold(name, "<nil>") && !strings.EqualFold(name, "null") {
						return []string{name}, nil
					}
				}
			}
		}
	}

	// Best effort:
	return []string{}, nil
}

func (c *CustomDB) GetTables(dbName string) ([]string, error) {
	driverName := strings.ToLower(strings.TrimSpace(c.driver))
	// ANSI Standard
	query := "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
	// If mysql-like
	if driverName == "mysql" {
		query = "SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"
		if dbName != "" {
			query = fmt.Sprintf(
				"SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = '%s' AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
				strings.ReplaceAll(dbName, "'", "''"),
			)
		}
	} else if driverName == "postgres" || driverName == "kingbase" {
		query = `
			SELECT DISTINCT table_schema AS schemaname, table_name AS tablename
			FROM information_schema.tables
			WHERE table_type = 'BASE TABLE'
			  AND table_schema NOT IN ('pg_catalog', 'information_schema')`
		if dbName != "" {
			query += fmt.Sprintf(" AND table_schema = '%s'", strings.ReplaceAll(dbName, "'", "''"))
		}
		query += " ORDER BY table_schema, table_name"
	} else if driverName == "sqlite" {
		query = "SELECT name FROM sqlite_master WHERE type='table'"
	} else if driverName == "oracle" || driverName == "dm" {
		query = "SELECT table_name FROM user_tables"
		if dbName != "" {
			query = fmt.Sprintf("SELECT owner, table_name FROM all_tables WHERE owner = '%s' ORDER BY table_name", strings.ToUpper(dbName))
		}
	}

	// Fallback generic execution
	data, _, err := c.Query(query)
	if err != nil {
		return nil, fmt.Errorf("failed to get tables for custom driver %s: %v", c.driver, err)
	}
	if driverName == "postgres" || driverName == "kingbase" {
		return parsePostgresTableNames(data), nil
	}

	tables := make([]string, 0, len(data))
	seen := make(map[string]struct{}, len(data))
	appendTable := func(table string) {
		trimmed := strings.TrimSpace(table)
		if trimmed == "" || strings.EqualFold(trimmed, "<nil>") || strings.EqualFold(trimmed, "null") {
			return
		}
		if _, exists := seen[trimmed]; exists {
			return
		}
		seen[trimmed] = struct{}{}
		tables = append(tables, trimmed)
	}
	for _, row := range data {
		if schema := getCaseInsensitiveRowString(row, "schemaname", "schema_name", "schema"); schema != "" {
			if name := getCaseInsensitiveRowString(row, "tablename", "table_name"); name != "" {
				appendTable(fmt.Sprintf("%s.%s", schema, name))
				continue
			}
		}
		if owner := getCaseInsensitiveRowString(row, "owner"); owner != "" {
			if name := getCaseInsensitiveRowString(row, "table_name", "tablename"); name != "" {
				appendTable(fmt.Sprintf("%s.%s", owner, name))
				continue
			}
		}
		// iterate keys to find likely column
		for k, v := range row {
			if strings.Contains(strings.ToLower(k), "name") || strings.Contains(strings.ToLower(k), "table") {
				appendTable(fmt.Sprintf("%v", v))
				break
			}
		}
	}
	return tables, nil
}

func (c *CustomDB) GetTableRowCounts(_ string, tables []string) (map[string]int64, error) {
	if !strings.EqualFold(strings.TrimSpace(c.driver), "sqlite") {
		return map[string]int64{}, nil
	}
	return getSQLiteTableRowCounts(c.Query, tables)
}

func (c *CustomDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return "Not supported for custom connections yet", nil
}

func (c *CustomDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	// ANSI Standard
	// SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = '...'

	schema := "public"
	if dbName != "" {
		schema = dbName
	}

	query := fmt.Sprintf(`SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, is_nullable, column_default
		FROM information_schema.columns
		WHERE table_name = '%s'`, tableName)

	// Adjust for schema if likely supported
	if c.driver == "postgres" || c.driver == "kingbase" {
		query += fmt.Sprintf(" AND table_schema = '%s'", schema)
	} else if c.driver == "mysql" {
		query = fmt.Sprintf("SHOW FULL COLUMNS FROM `%s`", tableName)
		if dbName != "" {
			query = fmt.Sprintf("SHOW FULL COLUMNS FROM `%s`.`%s`", dbName, tableName)
		}
	}

	data, _, err := c.Query(query)
	if err != nil {
		return nil, err
	}

	var columns []connection.ColumnDefinition
	for _, row := range data {
		columns = append(columns, buildCustomColumnDefinition(row))
	}
	return columns, nil
}

func buildCustomColumnDefinition(row map[string]interface{}) connection.ColumnDefinition {
	col := connection.ColumnDefinition{
		Name:     customMetadataString(row, "Field", "field", "COLUMN_NAME", "column_name", "NAME", "name"),
		Type:     buildCustomColumnType(row),
		Nullable: normalizeCustomNullable(customMetadataString(row, "Null", "null", "IS_NULLABLE", "is_nullable", "NULLABLE", "nullable")),
		Key:      customMetadataString(row, "Key", "key", "COLUMN_KEY", "column_key", "PRIMARY_KEY", "primary_key"),
		Extra:    customMetadataString(row, "Extra", "extra", "EXTRA"),
		Comment:  customMetadataString(row, "Comment", "comment", "COMMENTS", "comments", "COLUMN_COMMENT", "column_comment"),
	}
	if defaultValue, ok := customMetadataStringOK(row, "Default", "default", "COLUMN_DEFAULT", "column_default", "DATA_DEFAULT", "data_default"); ok {
		col.Default = &defaultValue
	}
	return col
}

func buildCustomColumnType(row map[string]interface{}) string {
	rawType := customMetadataString(
		row,
		"COLUMN_TYPE",
		"column_type",
		"FULL_TYPE",
		"full_type",
		"FULL_DATA_TYPE",
		"full_data_type",
		"TYPE_NAME",
		"type_name",
		"Type",
		"type",
		"DATA_TYPE",
		"data_type",
	)
	if rawType == "" || strings.Contains(rawType, "(") {
		return rawType
	}

	upperType := strings.ToUpper(rawType)
	charLength := customMetadataInt(row, "CHARACTER_MAXIMUM_LENGTH", "character_maximum_length", "CHARACTER_MAX_LENGTH", "character_max_length", "CHAR_LENGTH", "char_length", "LENGTH", "length")
	if charLength > 0 && strings.Contains(upperType, "CHAR") {
		return fmt.Sprintf("%s(%d)", rawType, charLength)
	}

	precision := customMetadataInt(row, "NUMERIC_PRECISION", "numeric_precision", "DATA_PRECISION", "data_precision", "PRECISION", "precision")
	if precision > 0 && (strings.Contains(upperType, "DECIMAL") || strings.Contains(upperType, "NUMERIC") || strings.Contains(upperType, "NUMBER")) {
		scale := customMetadataInt(row, "NUMERIC_SCALE", "numeric_scale", "DATA_SCALE", "data_scale", "SCALE", "scale")
		if scale > 0 {
			return fmt.Sprintf("%s(%d,%d)", rawType, precision, scale)
		}
		return fmt.Sprintf("%s(%d)", rawType, precision)
	}

	return rawType
}

func customMetadataString(row map[string]interface{}, keys ...string) string {
	value, _ := customMetadataStringOK(row, keys...)
	return value
}

func customMetadataStringOK(row map[string]interface{}, keys ...string) (string, bool) {
	for _, key := range keys {
		for rowKey, raw := range row {
			if !strings.EqualFold(rowKey, key) || raw == nil {
				continue
			}
			return strings.TrimSpace(fmt.Sprintf("%v", raw)), true
		}
	}
	return "", false
}

func customMetadataInt(row map[string]interface{}, keys ...string) int {
	return parseMetadataInt(customMetadataString(row, keys...))
}

func normalizeCustomNullable(value string) string {
	trimmed := strings.TrimSpace(value)
	switch strings.ToLower(trimmed) {
	case "n", "no", "false", "0":
		return "NO"
	case "y", "yes", "true", "1":
		return "YES"
	default:
		return trimmed
	}
}

func (c *CustomDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return nil, fmt.Errorf("not implemented for custom")
}

func (c *CustomDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return nil, fmt.Errorf("not implemented for custom")
}

func (c *CustomDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return nil, fmt.Errorf("not implemented for custom")
}

func (c *CustomDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	if c.conn == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}

	conn, tx, err := beginPinnedWriteTransaction(c.conn)
	if err != nil {
		return err
	}
	defer func() {
		if conn != nil {
			_ = conn.Close()
		}
	}()
	defer tx.Rollback()

	driver := strings.ToLower(strings.TrimSpace(c.driver))
	isMySQL := strings.Contains(driver, "mysql")
	isKingbase := strings.Contains(driver, "kingbase")
	isPostgres := strings.Contains(driver, "postgres") || isKingbase || strings.Contains(driver, "pg")
	isOracle := strings.Contains(driver, "oracle") || strings.Contains(driver, "ora") || strings.Contains(driver, "dm") || strings.Contains(driver, "dameng")
	isSQLServer := strings.Contains(driver, "sqlserver") || strings.Contains(driver, "mssql")
	isSQLite := strings.Contains(driver, "sqlite") || strings.Contains(driver, "duckdb")

	quoteIdent := func(name string) string {
		n := strings.TrimSpace(name)
		if isKingbase {
			return QuoteKingbaseIdentifier(n)
		}
		if isMySQL {
			n = strings.Trim(n, "`")
			n = strings.ReplaceAll(n, "`", "``")
			if n == "" {
				return "``"
			}
			return "`" + n + "`"
		}
		n = strings.Trim(n, "\"")
		n = strings.ReplaceAll(n, "\"", "\"\"")
		if n == "" {
			return "\"\""
		}
		return `"` + n + `"`
	}

	placeholder := func(idx int) string {
		if isPostgres {
			return fmt.Sprintf("$%d", idx)
		}
		if isOracle {
			return fmt.Sprintf(":%d", idx)
		}
		// MySQL / SQLite / default
		return "?"
	}

	schema := ""
	table := strings.TrimSpace(tableName)
	if isKingbase {
		schema, table = SplitKingbaseQualifiedName(table)
	} else if parts := strings.SplitN(table, ".", 2); len(parts) == 2 {
		schema = strings.TrimSpace(parts[0])
		table = strings.TrimSpace(parts[1])
	}

	qualifiedTable := ""
	if schema != "" {
		qualifiedTable = fmt.Sprintf("%s.%s", quoteIdent(schema), quoteIdent(table))
	} else {
		qualifiedTable = quoteIdent(table)
	}

	// 1. Deletes
	for _, pk := range changes.Deletes {
		var wheres []string
		var args []interface{}
		idx := 0
		for k, v := range pk {
			idx++
			wheres = append(wheres, fmt.Sprintf("%s = %s", quoteIdent(k), placeholder(idx)))
			args = append(args, v)
		}
		if len(wheres) == 0 {
			continue
		}
		query := fmt.Sprintf("DELETE FROM %s WHERE %s", qualifiedTable, strings.Join(wheres, " AND "))
		if _, err := tx.Exec(query, args...); err != nil {
			return localizedDatabaseRuntimeError("db.backend.error.row_delete_failed", map[string]any{"detail": err.Error()})
		}
	}

	// 2. Updates
	for _, update := range changes.Updates {
		var sets []string
		var args []interface{}
		idx := 0

		for k, v := range update.Values {
			idx++
			sets = append(sets, fmt.Sprintf("%s = %s", quoteIdent(k), placeholder(idx)))
			args = append(args, v)
		}

		if len(sets) == 0 {
			continue
		}

		var wheres []string
		for k, v := range update.Keys {
			idx++
			wheres = append(wheres, fmt.Sprintf("%s = %s", quoteIdent(k), placeholder(idx)))
			args = append(args, v)
		}

		if len(wheres) == 0 {
			return localizedDatabaseRuntimeError("db.backend.error.row_update_key_conditions_required", nil)
		}

		query := fmt.Sprintf("UPDATE %s SET %s WHERE %s", qualifiedTable, strings.Join(sets, ", "), strings.Join(wheres, " AND "))
		if _, err := tx.Exec(query, args...); err != nil {
			return localizedDatabaseRuntimeError("db.backend.error.row_update_failed", map[string]any{"detail": err.Error()})
		}
	}

	if err := execParameterizedInsertBatches(parameterizedInsertConfig{
		Table:       qualifiedTable,
		Rows:        changes.Inserts,
		QuoteColumn: quoteIdent,
		Placeholder: placeholder,
		Exec: func(query string, args ...interface{}) (sql.Result, error) {
			return tx.Exec(query, args...)
		},
		MaxArgs: customInsertMaxArgs(isSQLServer, isSQLite),
	}); err != nil {
		return err
	}

	return commitPinnedWriteTransaction(&conn, tx)
}

func customInsertMaxArgs(isSQLServer, isSQLite bool) int {
	switch {
	case isSQLServer:
		return sqlServerBatchInsertArgs
	case isSQLite:
		return sqliteBatchInsertArgs
	default:
		return 0
	}
}

func (c *CustomDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, fmt.Errorf("not implemented for custom")
}
