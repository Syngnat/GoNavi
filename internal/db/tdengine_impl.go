package db

import (
	"context"
	"database/sql"
	"fmt"
	"net"
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

	return fmt.Sprintf("%s:%s@ws(%s)%s", user, pass, net.JoinHostPort(config.Host, strconv.Itoa(config.Port)), path)
}

func (t *TDengineDB) Connect(config connection.ConnectionConfig) error {
	var dsn string

	if config.UseSSH {
		logger.Infof("TDengine 使用 SSH 连接：地址=%s:%d 用户=%s", config.Host, config.Port, config.User)

		forwarder, err := ssh.GetOrCreateLocalForwarder(config.SSH, config.Host, config.Port)
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
		dsn = t.getDSN(localConfig)
		logger.Infof("TDengine 通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	} else {
		dsn = t.getDSN(config)
	}

	db, err := sql.Open("taosWS", dsn)
	if err != nil {
		return fmt.Errorf("打开数据库连接失败：%w", err)
	}
	t.conn = db
	t.pingTimeout = getConnectTimeout(config)

	if err := t.Ping(); err != nil {
		return fmt.Errorf("连接建立后验证失败：%w", err)
	}
	return nil
}

func (t *TDengineDB) Close() error {
	if t.forwarder != nil {
		if err := t.forwarder.Close(); err != nil {
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
		return fmt.Errorf("connection not open")
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
		return nil, nil, fmt.Errorf("connection not open")
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
		return nil, nil, fmt.Errorf("connection not open")
	}

	rows, err := t.conn.Query(query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	return scanRows(rows)
}

func (t *TDengineDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if t.conn == nil {
		return 0, fmt.Errorf("connection not open")
	}
	res, err := t.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (t *TDengineDB) Exec(query string) (int64, error) {
	if t.conn == nil {
		return 0, fmt.Errorf("connection not open")
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
	queries := make([]string, 0, 2)
	if strings.TrimSpace(dbName) != "" {
		queries = append(queries, fmt.Sprintf("SHOW TABLES FROM `%s`", escapeBacktickIdent(dbName)))
	}
	queries = append(queries, "SHOW TABLES")

	var lastErr error
	for _, query := range queries {
		data, _, err := t.Query(query)
		if err != nil {
			lastErr = err
			continue
		}

		var tables []string
		for _, row := range data {
			if val, ok := getValueFromRow(row, "table_name", "tablename", "name", "Table", "table"); ok {
				tables = append(tables, fmt.Sprintf("%v", val))
				continue
			}
			for _, val := range row {
				tables = append(tables, fmt.Sprintf("%v", val))
				break
			}
		}
		return tables, nil
	}

	if lastErr != nil {
		return nil, lastErr
	}
	return []string{}, nil
}

func (t *TDengineDB) GetCreateStatement(dbName, tableName string) (string, error) {
	qualified := quoteTDengineTable(dbName, tableName)
	queries := []string{
		fmt.Sprintf("SHOW CREATE TABLE %s", qualified),
		fmt.Sprintf("SHOW CREATE STABLE %s", qualified),
	}

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
	return "", fmt.Errorf("create statement not found")
}

func (t *TDengineDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	query := fmt.Sprintf("DESCRIBE %s", quoteTDengineTable(dbName, tableName))
	data, _, err := t.Query(query)
	if err != nil {
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
		return nil, fmt.Errorf("database name required for GetAllColumns")
	}

	tables, err := t.GetTables(dbName)
	if err != nil {
		return nil, err
	}

	cols := make([]connection.ColumnDefinitionWithTable, 0)
	for _, table := range tables {
		tableCols, err := t.GetColumns(dbName, table)
		if err != nil {
			continue
		}
		for _, col := range tableCols {
			cols = append(cols, connection.ColumnDefinitionWithTable{
				TableName: table,
				Name:      col.Name,
				Type:      col.Type,
			})
		}
	}

	return cols, nil
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
