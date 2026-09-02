//go:build gonavi_full_drivers || gonavi_kingbase_driver

package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"net"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/internal/utils"

	gokb "gitea.com/kingbase/gokb" // Registers "kingbase" driver
)

type KingbaseDB struct {
	conn        *sql.DB
	pingTimeout time.Duration
	forwarder   *ssh.LocalForwarder // Store SSH tunnel forwarder
}

type kingbaseSessionExecer struct {
	*sqlConnStatementExecer
}

var _ QueryMessageExecer = (*KingbaseDB)(nil)
var _ StatementQueryMessageExecer = (*kingbaseSessionExecer)(nil)
var _ DatabaseForeignKeyProvider = (*KingbaseDB)(nil)

var openKingbaseDB = sql.Open

// resolveKingbaseConnectDatabases returns databases that can be used to establish
// a connection. Kingbase follows PostgreSQL's default of using the login user as
// the database when no database is supplied, which is surprising for the UI's
// optional database field. Use known maintenance databases instead.
func resolveKingbaseConnectDatabases(config connection.ConnectionConfig) []string {
	params := url.Values{}
	mergeConnectionParamValuesWithAllowlist(params, connectionParamsFromURI(config.URI, "kingbase", "postgres", "postgresql"), kingbaseConnectionParamNames)
	mergeConnectionParamValuesWithAllowlist(params, connectionParamsFromText(config.ConnectionParams), kingbaseConnectionParamNames)

	explicit := strings.TrimSpace(config.Database)
	if explicit == "" {
		explicit = kingbaseDatabaseFromURI(config.URI)
	}
	if paramDatabase := strings.TrimSpace(firstConnectionParamValue(params, "dbname", "database")); paramDatabase != "" {
		explicit = paramDatabase
	}
	if explicit != "" {
		return []string{explicit}
	}

	return []string{"test", "template1"}
}

// kingbaseDatabaseFromURI extracts the PostgreSQL-compatible database path
// from a Kingbase URI. Explicit config.Database and query parameters have
// higher priority and are applied by the caller.
func kingbaseDatabaseFromURI(raw string) string {
	parsed, ok := parseConnectionURI(raw, "kingbase", "postgres", "postgresql")
	if !ok {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(parsed.Path, "/"))
}

func firstConnectionParamValue(params url.Values, keys ...string) string {
	for _, key := range keys {
		if values := params[key]; len(values) > 0 {
			return values[len(values)-1]
		}
	}
	return ""
}

func kingbaseConfigHasExplicitSearchPath(config connection.ConnectionConfig) bool {
	params := url.Values{}
	mergeConnectionParamValuesWithAllowlist(params, connectionParamsFromURI(config.URI, "kingbase", "postgres", "postgresql"), kingbaseConnectionParamNames)
	mergeConnectionParamValuesWithAllowlist(params, connectionParamsFromText(config.ConnectionParams), kingbaseConnectionParamNames)
	return strings.TrimSpace(params.Get("search_path")) != ""
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

	params := url.Values{}
	params.Set("host", config.Host)
	params.Set("port", strconv.Itoa(config.Port))
	params.Set("user", config.User)
	params.Set("password", config.Password)
	dbname := strings.TrimSpace(config.Database)
	if dbname == "" {
		dbname = kingbaseDatabaseFromURI(config.URI)
	}
	if dbname == "" {
		dbname = "test"
	}
	params.Set("dbname", dbname)
	params.Set("sslmode", resolvePostgresSSLMode(config))
	applyPostgresSSLPathParams(params, config)
	params.Set("connect_timeout", strconv.Itoa(getConnectTimeoutSeconds(config)))
	mergeConnectionParamsFromConfigWithAllowlist(params, config, kingbaseConnectionParamNames, "kingbase", "postgres", "postgresql")
	if strings.TrimSpace(params.Get("dbname")) == "" {
		params.Set("dbname", dbname)
	}

	preferred := []string{"host", "port", "user", "password", "dbname", "sslmode", "sslrootcert", "sslcert", "sslkey", "connect_timeout"}
	seen := make(map[string]struct{}, len(params))
	parts := make([]string, 0, len(params))
	for _, key := range preferred {
		if values, ok := params[key]; ok && len(values) > 0 {
			parts = append(parts, fmt.Sprintf("%s=%s", key, quoteConnValue(values[len(values)-1])))
			seen[key] = struct{}{}
		}
	}
	extraKeys := make([]string, 0, len(params))
	for key := range params {
		if _, ok := seen[key]; ok || !isSafeConnectionParamKey(key) {
			continue
		}
		extraKeys = append(extraKeys, key)
	}
	sort.Strings(extraKeys)
	for _, key := range extraKeys {
		values := params[key]
		if len(values) == 0 {
			continue
		}
		parts = append(parts, fmt.Sprintf("%s=%s", key, quoteConnValue(values[len(values)-1])))
	}

	return strings.Join(parts, " ")
}

