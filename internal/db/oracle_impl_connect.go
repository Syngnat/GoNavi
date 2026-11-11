package db

import (
	"context"
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

// oracleConnectionSID 解析连接配置（ConnectionParams / URI）中的 SID 参数。
// SID 与 Service Name 是 Oracle 两种互斥的连接定位方式：go-ora 驱动在
// CONNECT_DATA 中优先使用 SID（configurations/connect_config.go），因此
// SID 模式只需把 SID 值放入 DSN 查询参数，Database（服务名）可留空。
func oracleConnectionSID(config connection.ConnectionConfig) string {
	values := url.Values{}
	mergeConnectionParamsFromConfigWithAllowlist(values, config, oracleConnectionParamNames, "oracle")
	return oracleQueryValue(values, "SID")
}

// isOracleSIDMode 报告连接是否以 SID 模式连接（存在 SID 参数时优先于服务名）。
func isOracleSIDMode(config connection.ConnectionConfig) bool {
	return oracleConnectionSID(config) != ""
}

func (o *OracleDB) getDSN(config connection.ConnectionConfig) string {
	// 服务名模式：oracle://user:pass@host:port/service_name
	// SID 模式：oracle://user:pass@host:port/?SID=sid（go-ora 驱动据此组装 (SID=...)）
	database := strings.TrimSpace(config.Database)
	sid := oracleConnectionSID(config)

	u := &url.URL{
		Scheme: "oracle",
		Host:   net.JoinHostPort(config.Host, strconv.Itoa(config.Port)),
	}
	if sid == "" {
		u.Path = "/" + database
		u.RawPath = "/" + url.PathEscape(database)
	}
	u.User = url.UserPassword(config.User, config.Password)
	q := url.Values{}
	switch normalizedSSLMode(config) {
	case sslModeRequired:
		q.Set("SSL", "TRUE")
		q.Set("SSL VERIFY", "TRUE")
	case sslModeSkipVerify, sslModePreferred:
		q.Set("SSL", "TRUE")
		q.Set("SSL VERIFY", "FALSE")
	}
	// Keep fetch batches bounded. go-ora materializes every LOB in a fetched batch,
	// so a large prefetch value can retain many BLOBs at once before rows are scanned.
	q.Set("PREFETCH_ROWS", strconv.Itoa(oracleDefaultPrefetchRows))
	// LOB 数据延迟加载，避免大 LOB 列影响普通查询性能
	q.Set("LOB FETCH", "POST")
	timeoutSeconds := strconv.Itoa(getConnectTimeoutSeconds(config))
	q.Set("CONNECT TIMEOUT", timeoutSeconds)
	// Do not copy connect timeout into go-ora READ TIMEOUT. That I/O deadline
	// would abort long-running queries; set READ TIMEOUT only via connection params.
	mergeConnectionParamsFromConfigWithAllowlist(q, config, oracleConnectionParamNames, "oracle")
	if encoded := q.Encode(); encoded != "" {
		u.RawQuery = encoded
	}
	return u.String()
}

func oracleQueryValue(values url.Values, key string) string {
	return strings.TrimSpace(values.Get(key))
}

func oracleQueryValueOrDefault(values url.Values, key string) string {
	value := oracleQueryValue(values, key)
	if value == "" {
		return "未配置"
	}
	return value
}

func oracleDSNLogSummary(config connection.ConnectionConfig, dsn string) string {
	serviceName := strings.TrimSpace(config.Database)
	params := url.Values{}
	if parsed, err := url.Parse(dsn); err == nil && parsed != nil {
		if pathService, unescapeErr := url.PathUnescape(strings.TrimPrefix(parsed.EscapedPath(), "/")); unescapeErr == nil && strings.TrimSpace(pathService) != "" {
			serviceName = strings.TrimSpace(pathService)
		}
		params = parsed.Query()
	}
	sid := oracleQueryValue(params, "SID")
	mode := "服务名"
	targetLabel := "服务名"
	targetValue := serviceName
	if sid != "" {
		mode = "SID"
		targetLabel = "SID"
		targetValue = sid
	}
	if targetValue == "" {
		targetValue = "(未配置)"
	}
	return fmt.Sprintf("连接模式=%s %s=%s CONNECT_TIMEOUT=%s READ_TIMEOUT=%s SSL=%s SSL_VERIFY=%s AUTH_TYPE=%s DBA_PRIVILEGE=%s",
		mode,
		targetLabel,
		targetValue,
		oracleQueryValueOrDefault(params, "CONNECT TIMEOUT"),
		oracleQueryValueOrDefault(params, "READ TIMEOUT"),
		oracleQueryValueOrDefault(params, "SSL"),
		oracleQueryValueOrDefault(params, "SSL VERIFY"),
		oracleQueryValueOrDefault(params, "AUTH TYPE"),
		oracleQueryValueOrDefault(params, "DBA PRIVILEGE"),
	)
}

func annotateOracleValidationError(err error) error {
	if err == nil {
		return nil
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "use of closed network connection") {
		return fmt.Errorf("%w（Oracle 连接在验证阶段被服务端关闭或被驱动超时中断；请检查监听端口是否为 Oracle 协议端口、服务名（Service Name）或 SID 是否正确、认证参数如 DBA_PRIVILEGE/AUTH_TYPE 是否匹配）", err)
	}
	// `EOF` / `unexpected EOF` 是驱动在握手阶段读不到完整响应的通用症状，本身不含
	// 任何可操作信息。最常见的原因是端口指向了非 Oracle 监听（例如把 MySQL 端口
	// 当成 Oracle 用）、Service Name/SID 写错，或中间有代理/防火墙截断。这里补一层
	// 具体提示，避免用户只看到「EOF」而无从下手。
	//
	// 必须整词匹配：`strings.Contains(message, "eof")` 会把主机名、用户名、路径里
	// 恰好含 "eof" 的无关错误也误判成握手失败（如 host "eoffice-db"）。
	if isOracleEOFHandshakeError(message) {
		return fmt.Errorf("%w（Oracle 握手阶段连接被对端直接关闭或响应不完整；请确认端口是 Oracle 监听端口（不是 MySQL/SQL Server 等其它协议）、Service Name 或 SID 填写正确，并确认客户端与服务端版本/字符集兼容；如经 SSH 隧道或代理，请检查代理是否在握手时中断连接）", err)
	}
	return err
}

// isOracleEOFHandshakeError 判断错误文本是否是「握手中断」形态。
//
// 只认整词 EOF / unexpected EOF，避免 host/user/path 里含 "eof" 的无关错误被
// 误判（调用方传入的已是小写文本）。
func isOracleEOFHandshakeError(lowerMessage string) bool {
	if lowerMessage == "eof" || lowerMessage == "unexpected eof" {
		return true
	}
	for _, token := range strings.FieldsFunc(lowerMessage, func(r rune) bool {
		return !(r >= 'a' && r <= 'z')
	}) {
		if token == "eof" {
			return true
		}
	}
	return false
}

func (o *OracleDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = o.Close()
	defer func() {
		if err != nil {
			_ = o.Close()
		}
	}()

	runConfig := config
	serviceName := strings.TrimSpace(config.Database)
	sid := oracleConnectionSID(config)
	if serviceName == "" && sid == "" {
		return fmt.Errorf("Oracle 连接缺少服务名（Service Name）或 SID，请在连接配置中填写，例如 ORCLPDB1（服务名）或 ORCL（SID）")
	}

	if config.UseSSH {
		// Create SSH tunnel with local port forwarding
		logger.Infof("Oracle 使用 SSH 连接：地址=%s:%d 用户=%s", config.Host, config.Port, config.User)

		forwarder, err := ssh.AcquireLocalForwarder(config.SSH, config.Host, config.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		o.forwarder = forwarder

		// Parse local address
		host, portStr, err := net.SplitHostPort(forwarder.LocalAddr)
		if err != nil {
			return fmt.Errorf("解析本地转发地址失败：%w", err)
		}

		port, err := strconv.Atoi(portStr)
		if err != nil {
			return fmt.Errorf("解析本地端口失败：%w", err)
		}

		// Create a modified config pointing to local forwarder
		localConfig := config
		localConfig.Host = host
		localConfig.Port = port
		localConfig.UseSSH = false

		runConfig = localConfig
		logger.Infof("Oracle 通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	}

	attempts := []connection.ConnectionConfig{runConfig}
	if shouldTrySSLPreferredFallback(runConfig) {
		attempts = append(attempts, withSSLDisabled(runConfig))
	}

	var failures []string
	// 保留最后一次底层错误，让汇总错误仍可被 errors.Unwrap 展开：
	// 否则 logger.ErrorChain 只能重复外层消息，日志里会出现两遍同样的内容。
	var lastErr error
	for idx, attempt := range attempts {
		dsn := o.getDSN(attempt)
		logger.Infof("Oracle 连接参数摘要：地址=%s:%d 用户=%s %s", attempt.Host, attempt.Port, attempt.User, oracleDSNLogSummary(attempt, dsn))
		db, err := openOracleSQLDatabase(dsn, attempt.RuntimeOracleCurrentSchema())
		if err != nil {
			lastErr = err
			failures = append(failures, fmt.Sprintf("第%d次连接打开失败: %v", idx+1, err))
			continue
		}
		configureSQLConnectionPool(db, "oracle", attempt)
		o.conn = db
		o.pingTimeout = getConnectTimeout(attempt)
		// 新连接可能指向另一个库实例，旧的名称解析与能力探测结果全部作废。
		o.resetOracleMetadataCache()
		if err := o.Ping(); err != nil {
			_ = db.Close()
			o.conn = nil
			annotated := annotateOracleValidationError(err)
			lastErr = annotated
			failures = append(failures, fmt.Sprintf("第%d次连接验证失败: %v", idx+1, annotated))
			continue
		}
		if idx > 0 {
			logger.Warnf("Oracle SSL 优先连接失败，已回退至明文连接")
		}
		return nil
	}
	if len(failures) == 0 {
		return fmt.Errorf("连接建立后验证失败：未找到可用的连接参数")
	}
	return newConnectAttemptError("连接建立后验证失败", failures, lastErr)
}

func (o *OracleDB) Close() error {
	// Close SSH forwarder first if exists
	if o.forwarder != nil {
		if err := o.forwarder.Release(); err != nil {
			logger.Warnf("关闭 Oracle SSH 端口转发失败：%v", err)
		}
		o.forwarder = nil
	}

	// Then close database connection
	if o.conn != nil {
		return o.conn.Close()
	}
	return nil
}

func (o *OracleDB) Ping() error {
	if o.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	timeout := o.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	return o.conn.PingContext(ctx)
}

func (o *OracleDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if o.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}

	rows, err := o.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	return scanRowsForDialectContext(ctx, rows, o.scanDialect)
}

func (o *OracleDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if o.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}

	rows, err := o.conn.QueryContext(metadataContextFor(o), query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRowsForDialect(rows, o.scanDialect)
}

func (o *OracleDB) queryUnbounded(query string) ([]map[string]interface{}, []string, error) {
	if o.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}

	rows, err := o.conn.QueryContext(metadataContextFor(o), query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRowsUnboundedForDialect(rows, o.scanDialect)
}

func (o *OracleDB) StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error {
	if o.conn == nil {
		return fmt.Errorf("连接未打开")
	}

	rows, err := o.conn.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	defer rows.Close()
	return streamRowsForDialect(rows, o.scanDialect, consumer)
}

func (o *OracleDB) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return o.StreamQueryContext(context.Background(), query, consumer)
}

func (o *OracleDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if o.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := o.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (o *OracleDB) Exec(query string) (int64, error) {
	if o.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := o.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (o *OracleDB) OpenTransactionExecer(ctx context.Context) (TransactionExecer, error) {
	if o.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	conn, err := o.conn.Conn(ctx)
	if err != nil {
		return nil, err
	}
	return NewSQLConnTransactionExecerWithDialect(conn, "COMMIT", "ROLLBACK", o.scanDialect), nil
}

func (o *OracleDB) OpenSessionExecer(ctx context.Context) (StatementExecer, error) {
	if o.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	conn, err := o.conn.Conn(ctx)
	if err != nil {
		return nil, err
	}
	return NewSQLConnStatementExecerWithDialect(conn, o.scanDialect), nil
}
