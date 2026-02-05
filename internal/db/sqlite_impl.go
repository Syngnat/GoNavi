package db

import (
	"context"
	"database/sql"
	"fmt"
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

func (s *SQLiteDB) Connect(config connection.ConnectionConfig) error {
	dsn := config.Host
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return fmt.Errorf("打开数据库连接失败：%w", err)
	}
	s.conn = db
	s.pingTimeout = getConnectTimeout(config)

	// Force verification
	if err := s.Ping(); err != nil {
		return fmt.Errorf("连接建立后验证失败：%w", err)
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
		return fmt.Errorf("connection not open")
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
		return nil, nil, fmt.Errorf("connection not open")
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
		return nil, nil, fmt.Errorf("connection not open")
	}

	rows, err := s.conn.Query(query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (s *SQLiteDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if s.conn == nil {
		return 0, fmt.Errorf("connection not open")
	}
	res, err := s.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *SQLiteDB) Exec(query string) (int64, error) {
	if s.conn == nil {
		return 0, fmt.Errorf("connection not open")
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

func (s *SQLiteDB) GetCreateStatement(dbName, tableName string) (string, error) {
	query := fmt.Sprintf("SELECT sql FROM sqlite_master WHERE type='table' AND name='%s'", tableName)
	data, _, err := s.Query(query)
	if err != nil {
		return "", err
	}
	if len(data) > 0 {
		if val, ok := data[0]["sql"]; ok {
			return fmt.Sprintf("%v", val), nil
		}
	}
	return "", fmt.Errorf("create statement not found")
}

func (s *SQLiteDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	table := strings.TrimSpace(tableName)
	if table == "" {
		return nil, fmt.Errorf("table name required")
	}

	esc := func(v string) string { return strings.ReplaceAll(v, "'", "''") }

	// cid, name, type, notnull, dflt_value, pk
	data, _, err := s.Query(fmt.Sprintf("PRAGMA table_info('%s')", esc(table)))
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
		return nil, fmt.Errorf("table name required")
	}

	esc := func(v string) string { return strings.ReplaceAll(v, "'", "''") }
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

	data, _, err := s.Query(fmt.Sprintf("PRAGMA index_list('%s')", esc(table)))
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

		cols, _, err := s.Query(fmt.Sprintf("PRAGMA index_info('%s')", esc(indexName)))
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
		return nil, fmt.Errorf("table name required")
	}

	esc := func(v string) string { return strings.ReplaceAll(v, "'", "''") }

	data, _, err := s.Query(fmt.Sprintf("PRAGMA foreign_key_list('%s')", esc(table)))
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
		return nil, fmt.Errorf("table name required")
	}

	esc := func(v string) string { return strings.ReplaceAll(v, "'", "''") }

	data, _, err := s.Query(fmt.Sprintf("SELECT name AS trigger_name, sql AS statement FROM sqlite_master WHERE type='trigger' AND tbl_name='%s' ORDER BY name", esc(table)))
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
	if s.conn == nil {
		return fmt.Errorf("connection not open")
	}

	tx, err := s.conn.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

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
		if _, err := tx.Exec(query, args...); err != nil {
			return fmt.Errorf("delete error: %v", err)
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
			return fmt.Errorf("update requires keys")
		}

		query := fmt.Sprintf("UPDATE %s SET %s WHERE %s", qualifiedTable, strings.Join(sets, ", "), strings.Join(wheres, " AND "))
		if _, err := tx.Exec(query, args...); err != nil {
			return fmt.Errorf("update error: %v", err)
		}
	}

	// 3. Inserts
	for _, row := range changes.Inserts {
		var cols []string
		var placeholders []string
		var args []interface{}

		for k, v := range row {
			cols = append(cols, quoteIdent(k))
			placeholders = append(placeholders, "?")
			args = append(args, v)
		}

		if len(cols) == 0 {
			continue
		}

		query := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", qualifiedTable, strings.Join(cols, ", "), strings.Join(placeholders, ", "))
		if _, err := tx.Exec(query, args...); err != nil {
			return fmt.Errorf("insert error: %v", err)
		}
	}

	return tx.Commit()
}

func (s *SQLiteDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	tables, err := s.GetTables(dbName)
	if err != nil {
		return nil, err
	}

	var cols []connection.ColumnDefinitionWithTable
	for _, table := range tables {
		// Skip internal tables
		if strings.HasPrefix(strings.ToLower(table), "sqlite_") {
			continue
		}
		columns, err := s.GetColumns("", table)
		if err != nil {
			continue
		}
		for _, col := range columns {
			cols = append(cols, connection.ColumnDefinitionWithTable{
				TableName: table,
				Name:      col.Name,
				Type:      col.Type,
			})
		}
	}
	return cols, nil
}
