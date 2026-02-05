package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/internal/utils"

	_ "github.com/go-sql-driver/mysql"
)

type MySQLDB struct {
	conn        *sql.DB
	pingTimeout time.Duration
}

func (m *MySQLDB) getDSN(config connection.ConnectionConfig) string {
	database := config.Database
	protocol := "tcp"
	address := fmt.Sprintf("%s:%d", config.Host, config.Port)

	if config.UseSSH {
		netName, err := ssh.RegisterSSHNetwork(config.SSH)
		if err == nil {
			protocol = netName
			address = fmt.Sprintf("%s:%d", config.Host, config.Port)
		} else {
			logger.Warnf("注册 SSH 网络失败，将尝试直连：地址=%s:%d 用户=%s，原因：%v", config.Host, config.Port, config.User, err)
		}
	}

	timeout := getConnectTimeoutSeconds(config)

	return fmt.Sprintf("%s:%s@%s(%s)/%s?charset=utf8mb4&parseTime=True&loc=Local&timeout=%ds",
		config.User, config.Password, protocol, address, database, timeout)
}

func (m *MySQLDB) Connect(config connection.ConnectionConfig) error {
	dsn := m.getDSN(config)
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return fmt.Errorf("打开数据库连接失败：%w", err)
	}
	m.conn = db
	m.pingTimeout = getConnectTimeout(config)

	// Force verification
	if err := m.Ping(); err != nil {
		return fmt.Errorf("连接建立后验证失败：%w", err)
	}
	return nil
}

func (m *MySQLDB) Close() error {
	if m.conn != nil {
		return m.conn.Close()
	}
	return nil
}

func (m *MySQLDB) Ping() error {
	if m.conn == nil {
		return fmt.Errorf("connection not open")
	}
	timeout := m.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	return m.conn.PingContext(ctx)
}

func (m *MySQLDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if m.conn == nil {
		return nil, nil, fmt.Errorf("connection not open")
	}

	rows, err := m.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	return scanRows(rows)
}

