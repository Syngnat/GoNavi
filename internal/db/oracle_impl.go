package db

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/internal/utils"

	_ "github.com/sijms/go-ora/v2"
)

type OracleDB struct {
	conn        *sql.DB
	pingTimeout time.Duration
	forwarder   *ssh.LocalForwarder // Store SSH tunnel forwarder
	scanDialect string
}

var _ SessionExecerProvider = (*OracleDB)(nil)
var _ TransactionExecerProvider = (*OracleDB)(nil)
var _ StreamQueryExecer = (*OracleDB)(nil)

const oracleDefaultPrefetchRows = 25

var (
	oracleTriggerCreatePattern = regexp.MustCompile(`(?is)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\b`)
	oracleTriggerTimingPattern = regexp.MustCompile(`(?is)^\s*(?:BEFORE|AFTER|INSTEAD\s+OF)\b`)
	// DBMS_METADATA appends the enabled state as a separate statement; it is not part of the trigger definition.
	oracleTriggerEnableStatementPattern = regexp.MustCompile(`(?is)(?:\r?\n|;)\s*ALTER\s+TRIGGER\s+[^;]+?\s+ENABLE\s*;?\s*(?:/\s*)?$`)
)

func oracleRuntimeError(key string, params map[string]any) error {
	return fmt.Errorf("%s", localizedDriverRuntimeText(key, params))
}

// oracleConnectionSID 解析连接配置（ConnectionParams / URI）中的 SID 参数。
// SID 与 Service Name 是 Oracle 两种互斥的连接定位方式：go-ora 驱动在
// CONNECT_DATA 中优先使用 SID（configurations/connect_config.go），因此
// SID 模式只需把 SID 值放入 DSN 查询参数，Database（服务名）可留空。
func oracleConnectionSID(config connection.ConnectionConfig) string {
	values := url.Values{}
	mergeConnectionParamsFromConfigWithAllowlist(values, config, oracleConnectionParamNames, "oracle")
	return oracleQueryValue(values, "SID")
}

// isOracleSIDMode 报告连接是否以 SID 模式连接（存在 SID 参数时优先于服务名）。
func isOracleSIDMode(config connection.ConnectionConfig) bool {
	return oracleConnectionSID(config) != ""
}

func (o *OracleDB) getDSN(config connection.ConnectionConfig) string {
	// 服务名模式：oracle://user:pass@host:port/service_name
	// SID 模式：oracle://user:pass@host:port/?SID=sid（go-ora 驱动据此组装 (SID=...)）
	database := strings.TrimSpace(config.Database)
	sid := oracleConnectionSID(config)

	u := &url.URL{
		Scheme: "oracle",
		Host:   net.JoinHostPort(config.Host, strconv.Itoa(config.Port)),
	}
	if sid == "" {
		u.Path = "/" + database
		u.RawPath = "/" + url.PathEscape(database)
	}
	u.User = url.UserPassword(config.User, config.Password)
	q := url.Values{}
	switch normalizedSSLMode(config) {
	case sslModeRequired:
		q.Set("SSL", "TRUE")
		q.Set("SSL VERIFY", "TRUE")
	case sslModeSkipVerify, sslModePreferred:
		q.Set("SSL", "TRUE")
		q.Set("SSL VERIFY", "FALSE")
	}
	// Keep fetch batches bounded. go-ora materializes every LOB in a fetched batch,
	// so a large prefetch value can retain many BLOBs at once before rows are scanned.
	q.Set("PREFETCH_ROWS", strconv.Itoa(oracleDefaultPrefetchRows))
	// LOB 数据延迟加载，避免大 LOB 列影响普通查询性能
	q.Set("LOB FETCH", "POST")
	timeoutSeconds := strconv.Itoa(getConnectTimeoutSeconds(config))
	q.Set("CONNECT TIMEOUT", timeoutSeconds)
	q.Set("READ TIMEOUT", timeoutSeconds)
	mergeConnectionParamsFromConfigWithAllowlist(q, config, oracleConnectionParamNames, "oracle")
	if encoded := q.Encode(); encoded != "" {
		u.RawQuery = encoded
	}
	return u.String()
}

func oracleQueryValue(values url.Values, key string) string {
	return strings.TrimSpace(values.Get(key))
}

func oracleQueryValueOrDefault(values url.Values, key string) string {
	value := oracleQueryValue(values, key)
	if value == "" {
		return "未配置"
	}
	return value
}

func oracleDSNLogSummary(config connection.ConnectionConfig, dsn string) string {
	serviceName := strings.TrimSpace(config.Database)
	params := url.Values{}
	if parsed, err := url.Parse(dsn); err == nil && parsed != nil {
		if pathService, unescapeErr := url.PathUnescape(strings.TrimPrefix(parsed.EscapedPath(), "/")); unescapeErr == nil && strings.TrimSpace(pathService) != "" {
			serviceName = strings.TrimSpace(pathService)
		}
		params = parsed.Query()
	}
	sid := oracleQueryValue(params, "SID")
	mode := "服务名"
	targetLabel := "服务名"
	targetValue := serviceName
	if sid != "" {
		mode = "SID"
		targetLabel = "SID"
		targetValue = sid
	}
	if targetValue == "" {
		targetValue = "(未配置)"
	}
	return fmt.Sprintf("连接模式=%s %s=%s CONNECT_TIMEOUT=%s READ_TIMEOUT=%s SSL=%s SSL_VERIFY=%s AUTH_TYPE=%s DBA_PRIVILEGE=%s",
		mode,
		targetLabel,
		targetValue,
		oracleQueryValueOrDefault(params, "CONNECT TIMEOUT"),
		oracleQueryValueOrDefault(params, "READ TIMEOUT"),
		oracleQueryValueOrDefault(params, "SSL"),
		oracleQueryValueOrDefault(params, "SSL VERIFY"),
		oracleQueryValueOrDefault(params, "AUTH TYPE"),
		oracleQueryValueOrDefault(params, "DBA PRIVILEGE"),
	)
}

func annotateOracleValidationError(err error) error {
	if err == nil {
		return nil
	}
	message := strings.ToLower(err.Error())
	if !strings.Contains(message, "use of closed network connection") {
		return err
	}
	return fmt.Errorf("%w（Oracle 连接在验证阶段被服务端关闭或被驱动超时中断；请检查监听端口是否为 Oracle 协议端口、服务名（Service Name）或 SID 是否正确、认证参数如 DBA_PRIVILEGE/AUTH_TYPE 是否匹配）", err)
}

