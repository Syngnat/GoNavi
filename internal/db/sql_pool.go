package db

import (
	"database/sql"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
)

const (
	defaultSQLMaxOpenConns    = 4
	defaultSQLMaxIdleConns    = 1
	sqliteSQLMaxOpenConns     = 1
	sqliteSQLMaxIdleConns     = 1
	duckDBSQLMaxOpenConns     = 4
	duckDBSQLMaxIdleConns     = 1
	defaultSQLConnMaxLifetime = 30 * time.Minute
	defaultSQLConnMaxIdleTime = 30 * time.Second
	// SQL Server login can be expensive. Keep its single idle connection warm
	// until the normal lifetime rotation instead of expiring it at 30 seconds.
	sqlServerSQLConnMaxIdleTime = defaultSQLConnMaxLifetime
	// sqlPoolKeepAliveIdleMargin 给保活间隔预留的空闲窗口余量：保活扫描周期为 30 秒、
	// 单次探活最长 30 秒，间隔之外再留 2 分钟，避免池子在两次探活之间提前回收连接。
	sqlPoolKeepAliveIdleMargin = 2 * time.Minute
	// searchPathPoolConnMaxLifetime 收紧 search_path 重建池的生命周期，避免携带
	// 旧 search_path 的连接长期存活。
	searchPathPoolConnMaxLifetime = 5 * time.Minute
)

func resolveSQLConnectionPoolMaxIdleTime(dbType string) time.Duration {
	if strings.EqualFold(strings.TrimSpace(dbType), "sqlserver") {
		return sqlServerSQLConnMaxIdleTime
	}
	return defaultSQLConnMaxIdleTime
}

func configureSQLConnectionPool(db *sql.DB, dbType string, config connection.ConnectionConfig) {
	if db == nil {
		return
	}
	normalizedType := strings.ToLower(strings.TrimSpace(dbType))
	switch normalizedType {
	case "sqlite":
		db.SetMaxOpenConns(sqliteSQLMaxOpenConns)
		db.SetMaxIdleConns(sqliteSQLMaxIdleConns)
		return
	case "duckdb":
		db.SetMaxOpenConns(duckDBSQLMaxOpenConns)
		db.SetMaxIdleConns(duckDBSQLMaxIdleConns)
		return
	}
	db.SetMaxOpenConns(defaultSQLMaxOpenConns)
	maxIdle := 0
	if isSQLPoolKeepIdleProfile(normalizedType) {
		maxIdle = defaultSQLMaxIdleConns
	}
	db.SetMaxIdleConns(maxIdle)
	db.SetConnMaxIdleTime(resolveSQLConnectionPoolMaxIdleTime(dbType))
	db.SetConnMaxLifetime(defaultSQLConnMaxLifetime)
	applySQLConnectionPoolKeepAlive(db, config)
}

// isSQLPoolKeepIdleProfile 判断驱动是否沿用「保留 1 条空闲连接」的历史池配置。
func isSQLPoolKeepIdleProfile(normalizedType string) bool {
	switch normalizedType {
	case "oracle", "oceanbase", "kingbase", "sqlserver":
		return true
	}
	return false
}

// sqlPoolKeepAliveRetention 是开启保活时连接池应采用的回收策略。
type sqlPoolKeepAliveRetention struct {
	maxIdle  int
	idleTime time.Duration
	lifetime time.Duration
}

// resolveSQLPoolKeepAliveRetention 由保活配置推导连接池回收策略；保活关闭时 ok=false，
// 池子维持原有回收行为。堡垒机/临时凭据场景下令牌过期后无法再建立新连接，因此开启
// 保活必须持续复用已建立的物理连接：保留 1 条空闲连接、空闲回收窗口盖住探活间隔、
// 取消生命周期轮换。保活探活本身就是这条连接的健康检查，探活失败会清缓存并重建。
func resolveSQLPoolKeepAliveRetention(config connection.ConnectionConfig) (sqlPoolKeepAliveRetention, bool) {
	if !config.KeepAliveEnabled {
		return sqlPoolKeepAliveRetention{}, false
	}
	return sqlPoolKeepAliveRetention{
		maxIdle:  defaultSQLMaxIdleConns,
		idleTime: connection.ResolveKeepAliveInterval(config.KeepAliveIntervalMinutes) + sqlPoolKeepAliveIdleMargin,
		lifetime: 0,
	}, true
}

func applySQLConnectionPoolKeepAlive(db *sql.DB, config connection.ConnectionConfig) {
	retention, ok := resolveSQLPoolKeepAliveRetention(config)
	if !ok {
		return
	}
	db.SetMaxIdleConns(retention.maxIdle)
	db.SetConnMaxIdleTime(retention.idleTime)
	db.SetConnMaxLifetime(retention.lifetime)
}

// applySQLSearchPathPoolLifetimeCap 收紧 search_path 重建池的生命周期；开启保活时
// 不收紧，保留保活策略给的常驻连接，否则周期重建会让堡垒机临时凭据反复重新校验。
func applySQLSearchPathPoolLifetimeCap(db *sql.DB, config connection.ConnectionConfig) {
	if db == nil || config.KeepAliveEnabled {
		return
	}
	db.SetConnMaxLifetime(searchPathPoolConnMaxLifetime)
}
