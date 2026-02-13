package db

import (
	"GoNavi-Wails/internal/connection"
	"fmt"
	"strings"
)

type Database interface {
	Connect(config connection.ConnectionConfig) error
	Close() error
	Ping() error
	Query(query string) ([]map[string]interface{}, []string, error)
	Exec(query string) (int64, error)
	GetDatabases() ([]string, error)
	GetTables(dbName string) ([]string, error)
	GetCreateStatement(dbName, tableName string) (string, error)
	GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error)
	GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error)
	GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error)
	GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error)
	GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error)
}

type BatchApplier interface {
	ApplyChanges(tableName string, changes connection.ChangeSet) error
}

type databaseFactory func() Database

var databaseFactories = map[string]databaseFactory{
	"mysql": func() Database {
		return &MySQLDB{}
	},
	"postgres": func() Database {
		return &PostgresDB{}
	},
	"oracle": func() Database {
		return &OracleDB{}
	},
	"custom": func() Database {
		return &CustomDB{}
	},
}

func init() {
	registerOptionalDatabaseFactories()
}

func registerDatabaseFactory(factory databaseFactory, dbTypes ...string) {
	if factory == nil || len(dbTypes) == 0 {
		return
	}
	for _, dbType := range dbTypes {
		normalized := normalizeDatabaseType(dbType)
		if normalized == "" {
			continue
		}
		databaseFactories[normalized] = factory
	}
}

func normalizeDatabaseType(dbType string) string {
	normalized := strings.ToLower(strings.TrimSpace(dbType))
	switch normalized {
	case "doris":
		return "diros"
	case "postgresql":
		return "postgres"
	default:
		return normalized
	}
}

// Factory
func NewDatabase(dbType string) (Database, error) {
	normalized := normalizeDatabaseType(dbType)
	if normalized == "" {
		normalized = "mysql"
	}
	factory, ok := databaseFactories[normalized]
	if !ok {
		return nil, fmt.Errorf("unsupported database type: %s", dbType)
	}
	return factory(), nil
}
