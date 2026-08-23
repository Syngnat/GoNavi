//go:build gonavi_full_drivers || gonavi_vastbase_driver

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

	_ "github.com/lib/pq" // Vastbase is PostgreSQL compatible
)

// VastbaseDB implements Database interface for Vastbase (海量) database
// Vastbase is a PostgreSQL-compatible database, so we reuse PostgreSQL driver
type VastbaseDB struct {
	conn        *sql.DB
	pingTimeout time.Duration
	forwarder   *ssh.LocalForwarder
}

func (v *VastbaseDB) getDSN(config connection.ConnectionConfig) string {
	dbname := config.Database
	if dbname == "" {
		dbname = "vastbase" // Vastbase default database
	}

	u := &url.URL{
		Scheme: "postgres",
		Host:   net.JoinHostPort(config.Host, strconv.Itoa(config.Port)),
		Path:   "/" + dbname,
	}
	u.User = url.UserPassword(config.User, config.Password)
	q := url.Values{}
	q.Set("sslmode", resolvePostgresSSLMode(config))
	applyPostgresSSLPathParams(q, config)
	q.Set("connect_timeout", strconv.Itoa(getConnectTimeoutSeconds(config)))
	mergeConnectionParamsFromConfigWithAllowlist(q, config, postgresConnectionParamNames, "postgres", "postgresql", "vastbase")
	u.RawQuery = q.Encode()

	return u.String()
}

