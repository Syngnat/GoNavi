//go:build gonavi_full_drivers || gonavi_tdengine_driver

package db

import (
	"context"
	"crypto/tls"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/internal/utils"

	"github.com/gorilla/websocket"
	_ "github.com/taosdata/driver-go/v3/taosRestful"
	_ "github.com/taosdata/driver-go/v3/taosWS"
)

const (
	tdengineWebSocketDriver = "taosWS"
	tdengineRestfulDriver   = "taosRestful"
	tdengineVersionProbeSQL = "SELECT SERVER_VERSION()"
)

var tdengineRESTConnectionParamNames = newConnectionParamNameMap(
	"interpolateParams",
	"token",
	"disableCompression",
	"readBufferSize",
	"timezone",
	"bearerToken",
)

type tdengineConnectAttemptFunc func(config connection.ConnectionConfig, driverName, dsn string) (*sql.DB, error)

type tdengineWebSocketEndpointProbeFunc func(ctx context.Context, config connection.ConnectionConfig) (int, error)

// TDengineDB implements Database interface for TDengine.
// WebSocket is preferred; RESTful is used only for explicit server/protocol incompatibility.
type TDengineDB struct {
	conn                   *sql.DB
	driverName             string
	pingTimeout            time.Duration
	forwarder              *ssh.LocalForwarder
	connectAttempt         tdengineConnectAttemptFunc
	probeWebSocketEndpoint tdengineWebSocketEndpointProbeFunc
}

var _ BatchApplierContext = (*TDengineDB)(nil)

func (t *TDengineDB) getDSN(config connection.ConnectionConfig) string {
	params := url.Values{}
	mergeConnectionParamsFromConfigWithAllowlist(params, config, tdengineConnectionParamNames, "taos", "taosws", "tdengine")
	return buildTDengineDSN(config, resolveTDengineNet(config), params)
}

func (t *TDengineDB) getRestDSN(config connection.ConnectionConfig) string {
	params := url.Values{}
	mergeConnectionParamsFromConfigWithAllowlist(params, config, tdengineRESTConnectionParamNames, "taos", "taosrestful", "tdengine", "http", "https")
	if normalizedSSLMode(config) == sslModeSkipVerify {
		params.Set("skipVerify", "true")
	}

	netType := "http"
	if normalizedSSLMode(config) != sslModeDisable {
		netType = "https"
	}
	return buildTDengineDSN(config, netType, params)
}

func buildTDengineDSN(config connection.ConnectionConfig, netType string, params url.Values) string {
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
	for idx, attemptConfig := range attempts {
		db, wsErr := t.runConnectAttempt(attemptConfig, tdengineWebSocketDriver, t.getDSN(attemptConfig))
		if wsErr == nil {
			t.acceptConnection(db, tdengineWebSocketDriver, attemptConfig)
			t.logTDengineSSLFallback(idx)
			return nil
		}
		if db != nil {
			_ = db.Close()
		}
		failures = append(failures, fmt.Sprintf("第%d次 WebSocket 连接验证失败: %s", idx+1, safeTDengineErrorText(wsErr, attemptConfig)))

		if !t.shouldFallbackToREST(attemptConfig, wsErr) {
			continue
		}

		logger.Warnf("TDengine WebSocket 与服务端版本或协议不兼容，尝试 RESTful 协议")
		restDB, restErr := t.runConnectAttempt(attemptConfig, tdengineRestfulDriver, t.getRestDSN(attemptConfig))
		if restErr == nil {
			t.acceptConnection(restDB, tdengineRestfulDriver, attemptConfig)
			t.logTDengineSSLFallback(idx)
			logger.Warnf("TDengine 已回退至 RESTful 协议")
			return nil
		}
		if restDB != nil {
			_ = restDB.Close()
		}
		failures = append(failures, fmt.Sprintf("第%d次 RESTful 连接验证失败: %s", idx+1, safeTDengineErrorText(restErr, attemptConfig)))
	}
	return fmt.Errorf("连接建立后验证失败：%s", strings.Join(failures, "；"))
}

func (t *TDengineDB) runConnectAttempt(config connection.ConnectionConfig, driverName, dsn string) (*sql.DB, error) {
	if t.connectAttempt != nil {
		return t.connectAttempt(config, driverName, dsn)
	}
	return openAndValidateTDengineConnection(config, driverName, dsn)
}

