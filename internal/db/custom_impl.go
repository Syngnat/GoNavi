package db

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/utils"
)

type CustomDB struct {
	conn   *sql.DB
	driver string
}

func (c *CustomDB) Connect(config connection.ConnectionConfig) error {
	if config.Driver == "" || config.DSN == "" {
		return fmt.Errorf("driver and dsn are required for custom connection")
	}

	// Verify driver is registered (implicit check by sql.Open)
	// We might not need explicit check, sql.Open will fail or Ping will fail if driver not found.

	db, err := sql.Open(config.Driver, config.DSN)
	if err != nil {
		return err
	}
	c.conn = db
	c.driver = config.Driver
	return c.Ping()
}

func (c *CustomDB) Close() error {
	if c.conn != nil {
		return c.conn.Close()
	}
	return nil
}

func (c *CustomDB) Ping() error {
	if c.conn == nil {
		return fmt.Errorf("connection not open")
	}
	ctx, cancel := utils.ContextWithTimeout(5 * time.Second)
	defer cancel()
	return c.conn.PingContext(ctx)
}

func (c *CustomDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if c.conn == nil {
		return nil, nil, fmt.Errorf("connection not open")
	}

	rows, err := c.conn.Query(query)
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

func (c *CustomDB) Exec(query string) (int64, error) {
	if c.conn == nil {
		return 0, fmt.Errorf("connection not open")
	}
	res, err := c.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (c *CustomDB) GetDatabases() ([]string, error) {
	// Try standard information_schema or some known patterns if we can't guess
	// For "custom", we can't easily know.
	// But many DBs support SHOW DATABASES or SELECT datname FROM pg_database
	// We'll try a generic query or return empty.
	// Users using custom might know their DB context is single.

	// Best effort:
	return []string{}, nil
}

func (c *CustomDB) GetTables(dbName string) ([]string, error) {
	// ANSI Standard
	query := "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
	// If mysql-like
	if c.driver == "mysql" {
		query = "SHOW TABLES"
		if dbName != "" {
			query = fmt.Sprintf("SHOW TABLES FROM `%s`", dbName)
		}
	} else if c.driver == "postgres" || c.driver == "kingbase" {
		if dbName != "" && dbName != "public" {
			query = fmt.Sprintf("SELECT table_name FROM information_schema.tables WHERE table_schema = '%s'", dbName)
		}
	} else if c.driver == "sqlite" {
		query = "SELECT name FROM sqlite_master WHERE type='table'"
	} else if c.driver == "oracle" || c.driver == "dm" {
		query = "SELECT table_name FROM user_tables"
	}

	// Fallback generic execution
	data, _, err := c.Query(query)
	if err != nil {
		return nil, fmt.Errorf("failed to get tables for custom driver %s: %v", c.driver, err)
	}

	var tables []string
	for _, row := range data {
		// iterate keys to find likely column
		for k, v := range row {
			if strings.Contains(strings.ToLower(k), "name") || strings.Contains(strings.ToLower(k), "table") {
				tables = append(tables, fmt.Sprintf("%v", v))
				break
			}
		}
	}
	return tables, nil
}

func (c *CustomDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return "Not supported for custom connections yet", nil
}

func (c *CustomDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	// ANSI Standard
	// SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = '...'

	schema := "public"
	if dbName != "" {
		schema = dbName
	}

	query := fmt.Sprintf(`SELECT column_name, data_type, is_nullable, column_default 
		FROM information_schema.columns 
		WHERE table_name = '%s'`, tableName)

	// Adjust for schema if likely supported
	if c.driver == "postgres" || c.driver == "kingbase" {
		query += fmt.Sprintf(" AND table_schema = '%s'", schema)
	} else if c.driver == "mysql" {
		query = fmt.Sprintf("SHOW FULL COLUMNS FROM `%s`", tableName)
		if dbName != "" {
			query = fmt.Sprintf("SHOW FULL COLUMNS FROM `%s`.`%s`", dbName, tableName)
		}
	}

	data, _, err := c.Query(query)
	if err != nil {
		return nil, err
	}

	var columns []connection.ColumnDefinition
	for _, row := range data {
		col := connection.ColumnDefinition{}
		// flexible mapping
		for k, v := range row {
			kl := strings.ToLower(k)
			val := fmt.Sprintf("%v", v)
			if strings.Contains(kl, "field") || strings.Contains(kl, "column_name") {
				col.Name = val
			} else if strings.Contains(kl, "type") {
				col.Type = val
			} else if strings.Contains(kl, "null") || strings.Contains(kl, "nullable") {
				col.Nullable = val
			} else if strings.Contains(kl, "default") {
				col.Default = &val
			} else if strings.Contains(kl, "key") {
				col.Key = val
			} else if strings.Contains(kl, "comment") {
				col.Comment = val
			}
		}
		columns = append(columns, col)
	}
	return columns, nil
}

func (c *CustomDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return nil, fmt.Errorf("not implemented for custom")
}

func (c *CustomDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return nil, fmt.Errorf("not implemented for custom")
}

func (c *CustomDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return nil, fmt.Errorf("not implemented for custom")
}

func (c *CustomDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return fmt.Errorf("read-only mode for custom")
}

func (c *CustomDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, fmt.Errorf("not implemented for custom")
}
