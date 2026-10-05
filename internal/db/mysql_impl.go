package db

import (
	"database/sql"
	"time"

	"GoNavi-Wails/internal/connection"
)

type MySQLDB struct {
	conn                *sql.DB
	pingTimeout         time.Duration
	batchWritesEnabled  bool
	navicatTunnel       bool
	navicatTunnelClient *navicatMySQLTunnelClient
	sshNetworkRegistrar func(connection.SSHConfig) (string, error)
}

var _ BatchApplierContext = (*MySQLDB)(nil)

const (
	defaultMySQLPort            = 3306
	defaultGoldenDBPort         = 1523
	defaultMySQLInsertBatchSize = 1000
	maxMySQLInsertBatchArgs     = 60000
)
