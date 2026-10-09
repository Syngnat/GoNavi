//go:build gonavi_full_drivers || gonavi_gbase8s_driver

package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/internal/utils"
)

const (
	defaultGBase8sPort     = 9088
	defaultGBase8sDatabase = "sysmaster"
	defaultGBase8sLocale   = "en_US.utf8"

	gbase8sErrServerName     = -761
	gbase8sErrLocaleMismatch = -23197
)

// GBase8sDB 接入 GBase 8s（南大通用，Informix 内核）：通过 CSDK 的 ODBC 驱动库连接（gbase8s_odbc_*.go），
// 客户端字符集固定为 UTF-8，打开 DELIMIDENT 让双引号表示标识符。
type GBase8sDB struct {
	conn        *sql.DB
	pingTimeout time.Duration
	forwarder   *ssh.LocalForwarder
	database    string
	driverVariantState
}

var (
	_ Database                  = (*GBase8sDB)(nil)
	_ DriverVariantReporter     = (*GBase8sDB)(nil)
	_ TransactionExecerProvider = (*GBase8sDB)(nil)
	_ BatchApplierContext       = (*GBase8sDB)(nil)
)

// gbase8sReservedParams 是连接参数里由 GoNavi 自己解释、不传给 ODBC 连接串的键。
var gbase8sReservedParams = map[string]struct{}{"clientdir": {}, "odbclibrary": {}, "server": {}}

