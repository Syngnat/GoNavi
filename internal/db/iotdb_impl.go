//go:build gonavi_full_drivers || gonavi_iotdb_driver

package db

import (
	"context"
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

	iotdbclient "github.com/apache/iotdb-client-go/client"
)

const (
	defaultIoTDBPort         = 6667
	defaultIoTDBUser         = "root"
	defaultIoTDBPassword     = "root"
	defaultIoTDBQueryTimeout = 30 * time.Second
)

type iotdbDataSet interface {
	Next() (bool, error)
	Close() error
	IsNull(columnName string) (bool, error)
	GetObject(columnName string) (interface{}, error)
	GetColumnNames() []string
}

type iotdbSessionRunner interface {
	Close() error
	Query(ctx context.Context, sql string, timeoutMs *int64) (iotdbDataSet, error)
	Exec(ctx context.Context, sql string) error
}

type iotdbClientSession struct {
	session *iotdbclient.Session
}

func (s *iotdbClientSession) Close() error {
	if s == nil || s.session == nil {
		return nil
	}
	return s.session.Close()
}

func (s *iotdbClientSession) Query(ctx context.Context, sql string, timeoutMs *int64) (iotdbDataSet, error) {
	if s == nil || s.session == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	return s.session.ExecuteQueryStatement(sql, timeoutMs)
}

func (s *iotdbClientSession) Exec(ctx context.Context, sql string) error {
	if s == nil || s.session == nil {
		return fmt.Errorf("连接未打开")
	}
	return s.session.ExecuteNonQueryStatement(sql)
}

var newIoTDBSessionRunner = func(config connection.ConnectionConfig) (iotdbSessionRunner, error) {
	params := iotdbConnectionParams(config)
	user := strings.TrimSpace(config.User)
	if user == "" {
		user = defaultIoTDBUser
	}
	password := config.Password
	if password == "" {
		password = defaultIoTDBPassword
	}
	fetchSize := int32(intFromAny(params.Get("fetchSize"), iotdbclient.DefaultFetchSize))
	if fetchSize <= 0 {
		fetchSize = iotdbclient.DefaultFetchSize
	}
	timeZone := strings.TrimSpace(firstNonEmpty(params.Get("timeZone"), params.Get("timezone"), params.Get("zoneId")))
	if timeZone == "" {
		timeZone = iotdbclient.DefaultTimeZone
	}
	retryMax := intFromAny(firstNonEmpty(params.Get("connectRetryMax"), params.Get("retryMax")), iotdbclient.DefaultConnectRetryMax)
	if retryMax <= 0 {
		retryMax = iotdbclient.DefaultConnectRetryMax
	}
	enableCompression := getOrBool(map[string]interface{}{"rpcCompression": params.Get("rpcCompression")}, "rpcCompression")
	cfg := &iotdbclient.Config{
		Host:            strings.TrimSpace(config.Host),
		Port:            strconv.Itoa(config.Port),
		UserName:        user,
		Password:        password,
		FetchSize:       fetchSize,
		TimeZone:        timeZone,
		ConnectRetryMax: retryMax,
	}
	session := iotdbclient.NewSession(cfg)
	timeoutMs := getConnectTimeout(config).Milliseconds()
	if timeoutMs < 0 {
		timeoutMs = 0
	}
	if err := session.Open(enableCompression, int(timeoutMs)); err != nil {
		return nil, err
	}
	return &iotdbClientSession{session: &session}, nil
}

// IoTDBDB implements Database for Apache IoTDB through the official Session API.
type IoTDBDB struct {
	session     iotdbSessionRunner
	forwarder   *ssh.LocalForwarder
	pingTimeout time.Duration
}

