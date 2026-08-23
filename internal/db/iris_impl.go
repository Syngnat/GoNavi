//go:build gonavi_full_drivers || gonavi_iris_driver

package db

import (
	"context"
	"database/sql"
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

	_ "github.com/caretdev/go-irisnative"
)

const (
	defaultIRISPort      = 1972
	defaultIRISNamespace = "USER"
)

type IrisDB struct {
	conn        *sql.DB
	pingTimeout time.Duration
	namespace   string
	forwarder   *ssh.LocalForwarder
}

type irisTableRef struct {
	Schema string
	Table  string
}

func normalizeIRISNamespace(namespace string) string {
	trimmed := strings.Trim(strings.TrimSpace(namespace), "/")
	if trimmed == "" {
		return defaultIRISNamespace
	}
	return trimmed
}

func applyIRISURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	parsed, ok := parseConnectionURI(config.URI, "iris", "intersystems")
	if !ok || parsed == nil {
		return config
	}
	next := config
	if host := strings.TrimSpace(parsed.Hostname()); host != "" {
		next.Host = host
	}
	if portText := strings.TrimSpace(parsed.Port()); portText != "" {
		if port, err := strconv.Atoi(portText); err == nil && port > 0 {
			next.Port = port
		}
	}
	if parsed.User != nil {
		next.User = parsed.User.Username()
		if password, ok := parsed.User.Password(); ok {
			next.Password = password
		}
	}
	if namespace := strings.Trim(strings.TrimSpace(parsed.Path), "/"); namespace != "" {
		next.Database = namespace
	}
	return next
}

func (i *IrisDB) getDSN(config connection.ConnectionConfig) string {
	namespace := normalizeIRISNamespace(config.Database)
	port := config.Port
	if port <= 0 {
		port = defaultIRISPort
	}

	u := &url.URL{
		Scheme: "iris",
		Host:   net.JoinHostPort(config.Host, strconv.Itoa(port)),
		Path:   "/" + namespace,
	}
	u.User = url.UserPassword(config.User, config.Password)

	q := url.Values{}
	mergeConnectionParamsFromConfig(q, config, "iris", "intersystems")
	u.RawQuery = q.Encode()
	return u.String()
}

