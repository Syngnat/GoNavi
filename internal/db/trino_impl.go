//go:build gonavi_full_drivers || gonavi_trino_driver

package db

import (
	"context"
	"database/sql"
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

	trinodriver "github.com/trinodb/trino-go-client/trino"
)

const (
	defaultTrinoPort   = 8080
	defaultTrinoSource = "GoNavi"
)

type TrinoDB struct {
	conn             *sql.DB
	pingTimeout      time.Duration
	forwarder        *ssh.LocalForwarder
	namespace        string
	customClientName string
}

func normalizeTrinoConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	normalized := applyTrinoURI(config)
	normalized = applyTrinoHostURI(normalized)
	if strings.TrimSpace(normalized.Host) == "" {
		normalized.Host = "localhost"
	}
	if normalized.Port <= 0 {
		normalized.Port = defaultTrinoPort
	}
	return normalized
}

func applyTrinoURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	return applyTrinoEndpointURI(config, config.URI, false)
}

func applyTrinoHostURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	return applyTrinoEndpointURI(config, config.Host, true)
}

func applyTrinoEndpointURI(config connection.ConnectionConfig, raw string, fromHostField bool) connection.ConnectionConfig {
	uriText := strings.TrimSpace(raw)
	if uriText == "" {
		return config
	}
	parsed, err := url.Parse(uriText)
	if err != nil {
		return config
	}
	scheme := strings.ToLower(strings.TrimSpace(parsed.Scheme))
	if scheme != "trino" && scheme != "http" && scheme != "https" {
		return config
	}
	if strings.TrimSpace(parsed.Host) == "" {
		return config
	}

	if parsed.User != nil {
		if strings.TrimSpace(config.User) == "" {
			config.User = parsed.User.Username()
		}
		if pass, ok := parsed.User.Password(); ok && config.Password == "" {
			config.Password = pass
		}
	}

	params := url.Values{}
	mergeConnectionParamValues(params, parsed.Query())
	mergeConnectionParamValues(params, connectionParamsFromText(config.ConnectionParams))

	catalog := strings.TrimSpace(parsed.Query().Get("catalog"))
	schema := strings.TrimSpace(parsed.Query().Get("schema"))
	if strings.TrimSpace(config.Database) == "" {
		config.Database = joinTrinoNamespace(catalog, schema)
	}

	if scheme == "https" {
		config.UseSSL = true
		if normalizeSSLModeValue(config.SSLMode) == sslModeDisable || strings.TrimSpace(config.SSLMode) == "" {
			config.SSLMode = sslModeRequired
		}
	}

	defaultPort := config.Port
	if defaultPort <= 0 {
		defaultPort = defaultTrinoPort
	}
	if fromHostField || strings.TrimSpace(config.Host) == "" {
		host, port, ok := parseHostPortWithDefault(parsed.Host, defaultPort)
		if ok {
			config.Host = host
			config.Port = port
		}
	}
	if config.Port <= 0 {
		config.Port = defaultPort
	}
	config.ConnectionParams = params.Encode()
	return config
}

func splitTrinoNamespace(raw string) (string, string) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "", ""
	}
	parts := strings.SplitN(text, ".", 2)
	catalog := strings.TrimSpace(parts[0])
	if len(parts) == 1 {
		return catalog, ""
	}
	return catalog, strings.TrimSpace(parts[1])
}

func joinTrinoNamespace(catalog, schema string) string {
	c := strings.TrimSpace(catalog)
	s := strings.TrimSpace(schema)
	switch {
	case c == "":
		return s
	case s == "":
		return c
	default:
		return c + "." + s
	}
}

func resolveTrinoNamespace(raw string, fallback string) (string, string) {
	catalog, schema := splitTrinoNamespace(raw)
	if catalog != "" || schema != "" {
		return catalog, schema
	}
	return splitTrinoNamespace(fallback)
}

func quoteTrinoIdentifier(ident string) string {
	return `"` + strings.ReplaceAll(strings.TrimSpace(ident), `"`, `""`) + `"`
}

func quoteTrinoQualifiedTable(catalog, schema, table string) string {
	quoted := make([]string, 0, 3)
	if trimmed := strings.TrimSpace(catalog); trimmed != "" {
		quoted = append(quoted, quoteTrinoIdentifier(trimmed))
	}
	if trimmed := strings.TrimSpace(schema); trimmed != "" {
		quoted = append(quoted, quoteTrinoIdentifier(trimmed))
	}
	quoted = append(quoted, quoteTrinoIdentifier(table))
	return strings.Join(quoted, ".")
}

