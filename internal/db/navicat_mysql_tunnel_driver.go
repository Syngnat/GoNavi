package db

import (
	"context"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"reflect"
	"strings"

	"GoNavi-Wails/internal/connection"

	mysql "github.com/go-sql-driver/mysql"
)

func isNavicatMySQLTunnelURL(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" {
		return false
	}
	return strings.EqualFold(parsed.Scheme, "http") || strings.EqualFold(parsed.Scheme, "https")
}

func newNavicatMySQLTunnelConnector(config connection.ConnectionConfig) (*navicatMySQLTunnelConnector, error) {
	endpoint := strings.TrimSpace(config.HTTPTunnel.Host)
	if !isNavicatMySQLTunnelURL(endpoint) {
		return nil, fmt.Errorf("Navicat HTTP 隧道地址无效：必须填写完整的 http:// 或 https:// URL")
	}
	port := config.Port
	if port <= 0 {
		port = resolveMySQLCompatibleDefaultPort(config)
	}
	return &navicatMySQLTunnelConnector{client: &navicatMySQLTunnelClient{
		endpoint: endpoint,
		httpClient: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
			// A 307/308 redirect would replay database credentials and SQL in the
			// POST body to a different endpoint. Tunnel URLs must be explicit.
			return http.ErrUseLastResponse
		}},
		host:      strings.TrimSpace(config.Host),
		port:      port,
		login:     config.User,
		password:  config.Password,
		database:  config.Database,
		webUser:   strings.TrimSpace(config.HTTPTunnel.User),
		webPass:   config.HTTPTunnel.Password,
		base64SQL: config.HTTPTunnel.EncodeBase64 == nil || *config.HTTPTunnel.EncodeBase64,
	}}, nil
}

func (c *navicatMySQLTunnelConnector) Connect(context.Context) (driver.Conn, error) {
	if c == nil || c.client == nil {
		return nil, errors.New("Navicat HTTP 隧道连接器未初始化")
	}
	return &navicatMySQLTunnelConn{client: c.client}, nil
}

func (*navicatMySQLTunnelConnector) Driver() driver.Driver {
	return navicatMySQLTunnelDriver{}
}

func (navicatMySQLTunnelDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("Navicat HTTP 隧道必须通过 Connector 打开")
}

func (c *navicatMySQLTunnelConn) Prepare(query string) (driver.Stmt, error) {
	return c.PrepareContext(context.Background(), query)
}

func (c *navicatMySQLTunnelConn) PrepareContext(_ context.Context, query string) (driver.Stmt, error) {
	return &navicatMySQLTunnelStmt{conn: c, query: query}, nil
}

func (*navicatMySQLTunnelConn) Close() error { return nil }

func (*navicatMySQLTunnelConn) Begin() (driver.Tx, error) {
	return nil, navicatMySQLTunnelTransactionError()
}

func (*navicatMySQLTunnelConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return nil, navicatMySQLTunnelTransactionError()
}

func (c *navicatMySQLTunnelConn) Ping(ctx context.Context) error {
	if c == nil || c.client == nil {
		return errors.New("Navicat HTTP 隧道连接未初始化")
	}
	return c.client.ping(ctx)
}

func (c *navicatMySQLTunnelConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if c == nil || c.client == nil {
		return nil, errors.New("Navicat HTTP 隧道连接未初始化")
	}
	interpolated, err := interpolateNavicatMySQLQuery(query, args)
	if err != nil {
		return nil, err
	}
	if isNavicatMySQLTransactionControl(interpolated) {
		return nil, navicatMySQLTunnelTransactionError()
	}
	result, err := c.client.query(ctx, interpolated)
	if err != nil {
		return nil, err
	}
	return &navicatMySQLTunnelRows{fields: result.fields, rows: result.rows}, nil
}

