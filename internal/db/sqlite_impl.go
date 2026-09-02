//go:build gonavi_full_drivers || gonavi_sqlite_driver

package db

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/utils"

	_ "modernc.org/sqlite"
)

type SQLiteDB struct {
	conn        *sql.DB
	pingTimeout time.Duration
}

var _ BatchApplierContext = (*SQLiteDB)(nil)

func escapeSQLiteStringLiteral(value string) string {
	return strings.ReplaceAll(value, "'", "''")
}

func (s *SQLiteDB) Connect(config connection.ConnectionConfig) error {
	dsn, err := resolveSQLiteDSN(config)
	if err != nil {
		return err
	}
	if err := ensureSQLiteParentDir(dsn); err != nil {
		return err
	}

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return wrapDatabaseConnectionOpenError(err)
	}
	configureSQLConnectionPool(db, "sqlite")
	s.conn = db
	s.pingTimeout = getConnectTimeout(config)

	// Force verification
	if err := s.Ping(); err != nil {
		_ = db.Close()
		s.conn = nil
		return wrapDatabaseConnectionVerifyError(err)
	}
	return nil
}

func resolveSQLiteDSN(config connection.ConnectionConfig) (string, error) {
	dsn := strings.TrimSpace(config.Host)
	if dsn == "" {
		dsn = strings.TrimSpace(config.Database)
	}
	dsn = normalizeSQLitePath(dsn)
	if dsn == "" {
		return "", localizedDatabaseRuntimeError("db.backend.error.sqlite_file_path_required", nil)
	}
	if strings.EqualFold(dsn, ":memory:") {
		return dsn, nil
	}
	if looksLikeHostPort(dsn) {
		return "", localizedDatabaseRuntimeError("db.backend.error.sqlite_host_port_not_file_path", map[string]any{"dsn": dsn})
	}
	return dsn, nil
}

func normalizeSQLitePath(raw string) string {
	text := strings.TrimSpace(raw)
	if strings.HasPrefix(text, "/") && len(text) > 3 && isWindowsDrivePath(text[1:]) {
		text = text[1:]
	}
	if isWindowsDrivePath(text) {
		text = trimLegacyPortSuffix(text)
	}
	return text
}

func isWindowsDrivePath(path string) bool {
	if len(path) < 3 {
		return false
	}
	drive := path[0]
	if !((drive >= 'a' && drive <= 'z') || (drive >= 'A' && drive <= 'Z')) {
		return false
	}
	if path[1] != ':' {
		return false
	}
	sep := path[2]
	return sep == '\\' || sep == '/'
}

func trimLegacyPortSuffix(path string) string {
	normalized := path
	for {
		idx := strings.LastIndex(normalized, ":")
		if idx <= 1 || idx+1 >= len(normalized) {
			return normalized
		}
		suffix := normalized[idx+1:]
		validDigits := true
		for _, ch := range suffix {
			if ch < '0' || ch > '9' {
				validDigits = false
				break
			}
		}
		if !validDigits {
			return normalized
		}
		normalized = normalized[:idx]
	}
}

