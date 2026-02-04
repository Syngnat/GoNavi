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

	_ "gitee.com/chunanyong/dm"
)

type DamengDB struct {
	conn        *sql.DB
	pingTimeout time.Duration
	forwarder   *ssh.LocalForwarder // Store SSH tunnel forwarder
}

func (d *DamengDB) getDSN(config connection.ConnectionConfig) string {
	// dm://user:password@host:port?schema=...
	// or dm://user:password@host:port

	address := net.JoinHostPort(config.Host, strconv.Itoa(config.Port))
	escapedPassword := url.PathEscape(config.Password)
	q := url.Values{}
	if config.Database != "" {
		q.Set("schema", config.Database)
	}
	if escapedPassword != config.Password {
		// 达梦驱动要求：密码包含特殊字符时，password 需 PathEscape，并添加 escapeProcess=true 让驱动解码。
		q.Set("escapeProcess", "true")
	}

	dsn := fmt.Sprintf("dm://%s:%s@%s", config.User, escapedPassword, address)
	encoded := q.Encode()
	if encoded == "" {
		return dsn
	}
	return dsn + "?" + encoded
}

func (d *DamengDB) Connect(config connection.ConnectionConfig) error {
	var dsn string
	var err error

	if config.UseSSH {
		// Create SSH tunnel with local port forwarding
		logger.Infof("达梦数据库使用 SSH 连接：地址=%s:%d 用户=%s", config.Host, config.Port, config.User)

		forwarder, err := ssh.GetOrCreateLocalForwarder(config.SSH, config.Host, config.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		d.forwarder = forwarder

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

		dsn = d.getDSN(localConfig)
		logger.Infof("达梦数据库通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	} else {
		dsn = d.getDSN(config)
	}

	db, err := sql.Open("dm", dsn)
	if err != nil {
		return fmt.Errorf("打开数据库连接失败：%w", err)
	}
	d.conn = db
	d.pingTimeout = getConnectTimeout(config)
	if err := d.Ping(); err != nil {
		return fmt.Errorf("连接建立后验证失败：%w", err)
	}
	return nil
}

func (d *DamengDB) Close() error {
	// Close SSH forwarder first if exists
	if d.forwarder != nil {
		if err := d.forwarder.Close(); err != nil {
			logger.Warnf("关闭达梦数据库 SSH 端口转发失败：%v", err)
		}
		d.forwarder = nil
	}

	// Then close database connection
	if d.conn != nil {
		return d.conn.Close()
	}
	return nil
}

func (d *DamengDB) Ping() error {
	if d.conn == nil {
		return fmt.Errorf("connection not open")
	}
	timeout := d.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	return d.conn.PingContext(ctx)
}

func (d *DamengDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if d.conn == nil {
		return nil, nil, fmt.Errorf("connection not open")
	}

	rows, err := d.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	return scanRows(rows)
}

func (d *DamengDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if d.conn == nil {
		return nil, nil, fmt.Errorf("connection not open")
	}

	rows, err := d.conn.Query(query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (d *DamengDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if d.conn == nil {
		return 0, fmt.Errorf("connection not open")
	}
	res, err := d.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (d *DamengDB) Exec(query string) (int64, error) {
	if d.conn == nil {
		return 0, fmt.Errorf("connection not open")
	}
	res, err := d.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (d *DamengDB) GetDatabases() ([]string, error) {
	// DM: List Users/Schemas
	data, _, err := d.Query("SELECT username FROM dba_users")
	if err != nil {
		// Fallback if dba_users not accessible
		data, _, err = d.Query("SELECT username FROM all_users")
		if err != nil {
			return nil, err
		}
	}
	var dbs []string
	for _, row := range data {
		if val, ok := row["USERNAME"]; ok {
			dbs = append(dbs, fmt.Sprintf("%v", val))
		}
	}
	return dbs, nil
}

func (d *DamengDB) GetTables(dbName string) ([]string, error) {
	query := fmt.Sprintf("SELECT owner, table_name FROM all_tables WHERE owner = '%s' ORDER BY table_name", strings.ToUpper(dbName))
	if dbName == "" {
		query = "SELECT table_name FROM user_tables"
	}

	data, _, err := d.Query(query)
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

func (d *DamengDB) GetCreateStatement(dbName, tableName string) (string, error) {
	// DM: SP_TABLEDEF usually returns definition
	// Or standard Oracle way if supported.
	// We'll try a common DM approach.
	// SELECT DBMS_METADATA.GET_DDL('TABLE', 'TABLE_NAME', 'OWNER') FROM DUAL;

	query := fmt.Sprintf("SELECT DBMS_METADATA.GET_DDL('TABLE', '%s', '%s') as ddl FROM DUAL",
		strings.ToUpper(tableName), strings.ToUpper(dbName))

	if dbName == "" {
		query = fmt.Sprintf("SELECT DBMS_METADATA.GET_DDL('TABLE', '%s') as ddl FROM DUAL", strings.ToUpper(tableName))
	}

	data, _, err := d.Query(query)
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

func (d *DamengDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	query := fmt.Sprintf(`SELECT column_name, data_type, nullable, data_default 
		FROM all_tab_columns 
		WHERE owner = '%s' AND table_name = '%s'`,
		strings.ToUpper(dbName), strings.ToUpper(tableName))

	if dbName == "" {
		query = fmt.Sprintf(`SELECT column_name, data_type, nullable, data_default 
			FROM user_tab_columns 
			WHERE table_name = '%s'`, strings.ToUpper(tableName))
	}

	data, _, err := d.Query(query)
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
			def := fmt.Sprintf("%v", row["DATA_DEFAULT"])
			col.Default = &def
		}

		columns = append(columns, col)
	}
	return columns, nil
}

func (d *DamengDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
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

	data, _, err := d.Query(query)
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
			IndexType:  "BTREE",
		}
		indexes = append(indexes, idx)
	}
	return indexes, nil
}

func (d *DamengDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	// Reusing Oracle style query as DM is highly compatible
	query := fmt.Sprintf(`SELECT a.constraint_name, a.column_name, c_pk.table_name r_table_name, b.column_name r_column_name
		FROM all_cons_columns a
		JOIN all_constraints c ON a.owner = c.owner AND a.constraint_name = c.constraint_name
		JOIN all_constraints c_pk ON c.r_owner = c_pk.owner AND c.r_constraint_name = c_pk.constraint_name
		JOIN all_cons_columns b ON c_pk.owner = b.owner AND c_pk.constraint_name = b.constraint_name AND a.position = b.position
		WHERE c.constraint_type = 'R' AND a.owner = '%s' AND a.table_name = '%s'`,
		strings.ToUpper(dbName), strings.ToUpper(tableName))

	data, _, err := d.Query(query)
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

func (d *DamengDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	query := fmt.Sprintf(`SELECT trigger_name, trigger_type, triggering_event 
		FROM all_triggers 
		WHERE table_owner = '%s' AND table_name = '%s'`,
		strings.ToUpper(dbName), strings.ToUpper(tableName))

	data, _, err := d.Query(query)
	if err != nil {
		return nil, err
	}

	var triggers []connection.TriggerDefinition
	for _, row := range data {
		trig := connection.TriggerDefinition{
			Name:      fmt.Sprintf("%v", row["TRIGGER_NAME"]),
			Timing:    fmt.Sprintf("%v", row["TRIGGER_TYPE"]),
			Event:     fmt.Sprintf("%v", row["TRIGGERING_EVENT"]),
			Statement: "SOURCE HIDDEN",
		}
		triggers = append(triggers, trig)
	}
	return triggers, nil
}

func (d *DamengDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return fmt.Errorf("read-only mode implemented for Dameng so far")
}

func (d *DamengDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	query := fmt.Sprintf(`SELECT table_name, column_name, data_type 
		FROM all_tab_columns 
		WHERE owner = '%s'`, strings.ToUpper(dbName))

	data, _, err := d.Query(query)
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
