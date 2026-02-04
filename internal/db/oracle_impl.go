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

	_ "github.com/sijms/go-ora/v2"
)

type OracleDB struct {
	conn        *sql.DB
	pingTimeout time.Duration
	forwarder   *ssh.LocalForwarder // Store SSH tunnel forwarder
}

func (o *OracleDB) getDSN(config connection.ConnectionConfig) string {
	// oracle://user:pass@host:port/service_name
	database := config.Database
	if database == "" {
		database = config.User // Default to user service/schema if empty?
	}

	u := &url.URL{
		Scheme: "oracle",
		Host:   net.JoinHostPort(config.Host, strconv.Itoa(config.Port)),
		Path:   "/" + database,
	}
	u.User = url.UserPassword(config.User, config.Password)
	u.RawPath = "/" + url.PathEscape(database)
	return u.String()
}

func (o *OracleDB) Connect(config connection.ConnectionConfig) error {
	var dsn string
	var err error

	if config.UseSSH {
		// Create SSH tunnel with local port forwarding
		logger.Infof("Oracle 使用 SSH 连接：地址=%s:%d 用户=%s", config.Host, config.Port, config.User)

		forwarder, err := ssh.GetOrCreateLocalForwarder(config.SSH, config.Host, config.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		o.forwarder = forwarder

		// Parse local address
		host, portStr, err := net.SplitHostPort(forwarder.LocalAddr)
		if err != nil {
			return fmt.Errorf("解析本地转发地址失败：%w", err)
		}

		port, err := strconv.Atoi(portStr)
		if err != nil {
			return fmt.Errorf("解析本地端口失败：%w", err)
		}

		// Create a modified config pointing to local forwarder
		localConfig := config
		localConfig.Host = host
		localConfig.Port = port
		localConfig.UseSSH = false

		dsn = o.getDSN(localConfig)
		logger.Infof("Oracle 通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	} else {
		dsn = o.getDSN(config)
	}

	db, err := sql.Open("oracle", dsn)
	if err != nil {
		return fmt.Errorf("打开数据库连接失败：%w", err)
	}
	o.conn = db
	o.pingTimeout = getConnectTimeout(config)
	if err := o.Ping(); err != nil {
		return fmt.Errorf("连接建立后验证失败：%w", err)
	}
	return nil
}

func (o *OracleDB) Close() error {
	// Close SSH forwarder first if exists
	if o.forwarder != nil {
		if err := o.forwarder.Close(); err != nil {
			logger.Warnf("关闭 Oracle SSH 端口转发失败：%v", err)
		}
		o.forwarder = nil
	}

	// Then close database connection
	if o.conn != nil {
		return o.conn.Close()
	}
	return nil
}

func (o *OracleDB) Ping() error {
	if o.conn == nil {
		return fmt.Errorf("connection not open")
	}
	timeout := o.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	return o.conn.PingContext(ctx)
}

func (o *OracleDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if o.conn == nil {
		return nil, nil, fmt.Errorf("connection not open")
	}

	rows, err := o.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	return scanRows(rows)
}

func (o *OracleDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if o.conn == nil {
		return nil, nil, fmt.Errorf("connection not open")
	}

	rows, err := o.conn.Query(query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (o *OracleDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if o.conn == nil {
		return 0, fmt.Errorf("connection not open")
	}
	res, err := o.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (o *OracleDB) Exec(query string) (int64, error) {
	if o.conn == nil {
		return 0, fmt.Errorf("connection not open")
	}
	res, err := o.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (o *OracleDB) GetDatabases() ([]string, error) {
	// Oracle treats Users/Schemas as "Databases" in this context
	data, _, err := o.Query("SELECT username FROM all_users ORDER BY username")
	if err != nil {
		return nil, err
	}
	var dbs []string
	for _, row := range data {
		if val, ok := row["USERNAME"]; ok {
			dbs = append(dbs, fmt.Sprintf("%v", val))
		}
	}
	return dbs, nil
}

func (o *OracleDB) GetTables(dbName string) ([]string, error) {
	// dbName is Schema/Owner
	query := "SELECT table_name FROM user_tables"
	if dbName != "" {
		query = fmt.Sprintf("SELECT owner, table_name FROM all_tables WHERE owner = '%s' ORDER BY table_name", strings.ToUpper(dbName))
	}

	data, _, err := o.Query(query)
	if err != nil {
		return nil, err
	}

	var tables []string
	for _, row := range data {
		if dbName != "" {
			if owner, okOwner := row["OWNER"]; okOwner {
				if name, okName := row["TABLE_NAME"]; okName {
					tables = append(tables, fmt.Sprintf("%v.%v", owner, name))
					continue
				}
			}
		}
		if val, ok := row["TABLE_NAME"]; ok {
			tables = append(tables, fmt.Sprintf("%v", val))
		}
	}
	return tables, nil
}

func (o *OracleDB) GetCreateStatement(dbName, tableName string) (string, error) {
	// Oracle provides DBMS_METADATA.GET_DDL
	// Note: LONG type might be tricky, but basic string scan should work for smaller DDLs
	query := fmt.Sprintf("SELECT DBMS_METADATA.GET_DDL('TABLE', '%s', '%s') as ddl FROM DUAL",
		strings.ToUpper(tableName), strings.ToUpper(dbName))

	if dbName == "" {
		query = fmt.Sprintf("SELECT DBMS_METADATA.GET_DDL('TABLE', '%s') as ddl FROM DUAL", strings.ToUpper(tableName))
	}

	data, _, err := o.Query(query)
	if err != nil {
		return "", err
	}

	if len(data) > 0 {
		if val, ok := data[0]["DDL"]; ok {
			return fmt.Sprintf("%v", val), nil
		}
	}
	return "", fmt.Errorf("create statement not found")
}

func (o *OracleDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	query := fmt.Sprintf(`SELECT column_name, data_type, nullable, data_default 
		FROM all_tab_columns 
		WHERE owner = '%s' AND table_name = '%s' 
		ORDER BY column_id`, strings.ToUpper(dbName), strings.ToUpper(tableName))

	if dbName == "" {
		query = fmt.Sprintf(`SELECT column_name, data_type, nullable, data_default 
			FROM user_tab_columns 
			WHERE table_name = '%s' 
			ORDER BY column_id`, strings.ToUpper(tableName))
	}

	data, _, err := o.Query(query)
	if err != nil {
		return nil, err
	}

	var columns []connection.ColumnDefinition
	for _, row := range data {
		col := connection.ColumnDefinition{
			Name:     fmt.Sprintf("%v", row["COLUMN_NAME"]),
			Type:     fmt.Sprintf("%v", row["DATA_TYPE"]),
			Nullable: fmt.Sprintf("%v", row["NULLABLE"]),
		}

		if row["DATA_DEFAULT"] != nil {
			d := fmt.Sprintf("%v", row["DATA_DEFAULT"])
			col.Default = &d
		}

		columns = append(columns, col)
	}
	return columns, nil
}

func (o *OracleDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	query := fmt.Sprintf(`SELECT index_name, column_name, uniqueness 
		FROM all_ind_columns 
		JOIN all_indexes USING (index_name, owner) 
		WHERE table_owner = '%s' AND table_name = '%s'`,
		strings.ToUpper(dbName), strings.ToUpper(tableName))

	if dbName == "" {
		query = fmt.Sprintf(`SELECT index_name, column_name, uniqueness 
			FROM user_ind_columns 
			JOIN user_indexes USING (index_name) 
			WHERE table_name = '%s'`, strings.ToUpper(tableName))
	}

	data, _, err := o.Query(query)
	if err != nil {
		return nil, err
	}

	var indexes []connection.IndexDefinition
	for _, row := range data {
		unique := 1
		if val, ok := row["UNIQUENESS"]; ok && val == "UNIQUE" {
			unique = 0
		}

		idx := connection.IndexDefinition{
			Name:       fmt.Sprintf("%v", row["INDEX_NAME"]),
			ColumnName: fmt.Sprintf("%v", row["COLUMN_NAME"]),
			NonUnique:  unique,
			// SeqInIndex is harder to get in simple join, omitting or estimating
			IndexType: "BTREE", // Default assumption
		}
		indexes = append(indexes, idx)
	}
	return indexes, nil
}

func (o *OracleDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	// Simplified query for FKs
	query := fmt.Sprintf(`SELECT a.constraint_name, a.column_name, c_pk.table_name r_table_name, b.column_name r_column_name
		FROM all_cons_columns a
		JOIN all_constraints c ON a.owner = c.owner AND a.constraint_name = c.constraint_name
		JOIN all_constraints c_pk ON c.r_owner = c_pk.owner AND c.r_constraint_name = c_pk.constraint_name
		JOIN all_cons_columns b ON c_pk.owner = b.owner AND c_pk.constraint_name = b.constraint_name AND a.position = b.position
		WHERE c.constraint_type = 'R' AND a.owner = '%s' AND a.table_name = '%s'`,
		strings.ToUpper(dbName), strings.ToUpper(tableName))

	data, _, err := o.Query(query)
	if err != nil {
		return nil, err
	}

	var fks []connection.ForeignKeyDefinition
	for _, row := range data {
		fk := connection.ForeignKeyDefinition{
			Name:           fmt.Sprintf("%v", row["CONSTRAINT_NAME"]),
			ColumnName:     fmt.Sprintf("%v", row["COLUMN_NAME"]),
			RefTableName:   fmt.Sprintf("%v", row["R_TABLE_NAME"]),
			RefColumnName:  fmt.Sprintf("%v", row["R_COLUMN_NAME"]),
			ConstraintName: fmt.Sprintf("%v", row["CONSTRAINT_NAME"]),
		}
		fks = append(fks, fk)
	}
	return fks, nil
}

func (o *OracleDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	query := fmt.Sprintf(`SELECT trigger_name, trigger_type, triggering_event 
		FROM all_triggers 
		WHERE table_owner = '%s' AND table_name = '%s'`,
		strings.ToUpper(dbName), strings.ToUpper(tableName))

	data, _, err := o.Query(query)
	if err != nil {
		return nil, err
	}

	var triggers []connection.TriggerDefinition
	for _, row := range data {
		trig := connection.TriggerDefinition{
			Name:      fmt.Sprintf("%v", row["TRIGGER_NAME"]),
			Timing:    fmt.Sprintf("%v", row["TRIGGER_TYPE"]),
			Event:     fmt.Sprintf("%v", row["TRIGGERING_EVENT"]),
			Statement: "SOURCE HIDDEN", // Requires more complex query to get body
		}
		triggers = append(triggers, trig)
	}
	return triggers, nil
}

func (o *OracleDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	// TODO: Implement batch application for Oracle using correct syntax
	return fmt.Errorf("read-only mode implemented for Oracle so far")
}

func (o *OracleDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	query := fmt.Sprintf(`SELECT table_name, column_name, data_type 
		FROM all_tab_columns 
		WHERE owner = '%s'`, strings.ToUpper(dbName))

	data, _, err := o.Query(query)
	if err != nil {
		return nil, err
	}

	var cols []connection.ColumnDefinitionWithTable
	for _, row := range data {
		col := connection.ColumnDefinitionWithTable{
			TableName: fmt.Sprintf("%v", row["TABLE_NAME"]),
			Name:      fmt.Sprintf("%v", row["COLUMN_NAME"]),
			Type:      fmt.Sprintf("%v", row["DATA_TYPE"]),
		}
		cols = append(cols, col)
	}
	return cols, nil
}
