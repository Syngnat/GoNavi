//go:build gonavi_full_drivers || gonavi_iris_driver || gonavi_cache_driver

package db

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/internal/utils"
)

func applyIRISURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	parsed, ok := parseConnectionURI(
		config.URI,
		"iris",
		"intersystems",
		"cache",
		"intersystems-cache",
		"intersystemscache",
	)
	if !ok || parsed == nil {
		return config
	}
	next := config
	if host := strings.TrimSpace(parsed.Hostname()); host != "" {
		next.Host = host
	}
	if portText := strings.TrimSpace(parsed.Port()); portText != "" {
		if port, err := strconv.Atoi(portText); err == nil && port > 0 {
			next.Port = port
		}
	}
	if parsed.User != nil {
		next.User = parsed.User.Username()
		if password, ok := parsed.User.Password(); ok {
			next.Password = password
		}
	}
	if namespace := strings.Trim(strings.TrimSpace(parsed.Path), "/"); namespace != "" {
		next.Database = namespace
	}
	return next
}

func (i *IrisDB) getDSN(config connection.ConnectionConfig) string {
	namespace := normalizeIRISNamespace(config.Database)
	port := config.Port
	if port <= 0 {
		port = defaultIRISPort
	}

	u := &url.URL{
		Scheme: "iris",
		Host:   net.JoinHostPort(config.Host, strconv.Itoa(port)),
		Path:   "/" + namespace,
	}
	u.User = url.UserPassword(config.User, config.Password)

	q := url.Values{}
	mergeConnectionParamsFromConfig(
		q,
		config,
		"iris",
		"intersystems",
		"cache",
		"intersystems-cache",
		"intersystemscache",
	)
	// 给驱动层注入单次网络读超时。caretdev/go-irisnative 不响应 context 取消，
	// 对受限账号的 %SYS 视图查询、以及 INFORMATION_SCHEMA 大结果集的尾部
	// fetchMoreData 都可能让服务端长时间不回包；不在驱动层兜底就会让侧栏
	// 「库列表/表列表」永久转圈（issue #1430/#1427）。
	// 这里的值是「单次 Read」的上限，不是整条 SQL 的端到端超时；比客户端
	// 元数据 ctx 略长，避免与上层 deadline 抢跑。
	if !q.Has("query_timeout") {
		q.Set("query_timeout", irisDriverQueryReadTimeout.String())
	}
	u.RawQuery = q.Encode()
	return u.String()
}

func (i *IrisDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = i.Close()
	defer func() {
		if err != nil {
			_ = i.Close()
		}
	}()

	runConfig := applyIRISURI(config)
	if runConfig.Port <= 0 {
		runConfig.Port = defaultIRISPort
	}
	i.namespace = normalizeIRISNamespace(runConfig.Database)
	i.namespaceExplicit = strings.Trim(strings.TrimSpace(runConfig.Database), "/") != ""

	if runConfig.UseSSH {
		logger.Infof("%s 使用 SSH 连接：地址=%s:%d 用户=%s", i.productName(), runConfig.Host, runConfig.Port, runConfig.User)
		forwarder, err := ssh.AcquireLocalForwarder(runConfig.SSH, runConfig.Host, runConfig.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		i.forwarder = forwarder

		host, portStr, err := net.SplitHostPort(forwarder.LocalAddr)
		if err != nil {
			return fmt.Errorf("解析本地转发地址失败：%w", err)
		}
		port, err := strconv.Atoi(portStr)
		if err != nil {
			return fmt.Errorf("解析本地端口失败：%w", err)
		}

		runConfig.Host = host
		runConfig.Port = port
		runConfig.UseSSH = false
		logger.Infof("%s 通过本地端口转发连接：%s -> %s:%d", i.productName(), forwarder.LocalAddr, config.Host, config.Port)
	}

	db, err := sql.Open("iris", i.getDSN(runConfig))
	if err != nil {
		return wrapDatabaseConnectionOpenError(err)
	}
	configureSQLConnectionPool(db, i.productType(), runConfig)
	i.conn = db
	i.pingTimeout = getConnectTimeout(runConfig)
	if err := i.Ping(); err != nil {
		_ = db.Close()
		i.conn = nil
		return wrapDatabaseConnectionVerifyError(err)
	}
	return nil
}

func (c *CacheDB) Connect(config connection.ConnectionConfig) error {
	c.product = interSystemsProductCache
	return c.IrisDB.Connect(config)
}

func (i *IrisDB) Close() error {
	if i.forwarder != nil {
		if err := i.forwarder.Release(); err != nil {
			logger.Warnf("关闭 %s SSH 端口转发失败：%v", i.productName(), err)
		}
		i.forwarder = nil
	}
	if i.conn != nil {
		return i.conn.Close()
	}
	return nil
}

func (i *IrisDB) Ping() error {
	if i.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	timeout := i.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	return i.conn.PingContext(ctx)
}

func (i *IrisDB) QueryMulti(query string) ([]connection.ResultSetData, error) {
	if i.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	rows, err := i.conn.QueryContext(metadataContextFor(i), query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMultiRows(rows)
}

func (i *IrisDB) QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error) {
	if i.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	rows, err := i.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMultiRowsContext(ctx, rows)
}

func (i *IrisDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if i.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}
	rows, err := i.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRowsContext(ctx, rows)
}

func (i *IrisDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if i.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}
	rows, err := i.conn.QueryContext(metadataContextFor(i), query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (i *IrisDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if i.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := i.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (i *IrisDB) ExecBatchContext(ctx context.Context, query string) (int64, error) {
	return i.ExecContext(ctx, query)
}

func (i *IrisDB) OpenSessionExecer(ctx context.Context) (StatementExecer, error) {
	if i.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	conn, err := i.conn.Conn(ctx)
	if err != nil {
		return nil, err
	}
	return NewSQLConnStatementExecer(conn), nil
}

func (i *IrisDB) Exec(query string) (int64, error) {
	if i.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := i.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