func escapeTrinoSQLLiteral(value string) string {
	return "'" + strings.ReplaceAll(strings.TrimSpace(value), "'", "''") + "'"
}

func trinoRowValue(row map[string]interface{}, keys ...string) (interface{}, bool) {
	if len(row) == 0 {
		return nil, false
	}
	for _, key := range keys {
		for current, value := range row {
			if strings.EqualFold(strings.TrimSpace(current), strings.TrimSpace(key)) {
				return value, true
			}
		}
	}
	return nil, false
}

func trinoRowString(row map[string]interface{}, keys ...string) string {
	value, ok := trinoRowValue(row, keys...)
	if !ok || value == nil {
		return ""
	}
	text := strings.TrimSpace(fmt.Sprintf("%v", value))
	if strings.EqualFold(text, "<nil>") {
		return ""
	}
	return text
}

func firstTrinoMapValueAsString(row map[string]interface{}) string {
	for _, value := range row {
		text := strings.TrimSpace(fmt.Sprintf("%v", value))
		if !strings.EqualFold(text, "<nil>") {
			return text
		}
	}
	return ""
}

func firstTrinoRowValueAsString(data []map[string]interface{}) string {
	if len(data) == 0 {
		return ""
	}
	return firstTrinoMapValueAsString(data[0])
}

func (t *TrinoDB) buildTrinoHTTPClient(config connection.ConnectionConfig) (*http.Client, error) {
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   getConnectTimeout(config),
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:          32,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	tlsConfig, err := resolveGenericTLSConfig(config)
	if err != nil {
		return nil, err
	}
	if tlsConfig != nil {
		transport.TLSClientConfig = tlsConfig
	}
	return &http.Client{Transport: transport}, nil
}

func (t *TrinoDB) registerTrinoCustomClient(config connection.ConnectionConfig) (string, error) {
	client, err := t.buildTrinoHTTPClient(config)
	if err != nil {
		return "", err
	}
	name := fmt.Sprintf("gonavi-trino-%d", time.Now().UnixNano())
	if err := trinodriver.RegisterCustomClient(name, client); err != nil {
		return "", err
	}
	return name, nil
}

func buildTrinoDSN(config connection.ConnectionConfig, customClientName string) (string, error) {
	user := strings.TrimSpace(config.User)
	if user == "" {
		return "", fmt.Errorf("Trino 用户名不能为空")
	}

	scheme := "http"
	if config.UseSSL {
		scheme = "https"
	}
	if config.Password != "" && scheme != "https" {
		return "", fmt.Errorf("Trino 启用密码认证时必须使用 HTTPS")
	}

	params := connectionParamsFromText(config.ConnectionParams)
	if params == nil {
		params = url.Values{}
	}
	catalog, schema := resolveTrinoNamespace(config.Database, "")
	if catalog != "" {
		params.Set("catalog", catalog)
	}
	if schema != "" {
		params.Set("schema", schema)
	}
	if strings.TrimSpace(params.Get("source")) == "" {
		params.Set("source", defaultTrinoSource)
	}
	if strings.TrimSpace(params.Get("explicitPrepare")) == "" {
		params.Set("explicitPrepare", "false")
	}
	// Do not derive Trino's server-side query_timeout from the connection
	// timeout. The request context is the sole automatic query deadline.
	if strings.TrimSpace(customClientName) != "" {
		params.Set("custom_client", strings.TrimSpace(customClientName))
	}

	endpoint := &url.URL{
		Scheme:   scheme,
		Host:     net.JoinHostPort(strings.TrimSpace(config.Host), strconv.Itoa(config.Port)),
		RawQuery: params.Encode(),
	}
	if config.Password != "" {
		endpoint.User = url.UserPassword(user, config.Password)
	} else {
		endpoint.User = url.User(user)
	}
	return endpoint.String(), nil
}

func (t *TrinoDB) Close() error {
	var firstErr error
	if t.conn != nil {
		if err := t.conn.Close(); err != nil {
			firstErr = err
		}
		t.conn = nil
	}
	if t.forwarder != nil {
		if err := t.forwarder.Release(); err != nil {
			logger.Warnf("关闭 Trino SSH 端口转发失败：%v", err)
			if firstErr == nil {
				firstErr = err
			}
		}
		t.forwarder = nil
	}
	if t.customClientName != "" {
		trinodriver.DeregisterCustomClient(t.customClientName)
		t.customClientName = ""
	}
	t.namespace = ""
	return firstErr
}

