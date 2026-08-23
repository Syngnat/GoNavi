//go:build gonavi_full_drivers || gonavi_tdengine_driver

package db

import (
	"context"
	"database/sql"
	"errors"
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

	_ "github.com/taosdata/driver-go/v3/taosWS"
)

// TDengineDB implements Database interface for TDengine.
// Uses taosWS driver via WebSocket (通常通过 taosAdapter 提供服务)。
type TDengineDB struct {
	conn        *sql.DB
	pingTimeout time.Duration
	forwarder   *ssh.LocalForwarder
}

func (t *TDengineDB) getDSN(config connection.ConnectionConfig) string {
	user := strings.TrimSpace(config.User)
	if user == "" {
		user = "root"
	}

	pass := config.Password
	dbName := strings.TrimSpace(config.Database)
	path := "/"
	if dbName != "" {
		path = "/" + dbName
	}

	escapedUser := url.QueryEscape(user)
	escapedPass := url.QueryEscape(pass)
	netType := resolveTDengineNet(config)
	params := url.Values{}
	mergeConnectionParamsFromConfigWithAllowlist(params, config, tdengineConnectionParamNames, "taos", "taosws", "tdengine")
	query := params.Encode()
	dsn := fmt.Sprintf("%s:%s@%s(%s)%s", escapedUser, escapedPass, netType, net.JoinHostPort(config.Host, strconv.Itoa(config.Port)), path)
	if query == "" {
		return dsn
	}
	return dsn + "?" + query
}

