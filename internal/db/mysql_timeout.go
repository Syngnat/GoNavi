package db

import (
	"time"

	mysql "github.com/go-sql-driver/mysql"
)

func effectiveMySQLPlanTimeout(dsn string, fallback time.Duration) time.Duration {
	parsed, err := mysql.ParseDSN(dsn)
	if err != nil || parsed.Timeout <= 0 {
		return fallback
	}
	return parsed.Timeout
}
