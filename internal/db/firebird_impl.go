//go:build gonavi_full_drivers || gonavi_firebird_driver

package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"net/url"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/internal/utils"

	"github.com/nakagami/firebirdsql"
)

const (
	defaultFirebirdPort    = 3050
	firebirdVersionQuery   = "SELECT rdb$get_context('SYSTEM', 'ENGINE_VERSION') AS version FROM rdb$database"
	firebirdDatabaseParam  = "databasePath"
	firebirdLegacyAuthName = "Legacy_Auth"
	firebirdMaxIdleConns   = 2
)

// FirebirdDB 接入 Firebird（2.5 – 5.0），驱动是纯 Go 的 firebirdsql（按服务端协商 Srp256 / Srp / Legacy_Auth 与线路加密）。
// 一个连接对应一个数据库文件或别名：导航树只有这一个库，表、视图、存储过程、函数、触发器、生成器都来自 RDB$ 系统表。
type FirebirdDB struct {
	conn        *sql.DB
	pingTimeout time.Duration
	forwarder   *ssh.LocalForwarder
	database    string
	label       string
	driverVariantState
}

var (
	_ Database                  = (*FirebirdDB)(nil)
	_ DriverVariantReporter     = (*FirebirdDB)(nil)
	_ TransactionExecerProvider = (*FirebirdDB)(nil)
	_ BatchApplierContext       = (*FirebirdDB)(nil)
)

// firebirdReservedParams 是连接参数里由 GoNavi 自己解释、不传给驱动的键。
var firebirdReservedParams = map[string]struct{}{strings.ToLower(firebirdDatabaseParam): {}}

