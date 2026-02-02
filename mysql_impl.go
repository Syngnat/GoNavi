package main

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

type MySQLDB struct {
	conn *sql.DB
}

func (m *MySQLDB) getDSN(config ConnectionConfig) string {
	database := config.Database
	protocol := "tcp"
	address := fmt.Sprintf("%s:%d", config.Host, config.Port)

	// Reuse SSH logic from app.go/ssh.go if available globally or duplicate logic
	// For now assuming RegisterSSHNetwork is global
	if config.UseSSH {
		netName, err := RegisterSSHNetwork(config.SSH)
		if err == nil {
			protocol = netName
			address = fmt.Sprintf("%s:%d", config.Host, config.Port)
		}
	}

	return fmt.Sprintf("%s:%s@%s(%s)/%s?charset=utf8mb4&parseTime=True&loc=Local",
		config.User, config.Password, protocol, address, database)
}

func (m *MySQLDB) Connect(config ConnectionConfig) error {
	dsn := m.getDSN(config)
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return err
	}
	m.conn = db
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
	ctx, cancel := contextWithTimeout(5 * time.Second)
	defer cancel()
	return m.conn.PingContext(ctx)
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
	// MySQL connection is usually bound to a DB, but we might need to query another DB or just SHOW TABLES
	// If current conn is bound to dbName, fine. If not, SHOW TABLES FROM dbName
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
		// The column name is usually "Tables_in_dbname"
		for _, v := range row {
			tables = append(tables, fmt.Sprintf("%v", v))
			break // Only first column
		}
	}
	return tables, nil
}

func (m *MySQLDB) GetCreateStatement(dbName, tableName string) (string, error) {
	query := fmt.Sprintf("SHOW CREATE TABLE `%s`.`%s`", dbName, tableName)
	// If dbName is already selected or empty, just table name
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

func (m *MySQLDB) GetColumns(dbName, tableName string) ([]ColumnDefinition, error) {
	query := fmt.Sprintf("SHOW FULL COLUMNS FROM `%s`.`%s`", dbName, tableName)
	if dbName == "" {
		query = fmt.Sprintf("SHOW FULL COLUMNS FROM `%s`", tableName)
	}

	data, _, err := m.Query(query)
	if err != nil {
		return nil, err
	}

	var columns []ColumnDefinition
	for _, row := range data {
		col := ColumnDefinition{
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

func (m *MySQLDB) GetIndexes(dbName, tableName string) ([]IndexDefinition, error) {
	query := fmt.Sprintf("SHOW INDEX FROM `%s`.`%s`", dbName, tableName)
	if dbName == "" {
		query = fmt.Sprintf("SHOW INDEX FROM `%s`", tableName)
	}

	data, _, err := m.Query(query)
	if err != nil {
		return nil, err
	}

	var indexes []IndexDefinition
	for _, row := range data {
		// Need to handle types carefully. Non_unique is int usually.
		nonUnique := 0
		if val, ok := row["Non_unique"]; ok {
            // Handle various number types (json decoding might be float64)
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

		idx := IndexDefinition{
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

func (m *MySQLDB) GetForeignKeys(dbName, tableName string) ([]ForeignKeyDefinition, error) {
	query := fmt.Sprintf(`SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME 
              FROM information_schema.KEY_COLUMN_USAGE 
              WHERE TABLE_SCHEMA = '%s' AND TABLE_NAME = '%s' AND REFERENCED_TABLE_NAME IS NOT NULL`, dbName, tableName)

	data, _, err := m.Query(query)
	if err != nil {
		return nil, err
	}

	var fks []ForeignKeyDefinition
	for _, row := range data {
		fk := ForeignKeyDefinition{
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

func (m *MySQLDB) GetTriggers(dbName, tableName string) ([]TriggerDefinition, error) {
	query := fmt.Sprintf("SHOW TRIGGERS FROM `%s` WHERE `Table` = '%s'", dbName, tableName)
	data, _, err := m.Query(query)
	if err != nil {
		return nil, err
	}

	var triggers []TriggerDefinition
	for _, row := range data {
		trig := TriggerDefinition{
			Name:      fmt.Sprintf("%v", row["Trigger"]),
			Timing:    fmt.Sprintf("%v", row["Timing"]),
			Event:     fmt.Sprintf("%v", row["Event"]),
			Statement: fmt.Sprintf("%v", row["Statement"]),
		}
		triggers = append(triggers, trig)
	}
	return triggers, nil
}

func (m *MySQLDB) ApplyChanges(tableName string, changes ChangeSet) error {
	if m.conn == nil {
		return fmt.Errorf("connection not open")
	}

	tx, err := m.conn.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() // Rollback if not committed

	// 1. Deletes
	for _, pk := range changes.Deletes {
		// Build WHERE clause from PK
		var wheres []string
		var args []interface{}
		for k, v := range pk {
			wheres = append(wheres, fmt.Sprintf("`%s` = ?", k))
			args = append(args, v)
		}
		if len(wheres) == 0 {
			continue // Safety
		}
		query := fmt.Sprintf("DELETE FROM `%s` WHERE %s", tableName, strings.Join(wheres, " AND "))
		if _, err := tx.Exec(query, args...); err != nil {
			return fmt.Errorf("delete error: %v", err)
		}
	}

	// 2. Updates
	for _, update := range changes.Updates {
		var sets []string
		var args []interface{}
		
		for k, v := range update.Values {
			sets = append(sets, fmt.Sprintf("`%s` = ?", k))
			args = append(args, v)
		}
		
		if len(sets) == 0 {
			continue
		}

		var wheres []string
		for k, v := range update.Keys {
			wheres = append(wheres, fmt.Sprintf("`%s` = ?", k))
			args = append(args, v)
		}
		
		if len(wheres) == 0 {
			return fmt.Errorf("update requires keys") // Safety
		}

		query := fmt.Sprintf("UPDATE `%s` SET %s WHERE %s", tableName, strings.Join(sets, ", "), strings.Join(wheres, " AND "))
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
			cols = append(cols, fmt.Sprintf("`%s`", k))
			placeholders = append(placeholders, "?")
			args = append(args, v)
		}
		
		if len(cols) == 0 {
			continue
		}

		query := fmt.Sprintf("INSERT INTO `%s` (%s) VALUES (%s)", tableName, strings.Join(cols, ", "), strings.Join(placeholders, ", "))
		if _, err := tx.Exec(query, args...); err != nil {
			return fmt.Errorf("insert error: %v", err)
		}
	}

	return tx.Commit()
}

func (m *MySQLDB) GetAllColumns(dbName string) ([]ColumnDefinitionWithTable, error) {
	query := fmt.Sprintf("SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '%s'", dbName)
	if dbName == "" {
		// If dbName is empty, we might need to use the current DB from connection? 
		// But information_schema requires a schema filter usually or it returns all.
		// Let's assume dbName is provided or we try to get it.
		// For MVP, if empty, we return empty or try "SELECT DATABASE()".
		return nil, fmt.Errorf("database name required for GetAllColumns")
	}

	data, _, err := m.Query(query)
	if err != nil {
		return nil, err
	}

	var cols []ColumnDefinitionWithTable
	for _, row := range data {
		col := ColumnDefinitionWithTable{
			TableName: fmt.Sprintf("%v", row["TABLE_NAME"]),
			Name:      fmt.Sprintf("%v", row["COLUMN_NAME"]),
			Type:      fmt.Sprintf("%v", row["COLUMN_TYPE"]),
		}
		cols = append(cols, col)
	}
	return cols, nil
}