func (t *TDengineDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = t.Close()
	defer func() {
		if err != nil {
			_ = t.Close()
		}
	}()

	runConfig := config

	if config.UseSSH {
		logger.Infof("TDengine 使用 SSH 连接：地址=%s:%d 用户=%s", config.Host, config.Port, config.User)

		forwarder, err := ssh.AcquireLocalForwarder(config.SSH, config.Host, config.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		t.forwarder = forwarder

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
		logger.Infof("TDengine 通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	}

	attempts := []connection.ConnectionConfig{runConfig}
	if shouldTrySSLPreferredFallback(runConfig) {
		attempts = append(attempts, withSSLDisabled(runConfig))
	}

	var failures []string
	for idx, attempt := range attempts {
		dsn := t.getDSN(attempt)
		db, err := sql.Open("taosWS", dsn)
		if err != nil {
			failures = append(failures, fmt.Sprintf("第%d次连接打开失败: %v", idx+1, err))
			continue
		}
		configureSQLConnectionPool(db, "tdengine")
		t.conn = db
		t.pingTimeout = getConnectTimeout(attempt)

		if err := t.Ping(); err != nil {
			_ = db.Close()
			t.conn = nil
			failures = append(failures, fmt.Sprintf("第%d次连接验证失败: %v", idx+1, err))
			continue
		}
		if idx > 0 {
			logger.Warnf("TDengine SSL 优先连接失败，已回退至明文连接")
		}
		return nil
	}
	return fmt.Errorf("连接建立后验证失败：%s", strings.Join(failures, "；"))
}

func (t *TDengineDB) Close() error {
	if t.forwarder != nil {
		if err := t.forwarder.Release(); err != nil {
			logger.Warnf("关闭 TDengine SSH 端口转发失败：%v", err)
		}
		t.forwarder = nil
	}

	if t.conn != nil {
		return t.conn.Close()
	}
	return nil
}

func (t *TDengineDB) Ping() error {
	if t.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	timeout := t.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	return t.conn.PingContext(ctx)
}

func (t *TDengineDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if t.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}

	rows, err := t.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	return scanRows(rows)
}

func (t *TDengineDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if t.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}

	rows, err := t.conn.QueryContext(metadataContextFor(t), query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	return scanRows(rows)
}

func (t *TDengineDB) StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error {
	if t.conn == nil {
		return fmt.Errorf("连接未打开")
	}

	rows, err := t.conn.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	defer rows.Close()

	return streamRows(rows, consumer)
}

func (t *TDengineDB) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return t.StreamQueryContext(context.Background(), query, consumer)
}

func (t *TDengineDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if t.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := t.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (t *TDengineDB) Exec(query string) (int64, error) {
	if t.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := t.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (t *TDengineDB) GetDatabases() ([]string, error) {
	data, _, err := t.Query("SHOW DATABASES")
	if err != nil {
		return nil, err
	}

	var dbs []string
	for _, row := range data {
		if val, ok := getValueFromRow(row, "name", "database", "Database", "db_name"); ok {
			dbs = append(dbs, fmt.Sprintf("%v", val))
			continue
		}
		for _, val := range row {
			dbs = append(dbs, fmt.Sprintf("%v", val))
			break
		}
	}
	return dbs, nil
}

func (t *TDengineDB) GetTables(dbName string) ([]string, error) {
	queries := tdengineShowTablesQueries(dbName)

	var lastErr error
	tableSet := make(map[string]struct{})
	tables := make([]string, 0)
	for _, query := range queries {
		data, _, err := t.Query(query)
		if err != nil {
			lastErr = err
			continue
		}

		for _, row := range data {
			if val, ok := getValueFromRow(row, "table_name", "tablename", "name", "Table", "table"); ok {
				tableName := strings.TrimSpace(fmt.Sprintf("%v", val))
				if tableName == "" {
					continue
				}
				if _, exists := tableSet[tableName]; exists {
					continue
				}
				tableSet[tableName] = struct{}{}
				tables = append(tables, tableName)
				continue
			}
			for _, val := range row {
				tableName := strings.TrimSpace(fmt.Sprintf("%v", val))
				if tableName == "" {
					break
				}
				if _, exists := tableSet[tableName]; exists {
					break
				}
				tableSet[tableName] = struct{}{}
				tables = append(tables, tableName)
				break
			}
		}
	}
	if len(tables) > 0 {
		sort.Strings(tables)
		return tables, nil
	}

	if lastErr != nil {
		return nil, lastErr
	}
	return []string{}, nil
}

func (t *TDengineDB) GetCreateStatement(dbName, tableName string) (string, error) {
	queries := tdengineCreateStatementQueries(dbName, tableName)

	var lastErr error
	for _, query := range queries {
		data, _, err := t.Query(query)
		if err != nil {
			lastErr = err
			continue
		}
		if len(data) == 0 {
			continue
		}

		row := data[0]
		if val, ok := getValueFromRow(row, "Create Table", "create table", "Create Stable", "create stable", "SQL", "sql"); ok {
			return fmt.Sprintf("%v", val), nil
		}

		longest := ""
		for _, val := range row {
			text := fmt.Sprintf("%v", val)
			if strings.Contains(strings.ToUpper(text), "CREATE ") && len(text) > len(longest) {
				longest = text
			}
		}
		if longest != "" {
			return longest, nil
		}
	}

	if lastErr != nil {
		return "", lastErr
	}
	return "", errors.New(localizedDriverRuntimeText("db.backend.error.create_table_statement_not_found", nil))
}

func (t *TDengineDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	var (
		data    []map[string]interface{}
		err     error
		lastErr error
	)
	for _, query := range tdengineDescribeQueries(dbName, tableName) {
		data, _, err = t.Query(query)
		if err == nil {
			break
		}
		lastErr = err
		if !isTDengineSyntaxCompatibilityError(err) {
			return nil, err
		}
	}
	if err != nil {
		if lastErr != nil {
			return nil, lastErr
		}
		return nil, err
	}

	columns := make([]connection.ColumnDefinition, 0, len(data))
	for _, row := range data {
		name, _ := getValueFromRow(row, "Field", "field", "col_name", "column_name", "name")
		colType, _ := getValueFromRow(row, "Type", "type", "data_type")
		note, _ := getValueFromRow(row, "Note", "note", "Extra", "extra")
		nullable, okNull := getValueFromRow(row, "Null", "null", "nullable")
		comment, _ := getValueFromRow(row, "Comment", "comment")
		defaultVal, hasDefault := getValueFromRow(row, "Default", "default")

		col := connection.ColumnDefinition{
			Name:     fmt.Sprintf("%v", name),
			Type:     fmt.Sprintf("%v", colType),
			Nullable: "YES",
			Key:      "",
			Extra:    fmt.Sprintf("%v", note),
			Comment:  fmt.Sprintf("%v", comment),
		}

		if okNull {
			col.Nullable = strings.ToUpper(fmt.Sprintf("%v", nullable))
		}

		noteUpper := strings.ToUpper(fmt.Sprintf("%v", note))
		if strings.Contains(noteUpper, "TAG") {
			col.Key = "TAG"
		}

		if hasDefault && defaultVal != nil {
			def := fmt.Sprintf("%v", defaultVal)
			if def != "<nil>" {
				col.Default = &def
			}
		}

		columns = append(columns, col)
	}
	return columns, nil
}

func (t *TDengineDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	if strings.TrimSpace(dbName) == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.database_name_required", nil)
	}

	tables, err := t.GetTables(dbName)
	if err != nil {
		return nil, err
	}

	cols := make([]connection.ColumnDefinitionWithTable, 0)
	var failures []MetadataObjectFailure
	for _, table := range tables {
		tableCols, err := t.GetColumns(dbName, table)
		if err != nil {
			failures = append(failures, MetadataObjectFailure{ObjectName: table, Err: err})
			continue
		}
		for _, col := range tableCols {
			cols = append(cols, connection.ColumnDefinitionWithTable{
				TableName: table,
				Name:      col.Name,
				Type:      col.Type,
				Comment:   col.Comment,
			})
		}
	}

	return cols, NewPartialMetadataError(failures)
}

func (t *TDengineDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return []connection.IndexDefinition{}, nil
}

func (t *TDengineDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

func (t *TDengineDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}

func (t *TDengineDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	if t.conn == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	if strings.TrimSpace(tableName) == "" {
		return localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}
	if len(changes.Updates) > 0 || len(changes.Deletes) > 0 {
		return localizedDatabaseRuntimeError("db.backend.error.tdengine_apply_changes_insert_only", nil)
	}

	qualifiedTable := quoteTDengineTable("", tableName)
	return execTDengineInsertBatches(t.conn, qualifiedTable, changes.Inserts)
}

func execTDengineInsertBatches(conn *sql.DB, qualifiedTable string, rows []map[string]interface{}) error {
	if conn == nil {
		return fmt.Errorf("连接未打开")
	}
	return execLiteralInsertBatches(literalInsertConfig{
		Table: qualifiedTable,
		Rows:  rows,
		QuoteColumn: func(column string) string {
			return fmt.Sprintf("`%s`", escapeBacktickIdent(column))
		},
		Literal: tdengineLiteral,
		Exec: func(query string) (sql.Result, error) {
			return conn.Exec(query)
		},
	})
}

func buildTDengineInsertSQL(qualifiedTable string, row map[string]interface{}) (string, error) {
	if strings.TrimSpace(qualifiedTable) == "" {
		return "", fmt.Errorf("需要指定完整的表名")
	}
	if len(row) == 0 {
		return "", nil
	}

	cols := make([]string, 0, len(row))
	for key := range row {
		if strings.TrimSpace(key) == "" {
			continue
		}
		cols = append(cols, key)
	}
	if len(cols) == 0 {
		return "", nil
	}
	sort.Strings(cols)

	quotedCols := make([]string, 0, len(cols))
	values := make([]string, 0, len(cols))
	for _, col := range cols {
		quotedCols = append(quotedCols, fmt.Sprintf("`%s`", escapeBacktickIdent(col)))
		values = append(values, tdengineLiteral(row[col]))
	}

	return fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", qualifiedTable, strings.Join(quotedCols, ", "), strings.Join(values, ", ")), nil
}

func tdengineLiteral(value interface{}) string {
	switch val := value.(type) {
	case nil:
		return "NULL"
	case bool:
		if val {
			return "1"
		}
		return "0"
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
		return fmt.Sprintf("%v", val)
	case time.Time:
		return fmt.Sprintf("'%s'", val.Format("2006-01-02 15:04:05"))
	case []byte:
		return fmt.Sprintf("'%s'", strings.ReplaceAll(string(val), "'", "''"))
	default:
		return fmt.Sprintf("'%s'", strings.ReplaceAll(fmt.Sprintf("%v", val), "'", "''"))
	}
}

func getValueFromRow(row map[string]interface{}, keys ...string) (interface{}, bool) {
	if len(row) == 0 {
		return nil, false
	}

	for _, key := range keys {
		if val, ok := row[key]; ok {
			return val, true
		}
	}

	for existingKey, val := range row {
		for _, key := range keys {
			if strings.EqualFold(existingKey, key) {
				return val, true
			}
		}
	}

	return nil, false
}

func escapeBacktickIdent(ident string) string {
	return strings.ReplaceAll(strings.TrimSpace(ident), "`", "``")
}

func tdengineShowTablesQueries(dbName string) []string {
	queries := make([]string, 0, 6)
	appendQuery := func(query string) {
		query = strings.TrimSpace(query)
		if query == "" {
			return
		}
		for _, existing := range queries {
			if existing == query {
				return
			}
		}
		queries = append(queries, query)
	}

	db := strings.TrimSpace(dbName)
	if db != "" {
		escaped := escapeBacktickIdent(db)
		appendQuery(fmt.Sprintf("SHOW TABLES FROM `%s`", escaped))
		appendQuery(fmt.Sprintf("SHOW STABLES FROM `%s`", escaped))
		appendQuery(fmt.Sprintf("SHOW TABLES FROM %s", db))
		appendQuery(fmt.Sprintf("SHOW STABLES FROM %s", db))
	}

	appendQuery("SHOW TABLES")
	appendQuery("SHOW STABLES")
	return queries
}

func tdengineDescribeQueries(dbName, tableName string) []string {
	qualified := quoteTDengineTable(dbName, tableName)
	legacyQualified := quoteTDengineTableLegacy(dbName, tableName)
	queries := []string{fmt.Sprintf("DESCRIBE %s", qualified)}
	if legacyQualified != qualified {
		queries = append(queries, fmt.Sprintf("DESCRIBE %s", legacyQualified))
	}
	return queries
}

func tdengineCreateStatementQueries(dbName, tableName string) []string {
	queries := make([]string, 0, 4)
	appendQualifiedQueries := func(qualified string) {
		if strings.TrimSpace(qualified) == "" {
			return
		}
		queries = append(queries,
			fmt.Sprintf("SHOW CREATE TABLE %s", qualified),
			fmt.Sprintf("SHOW CREATE STABLE %s", qualified),
		)
	}
	qualified := quoteTDengineTable(dbName, tableName)
	appendQualifiedQueries(qualified)
	legacyQualified := quoteTDengineTableLegacy(dbName, tableName)
	if legacyQualified != qualified {
		appendQualifiedQueries(legacyQualified)
	}
	return queries
}

func quoteTDengineTableLegacy(dbName, tableName string) string {
	table := strings.TrimSpace(tableName)
	if table == "" {
		return ""
	}
	if strings.Contains(table, ".") {
		return strings.Join(splitTDengineIdentifierParts(table), ".")
	}
	db := strings.TrimSpace(dbName)
	if db == "" {
		return table
	}
	return db + "." + table
}

func splitTDengineIdentifierParts(path string) []string {
	parts := strings.Split(strings.TrimSpace(path), ".")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.Trim(strings.TrimSpace(part), "`")
		if trimmed == "" {
			continue
		}
		result = append(result, trimmed)
	}
	return result
}

func isTDengineSyntaxCompatibilityError(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(strings.TrimSpace(err.Error()))
	if text == "" {
		return false
	}
	return strings.Contains(text, "syntax error near") ||
		strings.Contains(text, "[0x2600]") ||
		errors.Is(err, sql.ErrNoRows)
}

func quoteTDengineTable(dbName, tableName string) string {
	t := escapeBacktickIdent(tableName)
	if t == "" {
		return "``"
	}
	if strings.Contains(t, ".") {
		parts := strings.Split(t, ".")
		quoted := make([]string, 0, len(parts))
		for _, part := range parts {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			quoted = append(quoted, fmt.Sprintf("`%s`", escapeBacktickIdent(part)))
		}
		if len(quoted) > 0 {
			return strings.Join(quoted, ".")
		}
	}

	db := escapeBacktickIdent(dbName)
	if db == "" {
		return fmt.Sprintf("`%s`", t)
	}
	return fmt.Sprintf("`%s`.`%s`", db, t)
}