// Connect 解析 CSDK 目录与 ODBC 驱动库，按需建立 SSH 隧道后连接；未填写服务名时从服务端的 -761 报错里取得，
// 库的字符集与默认 DB_LOCALE 不一致（-23197）时从 sysmaster 查出该库的 locale 重连。
func (g *GBase8sDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = g.Close()
	defer func() {
		if err != nil {
			_ = g.Close()
		}
	}()
	runConfig := rewriteURIScheme(config, "gbase8s", "gbasedbt", "informix")
	params := connectionParamsFromText(runConfig.ConnectionParams)
	home := gbase8sClientHome(params)
	if home != "" {
		_ = os.Setenv("GBASEDBTDIR", home)
	}
	library, err := resolveGBase8sODBCLibrary(home, params.Get("odbcLibrary"))
	if err != nil {
		return err
	}
	api, err := loadODBCAPI(library)
	if err != nil {
		return err
	}
	if runConfig.Port <= 0 {
		runConfig.Port = defaultGBase8sPort
	}
	g.pingTimeout = getConnectTimeout(runConfig)
	if runConfig.UseSSH {
		forwarder, err := ssh.AcquireLocalForwarder(runConfig.SSH, runConfig.Host, runConfig.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		g.forwarder = forwarder
		host, portText, err := net.SplitHostPort(forwarder.LocalAddr)
		if err != nil {
			return err
		}
		port, err := strconv.Atoi(portText)
		if err != nil {
			return err
		}
		runConfig.Host, runConfig.Port, runConfig.UseSSH = host, port, false
	}
	g.database = strings.TrimSpace(runConfig.Database)
	if g.database == "" {
		g.database = defaultGBase8sDatabase
	}
	options := gbase8sConnectOptions{server: params.Get("server"), dbLocale: params.Get("DB_LOCALE")}
	if err := g.open(api, runConfig, params, options); err != nil {
		return err
	}
	if err := g.resolve("gbase8s", config, g.queryVersion()); err != nil {
		return err
	}
	return nil
}

type gbase8sConnectOptions struct {
	server   string
	dbLocale string
}

func (g *GBase8sDB) open(api *odbcAPI, config connection.ConnectionConfig, params url.Values, options gbase8sConnectOptions) error {
	connectServer := options.server
	if connectServer == "" {
		connectServer = "gonavi_probe"
	}
	pool, err := g.tryOpen(api, config, params, connectServer, options.dbLocale, g.database)
	if options.server == "" {
		if name, ok := gbase8sServerNameFromError(err); ok {
			logger.Infof("GBase 8s 未填写服务名，按服务端返回的 DBSERVERNAME 连接：%s", name)
			connectServer = name
			pool, err = g.tryOpen(api, config, params, connectServer, options.dbLocale, g.database)
		}
	}
	if options.dbLocale == "" && gbase8sErrorCode(err) == gbase8sErrLocaleMismatch {
		if locale := g.lookupDatabaseLocale(api, config, params, connectServer); locale != "" {
			logger.Infof("GBase 8s 库 %s 的 locale 为 %s，按它重新连接", g.database, locale)
			pool, err = g.tryOpen(api, config, params, connectServer, locale, g.database)
		}
	}
	if err != nil {
		return localizedDatabaseRuntimeError("db.backend.error.gbase8s_connect_failed", map[string]any{"detail": err.Error()})
	}
	g.conn = pool
	return nil
}

func (g *GBase8sDB) tryOpen(api *odbcAPI, config connection.ConnectionConfig, params url.Values, server, dbLocale, database string) (*sql.DB, error) {
	pool := sql.OpenDB(&odbcConnector{api: api, connStr: gbase8sConnString(config, params, server, dbLocale, database)})
	configureSQLConnectionPool(pool, "gbase8s", config)
	ctx, cancel := utils.ContextWithTimeout(g.pingTimeout)
	defer cancel()
	if err := pool.PingContext(ctx); err != nil {
		_ = pool.Close()
		return nil, err
	}
	return pool, nil
}

// lookupDatabaseLocale 连 sysmaster 查目标库的 locale（sysdbslocale.dbs_collate）。
func (g *GBase8sDB) lookupDatabaseLocale(api *odbcAPI, config connection.ConnectionConfig, params url.Values, server string) string {
	pool, err := g.tryOpen(api, config, params, server, "", defaultGBase8sDatabase)
	if err != nil {
		return ""
	}
	defer pool.Close()
	var locale sql.NullString
	if err := pool.QueryRow("SELECT dbs_collate FROM sysmaster:sysdbslocale WHERE dbs_dbsname = ?", g.database).Scan(&locale); err != nil {
		return ""
	}
	return strings.TrimSpace(locale.String)
}

// gbase8sClientHome 返回 CSDK 目录：连接参数 clientDir 优先，其次是环境变量 GBASEDBTDIR / INFORMIXDIR。
func gbase8sClientHome(params url.Values) string {
	for _, value := range []string{params.Get("clientDir"), os.Getenv("GBASEDBTDIR"), os.Getenv("INFORMIXDIR")} {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

// gbase8sConnString 生成 ODBC 连接串；含分号、花括号或首尾空格的值用花括号包起来。
func gbase8sConnString(config connection.ConnectionConfig, params url.Values, server, dbLocale, database string) string {
	if dbLocale == "" {
		dbLocale = defaultGBase8sLocale
	}
	pairs := [][2]string{
		{"SERVER", server}, {"HOST", config.Host}, {"SERVICE", strconv.Itoa(config.Port)}, {"PROTOCOL", "onsoctcp"},
		{"DATABASE", database}, {"UID", config.User}, {"PWD", config.Password},
		{"CLIENT_LOCALE", defaultGBase8sLocale}, {"DB_LOCALE", dbLocale}, {"DELIMIDENT", "y"},
	}
	index := map[string]int{}
	for i, pair := range pairs {
		index[pair[0]] = i
	}
	for key, values := range params {
		if _, reserved := gbase8sReservedParams[strings.ToLower(key)]; reserved || len(values) == 0 {
			continue
		}
		upper := strings.ToUpper(key)
		if upper == "DB_LOCALE" || upper == "DATABASE" || upper == "UID" || upper == "PWD" {
			continue
		}
		if i, ok := index[upper]; ok {
			pairs[i][1] = values[0]
			continue
		}
		pairs = append(pairs, [2]string{upper, values[0]})
	}
	parts := make([]string, 0, len(pairs))
	for _, pair := range pairs {
		parts = append(parts, pair[0]+"="+odbcConnValue(pair[1]))
	}
	return strings.Join(parts, ";")
}

func odbcConnValue(value string) string {
	if strings.ContainsAny(value, ";{}") || strings.TrimSpace(value) != value {
		return "{" + strings.ReplaceAll(value, "}", "}}") + "}"
	}
	return value
}

var gbase8sServerNamePattern = regexp.MustCompile(`sqlerrm\(([^)\s]+)\)`)

// gbase8sServerNameFromError 从 -761（GBASEDBTSERVER 与 DBSERVERNAME 不符）的报错里取服务端的服务名。
func gbase8sServerNameFromError(err error) (string, bool) {
	if gbase8sErrorCode(err) != gbase8sErrServerName {
		return "", false
	}
	match := gbase8sServerNamePattern.FindStringSubmatch(err.Error())
	if match == nil {
		return "", false
	}
	return match[1], true
}

func gbase8sErrorCode(err error) int32 {
	var odbcErr *odbcError
	if errors.As(err, &odbcErr) {
		return odbcErr.Native
	}
	return 0
}

var gbase8sVersionPattern = regexp.MustCompile(`(\d+\.\d+)\.?([A-Z]*\d*[A-Z]*\d*)`)

// queryVersion 读取服务端版本（Informix 内核版本，如 12.10.FC4G1）。
func (g *GBase8sDB) queryVersion() string {
	rows, _, err := g.Query("SELECT DBINFO('version', 'full') AS version FROM sysmaster:sysdual")
	if err != nil {
		logger.Warnf("GBase 8s 版本识别失败：%v", err)
		return ""
	}
	banner := FirstQueryRowValue(rows)
	if match := gbase8sVersionPattern.FindString(banner); match != "" {
		return match
	}
	return strings.TrimSpace(banner)
}

func (g *GBase8sDB) Close() error {
	if g.forwarder != nil {
		if err := g.forwarder.Release(); err != nil {
			logger.Warnf("关闭 GBase 8s SSH 端口转发失败：%v", err)
		}
		g.forwarder = nil
	}
	if g.conn != nil {
		err := g.conn.Close()
		g.conn = nil
		return err
	}
	return nil
}

func (g *GBase8sDB) Ping() error {
	if g.conn == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	timeout := g.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	return g.conn.PingContext(ctx)
}

func (g *GBase8sDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if g.conn == nil {
		return nil, nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	rows, err := g.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRowsContext(ctx, rows)
}

func (g *GBase8sDB) Query(query string) ([]map[string]interface{}, []string, error) {
	return g.QueryContext(metadataContextFor(g), query)
}

func (g *GBase8sDB) StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error {
	if g.conn == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	rows, err := g.conn.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	defer rows.Close()
	return streamRows(rows, consumer)
}

func (g *GBase8sDB) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return g.StreamQueryContext(context.Background(), query, consumer)
}

func (g *GBase8sDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if g.conn == nil {
		return 0, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	result, err := g.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func (g *GBase8sDB) Exec(query string) (int64, error) {
	return g.ExecContext(context.Background(), query)
}

// OpenTransactionExecer 为 SQL 编辑器的托管事务固定一条连接并关闭自动提交（ODBC 事务）。
func (g *GBase8sDB) OpenTransactionExecer(ctx context.Context) (TransactionExecer, error) {
	if g.conn == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	conn, err := g.conn.Conn(context.Background())
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

// OpenSessionExecer 固定一条连接，让 SQL 文件导入等多语句流程保持会话状态（临时表、SET 语句）。
func (g *GBase8sDB) OpenSessionExecer(ctx context.Context) (StatementExecer, error) {
	if g.conn == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	conn, err := g.conn.Conn(ctx)
	if err != nil {
		return nil, err
	}
	return NewSQLConnStatementExecer(conn), nil
}