func openAndValidateTDengineConnection(config connection.ConnectionConfig, driverName, dsn string) (*sql.DB, error) {
	db, err := sql.Open(driverName, dsn)
	if err != nil {
		return nil, err
	}
	configureSQLConnectionPool(db, "tdengine")

	ctx, cancel := utils.ContextWithTimeout(getConnectTimeout(config))
	defer cancel()
	if err := validateTDengineConnection(ctx, db, driverName); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

func validateTDengineConnection(ctx context.Context, db *sql.DB, driverName string) error {
	if driverName != tdengineRestfulDriver {
		return db.PingContext(ctx)
	}

	var version interface{}
	if err := db.QueryRowContext(ctx, tdengineVersionProbeSQL).Scan(&version); err != nil {
		return fmt.Errorf("RESTful 只读版本探针失败: %w", err)
	}
	if version == nil || strings.TrimSpace(fmt.Sprint(version)) == "" {
		return fmt.Errorf("RESTful 只读版本探针返回空版本")
	}
	return nil
}

func (t *TDengineDB) acceptConnection(db *sql.DB, driverName string, config connection.ConnectionConfig) {
	t.conn = db
	t.driverName = driverName
	t.pingTimeout = getConnectTimeout(config)
}

func (t *TDengineDB) logTDengineSSLFallback(attemptIndex int) {
	if attemptIndex > 0 {
		logger.Warnf("TDengine SSL 优先连接失败，已回退至明文连接")
	}
}

func (t *TDengineDB) shouldFallbackToREST(config connection.ConnectionConfig, wsErr error) bool {
	if isTDengineWebSocketCompatibilityError(wsErr) {
		return true
	}
	if !isTDengineBadWebSocketHandshake(wsErr) {
		return false
	}

	probe := t.probeWebSocketEndpoint
	if probe == nil {
		probe = probeTDengineWebSocketEndpoint
	}
	ctx, cancel := utils.ContextWithTimeout(getConnectTimeout(config))
	defer cancel()
	statusCode, _ := probe(ctx, config)
	return isTDengineUnsupportedWebSocketStatus(statusCode)
}

func isTDengineWebSocketCompatibilityError(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(err.Error())
	if strings.Contains(text, "version mismatch.") && strings.Contains(text, "minimum required tdengine version") {
		return true
	}
	if strings.Contains(text, "unknown tdengine version:") {
		return true
	}
	if strings.Contains(text, "get version:") {
		return true
	}
	if strings.Contains(text, "websocket endpoint") && (strings.Contains(text, "not found") || strings.Contains(text, "not support") || strings.Contains(text, "unsupported")) {
		return true
	}
	if strings.Contains(text, "websocket protocol") && (strings.Contains(text, "not support") || strings.Contains(text, "unsupported")) {
		return true
	}
	return strings.Contains(text, "unexpected action") ||
		strings.Contains(text, "unknown action") ||
		strings.Contains(text, "unsupported action") ||
		strings.Contains(text, "action not support") ||
		strings.Contains(text, "action not implemented")
}

func isTDengineBadWebSocketHandshake(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "websocket: bad handshake")
}

func isTDengineUnsupportedWebSocketStatus(statusCode int) bool {
	switch statusCode {
	case http.StatusNotFound,
		http.StatusMethodNotAllowed,
		http.StatusGone,
		http.StatusUpgradeRequired,
		http.StatusNotImplemented:
		return true
	default:
		return false
	}
}

func probeTDengineWebSocketEndpoint(ctx context.Context, config connection.ConnectionConfig) (int, error) {
	endpoint := url.URL{
		Scheme: resolveTDengineNet(config),
		Host:   net.JoinHostPort(config.Host, strconv.Itoa(config.Port)),
		Path:   "/ws",
	}
	params := url.Values{}
	mergeConnectionParamsFromConfigWithAllowlist(params, config, tdengineConnectionParamNames, "taos", "taosws", "tdengine")
	if token := params.Get("token"); token != "" {
		endpoint.RawQuery = url.Values{"token": []string{token}}.Encode()
	}

	dialer := websocket.Dialer{
		Proxy:            http.ProxyFromEnvironment,
		HandshakeTimeout: getConnectTimeout(config),
	}
	if normalizedSSLMode(config) == sslModeSkipVerify {
		// The caller explicitly selected skip-verify for this connection.
		dialer.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} // #nosec G402
	}

	ws, response, err := dialer.DialContext(ctx, endpoint.String(), nil)
	if ws != nil {
		_ = ws.Close()
	}
	statusCode := 0
	if response != nil {
		statusCode = response.StatusCode
		if response.Body != nil {
			_ = response.Body.Close()
		}
	}
	return statusCode, err
}