func (i *IoTDBDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = i.Close()
	defer func() {
		if err != nil {
			_ = i.Close()
		}
	}()

	runConfig := normalizeIoTDBConfig(config)
	if runConfig.UseSSH {
		forwarder, err := ssh.AcquireLocalForwarder(runConfig.SSH, runConfig.Host, runConfig.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		i.forwarder = forwarder

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
		logger.Infof("IoTDB 通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	}

	session, err := newIoTDBSessionRunner(runConfig)
	if err != nil {
		_ = i.Close()
		return err
	}
	i.session = session
	i.pingTimeout = getConnectTimeout(runConfig)
	if err := i.Ping(); err != nil {
		_ = i.Close()
		return err
	}
	return nil
}

func (i *IoTDBDB) Close() error {
	if i.forwarder != nil {
		if err := i.forwarder.Release(); err != nil {
			logger.Warnf("关闭 IoTDB SSH 端口转发失败：%v", err)
		}
		i.forwarder = nil
	}
	if i.session != nil {
		err := i.session.Close()
		i.session = nil
		return err
	}
	return nil
}

func (i *IoTDBDB) Ping() error {
	if i.session == nil {
		return fmt.Errorf("连接未打开")
	}
	ctx, cancel := context.WithTimeout(context.Background(), i.effectiveTimeout())
	defer cancel()
	ds, err := i.session.Query(ctx, "SHOW VERSION", nil)
	if err != nil {
		return err
	}
	return ds.Close()
}

func (i *IoTDBDB) Query(query string) ([]map[string]interface{}, []string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultIoTDBQueryTimeout)
	defer cancel()
	return i.QueryContext(ctx, query)
}

func (i *IoTDBDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if i.session == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}
	text := strings.TrimSpace(query)
	if text == "" {
		return nil, nil, fmt.Errorf("查询语句不能为空")
	}
	timeoutMs := int64(i.effectiveTimeout().Milliseconds())
	ds, err := i.session.Query(ctx, text, &timeoutMs)
	if err != nil {
		return nil, nil, err
	}
	return scanIoTDBDataSet(ds)
}

func (i *IoTDBDB) Exec(query string) (int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultIoTDBQueryTimeout)
	defer cancel()
	return i.ExecContext(ctx, query)
}

func (i *IoTDBDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if i.session == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	text := strings.TrimSpace(query)
	if text == "" {
		return 0, fmt.Errorf("执行语句不能为空")
	}
	if err := i.session.Exec(ctx, text); err != nil {
		return 0, err
	}
	return 0, nil
}