func (k *KingbaseDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = k.Close()
	defer func() {
		if err != nil {
			_ = k.Close()
		}
	}()

	runConfig := config

	if config.UseSSH {
		// Create SSH tunnel with local port forwarding
		logger.Infof("人大金仓使用 SSH 连接：地址=%s:%d 用户=%s", config.Host, config.Port, config.User)

		forwarder, err := ssh.AcquireLocalForwarder(config.SSH, config.Host, config.Port)
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

		runConfig = localConfig
		logger.Infof("人大金仓通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	}

	attempts := []connection.ConnectionConfig{runConfig}
	if shouldTrySSLPreferredFallback(runConfig) {
		attempts = append(attempts, withSSLDisabled(runConfig))
	}

	var failures []string
	for sslIndex, sslConfig := range attempts {
		sslLabel := "SSL"
		if sslIndex > 0 {
			sslLabel = "明文回退"
		}

		for _, dbName := range resolveKingbaseConnectDatabases(sslConfig) {
			attempt := sslConfig
			attempt.Database = dbName
			dsn := k.getDSN(attempt)
			db, err := openKingbaseDB("kingbase", dsn)
			if err != nil {
				failures = append(failures, fmt.Sprintf("%s 数据库=%s 打开连接失败: %v", sslLabel, dbName, err))
				continue
			}
			configureSQLConnectionPool(db, "kingbase")
			k.conn = db
			k.pingTimeout = getConnectTimeout(attempt)
			if err := k.Ping(); err != nil {
				_ = db.Close()
				k.conn = nil
				failures = append(failures, fmt.Sprintf("%s 数据库=%s 验证失败: %v", sslLabel, dbName, err))
				continue
			}
			if sslIndex > 0 {
				logger.Warnf("人大金仓 SSL 优先连接失败，已回退至明文连接")
			}
			if strings.TrimSpace(config.Database) == "" {
				logger.Infof("人大金仓自动选择连接数据库：%s", dbName)
			}

			if err := k.ensureSearchPath(dsn, kingbaseConfigHasExplicitSearchPath(attempt)); err != nil {
				failures = append(failures, fmt.Sprintf("%s 数据库=%s 配置 search_path 失败: %v", sslLabel, dbName, err))
				if k.conn != nil {
					_ = k.conn.Close()
					k.conn = nil
				}
				continue
			}

			return nil
		}
	}
	return fmt.Errorf("连接建立后验证失败：%s", strings.Join(failures, "；"))
}

func (k *KingbaseDB) ensureSearchPath(baseDSN string, hasExplicitSearchPath bool) error {
	if k.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	if hasExplicitSearchPath {
		return nil
	}

	searchPath, err := k.getSearchPathStr()
	if err != nil {
		return err
	}
	if strings.TrimSpace(searchPath) == "" {
		return nil
	}

	newDB, err := openKingbaseDB("kingbase", baseDSN+" search_path="+quoteConnValue(searchPath))
	if err != nil {
		return fmt.Errorf("打开带 search_path 的连接失败: %w", err)
	}
	configureSQLConnectionPool(newDB, "kingbase")
	newDB.SetConnMaxLifetime(5 * time.Minute)
	oldConn := k.conn
	k.conn = newDB
	if err := k.Ping(); err != nil {
		_ = newDB.Close()
		k.conn = oldConn
		return fmt.Errorf("验证带 search_path 的连接失败: %w", err)
	}

	_ = oldConn.Close()
	logger.Infof("人大金仓已配置连接级 search_path：%s", searchPath)
	return nil
}

// getSearchPathStr 查询当前数据库中所有用户 schema，配置 DSN 的 search_path。
// KingBase 默认 search_path 为 "$user", public，对于自定义 schema 下的表不可见。
func (k *KingbaseDB) getSearchPathStr() (string, error) {
	if k.conn == nil {
		return "", nil
	}

	query := `SELECT nspname FROM pg_namespace
		WHERE nspname NOT IN ('pg_catalog', 'information_schema')
		  AND nspname NOT LIKE 'pg|_%' ESCAPE '|'
		ORDER BY nspname`

	rows, err := k.conn.QueryContext(metadataContextFor(k), query)
	if err != nil {
		return "", fmt.Errorf("查询用户 schema：%w", err)
	}
	defer rows.Close()

	var rawSchemas []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return "", fmt.Errorf("扫描用户 schema：%w", err)
		}
		name = strings.TrimSpace(name)
		if name != "" {
			rawSchemas = append(rawSchemas, name)
		}
	}
	if err := rows.Err(); err != nil {
		return "", fmt.Errorf("遍历用户 schema：%w", err)
	}

	searchPath, _ := buildKingbaseSearchPathCommon(rawSchemas)
	return searchPath, nil
}

