package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
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

	"github.com/lib/pq"
)

type PostgresDB struct {
	conn        *sql.DB
	pingTimeout time.Duration
	forwarder   *ssh.LocalForwarder // Store SSH tunnel forwarder
}

var _ BatchApplierContext = (*PostgresDB)(nil)

var openPostgresDB = sql.Open

type postgresSessionExecer struct {
	*sqlConnStatementExecer
}

var _ QueryMessageExecer = (*PostgresDB)(nil)
var _ StatementQueryMessageExecer = (*postgresSessionExecer)(nil)

func resolvePostgresConnectDatabases(config connection.ConnectionConfig) []string {
	explicit := strings.TrimSpace(config.Database)
	if explicit != "" {
		return []string{explicit}
	}

	candidates := []string{"postgres", "template1", strings.TrimSpace(config.User)}
	seen := make(map[string]struct{}, len(candidates))
	result := make([]string, 0, len(candidates))
	for _, name := range candidates {
		trimmed := strings.TrimSpace(name)
		if trimmed == "" {
			continue
		}
		normalized := strings.ToLower(trimmed)
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, trimmed)
	}
	return result
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
	q.Set("sslmode", resolvePostgresSSLMode(config))
	applyPostgresSSLPathParams(q, config)
	q.Set("connect_timeout", strconv.Itoa(getConnectTimeoutSeconds(config)))
	mergeConnectionParamsFromConfigWithAllowlist(q, config, postgresConnectionParamNames, "postgres", "postgresql", "opengauss")
	u.RawQuery = q.Encode()

	return u.String()
}