func (i *IoTDBDB) GetDatabases() ([]string, error) {
	queries := []string{"SHOW DATABASES", "SHOW STORAGE GROUPS", "SHOW STORAGE GROUP"}
	var lastErr error
	for _, query := range queries {
		rows, _, err := i.Query(query)
		if err != nil {
			lastErr = err
			continue
		}
		names := make([]string, 0, len(rows))
		for _, row := range rows {
			name := firstRowString(row, "Database", "database", "Storage Group", "storage group", "storage_group", "name")
			if name == "" {
				name = firstAnyRowString(row)
			}
			if name != "" {
				names = append(names, name)
			}
		}
		if len(names) > 0 {
			sort.Strings(names)
			return names, nil
		}
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return []string{}, nil
}

func (i *IoTDBDB) GetTables(dbName string) ([]string, error) {
	queries := []string{}
	if pattern := iotdbDevicePattern(dbName); pattern != "" {
		queries = append(queries, "SHOW DEVICES "+pattern)
	}
	queries = append(queries, "SHOW DEVICES")

	var lastErr error
	seen := map[string]struct{}{}
	tables := []string{}
	for _, query := range queries {
		rows, _, err := i.Query(query)
		if err != nil {
			lastErr = err
			continue
		}
		for _, row := range rows {
			name := firstRowString(row, "Device", "device", "devices", "Devices", "Path", "path")
			if name == "" {
				name = firstAnyRowString(row)
			}
			if name == "" {
				continue
			}
			if _, exists := seen[name]; exists {
				continue
			}
			seen[name] = struct{}{}
			tables = append(tables, name)
		}
		if len(tables) > 0 {
			sort.Strings(tables)
			return tables, nil
		}
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return []string{}, nil
}

func (i *IoTDBDB) GetCreateStatement(dbName, tableName string) (string, error) {
	device := resolveIoTDBDevicePath(dbName, tableName)
	rows, _, err := i.Query("SHOW TIMESERIES " + iotdbTimeseriesPattern(device))
	if err != nil {
		return "", err
	}
	statements := make([]string, 0, len(rows))
	for _, row := range rows {
		path := firstRowString(row, "Timeseries", "timeseries", "Path", "path")
		if path == "" {
			path = firstAnyRowString(row)
		}
		if path == "" {
			continue
		}
		dataType := firstRowString(row, "DataType", "dataType", "data_type", "Type", "type")
		encoding := firstRowString(row, "Encoding", "encoding")
		compression := firstRowString(row, "Compression", "compression", "Compressor", "compressor")
		parts := []string{}
		if dataType != "" {
			parts = append(parts, "DATATYPE="+dataType)
		}
		if encoding != "" {
			parts = append(parts, "ENCODING="+encoding)
		}
		if compression != "" {
			parts = append(parts, "COMPRESSION="+compression)
		}
		if len(parts) == 0 {
			statements = append(statements, "CREATE TIMESERIES "+path+";")
		} else {
			statements = append(statements, "CREATE TIMESERIES "+path+" WITH "+strings.Join(parts, ", ")+";")
		}
	}
	if len(statements) == 0 {
		return "", fmt.Errorf("未找到 IoTDB timeseries：%s", device)
	}
	return strings.Join(statements, "\n"), nil
}

func (i *IoTDBDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	device := resolveIoTDBDevicePath(dbName, tableName)
	rows, _, err := i.Query("SHOW TIMESERIES " + iotdbTimeseriesPattern(device))
	if err != nil {
		return nil, err
	}
	columns := []connection.ColumnDefinition{{
		Name:     "Time",
		Type:     "TIMESTAMP",
		Nullable: "NO",
		Key:      "PRI",
		Comment:  "IoTDB timestamp column",
	}}
	for _, row := range rows {
		path := firstRowString(row, "Timeseries", "timeseries", "Path", "path")
		if path == "" {
			path = firstAnyRowString(row)
		}
		if path == "" {
			continue
		}
		name := strings.TrimPrefix(path, strings.TrimRight(device, ".")+".")
		dataType := firstRowString(row, "DataType", "dataType", "data_type", "Type", "type")
		encoding := firstRowString(row, "Encoding", "encoding")
		compression := firstRowString(row, "Compression", "compression", "Compressor", "compressor")
		commentParts := []string{}
		if encoding != "" {
			commentParts = append(commentParts, "encoding="+encoding)
		}
		if compression != "" {
			commentParts = append(commentParts, "compression="+compression)
		}
		columns = append(columns, connection.ColumnDefinition{
			Name:     name,
			Type:     dataType,
			Nullable: "YES",
			Comment:  strings.Join(commentParts, "; "),
		})
	}
	return columns, nil
}

func (i *IoTDBDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	tables, err := i.GetTables(dbName)
	if err != nil {
		return nil, err
	}
	var result []connection.ColumnDefinitionWithTable
	for _, table := range tables {
		cols, err := i.GetColumns(dbName, table)
		if err != nil {
			continue
		}
		for _, col := range cols {
			result = append(result, connection.ColumnDefinitionWithTable{
				TableName: table,
				Name:      col.Name,
				Type:      col.Type,
				Comment:   col.Comment,
			})
		}
	}
	return result, nil
}

func (i *IoTDBDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return []connection.IndexDefinition{{Name: "TIME", ColumnName: "Time", NonUnique: 0, SeqInIndex: 1, IndexType: "TIME"}}, nil
}

func (i *IoTDBDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

func (i *IoTDBDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}

func (i *IoTDBDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	if i.session == nil {
		return fmt.Errorf("连接未打开")
	}
	if strings.TrimSpace(tableName) == "" {
		return fmt.Errorf("设备路径不能为空")
	}
	if len(changes.Updates) > 0 || len(changes.Deletes) > 0 {
		return fmt.Errorf("IoTDB 目标端当前仅支持 INSERT 写入，暂不支持 UPDATE/DELETE 差异同步")
	}
	for _, row := range changes.Inserts {
		sqlText, err := buildIoTDBInsertSQL(tableName, row)
		if err != nil {
			return err
		}
		if strings.TrimSpace(sqlText) == "" {
			continue
		}
		if _, err := i.Exec(sqlText); err != nil {
			return err
		}
	}
	return nil
}

func normalizeIoTDBConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	runConfig := applyIoTDBURI(config)
	if strings.TrimSpace(runConfig.Host) == "" {
		runConfig.Host = "localhost"
	}
	if runConfig.Port <= 0 {
		runConfig.Port = defaultIoTDBPort
	}
	if strings.TrimSpace(runConfig.User) == "" {
		runConfig.User = defaultIoTDBUser
	}
	if runConfig.Password == "" {
		runConfig.Password = defaultIoTDBPassword
	}
	return runConfig
}

func applyIoTDBURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	uriText := strings.TrimSpace(config.URI)
	if uriText == "" {
		return config
	}
	parsed, err := url.Parse(uriText)
	if err != nil {
		return config
	}
	scheme := strings.ToLower(strings.TrimSpace(parsed.Scheme))
	if scheme != "iotdb" {
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
	if host := strings.TrimSpace(parsed.Host); host != "" {
		if h, port, ok := parseHostPortWithDefault(host, defaultIoTDBPort); ok {
			config.Host = h
			config.Port = port
		}
	}
	if dbName := strings.Trim(strings.TrimSpace(parsed.Path), "/"); dbName != "" && strings.TrimSpace(config.Database) == "" {
		config.Database = dbName
	}
	return config
}

func iotdbConnectionParams(config connection.ConnectionConfig) url.Values {
	params := url.Values{}
	mergeConnectionParamValues(params, connectionParamsFromURI(config.URI, "iotdb"))
	mergeConnectionParamValues(params, connectionParamsFromText(config.ConnectionParams))
	return params
}

func (i *IoTDBDB) effectiveTimeout() time.Duration {
	if i.pingTimeout > 0 {
		return i.pingTimeout
	}
	return defaultIoTDBQueryTimeout
}

func scanIoTDBDataSet(ds iotdbDataSet) ([]map[string]interface{}, []string, error) {
	if ds == nil {
		return nil, nil, nil
	}
	defer ds.Close()
	columns := ds.GetColumnNames()
	rows := make([]map[string]interface{}, 0)
	for {
		hasNext, err := ds.Next()
		if err != nil {
			return nil, nil, err
		}
		if !hasNext {
			break
		}
		row := make(map[string]interface{}, len(columns))
		for _, column := range columns {
			isNull, err := ds.IsNull(column)
			if err == nil && isNull {
				row[column] = nil
				continue
			}
			value, err := ds.GetObject(column)
			if err != nil {
				row[column] = nil
				continue
			}
			row[column] = normalizeIoTDBValue(value)
		}
		rows = append(rows, row)
	}
	return rows, columns, nil
}

func normalizeIoTDBValue(value interface{}) interface{} {
	switch v := value.(type) {
	case time.Time:
		return v.Format(time.RFC3339Nano)
	case *iotdbclient.Binary:
		if v == nil {
			return nil
		}
		return v.GetStringValue()
	case fmt.Stringer:
		return v.String()
	default:
		return value
	}
}

func iotdbDevicePattern(dbName string) string {
	db := strings.Trim(strings.TrimSpace(dbName), ".")
	if db == "" {
		return ""
	}
	if strings.HasSuffix(db, ".**") || strings.HasSuffix(db, ".*") {
		return db
	}
	return db + ".**"
}

func iotdbTimeseriesPattern(device string) string {
	path := strings.Trim(strings.TrimSpace(device), ".")
	if path == "" {
		return "root.**"
	}
	if strings.HasSuffix(path, ".**") || strings.HasSuffix(path, ".*") {
		return path
	}
	return path + ".*"
}

func resolveIoTDBDevicePath(dbName, tableName string) string {
	table := strings.Trim(strings.TrimSpace(tableName), ".")
	if table == "" {
		return strings.Trim(strings.TrimSpace(dbName), ".")
	}
	if strings.HasPrefix(strings.ToLower(table), "root.") || strings.TrimSpace(dbName) == "" {
		return table
	}
	return strings.Trim(strings.TrimSpace(dbName), ".") + "." + table
}

func firstRowString(row map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		for actual, value := range row {
			if strings.EqualFold(actual, key) {
				text := strings.TrimSpace(fmt.Sprintf("%v", value))
				if text != "" && text != "<nil>" {
					return text
				}
			}
		}
	}
	return ""
}

func firstAnyRowString(row map[string]interface{}) string {
	keys := make([]string, 0, len(row))
	for key := range row {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		text := strings.TrimSpace(fmt.Sprintf("%v", row[key]))
		if text != "" && text != "<nil>" {
			return text
		}
	}
	return ""
}

func buildIoTDBInsertSQL(device string, row map[string]interface{}) (string, error) {
	path := strings.TrimSpace(device)
	if path == "" {
		return "", fmt.Errorf("设备路径不能为空")
	}
	timestamp, ok := iotdbTimestampValue(row)
	if !ok {
		return "", fmt.Errorf("IoTDB INSERT 行缺少 Time/time/timestamp 字段")
	}
	measurements := make([]string, 0, len(row))
	for key := range row {
		if strings.TrimSpace(key) == "" || isIoTDBTimestampColumn(key) {
			continue
		}
		measurements = append(measurements, key)
	}
	if len(measurements) == 0 {
		return "", nil
	}
	sort.Strings(measurements)

	columns := append([]string{"timestamp"}, measurements...)
	values := []string{iotdbTimestampLiteral(timestamp)}
	for _, measurement := range measurements {
		values = append(values, iotdbLiteral(row[measurement]))
	}
	return fmt.Sprintf("INSERT INTO %s(%s) VALUES(%s)", path, strings.Join(columns, ", "), strings.Join(values, ", ")), nil
}

func iotdbTimestampValue(row map[string]interface{}) (interface{}, bool) {
	for key, value := range row {
		if isIoTDBTimestampColumn(key) {
			return value, true
		}
	}
	return nil, false
}

func isIoTDBTimestampColumn(column string) bool {
	switch strings.ToLower(strings.TrimSpace(column)) {
	case "time", "timestamp", "_time":
		return true
	default:
		return false
	}
}

func iotdbTimestampLiteral(value interface{}) string {
	switch v := value.(type) {
	case time.Time:
		return strconv.FormatInt(v.UnixMilli(), 10)
	case string:
		text := strings.TrimSpace(v)
		if _, err := strconv.ParseInt(text, 10, 64); err == nil {
			return text
		}
		return iotdbLiteral(text)
	default:
		return fmt.Sprintf("%v", value)
	}
}

func iotdbLiteral(value interface{}) string {
	switch v := value.(type) {
	case nil:
		return "null"
	case bool:
		if v {
			return "true"
		}
		return "false"
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
		return fmt.Sprintf("%v", v)
	case time.Time:
		return strconv.FormatInt(v.UnixMilli(), 10)
	default:
		text := fmt.Sprintf("%v", v)
		return "'" + strings.ReplaceAll(text, "'", "''") + "'"
	}
}