func looksLikeHostPort(raw string) bool {
	text := strings.TrimSpace(raw)
	if text == "" {
		return false
	}
	if strings.ContainsAny(text, `/\`) {
		return false
	}
	if strings.HasPrefix(strings.ToLower(text), "file:") {
		return false
	}
	if strings.HasPrefix(text, "[") {
		closing := strings.LastIndex(text, "]")
		if closing <= 0 || closing+1 >= len(text) {
			return false
		}
		portText := strings.TrimSpace(strings.TrimPrefix(text[closing+1:], ":"))
		return isValidPortText(portText)
	}
	if strings.Count(text, ":") != 1 {
		return false
	}
	split := strings.LastIndex(text, ":")
	if split <= 0 || split+1 >= len(text) {
		return false
	}
	return isValidPortText(strings.TrimSpace(text[split+1:]))
}

func isValidPortText(text string) bool {
	port, err := strconv.Atoi(text)
	return err == nil && port > 0 && port <= 65535
}

func ensureSQLiteParentDir(dsn string) error {
	text := strings.TrimSpace(dsn)
	if text == "" || strings.EqualFold(text, ":memory:") {
		return nil
	}
	// file: URI 由驱动处理，避免在这里误判路径格式。
	if strings.HasPrefix(strings.ToLower(text), "file:") {
		return nil
	}
	path := text
	if idx := strings.Index(path, "?"); idx >= 0 {
		path = path[:idx]
	}
	path = strings.TrimSpace(path)
	if path == "" {
		return nil
	}
	dir := filepath.Dir(path)
	if dir == "." || dir == "" {
		return nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("创建 SQLite 数据文件目录失败：%w", err)
	}
	return nil
}

func (s *SQLiteDB) Close() error {
	if s.conn != nil {
		return s.conn.Close()
	}
	return nil
}

func (s *SQLiteDB) Ping() error {
	if s.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	timeout := s.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	return s.conn.PingContext(ctx)
}

func (s *SQLiteDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if s.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}

	rows, err := s.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	return scanRows(rows)
}

func (s *SQLiteDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if s.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}

	rows, err := s.conn.QueryContext(metadataContextFor(s), query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (s *SQLiteDB) ExecBatchContext(ctx context.Context, query string) (int64, error) {
	if s.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := s.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *SQLiteDB) OpenSessionExecer(ctx context.Context) (StatementExecer, error) {
	if s.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	conn, err := s.conn.Conn(ctx)
	if err != nil {
		return nil, err
	}
	return NewSQLConnStatementExecer(conn), nil
}

func (s *SQLiteDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if s.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := s.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *SQLiteDB) Exec(query string) (int64, error) {
	if s.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := s.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *SQLiteDB) GetDatabases() ([]string, error) {
	return []string{"main"}, nil
}

func (s *SQLiteDB) GetTables(dbName string) ([]string, error) {
	query := "SELECT name FROM sqlite_master WHERE type='table'"
	data, _, err := s.Query(query)
	if err != nil {
		return nil, err
	}

	var tables []string
	for _, row := range data {
		if val, ok := row["name"]; ok {
			tables = append(tables, fmt.Sprintf("%v", val))
		}
	}
	return tables, nil
}

func (s *SQLiteDB) GetTableRowCounts(_ string, tables []string) (map[string]int64, error) {
	return getSQLiteTableRowCounts(s.Query, tables)
}

func (s *SQLiteDB) GetCreateStatement(dbName, tableName string) (string, error) {
	query := fmt.Sprintf("SELECT sql FROM sqlite_master WHERE type='table' AND name='%s'", escapeSQLiteStringLiteral(tableName))
	data, _, err := s.Query(query)
	if err != nil {
		return "", err
	}
	if len(data) > 0 {
		if val, ok := data[0]["sql"]; ok {
			return fmt.Sprintf("%v", val), nil
		}
	}
	return "", localizedDatabaseRuntimeError("db.backend.error.create_table_statement_not_found", nil)
}

func (s *SQLiteDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	return s.getColumnsContext(metadataContextFor(s), dbName, tableName)
}

func (s *SQLiteDB) GetColumnsContext(ctx context.Context, dbName, tableName string) ([]connection.ColumnDefinition, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	return s.getColumnsContext(ctx, dbName, tableName)
}

func (s *SQLiteDB) getColumnsContext(ctx context.Context, dbName, tableName string) ([]connection.ColumnDefinition, error) {
	table := strings.TrimSpace(tableName)
	if table == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}

	// cid, name, type, notnull, dflt_value, pk
	data, _, err := s.QueryContext(ctx, fmt.Sprintf("PRAGMA table_info('%s')", escapeSQLiteStringLiteral(table)))
	if err != nil {
		return nil, err
	}

	parseInt := func(v interface{}) int {
		switch val := v.(type) {
		case int:
			return val
		case int64:
			return int(val)
		case float64:
			return int(val)
		case string:
			var n int
			_, _ = fmt.Sscanf(strings.TrimSpace(val), "%d", &n)
			return n
		default:
			var n int
			_, _ = fmt.Sscanf(strings.TrimSpace(fmt.Sprintf("%v", v)), "%d", &n)
			return n
		}
	}

	getStr := func(row map[string]interface{}, key string) string {
		if v, ok := row[key]; ok && v != nil {
			return fmt.Sprintf("%v", v)
		}
		if v, ok := row[strings.ToUpper(key)]; ok && v != nil {
			return fmt.Sprintf("%v", v)
		}
		return ""
	}

	var columns []connection.ColumnDefinition
	for _, row := range data {
		notnull := 0
		if v, ok := row["notnull"]; ok && v != nil {
			notnull = parseInt(v)
		} else if v, ok := row["NOTNULL"]; ok && v != nil {
			notnull = parseInt(v)
		}

		pk := 0
		if v, ok := row["pk"]; ok && v != nil {
			pk = parseInt(v)
		} else if v, ok := row["PK"]; ok && v != nil {
			pk = parseInt(v)
		}

		nullable := "YES"
		if notnull == 1 {
			nullable = "NO"
		}

		key := ""
		if pk == 1 {
			key = "PRI"
		}

		col := connection.ColumnDefinition{
			Name:     getStr(row, "name"),
			Type:     getStr(row, "type"),
			Nullable: nullable,
			Key:      key,
			Extra:    "",
			Comment:  "",
		}

		if v, ok := row["dflt_value"]; ok && v != nil {
			def := fmt.Sprintf("%v", v)
			col.Default = &def
		} else if v, ok := row["DFLT_VALUE"]; ok && v != nil {
			def := fmt.Sprintf("%v", v)
			col.Default = &def
		}

		columns = append(columns, col)
	}
	return columns, nil
}

func (s *SQLiteDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	table := strings.TrimSpace(tableName)
	if table == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}

	parseInt := func(v interface{}) int {
		switch val := v.(type) {
		case int:
			return val
		case int64:
			return int(val)
		case float64:
			return int(val)
		case string:
			var n int
			_, _ = fmt.Sscanf(strings.TrimSpace(val), "%d", &n)
			return n
		default:
			var n int
			_, _ = fmt.Sscanf(strings.TrimSpace(fmt.Sprintf("%v", v)), "%d", &n)
			return n
		}
	}

	data, _, err := s.Query(fmt.Sprintf("PRAGMA index_list('%s')", escapeSQLiteStringLiteral(table)))
	if err != nil {
		return nil, err
	}

	var indexes []connection.IndexDefinition
	for _, row := range data {
		indexName := ""
		if v, ok := row["name"]; ok && v != nil {
			indexName = fmt.Sprintf("%v", v)
		} else if v, ok := row["NAME"]; ok && v != nil {
			indexName = fmt.Sprintf("%v", v)
		}
		if strings.TrimSpace(indexName) == "" {
			continue
		}

		unique := 0
		if v, ok := row["unique"]; ok && v != nil {
			unique = parseInt(v)
		} else if v, ok := row["UNIQUE"]; ok && v != nil {
			unique = parseInt(v)
		}
		nonUnique := 1
		if unique == 1 {
			nonUnique = 0
		}

		cols, _, err := s.Query(fmt.Sprintf("PRAGMA index_info('%s')", escapeSQLiteStringLiteral(indexName)))
		if err != nil {
			// skip broken index
			continue
		}

		for _, c := range cols {
			colName := ""
			if v, ok := c["name"]; ok && v != nil {
				colName = fmt.Sprintf("%v", v)
			} else if v, ok := c["NAME"]; ok && v != nil {
				colName = fmt.Sprintf("%v", v)
			}
			if strings.TrimSpace(colName) == "" {
				continue
			}

			seq := 0
			if v, ok := c["seqno"]; ok && v != nil {
				seq = parseInt(v) + 1
			} else if v, ok := c["SEQNO"]; ok && v != nil {
				seq = parseInt(v) + 1
			}

			indexes = append(indexes, connection.IndexDefinition{
				Name:       indexName,
				ColumnName: colName,
				NonUnique:  nonUnique,
				SeqInIndex: seq,
				IndexType:  "BTREE",
			})
		}
	}

	return indexes, nil
}

func (s *SQLiteDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	table := strings.TrimSpace(tableName)
	if table == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}

	data, _, err := s.Query(fmt.Sprintf("PRAGMA foreign_key_list('%s')", escapeSQLiteStringLiteral(table)))
	if err != nil {
		return nil, err
	}

	parseInt := func(v interface{}) int {
		switch val := v.(type) {
		case int:
			return val
		case int64:
			return int(val)
		case float64:
			return int(val)
		case string:
			var n int
			_, _ = fmt.Sscanf(strings.TrimSpace(val), "%d", &n)
			return n
		default:
			var n int
			_, _ = fmt.Sscanf(strings.TrimSpace(fmt.Sprintf("%v", v)), "%d", &n)
			return n
		}
	}

	var fks []connection.ForeignKeyDefinition
	for _, row := range data {
		id := 0
		if v, ok := row["id"]; ok && v != nil {
			id = parseInt(v)
		} else if v, ok := row["ID"]; ok && v != nil {
			id = parseInt(v)
		}

		refTable := ""
		if v, ok := row["table"]; ok && v != nil {
			refTable = fmt.Sprintf("%v", v)
		} else if v, ok := row["TABLE"]; ok && v != nil {
			refTable = fmt.Sprintf("%v", v)
		}

		fromCol := ""
		if v, ok := row["from"]; ok && v != nil {
			fromCol = fmt.Sprintf("%v", v)
		} else if v, ok := row["FROM"]; ok && v != nil {
			fromCol = fmt.Sprintf("%v", v)
		}

		toCol := ""
		if v, ok := row["to"]; ok && v != nil {
			toCol = fmt.Sprintf("%v", v)
		} else if v, ok := row["TO"]; ok && v != nil {
			toCol = fmt.Sprintf("%v", v)
		}

		name := fmt.Sprintf("fk_%s_%d", table, id)
		fks = append(fks, connection.ForeignKeyDefinition{
			Name:           name,
			ColumnName:     fromCol,
			RefTableName:   refTable,
			RefColumnName:  toCol,
			ConstraintName: name,
		})
	}
	return fks, nil
}

func (s *SQLiteDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	table := strings.TrimSpace(tableName)
	if table == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}

	data, _, err := s.Query(fmt.Sprintf("SELECT name AS trigger_name, sql AS statement FROM sqlite_master WHERE type='trigger' AND tbl_name='%s' ORDER BY name", escapeSQLiteStringLiteral(table)))
	if err != nil {
		return nil, err
	}

	var triggers []connection.TriggerDefinition
	for _, row := range data {
		name := fmt.Sprintf("%v", row["trigger_name"])
		stmt := ""
		if v, ok := row["statement"]; ok && v != nil {
			stmt = fmt.Sprintf("%v", v)
		}

		upper := strings.ToUpper(stmt)
		timing := ""
		switch {
		case strings.Contains(upper, " BEFORE "):
			timing = "BEFORE"
		case strings.Contains(upper, " AFTER "):
			timing = "AFTER"
		case strings.Contains(upper, " INSTEAD OF "):
			timing = "INSTEAD OF"
		}

		event := ""
		switch {
		case strings.Contains(upper, " INSERT "):
			event = "INSERT"
		case strings.Contains(upper, " UPDATE "):
			event = "UPDATE"
		case strings.Contains(upper, " DELETE "):
			event = "DELETE"
		}

		triggers = append(triggers, connection.TriggerDefinition{
			Name:      name,
			Timing:    timing,
			Event:     event,
			Statement: stmt,
		})
	}
	return triggers, nil
}

func (s *SQLiteDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return s.ApplyChangesContext(context.Background(), tableName, changes)
}

func (s *SQLiteDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) (err error) {
	if s.conn == nil {
		return fmt.Errorf("连接未打开")
	}

	tx, err := s.conn.BeginTx(ctx, nil)
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
		for k, v := range pk {
			wheres = append(wheres, fmt.Sprintf("%s = ?", quoteIdent(k)))
			args = append(args, v)
		}
		if len(wheres) == 0 {
			continue
		}
		query := fmt.Sprintf("DELETE FROM %s WHERE %s", qualifiedTable, strings.Join(wheres, " AND "))
		if _, err := tx.ExecContext(ctx, query, args...); err != nil {
			return fmt.Errorf("删除失败：%v", err)
		}
	}

	// 2. Updates
	for _, update := range changes.Updates {
		var sets []string
		var args []interface{}

		for k, v := range update.Values {
			sets = append(sets, fmt.Sprintf("%s = ?", quoteIdent(k)))
			args = append(args, v)
		}

		if len(sets) == 0 {
			continue
		}

		var wheres []string
		for k, v := range update.Keys {
			wheres = append(wheres, fmt.Sprintf("%s = ?", quoteIdent(k)))
			args = append(args, v)
		}

		if len(wheres) == 0 {
			return fmt.Errorf("更新操作需要主键条件")
		}

		query := fmt.Sprintf("UPDATE %s SET %s WHERE %s", qualifiedTable, strings.Join(sets, ", "), strings.Join(wheres, " AND "))
		if _, err := tx.ExecContext(ctx, query, args...); err != nil {
			return fmt.Errorf("更新失败：%v", err)
		}
	}

	if err := execParameterizedInsertBatches(parameterizedInsertConfig{
		Table:       qualifiedTable,
		Rows:        changes.Inserts,
		QuoteColumn: quoteIdent,
		Placeholder: func(int) string { return "?" },
		Exec: func(query string, args ...interface{}) (sql.Result, error) {
			return tx.ExecContext(ctx, query, args...)
		},
		MaxArgs: sqliteBatchInsertArgs,
	}); err != nil {
		return err
	}

	if err := commitWriteTransaction(tx); err != nil {
		return err
	}
	transactionCommitted = true
	return nil
}

func (s *SQLiteDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	tables, err := s.GetTables(dbName)
	if err != nil {
		return nil, err
	}

	var cols []connection.ColumnDefinitionWithTable
	var failures []MetadataObjectFailure
	for _, table := range tables {
		// Skip internal tables
		if strings.HasPrefix(strings.ToLower(table), "sqlite_") {
			continue
		}
		columns, err := s.GetColumns("", table)
		if err != nil {
			failures = append(failures, MetadataObjectFailure{ObjectName: table, Err: err})
			continue
		}
		for _, col := range columns {
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
