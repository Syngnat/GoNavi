//go:build gonavi_full_drivers || gonavi_clickhouse_driver

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

	clickhouse "github.com/ClickHouse/clickhouse-go/v2"
)

const (
	defaultClickHousePort     = 9000
	defaultClickHouseUser     = "default"
	defaultClickHouseDatabase = "default"
	minClickHouseReadTimeout  = 5 * time.Minute
)

type ClickHouseDB struct {
	conn        *sql.DB
	pingTimeout time.Duration
	forwarder   *ssh.LocalForwarder
	database    string
}

func normalizeClickHouseConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	normalized := applyClickHouseURI(config)
	if strings.TrimSpace(normalized.Host) == "" {
		normalized.Host = "localhost"
	}
	if normalized.Port <= 0 {
		normalized.Port = defaultClickHousePort
	}
	if strings.TrimSpace(normalized.User) == "" {
		normalized.User = defaultClickHouseUser
	}
	if strings.TrimSpace(normalized.Database) == "" {
		normalized.Database = defaultClickHouseDatabase
	}
	return normalized
}

func applyClickHouseURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	uriText := strings.TrimSpace(config.URI)
	if uriText == "" {
		return config
	}
	lowerURI := strings.ToLower(uriText)
	if !strings.HasPrefix(lowerURI, "clickhouse://") {
		return config
	}

	parsed, err := url.Parse(uriText)
	if err != nil {
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

	if dbName := strings.TrimPrefix(strings.TrimSpace(parsed.Path), "/"); dbName != "" && strings.TrimSpace(config.Database) == "" {
		config.Database = dbName
	}
	if strings.TrimSpace(config.Database) == "" {
		if dbName := strings.TrimSpace(parsed.Query().Get("database")); dbName != "" {
			config.Database = dbName
		}
	}

	defaultPort := config.Port
	if defaultPort <= 0 {
		defaultPort = defaultClickHousePort
	}
	if strings.TrimSpace(config.Host) == "" {
		host, port, ok := parseHostPortWithDefault(parsed.Host, defaultPort)
		if ok {
			config.Host = host
			config.Port = port
		}
	}
	if config.Port <= 0 {
		config.Port = defaultPort
	}
	return config
}

func (c *ClickHouseDB) buildClickHouseOptions(config connection.ConnectionConfig) *clickhouse.Options {
	connectTimeout := getConnectTimeout(config)
	readTimeout := connectTimeout
	if readTimeout < minClickHouseReadTimeout {
		readTimeout = minClickHouseReadTimeout
	}
	opts := &clickhouse.Options{
		Addr: []string{
			net.JoinHostPort(config.Host, strconv.Itoa(config.Port)),
		},
		Auth: clickhouse.Auth{
			Database: strings.TrimSpace(config.Database),
			Username: strings.TrimSpace(config.User),
			Password: config.Password,
		},
		DialTimeout: connectTimeout,
		ReadTimeout: readTimeout,
	}
	if tlsConfig := resolveGenericTLSConfig(config); tlsConfig != nil {
		opts.TLS = tlsConfig
	}
	return opts
}