func (o *OracleDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = o.Close()
	defer func() {
		if err != nil {
			_ = o.Close()
		}
	}()

	runConfig := config
	serviceName := strings.TrimSpace(config.Database)
	sid := oracleConnectionSID(config)
	if serviceName == "" && sid == "" {
		return fmt.Errorf("Oracle 连接缺少服务名（Service Name）或 SID，请在连接配置中填写，例如 ORCLPDB1（服务名）或 ORCL（SID）")
	}

	if config.UseSSH {
		// Create SSH tunnel with local port forwarding
		logger.Infof("Oracle 使用 SSH 连接：地址=%s:%d 用户=%s", config.Host, config.Port, config.User)

		forwarder, err := ssh.AcquireLocalForwarder(config.SSH, config.Host, config.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		o.forwarder = forwarder

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
		logger.Infof("Oracle 通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	}

	attempts := []connection.ConnectionConfig{runConfig}
	if shouldTrySSLPreferredFallback(runConfig) {
		attempts = append(attempts, withSSLDisabled(runConfig))
	}

	var failures []string
	for idx, attempt := range attempts {
		dsn := o.getDSN(attempt)
		logger.Infof("Oracle 连接参数摘要：地址=%s:%d 用户=%s %s", attempt.Host, attempt.Port, attempt.User, oracleDSNLogSummary(attempt, dsn))
		db, err := sql.Open("oracle", dsn)
		if err != nil {
			failures = append(failures, fmt.Sprintf("第%d次连接打开失败: %v", idx+1, err))
			continue
		}
		configureSQLConnectionPool(db, "oracle")
		o.conn = db
		o.pingTimeout = getConnectTimeout(attempt)
		if err := o.Ping(); err != nil {
			_ = db.Close()
			o.conn = nil
			failures = append(failures, fmt.Sprintf("第%d次连接验证失败: %v", idx+1, annotateOracleValidationError(err)))
			continue
		}
		if idx > 0 {
			logger.Warnf("Oracle SSL 优先连接失败，已回退至明文连接")
		}
		return nil
	}
	return fmt.Errorf("连接建立后验证失败：%s", strings.Join(failures, "；"))
}

func (o *OracleDB) Close() error {
	// Close SSH forwarder first if exists
	if o.forwarder != nil {
		if err := o.forwarder.Release(); err != nil {
			logger.Warnf("关闭 Oracle SSH 端口转发失败：%v", err)
		}
		o.forwarder = nil
	}

	// Then close database connection
	if o.conn != nil {
		return o.conn.Close()
	}
	return nil
}

func (o *OracleDB) Ping() error {
	if o.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	timeout := o.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	return o.conn.PingContext(ctx)
}

func (o *OracleDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if o.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}

	rows, err := o.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	return scanRowsForDialect(rows, o.scanDialect)
}

func (o *OracleDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if o.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}

	rows, err := o.conn.Query(query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRowsForDialect(rows, o.scanDialect)
}

func (o *OracleDB) queryUnbounded(query string) ([]map[string]interface{}, []string, error) {
	if o.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}

	rows, err := o.conn.Query(query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRowsUnboundedForDialect(rows, o.scanDialect)
}

func (o *OracleDB) StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error {
	if o.conn == nil {
		return fmt.Errorf("连接未打开")
	}

	rows, err := o.conn.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	defer rows.Close()
	return streamRowsForDialect(rows, o.scanDialect, consumer)
}

func (o *OracleDB) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return o.StreamQueryContext(context.Background(), query, consumer)
}

func (o *OracleDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if o.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := o.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (o *OracleDB) Exec(query string) (int64, error) {
	if o.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := o.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (o *OracleDB) OpenTransactionExecer(ctx context.Context) (TransactionExecer, error) {
	if o.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	conn, err := o.conn.Conn(ctx)
	if err != nil {
		return nil, err
	}
	return NewSQLConnTransactionExecerWithDialect(conn, "COMMIT", "ROLLBACK", o.scanDialect), nil
}

func (o *OracleDB) OpenSessionExecer(ctx context.Context) (StatementExecer, error) {
	if o.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	conn, err := o.conn.Conn(ctx)
	if err != nil {
		return nil, err
	}
	return NewSQLConnStatementExecerWithDialect(conn, o.scanDialect), nil
}

func (o *OracleDB) GetDatabases() ([]string, error) {
	// Oracle treats Users/Schemas as "Databases" in this context
	data, _, err := o.Query("SELECT username FROM all_users ORDER BY username")
	if err != nil {
		return nil, err
	}
	var dbs []string
	for _, row := range data {
		if val, ok := row["USERNAME"]; ok {
			dbs = append(dbs, fmt.Sprintf("%v", val))
		}
	}
	return dbs, nil
}

func (o *OracleDB) GetTables(dbName string) ([]string, error) {
	// dbName is Schema/Owner
	// 始终返回 OWNER.TABLE_NAME，避免下游 SQL 缺少 schema 前缀导致 ORA-00942（refs issue #445）
	// 列别名用双引号包裹强制大写，避免不同驱动版本返回不一致 case 导致 row map 取值失败
	var query string
	if dbName != "" {
		query = fmt.Sprintf(`SELECT owner AS "OWNER", table_name AS "TABLE_NAME" FROM all_tables WHERE owner = '%s' ORDER BY table_name`, escapeOracleMetadataLiteral(dbName))
	} else {
		query = `SELECT USER AS "OWNER", table_name AS "TABLE_NAME" FROM user_tables ORDER BY table_name`
	}

	data, _, err := o.Query(query)
	if err != nil {
		return nil, err
	}

	var tables []string
	for _, row := range data {
		owner, okOwner := row["OWNER"]
		name, okName := row["TABLE_NAME"]
		if okOwner && okName && name != nil {
			tables = append(tables, fmt.Sprintf("%v.%v", owner, name))
			continue
		}
		if okName && name != nil {
			tables = append(tables, fmt.Sprintf("%v", name))
		}
	}
	return tables, nil
}

func (o *OracleDB) GetCreateStatement(dbName, tableName string) (string, error) {
	// Oracle provides DBMS_METADATA.GET_DDL
	// Note: LONG type might be tricky, but basic string scan should work for smaller DDLs
	var firstErr error
	for _, candidate := range oracleMetadataNamePairs(dbName, tableName) {
		metadataTableName := escapeOracleMetadataLiteralExact(candidate.table)
		metadataSchemaName := escapeOracleMetadataLiteralExact(candidate.schema)
		query := fmt.Sprintf("SELECT DBMS_METADATA.GET_DDL('TABLE', '%s', '%s') as ddl FROM DUAL",
			metadataTableName, metadataSchemaName)

		if candidate.schema == "" {
			query = fmt.Sprintf("SELECT DBMS_METADATA.GET_DDL('TABLE', '%s') as ddl FROM DUAL", metadataTableName)
		}

		data, _, err := o.queryUnbounded(query)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}

		if len(data) > 0 {
			if val, ok := data[0]["DDL"]; ok {
				ddl := strings.TrimSpace(fmt.Sprintf("%v", val))
				if ddl != "" {
					return o.appendOracleCommentDDL(ddl, candidate.schema, candidate.table), nil
				}
			}
		}
	}
	if firstErr != nil {
		return "", firstErr
	}
	return "", oracleRuntimeError("db.backend.error.create_table_statement_not_found", nil)
}

func (o *OracleDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	for _, candidate := range oracleMetadataNamePairs(dbName, tableName) {
		query := buildOracleColumnsQuery(candidate.schema, candidate.table)
		data, _, err := o.Query(query)
		if err != nil {
			return nil, err
		}
		if len(data) == 0 {
			continue
		}

		return parseOracleColumns(data), nil
	}
	for _, target := range o.lookupOracleSynonymTargets(dbName, tableName) {
		query := buildOracleColumnsQuery(target.schema, target.table)
		data, _, err := o.Query(query)
		if err != nil {
			return nil, err
		}
		if len(data) == 0 {
			continue
		}

		return parseOracleColumns(data), nil
	}
	if columns, err := o.inferOracleColumnsFromSelect(dbName, tableName); err == nil && len(columns) > 0 {
		return columns, nil
	}
	return []connection.ColumnDefinition{}, nil
}

func (o *OracleDB) inferOracleColumnsFromSelect(dbName string, tableName string) ([]connection.ColumnDefinition, error) {
	if o.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}

	var firstErr error
	for _, candidate := range oracleMetadataNamePairs(dbName, tableName) {
		query := "SELECT * FROM " + quoteOracleTableRef(candidate.schema, candidate.table) + " WHERE 1 = 0"
		rows, err := o.conn.Query(query)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		columns, parseErr := oracleColumnsFromSQLRows(rows)
		closeErr := rows.Close()
		if parseErr != nil {
			if firstErr == nil {
				firstErr = parseErr
			}
			continue
		}
		if closeErr != nil {
			if firstErr == nil {
				firstErr = closeErr
			}
			continue
		}
		if len(columns) > 0 {
			return columns, nil
		}
	}
	if firstErr != nil {
		return nil, firstErr
	}
	return nil, fmt.Errorf("未获取到字段定义")
}

func oracleColumnsFromSQLRows(rows *sql.Rows) ([]connection.ColumnDefinition, error) {
	names, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	colTypes, err := rows.ColumnTypes()
	if err != nil || len(colTypes) != len(names) {
		colTypes = nil
	}

	columns := make([]connection.ColumnDefinition, 0, len(names))
	for idx, name := range names {
		col := connection.ColumnDefinition{
			Name:     strings.TrimSpace(name),
			Nullable: "",
			Key:      "",
			Extra:    "",
			Comment:  "",
		}
		if colTypes != nil && idx < len(colTypes) && colTypes[idx] != nil {
			col.Type = formatOracleSQLColumnType(colTypes[idx])
			if nullable, ok := colTypes[idx].Nullable(); ok {
				if nullable {
					col.Nullable = "YES"
				} else {
					col.Nullable = "NO"
				}
			}
		}
		columns = append(columns, col)
	}
	return columns, nil
}

func formatOracleSQLColumnType(colType *sql.ColumnType) string {
	if colType == nil {
		return ""
	}
	typeName := strings.TrimSpace(colType.DatabaseTypeName())
	if typeName == "" {
		return ""
	}
	upperType := strings.ToUpper(typeName)
	if length, ok := colType.Length(); ok && length > 0 && strings.Contains(upperType, "CHAR") {
		return fmt.Sprintf("%s(%d)", typeName, length)
	}
	if precision, scale, ok := colType.DecimalSize(); ok && precision > 0 && (strings.Contains(upperType, "NUMBER") || strings.Contains(upperType, "DECIMAL") || strings.Contains(upperType, "NUMERIC")) {
		if scale > 0 {
			return fmt.Sprintf("%s(%d,%d)", typeName, precision, scale)
		}
		return fmt.Sprintf("%s(%d)", typeName, precision)
	}
	return typeName
}

func oracleRowValue(row map[string]interface{}, names ...string) interface{} {
	for _, name := range names {
		if value, ok := row[name]; ok {
			return value
		}
		for key, value := range row {
			if strings.EqualFold(key, name) {
				return value
			}
		}
	}
	return nil
}

func oracleRowString(row map[string]interface{}, names ...string) string {
	value := oracleRowValue(row, names...)
	if value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprintf("%v", value))
}

