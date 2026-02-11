package db

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
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
	// Sphinx 使用 DESCRIBE 语法获取索引结构
	query := fmt.Sprintf("DESCRIBE %s", tableName)
	data, _, err := s.MySQLDB.Query(query)
	if err != nil {
		// 如果 DESCRIBE 失败，尝试使用 MySQL 的方式作为降级
		return s.MySQLDB.GetColumns(s.resolveDatabaseName(dbName), tableName)
	}

	var columns []connection.ColumnDefinition
	for _, row := range data {
		// Sphinx DESCRIBE 返回的字段：Field, Type, Properties
		fieldName := ""
		if val, ok := row["Field"]; ok {
			fieldName = fmt.Sprintf("%v", val)
		} else if val, ok := row["field"]; ok {
			fieldName = fmt.Sprintf("%v", val)
		}

		fieldType := ""
		if val, ok := row["Type"]; ok {
			fieldType = fmt.Sprintf("%v", val)
		} else if val, ok := row["type"]; ok {
			fieldType = fmt.Sprintf("%v", val)
		}

		properties := ""
		if val, ok := row["Properties"]; ok {
			properties = fmt.Sprintf("%v", val)
		} else if val, ok := row["properties"]; ok {
			properties = fmt.Sprintf("%v", val)
		}

		if fieldName == "" {
			continue
		}

		col := connection.ColumnDefinition{
			Name:     fieldName,
			Type:     fieldType,
			Nullable: "YES", // Sphinx 默认字段可为空
			Key:      "",    // Sphinx 没有主键概念
			Default:  nil,   // Sphinx DESCRIBE 不返回默认值
			Extra:    properties,
			Comment:  "",
		}

		// 根据 properties 判断是否为索引字段
		if strings.Contains(strings.ToLower(properties), "indexed") {
			col.Key = "MUL"
		}

		columns = append(columns, col)
	}

	// 如果没有获取到任何列，尝试使用 MySQL 方式
	if len(columns) == 0 {
		logger.Warnf("Sphinx DESCRIBE 未返回任何列，尝试使用 MySQL 方式获取：表=%s", tableName)
		return s.MySQLDB.GetColumns(s.resolveDatabaseName(dbName), tableName)
	}

	return columns, nil
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
