package main

import (
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

type SQLiteDB struct {
	conn *sql.DB
}

func (s *SQLiteDB) Connect(config ConnectionConfig) error {
	// Host field will be used as File Path for SQLite
	dsn := config.Host 
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return err
	}
	s.conn = db
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
	ctx, cancel := contextWithTimeout(5 * time.Second)
	defer cancel()
	return s.conn.PingContext(ctx)
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
	// SQLite only has one DB (the file).
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

func (s *SQLiteDB) GetColumns(dbName, tableName string) ([]ColumnDefinition, error) {
	// SQLite has PRAGMA table_info(tableName)
	// For MVP Stub:
	return []ColumnDefinition{}, nil
}

func (s *SQLiteDB) GetIndexes(dbName, tableName string) ([]IndexDefinition, error) {
	return []IndexDefinition{}, nil
}

func (s *SQLiteDB) GetForeignKeys(dbName, tableName string) ([]ForeignKeyDefinition, error) {
	return []ForeignKeyDefinition{}, nil
}

func (s *SQLiteDB) GetTriggers(dbName, tableName string) ([]TriggerDefinition, error) {
	return []TriggerDefinition{}, nil
}

func (s *SQLiteDB) GetAllColumns(dbName string) ([]ColumnDefinitionWithTable, error) {
	return []ColumnDefinitionWithTable{}, nil
}
