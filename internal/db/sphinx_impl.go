package db

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

const sphinxDefaultDatabaseName = "default"

// SphinxDB 复用 MySQL 协议实现，并在数据库列表不可用时提供兜底。
type SphinxDB struct {
	MySQLDB
	fallbackDatabase string
}

func isSphinxUnsupportedFeatureError(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(strings.TrimSpace(err.Error()))
	if text == "" {
		return false
	}
	keywords := []string{
		"not supported",
		"unsupported",
		"syntax error",
		"unknown table",
		"unknown column",
		"doesn't exist",
	}
	for _, keyword := range keywords {
		if strings.Contains(text, keyword) {
			return true
		}
	}
	return false
}

func (s *SphinxDB) Connect(config connection.ConnectionConfig) error {
	runConfig := applyMySQLURI(config)
	s.fallbackDatabase = strings.TrimSpace(runConfig.Database)
	return s.MySQLDB.Connect(config)
}

func (s *SphinxDB) resolveDatabaseName(dbName string) string {
	name := strings.TrimSpace(dbName)
	if name == "" {
		return s.fallbackDatabase
	}
	if strings.EqualFold(name, sphinxDefaultDatabaseName) && s.fallbackDatabase == "" {
		return ""
	}
	return name
}

func (s *SphinxDB) GetDatabases() ([]string, error) {
	dbs, err := s.MySQLDB.GetDatabases()
	if err == nil && len(dbs) > 0 {
		return dbs, nil
	}
	if s.fallbackDatabase != "" {
		return []string{s.fallbackDatabase}, nil
	}
	return []string{sphinxDefaultDatabaseName}, nil
}

func (s *SphinxDB) GetTables(dbName string) ([]string, error) {
	tables, err := s.MySQLDB.GetTables(s.resolveDatabaseName(dbName))
	if err == nil {
		return tables, nil
	}
	if !isSphinxUnsupportedFeatureError(err) {
		return nil, err
	}

	// Sphinx/Manticore 常见返回列名为 `Index`，并且不支持 `SHOW TABLES FROM <db>` 语法。
	data, fields, fallbackErr := s.MySQLDB.Query("SHOW TABLES")
	if fallbackErr != nil {
		return nil, fallbackErr
	}

	fallbackTables := make([]string, 0, len(data))
	for _, row := range data {
		if val, ok := row["Index"]; ok {
			fallbackTables = append(fallbackTables, fmt.Sprintf("%v", val))
			continue
		}
		if val, ok := row["index"]; ok {
			fallbackTables = append(fallbackTables, fmt.Sprintf("%v", val))
			continue
		}
		for _, field := range fields {
			if val, ok := row[field]; ok {
				fallbackTables = append(fallbackTables, fmt.Sprintf("%v", val))
				break
			}
		}
	}

	return fallbackTables, nil
}

func (s *SphinxDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return s.MySQLDB.GetCreateStatement(s.resolveDatabaseName(dbName), tableName)
}

func (s *SphinxDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	return s.MySQLDB.GetColumns(s.resolveDatabaseName(dbName), tableName)
}

func (s *SphinxDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return s.MySQLDB.GetAllColumns(s.resolveDatabaseName(dbName))
}

func (s *SphinxDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return s.MySQLDB.GetIndexes(s.resolveDatabaseName(dbName), tableName)
}

func (s *SphinxDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	fks, err := s.MySQLDB.GetForeignKeys(s.resolveDatabaseName(dbName), tableName)
	if err != nil && isSphinxUnsupportedFeatureError(err) {
		return []connection.ForeignKeyDefinition{}, nil
	}
	return fks, err
}

func (s *SphinxDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	triggers, err := s.MySQLDB.GetTriggers(s.resolveDatabaseName(dbName), tableName)
	if err != nil && isSphinxUnsupportedFeatureError(err) {
		return []connection.TriggerDefinition{}, nil
	}
	return triggers, err
}
