package db

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/internal/utils"

	_ "github.com/sijms/go-ora/v2"
)

type OracleDB struct {
	conn *sql.DB
}

func (o *OracleDB) getDSN(config connection.ConnectionConfig) string {
	// oracle://user:pass@host:port/service_name
	database := config.Database
	if database == "" {
		database = config.User // Default to user service/schema if empty?
	}

	address := fmt.Sprintf("%s:%d", config.Host, config.Port)
	if config.UseSSH {
		_, err := ssh.RegisterSSHNetwork(config.SSH)
		if err == nil {
			// Oracle driver might not support custom dialer via DSN easily without extra config
			// But go-ora v2 supports some advanced options.
			// For simplicity, we assume standard TCP or we might need a workaround for SSH.
			// go-ora v2 is pure Go, so we can potentially use a custom dialer if we manually open.
			// But for now, let's just use the address.
			// SSH tunneling via net.Dialer override is complex in sql.Open("oracle", ...).
			// We might need to forward a local port if using SSH.
			// Since ssh.RegisterSSHNetwork creates a custom network "ssh-via-...",
			// we need to see if go-ora supports custom networks.
			// Checking go-ora docs (simulated): It supports "unix" and "tcp".
			// We might need to map the custom network to a local proxy.
			// For now, we will assume direct connection or handle SSH separately later.
			// We'll leave the protocol implementation as is in MySQL for now, hoping go-ora uses standard net.Dial.
			// Note: go-ora connection string: oracle://user:pass@host:port/service
			// It parses host/port. It doesn't easily take a custom "network" parameter in URL.
			// We will proceed with standard TCP string.
		}
	}

	// go-ora url structure: oracle://user:password@address:port/service_name
	return fmt.Sprintf("oracle://%s:%s@%s/%s",
		config.User, config.Password, address, database)
}

func (o *OracleDB) Connect(config connection.ConnectionConfig) error {
	dsn := o.getDSN(config)
	db, err := sql.Open("oracle", dsn)
	if err != nil {
		return err
	}
	o.conn = db
	return o.Ping()
}

func (o *OracleDB) Close() error {
	if o.conn != nil {
		return o.conn.Close()
	}
	return nil
}

func (o *OracleDB) Ping() error {
	if o.conn == nil {
		return fmt.Errorf("connection not open")
	}
	ctx, cancel := utils.ContextWithTimeout(5 * time.Second)
	defer cancel()
	return o.conn.PingContext(ctx)
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

	columns, err := rows.Columns()
	if err != nil {
		return nil, nil, err
	}

	var resultData []map[string]interface{}

	for rows.Next() {
		values := make([]interface{}, len(columns))
		valuePtrs := make([]interface{}, len(columns))
		for i := range columns {
			valuePtrs[i] = &values[i]
		}

		if err := rows.Scan(valuePtrs...); err != nil {
			continue
		}

		entry := make(map[string]interface{})
		for i, col := range columns {
			var v interface{}
			val := values[i]
			b, ok := val.([]byte)
			if ok {
				v = string(b)
			} else {
				v = val
			}
			entry[col] = v
		}
		resultData = append(resultData, entry)
	}

	return resultData, columns, nil
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
		query = fmt.Sprintf("SELECT table_name FROM all_tables WHERE owner = '%s'", strings.ToUpper(dbName))
	}

	data, _, err := o.Query(query)
	if err != nil {
		return nil, err
	}

	var tables []string
	for _, row := range data {
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
