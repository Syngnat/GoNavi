package db

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/internal/utils"

	_ "github.com/microsoft/go-mssqldb"
)

type SqlServerDB struct {
	conn        *sql.DB
	pingTimeout time.Duration
	forwarder   *ssh.LocalForwarder
}

// quoteBracket escapes ] in identifiers for safe use in SQL Server [bracket] notation
func quoteBracket(name string) string {
	return strings.ReplaceAll(name, "]", "]]")
}

func (s *SqlServerDB) getDSN(config connection.ConnectionConfig) string {
	// sqlserver://user:password@host:port?database=dbname
	dbname := config.Database
	if dbname == "" {
		dbname = "master"
	}

	u := &url.URL{
		Scheme: "sqlserver",
		Host:   net.JoinHostPort(config.Host, strconv.Itoa(config.Port)),
	}
	u.User = url.UserPassword(config.User, config.Password)

	q := url.Values{}
	q.Set("database", dbname)
	q.Set("connection timeout", strconv.Itoa(getConnectTimeoutSeconds(config)))
	q.Set("encrypt", "disable")
	q.Set("TrustServerCertificate", "true")
	u.RawQuery = q.Encode()

	return u.String()
}

func (s *SqlServerDB) Connect(config connection.ConnectionConfig) error {
	var dsn string

	if config.UseSSH {
		logger.Infof("SQL Server 使用 SSH 连接：地址=%s:%d 用户=%s", config.Host, config.Port, config.User)

		forwarder, err := ssh.GetOrCreateLocalForwarder(config.SSH, config.Host, config.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		s.forwarder = forwarder

		host, portStr, err := net.SplitHostPort(forwarder.LocalAddr)
		if err != nil {
			return fmt.Errorf("解析本地转发地址失败：%w", err)
		}

		port, err := strconv.Atoi(portStr)
		if err != nil {
			return fmt.Errorf("解析本地端口失败：%w", err)
		}

		localConfig := config
		localConfig.Host = host
		localConfig.Port = port
		localConfig.UseSSH = false

		dsn = s.getDSN(localConfig)
		logger.Infof("SQL Server 通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	} else {
		dsn = s.getDSN(config)
	}

	db, err := sql.Open("sqlserver", dsn)
	if err != nil {
		return fmt.Errorf("打开数据库连接失败：%w", err)
	}
	s.conn = db
	s.pingTimeout = getConnectTimeout(config)

	if err := s.Ping(); err != nil {
		return fmt.Errorf("连接建立后验证失败：%w", err)
	}
	return nil
}

func (s *SqlServerDB) Close() error {
	if s.forwarder != nil {
		if err := s.forwarder.Close(); err != nil {
			logger.Warnf("关闭 SQL Server SSH 端口转发失败：%v", err)
		}
		s.forwarder = nil
	}

	if s.conn != nil {
		return s.conn.Close()
	}
	return nil
}

func (s *SqlServerDB) Ping() error {
	if s.conn == nil {
		return fmt.Errorf("connection not open")
	}
	timeout := s.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	return s.conn.PingContext(ctx)
}

func (s *SqlServerDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if s.conn == nil {
		return nil, nil, fmt.Errorf("connection not open")
	}

	rows, err := s.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	return scanRows(rows)
}

func (s *SqlServerDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if s.conn == nil {
		return nil, nil, fmt.Errorf("connection not open")
	}

	rows, err := s.conn.Query(query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (s *SqlServerDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if s.conn == nil {
		return 0, fmt.Errorf("connection not open")
	}
	res, err := s.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *SqlServerDB) Exec(query string) (int64, error) {
	if s.conn == nil {
		return 0, fmt.Errorf("connection not open")
	}
	res, err := s.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *SqlServerDB) GetDatabases() ([]string, error) {
	query := "SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' ORDER BY name"
	data, _, err := s.Query(query)
	if err != nil {
		return nil, err
	}
	var dbs []string
	for _, row := range data {
		if val, ok := row["name"]; ok {
			dbs = append(dbs, fmt.Sprintf("%v", val))
		}
	}
	return dbs, nil
}

func (s *SqlServerDB) GetTables(dbName string) ([]string, error) {
	// SQL Server uses schema.table format, default schema is dbo
	safeDB := quoteBracket(dbName)
	query := fmt.Sprintf(`
SELECT s.name AS schema_name, t.name AS table_name
FROM [%s].sys.tables t
JOIN [%s].sys.schemas s ON t.schema_id = s.schema_id
WHERE t.type = 'U'
ORDER BY s.name, t.name`, safeDB, safeDB)

	data, _, err := s.Query(query)
	if err != nil {
		return nil, err
	}

	var tables []string
	for _, row := range data {
		schema, okSchema := row["schema_name"]
		name, okName := row["table_name"]
		if okSchema && okName {
			tables = append(tables, fmt.Sprintf("%v.%v", schema, name))
			continue
		}
		if okName {
			tables = append(tables, fmt.Sprintf("%v", name))
		}
	}
	return tables, nil
}

func (s *SqlServerDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return fmt.Sprintf("-- SHOW CREATE TABLE not supported for SQL Server in this version.\n-- Table: %s.%s", dbName, tableName), nil
}

func (s *SqlServerDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	schema := "dbo"
	table := strings.TrimSpace(tableName)

	if parts := strings.SplitN(table, ".", 2); len(parts) == 2 {
		schema = strings.TrimSpace(parts[0])
		table = strings.TrimSpace(parts[1])
	}

	if table == "" {
		return nil, fmt.Errorf("table name required")
	}

	esc := func(s string) string { return strings.ReplaceAll(s, "'", "''") }
	safeDB := quoteBracket(dbName)

	query := fmt.Sprintf(`
SELECT
    c.name AS column_name,
    t.name + CASE
        WHEN t.name IN ('varchar', 'nvarchar', 'char', 'nchar') THEN '(' + CASE WHEN c.max_length = -1 THEN 'MAX' ELSE CAST(CASE WHEN t.name IN ('nvarchar', 'nchar') THEN c.max_length / 2 ELSE c.max_length END AS VARCHAR) END + ')'
        WHEN t.name IN ('decimal', 'numeric') THEN '(' + CAST(c.precision AS VARCHAR) + ',' + CAST(c.scale AS VARCHAR) + ')'
        ELSE ''
    END AS data_type,
    CASE WHEN c.is_nullable = 1 THEN 'YES' ELSE 'NO' END AS is_nullable,
    dc.definition AS column_default,
    ep.value AS comment,
    CASE WHEN pk.column_id IS NOT NULL THEN 'PRI' ELSE '' END AS column_key,
    CASE WHEN c.is_identity = 1 THEN 'auto_increment' ELSE '' END AS extra
FROM [%s].sys.columns c
JOIN [%s].sys.types t ON c.user_type_id = t.user_type_id
JOIN [%s].sys.tables tb ON c.object_id = tb.object_id
JOIN [%s].sys.schemas s ON tb.schema_id = s.schema_id
LEFT JOIN [%s].sys.default_constraints dc ON c.default_object_id = dc.object_id
LEFT JOIN [%s].sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
LEFT JOIN (
    SELECT ic.object_id, ic.column_id
    FROM [%s].sys.index_columns ic
    JOIN [%s].sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id
    WHERE i.is_primary_key = 1
) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
WHERE s.name = '%s' AND tb.name = '%s'
ORDER BY c.column_id`,
		safeDB, safeDB, safeDB, safeDB, safeDB, safeDB, safeDB, safeDB,
		esc(schema), esc(table))

	data, _, err := s.Query(query)
	if err != nil {
		return nil, err
	}

	var columns []connection.ColumnDefinition
	for _, row := range data {
		col := connection.ColumnDefinition{
			Name:     fmt.Sprintf("%v", row["column_name"]),
			Type:     fmt.Sprintf("%v", row["data_type"]),
			Nullable: fmt.Sprintf("%v", row["is_nullable"]),
			Key:      fmt.Sprintf("%v", row["column_key"]),
			Extra:    fmt.Sprintf("%v", row["extra"]),
			Comment:  "",
		}

		if v, ok := row["comment"]; ok && v != nil {
			col.Comment = fmt.Sprintf("%v", v)
		}

		if v, ok := row["column_default"]; ok && v != nil {
			def := fmt.Sprintf("%v", v)
			col.Default = &def
		}

		columns = append(columns, col)
	}
	return columns, nil
}

func (s *SqlServerDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	safeDB := quoteBracket(dbName)
	query := fmt.Sprintf(`
SELECT s.name AS schema_name, t.name AS table_name, c.name AS column_name, tp.name AS data_type
FROM [%s].sys.columns c
JOIN [%s].sys.tables t ON c.object_id = t.object_id
JOIN [%s].sys.schemas s ON t.schema_id = s.schema_id
JOIN [%s].sys.types tp ON c.user_type_id = tp.user_type_id
WHERE t.type = 'U'
ORDER BY s.name, t.name, c.column_id`, safeDB, safeDB, safeDB, safeDB)

	data, _, err := s.Query(query)
	if err != nil {
		return nil, err
	}

	var cols []connection.ColumnDefinitionWithTable
	for _, row := range data {
		schema := fmt.Sprintf("%v", row["schema_name"])
		table := fmt.Sprintf("%v", row["table_name"])
		tableName := fmt.Sprintf("%s.%s", schema, table)

		col := connection.ColumnDefinitionWithTable{
			TableName: tableName,
			Name:      fmt.Sprintf("%v", row["column_name"]),
			Type:      fmt.Sprintf("%v", row["data_type"]),
		}
		cols = append(cols, col)
	}
	return cols, nil
}

func (s *SqlServerDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	schema := "dbo"
	table := strings.TrimSpace(tableName)

	if parts := strings.SplitN(table, ".", 2); len(parts) == 2 {
		schema = strings.TrimSpace(parts[0])
		table = strings.TrimSpace(parts[1])
	}

	if table == "" {
		return nil, fmt.Errorf("table name required")
	}

	esc := func(s string) string { return strings.ReplaceAll(s, "'", "''") }
	safeDB := quoteBracket(dbName)

	query := fmt.Sprintf(`
SELECT
    i.name AS index_name,
    c.name AS column_name,
    i.is_unique,
    ic.key_ordinal AS seq_in_index,
    i.type_desc AS index_type
FROM [%s].sys.indexes i
JOIN [%s].sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
JOIN [%s].sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
JOIN [%s].sys.tables t ON i.object_id = t.object_id
JOIN [%s].sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = '%s' AND t.name = '%s' AND i.name IS NOT NULL
ORDER BY i.name, ic.key_ordinal`,
		safeDB, safeDB, safeDB, safeDB, safeDB, esc(schema), esc(table))

	data, _, err := s.Query(query)
	if err != nil {
		return nil, err
	}

	var indexes []connection.IndexDefinition
	for _, row := range data {
		isUnique := false
		if v, ok := row["is_unique"]; ok && v != nil {
			switch val := v.(type) {
			case bool:
				isUnique = val
			case int64:
				isUnique = val == 1
			}
		}

		nonUnique := 1
		if isUnique {
			nonUnique = 0
		}

		seq := 0
		if v, ok := row["seq_in_index"]; ok && v != nil {
			switch val := v.(type) {
			case int:
				seq = val
			case int64:
				seq = int(val)
			}
		}

		indexType := "NONCLUSTERED"
		if v, ok := row["index_type"]; ok && v != nil {
			indexType = strings.ToUpper(fmt.Sprintf("%v", v))
		}

		idx := connection.IndexDefinition{
			Name:       fmt.Sprintf("%v", row["index_name"]),
			ColumnName: fmt.Sprintf("%v", row["column_name"]),
			NonUnique:  nonUnique,
			SeqInIndex: seq,
			IndexType:  indexType,
		}
		indexes = append(indexes, idx)
	}
	return indexes, nil
}

func (s *SqlServerDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	schema := "dbo"
	table := strings.TrimSpace(tableName)

	if parts := strings.SplitN(table, ".", 2); len(parts) == 2 {
		schema = strings.TrimSpace(parts[0])
		table = strings.TrimSpace(parts[1])
	}

	if table == "" {
		return nil, fmt.Errorf("table name required")
	}

	esc := func(s string) string { return strings.ReplaceAll(s, "'", "''") }
	safeDB := quoteBracket(dbName)

	query := fmt.Sprintf(`
SELECT
    fk.name AS constraint_name,
    c.name AS column_name,
    rs.name AS foreign_schema,
    rt.name AS foreign_table,
    rc.name AS foreign_column
FROM [%s].sys.foreign_keys fk
JOIN [%s].sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
JOIN [%s].sys.columns c ON fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id
JOIN [%s].sys.tables t ON fk.parent_object_id = t.object_id
JOIN [%s].sys.schemas s ON t.schema_id = s.schema_id
JOIN [%s].sys.tables rt ON fk.referenced_object_id = rt.object_id
JOIN [%s].sys.schemas rs ON rt.schema_id = rs.schema_id
JOIN [%s].sys.columns rc ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id
WHERE s.name = '%s' AND t.name = '%s'
ORDER BY fk.name`,
		safeDB, safeDB, safeDB, safeDB, safeDB, safeDB, safeDB, safeDB, esc(schema), esc(table))

	data, _, err := s.Query(query)
	if err != nil {
		return nil, err
	}

	var fks []connection.ForeignKeyDefinition
	for _, row := range data {
		refSchema := fmt.Sprintf("%v", row["foreign_schema"])
		refTable := fmt.Sprintf("%v", row["foreign_table"])
		refTableName := fmt.Sprintf("%s.%s", refSchema, refTable)

		fk := connection.ForeignKeyDefinition{
			Name:           fmt.Sprintf("%v", row["constraint_name"]),
			ColumnName:     fmt.Sprintf("%v", row["column_name"]),
			RefTableName:   refTableName,
			RefColumnName:  fmt.Sprintf("%v", row["foreign_column"]),
			ConstraintName: fmt.Sprintf("%v", row["constraint_name"]),
		}
		fks = append(fks, fk)
	}
	return fks, nil
}

func (s *SqlServerDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	schema := "dbo"
	table := strings.TrimSpace(tableName)

	if parts := strings.SplitN(table, ".", 2); len(parts) == 2 {
		schema = strings.TrimSpace(parts[0])
		table = strings.TrimSpace(parts[1])
	}

	if table == "" {
		return nil, fmt.Errorf("table name required")
	}

	esc := func(s string) string { return strings.ReplaceAll(s, "'", "''") }
	safeDB := quoteBracket(dbName)

	query := fmt.Sprintf(`
SELECT
    tr.name AS trigger_name,
    CASE WHEN tr.is_instead_of_trigger = 1 THEN 'INSTEAD OF' ELSE 'AFTER' END AS timing,
    STUFF((
        SELECT ', ' + te.type_desc
        FROM [%s].sys.trigger_events te
        WHERE te.object_id = tr.object_id
        FOR XML PATH('')
    ), 1, 2, '') AS event,
    OBJECT_DEFINITION(tr.object_id) AS statement
FROM [%s].sys.triggers tr
JOIN [%s].sys.tables t ON tr.parent_id = t.object_id
JOIN [%s].sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = '%s' AND t.name = '%s'
ORDER BY tr.name`,
		safeDB, safeDB, safeDB, safeDB, esc(schema), esc(table))

	data, _, err := s.Query(query)
	if err != nil {
		return nil, err
	}

	var triggers []connection.TriggerDefinition
	for _, row := range data {
		trig := connection.TriggerDefinition{
			Name:      fmt.Sprintf("%v", row["trigger_name"]),
			Timing:    fmt.Sprintf("%v", row["timing"]),
			Event:     fmt.Sprintf("%v", row["event"]),
			Statement: "",
		}
		if v, ok := row["statement"]; ok && v != nil {
			trig.Statement = fmt.Sprintf("%v", v)
		}
		triggers = append(triggers, trig)
	}
	return triggers, nil
}

func (s *SqlServerDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	if s.conn == nil {
		return fmt.Errorf("connection not open")
	}

	tx, err := s.conn.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	quoteIdent := func(name string) string {
		n := strings.TrimSpace(name)
		n = strings.Trim(n, "[]")
		n = strings.ReplaceAll(n, "]", "]]")
		if n == "" {
			return "[]"
		}
		return "[" + n + "]"
	}

	schema := "dbo"
	table := strings.TrimSpace(tableName)
	if parts := strings.SplitN(table, ".", 2); len(parts) == 2 {
		schema = strings.TrimSpace(parts[0])
		table = strings.TrimSpace(parts[1])
	}

	qualifiedTable := fmt.Sprintf("%s.%s", quoteIdent(schema), quoteIdent(table))

	// 1. Deletes
	for _, pk := range changes.Deletes {
		var wheres []string
		var args []interface{}
		idx := 0
		for k, v := range pk {
			idx++
			wheres = append(wheres, fmt.Sprintf("%s = @p%d", quoteIdent(k), idx))
			args = append(args, sql.Named(fmt.Sprintf("p%d", idx), v))
		}
		if len(wheres) == 0 {
			continue
		}
		query := fmt.Sprintf("DELETE FROM %s WHERE %s", qualifiedTable, strings.Join(wheres, " AND "))
		if _, err := tx.Exec(query, args...); err != nil {
			return fmt.Errorf("delete error: %v", err)
		}
	}

	// 2. Updates
	for _, update := range changes.Updates {
		var sets []string
		var args []interface{}
		idx := 0

		for k, v := range update.Values {
			idx++
			sets = append(sets, fmt.Sprintf("%s = @p%d", quoteIdent(k), idx))
			args = append(args, sql.Named(fmt.Sprintf("p%d", idx), v))
		}

		if len(sets) == 0 {
			continue
		}

		var wheres []string
		for k, v := range update.Keys {
			idx++
			wheres = append(wheres, fmt.Sprintf("%s = @p%d", quoteIdent(k), idx))
			args = append(args, sql.Named(fmt.Sprintf("p%d", idx), v))
		}

		if len(wheres) == 0 {
			return fmt.Errorf("update requires keys")
		}

		query := fmt.Sprintf("UPDATE %s SET %s WHERE %s", qualifiedTable, strings.Join(sets, ", "), strings.Join(wheres, " AND "))
		if _, err := tx.Exec(query, args...); err != nil {
			return fmt.Errorf("update error: %v", err)
		}
	}

	// 3. Inserts
	for _, row := range changes.Inserts {
		var cols []string
		var placeholders []string
		var args []interface{}
		idx := 0

		for k, v := range row {
			idx++
			cols = append(cols, quoteIdent(k))
			placeholders = append(placeholders, fmt.Sprintf("@p%d", idx))
			args = append(args, sql.Named(fmt.Sprintf("p%d", idx), v))
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
