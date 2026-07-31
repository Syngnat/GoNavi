package db

import (
	"database/sql"
	"strings"
	"time"
)

const (
	defaultSQLMaxOpenConns    = 4
	defaultSQLMaxIdleConns    = 1
	defaultSQLConnMaxLifetime = 30 * time.Minute
	defaultSQLConnMaxIdleTime = 30 * time.Second
	// SQL Server login can be expensive. Keep its single idle connection warm
	// until the normal lifetime rotation instead of expiring it at 30 seconds.
	sqlServerSQLConnMaxIdleTime = defaultSQLConnMaxLifetime
)

func resolveSQLConnectionPoolMaxIdleTime(dbType string) time.Duration {
	if strings.EqualFold(strings.TrimSpace(dbType), "sqlserver") {
		return sqlServerSQLConnMaxIdleTime
	}
	return defaultSQLConnMaxIdleTime
}

func configureSQLConnectionPool(db *sql.DB, dbType string) {
	if db == nil {
		return
	}
	switch strings.ToLower(strings.TrimSpace(dbType)) {
	case "sqlite", "duckdb":
		return
	case "oracle", "oceanbase", "kingbase":
		db.SetMaxOpenConns(defaultSQLMaxOpenConns)
		db.SetMaxIdleConns(defaultSQLMaxIdleConns)
		db.SetConnMaxIdleTime(resolveSQLConnectionPoolMaxIdleTime(dbType))
		db.SetConnMaxLifetime(defaultSQLConnMaxLifetime)
		return
	case "sqlserver":
		db.SetMaxOpenConns(defaultSQLMaxOpenConns)
		db.SetMaxIdleConns(defaultSQLMaxIdleConns)
		db.SetConnMaxIdleTime(resolveSQLConnectionPoolMaxIdleTime(dbType))
		db.SetConnMaxLifetime(defaultSQLConnMaxLifetime)
		return
	}
	db.SetMaxOpenConns(defaultSQLMaxOpenConns)
	db.SetMaxIdleConns(0)
	db.SetConnMaxIdleTime(resolveSQLConnectionPoolMaxIdleTime(dbType))
	db.SetConnMaxLifetime(defaultSQLConnMaxLifetime)
}