func safeTDengineErrorText(err error, config connection.ConnectionConfig) string {
	if err == nil {
		return ""
	}
	text := err.Error()
	secrets := []string{config.Password}
	params := url.Values{}
	mergeConnectionParamsFromConfigWithAllowlist(params, config, tdengineConnectionParamNames, "taos", "taosws", "taosrestful", "tdengine", "http", "https")
	for _, name := range []string{"token", "bearerToken", "totpCode"} {
		secrets = append(secrets, params.Get(name))
	}
	for _, secret := range secrets {
		if secret == "" {
			continue
		}
		variants := []string{secret, url.QueryEscape(secret)}
		if encoded, marshalErr := json.Marshal(secret); marshalErr == nil && len(encoded) >= 2 {
			variants = append(variants, string(encoded[1:len(encoded)-1]))
		}
		for _, variant := range variants {
			if variant != "" {
				text = strings.ReplaceAll(text, variant, "[REDACTED]")
			}
		}
	}
	return text
}

func (t *TDengineDB) Close() error {
	if t.forwarder != nil {
		if err := t.forwarder.Release(); err != nil {
			logger.Warnf("关闭 TDengine SSH 端口转发失败：%v", err)
		}
		t.forwarder = nil
	}

	if t.conn != nil {
		db := t.conn
		t.conn = nil
		t.driverName = ""
		return db.Close()
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
	return validateTDengineConnection(ctx, t.conn, t.driverName)
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
	return t.ApplyChangesContext(context.Background(), tableName, changes)
}

func (t *TDengineDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error {
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
	return execTDengineInsertBatchesContext(ctx, t.conn, qualifiedTable, changes.Inserts)
}

func execTDengineInsertBatches(conn *sql.DB, qualifiedTable string, rows []map[string]interface{}) error {
	return execTDengineInsertBatchesContext(context.Background(), conn, qualifiedTable, rows)
}

func execTDengineInsertBatchesContext(ctx context.Context, conn *sql.DB, qualifiedTable string, rows []map[string]interface{}) error {
	if conn == nil {
		return fmt.Errorf("连接未打开")
	}
	err := execLiteralInsertBatches(literalInsertConfig{
		Table: qualifiedTable,
		Rows:  rows,
		QuoteColumn: func(column string) string {
			return fmt.Sprintf("`%s`", escapeBacktickIdent(column))
		},
		Literal: tdengineLiteral,
		Exec: func(query string) (sql.Result, error) {
			return conn.ExecContext(ctx, query)
		},
	})
	if err != nil && ctx.Err() != nil {
		if IsWriteOutcomeUnknown(err) {
			return MarkWriteOutcomeUnknown(ctx.Err())
		}
		return ctx.Err()
	}
	return err
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
	segments := SplitSQLIdentifierPathForDialect(table, "tdengine")
	if len(segments) >= 2 {
		parts := make([]string, 0, len(segments))
		for _, segment := range segments {
			parts = append(parts, strings.TrimSpace(segment.Value))
		}
		return strings.Join(parts, ".")
	}
	if len(segments) == 1 {
		table = strings.TrimSpace(segments[0].Value)
	}
	db := strings.TrimSpace(dbName)
	if db == "" {
		return table
	}
	return db + "." + table
}

func splitTDengineIdentifierParts(path string) []string {
	segments := SplitSQLIdentifierPathForDialect(path, "tdengine")
	result := make([]string, 0, len(segments))
	for _, segment := range segments {
		trimmed := strings.TrimSpace(segment.Value)
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
	tableText := strings.TrimSpace(tableName)
	if tableText == "" {
		return "``"
	}
	segments := SplitSQLIdentifierPathForDialect(tableText, "tdengine")
	if len(segments) >= 2 {
		// A qualified TDengine name is database.table. The final segment may
		// itself contain dots when it was delimited, so never split its value.
		dbPart := strings.TrimSpace(segments[0].Value)
		tableParts := make([]string, 0, len(segments)-1)
		for _, segment := range segments[1:] {
			tableParts = append(tableParts, strings.TrimSpace(segment.Value))
		}
		return fmt.Sprintf("`%s`.`%s`", escapeBacktickIdent(dbPart), escapeBacktickIdent(strings.Join(tableParts, ".")))
	}
	if len(segments) == 1 {
		tableText = strings.TrimSpace(segments[0].Value)
	}

	db := escapeBacktickIdent(dbName)
	if db == "" {
		return fmt.Sprintf("`%s`", escapeBacktickIdent(tableText))
	}
	return fmt.Sprintf("`%s`.`%s`", db, escapeBacktickIdent(tableText))
}
