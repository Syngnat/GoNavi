package db

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/internal/utils"

	_ "gitea.com/kingbase/gokb" // Registers "kingbase" driver
)

type KingbaseDB struct {
	conn        *sql.DB
	pingTimeout time.Duration
	forwarder   *ssh.LocalForwarder // Store SSH tunnel forwarder
}

func quoteConnValue(v string) string {
	if v == "" {
		return "''"
	}

	needsQuote := false
	for _, r := range v {
		switch r {
		case ' ', '\t', '\n', '\r', '\v', '\f', '\'', '\\':
			needsQuote = true
		}
		if needsQuote {
			break
		}
	}
	if !needsQuote {
		return v
	}

	var b strings.Builder
	b.Grow(len(v) + 2)
	b.WriteByte('\'')
	for _, r := range v {
		if r == '\\' || r == '\'' {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	b.WriteByte('\'')
	return b.String()
}

func (k *KingbaseDB) getDSN(config connection.ConnectionConfig) string {
	// Kingbase DSN usually similar to Postgres:
	// host=localhost port=54321 user=system password=... dbname=TEST sslmode=disable

	address := config.Host
	port := config.Port

	// Construct DSN
	dsn := fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=disable connect_timeout=%d",
		quoteConnValue(address),
		port,
		quoteConnValue(config.User),
		quoteConnValue(config.Password),
		quoteConnValue(config.Database),
		getConnectTimeoutSeconds(config),
	)

	return dsn
}

func (k *KingbaseDB) Connect(config connection.ConnectionConfig) error {
	var dsn string
	var err error

	if config.UseSSH {
		// Create SSH tunnel with local port forwarding
		logger.Infof("人大金仓使用 SSH 连接：地址=%s:%d 用户=%s", config.Host, config.Port, config.User)

		forwarder, err := ssh.GetOrCreateLocalForwarder(config.SSH, config.Host, config.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		k.forwarder = forwarder

		// Parse local address
		host, portStr, err := net.SplitHostPort(forwarder.LocalAddr)
		if err != nil {
			return fmt.Errorf("解析本地转发地址失败：%w", err)
		}

		port, err := strconv.Atoi(portStr)
		if err != nil {
			return fmt.Errorf("解析本地端口失败：%w", err)
		}

		// Create a modified config pointing to local forwarder
		localConfig := config
		localConfig.Host = host
		localConfig.Port = port
		localConfig.UseSSH = false

		dsn = k.getDSN(localConfig)
		logger.Infof("人大金仓通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	} else {
		dsn = k.getDSN(config)
	}

	// Open using "kingbase" driver
	db, err := sql.Open("kingbase", dsn)
	if err != nil {
		return fmt.Errorf("打开数据库连接失败：%w", err)
	}
	k.conn = db
	k.pingTimeout = getConnectTimeout(config)
	if err := k.Ping(); err != nil {
		return fmt.Errorf("连接建立后验证失败：%w", err)
	}
	return nil
}

func (k *KingbaseDB) Close() error {
	// Close SSH forwarder first if exists
	if k.forwarder != nil {
		if err := k.forwarder.Close(); err != nil {
			logger.Warnf("关闭人大金仓 SSH 端口转发失败：%v", err)
		}
		k.forwarder = nil
	}

	// Then close database connection
	if k.conn != nil {
		return k.conn.Close()
	}
	return nil
}

func (k *KingbaseDB) Ping() error {
	if k.conn == nil {
		return fmt.Errorf("connection not open")
	}
	timeout := k.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	return k.conn.PingContext(ctx)
}

func (k *KingbaseDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if k.conn == nil {
		return nil, nil, fmt.Errorf("connection not open")
	}

	rows, err := k.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	return scanRows(rows)
}

func (k *KingbaseDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if k.conn == nil {
		return nil, nil, fmt.Errorf("connection not open")
	}

	rows, err := k.conn.Query(query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (k *KingbaseDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if k.conn == nil {
		return 0, fmt.Errorf("connection not open")
	}
	res, err := k.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (k *KingbaseDB) Exec(query string) (int64, error) {
	if k.conn == nil {
		return 0, fmt.Errorf("connection not open")
	}
	res, err := k.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (k *KingbaseDB) GetDatabases() ([]string, error) {
	// Postgres/Kingbase style
	data, _, err := k.Query("SELECT datname FROM pg_database WHERE datistemplate = false")
	if err != nil {
		return nil, err
	}
	var dbs []string
	for _, row := range data {
		if val, ok := row["datname"]; ok {
			dbs = append(dbs, fmt.Sprintf("%v", val))
		}
	}
	return dbs, nil
}

func (k *KingbaseDB) GetTables(dbName string) ([]string, error) {
	// Kingbase: tables are scoped by the current DB connection; include schema to avoid search_path issues.
	query := `
		SELECT table_schema AS schemaname, table_name AS tablename
		FROM information_schema.tables
		WHERE table_type = 'BASE TABLE'
		  AND table_schema NOT IN ('pg_catalog', 'information_schema')
		  AND table_schema NOT LIKE 'pg_%'
		ORDER BY table_schema, table_name`

	data, _, err := k.Query(query)
	if err != nil {
		return nil, err
	}

	var tables []string
	for _, row := range data {
		schema, okSchema := row["schemaname"]
		name, okName := row["tablename"]
		if okSchema && okName {
			tables = append(tables, fmt.Sprintf("%v.%v", schema, name))
			continue
		}
		if val, ok := row["table_name"]; ok {
			tables = append(tables, fmt.Sprintf("%v", val))
		}
	}
	return tables, nil
}

func (k *KingbaseDB) GetCreateStatement(dbName, tableName string) (string, error) {
	// Kingbase doesn't have "SHOW CREATE TABLE".
	// We can try pg_dump logic or use a query to reconstruction.
	// A simple approach is just returning basic info or "Not Supported".
	// Or we can query information_schema to build it.
	return "SHOW CREATE TABLE not directly supported in Kingbase/Postgres via SQL", nil
}

func (k *KingbaseDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	// 解析 schema.table 格式
	schema := strings.TrimSpace(dbName)
	table := strings.TrimSpace(tableName)

	// 如果 tableName 包含 schema (格式: schema.table)
	if parts := strings.SplitN(table, ".", 2); len(parts) == 2 {
		parsedSchema := strings.TrimSpace(parts[0])
		parsedTable := strings.TrimSpace(parts[1])
		if parsedSchema != "" && parsedTable != "" {
			schema = parsedSchema
			table = parsedTable
		}
	}

	// 如果仍然没有 schema,使用 current_schema()
	// 这样可以自动匹配当前连接的 search_path
	if schema == "" {
		return k.getColumnsWithCurrentSchema(table)
	}

	if table == "" {
		return nil, fmt.Errorf("table name required")
	}

	// 转义函数:处理单引号,移除双引号
	esc := func(s string) string {
		// 移除前后的双引号(如果存在)
		s = strings.Trim(s, "\"")
		// 转义单引号
		return strings.ReplaceAll(s, "'", "''")
	}

	query := fmt.Sprintf(`SELECT column_name, data_type, is_nullable, column_default
		FROM information_schema.columns
		WHERE table_schema = '%s' AND table_name = '%s'
		ORDER BY ordinal_position`, esc(schema), esc(table))

	data, _, err := k.Query(query)
	if err != nil {
		return nil, err
	}

	var columns []connection.ColumnDefinition
	for _, row := range data {
		col := connection.ColumnDefinition{
			Name:     fmt.Sprintf("%v", row["column_name"]),
			Type:     fmt.Sprintf("%v", row["data_type"]),
			Nullable: fmt.Sprintf("%v", row["is_nullable"]),
		}

		if row["column_default"] != nil {
			def := fmt.Sprintf("%v", row["column_default"])
			col.Default = &def
		}

		columns = append(columns, col)
	}
	return columns, nil
}

// getColumnsWithCurrentSchema 使用 current_schema() 查询当前schema的表
func (k *KingbaseDB) getColumnsWithCurrentSchema(tableName string) ([]connection.ColumnDefinition, error) {
	table := strings.TrimSpace(tableName)
	if table == "" {
		return nil, fmt.Errorf("table name required")
	}

	// 转义函数
	esc := func(s string) string {
		s = strings.Trim(s, "\"")
		return strings.ReplaceAll(s, "'", "''")
	}

	// 使用 current_schema() 获取当前schema
	query := fmt.Sprintf(`SELECT column_name, data_type, is_nullable, column_default
		FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = '%s'
		ORDER BY ordinal_position`, esc(table))

	data, _, err := k.Query(query)
	if err != nil {
		return nil, err
	}

	var columns []connection.ColumnDefinition
	for _, row := range data {
		col := connection.ColumnDefinition{
			Name:     fmt.Sprintf("%v", row["column_name"]),
			Type:     fmt.Sprintf("%v", row["data_type"]),
			Nullable: fmt.Sprintf("%v", row["is_nullable"]),
		}

		if row["column_default"] != nil {
			def := fmt.Sprintf("%v", row["column_default"])
			col.Default = &def
		}

		columns = append(columns, col)
	}
	return columns, nil
}

func (k *KingbaseDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	// 解析 schema.table 格式
	schema := strings.TrimSpace(dbName)
	table := strings.TrimSpace(tableName)

	// 如果 tableName 包含 schema (格式: schema.table)
	if parts := strings.SplitN(table, ".", 2); len(parts) == 2 {
		parsedSchema := strings.TrimSpace(parts[0])
		parsedTable := strings.TrimSpace(parts[1])
		if parsedSchema != "" && parsedTable != "" {
			schema = parsedSchema
			table = parsedTable
		}
	}

	if table == "" {
		return nil, fmt.Errorf("table name required")
	}

	// 转义函数:处理单引号,移除双引号
	esc := func(s string) string {
		s = strings.Trim(s, "\"")
		return strings.ReplaceAll(s, "'", "''")
	}

	// 构建查询：如果没有指定schema,使用current_schema()
	var query string
	if schema != "" {
		query = fmt.Sprintf(`
			SELECT
				i.relname as index_name,
				a.attname as column_name,
				ix.indisunique as is_unique
			FROM
				pg_class t,
				pg_class i,
				pg_index ix,
				pg_attribute a,
				pg_namespace n
			WHERE
				t.oid = ix.indrelid
				AND i.oid = ix.indexrelid
				AND a.attrelid = t.oid
				AND a.attnum = ANY(ix.indkey)
				AND t.relkind = 'r'
				AND t.relname = '%s'
				AND n.oid = t.relnamespace
				AND n.nspname = '%s'
		`, esc(table), esc(schema))
	} else {
		query = fmt.Sprintf(`
			SELECT
				i.relname as index_name,
				a.attname as column_name,
				ix.indisunique as is_unique
			FROM
				pg_class t,
				pg_class i,
				pg_index ix,
				pg_attribute a,
				pg_namespace n
			WHERE
				t.oid = ix.indrelid
				AND i.oid = ix.indexrelid
				AND a.attrelid = t.oid
				AND a.attnum = ANY(ix.indkey)
				AND t.relkind = 'r'
				AND t.relname = '%s'
				AND n.oid = t.relnamespace
				AND n.nspname = current_schema()
		`, esc(table))
	}

	data, _, err := k.Query(query)
	if err != nil {
		return nil, err
	}

	var indexes []connection.IndexDefinition
	for _, row := range data {
		nonUnique := 1
		if val, ok := row["is_unique"]; ok {
			if b, ok := val.(bool); ok && b {
				nonUnique = 0
			}
		}

		idx := connection.IndexDefinition{
			Name:       fmt.Sprintf("%v", row["index_name"]),
			ColumnName: fmt.Sprintf("%v", row["column_name"]),
			NonUnique:  nonUnique,
			IndexType:  "BTREE", // Default
		}
		indexes = append(indexes, idx)
	}
	return indexes, nil
}

func (k *KingbaseDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	// 解析 schema.table 格式
	schema := strings.TrimSpace(dbName)
	table := strings.TrimSpace(tableName)

	// 如果 tableName 包含 schema (格式: schema.table)
	if parts := strings.SplitN(table, ".", 2); len(parts) == 2 {
		parsedSchema := strings.TrimSpace(parts[0])
		parsedTable := strings.TrimSpace(parts[1])
		if parsedSchema != "" && parsedTable != "" {
			schema = parsedSchema
			table = parsedTable
		}
	}

	if table == "" {
		return nil, fmt.Errorf("table name required")
	}

	// 转义函数:处理单引号,移除双引号
	esc := func(s string) string {
		s = strings.Trim(s, "\"")
		return strings.ReplaceAll(s, "'", "''")
	}

	// 构建查询：如果没有指定schema,使用current_schema()
	var query string
	if schema != "" {
		query = fmt.Sprintf(`
			SELECT
				tc.constraint_name,
				kcu.column_name,
				ccu.table_name AS foreign_table_name,
				ccu.column_name AS foreign_column_name
			FROM
				information_schema.table_constraints AS tc
				JOIN information_schema.key_column_usage AS kcu
				  ON tc.constraint_name = kcu.constraint_name
				  AND tc.table_schema = kcu.table_schema
				JOIN information_schema.constraint_column_usage AS ccu
				  ON ccu.constraint_name = tc.constraint_name
				  AND ccu.table_schema = tc.table_schema
			WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name='%s' AND tc.table_schema='%s'`,
			esc(table), esc(schema))
	} else {
		query = fmt.Sprintf(`
			SELECT
				tc.constraint_name,
				kcu.column_name,
				ccu.table_name AS foreign_table_name,
				ccu.column_name AS foreign_column_name
			FROM
				information_schema.table_constraints AS tc
				JOIN information_schema.key_column_usage AS kcu
				  ON tc.constraint_name = kcu.constraint_name
				  AND tc.table_schema = kcu.table_schema
				JOIN information_schema.constraint_column_usage AS ccu
				  ON ccu.constraint_name = tc.constraint_name
				  AND ccu.table_schema = tc.table_schema
			WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name='%s' AND tc.table_schema=current_schema()`,
			esc(table))
	}

	data, _, err := k.Query(query)
	if err != nil {
		return nil, err
	}

	var fks []connection.ForeignKeyDefinition
	for _, row := range data {
		fk := connection.ForeignKeyDefinition{
			Name:           fmt.Sprintf("%v", row["constraint_name"]),
			ColumnName:     fmt.Sprintf("%v", row["column_name"]),
			RefTableName:   fmt.Sprintf("%v", row["foreign_table_name"]),
			RefColumnName:  fmt.Sprintf("%v", row["foreign_column_name"]),
			ConstraintName: fmt.Sprintf("%v", row["constraint_name"]),
		}
		fks = append(fks, fk)
	}
	return fks, nil
}

func (k *KingbaseDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	// 解析 schema.table 格式
	schema := strings.TrimSpace(dbName)
	table := strings.TrimSpace(tableName)

	// 如果 tableName 包含 schema (格式: schema.table)
	if parts := strings.SplitN(table, ".", 2); len(parts) == 2 {
		parsedSchema := strings.TrimSpace(parts[0])
		parsedTable := strings.TrimSpace(parts[1])
		if parsedSchema != "" && parsedTable != "" {
			schema = parsedSchema
			table = parsedTable
		}
	}

	if table == "" {
		return nil, fmt.Errorf("table name required")
	}

	// 转义函数:处理单引号,移除双引号
	esc := func(s string) string {
		s = strings.Trim(s, "\"")
		return strings.ReplaceAll(s, "'", "''")
	}

	// 构建查询：如果指定了schema,也加上schema条件
	var query string
	if schema != "" {
		query = fmt.Sprintf(`SELECT trigger_name, action_timing, event_manipulation
			FROM information_schema.triggers
			WHERE event_object_table = '%s' AND event_object_schema = '%s'`,
			esc(table), esc(schema))
	} else {
		query = fmt.Sprintf(`SELECT trigger_name, action_timing, event_manipulation
			FROM information_schema.triggers
			WHERE event_object_table = '%s' AND event_object_schema = current_schema()`,
			esc(table))
	}

	data, _, err := k.Query(query)
	if err != nil {
		return nil, err
	}

	var triggers []connection.TriggerDefinition
	for _, row := range data {
		trig := connection.TriggerDefinition{
			Name:      fmt.Sprintf("%v", row["trigger_name"]),
			Timing:    fmt.Sprintf("%v", row["action_timing"]),
			Event:     fmt.Sprintf("%v", row["event_manipulation"]),
			Statement: "SOURCE HIDDEN",
		}
		triggers = append(triggers, trig)
	}
	return triggers, nil
}

func (k *KingbaseDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	if k.conn == nil {
		return fmt.Errorf("connection not open")
	}

	tx, err := k.conn.Begin()
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
			wheres = append(wheres, fmt.Sprintf("%s = $%d", quoteIdent(k), idx))
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

	// 2. Updates
	for _, update := range changes.Updates {
		var sets []string
		var args []interface{}
		idx := 0

		for k, v := range update.Values {
			idx++
			sets = append(sets, fmt.Sprintf("%s = $%d", quoteIdent(k), idx))
			args = append(args, v)
		}

		if len(sets) == 0 {
			continue
		}

		var wheres []string
		for k, v := range update.Keys {
			idx++
			wheres = append(wheres, fmt.Sprintf("%s = $%d", quoteIdent(k), idx))
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

	// 3. Inserts
	for _, row := range changes.Inserts {
		var cols []string
		var placeholders []string
		var args []interface{}
		idx := 0

		for k, v := range row {
			idx++
			cols = append(cols, quoteIdent(k))
			placeholders = append(placeholders, fmt.Sprintf("$%d", idx))
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

func (k *KingbaseDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	// dbName 在本项目语义里是“数据库”，schema 由 table_schema 决定；这里返回全部用户 schema 的列用于查询提示。
	query := `
		SELECT table_schema, table_name, column_name, data_type
		FROM information_schema.columns
		WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
		  AND table_schema NOT LIKE 'pg_%'
		ORDER BY table_schema, table_name, ordinal_position`

	data, _, err := k.Query(query)
	if err != nil {
		return nil, err
	}

	var cols []connection.ColumnDefinitionWithTable
	for _, row := range data {
		schema := fmt.Sprintf("%v", row["table_schema"])
		table := fmt.Sprintf("%v", row["table_name"])
		tableName := table
		if strings.TrimSpace(schema) != "" {
			tableName = fmt.Sprintf("%s.%s", schema, table)
		}
		col := connection.ColumnDefinitionWithTable{
			TableName: tableName,
			Name:      fmt.Sprintf("%v", row["column_name"]),
			Type:      fmt.Sprintf("%v", row["data_type"]),
		}
		cols = append(cols, col)
	}
	return cols, nil
}
