package db

import (
	"database/sql"
	"fmt"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/utils"

	_ "modernc.org/sqlite"
)

type SQLiteDB struct {
	conn        *sql.DB
	pingTimeout time.Duration
}

func (s *SQLiteDB) Connect(config connection.ConnectionConfig) error {
	dsn := config.Host 
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return fmt.Errorf("打开数据库连接失败：%w", err)
	}
	s.conn = db
	s.pingTimeout = getConnectTimeout(config)
	
	// Force verification
	if err := s.Ping(); err != nil {
		return fmt.Errorf("连接建立后验证失败：%w", err)
	}
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
	timeout := s.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
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

func (s *SQLiteDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	return []connection.ColumnDefinition{}, nil
}

func (s *SQLiteDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return []connection.IndexDefinition{}, nil
}

func (s *SQLiteDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

func (s *SQLiteDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}

func (s *SQLiteDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return []connection.ColumnDefinitionWithTable{}, nil
}