func (m *MySQLDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if m.conn == nil {
		return nil, nil, fmt.Errorf("connection not open")
	}

	rows, err := m.conn.Query(query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (m *MySQLDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if m.conn == nil {
		return 0, fmt.Errorf("connection not open")
	}
	res, err := m.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (m *MySQLDB) Exec(query string) (int64, error) {
	if m.conn == nil {
		return 0, fmt.Errorf("connection not open")
	}
	res, err := m.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (m *MySQLDB) GetDatabases() ([]string, error) {
	data, _, err := m.Query("SHOW DATABASES")
	if err != nil {
		return nil, err
	}
	var dbs []string
	for _, row := range data {
		if val, ok := row["Database"]; ok {
			dbs = append(dbs, fmt.Sprintf("%v", val))
		} else if val, ok := row["database"]; ok {
			dbs = append(dbs, fmt.Sprintf("%v", val))
		}
	}
	return dbs, nil
}

func (m *MySQLDB) GetTables(dbName string) ([]string, error) {
	query := "SHOW TABLES"
	if dbName != "" {
		query = fmt.Sprintf("SHOW TABLES FROM `%s`", dbName)
	}

	data, _, err := m.Query(query)
	if err != nil {
		return nil, err
	}

	var tables []string
	for _, row := range data {
		for _, v := range row {
			tables = append(tables, fmt.Sprintf("%v", v))
			break
		}
	}
	return tables, nil
}

func (m *MySQLDB) GetCreateStatement(dbName, tableName string) (string, error) {
	query := fmt.Sprintf("SHOW CREATE TABLE `%s`.`%s`", dbName, tableName)
	if dbName == "" {
		query = fmt.Sprintf("SHOW CREATE TABLE `%s`", tableName)
	}

	data, _, err := m.Query(query)
	if err != nil {
		return "", err
	}

	if len(data) > 0 {
		if val, ok := data[0]["Create Table"]; ok {
			return fmt.Sprintf("%v", val), nil
		}
	}
	return "", fmt.Errorf("create statement not found")
}

func (m *MySQLDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	query := fmt.Sprintf("SHOW FULL COLUMNS FROM `%s`.`%s`", dbName, tableName)
	if dbName == "" {
		query = fmt.Sprintf("SHOW FULL COLUMNS FROM `%s`", tableName)
	}

	data, _, err := m.Query(query)
	if err != nil {
		return nil, err
	}

	var columns []connection.ColumnDefinition
	for _, row := range data {
		col := connection.ColumnDefinition{
			Name:     fmt.Sprintf("%v", row["Field"]),
			Type:     fmt.Sprintf("%v", row["Type"]),
			Nullable: fmt.Sprintf("%v", row["Null"]),
			Key:      fmt.Sprintf("%v", row["Key"]),
			Extra:    fmt.Sprintf("%v", row["Extra"]),
			Comment:  fmt.Sprintf("%v", row["Comment"]),
		}

		if row["Default"] != nil {
			d := fmt.Sprintf("%v", row["Default"])
			col.Default = &d
		}

		columns = append(columns, col)
	}
	return columns, nil
}

func (m *MySQLDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	query := fmt.Sprintf("SHOW INDEX FROM `%s`.`%s`", dbName, tableName)
	if dbName == "" {
		query = fmt.Sprintf("SHOW INDEX FROM `%s`", tableName)
	}

	data, _, err := m.Query(query)
	if err != nil {
		return nil, err
	}

	var indexes []connection.IndexDefinition
	for _, row := range data {
		nonUnique := 0
		if val, ok := row["Non_unique"]; ok {
			if f, ok := val.(float64); ok {
				nonUnique = int(f)
			} else if i, ok := val.(int64); ok {
				nonUnique = int(i)
			}
		}

		seq := 0
		if val, ok := row["Seq_in_index"]; ok {
			if f, ok := val.(float64); ok {
				seq = int(f)
			} else if i, ok := val.(int64); ok {
				seq = int(i)
			}
		}

		idx := connection.IndexDefinition{
			Name:       fmt.Sprintf("%v", row["Key_name"]),
			ColumnName: fmt.Sprintf("%v", row["Column_name"]),
			NonUnique:  nonUnique,
			SeqInIndex: seq,
			IndexType:  fmt.Sprintf("%v", row["Index_type"]),
		}
		indexes = append(indexes, idx)
	}
	return indexes, nil
}

func (m *MySQLDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	query := fmt.Sprintf(`SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME 
              FROM information_schema.KEY_COLUMN_USAGE 
              WHERE TABLE_SCHEMA = '%s' AND TABLE_NAME = '%s' AND REFERENCED_TABLE_NAME IS NOT NULL`, dbName, tableName)

	data, _, err := m.Query(query)
	if err != nil {
		return nil, err
	}

	var fks []connection.ForeignKeyDefinition
	for _, row := range data {
		fk := connection.ForeignKeyDefinition{
			Name:           fmt.Sprintf("%v", row["CONSTRAINT_NAME"]),
			ColumnName:     fmt.Sprintf("%v", row["COLUMN_NAME"]),
			RefTableName:   fmt.Sprintf("%v", row["REFERENCED_TABLE_NAME"]),
			RefColumnName:  fmt.Sprintf("%v", row["REFERENCED_COLUMN_NAME"]),
			ConstraintName: fmt.Sprintf("%v", row["CONSTRAINT_NAME"]),
		}
		fks = append(fks, fk)
	}
	return fks, nil
}

func (m *MySQLDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	query := fmt.Sprintf("SHOW TRIGGERS FROM `%s` WHERE `Table` = '%s'", dbName, tableName)
	data, _, err := m.Query(query)
	if err != nil {
		return nil, err
	}

	var triggers []connection.TriggerDefinition
	for _, row := range data {
		trig := connection.TriggerDefinition{
			Name:      fmt.Sprintf("%v", row["Trigger"]),
			Timing:    fmt.Sprintf("%v", row["Timing"]),
			Event:     fmt.Sprintf("%v", row["Event"]),
			Statement: fmt.Sprintf("%v", row["Statement"]),
		}
		triggers = append(triggers, trig)
	}
	return triggers, nil
}

func (m *MySQLDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	if m.conn == nil {
		return fmt.Errorf("connection not open")
	}

	tx, err := m.conn.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// 1. Deletes
	for _, pk := range changes.Deletes {
		var wheres []string
		var args []interface{}
		for k, v := range pk {
			wheres = append(wheres, fmt.Sprintf("`%s` = ?", k))
			args = append(args, normalizeMySQLDateTimeValue(v))
		}
		if len(wheres) == 0 {
			continue
		}
		query := fmt.Sprintf("DELETE FROM `%s` WHERE %s", tableName, strings.Join(wheres, " AND "))
		res, err := tx.Exec(query, args...)
		if err != nil {
			return fmt.Errorf("delete error: %v", err)
		}
		if affected, err := res.RowsAffected(); err == nil && affected == 0 {
			return fmt.Errorf("删除未生效：未匹配到任何行")
		}
	}

	// 2. Updates
	for _, update := range changes.Updates {
		var sets []string
		var args []interface{}

		for k, v := range update.Values {
			sets = append(sets, fmt.Sprintf("`%s` = ?", k))
			args = append(args, normalizeMySQLDateTimeValue(v))
		}

		if len(sets) == 0 {
			continue
		}

		var wheres []string
		for k, v := range update.Keys {
			wheres = append(wheres, fmt.Sprintf("`%s` = ?", k))
			args = append(args, normalizeMySQLDateTimeValue(v))
		}

		if len(wheres) == 0 {
			return fmt.Errorf("update requires keys")
		}

		query := fmt.Sprintf("UPDATE `%s` SET %s WHERE %s", tableName, strings.Join(sets, ", "), strings.Join(wheres, " AND "))
		res, err := tx.Exec(query, args...)
		if err != nil {
			return fmt.Errorf("update error: %v", err)
		}
		if affected, err := res.RowsAffected(); err == nil && affected == 0 {
			return fmt.Errorf("更新未生效：未匹配到任何行")
		}
	}

	// 3. Inserts
	for _, row := range changes.Inserts {
		var cols []string
		var placeholders []string
		var args []interface{}

		for k, v := range row {
			cols = append(cols, fmt.Sprintf("`%s`", k))
			placeholders = append(placeholders, "?")
			args = append(args, normalizeMySQLDateTimeValue(v))
		}

		if len(cols) == 0 {
			continue
		}

		query := fmt.Sprintf("INSERT INTO `%s` (%s) VALUES (%s)", tableName, strings.Join(cols, ", "), strings.Join(placeholders, ", "))
		res, err := tx.Exec(query, args...)
		if err != nil {
			return fmt.Errorf("insert error: %v", err)
		}
		if affected, err := res.RowsAffected(); err == nil && affected == 0 {
			return fmt.Errorf("插入未生效：未影响任何行")
		}
	}

	return tx.Commit()
}

func normalizeMySQLDateTimeValue(value interface{}) interface{} {
	text, ok := value.(string)
	if !ok {
		return value
	}
	raw := strings.TrimSpace(text)
	if raw == "" {
		return value
	}

	cleaned := strings.ReplaceAll(raw, "+ ", "+")
	cleaned = strings.ReplaceAll(cleaned, "- ", "-")

	if len(cleaned) >= 19 && cleaned[10] == 'T' {
		if strings.HasSuffix(cleaned, "Z") || hasTimezoneOffset(cleaned) {
			if t, err := time.Parse(time.RFC3339Nano, cleaned); err == nil {
				return formatMySQLDateTime(t)
			}
			if t, err := time.Parse(time.RFC3339, cleaned); err == nil {
				return formatMySQLDateTime(t)
			}
		}
		return strings.Replace(cleaned, "T", " ", 1)
	}

	if strings.Contains(cleaned, " ") && (strings.HasSuffix(cleaned, "Z") || hasTimezoneOffset(cleaned)) {
		candidate := strings.Replace(cleaned, " ", "T", 1)
		if t, err := time.Parse(time.RFC3339Nano, candidate); err == nil {
			return formatMySQLDateTime(t)
		}
		if t, err := time.Parse(time.RFC3339, candidate); err == nil {
			return formatMySQLDateTime(t)
		}
	}

	return value
}

func hasTimezoneOffset(text string) bool {
	pos := strings.LastIndexAny(text, "+-")
	if pos < 0 || pos < 10 || pos+1 >= len(text) {
		return false
	}
	offset := text[pos+1:]
	if len(offset) == 5 && offset[2] == ':' {
		return isAllDigits(offset[:2]) && isAllDigits(offset[3:])
	}
	if len(offset) == 4 {
		return isAllDigits(offset)
	}
	return false
}

func isAllDigits(text string) bool {
	if text == "" {
		return false
	}
	for _, r := range text {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func formatMySQLDateTime(t time.Time) string {
	base := t.Format("2006-01-02 15:04:05")
	nanos := t.Nanosecond()
	if nanos == 0 {
		return base
	}
	micro := nanos / 1000
	return fmt.Sprintf("%s.%06d", base, micro)
}

func (m *MySQLDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	query := fmt.Sprintf("SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '%s'", dbName)
	if dbName == "" {
		return nil, fmt.Errorf("database name required for GetAllColumns")
	}

	data, _, err := m.Query(query)
	if err != nil {
		return nil, err
	}

	var cols []connection.ColumnDefinitionWithTable
	for _, row := range data {
		col := connection.ColumnDefinitionWithTable{
			TableName: fmt.Sprintf("%v", row["TABLE_NAME"]),
			Name:      fmt.Sprintf("%v", row["COLUMN_NAME"]),
			Type:      fmt.Sprintf("%v", row["COLUMN_TYPE"]),
		}
		cols = append(cols, col)
	}
	return cols, nil
}
