package db

import (
	"database/sql/driver"
	"net/http"
)

const (
	navicatMySQLTunnelMagic                       = 1111
	maxNavicatMySQLTunnelResponseBytes            = 128 << 20
	maxNavicatMySQLTunnelDecodedAllocBytes        = 64 << 20
	maxNavicatMySQLTunnelFields                   = 4096
	maxNavicatMySQLTunnelRows                     = 1_000_000
	maxNavicatMySQLTunnelCells             uint64 = 2_000_000
)

type navicatMySQLTunnelConnector struct {
	client *navicatMySQLTunnelClient
}

type navicatMySQLTunnelDriver struct{}

type navicatMySQLTunnelConn struct {
	client *navicatMySQLTunnelClient
}

type navicatMySQLTunnelStmt struct {
	conn  *navicatMySQLTunnelConn
	query string
}

type navicatMySQLTunnelClient struct {
	endpoint   string
	httpClient *http.Client
	host       string
	port       int
	login      string
	password   string
	database   string
	webUser    string
	webPass    string
	base64SQL  bool
}

type navicatMySQLTunnelResult struct {
	fields       []navicatMySQLTunnelField
	rows         [][]driver.Value
	affectedRows int64
	insertID     int64
	info         string
}

type navicatMySQLTunnelField struct {
	name       string
	table      string
	typeID     uint32
	flags      uint32
	length     uint32
	databaseTy string
}

type navicatMySQLTunnelRows struct {
	fields []navicatMySQLTunnelField
	rows   [][]driver.Value
	index  int
}

type navicatMySQLTunnelExecResult struct {
	lastInsertID int64
	rowsAffected int64
}

type navicatMySQLTunnelProtocolError struct {
	code    uint32
	message string
}

type navicatMySQLTunnelParser struct {
	body                  []byte
	offset                int
	decodedAllocationSize uint64
}

var (
	_ driver.Connector                      = (*navicatMySQLTunnelConnector)(nil)
	_ driver.Driver                         = navicatMySQLTunnelDriver{}
	_ driver.Conn                           = (*navicatMySQLTunnelConn)(nil)
	_ driver.ConnPrepareContext             = (*navicatMySQLTunnelConn)(nil)
	_ driver.Pinger                         = (*navicatMySQLTunnelConn)(nil)
	_ driver.QueryerContext                 = (*navicatMySQLTunnelConn)(nil)
	_ driver.ExecerContext                  = (*navicatMySQLTunnelConn)(nil)
	_ driver.ConnBeginTx                    = (*navicatMySQLTunnelConn)(nil)
	_ driver.Stmt                           = (*navicatMySQLTunnelStmt)(nil)
	_ driver.StmtQueryContext               = (*navicatMySQLTunnelStmt)(nil)
	_ driver.StmtExecContext                = (*navicatMySQLTunnelStmt)(nil)
	_ driver.Rows                           = (*navicatMySQLTunnelRows)(nil)
	_ driver.RowsColumnTypeDatabaseTypeName = (*navicatMySQLTunnelRows)(nil)
	_ driver.RowsColumnTypeLength           = (*navicatMySQLTunnelRows)(nil)
	_ driver.RowsColumnTypeScanType         = (*navicatMySQLTunnelRows)(nil)
	_ driver.Result                         = navicatMySQLTunnelExecResult{}
)
