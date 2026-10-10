//go:build gonavi_full_drivers || gonavi_gbase8a_driver

package db

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/internal/utils"
)

const defaultGBase8aPort = 5258

// GBase8aDB 通过 MySQL 协议接入 GBase 8a（南大通用 MPP 分析型数据库）。元数据、DDL 与网格编辑复用 MySQL 实现，
// 连接池换成 gbase8a_driver.go 的包装驱动，让 BeginTx 开启真正的事务。
type GBase8aDB struct {
	MySQLDB
	driverVariantState
}

var (
	_ Database                  = (*GBase8aDB)(nil)
	_ DriverVariantReporter     = (*GBase8aDB)(nil)
	_ TransactionExecerProvider = (*GBase8aDB)(nil)
)

// gbase8aHiddenDatabases 是服务端内部使用的库：gctmpdb 存放执行期间的临时表，不在导航树里展示。
var gbase8aHiddenDatabases = map[string]struct{}{"gctmpdb": {}}

func (g *GBase8aDB) bindMetadataContext(ctx context.Context) {
	BindMetadataContext(&g.MySQLDB, ctx)
}

func (g *GBase8aDB) clearMetadataContext() {
	ClearMetadataContext(&g.MySQLDB)
}

// Connect 按 MySQL 的连接链路（多地址、SSH、代理、SSL）建立连接池，再识别服务端版本并确定档位。
func (g *GBase8aDB) Connect(config connection.ConnectionConfig) error {
	runConfig := rewriteURIScheme(config, "mysql", "gbase8a", "gbase")
	if runConfig.Port <= 0 {
		runConfig.Port = defaultGBase8aPort
	}
	if err := g.openPool(runConfig); err != nil {
		return err
	}
	version := g.queryVersion()
	if err := g.resolve("gbase8a", config, version); err != nil {
		_ = g.MySQLDB.Close()
		return err
	}
	return nil
}

// openPool 对应 MySQLDB.Connect 的直连分支：逐个地址尝试，用包装驱动打开连接池（GBase 不支持 Navicat HTTP 隧道）。
func (g *GBase8aDB) openPool(config connection.ConnectionConfig) error {
	m := &g.MySQLDB
	m.batchWritesEnabled, m.navicatTunnel, m.navicatTunnelClient = false, false, nil
	runConfig := applyMySQLURI(config)
	defaultPort := resolveMySQLCompatibleDefaultPort(runConfig)
	var details []string
	for index, address := range collectMySQLAddresses(runConfig) {
		candidate := runConfig
		host, port, ok := parseHostPortWithDefault(address, defaultPort)
		if !ok {
			continue
		}
		candidate.Host, candidate.Port = host, port
		candidate.User, candidate.Password = resolveMySQLCredential(runConfig, index)
		protocol, dialAddress, err := m.resolveProtocolAndAddress(candidate)
		if err != nil {
			if _, requiresTrust := ssh.HostKeyTrustStatusFromError(err); requiresTrust {
				return err
			}
			details = append(details, fmt.Sprintf("%s: %v", address, err))
			continue
		}
		plans, err := buildMySQLCompatibleConnectPlans(candidate, protocol, dialAddress, candidate.Database)
		if err != nil {
			details = append(details, fmt.Sprintf("%s: %v", address, err))
			continue
		}
		for _, plan := range plans {
			pool, err := sql.Open(gbase8aSQLDriverName, plan.dsn)
			if err != nil {
				details = append(details, fmt.Sprintf("%s: %v", address, err))
				continue
			}
			configureSQLConnectionPool(pool, candidate.Type, candidate)
			timeout := getConnectTimeout(candidate)
			ctx, cancel := utils.ContextWithTimeout(timeout)
			err = pool.PingContext(ctx)
			cancel()
			if err != nil {
				_ = pool.Close()
				details = append(details, fmt.Sprintf("%s [%s]: %v", address, plan.label, err))
				continue
			}
			m.conn, m.pingTimeout = pool, timeout
			m.batchWritesEnabled = mysqlDSNSupportsBatchWrites(plan.dsn)
			return nil
		}
	}
	if len(details) == 0 {
		details = append(details, "no address")
	}
	return localizedDatabaseRuntimeError("db.backend.error.gbase8a_connect_failed", map[string]any{"detail": strings.Join(details, "; ")})
}

var gbase8aVersionPattern = regexp.MustCompile(`^\s*(\d+(?:\.\d+)*)`)

// parseGBase8aVersion 从 "8.6.2.43-R7-free.110605" 这类版本串里取出数字版本。
func parseGBase8aVersion(banner string) string {
	if match := gbase8aVersionPattern.FindStringSubmatch(banner); match != nil {
		return match[1]
	}
	return ""
}

func (g *GBase8aDB) queryVersion() string {
	rows, _, err := g.MySQLDB.Query("SELECT VERSION() AS version")
	if err != nil {
		logger.Warnf("GBase 8a 版本识别失败：%v", err)
		return ""
	}
	return parseGBase8aVersion(fmt.Sprint(FirstQueryRowValue(rows)))
}

// GetDatabases 隐藏服务端内部使用的库。
func (g *GBase8aDB) GetDatabases() ([]string, error) {
	databases, err := g.MySQLDB.GetDatabases()
	if err != nil {
		return nil, err
	}
	visible := databases[:0]
	for _, name := range databases {
		if _, hidden := gbase8aHiddenDatabases[strings.ToLower(name)]; !hidden {
			visible = append(visible, name)
		}
	}
	return visible, nil
}

// OpenTransactionExecer 为 SQL 编辑器的托管事务固定一条连接并开启事务（包装驱动会关闭自动提交）。
// 文本 BEGIN / START TRANSACTION 在 GBase 8a 上不生效，所以托管事务必须走驱动接口；语句错误补充事务限制说明。
func (g *GBase8aDB) OpenTransactionExecer(ctx context.Context) (TransactionExecer, error) {
	if g.conn == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	conn, err := g.conn.Conn(ctx)
	if err != nil {
		return nil, err
	}
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	return gbase8aTransaction{&sqlTxStatementExecer{tx: tx, conn: conn}}, nil
}