func oracleRowInt(row map[string]interface{}, names ...string) (int, bool) {
	raw := oracleRowString(row, names...)
	if raw == "" {
		return 0, false
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil {
		return 0, false
	}
	return parsed, true
}

func isOracleLengthQualifiedType(upperType string) bool {
	switch strings.TrimSpace(upperType) {
	case "CHAR", "NCHAR", "VARCHAR", "VARCHAR2", "NVARCHAR", "NVARCHAR2", "RAW", "BINARY", "VARBINARY":
		return true
	default:
		return strings.Contains(upperType, "CHARACTER")
	}
}

func formatOracleColumnType(row map[string]interface{}) string {
	dataType := oracleRowString(row, "DATA_TYPE")
	if dataType == "" || strings.Contains(dataType, "(") {
		return dataType
	}

	upperType := strings.ToUpper(dataType)
	if isOracleLengthQualifiedType(upperType) {
		if charLength, ok := oracleRowInt(row, "CHAR_LENGTH", "CHAR_COL_DECL_LENGTH"); ok && charLength > 0 {
			return fmt.Sprintf("%s(%d)", dataType, charLength)
		}
		if dataLength, ok := oracleRowInt(row, "DATA_LENGTH"); ok && dataLength > 0 {
			return fmt.Sprintf("%s(%d)", dataType, dataLength)
		}
	}

	if strings.Contains(upperType, "NUMBER") || strings.Contains(upperType, "DECIMAL") || strings.Contains(upperType, "NUMERIC") {
		precision, hasPrecision := oracleRowInt(row, "DATA_PRECISION", "NUMERIC_PRECISION")
		if hasPrecision && precision > 0 {
			scale, hasScale := oracleRowInt(row, "DATA_SCALE", "NUMERIC_SCALE")
			if hasScale && scale > 0 {
				return fmt.Sprintf("%s(%d,%d)", dataType, precision, scale)
			}
			return fmt.Sprintf("%s(%d)", dataType, precision)
		}
	}

	return dataType
}

func (o *OracleDB) appendOracleCommentDDL(baseDDL string, dbName string, tableName string) string {
	table := strings.TrimSpace(tableName)
	if strings.TrimSpace(baseDDL) == "" || table == "" {
		return baseDDL
	}

	schema := strings.TrimSpace(dbName)
	tableRef := quoteOracleDDLIdentifier(table)
	if schema != "" {
		tableRef = quoteOracleDDLIdentifier(schema) + "." + tableRef
	}
	existingDDLUpper := strings.ToUpper(baseDDL)
	commentLines := make([]string, 0, 4)

	if tableComment := strings.TrimSpace(o.fetchOracleTableComment(schema, table)); tableComment != "" {
		marker := "COMMENT ON TABLE " + strings.ToUpper(tableRef)
		if !strings.Contains(existingDDLUpper, marker) {
			commentLines = append(commentLines, fmt.Sprintf("COMMENT ON TABLE %s IS '%s';", tableRef, escapeOracleCommentLiteral(tableComment)))
		}
	}

	for _, colComment := range o.fetchOracleColumnComments(schema, table) {
		columnName := strings.TrimSpace(colComment.columnName)
		comment := strings.TrimSpace(colComment.comment)
		if columnName == "" || comment == "" {
			continue
		}
		columnRef := fmt.Sprintf("%s.%s", tableRef, quoteOracleDDLIdentifier(columnName))
		marker := "COMMENT ON COLUMN " + strings.ToUpper(columnRef)
		if strings.Contains(existingDDLUpper, marker) {
			continue
		}
		commentLines = append(commentLines, fmt.Sprintf("COMMENT ON COLUMN %s IS '%s';", columnRef, escapeOracleCommentLiteral(comment)))
	}

	if len(commentLines) == 0 {
		return baseDDL
	}
	return ensureOracleDDLStatementTerminator(baseDDL) + "\n\n" + strings.Join(commentLines, "\n")
}

func ensureOracleDDLStatementTerminator(ddl string) string {
	trimmed := strings.TrimRight(ddl, " \t\r\n")
	if trimmed == "" {
		return trimmed
	}
	if strings.HasSuffix(trimmed, ";") || strings.HasSuffix(trimmed, "/") {
		return trimmed
	}
	return trimmed + ";"
}

func (o *OracleDB) fetchOracleTableComment(schema string, table string) string {
	escapedTable := escapeOracleMetadataLiteralExact(table)
	var query string
	if strings.TrimSpace(schema) != "" {
		query = fmt.Sprintf(`SELECT comments AS "COMMENT" FROM all_tab_comments WHERE owner = '%s' AND table_name = '%s' AND comments IS NOT NULL`, escapeOracleMetadataLiteralExact(schema), escapedTable)
	} else {
		query = fmt.Sprintf(`SELECT comments AS "COMMENT" FROM user_tab_comments WHERE table_name = '%s' AND comments IS NOT NULL`, escapedTable)
	}
	data, _, err := o.Query(query)
	if err != nil || len(data) == 0 {
		return ""
	}
	return oracleRowString(data[0], "COMMENT", "COMMENTS")
}

type oracleColumnComment struct {
	columnName string
	comment    string
}

func (o *OracleDB) fetchOracleColumnComments(schema string, table string) []oracleColumnComment {
	escapedTable := escapeOracleMetadataLiteralExact(table)
	var query string
	if strings.TrimSpace(schema) != "" {
		query = fmt.Sprintf(`SELECT c.column_name AS "COLUMN_NAME", cc.comments AS "COMMENT"
FROM all_tab_columns c
JOIN all_col_comments cc
  ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
WHERE c.owner = '%s' AND c.table_name = '%s' AND cc.comments IS NOT NULL
ORDER BY c.column_id`, escapeOracleMetadataLiteralExact(schema), escapedTable)
	} else {
		query = fmt.Sprintf(`SELECT c.column_name AS "COLUMN_NAME", cc.comments AS "COMMENT"
FROM user_tab_columns c
JOIN user_col_comments cc
  ON cc.table_name = c.table_name AND cc.column_name = c.column_name
WHERE c.table_name = '%s' AND cc.comments IS NOT NULL
ORDER BY c.column_id`, escapedTable)
	}

	data, _, err := o.Query(query)
	if err != nil {
		return nil
	}
	comments := make([]oracleColumnComment, 0, len(data))
	for _, row := range data {
		comments = append(comments, oracleColumnComment{
			columnName: oracleRowString(row, "COLUMN_NAME"),
			comment:    oracleRowString(row, "COMMENT", "COMMENTS"),
		})
	}
	return comments
}

func quoteOracleDDLIdentifier(ident string) string {
	return `"` + strings.ReplaceAll(strings.TrimSpace(ident), `"`, `""`) + `"`
}

func quoteOracleTableRef(schema string, table string) string {
	tableRef := quoteOracleDDLIdentifier(table)
	if strings.TrimSpace(schema) != "" {
		return quoteOracleDDLIdentifier(schema) + "." + tableRef
	}
	return tableRef
}

func escapeOracleCommentLiteral(text string) string {
	return strings.ReplaceAll(text, "'", "''")
}

func escapeOracleMetadataLiteral(text string) string {
	return strings.ReplaceAll(strings.ToUpper(strings.TrimSpace(text)), "'", "''")
}

func escapeOracleMetadataLiteralExact(text string) string {
	return strings.ReplaceAll(strings.TrimSpace(text), "'", "''")
}

type oracleMetadataNamePair struct {
	schema string
	table  string
}

func oracleMetadataNamePairs(dbName string, tableName string) []oracleMetadataNamePair {
	rawSchema := strings.TrimSpace(dbName)
	rawTable := strings.TrimSpace(tableName)
	if rawTable == "" {
		return nil
	}

	upperSchema := strings.ToUpper(rawSchema)
	upperTable := strings.ToUpper(rawTable)
	pairs := make([]oracleMetadataNamePair, 0, 4)
	seen := map[string]struct{}{}
	add := func(schema string, table string) {
		key := schema + "\x00" + table
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		pairs = append(pairs, oracleMetadataNamePair{schema: schema, table: table})
	}

	add(rawSchema, rawTable)
	add(upperSchema, upperTable)
	add(rawSchema, upperTable)
	add(upperSchema, rawTable)
	return pairs
}

func (o *OracleDB) lookupOracleSynonymTargets(dbName string, tableName string) []oracleMetadataNamePair {
	targets := make([]oracleMetadataNamePair, 0, 4)
	seen := map[string]struct{}{}
	add := func(schema string, table string) {
		key := schema + "\x00" + table
		if strings.TrimSpace(table) == "" {
			return
		}
		if _, exists := seen[key]; exists {
			return
		}
		seen[key] = struct{}{}
		targets = append(targets, oracleMetadataNamePair{schema: schema, table: table})
	}

	for _, candidate := range oracleMetadataNamePairs(dbName, tableName) {
		data, _, err := o.Query(buildOracleSynonymLookupQuery(candidate.schema, candidate.table))
		if err != nil {
			continue
		}
		for _, row := range data {
			targetSchema := oracleRowString(row, "TABLE_OWNER", "table_owner")
			targetTable := oracleRowString(row, "TABLE_NAME", "table_name")
			for _, target := range oracleMetadataNamePairs(targetSchema, targetTable) {
				add(target.schema, target.table)
			}
			if strings.TrimSpace(targetTable) != "" {
				break
			}
		}
	}

	return targets
}

func buildOracleSynonymLookupQuery(schema string, table string) string {
	metadataTableName := escapeOracleMetadataLiteralExact(table)
	if strings.TrimSpace(schema) == "" {
		return fmt.Sprintf(`SELECT table_owner AS "TABLE_OWNER", table_name AS "TABLE_NAME"
FROM all_synonyms
WHERE synonym_name = '%s'
  AND db_link IS NULL
  AND (owner = USER OR owner = 'PUBLIC')
ORDER BY CASE WHEN owner = USER THEN 0 WHEN owner = 'PUBLIC' THEN 1 ELSE 2 END`, metadataTableName)
	}

	metadataSchemaName := escapeOracleMetadataLiteralExact(schema)
	return fmt.Sprintf(`SELECT table_owner AS "TABLE_OWNER", table_name AS "TABLE_NAME"
FROM all_synonyms
WHERE synonym_name = '%s'
  AND db_link IS NULL
  AND owner IN ('%s', 'PUBLIC')
ORDER BY CASE WHEN owner = '%s' THEN 0 WHEN owner = 'PUBLIC' THEN 1 ELSE 2 END`, metadataTableName, metadataSchemaName, metadataSchemaName)
}

func buildOracleColumnsQuery(schema string, table string) string {
	metadataTableName := escapeOracleMetadataLiteralExact(table)
	metadataSchemaName := escapeOracleMetadataLiteralExact(schema)
	if strings.TrimSpace(schema) == "" {
		return fmt.Sprintf(`SELECT c.column_name AS "COLUMN_NAME", c.data_type AS "DATA_TYPE", c.data_length AS "DATA_LENGTH", c.char_length AS "CHAR_LENGTH", c.data_precision AS "DATA_PRECISION", c.data_scale AS "DATA_SCALE", c.nullable AS "NULLABLE", c.data_default AS "DATA_DEFAULT",
			CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END AS "COLUMN_KEY",
			cc.comments AS "COMMENT"
			FROM user_tab_columns c
			LEFT JOIN user_col_comments cc
			  ON cc.table_name = c.table_name AND cc.column_name = c.column_name
			LEFT JOIN (
				SELECT cols.table_name, cols.column_name
				FROM user_constraints cons
				JOIN user_cons_columns cols USING (constraint_name)
				WHERE cons.constraint_type = 'P'
				  AND cons.table_name = '%s'
				  AND cols.table_name = '%s'
			) pk ON c.table_name = pk.table_name AND c.column_name = pk.column_name
			WHERE c.table_name = '%s'
			ORDER BY c.column_id`, metadataTableName, metadataTableName, metadataTableName)
	}

	return fmt.Sprintf(`SELECT c.column_name AS "COLUMN_NAME", c.data_type AS "DATA_TYPE", c.data_length AS "DATA_LENGTH", c.char_length AS "CHAR_LENGTH", c.data_precision AS "DATA_PRECISION", c.data_scale AS "DATA_SCALE", c.nullable AS "NULLABLE", c.data_default AS "DATA_DEFAULT",
		CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END AS "COLUMN_KEY",
		cc.comments AS "COMMENT"
		FROM all_tab_columns c
		LEFT JOIN all_col_comments cc
		  ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
		LEFT JOIN (
			SELECT cols.owner, cols.table_name, cols.column_name
			FROM all_constraints cons
			JOIN all_cons_columns cols
			  ON cons.owner = cols.owner AND cons.constraint_name = cols.constraint_name
			WHERE cons.constraint_type = 'P'
			  AND cons.owner = '%s'
			  AND cons.table_name = '%s'
			  AND cols.owner = '%s'
			  AND cols.table_name = '%s'
		) pk ON c.owner = pk.owner AND c.table_name = pk.table_name AND c.column_name = pk.column_name
		WHERE c.owner = '%s' AND c.table_name = '%s'
		ORDER BY c.column_id`, metadataSchemaName, metadataTableName, metadataSchemaName, metadataTableName, metadataSchemaName, metadataTableName)
}

func parseOracleColumns(data []map[string]interface{}) []connection.ColumnDefinition {
	columns := make([]connection.ColumnDefinition, 0, len(data))
	for _, row := range data {
		col := connection.ColumnDefinition{
			Name:     oracleRowString(row, "COLUMN_NAME"),
			Type:     formatOracleColumnType(row),
			Nullable: oracleRowString(row, "NULLABLE"),
			Key:      oracleRowString(row, "COLUMN_KEY"),
			Comment:  oracleRowString(row, "COMMENT"),
		}

		if defaultValue := oracleRowValue(row, "DATA_DEFAULT"); defaultValue != nil {
			d := fmt.Sprintf("%v", defaultValue)
			col.Default = &d
		}

		columns = append(columns, col)
	}
	return columns
}

func (o *OracleDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	if strings.TrimSpace(tableName) == "" {
		return nil, oracleRuntimeError("db.backend.error.table_name_required", nil)
	}

	for _, candidate := range oracleMetadataNamePairs(dbName, tableName) {
		data, _, err := o.Query(buildOracleIndexesQuery(candidate.schema, candidate.table))
		if err != nil {
			return nil, err
		}
		if len(data) == 0 {
			continue
		}
		return parseOracleIndexes(data), nil
	}
	return []connection.IndexDefinition{}, nil
}

func buildOracleIndexesQuery(schema string, table string) string {
	metadataTableName := escapeOracleMetadataLiteralExact(table)
	metadataSchemaName := escapeOracleMetadataLiteralExact(schema)
	if strings.TrimSpace(schema) == "" {
		return fmt.Sprintf(`SELECT c.index_name, c.column_name, i.uniqueness, c.column_position, i.index_type
			FROM user_ind_columns c
			JOIN user_indexes i ON i.index_name = c.index_name
			WHERE c.table_name = '%s'
			  AND c.column_name IS NOT NULL
			  AND c.column_name NOT LIKE 'SYS_NC%%$'
			  AND i.index_type NOT LIKE 'FUNCTION-BASED%%'
			ORDER BY c.index_name, c.column_position`, metadataTableName)
	}
	return fmt.Sprintf(`SELECT c.index_name, c.column_name, i.uniqueness, c.column_position, i.index_type
		FROM all_ind_columns c
		JOIN all_indexes i ON i.owner = c.index_owner AND i.index_name = c.index_name
		WHERE c.table_owner = '%s'
		  AND c.table_name = '%s'
		  AND c.column_name IS NOT NULL
		  AND c.column_name NOT LIKE 'SYS_NC%%$'
		  AND i.index_type NOT LIKE 'FUNCTION-BASED%%'
		ORDER BY c.index_name, c.column_position`, metadataSchemaName, metadataTableName)
}

func parseOracleIndexes(data []map[string]interface{}) []connection.IndexDefinition {
	getValue := func(row map[string]interface{}, names ...string) interface{} {
		for _, name := range names {
			if value, ok := row[name]; ok {
				return value
			}
			for key, value := range row {
				if strings.EqualFold(key, name) {
					return value
				}
			}
		}
		return nil
	}
	parseInt := func(value interface{}) int {
		var n int
		_, _ = fmt.Sscanf(strings.TrimSpace(fmt.Sprintf("%v", value)), "%d", &n)
		return n
	}

	var indexes []connection.IndexDefinition
	for _, row := range data {
		uniqueness := strings.ToUpper(strings.TrimSpace(fmt.Sprintf("%v", getValue(row, "UNIQUENESS"))))
		nonUnique := 1
		if uniqueness == "UNIQUE" {
			nonUnique = 0
		}
		indexType := strings.ToUpper(strings.TrimSpace(fmt.Sprintf("%v", getValue(row, "INDEX_TYPE"))))
		if indexType == "" || indexType == "<NIL>" {
			indexType = "BTREE"
		}

		idx := connection.IndexDefinition{
			Name:       strings.TrimSpace(fmt.Sprintf("%v", getValue(row, "INDEX_NAME"))),
			ColumnName: strings.TrimSpace(fmt.Sprintf("%v", getValue(row, "COLUMN_NAME"))),
			NonUnique:  nonUnique,
			SeqInIndex: parseInt(getValue(row, "COLUMN_POSITION")),
			IndexType:  indexType,
		}
		if idx.Name == "" || idx.ColumnName == "" || strings.EqualFold(idx.ColumnName, "<nil>") {
			continue
		}
		indexes = append(indexes, idx)
	}
	return indexes
}

func (o *OracleDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	for _, candidate := range oracleMetadataNamePairs(dbName, tableName) {
		data, _, err := o.Query(buildOracleForeignKeysQuery(candidate.schema, candidate.table))
		if err != nil {
			return nil, err
		}
		if len(data) == 0 {
			continue
		}
		return parseOracleForeignKeys(data), nil
	}
	return []connection.ForeignKeyDefinition{}, nil
}

func buildOracleForeignKeysQuery(schema string, table string) string {
	metadataTableName := escapeOracleMetadataLiteralExact(table)
	metadataSchemaName := escapeOracleMetadataLiteralExact(schema)
	if strings.TrimSpace(schema) == "" {
		return fmt.Sprintf(`SELECT a.constraint_name, a.column_name, c_pk.table_name r_table_name, b.column_name r_column_name
		FROM (
			SELECT constraint_name, table_name, column_name, position
			FROM user_cons_columns
			WHERE table_name = '%s'
		) a
		JOIN user_constraints c ON a.constraint_name = c.constraint_name
		JOIN user_constraints c_pk ON c.r_constraint_name = c_pk.constraint_name
		JOIN user_cons_columns b ON c_pk.constraint_name = b.constraint_name AND a.position = b.position
		WHERE c.constraint_type = 'R' AND c.table_name = '%s'`, metadataTableName, metadataTableName)
	}
	return fmt.Sprintf(`SELECT a.constraint_name, a.column_name, c_pk.table_name r_table_name, b.column_name r_column_name
		FROM (
			SELECT owner, constraint_name, table_name, column_name, position
			FROM all_cons_columns
			WHERE owner = '%s' AND table_name = '%s'
		) a
		JOIN all_constraints c ON a.owner = c.owner AND a.constraint_name = c.constraint_name
		JOIN all_constraints c_pk ON c.r_owner = c_pk.owner AND c.r_constraint_name = c_pk.constraint_name
		JOIN all_cons_columns b ON c_pk.owner = b.owner AND c_pk.constraint_name = b.constraint_name AND a.position = b.position
		WHERE c.constraint_type = 'R' AND c.owner = '%s' AND c.table_name = '%s'`,
		metadataSchemaName, metadataTableName, metadataSchemaName, metadataTableName)
}

func parseOracleForeignKeys(data []map[string]interface{}) []connection.ForeignKeyDefinition {
	var fks []connection.ForeignKeyDefinition
	for _, row := range data {
		fk := connection.ForeignKeyDefinition{
			Name:           fmt.Sprintf("%v", row["CONSTRAINT_NAME"]),
			ColumnName:     fmt.Sprintf("%v", row["COLUMN_NAME"]),
			RefTableName:   fmt.Sprintf("%v", row["R_TABLE_NAME"]),
			RefColumnName:  fmt.Sprintf("%v", row["R_COLUMN_NAME"]),
			ConstraintName: fmt.Sprintf("%v", row["CONSTRAINT_NAME"]),
		}
		fks = append(fks, fk)
	}
	return fks
}

func (o *OracleDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	for _, candidate := range oracleMetadataNamePairs(dbName, tableName) {
		data, _, err := o.queryUnbounded(buildOracleTriggersQuery(candidate.schema, candidate.table))
		if err != nil {
			return nil, err
		}
		if len(data) == 0 {
			continue
		}
		return o.parseOracleTriggers(data), nil
	}
	return []connection.TriggerDefinition{}, nil
}

func buildOracleTriggersQuery(schema string, table string) string {
	metadataTableName := escapeOracleMetadataLiteralExact(table)
	metadataSchemaName := escapeOracleMetadataLiteralExact(schema)
	if strings.TrimSpace(schema) == "" {
		return fmt.Sprintf(`SELECT USER AS "OWNER", USER AS "TABLE_OWNER", table_name AS "TABLE_NAME", trigger_name AS "TRIGGER_NAME", trigger_type AS "TRIGGER_TYPE", triggering_event AS "TRIGGERING_EVENT", when_clause AS "WHEN_CLAUSE", trigger_body AS "TRIGGER_BODY"
		FROM user_triggers
		WHERE table_name = '%s'
		ORDER BY trigger_name`, metadataTableName)
	}
	return fmt.Sprintf(`SELECT owner AS "OWNER", table_owner AS "TABLE_OWNER", table_name AS "TABLE_NAME", trigger_name AS "TRIGGER_NAME", trigger_type AS "TRIGGER_TYPE", triggering_event AS "TRIGGERING_EVENT", when_clause AS "WHEN_CLAUSE", trigger_body AS "TRIGGER_BODY"
		FROM all_triggers
		WHERE table_owner = '%s' AND table_name = '%s'
		ORDER BY owner, trigger_name`,
		metadataSchemaName, metadataTableName)
}

func (o *OracleDB) parseOracleTriggers(data []map[string]interface{}) []connection.TriggerDefinition {
	var triggers []connection.TriggerDefinition
	for _, row := range data {
		owner := oracleRowString(row, "OWNER")
		triggerName := oracleRowString(row, "TRIGGER_NAME")
		statement := strings.TrimSpace(o.fetchOracleTriggerDDL(owner, triggerName))
		if statement == "" {
			statement = buildOracleTriggerDDLFromMetadata(row)
		}

		trig := connection.TriggerDefinition{
			Name:      triggerName,
			Timing:    oracleRowString(row, "TRIGGER_TYPE"),
			Event:     oracleRowString(row, "TRIGGERING_EVENT"),
			Statement: statement,
		}
		triggers = append(triggers, trig)
	}
	return triggers
}

func (o *OracleDB) fetchOracleTriggerDDL(owner string, triggerName string) string {
	if strings.TrimSpace(triggerName) == "" {
		return ""
	}
	for _, candidate := range oracleMetadataNamePairs(owner, triggerName) {
		metadataTriggerName := escapeOracleMetadataLiteralExact(candidate.table)
		metadataOwnerName := escapeOracleMetadataLiteralExact(candidate.schema)
		query := fmt.Sprintf("SELECT DBMS_METADATA.GET_DDL('TRIGGER', '%s', '%s') as ddl FROM DUAL",
			metadataTriggerName, metadataOwnerName)
		if candidate.schema == "" {
			query = fmt.Sprintf("SELECT DBMS_METADATA.GET_DDL('TRIGGER', '%s') as ddl FROM DUAL", metadataTriggerName)
		}

		data, _, err := o.queryUnbounded(query)
		if err != nil || len(data) == 0 {
			continue
		}
		ddl := oracleRowString(data[0], "DDL", "ddl", "TRIGGER_DEFINITION", "trigger_definition")
		if ddl != "" {
			return ensureOracleDDLStatementTerminator(stripOracleTriggerEnableStatement(ddl))
		}
	}
	return ""
}

func stripOracleTriggerEnableStatement(ddl string) string {
	trimmed := strings.TrimRight(ddl, " \t\r\n")
	match := oracleTriggerEnableStatementPattern.FindStringIndex(trimmed)
	if match == nil || match[1] != len(trimmed) {
		return trimmed
	}
	return strings.TrimRight(trimmed[:match[0]], " \t\r\n")
}

func buildOracleTriggerDDLFromMetadata(row map[string]interface{}) string {
	body := strings.TrimSpace(oracleRowString(row, "TRIGGER_BODY"))
	if body == "" || strings.EqualFold(body, "SOURCE HIDDEN") {
		return ""
	}

	if startsWithOracleTriggerCreate(body) {
		return ensureOracleDDLStatementTerminator(body)
	}

	triggerName := oracleRowString(row, "TRIGGER_NAME")
	if triggerName == "" {
		return ""
	}

	if strings.HasPrefix(strings.ToUpper(body), "TRIGGER ") {
		return ensureOracleDDLStatementTerminator("CREATE OR REPLACE " + body)
	}

	triggerOwner := oracleRowString(row, "OWNER")
	tableOwner := oracleRowString(row, "TABLE_OWNER")
	tableName := oracleRowString(row, "TABLE_NAME")
	triggerRef := quoteOracleTableRef(triggerOwner, triggerName)

	if startsWithOracleTriggerTiming(body) {
		return ensureOracleDDLStatementTerminator(fmt.Sprintf("CREATE OR REPLACE TRIGGER %s\n%s", triggerRef, body))
	}

	triggerClause := buildOracleTriggerClause(
		oracleRowString(row, "TRIGGER_TYPE"),
		oracleRowString(row, "TRIGGERING_EVENT"),
		oracleTriggerTableRef(tableOwner, tableName),
	)
	if triggerClause == "" {
		return ""
	}

	lines := []string{
		fmt.Sprintf("CREATE OR REPLACE TRIGGER %s", triggerRef),
		triggerClause,
	}
	if shouldAppendOracleForEachRow(oracleRowString(row, "TRIGGER_TYPE")) {
		lines = append(lines, "FOR EACH ROW")
	}
	if whenClause := normalizeOracleTriggerWhenClause(oracleRowString(row, "WHEN_CLAUSE")); whenClause != "" {
		lines = append(lines, whenClause)
	}
	lines = append(lines, body)
	return ensureOracleDDLStatementTerminator(strings.Join(lines, "\n"))
}

func startsWithOracleTriggerCreate(sql string) bool {
	return oracleTriggerCreatePattern.MatchString(sql)
}

func startsWithOracleTriggerTiming(sql string) bool {
	return oracleTriggerTimingPattern.MatchString(sql)
}

func oracleTriggerTableRef(tableOwner string, tableName string) string {
	if strings.TrimSpace(tableName) == "" {
		return ""
	}
	return quoteOracleTableRef(tableOwner, tableName)
}

func buildOracleTriggerClause(triggerType string, event string, tableRef string) string {
	normalizedType := strings.ToUpper(strings.TrimSpace(triggerType))
	normalizedEvent := strings.TrimSpace(event)
	if tableRef == "" || normalizedEvent == "" {
		return ""
	}

	switch {
	case strings.HasPrefix(normalizedType, "BEFORE"):
		return fmt.Sprintf("BEFORE %s ON %s", normalizedEvent, tableRef)
	case strings.HasPrefix(normalizedType, "AFTER"):
		return fmt.Sprintf("AFTER %s ON %s", normalizedEvent, tableRef)
	case strings.HasPrefix(normalizedType, "INSTEAD OF"):
		return fmt.Sprintf("INSTEAD OF %s ON %s", normalizedEvent, tableRef)
	case strings.Contains(normalizedType, "COMPOUND"):
		return fmt.Sprintf("FOR %s ON %s", normalizedEvent, tableRef)
	default:
		return fmt.Sprintf("%s %s ON %s", strings.TrimSpace(triggerType), normalizedEvent, tableRef)
	}
}

func shouldAppendOracleForEachRow(triggerType string) bool {
	normalizedType := strings.ToUpper(strings.TrimSpace(triggerType))
	return strings.Contains(normalizedType, "EACH ROW") && !strings.HasPrefix(normalizedType, "INSTEAD OF")
}

func normalizeOracleTriggerWhenClause(whenClause string) string {
	trimmed := strings.TrimSpace(whenClause)
	if trimmed == "" {
		return ""
	}
	if strings.HasPrefix(trimmed, "(") && strings.HasSuffix(trimmed, ")") {
		return "WHEN " + trimmed
	}
	return "WHEN (" + trimmed + ")"
}

func splitOracleQualifiedTableName(raw string) (string, string) {
	table := strings.TrimSpace(raw)
	schema := ""
	if parts := strings.SplitN(table, ".", 2); len(parts) == 2 {
		schema = strings.Trim(strings.TrimSpace(parts[0]), "\"")
		table = strings.TrimSpace(parts[1])
	}
	table = strings.Trim(strings.TrimSpace(table), "\"")
	return schema, table
}

func (o *OracleDB) loadColumnTypeMap(tableName string) (map[string]string, error) {
	result := map[string]string{}
	schema, table := splitOracleQualifiedTableName(tableName)
	if table == "" {
		return result, nil
	}

	columns, err := o.GetColumns(schema, table)
	if err != nil {
		return nil, oracleRuntimeError("db.backend.error.oracle_column_metadata_load_failed", map[string]any{
			"table":  tableName,
			"detail": err.Error(),
		})
	}

	for _, col := range columns {
		name := strings.ToLower(strings.TrimSpace(col.Name))
		if name == "" {
			continue
		}
		result[name] = strings.TrimSpace(col.Type)
	}
	return result, nil
}

func normalizeOracleValueForWrite(columnName string, value interface{}, columnTypeMap map[string]string) interface{} {
	columnType := columnTypeMap[strings.ToLower(strings.TrimSpace(columnName))]
	if !isOracleTemporalColumnType(columnType) {
		return value
	}
	if value == nil {
		return nil
	}
	text, ok := value.(string)
	if !ok {
		return value
	}
	raw := strings.TrimSpace(text)
	if raw == "" {
		return nil
	}
	if parsed, ok := parseOracleTemporalString(raw); ok {
		return parsed
	}
	return value
}

func isOracleTemporalColumnType(columnType string) bool {
	typ := strings.ToUpper(strings.TrimSpace(columnType))
	return strings.Contains(typ, "DATE") || strings.Contains(typ, "TIMESTAMP")
}

func parseOracleTemporalString(raw string) (time.Time, bool) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return time.Time{}, false
	}
	text = strings.ReplaceAll(text, "+ ", "+")
	text = strings.ReplaceAll(text, "- ", "-")

	candidates := []string{text}
	if len(text) >= 19 && text[10] == ' ' && (strings.HasSuffix(text, "Z") || hasTimezoneOffset(text)) {
		candidates = append(candidates, strings.Replace(text, " ", "T", 1))
	}

	layoutsWithZone := []string{
		"2006-01-02 15:04:05.999999999 -0700 MST",
		"2006-01-02 15:04:05 -0700 MST",
		"2006-01-02 15:04:05.999999999 -0700",
		"2006-01-02 15:04:05 -0700",
		time.RFC3339Nano,
		time.RFC3339,
	}
	for _, candidate := range candidates {
		for _, layout := range layoutsWithZone {
			if parsed, err := time.Parse(layout, candidate); err == nil {
				return parsed, true
			}
		}
	}

	layoutsWithoutZone := []string{
		"2006-01-02T15:04:05.999999999",
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05.999999999",
		"2006-01-02 15:04:05",
		"2006-01-02",
	}
	for _, layout := range layoutsWithoutZone {
		if parsed, err := time.ParseInLocation(layout, text, time.Local); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

func (o *OracleDB) ApplyChanges(tableName string, changes connection.ChangeSet) (err error) {
	if o.conn == nil {
		return fmt.Errorf("连接未打开")
	}

	columnTypeMap, err := o.loadColumnTypeMap(tableName)
	if err != nil {
		return err
	}

	ctx := context.Background()
	conn, err := o.conn.Conn(ctx)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := conn.Close(); closeErr != nil && err == nil {
			err = closeErr
		}
	}()

	transactionFinished := false
	defer func() {
		if transactionFinished {
			return
		}
		if _, rollbackErr := conn.ExecContext(context.Background(), "ROLLBACK"); rollbackErr != nil {
			logger.Warnf("Oracle 表格编辑事务回滚失败：table=%s err=%v", tableName, rollbackErr)
		}
	}()

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

	isOracleRowIDLocator := strings.EqualFold(strings.TrimSpace(changes.LocatorStrategy), "oracle-rowid")
	buildWhere := func(keys map[string]interface{}, startIndex int) ([]string, []interface{}, int) {
		var wheres []string
		var args []interface{}
		idx := startIndex
		for k, v := range keys {
			idx++
			if isOracleRowIDLocator && strings.EqualFold(strings.TrimSpace(k), "ROWID") {
				wheres = append(wheres, fmt.Sprintf("ROWID = :%d", idx))
				args = append(args, v)
				continue
			}
			wheres = append(wheres, fmt.Sprintf("%s = :%d", quoteIdent(k), idx))
			args = append(args, normalizeOracleValueForWrite(k, v, columnTypeMap))
		}
		return wheres, args, idx
	}

	// 1. Deletes
	for _, pk := range changes.Deletes {
		wheres, args, _ := buildWhere(pk, 0)
		if len(wheres) == 0 {
			continue
		}
		query := fmt.Sprintf("DELETE FROM %s WHERE %s", qualifiedTable, strings.Join(wheres, " AND "))
		res, err := conn.ExecContext(ctx, query, args...)
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
			sets = append(sets, fmt.Sprintf("%s = :%d", quoteIdent(k), idx))
			args = append(args, normalizeOracleValueForWrite(k, v, columnTypeMap))
		}

		if len(sets) == 0 {
			continue
		}

		wheres, whereArgs, _ := buildWhere(update.Keys, idx)
		args = append(args, whereArgs...)

		if len(wheres) == 0 {
			return fmt.Errorf("更新操作需要主键条件")
		}

		query := fmt.Sprintf("UPDATE %s SET %s WHERE %s", qualifiedTable, strings.Join(sets, ", "), strings.Join(wheres, " AND "))
		res, err := conn.ExecContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("更新失败：%v", err)
		}
		if err := requireSingleRowAffected(res, rowMutationActionUpdate); err != nil {
			return err
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
			placeholders = append(placeholders, fmt.Sprintf(":%d", idx))
			args = append(args, normalizeOracleValueForWrite(k, v, columnTypeMap))
		}

		if len(cols) == 0 {
			continue
		}

		query := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", qualifiedTable, strings.Join(cols, ", "), strings.Join(placeholders, ", "))
		res, err := conn.ExecContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("插入失败：%v", err)
		}
		if affected, err := res.RowsAffected(); err == nil && affected == 0 {
			return fmt.Errorf("插入未生效：未影响任何行")
		}
	}

	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return fmt.Errorf("事务提交失败：%v", err)
	}
	transactionFinished = true
	return nil
}

func (o *OracleDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	query := fmt.Sprintf(`SELECT c.table_name, c.column_name, c.data_type, cc.comments AS comment
		FROM all_tab_columns c
		LEFT JOIN all_col_comments cc
		  ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
		WHERE c.owner = '%s'`, strings.ReplaceAll(strings.ToUpper(dbName), "'", "''"))

	data, _, err := o.Query(query)
	if err != nil {
		return nil, err
	}

	var cols []connection.ColumnDefinitionWithTable
	for _, row := range data {
		col := connection.ColumnDefinitionWithTable{
			TableName: fmt.Sprintf("%v", row["TABLE_NAME"]),
			Name:      fmt.Sprintf("%v", row["COLUMN_NAME"]),
			Type:      fmt.Sprintf("%v", row["DATA_TYPE"]),
			Comment:   fmt.Sprintf("%v", row["COMMENT"]),
		}
		cols = append(cols, col)
	}
	return cols, nil
}
