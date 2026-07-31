//go:build gonavi_full_drivers || gonavi_mariadb_driver

package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/internal/utils"

	_ "github.com/go-sql-driver/mysql"
)

// MariaDB implements Database interface for MariaDB
// MariaDB is MySQL-compatible, so we reuse the MySQL driver
type MariaDB struct {
	conn        *sql.DB
	pingTimeout time.Duration
}

func (m *MariaDB) getDSN(config connection.ConnectionConfig) (string, error) {
	database := config.Database
	protocol := "tcp"
	address := fmt.Sprintf("%s:%d", config.Host, config.Port)

	if config.UseSSH {
		netName, err := ssh.RegisterSSHNetwork(config.SSH)
		if err != nil {
			return "", fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		protocol = netName
	}

	return buildMySQLCompatibleDSN(config, protocol, address, database)
}

func (m *MariaDB) Connect(config connection.ConnectionConfig) error {
	runConfig := applyMySQLURI(config)
	dsn, err := m.getDSN(runConfig)
	if err != nil {
		return err
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return wrapDatabaseConnectionOpenError(err)
	}
	configureSQLConnectionPool(db, "mariadb")
	m.conn = db
	m.pingTimeout = getConnectTimeout(config)

	if err := m.Ping(); err != nil {
		_ = db.Close()
		m.conn = nil
		return wrapDatabaseConnectionVerifyError(err)
	}
	return nil
}

func (m *MariaDB) Close() error {
	if m.conn != nil {
		return m.conn.Close()
	}
	return nil
}

func (m *MariaDB) Ping() error {
	if m.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	timeout := m.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	return m.conn.PingContext(ctx)
}

func (m *MariaDB) QueryMulti(query string) ([]connection.ResultSetData, error) {
	if m.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	rows, err := m.conn.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMultiRowsForDialect(rows, "mariadb")
}

func (m *MariaDB) QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error) {
	if m.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	rows, err := m.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMultiRowsForDialect(rows, "mariadb")
}

func (m *MariaDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if m.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}

	rows, err := m.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	return scanRowsForDialect(rows, "mariadb")
}

func (m *MariaDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if m.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}

	rows, err := m.conn.Query(query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRowsForDialect(rows, "mariadb")
}