func (c *navicatMySQLTunnelConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if c == nil || c.client == nil {
		return nil, errors.New("Navicat HTTP 隧道连接未初始化")
	}
	interpolated, err := interpolateNavicatMySQLQuery(query, args)
	if err != nil {
		return nil, err
	}
	if isNavicatMySQLTransactionControl(interpolated) {
		return nil, navicatMySQLTunnelTransactionError()
	}
	result, err := c.client.query(ctx, interpolated)
	if err != nil {
		return nil, err
	}
	return navicatMySQLTunnelExecResult{
		lastInsertID: result.insertID,
		rowsAffected: result.affectedRows,
	}, nil
}

func (*navicatMySQLTunnelStmt) Close() error { return nil }

func (*navicatMySQLTunnelStmt) NumInput() int { return -1 }

func (s *navicatMySQLTunnelStmt) Query(args []driver.Value) (driver.Rows, error) {
	return s.QueryContext(context.Background(), namedValuesFromDriverValues(args))
}

func (s *navicatMySQLTunnelStmt) QueryContext(ctx context.Context, args []driver.NamedValue) (driver.Rows, error) {
	return s.conn.QueryContext(ctx, s.query, args)
}

func (s *navicatMySQLTunnelStmt) Exec(args []driver.Value) (driver.Result, error) {
	return s.ExecContext(context.Background(), namedValuesFromDriverValues(args))
}

func (s *navicatMySQLTunnelStmt) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	return s.conn.ExecContext(ctx, s.query, args)
}

func namedValuesFromDriverValues(values []driver.Value) []driver.NamedValue {
	result := make([]driver.NamedValue, len(values))
	for index, value := range values {
		result[index] = driver.NamedValue{Ordinal: index + 1, Value: value}
	}
	return result
}

func (r *navicatMySQLTunnelRows) Columns() []string {
	columns := make([]string, len(r.fields))
	for index := range r.fields {
		columns[index] = r.fields[index].name
	}
	return columns
}

func (*navicatMySQLTunnelRows) Close() error { return nil }

func (r *navicatMySQLTunnelRows) Next(dest []driver.Value) error {
	if r.index >= len(r.rows) {
		return io.EOF
	}
	row := r.rows[r.index]
	for index := range dest {
		if index < len(row) {
			dest[index] = row[index]
		} else {
			dest[index] = nil
		}
	}
	r.index++
	return nil
}

func (r *navicatMySQLTunnelRows) ColumnTypeDatabaseTypeName(index int) string {
	if index < 0 || index >= len(r.fields) {
		return ""
	}
	return r.fields[index].databaseTy
}

func (r *navicatMySQLTunnelRows) ColumnTypeLength(index int) (int64, bool) {
	if index < 0 || index >= len(r.fields) {
		return 0, false
	}
	return int64(r.fields[index].length), true
}

func (*navicatMySQLTunnelRows) ColumnTypeScanType(int) reflect.Type {
	return reflect.TypeOf([]byte(nil))
}

func (r navicatMySQLTunnelExecResult) LastInsertId() (int64, error) {
	return r.lastInsertID, nil
}

func (r navicatMySQLTunnelExecResult) RowsAffected() (int64, error) {
	return r.rowsAffected, nil
}

func (e *navicatMySQLTunnelProtocolError) Error() string {
	if strings.TrimSpace(e.message) == "" {
		return fmt.Sprintf("Navicat HTTP 隧道错误 %d", e.code)
	}
	return fmt.Sprintf("Navicat HTTP 隧道错误 %d：%s", e.code, e.message)
}

func (e *navicatMySQLTunnelProtocolError) Unwrap() error {
	if e == nil || e.code > math.MaxUint16 {
		return nil
	}
	return &mysql.MySQLError{Number: uint16(e.code), Message: e.message}
}

func navicatMySQLTunnelTransactionError() error {
	return errors.New("Navicat HTTP 隧道脚本按请求创建数据库连接，不支持跨请求事务")
}

func isNavicatMySQLTransactionControl(query string) bool {
	return navicatMySQLTransactionCommand(query) != ""
}