func (t *TrinoDB) Connect(config connection.ConnectionConfig) error {
	_ = t.Close()

	runConfig := normalizeTrinoConfig(config)
	t.pingTimeout = getConnectTimeout(runConfig)

	if runConfig.UseSSH {
		forwarder, err := ssh.AcquireLocalForwarder(runConfig.SSH, runConfig.Host, runConfig.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		t.forwarder = forwarder

		host, portText, err := net.SplitHostPort(forwarder.LocalAddr)
		if err != nil {
			_ = t.Close()
			return fmt.Errorf("解析本地转发地址失败：%w", err)
		}
		port, err := strconv.Atoi(portText)
		if err != nil {
			_ = t.Close()
			return fmt.Errorf("解析本地端口失败：%w", err)
		}
		runConfig.Host = host
		runConfig.Port = port
		runConfig.UseSSH = false
		logger.Infof("Trino 通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	}

	customClientName, err := t.registerTrinoCustomClient(runConfig)
	if err != nil {
		_ = t.Close()
		return fmt.Errorf("注册 Trino 自定义 HTTP 客户端失败：%w", err)
	}
	t.customClientName = customClientName

	dsn, err := buildTrinoDSN(runConfig, customClientName)
	if err != nil {
		_ = t.Close()
		return err
	}
	conn, err := sql.Open("trino", dsn)
	if err != nil {
		_ = t.Close()
		return err
	}
	t.conn = conn
	t.namespace = strings.TrimSpace(runConfig.Database)
	if err := t.Ping(); err != nil {
		_ = t.Close()
		return err
	}
	return nil
}

func (t *TrinoDB) Ping() error {
	if t.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	timeout := t.pingTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	rows, err := t.conn.QueryContext(ctx, "SELECT 1")
	if err != nil {
		return err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return err
		}
		return fmt.Errorf("连接查询验证未返回结果")
	}
	var value sql.NullInt64
	if err := rows.Scan(&value); err != nil {
		return err
	}
	return rows.Err()
}

func (t *TrinoDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
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

func (t *TrinoDB) Query(query string) ([]map[string]interface{}, []string, error) {
	return t.QueryContext(metadataContextFor(t), query)
}

func (t *TrinoDB) StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error {
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

func (t *TrinoDB) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return t.StreamQueryContext(context.Background(), query, consumer)
}

func (t *TrinoDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if t.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := t.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return 0, nil
	}
	return affected, nil
}

func (t *TrinoDB) Exec(query string) (int64, error) {
	return t.ExecContext(context.Background(), query)
}

func (t *TrinoDB) queryTrinoSingleColumnStrings(query string) ([]string, error) {
	data, _, err := t.Query(query)
	if err != nil {
		return nil, err
	}
	result := make([]string, 0, len(data))
	for _, row := range data {
		text := firstTrinoMapValueAsString(row)
		if text != "" {
			result = append(result, text)
		}
	}
	return result, nil
}

func (t *TrinoDB) GetDatabases() ([]string, error) {
	catalogs, err := t.queryTrinoSingleColumnStrings("SHOW CATALOGS")
	if err != nil {
		if strings.TrimSpace(t.namespace) != "" {
			return []string{t.namespace}, nil
		}
		return nil, err
	}

	namespaces := make([]string, 0, len(catalogs)*2)
	seen := make(map[string]struct{}, len(catalogs)*4)
	var lastErr error
	for _, catalog := range catalogs {
		query := fmt.Sprintf("SHOW SCHEMAS FROM %s", quoteTrinoIdentifier(catalog))
		schemas, schemaErr := t.queryTrinoSingleColumnStrings(query)
		if schemaErr != nil {
			lastErr = schemaErr
			continue
		}
		for _, schema := range schemas {
			namespace := joinTrinoNamespace(catalog, schema)
			if namespace == "" {
				continue
			}
			key := strings.ToLower(namespace)
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			namespaces = append(namespaces, namespace)
		}
	}

	if len(namespaces) == 0 {
		if strings.TrimSpace(t.namespace) != "" {
			return []string{t.namespace}, nil
		}
		if lastErr != nil {
			return nil, lastErr
		}
	}
	sort.Strings(namespaces)
	return namespaces, nil
}

func (t *TrinoDB) GetTables(dbName string) ([]string, error) {
	catalog, schema := resolveTrinoNamespace(dbName, t.namespace)
	if catalog == "" || schema == "" {
		return nil, fmt.Errorf("Trino 默认命名空间必须使用 catalog.schema")
	}
	query := fmt.Sprintf("SHOW TABLES FROM %s.%s", quoteTrinoIdentifier(catalog), quoteTrinoIdentifier(schema))
	tables, err := t.queryTrinoSingleColumnStrings(query)
	if err != nil {
		return nil, err
	}
	sort.Strings(tables)
	return tables, nil
}

func (t *TrinoDB) GetCreateStatement(dbName, tableName string) (string, error) {
	catalog, schema := resolveTrinoNamespace(dbName, t.namespace)
	if catalog == "" || schema == "" {
		return "", fmt.Errorf("Trino 默认命名空间必须使用 catalog.schema")
	}
	query := fmt.Sprintf("SHOW CREATE TABLE %s", quoteTrinoQualifiedTable(catalog, schema, tableName))
	data, _, err := t.Query(query)
	if err != nil {
		return "", err
	}
	ddl := firstTrinoRowValueAsString(data)
	if ddl == "" {
		return "", fmt.Errorf("未返回建表语句")
	}
	return ddl, nil
}

func buildTrinoColumnsQuery(catalog, schema, tableName string) string {
	return fmt.Sprintf(`SELECT
	column_name,
	data_type,
	is_nullable,
	column_default
FROM %s.information_schema.columns
WHERE table_schema = %s AND table_name = %s
ORDER BY ordinal_position`,
		quoteTrinoIdentifier(catalog),
		escapeTrinoSQLLiteral(schema),
		escapeTrinoSQLLiteral(tableName),
	)
}

func buildTrinoColumnDefinitions(data []map[string]interface{}) []connection.ColumnDefinition {
	result := make([]connection.ColumnDefinition, 0, len(data))
	for _, row := range data {
		column := connection.ColumnDefinition{
			Name:     trinoRowString(row, "column_name", "Column", "Field"),
			Type:     trinoRowString(row, "data_type", "Type"),
			Nullable: strings.ToUpper(trinoRowString(row, "is_nullable", "Null")),
		}
		if rawDefault, ok := trinoRowValue(row, "column_default", "Default"); ok && rawDefault != nil {
			def := strings.TrimSpace(fmt.Sprintf("%v", rawDefault))
			if !strings.EqualFold(def, "<nil>") && def != "" {
				column.Default = &def
			}
		}
		if column.Nullable == "" {
			column.Nullable = "YES"
		}
		result = append(result, column)
	}
	return result
}

func (t *TrinoDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	catalog, schema := resolveTrinoNamespace(dbName, t.namespace)
	if catalog == "" || schema == "" {
		return nil, fmt.Errorf("Trino 默认命名空间必须使用 catalog.schema")
	}
	data, _, err := t.Query(buildTrinoColumnsQuery(catalog, schema, tableName))
	if err == nil {
		return buildTrinoColumnDefinitions(data), nil
	}

	describeQuery := fmt.Sprintf("DESCRIBE %s", quoteTrinoQualifiedTable(catalog, schema, tableName))
	describeRows, _, describeErr := t.Query(describeQuery)
	if describeErr != nil {
		return nil, err
	}
	columns := make([]connection.ColumnDefinition, 0, len(describeRows))
	for _, row := range describeRows {
		name := trinoRowString(row, "Column", "column_name", "Field")
		if name == "" || strings.HasPrefix(name, "#") {
			continue
		}
		columns = append(columns, connection.ColumnDefinition{
			Name:     name,
			Type:     trinoRowString(row, "Type", "data_type"),
			Nullable: "YES",
		})
	}
	return columns, nil
}

func (t *TrinoDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	catalog, schema := resolveTrinoNamespace(dbName, t.namespace)
	if catalog == "" || schema == "" {
		return nil, fmt.Errorf("Trino 默认命名空间必须使用 catalog.schema")
	}
	query := fmt.Sprintf(`SELECT
	table_name,
	column_name,
	data_type
FROM %s.information_schema.columns
WHERE table_schema = %s
ORDER BY table_name, ordinal_position`,
		quoteTrinoIdentifier(catalog),
		escapeTrinoSQLLiteral(schema),
	)
	data, _, err := t.Query(query)
	if err != nil {
		return nil, err
	}
	result := make([]connection.ColumnDefinitionWithTable, 0, len(data))
	for _, row := range data {
		result = append(result, connection.ColumnDefinitionWithTable{
			TableName: trinoRowString(row, "table_name", "TABLE_NAME"),
			Name:      trinoRowString(row, "column_name", "COLUMN_NAME"),
			Type:      trinoRowString(row, "data_type", "DATA_TYPE"),
		})
	}
	return result, nil
}

func (t *TrinoDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return []connection.IndexDefinition{}, nil
}

func (t *TrinoDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

func (t *TrinoDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}

func (t *TrinoDB) OpenSessionExecer(ctx context.Context) (StatementExecer, error) {
	if t.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	conn, err := t.conn.Conn(ctx)
	if err != nil {
		return nil, err
	}
	return NewSQLConnStatementExecer(conn), nil
}
