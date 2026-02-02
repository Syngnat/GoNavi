package main

import (
	"database/sql"
	"fmt"
	"time"

	_ "github.com/lib/pq"
)

type PostgresDB struct {
	conn *sql.DB
}

func (p *PostgresDB) getDSN(config ConnectionConfig) string {
	// postgres://user:password@host:port/dbname?sslmode=disable
	// If SSH is used, host/port will be local tunnel, similar to MySQL
	host := config.Host
	port := config.Port
	if config.UseSSH {
		// Assuming generic SSH tunnel registered for PG as well
		// But lib/pq registerDialer is different or harder to hook.
		// For MVP, if we use the same RegisterSSHNetwork, we need to see if lib/pq supports custom dialer easily.
		// lib/pq uses 'postgres' driver. hooking dialer is not standard in DSN.
		// Standard SSH tunneling: Listen on local port -> Forward to remote.
		// Our implementation in ssh.go does RegisterDialContext which works for drivers that support it (mysql does).
		// lib/pq *does not* support DialContext in sql.Open directly via DSN easily without wrapping connector.
		// 
		// FOR NOW: Disable SSH for Postgres in MVP or use basic local forwarding manually if we had time.
		// Let's assume direct connection for PG MVP.
	}

	dbname := config.Database
	if dbname == "" {
		dbname = "postgres" // Default DB
	}

	return fmt.Sprintf("postgres://%s:%s@%s:%d/%s?sslmode=disable",
		config.User, config.Password, host, port, dbname)
}

func (p *PostgresDB) Connect(config ConnectionConfig) error {
	dsn := p.getDSN(config)
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return err
	}
	p.conn = db
	return nil
}

func (p *PostgresDB) Close() error {
	if p.conn != nil {
		return p.conn.Close()
	}
	return nil
}

func (p *PostgresDB) Ping() error {
	if p.conn == nil {
		return fmt.Errorf("connection not open")
	}
	ctx, cancel := contextWithTimeout(5 * time.Second)
	defer cancel()
	return p.conn.PingContext(ctx)
}

func (p *PostgresDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if p.conn == nil {
		return nil, nil, fmt.Errorf("connection not open")
	}


rows, err := p.conn.Query(query)
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

func (p *PostgresDB) Exec(query string) (int64, error) {
	if p.conn == nil {
		return 0, fmt.Errorf("connection not open")
	}
	res, err := p.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (p *PostgresDB) GetDatabases() ([]string, error) {
	data, _, err := p.Query("SELECT datname FROM pg_database WHERE datistemplate = false")
	if err != nil {
		return nil, err
	}
	var dbs []string
	for _, row := range data {
		if val, ok := row["datname"]; ok {
			dbs = append(dbs, fmt.Sprintf("%v", val))
		}
	}
	return dbs, nil
}

func (p *PostgresDB) GetTables(dbName string) ([]string, error) {
	// In PG, dbName usually implies a separate connection. 
	// If we are already connected to 'postgres' db, we can't easily query tables of another DB without reconnecting.
	// For MVP simplicity: we assume the user connects to the specific DB, or we list tables of current DB.
	// If dbName is provided and different from current, we might need to error or reconnect (logic in App layer).
	// Here we query current connection's tables.
	query := "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname != 'pg_catalog' AND schemaname != 'information_schema'"
	data, _, err := p.Query(query)
	if err != nil {
		return nil, err
	}
	
	var tables []string
	for _, row := range data {
		if val, ok := row["tablename"]; ok {
			tables = append(tables, fmt.Sprintf("%v", val))
		}
	}
	return tables, nil
}

func (p *PostgresDB) GetCreateStatement(dbName, tableName string) (string, error) {
    // PG doesn't have SHOW CREATE TABLE. We need a complex query or use pg_dump logic.
    // MVP: return placeholder or simple definition.
    // Or use a query to reconstruct it (simplified).
	return fmt.Sprintf("-- SHOW CREATE TABLE not fully supported for PostgreSQL in this MVP.\n-- Table: %s", tableName), nil
}

func (p *PostgresDB) GetColumns(dbName, tableName string) ([]ColumnDefinition, error) {
	// TODO: Implement query against information_schema.columns
	return []ColumnDefinition{}, nil
}

func (p *PostgresDB) GetIndexes(dbName, tableName string) ([]IndexDefinition, error) {
	// TODO: Implement query against pg_indexes
	return []IndexDefinition{}, nil
}

func (p *PostgresDB) GetForeignKeys(dbName, tableName string) ([]ForeignKeyDefinition, error) {
	return []ForeignKeyDefinition{}, nil
}

func (p *PostgresDB) GetTriggers(dbName, tableName string) ([]TriggerDefinition, error) {
	return []TriggerDefinition{}, nil
}

func (p *PostgresDB) GetAllColumns(dbName string) ([]ColumnDefinitionWithTable, error) {
	// TODO: Implement using information_schema.columns
	return []ColumnDefinitionWithTable{}, nil
}