func (v *VastbaseDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = v.Close()
	defer func() {
		if err != nil {
			_ = v.Close()
		}
	}()

	runConfig := config

	if config.UseSSH {
		logger.Infof("Vastbase 使用 SSH 连接：地址=%s:%d 用户=%s", config.Host, config.Port, config.User)

		forwarder, err := ssh.AcquireLocalForwarder(config.SSH, config.Host, config.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		v.forwarder = forwarder

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

		runConfig = localConfig
		logger.Infof("Vastbase 通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	}

	attempts := []connection.ConnectionConfig{runConfig}
	if shouldTrySSLPreferredFallback(runConfig) {
		attempts = append(attempts, withSSLDisabled(runConfig))
	}

	var failures []string
	for idx, attempt := range attempts {
		dsn := v.getDSN(attempt)
		db, err := sql.Open("postgres", dsn)
		if err != nil {
			failures = append(failures, fmt.Sprintf("第%d次连接打开失败: %v", idx+1, err))
			continue
		}
		configureSQLConnectionPool(db, "vastbase")
		v.conn = db
		v.pingTimeout = getConnectTimeout(attempt)
		if err := v.Ping(); err != nil {
			_ = db.Close()
			v.conn = nil
			failures = append(failures, fmt.Sprintf("第%d次连接验证失败: %v", idx+1, err))
			continue
		}
		if idx > 0 {
			logger.Warnf("Vastbase SSL 优先连接失败，已回退至明文连接")
		}
		return nil
	}
	return fmt.Errorf("连接建立后验证失败：%s", strings.Join(failures, "；"))
}

func (v *VastbaseDB) Close() error {
	if v.forwarder != nil {
		if err := v.forwarder.Release(); err != nil {
			logger.Warnf("关闭 Vastbase SSH 端口转发失败：%v", err)
		}
		v.forwarder = nil
	}

	if v.conn != nil {
		return v.conn.Close()
	}
	return nil
}

func (v *VastbaseDB) Ping() error {
	if v.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	timeout := v.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	return v.conn.PingContext(ctx)
}

func (v *VastbaseDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if v.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}

	rows, err := v.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	return scanRows(rows)
}

func (v *VastbaseDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if v.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}

	rows, err := v.conn.QueryContext(metadataContextFor(v), query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (v *VastbaseDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if v.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := v.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (v *VastbaseDB) ExecBatchContext(ctx context.Context, query string) (int64, error) {
	if v.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := v.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (v *VastbaseDB) OpenSessionExecer(ctx context.Context) (StatementExecer, error) {
	if v.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	conn, err := v.conn.Conn(ctx)
	if err != nil {
		return nil, err
	}
	return NewSQLConnStatementExecer(conn), nil
}

func (v *VastbaseDB) Exec(query string) (int64, error) {
	if v.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := v.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (v *VastbaseDB) GetDatabases() ([]string, error) {
	data, _, err := v.Query("SELECT datname FROM pg_database WHERE datistemplate = false")
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

func (v *VastbaseDB) GetTables(dbName string) ([]string, error) {
	query := buildPostgresLegacyTablesQuery()
	data, _, err := v.Query(query)
	if err != nil {
		return nil, err
	}
	return parsePostgresTableNames(data), nil
}

func (v *VastbaseDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return fmt.Sprintf("-- SHOW CREATE TABLE not fully supported for Vastbase in this version.\n-- Table: %s", tableName), nil
}

func (v *VastbaseDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	schema, table := normalizePGLikeMetadataTable(dbName, tableName)
	if table == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}

	data, _, err := v.Query(buildPGLikeColumnsMetadataQuery(schema, table))
	if err != nil {
		return nil, err
	}

	return buildPGLikeColumnDefinitions(data), nil
}

func (v *VastbaseDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	schema, table := normalizePGLikeMetadataTable(dbName, tableName)
	if table == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}

	data, _, err := v.Query(buildPGLikeIndexesMetadataQuery(schema, table))
	if err != nil {
		return nil, err
	}

	return buildPGLikeIndexDefinitions(data), nil
}

func (v *VastbaseDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	schema, table := normalizePGLikeMetadataTable(dbName, tableName)
	if table == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}

	data, _, err := v.Query(buildPGLikeForeignKeysMetadataQuery(schema, table))
	if err != nil {
		return nil, err
	}

	var fks []connection.ForeignKeyDefinition
	for _, row := range data {
		refSchema := ""
		if val, ok := row["foreign_table_schema"]; ok && val != nil {
			refSchema = fmt.Sprintf("%v", val)
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

func (v *VastbaseDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	schema, table := normalizePGLikeMetadataTable(dbName, tableName)
	if table == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}

	data, _, err := v.Query(buildPGLikeTriggersMetadataQuery(schema, table))
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

func (v *VastbaseDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	query := `
SELECT
	c.table_schema,
	c.table_name,
	c.column_name,
	c.data_type,
	col_description(cls.oid, a.attnum) AS comment
FROM information_schema.columns c
LEFT JOIN pg_namespace n ON n.nspname = c.table_schema
LEFT JOIN pg_class cls ON cls.relnamespace = n.oid AND cls.relname = c.table_name
LEFT JOIN pg_attribute a ON a.attrelid = cls.oid AND a.attname = c.column_name
WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
  AND c.table_schema NOT LIKE 'pg|_%' ESCAPE '|'
ORDER BY c.table_schema, c.table_name, c.ordinal_position`

	data, _, err := v.Query(query)
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
			Comment:   fmt.Sprintf("%v", row["comment"]),
		}
		cols = append(cols, col)
	}
	return cols, nil
}

func (v *VastbaseDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	if v.conn == nil {
		return fmt.Errorf("连接未打开")
	}

	tx, err := v.conn.Begin()
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
		for k, val := range pk {
			idx++
			wheres = append(wheres, fmt.Sprintf("%s = $%d", quoteIdent(k), idx))
			args = append(args, val)
		}
		if len(wheres) == 0 {
			continue
		}
		query := fmt.Sprintf("DELETE FROM %s WHERE %s", qualifiedTable, strings.Join(wheres, " AND "))
		if _, err := tx.Exec(query, args...); err != nil {
			return fmt.Errorf("删除失败：%v", err)
		}
	}

	// 2. Updates
	for _, update := range changes.Updates {
		var sets []string
		var args []interface{}
		idx := 0

		for k, val := range update.Values {
			idx++
			sets = append(sets, fmt.Sprintf("%s = $%d", quoteIdent(k), idx))
			args = append(args, val)
		}

		if len(sets) == 0 {
			continue
		}

		var wheres []string
		for k, val := range update.Keys {
			idx++
			wheres = append(wheres, fmt.Sprintf("%s = $%d", quoteIdent(k), idx))
			args = append(args, val)
		}

		if len(wheres) == 0 {
			return fmt.Errorf("更新操作需要主键条件")
		}

		query := fmt.Sprintf("UPDATE %s SET %s WHERE %s", qualifiedTable, strings.Join(sets, ", "), strings.Join(wheres, " AND "))
		if _, err := tx.Exec(query, args...); err != nil {
			return fmt.Errorf("更新失败：%v", err)
		}
	}

	if err := execParameterizedInsertBatches(parameterizedInsertConfig{
		Table:       qualifiedTable,
		Rows:        changes.Inserts,
		QuoteColumn: quoteIdent,
		Placeholder: func(idx int) string {
			return fmt.Sprintf("$%d", idx)
		},
		Exec: func(query string, args ...interface{}) (sql.Result, error) {
			return tx.Exec(query, args...)
		},
	}); err != nil {
		return err
	}

	return tx.Commit()
}