func (k *KingbaseDB) Close() error {
	// Close SSH forwarder first if exists
	if k.forwarder != nil {
		if err := k.forwarder.Release(); err != nil {
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
		return fmt.Errorf("连接未打开")
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
		return nil, nil, fmt.Errorf("连接未打开")
	}

	rows, err := k.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	return scanRows(rows)
}

func (k *KingbaseDB) QueryContextWithMessages(ctx context.Context, query string) ([]map[string]interface{}, []string, []string, error) {
	if k.conn == nil {
		return nil, nil, nil, fmt.Errorf("连接未打开")
	}

	conn, err := k.conn.Conn(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	defer conn.Close()

	return queryKingbaseConnWithMessages(ctx, conn, query)
}

func (k *KingbaseDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if k.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}

	rows, err := k.conn.QueryContext(metadataContextFor(k), query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (k *KingbaseDB) QueryWithMessages(query string) ([]map[string]interface{}, []string, []string, error) {
	return k.QueryContextWithMessages(context.Background(), query)
}

func (k *KingbaseDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if k.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := k.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (k *KingbaseDB) ExecBatchContext(ctx context.Context, query string) (int64, error) {
	if k.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := k.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (k *KingbaseDB) OpenSessionExecer(ctx context.Context) (StatementExecer, error) {
	if k.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	conn, err := k.conn.Conn(ctx)
	if err != nil {
		return nil, err
	}
	return &kingbaseSessionExecer{sqlConnStatementExecer: &sqlConnStatementExecer{conn: conn}}, nil
}

func (k *KingbaseDB) Exec(query string) (int64, error) {
	if k.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := k.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (e *kingbaseSessionExecer) QueryWithMessages(query string) ([]map[string]interface{}, []string, []string, error) {
	return e.QueryContextWithMessages(context.Background(), query)
}

func (e *kingbaseSessionExecer) QueryContextWithMessages(ctx context.Context, query string) ([]map[string]interface{}, []string, []string, error) {
	if e == nil || e.conn == nil {
		return nil, nil, nil, fmt.Errorf("连接未打开")
	}
	return queryKingbaseConnWithMessages(ctx, e.conn, query)
}

func queryKingbaseConnWithMessages(ctx context.Context, conn *sql.Conn, query string) ([]map[string]interface{}, []string, []string, error) {
	return querySQLConnWithTextNotices(ctx, conn, query, func(driverConn driver.Conn, addNotice func(string)) {
		if addNotice == nil {
			gokb.SetNoticeHandler(driverConn, nil)
			return
		}
		gokb.SetNoticeHandler(driverConn, func(notice *gokb.Error) {
			if notice != nil {
				addNotice(notice.Message)
			}
		})
	})
}

func (k *KingbaseDB) GetDatabases() ([]string, error) {
	data, _, err := k.Query("SELECT datname FROM pg_database WHERE datistemplate = false")
	if err == nil {
		dbs := collectKingbaseNames(data, "datname", "database")
		if len(dbs) > 0 {
			return dbs, nil
		}
	}

	fallbackData, _, fallbackErr := k.Query("SELECT current_database() AS datname")
	if fallbackErr != nil {
		if err != nil {
			return nil, err
		}
		return nil, fallbackErr
	}

	dbs := collectKingbaseNames(fallbackData, "datname", "database", "current_database", "currentDatabase")
	if len(dbs) > 0 {
		return dbs, nil
	}

	if err != nil {
		return nil, err
	}
	return nil, fmt.Errorf("未获取到可见数据库列表")
}

func collectKingbaseNames(rows []map[string]interface{}, keys ...string) []string {
	result := make([]string, 0, len(rows))
	seen := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		name := strings.TrimSpace(getKingbaseNameFromRow(row, keys...))
		if name == "" {
			continue
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		result = append(result, name)
	}
	return result
}

func getKingbaseNameFromRow(row map[string]interface{}, keys ...string) string {
	if len(row) == 0 {
		return ""
	}
	for _, key := range keys {
		if value, ok := row[key]; ok {
			return fmt.Sprintf("%v", value)
		}
	}
	for existingKey, value := range row {
		for _, key := range keys {
			if strings.EqualFold(existingKey, key) {
				return fmt.Sprintf("%v", value)
			}
		}
	}
	for _, value := range row {
		return fmt.Sprintf("%v", value)
	}
	return ""
}

func (k *KingbaseDB) GetTables(dbName string) ([]string, error) {
	// Kingbase: tables are scoped by the current DB connection; include schema to avoid search_path issues.
	query := `
		SELECT DISTINCT table_schema AS schemaname, table_name AS tablename
		FROM information_schema.tables
		WHERE table_type = 'BASE TABLE'
		  AND table_schema NOT IN ('pg_catalog', 'information_schema')
		  AND table_schema NOT LIKE 'pg|_%' ESCAPE '|'
		ORDER BY table_schema, table_name`

	data, _, err := k.Query(query)
	if err != nil {
		return nil, err
	}

	return parsePostgresTableNames(data), nil
}

func (k *KingbaseDB) GetCreateStatement(dbName, tableName string) (string, error) {
	// Kingbase doesn't have "SHOW CREATE TABLE".
	// We can try pg_dump logic or use a query to reconstruction.
	// A simple approach is just returning basic info or "Not Supported".
	// Or we can query information_schema to build it.
	return "SHOW CREATE TABLE not directly supported in Kingbase/Postgres via SQL", nil
}

func (k *KingbaseDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	schema, table := normalizePGLikeMetadataTable(dbName, tableName)
	if table == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}

	data, _, err := k.Query(buildPGLikeColumnsMetadataQuery(schema, table))
	if err != nil {
		return nil, err
	}

	return buildPGLikeColumnDefinitions(data), nil
}

func (k *KingbaseDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	schema, table := normalizePGLikeMetadataTable(dbName, tableName)
	if table == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}

	data, _, err := k.Query(buildPGLikeIndexesMetadataQuery(schema, table))
	if err != nil {
		return nil, err
	}

	return buildPGLikeIndexDefinitions(data), nil
}

func (k *KingbaseDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	schema, table := normalizePGLikeMetadataTable(dbName, tableName)
	if table == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}

	data, _, err := k.Query(buildPGLikeForeignKeysMetadataQuery(schema, table))
	if err != nil {
		return nil, err
	}

	var fks []connection.ForeignKeyDefinition
	for _, row := range data {
		refSchema := strings.TrimSpace(fmt.Sprintf("%v", row["foreign_table_schema"]))
		refTable := fmt.Sprintf("%v", row["foreign_table_name"])
		if refSchema != "" {
			refTable = refSchema + "." + refTable
		}
		fk := connection.ForeignKeyDefinition{
			Name:           fmt.Sprintf("%v", row["constraint_name"]),
			ColumnName:     fmt.Sprintf("%v", row["column_name"]),
			RefTableName:   refTable,
			RefColumnName:  fmt.Sprintf("%v", row["foreign_column_name"]),
			ConstraintName: fmt.Sprintf("%v", row["constraint_name"]),
		}
		fks = append(fks, fk)
	}
	return fks, nil
}

func buildKingbaseDatabaseForeignKeysQuery() string {
	return `
		SELECT
			source_ns.nspname AS table_schema,
			source_table.relname AS table_name,
			con.conname AS constraint_name,
			source_column.attname AS column_name,
			target_ns.nspname AS foreign_table_schema,
			target_table.relname AS foreign_table_name,
			target_column.attname AS foreign_column_name
		FROM pg_catalog.pg_constraint AS con
		JOIN pg_catalog.pg_class AS source_table
		  ON source_table.oid = con.conrelid
		JOIN pg_catalog.pg_namespace AS source_ns
		  ON source_ns.oid = source_table.relnamespace
		JOIN pg_catalog.pg_class AS target_table
		  ON target_table.oid = con.confrelid
		JOIN pg_catalog.pg_namespace AS target_ns
		  ON target_ns.oid = target_table.relnamespace
		JOIN LATERAL pg_catalog.generate_subscripts(con.conkey, 1) AS key_position(position)
		  ON TRUE
		JOIN pg_catalog.pg_attribute AS source_column
		  ON source_column.attrelid = source_table.oid
		  AND source_column.attnum = con.conkey[key_position.position]
		JOIN pg_catalog.pg_attribute AS target_column
		  ON target_column.attrelid = target_table.oid
		  AND target_column.attnum = con.confkey[key_position.position]
		WHERE con.contype = 'f'
		  AND source_ns.nspname NOT IN ('pg_catalog', 'information_schema')
		  AND source_ns.nspname NOT LIKE 'pg|_%' ESCAPE '|'
		ORDER BY source_ns.nspname, source_table.relname, con.conname, key_position.position`
}

func buildKingbaseDatabaseForeignKeys(
	data []map[string]interface{},
) map[string][]connection.ForeignKeyDefinition {
	foreignKeysByTable := make(map[string][]connection.ForeignKeyDefinition)
	for _, row := range data {
		sourceSchema := strings.TrimSpace(fmt.Sprint(row["table_schema"]))
		sourceTable := strings.TrimSpace(fmt.Sprint(row["table_name"]))
		targetSchema := strings.TrimSpace(fmt.Sprint(row["foreign_table_schema"]))
		targetTable := strings.TrimSpace(fmt.Sprint(row["foreign_table_name"]))
		if sourceTable == "" || targetTable == "" {
			continue
		}

		sourceTableName := sourceTable
		if sourceSchema != "" {
			sourceTableName = sourceSchema + "." + sourceTable
		}
		targetTableName := targetTable
		if targetSchema != "" {
			targetTableName = targetSchema + "." + targetTable
		}
		constraintName := strings.TrimSpace(fmt.Sprint(row["constraint_name"]))
		foreignKeysByTable[sourceTableName] = append(
			foreignKeysByTable[sourceTableName],
			connection.ForeignKeyDefinition{
				Name:           constraintName,
				ColumnName:     strings.TrimSpace(fmt.Sprint(row["column_name"])),
				RefTableName:   targetTableName,
				RefColumnName:  strings.TrimSpace(fmt.Sprint(row["foreign_column_name"])),
				ConstraintName: constraintName,
			},
		)
	}
	return foreignKeysByTable
}

// GetDatabaseForeignKeys loads all user-schema foreign keys in one catalog
// query. The ER diagram uses this snapshot to avoid issuing one metadata query
// per table on large Kingbase schemas.
func (k *KingbaseDB) GetDatabaseForeignKeys(_ string) (map[string][]connection.ForeignKeyDefinition, error) {
	data, _, err := k.Query(buildKingbaseDatabaseForeignKeysQuery())
	if err != nil {
		return nil, err
	}
	return buildKingbaseDatabaseForeignKeys(data), nil
}

func (k *KingbaseDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	schema, table := normalizePGLikeMetadataTable(dbName, tableName)
	if table == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}

	data, _, err := k.Query(buildPGLikeTriggersMetadataQuery(schema, table))
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
		return fmt.Errorf("连接未打开")
	}

	tx, err := k.conn.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	schema, table := splitKingbaseQualifiedTable(tableName)
	if table == "" {
		return localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}

	qualifiedTable := ""
	if schema != "" {
		qualifiedTable = fmt.Sprintf("%s.%s", quoteKingbaseIdent(schema), quoteKingbaseIdent(table))
	} else {
		qualifiedTable = quoteKingbaseIdent(table)
	}

	// 1. Deletes
	for _, pk := range changes.Deletes {
		var wheres []string
		var args []interface{}
		idx := 0
		for k, v := range pk {
			idx++
			wheres = append(wheres, fmt.Sprintf("%s = $%d", quoteKingbaseIdent(k), idx))
			args = append(args, v)
		}
		if len(wheres) == 0 {
			continue
		}
		query := fmt.Sprintf("DELETE FROM %s WHERE %s", qualifiedTable, strings.Join(wheres, " AND "))
		if _, err := tx.Exec(query, args...); err != nil {
			return fmt.Errorf("delete error: %v; sql=%s", err, query)
		}
	}

	// 2. Updates
	for _, update := range changes.Updates {
		var sets []string
		var args []interface{}
		idx := 0

		for k, v := range update.Values {
			idx++
			sets = append(sets, fmt.Sprintf("%s = $%d", quoteKingbaseIdent(k), idx))
			args = append(args, v)
		}

		if len(sets) == 0 {
			continue
		}

		var wheres []string
		for k, v := range update.Keys {
			idx++
			wheres = append(wheres, fmt.Sprintf("%s = $%d", quoteKingbaseIdent(k), idx))
			args = append(args, v)
		}

		if len(wheres) == 0 {
			return fmt.Errorf("更新操作需要主键条件")
		}

		query := fmt.Sprintf("UPDATE %s SET %s WHERE %s", qualifiedTable, strings.Join(sets, ", "), strings.Join(wheres, " AND "))
		if _, err := tx.Exec(query, args...); err != nil {
			return fmt.Errorf("update error: %v; sql=%s", err, query)
		}
	}

	if err := execParameterizedInsertBatches(parameterizedInsertConfig{
		Table:       qualifiedTable,
		Rows:        changes.Inserts,
		QuoteColumn: quoteKingbaseIdent,
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

func splitKingbaseQualifiedTable(tableName string) (schema string, table string) {
	return splitKingbaseQualifiedNameCommon(tableName)
}

func (k *KingbaseDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	// dbName 在本项目语义里是“数据库”，schema 由 table_schema 决定；这里返回全部用户 schema 的列用于查询提示。
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
			Comment:   fmt.Sprintf("%v", row["comment"]),
		}
		cols = append(cols, col)
	}
	return cols, nil
}