func (i *IrisDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = i.Close()
	defer func() {
		if err != nil {
			_ = i.Close()
		}
	}()

	runConfig := applyIRISURI(config)
	if runConfig.Port <= 0 {
		runConfig.Port = defaultIRISPort
	}
	i.namespace = normalizeIRISNamespace(runConfig.Database)

	if runConfig.UseSSH {
		logger.Infof("InterSystems IRIS 使用 SSH 连接：地址=%s:%d 用户=%s", runConfig.Host, runConfig.Port, runConfig.User)
		forwarder, err := ssh.AcquireLocalForwarder(runConfig.SSH, runConfig.Host, runConfig.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		i.forwarder = forwarder

		host, portStr, err := net.SplitHostPort(forwarder.LocalAddr)
		if err != nil {
			return fmt.Errorf("解析本地转发地址失败：%w", err)
		}
		port, err := strconv.Atoi(portStr)
		if err != nil {
			return fmt.Errorf("解析本地端口失败：%w", err)
		}

		runConfig.Host = host
		runConfig.Port = port
		runConfig.UseSSH = false
		logger.Infof("InterSystems IRIS 通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	}

	db, err := sql.Open("iris", i.getDSN(runConfig))
	if err != nil {
		return wrapDatabaseConnectionOpenError(err)
	}
	configureSQLConnectionPool(db, "iris")
	i.conn = db
	i.pingTimeout = getConnectTimeout(runConfig)
	if err := i.Ping(); err != nil {
		_ = db.Close()
		i.conn = nil
		return wrapDatabaseConnectionVerifyError(err)
	}
	return nil
}

func (i *IrisDB) Close() error {
	if i.forwarder != nil {
		if err := i.forwarder.Release(); err != nil {
			logger.Warnf("关闭 InterSystems IRIS SSH 端口转发失败：%v", err)
		}
		i.forwarder = nil
	}
	if i.conn != nil {
		return i.conn.Close()
	}
	return nil
}

func (i *IrisDB) Ping() error {
	if i.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	timeout := i.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	return i.conn.PingContext(ctx)
}

func (i *IrisDB) QueryMulti(query string) ([]connection.ResultSetData, error) {
	if i.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	rows, err := i.conn.QueryContext(metadataContextFor(i), query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMultiRows(rows)
}

func (i *IrisDB) QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error) {
	if i.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	rows, err := i.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMultiRows(rows)
}

func (i *IrisDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if i.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}
	rows, err := i.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (i *IrisDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if i.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}
	rows, err := i.conn.QueryContext(metadataContextFor(i), query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (i *IrisDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if i.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := i.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (i *IrisDB) ExecBatchContext(ctx context.Context, query string) (int64, error) {
	return i.ExecContext(ctx, query)
}

func (i *IrisDB) OpenSessionExecer(ctx context.Context) (StatementExecer, error) {
	if i.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	conn, err := i.conn.Conn(ctx)
	if err != nil {
		return nil, err
	}
	return NewSQLConnStatementExecer(conn), nil
}

func (i *IrisDB) Exec(query string) (int64, error) {
	if i.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := i.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (i *IrisDB) GetDatabases() ([]string, error) {
	namespace := strings.TrimSpace(i.namespace)
	if namespace != "" {
		return []string{namespace}, nil
	}
	data, _, err := i.Query(`SELECT DISTINCT TABLE_CATALOG FROM INFORMATION_SCHEMA.TABLES`)
	if err != nil {
		return nil, err
	}
	var namespaces []string
	seen := map[string]struct{}{}
	for _, row := range data {
		name := strings.TrimSpace(rowString(row, "TABLE_CATALOG", "table_catalog", "TABLECATALOG", "tablecatalog"))
		if name == "" {
			continue
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		namespaces = append(namespaces, name)
	}
	sort.Strings(namespaces)
	return namespaces, nil
}

func (i *IrisDB) GetTables(dbName string) ([]string, error) {
	data, _, err := i.Query(`SELECT * FROM INFORMATION_SCHEMA.TABLES`)
	if err != nil {
		return nil, err
	}
	var tables []string
	seen := map[string]struct{}{}
	for _, row := range data {
		tableType := strings.ToUpper(strings.TrimSpace(rowString(row, "TABLE_TYPE", "table_type", "TABLETYPE", "tabletype")))
		if tableType != "" && tableType != "TABLE" && tableType != "BASE TABLE" {
			continue
		}
		schema := strings.TrimSpace(rowString(row, "TABLE_SCHEMA", "table_schema", "SCHEMA_NAME", "schema_name", "TABLESCHEMA", "tableschema", "SCHEMANAME", "schemaname"))
		table := strings.TrimSpace(rowString(row, "TABLE_NAME", "table_name", "TABLENAME", "tablename"))
		if table == "" || isIRISSystemSchema(schema) {
			continue
		}
		name := table
		if schema != "" {
			name = schema + "." + table
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		tables = append(tables, name)
	}
	sort.Strings(tables)
	return tables, nil
}

func (i *IrisDB) GetCreateStatement(dbName, tableName string) (string, error) {
	ref, err := parseIRISTableRef(dbName, tableName)
	if err != nil {
		return "", err
	}
	columns, err := i.GetColumns(dbName, tableName)
	if err != nil {
		return "", err
	}
	if len(columns) == 0 {
		return "", fmt.Errorf("未找到表字段：%s", tableName)
	}
	indexes, idxErr := i.GetIndexes(dbName, tableName)
	if idxErr != nil {
		indexes = nil
	}
	return buildIRISCreateTableDDL(ref, columns, indexes), nil
}

func (i *IrisDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	ref, err := parseIRISTableRef(dbName, tableName)
	if err != nil {
		return nil, err
	}
	data, _, err := i.Query(buildIRISInfoSchemaWhereQuery("INFORMATION_SCHEMA.COLUMNS", ref))
	if err != nil {
		return nil, err
	}
	indexes, _ := i.GetIndexes(dbName, tableName)
	keyByColumn := irisColumnKeyMap(indexes)

	columns := make([]connection.ColumnDefinition, 0, len(data))
	for _, row := range data {
		name := strings.TrimSpace(rowString(row, "COLUMN_NAME", "column_name", "COLUMNNAME", "columnname"))
		if name == "" {
			continue
		}
		key := keyByColumn[name]
		if primary, ok := irisBoolFromRow(row, "PRIMARY_KEY", "primary_key", "PRIMARYKEY", "primarykey"); ok && primary {
			key = "PRI"
		} else if key == "" {
			if unique, ok := irisBoolFromRow(row, "UNIQUE_COLUMN", "unique_column", "UNIQUECOLUMN", "uniquecolumn", "IS_UNIQUE", "is_unique", "ISUNIQUE", "isunique", "UNIQUE", "unique"); ok && unique {
				key = "UNI"
			}
		}
		col := connection.ColumnDefinition{
			Name:     name,
			Type:     buildIRISColumnType(row),
			Nullable: normalizeIRISNullable(rowString(row, "IS_NULLABLE", "is_nullable", "ISNULLABLE", "isnullable")),
			Key:      key,
			Extra:    "",
			Comment:  rowString(row, "DESCRIPTION", "description", "COMMENT", "comment"),
		}
		if rawDefault, ok := rowValue(row, "COLUMN_DEFAULT", "column_default", "COLUMNDEFAULT", "columndefault"); ok && rawDefault != nil {
			def := strings.TrimSpace(fmt.Sprintf("%v", rawDefault))
			if def != "" {
				col.Default = &def
			}
		}
		columns = append(columns, col)
	}
	sort.SliceStable(columns, func(a, b int) bool {
		return rowOrdinal(data, columns[a].Name) < rowOrdinal(data, columns[b].Name)
	})
	return columns, nil
}

func (i *IrisDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	data, _, err := i.Query(`SELECT * FROM INFORMATION_SCHEMA.COLUMNS`)
	if err != nil {
		return nil, err
	}
	cols := make([]connection.ColumnDefinitionWithTable, 0, len(data))
	for _, row := range data {
		schema := strings.TrimSpace(rowString(row, "TABLE_SCHEMA", "table_schema", "TABLESCHEMA", "tableschema"))
		table := strings.TrimSpace(rowString(row, "TABLE_NAME", "table_name", "TABLENAME", "tablename"))
		name := strings.TrimSpace(rowString(row, "COLUMN_NAME", "column_name", "COLUMNNAME", "columnname"))
		if table == "" || name == "" || isIRISSystemSchema(schema) {
			continue
		}
		tableName := table
		if schema != "" {
			tableName = schema + "." + table
		}
		cols = append(cols, connection.ColumnDefinitionWithTable{
			TableName: tableName,
			Name:      name,
			Type:      buildIRISColumnType(row),
			Comment:   rowString(row, "DESCRIPTION", "description", "COMMENT", "comment"),
		})
	}
	sort.SliceStable(cols, func(a, b int) bool {
		if cols[a].TableName == cols[b].TableName {
			return cols[a].Name < cols[b].Name
		}
		return cols[a].TableName < cols[b].TableName
	})
	return cols, nil
}

func (i *IrisDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	ref, err := parseIRISTableRef(dbName, tableName)
	if err != nil {
		return nil, err
	}
	data, _, err := i.Query(buildIRISInfoSchemaWhereQuery("INFORMATION_SCHEMA.INDEXES", ref))
	if err != nil {
		return nil, err
	}
	indexes := make([]connection.IndexDefinition, 0, len(data))
	for _, row := range data {
		name := strings.TrimSpace(rowString(row, "INDEX_NAME", "index_name", "INDEXNAME", "indexname", "KEY_NAME", "key_name", "KEYNAME", "keyname", "CONSTRAINT_NAME", "constraint_name", "CONSTRAINTNAME", "constraintname"))
		column := strings.TrimSpace(rowString(row, "COLUMN_NAME", "column_name", "COLUMNNAME", "columnname"))
		primary, hasPrimaryFlag := irisBoolFromRow(row, "PRIMARY_KEY", "primary_key", "PRIMARYKEY", "primarykey")
		if name == "" && hasPrimaryFlag && primary {
			name = "PRIMARY"
		}
		if name == "" || column == "" {
			continue
		}
		indexType := normalizeIRISIndexType(rowString(row, "INDEX_TYPE", "index_type", "INDEXTYPE", "indextype", "TYPE", "type"))
		if hasPrimaryFlag && primary {
			indexType = "PRIMARY"
		}
		nonUnique := parseIRISNonUnique(row)
		indexes = append(indexes, connection.IndexDefinition{
			Name:       name,
			ColumnName: column,
			NonUnique:  nonUnique,
			SeqInIndex: parseIRISInt(rowValueAny(row, "ORDINAL_POSITION", "ordinal_position", "ORDINALPOSITION", "ordinalposition", "SEQ_IN_INDEX", "seq_in_index", "SEQININDEX", "seqinindex", "KEY_SEQ", "key_seq", "KEYSEQ", "keyseq")),
			IndexType:  indexType,
		})
	}
	sort.SliceStable(indexes, func(a, b int) bool {
		if indexes[a].Name == indexes[b].Name {
			return indexes[a].SeqInIndex < indexes[b].SeqInIndex
		}
		return indexes[a].Name < indexes[b].Name
	})
	return indexes, nil
}

func (i *IrisDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

func (i *IrisDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}

func (i *IrisDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	if i.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	tx, err := i.conn.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	for _, keys := range changes.Deletes {
		query, args, ok := buildIRISDeleteSQL(tableName, keys)
		if !ok {
			continue
		}
		res, err := tx.Exec(query, args...)
		if err != nil {
			return fmt.Errorf("删除失败：%v", err)
		}
		if err := requireSingleRowAffected(res, rowMutationActionDelete); err != nil {
			return err
		}
	}

	for _, update := range changes.Updates {
		query, args, ok, err := buildIRISUpdateSQL(tableName, update)
		if err != nil {
			return err
		}
		if !ok {
			continue
		}
		res, err := tx.Exec(query, args...)
		if err != nil {
			return fmt.Errorf("更新失败：%v", err)
		}
		if err := requireSingleRowAffected(res, rowMutationActionUpdate); err != nil {
			return err
		}
	}

	for _, row := range changes.Inserts {
		query, args, ok := buildIRISInsertSQL(tableName, row)
		if !ok {
			continue
		}
		res, err := tx.Exec(query, args...)
		if err != nil {
			return fmt.Errorf("插入失败：%v", err)
		}
		if affected, err := res.RowsAffected(); err == nil && affected == 0 {
			return fmt.Errorf("插入未生效：未影响任何行")
		}
	}

	return tx.Commit()
}

func buildIRISInfoSchemaWhereQuery(table string, ref irisTableRef) string {
	conditions := []string{fmt.Sprintf("TABLE_NAME = '%s'", irisSQLLiteral(ref.Table))}
	if ref.Schema != "" {
		conditions = append(conditions, fmt.Sprintf("TABLE_SCHEMA = '%s'", irisSQLLiteral(ref.Schema)))
	}
	orderBy := ""
	switch strings.ToUpper(strings.TrimSpace(table)) {
	case "INFORMATION_SCHEMA.COLUMNS":
		orderBy = " ORDER BY ORDINAL_POSITION"
	case "INFORMATION_SCHEMA.INDEXES":
		orderBy = " ORDER BY INDEX_NAME, ORDINAL_POSITION"
	}
	return fmt.Sprintf("SELECT * FROM %s WHERE %s%s", table, strings.Join(conditions, " AND "), orderBy)
}

func parseIRISTableRef(defaultSchema, raw string) (irisTableRef, error) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return irisTableRef{}, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}
	if schemaPart, tablePart, ok := splitIRISTablePath(text); ok {
		schema := cleanIRISIdentifier(schemaPart)
		table := cleanIRISIdentifier(tablePart)
		if table == "" {
			return irisTableRef{}, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
		}
		return irisTableRef{Schema: schema, Table: table}, nil
	}
	return irisTableRef{Schema: cleanIRISIdentifier(defaultSchema), Table: cleanIRISIdentifier(text)}, nil
}

func splitIRISTablePath(raw string) (schemaPart, tablePart string, ok bool) {
	inQuote := false
	for idx := 0; idx < len(raw); idx++ {
		switch raw[idx] {
		case '"':
			if inQuote && idx+1 < len(raw) && raw[idx+1] == '"' {
				idx++
				continue
			}
			inQuote = !inQuote
		case '.':
			if !inQuote {
				return raw[:idx], raw[idx+1:], true
			}
		}
	}
	return "", raw, false
}

func cleanIRISIdentifier(raw string) string {
	text := strings.TrimSpace(raw)
	text = strings.Trim(text, `"`)
	return strings.ReplaceAll(text, `""`, `"`)
}

func irisSQLLiteral(raw string) string {
	return strings.ReplaceAll(raw, "'", "''")
}

func irisQuoteIdent(name string) string {
	text := cleanIRISIdentifier(name)
	text = strings.ReplaceAll(text, `"`, `""`)
	return `"` + text + `"`
}

func irisQuoteTable(raw string) string {
	ref, err := parseIRISTableRef("", raw)
	if err != nil {
		return irisQuoteIdent(raw)
	}
	if ref.Schema != "" {
		return irisQuoteIdent(ref.Schema) + "." + irisQuoteIdent(ref.Table)
	}
	return irisQuoteIdent(ref.Table)
}

func isIRISSystemSchema(schema string) bool {
	normalized := strings.ToUpper(strings.TrimSpace(schema))
	return normalized == "INFORMATION_SCHEMA" ||
		strings.HasPrefix(normalized, "%") ||
		strings.HasPrefix(normalized, "SYS")
}

func rowValue(row map[string]interface{}, keys ...string) (interface{}, bool) {
	for _, key := range keys {
		if value, ok := row[key]; ok {
			return value, true
		}
		for existing, value := range row {
			if strings.EqualFold(existing, key) {
				return value, true
			}
		}
	}
	return nil, false
}

func rowValueAny(row map[string]interface{}, keys ...string) interface{} {
	value, _ := rowValue(row, keys...)
	return value
}

func rowString(row map[string]interface{}, keys ...string) string {
	value, ok := rowValue(row, keys...)
	if !ok || value == nil {
		return ""
	}
	return fmt.Sprintf("%v", value)
}

func parseIRISInt(value interface{}) int {
	switch v := value.(type) {
	case int:
		return v
	case int32:
		return int(v)
	case int64:
		return int(v)
	case float64:
		return int(v)
	case string:
		n, _ := strconv.Atoi(strings.TrimSpace(v))
		return n
	default:
		n, _ := strconv.Atoi(strings.TrimSpace(fmt.Sprintf("%v", value)))
		return n
	}
}

func parseIRISBool(value interface{}) (bool, bool) {
	switch v := value.(type) {
	case bool:
		return v, true
	case int:
		return v != 0, true
	case int64:
		return v != 0, true
	case float64:
		return v != 0, true
	case string:
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "1", "true", "t", "yes", "y":
			return true, true
		case "0", "false", "f", "no", "n":
			return false, true
		}
	}
	return false, false
}

func irisBoolFromRow(row map[string]interface{}, keys ...string) (bool, bool) {
	value, ok := rowValue(row, keys...)
	if !ok {
		return false, false
	}
	return parseIRISBool(value)
}

func parseIRISNonUnique(row map[string]interface{}) int {
	if primary, ok := irisBoolFromRow(row, "PRIMARY_KEY", "primary_key", "PRIMARYKEY", "primarykey"); ok && primary {
		return 0
	}
	if value, ok := rowValue(row, "NON_UNIQUE", "non_unique", "NONUNIQUE", "nonunique"); ok {
		if enabled, ok := parseIRISBool(value); ok {
			if enabled {
				return 1
			}
			return 0
		}
		n := parseIRISInt(value)
		if n != 0 {
			return 1
		}
		return 0
	}
	if value, ok := rowValue(row, "IS_UNIQUE", "is_unique", "UNIQUE", "unique"); ok {
		if unique, ok := parseIRISBool(value); ok && unique {
			return 0
		}
	}
	if unique, ok := irisBoolFromRow(row, "UNIQUE_COLUMN", "unique_column", "UNIQUECOLUMN", "uniquecolumn"); ok && unique {
		return 0
	}
	return 1
}

func normalizeIRISIndexType(raw string) string {
	text := strings.ToUpper(strings.TrimSpace(raw))
	if text == "" {
		return "BTREE"
	}
	return text
}

func normalizeIRISNullable(raw string) string {
	switch strings.ToUpper(strings.TrimSpace(raw)) {
	case "NO", "N", "FALSE", "0":
		return "NO"
	default:
		return "YES"
	}
}

func buildIRISColumnType(row map[string]interface{}) string {
	dataType := strings.TrimSpace(rowString(row, "DATA_TYPE", "data_type", "DATATYPE", "datatype", "TYPE_NAME", "type_name", "TYPENAME", "typename"))
	if dataType == "" {
		dataType = "VARCHAR"
	}
	upper := strings.ToUpper(dataType)
	charLength := parseIRISInt(rowValueAny(row, "CHARACTER_MAXIMUM_LENGTH", "character_maximum_length", "CHARACTERMAXIMUMLENGTH", "charactermaximumlength", "CHARACTER_MAX_LENGTH", "character_max_length", "CHARACTERMAXLENGTH", "charactermaxlength"))
	precision := parseIRISInt(rowValueAny(row, "NUMERIC_PRECISION", "numeric_precision", "NUMERICPRECISION", "numericprecision"))
	scale := parseIRISInt(rowValueAny(row, "NUMERIC_SCALE", "numeric_scale", "NUMERICSCALE", "numericscale"))
	if charLength > 0 && (strings.Contains(upper, "CHAR") || strings.Contains(upper, "VARCHAR")) && !strings.Contains(dataType, "(") {
		return fmt.Sprintf("%s(%d)", dataType, charLength)
	}
	if precision > 0 && (strings.Contains(upper, "NUMERIC") || strings.Contains(upper, "DECIMAL") || strings.Contains(upper, "NUMBER")) && !strings.Contains(dataType, "(") {
		if scale > 0 {
			return fmt.Sprintf("%s(%d,%d)", dataType, precision, scale)
		}
		return fmt.Sprintf("%s(%d)", dataType, precision)
	}
	return dataType
}

func rowOrdinal(rows []map[string]interface{}, columnName string) int {
	for idx, row := range rows {
		if strings.EqualFold(rowString(row, "COLUMN_NAME", "column_name", "COLUMNNAME", "columnname"), columnName) {
			ordinal := parseIRISInt(rowValueAny(row, "ORDINAL_POSITION", "ordinal_position", "ORDINALPOSITION", "ordinalposition"))
			if ordinal > 0 {
				return ordinal
			}
			return idx + 1
		}
	}
	return len(rows) + 1
}

func irisColumnKeyMap(indexes []connection.IndexDefinition) map[string]string {
	result := map[string]string{}
	for _, idx := range indexes {
		column := strings.TrimSpace(idx.ColumnName)
		if column == "" {
			continue
		}
		if isIRISPrimaryIndex(idx) {
			result[column] = "PRI"
			continue
		}
		if idx.NonUnique == 0 && result[column] == "" {
			result[column] = "UNI"
		}
	}
	return result
}

func isIRISPrimaryIndexName(name string) bool {
	normalized := strings.ToUpper(strings.TrimSpace(name))
	return normalized == "PRIMARY" || normalized == "PRIMARYKEY" || normalized == "IDKEY"
}

func isIRISPrimaryIndex(idx connection.IndexDefinition) bool {
	return isIRISPrimaryIndexName(idx.Name) || strings.EqualFold(strings.TrimSpace(idx.IndexType), "PRIMARY")
}

func buildIRISCreateTableDDL(ref irisTableRef, columns []connection.ColumnDefinition, indexes []connection.IndexDefinition) string {
	qualified := irisQuoteIdent(ref.Table)
	if strings.TrimSpace(ref.Schema) != "" {
		qualified = irisQuoteIdent(ref.Schema) + "." + qualified
	}

	lines := make([]string, 0, len(columns)+1)
	primaryColumns := irisPrimaryColumns(indexes)
	if len(primaryColumns) == 0 {
		primaryColumns = irisPrimaryColumnsFromColumns(columns)
	}
	for _, col := range columns {
		line := fmt.Sprintf("  %s %s", irisQuoteIdent(col.Name), strings.TrimSpace(col.Type))
		if col.Default != nil && strings.TrimSpace(*col.Default) != "" {
			line += " DEFAULT " + strings.TrimSpace(*col.Default)
		}
		if strings.EqualFold(strings.TrimSpace(col.Nullable), "NO") {
			line += " NOT NULL"
		}
		lines = append(lines, line)
	}
	if len(primaryColumns) > 0 {
		lines = append(lines, fmt.Sprintf("  PRIMARY KEY (%s)", irisQuoteIdentList(primaryColumns)))
	}

	var b strings.Builder
	b.WriteString(fmt.Sprintf("CREATE TABLE %s (\n%s\n);", qualified, strings.Join(lines, ",\n")))

	for _, stmt := range buildIRISCreateIndexStatements(ref, indexes) {
		b.WriteString("\n\n")
		b.WriteString(stmt)
	}
	return b.String()
}

func irisPrimaryColumns(indexes []connection.IndexDefinition) []string {
	for _, group := range groupIRISIndexes(indexes) {
		if group.Primary {
			return group.Columns
		}
	}
	return nil
}

func irisPrimaryColumnsFromColumns(columns []connection.ColumnDefinition) []string {
	primaryColumns := make([]string, 0)
	for _, column := range columns {
		if strings.EqualFold(strings.TrimSpace(column.Key), "PRI") && strings.TrimSpace(column.Name) != "" {
			primaryColumns = append(primaryColumns, column.Name)
		}
	}
	return primaryColumns
}

type irisIndexGroup struct {
	Name      string
	Columns   []string
	NonUnique int
	IndexType string
	Primary   bool
}

func groupIRISIndexes(indexes []connection.IndexDefinition) []irisIndexGroup {
	groupsByName := map[string]*irisIndexGroup{}
	order := make([]string, 0)
	for _, idx := range indexes {
		name := strings.TrimSpace(idx.Name)
		column := strings.TrimSpace(idx.ColumnName)
		if name == "" || column == "" {
			continue
		}
		group, ok := groupsByName[name]
		if !ok {
			group = &irisIndexGroup{Name: name, NonUnique: idx.NonUnique, IndexType: idx.IndexType}
			groupsByName[name] = group
			order = append(order, name)
		}
		group.Columns = append(group.Columns, column)
		if idx.NonUnique == 0 {
			group.NonUnique = 0
		}
		if isIRISPrimaryIndex(idx) {
			group.Primary = true
		}
	}
	sort.Strings(order)
	groups := make([]irisIndexGroup, 0, len(order))
	for _, name := range order {
		group := groupsByName[name]
		groups = append(groups, *group)
	}
	return groups
}

func buildIRISCreateIndexStatements(ref irisTableRef, indexes []connection.IndexDefinition) []string {
	qualified := irisQuoteIdent(ref.Table)
	if strings.TrimSpace(ref.Schema) != "" {
		qualified = irisQuoteIdent(ref.Schema) + "." + qualified
	}
	var statements []string
	for _, group := range groupIRISIndexes(indexes) {
		if len(group.Columns) == 0 || group.Primary {
			continue
		}
		unique := ""
		if group.NonUnique == 0 {
			unique = "UNIQUE "
		}
		statements = append(statements, fmt.Sprintf("CREATE %sINDEX %s ON %s (%s);", unique, irisQuoteIdent(group.Name), qualified, irisQuoteIdentList(group.Columns)))
	}
	return statements
}

func irisQuoteIdentList(columns []string) string {
	quoted := make([]string, 0, len(columns))
	for _, column := range columns {
		quoted = append(quoted, irisQuoteIdent(column))
	}
	return strings.Join(quoted, ", ")
}

func buildIRISDeleteSQL(tableName string, keys map[string]interface{}) (string, []interface{}, bool) {
	wheres, args := irisAssignments(keys, " = ?")
	if len(wheres) == 0 {
		return "", nil, false
	}
	return fmt.Sprintf("DELETE FROM %s WHERE %s", irisQuoteTable(tableName), strings.Join(wheres, " AND ")), args, true
}

func buildIRISUpdateSQL(tableName string, update connection.UpdateRow) (string, []interface{}, bool, error) {
	sets, args := irisAssignments(update.Values, " = ?")
	if len(sets) == 0 {
		return "", nil, false, nil
	}
	wheres, whereArgs := irisAssignments(update.Keys, " = ?")
	if len(wheres) == 0 {
		return "", nil, false, fmt.Errorf("更新操作需要主键条件")
	}
	args = append(args, whereArgs...)
	return fmt.Sprintf("UPDATE %s SET %s WHERE %s", irisQuoteTable(tableName), strings.Join(sets, ", "), strings.Join(wheres, " AND ")), args, true, nil
}

func buildIRISInsertSQL(tableName string, row map[string]interface{}) (string, []interface{}, bool) {
	if len(row) == 0 {
		return "", nil, false
	}
	keys := sortedMapKeys(row)
	cols := make([]string, 0, len(keys))
	placeholders := make([]string, 0, len(keys))
	args := make([]interface{}, 0, len(keys))
	for _, key := range keys {
		cols = append(cols, irisQuoteIdent(key))
		placeholders = append(placeholders, "?")
		args = append(args, row[key])
	}
	return fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", irisQuoteTable(tableName), strings.Join(cols, ", "), strings.Join(placeholders, ", ")), args, true
}

func irisAssignments(values map[string]interface{}, suffix string) ([]string, []interface{}) {
	keys := sortedMapKeys(values)
	parts := make([]string, 0, len(keys))
	args := make([]interface{}, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, irisQuoteIdent(key)+suffix)
		args = append(args, values[key])
	}
	return parts, args
}

func sortedMapKeys(values map[string]interface{}) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		if strings.TrimSpace(key) != "" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	return keys
}
