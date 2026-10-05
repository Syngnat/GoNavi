//go:build gonavi_full_drivers || gonavi_clickhouse_driver

package db

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/internal/utils"

	clickhouse "github.com/ClickHouse/clickhouse-go/v2"
)

func (c *ClickHouseDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = c.Close()
	defer func() {
		if err != nil {
			_ = c.Close()
		}
	}()

	if supported, reason := DriverRuntimeSupportStatus("clickhouse"); !supported {
		if strings.TrimSpace(reason) == "" {
			reason = localizedDriverRuntimeText("driver_manager.backend.status.optional_disabled", map[string]any{"name": "ClickHouse"})
		}
		return fmt.Errorf("%s", reason)
	}

	runConfig := normalizeClickHouseConfig(config)
	c.pingTimeout = getConnectTimeout(runConfig)
	c.database = runConfig.Database
	logger.Infof("ClickHouse 连接准备：地址=%s:%d 数据库=%s 用户=%s 协议选择=%s SSL=%t SSH=%t 超时=%s",
		runConfig.Host, runConfig.Port, runConfig.Database, runConfig.User,
		normalizeClickHouseProtocol(runConfig.ClickHouseProtocol), runConfig.UseSSL, runConfig.UseSSH, c.pingTimeout)

	if runConfig.UseSSH {
		if normalizeClickHouseProtocol(runConfig.ClickHouseProtocol) == clickHouseProtocolAuto && detectClickHouseProtocol(runConfig) == clickhouse.HTTP {
			runConfig.ClickHouseProtocol = clickHouseProtocolHTTP
		}
		logger.Infof("ClickHouse 使用 SSH 连接：地址=%s:%d 用户=%s", runConfig.Host, runConfig.Port, runConfig.User)
		forwarder, err := ssh.AcquireLocalForwarder(runConfig.SSH, runConfig.Host, runConfig.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		c.forwarder = forwarder

		host, portText, err := net.SplitHostPort(forwarder.LocalAddr)
		if err != nil {
			return fmt.Errorf("解析本地转发地址失败：%w", err)
		}
		port, err := strconv.Atoi(portText)
		if err != nil {
			return fmt.Errorf("解析本地端口失败：%w", err)
		}

		runConfig.Host = host
		runConfig.Port = port
		runConfig.UseSSH = false
		logger.Infof("ClickHouse 通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	}

	attempts := []connection.ConnectionConfig{runConfig}
	if shouldTrySSLPreferredFallback(runConfig) {
		attempts = append(attempts, withSSLDisabled(runConfig))
	}

	var failures []string
	for idx, attempt := range attempts {
		protocols := clickHouseProtocolsForAttempt(attempt)
		for pIdx, protocol := range protocols {
			protocolConfig := withClickHouseProtocol(attempt, protocol)
			compatibilityModes := []bool{false}
			if protocol == clickhouse.HTTP {
				compatibilityModes = append(compatibilityModes, true)
			}
			protocolSuccess := false
			var lastProtocolErr error
			for compatIdx, stripHTTPClientProtocolVersion := range compatibilityModes {
				logger.Infof("ClickHouse 连接尝试：第%d组/%d 协议=%s 地址=%s:%d SSL=%t HTTP兼容=%t",
					idx+1, len(attempts), clickHouseProtocolName(protocol), protocolConfig.Host, protocolConfig.Port, protocolConfig.UseSSL, stripHTTPClientProtocolVersion)
				opts, err := c.buildClickHouseOptionsWithHTTPCompatibility(protocolConfig, stripHTTPClientProtocolVersion)
				if err != nil {
					failures = append(failures, clickHouseTLSConfigFailedMessage(idx+1, protocol.String(), err))
					logger.Warnf("ClickHouse TLS 配置失败：第%d组/%d 协议=%s 地址=%s:%d SSL=%t 原因=%v",
						idx+1, len(attempts), clickHouseProtocolName(protocol), protocolConfig.Host, protocolConfig.Port, protocolConfig.UseSSL, err)
					lastProtocolErr = err
					break
				}
				c.conn = clickhouse.OpenDB(opts)
				configureSQLConnectionPool(c.conn, "clickhouse")
				if err := c.Ping(); err != nil {
					lastProtocolErr = err
					failureMessage := clickHouseAttemptFailureMessage(protocol, err)
					failures = append(failures, clickHouseAttemptValidationFailedMessage(idx+1, protocol.String(), failureMessage))
					logger.Warnf("ClickHouse 连接尝试失败：第%d组/%d 协议=%s 地址=%s:%d SSL=%t HTTP兼容=%t 原因=%s",
						idx+1, len(attempts), clickHouseProtocolName(protocol), protocolConfig.Host, protocolConfig.Port, protocolConfig.UseSSL, stripHTTPClientProtocolVersion, failureMessage)
					if c.conn != nil {
						_ = c.conn.Close()
						c.conn = nil
					}
					if protocol == clickhouse.HTTP &&
						!stripHTTPClientProtocolVersion &&
						shouldRetryClickHouseHTTPCompatibility(err) &&
						compatIdx+1 < len(compatibilityModes) {
						if isClickHouseHTTPServerInfoFunctionUnsupported(err) {
							logger.Warnf("ClickHouse HTTP 端口不支持 displayName() 握手探测函数，改用 HTTP 兼容模式重试")
						} else {
							logger.Warnf("ClickHouse HTTP 端口不支持 client_protocol_version，改用 HTTP 兼容模式重试")
						}
						continue
					}
					if protocol == clickhouse.HTTP && stripHTTPClientProtocolVersion {
						legacyClient, legacyErr := c.connectClickHouseLegacyHTTP(opts)
						if legacyErr == nil {
							c.legacyHTTP = legacyClient
							protocolSuccess = true
							logger.Warnf("ClickHouse HTTP 兼容握手无法解码旧版 Native block，已切换 legacy JSON HTTP 模式")
							break
						}
						lastProtocolErr = legacyErr
						legacyFailure := sanitizeClickHouseErrorMessage(legacyErr)
						failures = append(failures, clickHouseAttemptValidationFailedMessage(idx+1, "legacy-http", legacyFailure))
						logger.Warnf("ClickHouse legacy JSON HTTP 连接尝试失败：第%d组/%d 地址=%s:%d SSL=%t 原因=%s",
							idx+1, len(attempts), protocolConfig.Host, protocolConfig.Port, protocolConfig.UseSSL, legacyFailure)
					}
					break
				}
				protocolSuccess = true
				if stripHTTPClientProtocolVersion {
					logger.Warnf("ClickHouse HTTP 兼容模式连接成功：已移除 client_protocol_version 参数")
				}
				break
			}
			if !protocolSuccess {
				if pIdx == 0 && !shouldTryNextClickHouseProtocol(protocol, lastProtocolErr) {
					// 首次连接不是协议误配或已知兼容性特征，避免无谓重试次协议。
					break
				}
				continue
			}
			if idx > 0 {
				logger.Warnf("ClickHouse SSL 优先连接失败，已回退至明文连接")
			}
			if pIdx > 0 {
				logger.Warnf("ClickHouse 已自动切换连接协议为 %s（常见于 %s HTTP 端口）", protocol.String(), clickHouseHTTPPortHint)
			}
			logger.Infof("ClickHouse 连接验证成功：协议=%s 地址=%s:%d 数据库=%s", clickHouseProtocolName(protocol), protocolConfig.Host, protocolConfig.Port, protocolConfig.Database)
			return nil
		}
	}

	_ = c.Close()
	return fmt.Errorf("%s", clickHouseConnectFailureSummary(runConfig, failures))
}

func (c *ClickHouseDB) connectClickHouseLegacyHTTP(opts *clickhouse.Options) (*clickHouseLegacyHTTPClient, error) {
	legacyClient, err := newClickHouseLegacyHTTPClient(opts)
	if err != nil {
		return nil, err
	}
	timeout := c.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	if err := legacyClient.Ping(ctx); err != nil {
		_ = legacyClient.Close()
		return nil, err
	}
	return legacyClient, nil
}

func (c *ClickHouseDB) Close() error {
	if c.forwarder != nil {
		if err := c.forwarder.Release(); err != nil {
			logger.Warnf("关闭 ClickHouse SSH 端口转发失败：%v", err)
		}
		c.forwarder = nil
	}
	if c.conn != nil {
		err := c.conn.Close()
		c.conn = nil
		if err != nil {
			return err
		}
	}
	if c.legacyHTTP != nil {
		err := c.legacyHTTP.Close()
		c.legacyHTTP = nil
		if err != nil {
			return err
		}
	}
	return nil
}

func (c *ClickHouseDB) Ping() error {
	if c.legacyHTTP != nil {
		timeout := c.pingTimeout
		if timeout <= 0 {
			timeout = 5 * time.Second
		}
		ctx, cancel := utils.ContextWithTimeout(timeout)
		defer cancel()
		return c.legacyHTTP.Ping(ctx)
	}
	if c.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	timeout := c.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	if err := c.conn.PingContext(ctx); err != nil {
		return err
	}
	return c.validateQueryPath()
}

func (c *ClickHouseDB) validateQueryPath() error {
	if c.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	timeout := c.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()

	rows, err := c.conn.QueryContext(ctx, "SELECT currentDatabase()")
	if err != nil {
		return err
	}
	defer rows.Close()

	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return err
		}
		return fmt.Errorf("连接查询验证未返回结果")
	}

	var current sql.NullString
	if err := rows.Scan(&current); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return nil
}

func (c *ClickHouseDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if c.legacyHTTP != nil {
		return c.legacyHTTP.Query(ctx, query)
	}
	if c.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}
	rows, err := c.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRowsContext(ctx, rows)
}

func (c *ClickHouseDB) Query(query string) ([]map[string]interface{}, []string, error) {
	return c.QueryContext(metadataContextFor(c), query)
}

func (c *ClickHouseDB) StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error {
	if c.legacyHTTP != nil {
		return c.legacyHTTP.StreamQuery(ctx, query, consumer)
	}
	if c.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	rows, err := c.conn.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	defer rows.Close()
	return streamRows(rows, consumer)
}

func (c *ClickHouseDB) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return c.StreamQueryContext(context.Background(), query, consumer)
}

func (c *ClickHouseDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if c.legacyHTTP != nil {
		return c.legacyHTTP.Exec(ctx, query)
	}
	if c.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := c.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (c *ClickHouseDB) Exec(query string) (int64, error) {
	if c.legacyHTTP != nil {
		return c.legacyHTTP.Exec(context.Background(), query)
	}
	if c.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := c.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
