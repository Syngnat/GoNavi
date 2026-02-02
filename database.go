package main

import "fmt"

type ColumnDefinition struct {
	Name     string  `json:"name"`
	Type     string  `json:"type"`
	Nullable string  `json:"nullable"` // YES/NO
	Key      string  `json:"key"`      // PRI, UNI, MUL
	Default  *string `json:"default"`
	Extra    string  `json:"extra"`    // auto_increment
	Comment  string  `json:"comment"`
}

type IndexDefinition struct {
	Name       string `json:"name"`
	ColumnName string `json:"columnName"`
	NonUnique  int    `json:"nonUnique"`
	SeqInIndex int    `json:"seqInIndex"`
	IndexType  string `json:"indexType"`
}

type ForeignKeyDefinition struct {
	Name           string `json:"name"`
	ColumnName     string `json:"columnName"`
	RefTableName   string `json:"refTableName"`
	RefColumnName  string `json:"refColumnName"`
	ConstraintName string `json:"constraintName"`
}

type TriggerDefinition struct {
	Name    string `json:"name"`
	Timing  string `json:"timing"` // BEFORE/AFTER
	Event   string `json:"event"`  // INSERT/UPDATE/DELETE
	Statement string `json:"statement"`
}

type ColumnDefinitionWithTable struct {
	TableName string `json:"tableName"`
	Name      string `json:"name"`
	Type      string `json:"type"`
}

type Database interface {
	Connect(config ConnectionConfig) error
	Close() error
	Ping() error
	Query(query string) ([]map[string]interface{}, []string, error)
	Exec(query string) (int64, error)
	GetDatabases() ([]string, error)
	GetTables(dbName string) ([]string, error)
	GetCreateStatement(dbName, tableName string) (string, error)
	GetColumns(dbName, tableName string) ([]ColumnDefinition, error)
	GetAllColumns(dbName string) ([]ColumnDefinitionWithTable, error)
	GetIndexes(dbName, tableName string) ([]IndexDefinition, error)
	GetForeignKeys(dbName, tableName string) ([]ForeignKeyDefinition, error)
	GetTriggers(dbName, tableName string) ([]TriggerDefinition, error)
}

type BatchApplier interface {
	ApplyChanges(tableName string, changes ChangeSet) error
}

// Factory
func NewDatabase(dbType string) (Database, error) {
	switch dbType {
	case "mysql":
		return &MySQLDB{}, nil
	case "postgres":
		return &PostgresDB{}, nil
	case "sqlite":
		return &SQLiteDB{}, nil
	default:
		// Default to MySQL for backward compatibility if empty
		if dbType == "" {
			return &MySQLDB{}, nil
		}
		return nil, fmt.Errorf("unsupported database type: %s", dbType)
	}
}