// Connect 按连接参数 databasePath（或连接串里的路径）连接数据库文件 / 别名；连接参数里的 wire_crypt、auth_plugin_name、
// role、charset 等原样交给驱动，未指定字符集时用 UTF8。手选 2.5 档位时默认按 Legacy_Auth 认证。
func (f *FirebirdDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = f.Close()
	defer func() {
		if err != nil {
			_ = f.Close()
		}
	}()
	params := connectionParamsFromText(config.ConnectionParams)
	database := strings.TrimSpace(params.Get(firebirdDatabaseParam))
	if database == "" {
		database = strings.TrimSpace(config.Database)
	}
	if database == "" {
		return localizedDatabaseRuntimeError("db.backend.error.firebird_database_required", nil)
	}
	runConfig := config
	if runConfig.Port <= 0 {
		runConfig.Port = defaultFirebirdPort
	}
	f.pingTimeout = getConnectTimeout(runConfig)
	if runConfig.UseSSH {
		forwarder, err := ssh.AcquireLocalForwarder(runConfig.SSH, runConfig.Host, runConfig.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		f.forwarder = forwarder
		host, portText, err := net.SplitHostPort(forwarder.LocalAddr)
		if err != nil {
			return fmt.Errorf("解析本地转发地址失败：%w", err)
		}
		port, err := strconv.Atoi(portText)
		if err != nil {
			return fmt.Errorf("解析本地端口失败：%w", err)
		}
		runConfig.Host, runConfig.Port, runConfig.UseSSH = host, port, false
	}
	if strings.TrimSpace(config.DriverVariant) == "v25" && params.Get("auth_plugin_name") == "" {
		if params == nil {
			params = url.Values{}
		}
		params.Set("auth_plugin_name", firebirdLegacyAuthName)
	}
	connector, err := newFirebirdConnector(firebirdDSN(runConfig, database, params))
	if err != nil {
		return err
	}
	f.conn = sql.OpenDB(connector)
	f.conn.SetMaxIdleConns(firebirdMaxIdleConns)
	f.database = database
	f.label = firebirdDatabaseLabel(database)
	if err := f.Ping(); err != nil {
		return localizedDatabaseRuntimeError("db.backend.error.firebird_connect_failed", map[string]any{"detail": err.Error()})
	}
	return f.resolve("firebird", config, f.queryVersion())
}

// firebirdDSN 拼出 firebirdsql 的连接串：用户名口令按 URL 转义，库路径统一成正斜杠（Windows 盘符路径与别名都由驱动识别）。
func firebirdDSN(config connection.ConnectionConfig, database string, params url.Values) string {
	query := url.Values{}
	for key, values := range params {
		if _, reserved := firebirdReservedParams[strings.ToLower(key)]; reserved || len(values) == 0 {
			continue
		}
		query.Set(key, values[0])
	}
	if query.Get("charset") == "" {
		query.Set("charset", "UTF8")
	}
	databasePath := strings.ReplaceAll(strings.TrimSpace(database), `\`, "/")
	if !strings.HasPrefix(databasePath, "/") {
		databasePath = "/" + databasePath
	}
	dsn := url.URL{
		Scheme:   "firebird",
		User:     url.UserPassword(config.User, config.Password),
		Host:     net.JoinHostPort(strings.TrimSpace(config.Host), strconv.Itoa(config.Port)),
		Path:     databasePath,
		RawQuery: query.Encode(),
	}
	return dsn.String()
}

// firebirdDatabaseLabel 是导航树里库节点的名字：别名原样，文件路径取不带扩展名的文件名。
func firebirdDatabaseLabel(database string) string {
	name := path.Base(strings.ReplaceAll(strings.TrimSpace(database), `\`, "/"))
	if ext := path.Ext(name); ext != "" && len(name) > len(ext) {
		name = strings.TrimSuffix(name, ext)
	}
	if name == "" || name == "." || name == "/" {
		return strings.TrimSpace(database)
	}
	return name
}

var firebirdVersionPattern = regexp.MustCompile(`\d+\.\d+(?:\.\d+)?`)

// queryVersion 读取引擎版本（2.5.9、3.0.14、5.0.4……）。
func (f *FirebirdDB) queryVersion() string {
	rows, _, err := f.Query(firebirdVersionQuery)
	if err != nil {
		logger.Warnf("Firebird 版本识别失败：%v", err)
		return ""
	}
	return firebirdVersionPattern.FindString(FirstQueryRowValue(rows))
}

func (f *FirebirdDB) Close() error {
	if f.forwarder != nil {
		if err := f.forwarder.Release(); err != nil {
			logger.Warnf("关闭 Firebird SSH 端口转发失败：%v", err)
		}
		f.forwarder = nil
	}
	if f.conn != nil {
		err := f.conn.Close()
		f.conn = nil
		return err
	}
	return nil
}

func (f *FirebirdDB) Ping() error {
	if f.conn == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	timeout := f.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	return f.conn.PingContext(ctx)
}

func (f *FirebirdDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if f.conn == nil {
		return nil, nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	rows, err := f.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRowsContext(ctx, rows)
}

func (f *FirebirdDB) Query(query string) ([]map[string]interface{}, []string, error) {
	return f.QueryContext(metadataContextFor(f), query)
}

// queryArgs 执行带参数的元数据查询（系统表里的对象名按参数绑定，避免拼接引号）。
func (f *FirebirdDB) queryArgs(query string, args ...any) ([]map[string]interface{}, error) {
	if f.conn == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	ctx := metadataContextFor(f)
	rows, err := f.conn.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	data, _, err := scanRowsUnboundedForDialect(rows, "")
	return data, err
}

func (f *FirebirdDB) StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error {
	if f.conn == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	rows, err := f.conn.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	defer rows.Close()
	return streamRows(rows, consumer)
}

func (f *FirebirdDB) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return f.StreamQueryContext(context.Background(), query, consumer)
}

func (f *FirebirdDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if f.conn == nil {
		return 0, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	result, err := f.conn.ExecContext(ctx, query)
	if err != nil && isFirebirdDDL(query) && isFirebirdObjectInUse(err) {
		// 连接池里闲置的连接还缓存着用到该对象的语句（Firebird 按连接持有对象的使用锁）：关掉闲置连接后在新连接上重试一次。
		f.conn.SetMaxIdleConns(0)
		f.conn.SetMaxIdleConns(firebirdMaxIdleConns)
		result, err = f.conn.ExecContext(ctx, query)
	}
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// isFirebirdObjectInUse 报告错误是否为“对象正被使用”（isc_obj_in_use）。
func isFirebirdObjectInUse(err error) bool {
	var fbErr *firebirdsql.FbError
	return errors.As(err, &fbErr) && slices.Contains(fbErr.GDSCodes, firebirdsql.ISCObjInUse)
}

func (f *FirebirdDB) Exec(query string) (int64, error) {
	return f.ExecContext(context.Background(), query)
}

// OpenTransactionExecer 为 SQL 编辑器的托管事务固定一条连接并开启驱动事务。
func (f *FirebirdDB) OpenTransactionExecer(ctx context.Context) (TransactionExecer, error) {
	if f.conn == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	conn, err := f.conn.Conn(context.Background())
	if err != nil {
		return nil, err
	}
	tx, err := conn.BeginTx(context.Background(), nil)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	return NewSQLTxStatementExecerWithConn(tx, conn), nil
}

// OpenSessionExecer 固定一条连接，让 SQL 文件导入等多语句流程保持会话状态。
func (f *FirebirdDB) OpenSessionExecer(ctx context.Context) (StatementExecer, error) {
	if f.conn == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	conn, err := f.conn.Conn(ctx)
	if err != nil {
		return nil, err
	}
	return NewSQLConnStatementExecer(conn), nil
}
