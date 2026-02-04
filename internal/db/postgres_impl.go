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

	_ "github.com/lib/pq"
)


type PostgresDB struct {
	conn        *sql.DB
	pingTimeout time.Duration
	forwarder   *ssh.LocalForwarder // Store SSH tunnel forwarder
}


func (p *PostgresDB) getDSN(config connection.ConnectionConfig) string {
	// postgres://user:password@host:port/dbname?sslmode=disable
	dbname := config.Database
	if dbname == "" {
		dbname = "postgres" // Default DB
	}

	u := &url.URL{
		Scheme: "postgres",
		Host:   net.JoinHostPort(config.Host, strconv.Itoa(config.Port)),
		Path:   "/" + dbname,
	}
	u.User = url.UserPassword(config.User, config.Password)
	q := url.Values{}
	q.Set("sslmode", "disable")
	q.Set("connect_timeout", strconv.Itoa(getConnectTimeoutSeconds(config)))
	u.RawQuery = q.Encode()

	return u.String()
}

func (p *PostgresDB) Connect(config connection.ConnectionConfig) error {
	var dsn string
	var err error

	if config.UseSSH {
		// Create SSH tunnel with local port forwarding
		logger.Infof("PostgreSQL 使用 SSH 连接：地址=%s:%d 用户=%s", config.Host, config.Port, config.User)

		forwarder, err := ssh.GetOrCreateLocalForwarder(config.SSH, config.Host, config.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		p.forwarder = forwarder

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
		localConfig.UseSSH = false // Disable SSH flag for DSN generation

		dsn = p.getDSN(localConfig)
		logger.Infof("PostgreSQL 通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	} else {
		dsn = p.getDSN(config)
	}

	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return fmt.Errorf("打开数据库连接失败：%w", err)
	}
	p.conn = db
	p.pingTimeout = getConnectTimeout(config)

	// Force verification
	if err := p.Ping(); err != nil {
		return fmt.Errorf("连接建立后验证失败：%w", err)
	}
	return nil
}


func (p *PostgresDB) Close() error {
	// Close SSH forwarder first if exists
	if p.forwarder != nil {
		if err := p.forwarder.Close(); err != nil {
			logger.Warnf("关闭 PostgreSQL SSH 端口转发失败：%v", err)
		}
		p.forwarder = nil
	}

	// Then close database connection
	if p.conn != nil {
		return p.conn.Close()
	}
	return nil
}

func (p *PostgresDB) Ping() error {
	if p.conn == nil {
		return fmt.Errorf("connection not open")
	}
	timeout := p.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	return p.conn.PingContext(ctx)
}

func (p *PostgresDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if p.conn == nil {
		return nil, nil, fmt.Errorf("connection not open")
	}

	rows, err := p.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	return scanRows(rows)
}

func (p *PostgresDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if p.conn == nil {
		return nil, nil, fmt.Errorf("connection not open")
	}

	rows, err := p.conn.Query(query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (p *PostgresDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if p.conn == nil {
		return 0, fmt.Errorf("connection not open")
	}
	res, err := p.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (p *PostgresDB) Exec(query string) (int64, error) {
	if p.conn == nil {
		return 0, fmt.Errorf("connection not open")
	}
	res, err := p.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (p *PostgresDB) GetDatabases() ([]string, error) {
	data, _, err := p.Query("SELECT datname FROM pg_database WHERE datistemplate = false")
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

func (p *PostgresDB) GetTables(dbName string) ([]string, error) {
	query := "SELECT schemaname, tablename FROM pg_catalog.pg_tables WHERE schemaname != 'information_schema' AND schemaname NOT LIKE 'pg_%' ORDER BY schemaname, tablename"
	data, _, err := p.Query(query)
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
		if okName {
			tables = append(tables, fmt.Sprintf("%v", name))
		}
	}
	return tables, nil
}

func (p *PostgresDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return fmt.Sprintf("-- SHOW CREATE TABLE not fully supported for PostgreSQL in this MVP.\n-- Table: %s", tableName), nil
}

func (p *PostgresDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	schema := strings.TrimSpace(dbName)
	if schema == "" {
		schema = "public"
	}
	table := strings.TrimSpace(tableName)
	if table == "" {
		return nil, fmt.Errorf("table name required")
	}

	esc := func(s string) string { return strings.ReplaceAll(s, "'", "''") }

	query := fmt.Sprintf(`
SELECT
	a.attname AS column_name,
	pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
	CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
	pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
	col_description(a.attrelid, a.attnum) AS comment,
	CASE WHEN pk.attname IS NOT NULL THEN 'PRI' ELSE '' END AS column_key
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid
LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
LEFT JOIN (
	SELECT i.indrelid, a3.attname
	FROM pg_index i
	JOIN pg_attribute a3 ON a3.attrelid = i.indrelid AND a3.attnum = ANY(i.indkey)
	WHERE i.indisprimary
) pk ON pk.indrelid = c.oid AND pk.attname = a.attname
WHERE c.relkind IN ('r', 'p')
  AND n.nspname = '%s'
  AND c.relname = '%s'
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY a.attnum`, esc(schema), esc(table))

	data, _, err := p.Query(query)
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
			Extra:    "",
			Comment:  "",
		}

		if v, ok := row["comment"]; ok && v != nil {
			col.Comment = fmt.Sprintf("%v", v)
		}

		if v, ok := row["column_default"]; ok && v != nil {
			def := fmt.Sprintf("%v", v)
			col.Default = &def
			if strings.HasPrefix(strings.ToLower(strings.TrimSpace(def)), "nextval(") {
				col.Extra = "auto_increment"
			}
		}

		columns = append(columns, col)
	}
	return columns, nil
}

func (p *PostgresDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	schema := strings.TrimSpace(dbName)
	if schema == "" {
		schema = "public"
	}
	table := strings.TrimSpace(tableName)
	if table == "" {
		return nil, fmt.Errorf("table name required")
	}

	esc := func(s string) string { return strings.ReplaceAll(s, "'", "''") }

	query := fmt.Sprintf(`
SELECT
	i.relname AS index_name,
	a.attname AS column_name,
	ix.indisunique AS is_unique,
	x.ordinality AS seq_in_index,
	am.amname AS index_type
FROM pg_class t
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_index ix ON t.oid = ix.indrelid
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_am am ON i.relam = am.oid
JOIN unnest(ix.indkey) WITH ORDINALITY AS x(attnum, ordinality) ON TRUE
JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum
WHERE t.relkind IN ('r', 'p')
  AND t.relname = '%s'
  AND n.nspname = '%s'
ORDER BY i.relname, x.ordinality`, esc(table), esc(schema))

	data, _, err := p.Query(query)
	if err != nil {
		return nil, err
	}

	parseBool := func(v interface{}) bool {
		switch val := v.(type) {
		case bool:
			return val
		case string:
			s := strings.ToLower(strings.TrimSpace(val))
			return s == "t" || s == "true" || s == "1" || s == "y" || s == "yes"
		default:
			s := strings.ToLower(strings.TrimSpace(fmt.Sprintf("%v", v)))
			return s == "t" || s == "true" || s == "1" || s == "y" || s == "yes"
		}
	}

	parseInt := func(v interface{}) int {
		switch val := v.(type) {
		case int:
			return val
		case int64:
			return int(val)
		case float64:
			return int(val)
		case string:
			// best effort
			var n int
			_, _ = fmt.Sscanf(strings.TrimSpace(val), "%d", &n)
			return n
		default:
			var n int
			_, _ = fmt.Sscanf(strings.TrimSpace(fmt.Sprintf("%v", v)), "%d", &n)
			return n
		}
	}

	var indexes []connection.IndexDefinition
	for _, row := range data {
		isUnique := false
		if v, ok := row["is_unique"]; ok && v != nil {
			isUnique = parseBool(v)
		}

		nonUnique := 1
		if isUnique {
			nonUnique = 0
		}

		seq := 0
		if v, ok := row["seq_in_index"]; ok && v != nil {
			seq = parseInt(v)
		}

		indexType := ""
		if v, ok := row["index_type"]; ok && v != nil {
			indexType = strings.ToUpper(fmt.Sprintf("%v", v))
		}
		if indexType == "" {
			indexType = "BTREE"
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

func (p *PostgresDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	schema := strings.TrimSpace(dbName)
	if schema == "" {
		schema = "public"
	}
	table := strings.TrimSpace(tableName)
	if table == "" {
		return nil, fmt.Errorf("table name required")
	}

	esc := func(s string) string { return strings.ReplaceAll(s, "'", "''") }

	query := fmt.Sprintf(`
SELECT
	tc.constraint_name AS constraint_name,
	kcu.column_name AS column_name,
	ccu.table_schema AS foreign_table_schema,
	ccu.table_name AS foreign_table_name,
	ccu.column_name AS foreign_column_name
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
  AND ccu.table_schema = tc.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_name = '%s'
  AND tc.table_schema = '%s'
ORDER BY tc.constraint_name, kcu.ordinal_position`, esc(table), esc(schema))

	data, _, err := p.Query(query)
	if err != nil {
		return nil, err
	}

	var fks []connection.ForeignKeyDefinition
	for _, row := range data {
		refSchema := ""
		if v, ok := row["foreign_table_schema"]; ok && v != nil {
			refSchema = fmt.Sprintf("%v", v)
		}
		refTable := fmt.Sprintf("%v", row["foreign_table_name"])
		refTableName := refTable
		if strings.TrimSpace(refSchema) != "" {
			refTableName = fmt.Sprintf("%s.%s", refSchema, refTable)
		}

		fk := connection.ForeignKeyDefinition{
			Name:           fmt.Sprintf("%v", row["constraint_name"]),
			ColumnName:     fmt.Sprintf("%v", row["column_name"]),
			RefTableName:   refTableName,
			RefColumnName:  fmt.Sprintf("%v", row["foreign_column_name"]),
			ConstraintName: fmt.Sprintf("%v", row["constraint_name"]),
		}
		fks = append(fks, fk)
	}
	return fks, nil
}

func (p *PostgresDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	schema := strings.TrimSpace(dbName)
	if schema == "" {
		schema = "public"
	}
	table := strings.TrimSpace(tableName)
	if table == "" {
		return nil, fmt.Errorf("table name required")
	}

	esc := func(s string) string { return strings.ReplaceAll(s, "'", "''") }

	query := fmt.Sprintf(`
SELECT trigger_name, action_timing, event_manipulation, action_statement
FROM information_schema.triggers
WHERE event_object_table = '%s'
  AND event_object_schema = '%s'
ORDER BY trigger_name, event_manipulation`, esc(table), esc(schema))

	data, _, err := p.Query(query)
	if err != nil {
		return nil, err
	}

	var triggers []connection.TriggerDefinition
	for _, row := range data {
		trig := connection.TriggerDefinition{
			Name:      fmt.Sprintf("%v", row["trigger_name"]),
			Timing:    fmt.Sprintf("%v", row["action_timing"]),
			Event:     fmt.Sprintf("%v", row["event_manipulation"]),
			Statement: fmt.Sprintf("%v", row["action_statement"]),
		}
		triggers = append(triggers, trig)
	}
	return triggers, nil
}

func (p *PostgresDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	query := `
SELECT table_schema, table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
  AND table_schema NOT LIKE 'pg_%'
ORDER BY table_schema, table_name, ordinal_position`

	data, _, err := p.Query(query)
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