func (c *ClickHouseDB) Connect(config connection.ConnectionConfig) error {
	if supported, reason := DriverRuntimeSupportStatus("clickhouse"); !supported {
		if strings.TrimSpace(reason) == "" {
			reason = "ClickHouse 纯 Go 驱动未启用，请先在驱动管理中安装启用"
		}
		return fmt.Errorf("%s", reason)
	}

	if c.forwarder != nil {
		_ = c.forwarder.Close()
		c.forwarder = nil
	}
	if c.conn != nil {
		_ = c.conn.Close()
		c.conn = nil
	}

	runConfig := normalizeClickHouseConfig(config)
	c.pingTimeout = getConnectTimeout(runConfig)
	c.database = runConfig.Database

	if runConfig.UseSSH {
		logger.Infof("ClickHouse 使用 SSH 连接：地址=%s:%d 用户=%s", runConfig.Host, runConfig.Port, runConfig.User)
		forwarder, err := ssh.GetOrCreateLocalForwarder(runConfig.SSH, runConfig.Host, runConfig.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		c.forwarder = forwarder

		host, portText, err := net.SplitHostPort(forwarder.LocalAddr)
		if err != nil {
			return fmt.Errorf("解析本地转发地址失败：%w", err)
		}
		port, err := strconv.Atoi(portText)
		if err != nil {
			return fmt.Errorf("解析本地端口失败：%w", err)
		}

		runConfig.Host = host
		runConfig.Port = port
		runConfig.UseSSH = false
		logger.Infof("ClickHouse 通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	}

	attempts := []connection.ConnectionConfig{runConfig}
	if shouldTrySSLPreferredFallback(runConfig) {
		attempts = append(attempts, withSSLDisabled(runConfig))
	}

	var failures []string
	for idx, attempt := range attempts {
		c.conn = clickhouse.OpenDB(c.buildClickHouseOptions(attempt))
		if err := c.Ping(); err != nil {
			failures = append(failures, fmt.Sprintf("第%d次连接验证失败: %v", idx+1, err))
			if c.conn != nil {
				_ = c.conn.Close()
				c.conn = nil
			}
			continue
		}
		if idx > 0 {
			logger.Warnf("ClickHouse SSL 优先连接失败，已回退至明文连接")
		}
		return nil
	}

	_ = c.Close()
	return fmt.Errorf("连接建立后验证失败：%s", strings.Join(failures, "；"))
}

func (c *ClickHouseDB) Close() error {
	if c.forwarder != nil {
		if err := c.forwarder.Close(); err != nil {
			logger.Warnf("关闭 ClickHouse SSH 端口转发失败：%v", err)
		}
		c.forwarder = nil
	}
	if c.conn != nil {
		return c.conn.Close()
	}
	return nil
}

func (c *ClickHouseDB) Ping() error {
	if c.conn == nil {
		return fmt.Errorf("connection not open")
	}
	timeout := c.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	return c.conn.PingContext(ctx)
}

func (c *ClickHouseDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if c.conn == nil {
		return nil, nil, fmt.Errorf("connection not open")
	}
	rows, err := c.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (c *ClickHouseDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if c.conn == nil {
		return nil, nil, fmt.Errorf("connection not open")
	}
	rows, err := c.conn.Query(query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (c *ClickHouseDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if c.conn == nil {
		return 0, fmt.Errorf("connection not open")
	}
	res, err := c.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (c *ClickHouseDB) Exec(query string) (int64, error) {
	if c.conn == nil {
		return 0, fmt.Errorf("connection not open")
	}
	res, err := c.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (c *ClickHouseDB) GetDatabases() ([]string, error) {
	data, _, err := c.Query("SELECT name FROM system.databases ORDER BY name")
	if err != nil {
		return nil, err
	}

	result := make([]string, 0, len(data))
	for _, row := range data {
		if val, ok := getClickHouseValueFromRow(row, "name", "database"); ok {
			result = append(result, fmt.Sprintf("%v", val))
			continue
		}
		for _, value := range row {
			result = append(result, fmt.Sprintf("%v", value))
			break
		}
	}
	return result, nil
}

func (c *ClickHouseDB) GetTables(dbName string) ([]string, error) {
	targetDB := strings.TrimSpace(dbName)
	if targetDB == "" {
		targetDB = strings.TrimSpace(c.database)
	}

	var query string
	if targetDB != "" {
		query = fmt.Sprintf(
			"SELECT name FROM system.tables WHERE database = '%s' ORDER BY name",
			escapeClickHouseSQLLiteral(targetDB),
		)
	} else {
		query = "SELECT database, name FROM system.tables ORDER BY database, name"
	}

	data, _, err := c.Query(query)
	if err != nil {
		return nil, err
	}

	result := make([]string, 0, len(data))
	for _, row := range data {
		if targetDB != "" {
			if val, ok := getClickHouseValueFromRow(row, "name", "table", "table_name"); ok {
				result = append(result, fmt.Sprintf("%v", val))
				continue
			}
		} else {
			databaseValue, hasDB := getClickHouseValueFromRow(row, "database", "schema_name")
			tableValue, hasTable := getClickHouseValueFromRow(row, "name", "table", "table_name")
			if hasDB && hasTable {
				result = append(result, fmt.Sprintf("%v.%v", databaseValue, tableValue))
				continue
			}
		}
		for _, value := range row {
			result = append(result, fmt.Sprintf("%v", value))
			break
		}
	}
	return result, nil
}

func (c *ClickHouseDB) GetCreateStatement(dbName, tableName string) (string, error) {
	database, table, err := c.resolveDatabaseAndTable(dbName, tableName)
	if err != nil {
		return "", err
	}

	query := fmt.Sprintf("SHOW CREATE TABLE %s.%s", quoteClickHouseIdentifier(database), quoteClickHouseIdentifier(table))
	data, _, err := c.Query(query)
	if err != nil {
		return "", err
	}
	if len(data) == 0 {
		return "", fmt.Errorf("create statement not found")
	}
	row := data[0]
	if val, ok := getClickHouseValueFromRow(row, "statement", "create_statement", "sql", "query"); ok {
		text := strings.TrimSpace(fmt.Sprintf("%v", val))
		if text != "" {
			return text, nil
		}
	}

	longest := ""
	for _, value := range row {
		text := strings.TrimSpace(fmt.Sprintf("%v", value))
		if text == "" {
			continue
		}
		if strings.Contains(strings.ToUpper(text), "CREATE ") && len(text) > len(longest) {
			longest = text
		}
	}
	if longest != "" {
		return longest, nil
	}
	return "", fmt.Errorf("create statement not found")
}

func (c *ClickHouseDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	database, table, err := c.resolveDatabaseAndTable(dbName, tableName)
	if err != nil {
		return nil, err
	}

	query := fmt.Sprintf(`
SELECT
    name,
    type,
    default_kind,
    default_expression,
    is_in_primary_key,
    is_in_sorting_key,
    comment
FROM system.columns
WHERE database = '%s' AND table = '%s'
ORDER BY position`,
		escapeClickHouseSQLLiteral(database),
		escapeClickHouseSQLLiteral(table),
	)
	data, _, err := c.Query(query)
	if err != nil {
		return nil, err
	}

	columns := make([]connection.ColumnDefinition, 0, len(data))
	for _, row := range data {
		nameValue, _ := getClickHouseValueFromRow(row, "name", "column_name")
		typeValue, _ := getClickHouseValueFromRow(row, "type", "data_type")
		defaultKind, _ := getClickHouseValueFromRow(row, "default_kind")
		defaultExpr, hasDefault := getClickHouseValueFromRow(row, "default_expression", "column_default")
		commentValue, _ := getClickHouseValueFromRow(row, "comment")
		inPrimary, _ := getClickHouseValueFromRow(row, "is_in_primary_key")
		inSorting, _ := getClickHouseValueFromRow(row, "is_in_sorting_key")

		colType := strings.TrimSpace(fmt.Sprintf("%v", typeValue))
		nullable := "NO"
		if strings.HasPrefix(strings.ToLower(colType), "nullable(") {
			nullable = "YES"
		}

		key := ""
		if isClickHouseTruthy(inPrimary) {
			key = "PRI"
		} else if isClickHouseTruthy(inSorting) {
			key = "MUL"
		}

		extra := ""
		kindText := strings.ToUpper(strings.TrimSpace(fmt.Sprintf("%v", defaultKind)))
		if kindText != "" && kindText != "DEFAULT" {
			extra = kindText
		}

		col := connection.ColumnDefinition{
			Name:     strings.TrimSpace(fmt.Sprintf("%v", nameValue)),
			Type:     colType,
			Nullable: nullable,
			Key:      key,
			Extra:    extra,
			Comment:  strings.TrimSpace(fmt.Sprintf("%v", commentValue)),
		}
		if hasDefault && defaultExpr != nil {
			text := strings.TrimSpace(fmt.Sprintf("%v", defaultExpr))
			if text != "" {
				col.Default = &text
			}
		}
		columns = append(columns, col)
	}
	return columns, nil
}

func (c *ClickHouseDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	targetDB := strings.TrimSpace(dbName)
	if targetDB == "" {
		targetDB = strings.TrimSpace(c.database)
	}

	var query string
	if targetDB != "" {
		query = fmt.Sprintf(`
SELECT
    database,
    table,
    name,
    type
FROM system.columns
WHERE database = '%s'
ORDER BY table, position`,
			escapeClickHouseSQLLiteral(targetDB),
		)
	} else {
		query = `
SELECT
    database,
    table,
    name,
    type
FROM system.columns
WHERE database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA')
ORDER BY database, table, position`
	}

	data, _, err := c.Query(query)
	if err != nil {
		return nil, err
	}

	result := make([]connection.ColumnDefinitionWithTable, 0, len(data))
	for _, row := range data {
		databaseValue, _ := getClickHouseValueFromRow(row, "database")
		tableValue, hasTable := getClickHouseValueFromRow(row, "table", "table_name")
		nameValue, hasName := getClickHouseValueFromRow(row, "name", "column_name")
		typeValue, _ := getClickHouseValueFromRow(row, "type", "data_type")
		if !hasTable || !hasName {
			continue
		}

		tableName := strings.TrimSpace(fmt.Sprintf("%v", tableValue))
		if targetDB == "" {
			dbText := strings.TrimSpace(fmt.Sprintf("%v", databaseValue))
			if dbText != "" {
				tableName = dbText + "." + tableName
			}
		}

		result = append(result, connection.ColumnDefinitionWithTable{
			TableName: tableName,
			Name:      strings.TrimSpace(fmt.Sprintf("%v", nameValue)),
			Type:      strings.TrimSpace(fmt.Sprintf("%v", typeValue)),
		})
	}
	return result, nil
}

func (c *ClickHouseDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return []connection.IndexDefinition{}, nil
}

func (c *ClickHouseDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

func (c *ClickHouseDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}

func (c *ClickHouseDB) resolveDatabaseAndTable(dbName, tableName string) (string, string, error) {
	rawTable := strings.TrimSpace(tableName)
	if rawTable == "" {
		return "", "", fmt.Errorf("table name required")
	}

	resolvedDB := strings.TrimSpace(dbName)
	resolvedTable := rawTable
	if parts := strings.SplitN(rawTable, ".", 2); len(parts) == 2 {
		if dbPart := normalizeClickHouseIdentifierPart(parts[0]); dbPart != "" {
			resolvedDB = dbPart
		}
		resolvedTable = normalizeClickHouseIdentifierPart(parts[1])
	} else {
		resolvedTable = normalizeClickHouseIdentifierPart(rawTable)
	}

	if resolvedDB == "" {
		resolvedDB = strings.TrimSpace(c.database)
	}
	if resolvedDB == "" {
		resolvedDB = defaultClickHouseDatabase
	}
	if resolvedTable == "" {
		return "", "", fmt.Errorf("table name required")
	}
	return resolvedDB, resolvedTable, nil
}

func normalizeClickHouseIdentifierPart(raw string) string {
	text := strings.TrimSpace(raw)
	if len(text) >= 2 {
		first := text[0]
		last := text[len(text)-1]
		if (first == '`' && last == '`') || (first == '"' && last == '"') {
			text = text[1 : len(text)-1]
		}
	}
	return strings.TrimSpace(text)
}

func quoteClickHouseIdentifier(raw string) string {
	return "`" + strings.ReplaceAll(strings.TrimSpace(raw), "`", "``") + "`"
}

func escapeClickHouseSQLLiteral(raw string) string {
	return strings.ReplaceAll(strings.TrimSpace(raw), "'", "''")
}

func getClickHouseValueFromRow(row map[string]interface{}, keys ...string) (interface{}, bool) {
	if len(row) == 0 {
		return nil, false
	}
	for _, key := range keys {
		if value, ok := row[key]; ok {
			return value, true
		}
	}
	for existingKey, value := range row {
		for _, key := range keys {
			if strings.EqualFold(existingKey, key) {
				return value, true
			}
		}
	}
	return nil, false
}

func isClickHouseTruthy(value interface{}) bool {
	switch val := value.(type) {
	case bool:
		return val
	case int:
		return val != 0
	case int8:
		return val != 0
	case int16:
		return val != 0
	case int32:
		return val != 0
	case int64:
		return val != 0
	case uint:
		return val != 0
	case uint8:
		return val != 0
	case uint16:
		return val != 0
	case uint32:
		return val != 0
	case uint64:
		return val != 0
	case string:
		normalized := strings.ToLower(strings.TrimSpace(val))
		return normalized == "1" || normalized == "true" || normalized == "yes" || normalized == "y"
	default:
		normalized := strings.ToLower(strings.TrimSpace(fmt.Sprintf("%v", value)))
		return normalized == "1" || normalized == "true" || normalized == "yes" || normalized == "y"
	}
}
