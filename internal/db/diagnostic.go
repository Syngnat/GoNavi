package db

import "database/sql"

// DiagnosticPoolStats is a privacy-safe snapshot of database/sql pool counters.
// It deliberately has no endpoint, database, SQL, or credential fields.
type DiagnosticPoolStats struct {
	MaxOpenConnections int   `json:"maxOpenConnections"`
	OpenConnections    int   `json:"openConnections"`
	InUse              int   `json:"inUse"`
	Idle               int   `json:"idle"`
	WaitCount          int64 `json:"waitCount"`
	WaitDurationMs     int64 `json:"waitDurationMs"`
	MaxIdleClosed      int64 `json:"maxIdleClosed"`
	MaxIdleTimeClosed  int64 `json:"maxIdleTimeClosed"`
	MaxLifetimeClosed  int64 `json:"maxLifetimeClosed"`
}

// DatabasePoolStats returns pool counters when this build's database
// implementation exposes a known database/sql pool. Other drivers deliberately
// report unavailable instead of fabricating zero values.
func DatabasePoolStats(database Database) (DiagnosticPoolStats, bool) {
	switch instance := database.(type) {
	case *CustomDB:
		return diagnosticPoolStats(instance.conn)
	case *MySQLDB:
		return diagnosticPoolStats(instance.conn)
	case *OracleDB:
		return diagnosticPoolStats(instance.conn)
	case *PostgresDB:
		return diagnosticPoolStats(instance.conn)
	default:
		return DiagnosticPoolStats{}, false
	}
}

func diagnosticPoolStats(pool *sql.DB) (DiagnosticPoolStats, bool) {
	if pool == nil {
		return DiagnosticPoolStats{}, false
	}
	stats := pool.Stats()
	return DiagnosticPoolStats{
		MaxOpenConnections: stats.MaxOpenConnections,
		OpenConnections:    stats.OpenConnections,
		InUse:              stats.InUse,
		Idle:               stats.Idle,
		WaitCount:          stats.WaitCount,
		WaitDurationMs:     stats.WaitDuration.Milliseconds(),
		MaxIdleClosed:      stats.MaxIdleClosed,
		MaxIdleTimeClosed:  stats.MaxIdleTimeClosed,
		MaxLifetimeClosed:  stats.MaxLifetimeClosed,
	}, true
}