func (m *MariaDB) ExecBatchContext(ctx context.Context, query string) (int64, error) {
	if m.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := m.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (m *MariaDB) OpenSessionExecer(ctx context.Context) (StatementExecer, error) {
	if m.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	conn, err := m.conn.Conn(ctx)
	if err != nil {
		return nil, err
	}
	// 与 QueryContext 的扫描方言保持一致（mariadb_impl.go:119 用 "mariadb"），
	// 否则 DATE 列在会话路径会退化成 RFC3339 时间戳，与网格直查结果不一致。
	return NewSQLConnStatementExecerWithDialect(conn, "mariadb"), nil
}

func (m *MariaDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if m.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := m.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (m *MariaDB) Exec(query string) (int64, error) {
	if m.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := m.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (m *MariaDB) GetDatabases() ([]string, error) {
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

func (m *MariaDB) GetTables(dbName string) ([]string, error) {
	query := "SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"
	if dbName != "" {
		query = fmt.Sprintf(
			"SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = '%s' AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
			strings.ReplaceAll(dbName, "'", "''"),
		)
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
	return resolveShardingSphereLogicalTables(tables, m.Query), nil
}

func (m *MariaDB) GetCreateStatement(dbName, tableName string) (string, error) {
	data, _, err := m.Query(buildMySQLShowCreateTableQuery(dbName, tableName))
	if err != nil {
		return "", err
	}

	if len(data) > 0 {
		if val, ok := data[0]["Create Table"]; ok {
			return fmt.Sprintf("%v", val), nil
		}
	}
	return "", localizedDatabaseRuntimeError("db.backend.error.create_table_statement_not_found", nil)
}

func (m *MariaDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	data, _, err := m.Query(buildMySQLShowFullColumnsQuery(dbName, tableName))
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

func (m *MariaDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
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

		subPart := 0
		if val, ok := row["Sub_part"]; ok && val != nil {
			if f, ok := val.(float64); ok {
				subPart = int(f)
			} else if i, ok := val.(int64); ok {
				subPart = int(i)
			}
		}

		idx := connection.IndexDefinition{
			Name:       fmt.Sprintf("%v", row["Key_name"]),
			ColumnName: fmt.Sprintf("%v", row["Column_name"]),
			NonUnique:  nonUnique,
			SeqInIndex: seq,
			IndexType:  fmt.Sprintf("%v", row["Index_type"]),
			SubPart:    subPart,
		}
		indexes = append(indexes, idx)
	}
	return indexes, nil
}

func (m *MariaDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
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

func (m *MariaDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
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

func (m *MariaDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	if m.conn == nil {
		return fmt.Errorf("连接未打开")
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
			args = append(args, normalizeMySQLComplexValue(normalizeMySQLDateTimeValue(v)))
		}
		if len(wheres) == 0 {
			continue
		}
		query := fmt.Sprintf("DELETE FROM `%s` WHERE %s", tableName, strings.Join(wheres, " AND "))
		res, err := tx.Exec(query, args...)
		if err != nil {
			return fmt.Errorf("删除失败：%v", err)
		}
		// 与 mysql_impl.go:1259 一致：本函数是 MySQL 版的拷贝，但漏掉了影响行数校验。
		// 缺少该校验时，无主键表上一次单元格编辑可能静默改写多行；
		// 或 WHERE 命中 0 行（他人已改该行）仍提交空事务并提示成功，造成静默丢失更新。
		if err := requireSingleRowAffected(res, rowMutationActionDelete); err != nil {
			return err
		}
	}

	// 2. Updates
	for _, update := range changes.Updates {
		var sets []string
		var args []interface{}

		for k, v := range update.Values {
			sets = append(sets, fmt.Sprintf("`%s` = ?", k))
			args = append(args, normalizeMySQLComplexValue(normalizeMySQLDateTimeValue(v)))
		}

		if len(sets) == 0 {
			continue
		}

		var wheres []string
		for k, v := range update.Keys {
			wheres = append(wheres, fmt.Sprintf("`%s` = ?", k))
			args = append(args, normalizeMySQLComplexValue(normalizeMySQLDateTimeValue(v)))
		}

		if len(wheres) == 0 {
			return fmt.Errorf("更新操作需要主键条件")
		}

		query := fmt.Sprintf("UPDATE `%s` SET %s WHERE %s", tableName, strings.Join(sets, ", "), strings.Join(wheres, " AND "))
		res, err := tx.Exec(query, args...)
		if err != nil {
			return fmt.Errorf("更新失败：%v", err)
		}
		// 与 mysql_impl.go:1293 一致，避免一次编辑静默改写多行或 0 行命中仍提示成功。
		if err := requireSingleRowAffected(res, rowMutationActionUpdate); err != nil {
			return err
		}
	}

	if err := execParameterizedInsertBatches(parameterizedInsertConfig{
		Table: fmt.Sprintf("`%s`", escapeMySQLBacktickIdent(tableName)),
		Rows:  changes.Inserts,
		QuoteColumn: func(column string) string {
			return fmt.Sprintf("`%s`", escapeMySQLBacktickIdent(column))
		},
		Placeholder: func(int) string { return "?" },
		Value: func(_ string, value interface{}) (interface{}, bool) {
			return normalizeMySQLComplexValue(normalizeMySQLDateTimeValue(value)), false
		},
		Exec: func(query string, args ...interface{}) (sql.Result, error) {
			return tx.Exec(query, args...)
		},
		MaxRows: defaultMySQLInsertBatchSize,
		MaxArgs: maxMySQLInsertBatchArgs,
	}); err != nil {
		return err
	}

	return tx.Commit()
}

func (m *MariaDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	if dbName == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.database_name_required", nil)
	}
	query := fmt.Sprintf("SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '%s'", strings.ReplaceAll(dbName, "'", "''"))

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
			Comment:   fmt.Sprintf("%v", row["COLUMN_COMMENT"]),
		}
		cols = append(cols, col)
	}
	return cols, nil
}