func (p *PostgresDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = p.Close()
	defer func() {
		if err != nil {
			_ = p.Close()
		}
	}()

	if supported, reason := DriverRuntimeSupportStatus("postgres"); !supported {
		if strings.TrimSpace(reason) == "" {
			reason = localizedDriverRuntimeText("driver_manager.backend.status.optional_disabled", map[string]any{"name": "PostgreSQL"})
		}
		return fmt.Errorf("%s", reason)
	}

	runConfig := config
	p.pingTimeout = getConnectTimeout(config)

	if config.UseSSH {
		// Create SSH tunnel with local port forwarding
		logger.Infof("PostgreSQL 使用 SSH 连接：地址=%s:%d 用户=%s", config.Host, config.Port, config.User)

		forwarder, err := ssh.AcquireLocalForwarder(config.SSH, config.Host, config.Port)
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

		runConfig = localConfig
		logger.Infof("PostgreSQL 通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	}

	sslAttempts := []connection.ConnectionConfig{runConfig}
	if shouldTrySSLPreferredFallback(runConfig) {
		sslAttempts = append(sslAttempts, withSSLDisabled(runConfig))
	}

	var failures []string
	for sslIndex, sslConfig := range sslAttempts {
		sslLabel := "SSL"
		if sslIndex > 0 {
			sslLabel = "明文回退"
		}

		attemptDBs := resolvePostgresConnectDatabases(sslConfig)
		for _, dbName := range attemptDBs {
			attemptConfig := sslConfig
			attemptConfig.Database = dbName
			dsn := p.getDSN(attemptConfig)

			dbConn, err := openPostgresDB("postgres", dsn)
			if err != nil {
				failures = append(failures, fmt.Sprintf("%s 数据库=%s 打开连接失败: %v", sslLabel, dbName, err))
				continue
			}
			configureSQLConnectionPool(dbConn, "postgres")
			p.conn = dbConn

			// Force verification
			if err := p.Ping(); err != nil {
				failures = append(failures, fmt.Sprintf("%s 数据库=%s 验证失败: %v", sslLabel, dbName, err))
				_ = dbConn.Close()
				p.conn = nil
				continue
			}

			if sslIndex > 0 {
				logger.Warnf("PostgreSQL SSL 优先连接失败，已回退至明文连接")
			}
			if strings.TrimSpace(config.Database) == "" && !strings.EqualFold(dbName, "postgres") {
				logger.Infof("PostgreSQL 自动选择连接数据库：%s", dbName)
			}

			// search_path 必须在连接建立时写入 DSN，避免连接池中的连接配置不一致。
			if err := p.ensureSearchPath(dsn); err != nil {
				failures = append(failures, fmt.Sprintf("%s 数据库=%s 配置 search_path 失败: %v", sslLabel, dbName, err))
				if p.conn != nil {
					_ = p.conn.Close()
					p.conn = nil
				}
				continue
			}

			return nil
		}
	}

	if len(failures) == 0 {
		return fmt.Errorf("连接建立后验证失败：未找到可用的连接数据库")
	}
	return fmt.Errorf("连接建立后验证失败：%s", strings.Join(failures, "；"))
}

func (p *PostgresDB) Close() error {
	// Close SSH forwarder first if exists
	if p.forwarder != nil {
		if err := p.forwarder.Release(); err != nil {
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
		return fmt.Errorf("连接未打开")
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
		return nil, nil, fmt.Errorf("连接未打开")
	}

	rows, err := p.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	return scanRows(rows)
}

func (p *PostgresDB) QueryContextWithMessages(ctx context.Context, query string) ([]map[string]interface{}, []string, []string, error) {
	if p.conn == nil {
		return nil, nil, nil, fmt.Errorf("连接未打开")
	}

	conn, err := p.conn.Conn(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	defer conn.Close()

	return queryPostgresConnWithMessages(ctx, conn, query)
}

func (p *PostgresDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if p.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}

	rows, err := p.conn.QueryContext(metadataContextFor(p), query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (p *PostgresDB) QueryWithMessages(query string) ([]map[string]interface{}, []string, []string, error) {
	return p.QueryContextWithMessages(metadataContextFor(p), query)
}

func (p *PostgresDB) ExecBatchContext(ctx context.Context, query string) (int64, error) {
	if p.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := p.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (p *PostgresDB) OpenSessionExecer(ctx context.Context) (StatementExecer, error) {
	if p.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	conn, err := p.conn.Conn(ctx)
	if err != nil {
		return nil, err
	}
	return &postgresSessionExecer{sqlConnStatementExecer: &sqlConnStatementExecer{conn: conn}}, nil
}

func (p *PostgresDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if p.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := p.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (p *PostgresDB) Exec(query string) (int64, error) {
	if p.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := p.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (e *postgresSessionExecer) QueryWithMessages(query string) ([]map[string]interface{}, []string, []string, error) {
	return e.QueryContextWithMessages(context.Background(), query)
}

func (e *postgresSessionExecer) QueryContextWithMessages(ctx context.Context, query string) ([]map[string]interface{}, []string, []string, error) {
	if e == nil || e.conn == nil {
		return nil, nil, nil, fmt.Errorf("连接未打开")
	}
	return queryPostgresConnWithMessages(ctx, e.conn, query)
}

func queryPostgresConnWithMessages(ctx context.Context, conn *sql.Conn, query string) ([]map[string]interface{}, []string, []string, error) {
	return querySQLConnWithTextNotices(ctx, conn, query, setPostgresNoticeHandler)
}

// lib/pq's notice setter accepts only its private *pq.conn and panics for
// other PostgreSQL-compatible drivers. Message capture is optional, so a
// driver such as GaussDB's *stdlib.Conn must still be allowed to execute the
// query without a notice handler.
func setPostgresNoticeHandler(driverConn driver.Conn, addNotice func(string)) {
	defer func() {
		_ = recover()
	}()

	if addNotice == nil {
		pq.SetNoticeHandler(driverConn, nil)
		return
	}
	pq.SetNoticeHandler(driverConn, func(notice *pq.Error) {
		if notice != nil {
			addNotice(notice.Message)
		}
	})
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
	query := buildPostgresTablesQuery()
	data, _, err := p.Query(query)
	if err != nil {
		data, _, err = p.Query(buildPostgresLegacyTablesQuery())
		if err != nil {
			return nil, err
		}
	}

	tables := parsePostgresTableNames(data)
	return resolveShardingSphereLogicalTables(tables, p.Query), nil
}

func buildPostgresTablesQuery() string {
	return `
SELECT DISTINCT
	n.nspname AS schemaname,
	c.relname AS tablename
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname != 'information_schema'
  AND n.nspname NOT LIKE 'pg|_%' ESCAPE '|'
ORDER BY n.nspname, c.relname`
}

func buildPostgresLegacyTablesQuery() string {
	return "SELECT schemaname, tablename FROM pg_catalog.pg_tables WHERE schemaname != 'information_schema' AND schemaname NOT LIKE 'pg|_%' ESCAPE '|' ORDER BY schemaname, tablename"
}

func parsePostgresTableNames(data []map[string]interface{}) []string {
	tables := make([]string, 0, len(data))
	seen := make(map[string]struct{}, len(data))
	for _, row := range data {
		schema := getCaseInsensitiveRowString(row, "schemaname", "schema_name", "schema", "nspname")
		name := getCaseInsensitiveRowString(row, "tablename", "table_name", "relname", "name")
		if name == "" {
			continue
		}
		table := encodePGLikeQualifiedNamePart(name)
		if schema != "" {
			table = fmt.Sprintf("%s.%s", encodePGLikeQualifiedNamePart(schema), table)
		}
		// pg_catalog and information_schema return the identifier value itself;
		// a quote in relname is therefore data, not a transport wrapper. Use the
		// encoded qualified name as the fallback identity so legal names such as
		// `"orders"` cannot collapse into the ordinary `orders` table.
		key := table
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		tables = append(tables, table)
	}
	return tables
}

func encodePGLikeQualifiedNamePart(identifier string) string {
	if !strings.ContainsAny(identifier, `."`) {
		return identifier
	}
	return `"` + strings.ReplaceAll(identifier, `"`, `""`) + `"`
}

func (p *PostgresDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return fmt.Sprintf("-- SHOW CREATE TABLE not fully supported for PostgreSQL in this MVP.\n-- Table: %s", tableName), nil
}

func (p *PostgresDB) GetTableComment(dbName, tableName string) (string, error) {
	// TableCommentProvider receives already-separated logical identifier parts.
	// Do not reinterpret a dot inside tableName as a schema separator.
	schema, table := normalizePGLikeMetadataParts(dbName, tableName)
	if table == "" {
		return "", localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}

	data, _, err := p.Query(buildPGLikeTableCommentMetadataQuery(schema, table))
	if err != nil {
		return "", err
	}
	return parsePGLikeTableComment(data), nil
}

func (p *PostgresDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	schema, table := normalizePGLikeMetadataTable(dbName, tableName)
	if table == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}

	data, _, err := p.Query(buildPGLikeColumnsMetadataQuery(schema, table))
	if err != nil {
		return nil, err
	}

	return buildPGLikeColumnDefinitions(data), nil
}

func (p *PostgresDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	schema, table := normalizePGLikeMetadataTable(dbName, tableName)
	if table == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}

	data, _, err := p.Query(buildPGLikeIndexesMetadataQuery(schema, table))
	if err != nil {
		return nil, err
	}

	return buildPGLikeIndexDefinitions(data), nil
}

func (p *PostgresDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	schema, table := normalizePGLikeMetadataTable(dbName, tableName)
	if table == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}

	data, _, err := p.Query(buildPGLikeForeignKeysMetadataQuery(schema, table))
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
	schema, table := normalizePGLikeMetadataTable(dbName, tableName)
	if table == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}

	data, err := queryPGLikeTriggersMetadata(p, schema, table)
	if err != nil {
		return nil, err
	}

	var triggers []connection.TriggerDefinition
	for _, row := range data {
		trig := connection.TriggerDefinition{
			Name:        fmt.Sprintf("%v", row["trigger_name"]),
			Timing:      fmt.Sprintf("%v", row["action_timing"]),
			Event:       fmt.Sprintf("%v", row["event_manipulation"]),
			Statement:   fmt.Sprintf("%v", row["action_statement"]),
			Orientation: getPGLikeTriggerOrientation(row),
		}
		triggers = append(triggers, trig)
	}
	return triggers, nil
}

func (p *PostgresDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
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
			Comment:   fmt.Sprintf("%v", row["comment"]),
		}
		cols = append(cols, col)
	}
	return cols, nil
}

func postgresDSNHasExplicitSearchPath(dsn string) bool {
	u, err := url.Parse(dsn)
	if err != nil {
		return false
	}

	return strings.TrimSpace(u.Query().Get("search_path")) != ""
}

func postgresDSNWithSearchPath(baseDSN string, searchPath string) (string, error) {
	u, err := url.Parse(baseDSN)
	if err != nil {
		return "", fmt.Errorf("解析连接 DSN 失败: %w", err)
	}
	q := u.Query()
	q.Set("search_path", searchPath)
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// ensureSearchPath 查询当前数据库中所有用户 schema，通过重建连接池将 search_path 写入 DSN。
// 将 search_path 写入 DSN (lib/pq 支持任意 PostgreSQL runtime parameter)，
// 使连接池中每个连接建立时自动携带 search_path，与金仓行为一致。
func (p *PostgresDB) ensureSearchPath(baseDSN string) error {
	if p.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	if postgresDSNHasExplicitSearchPath(baseDSN) {
		return nil
	}

	rawSchemas, err := p.queryUserSchemas()
	if err != nil {
		return fmt.Errorf("查询用户 schema 失败：%w", err)
	}
	if len(rawSchemas) == 0 {
		return nil
	}

	searchPathSQL, _ := buildKingbaseSearchPathCommon(rawSchemas)
	if strings.TrimSpace(searchPathSQL) == "" {
		return nil
	}

	newDSN, err := postgresDSNWithSearchPath(baseDSN, searchPathSQL)
	if err != nil {
		return err
	}

	newDB, err := openPostgresDB("postgres", newDSN)
	if err != nil {
		return fmt.Errorf("打开带 search_path 的连接失败: %w", err)
	}
	configureSQLConnectionPool(newDB, "postgres")
	newDB.SetConnMaxLifetime(5 * time.Minute)
	oldConn := p.conn
	p.conn = newDB
	if err := p.Ping(); err != nil {
		_ = newDB.Close()
		p.conn = oldConn
		return fmt.Errorf("验证带 search_path 的连接失败: %w", err)
	}

	_ = oldConn.Close()
	logger.Infof("PostgreSQL 已通过 DSN 配置 search_path：%s", searchPathSQL)
	return nil
}

// queryUserSchemas 查询当前数据库中所有用户 schema。
func (p *PostgresDB) queryUserSchemas() ([]string, error) {
	if p.conn == nil {
		return nil, nil
	}

	query := `SELECT nspname FROM pg_namespace
		WHERE nspname NOT IN ('pg_catalog', 'information_schema')
		  AND nspname NOT LIKE 'pg|_%' ESCAPE '|'
		ORDER BY nspname`

	rows, err := p.conn.QueryContext(metadataContextFor(p), query)
	if err != nil {
		return nil, fmt.Errorf("查询用户 schema：%w", err)
	}
	defer rows.Close()

	var schemas []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("扫描用户 schema：%w", err)
		}
		name = strings.TrimSpace(name)
		if name != "" {
			schemas = append(schemas, name)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历用户 schema：%w", err)
	}
	return schemas, nil
}

func (p *PostgresDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return p.ApplyChangesContext(context.Background(), tableName, changes)
}

func (p *PostgresDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) (err error) {
	if p.conn == nil {
		return fmt.Errorf("连接未打开")
	}

	tx, err := p.conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	transactionCommitted := false
	defer func() { rollbackUnfinishedWriteTransaction(tx, transactionCommitted, &err) }()

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
		res, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("删除失败：%v", err)
		}
		if err := requireSingleRowAffected(res, rowMutationActionDelete); err != nil {
			return err
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
			return fmt.Errorf("更新操作需要主键条件")
		}

		query := fmt.Sprintf("UPDATE %s SET %s WHERE %s", qualifiedTable, strings.Join(sets, ", "), strings.Join(wheres, " AND "))
		res, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("更新失败：%v", err)
		}
		if err := requireSingleRowAffected(res, rowMutationActionUpdate); err != nil {
			return err
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
			return tx.ExecContext(ctx, query, args...)
		},
		EmptyInsertSQL: func(table string) string {
			return fmt.Sprintf("INSERT INTO %s DEFAULT VALUES", table)
		},
	}); err != nil {
		return err
	}

	if err := commitWriteTransaction(tx); err != nil {
		return err
	}
	transactionCommitted = true
	return nil
}
