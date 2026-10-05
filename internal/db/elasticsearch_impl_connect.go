//go:build gonavi_full_drivers || gonavi_elasticsearch_driver || gonavi_opensearch_driver

package db

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"

	"github.com/elastic/go-elasticsearch/v8"
)

// Connect 建立到 Elasticsearch 集群的连接。
func (e *ElasticsearchDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = e.Close()
	defer func() {
		if err != nil {
			_ = e.Close()
		}
	}()

	runConfig := normalizeElasticsearchConfig(config)
	e.pingTimeout = getConnectTimeout(runConfig)
	e.database = strings.TrimSpace(runConfig.Database)

	logger.Infof("Elasticsearch 连接准备：地址=%s:%d 用户=%s SSL=%t SSH=%t 超时=%s",
		runConfig.Host, runConfig.Port, runConfig.User, runConfig.UseSSL, runConfig.UseSSH, e.pingTimeout)

	// SSH 隧道支持
	if runConfig.UseSSH {
		logger.Infof("Elasticsearch 使用 SSH 连接：地址=%s:%d", runConfig.Host, runConfig.Port)
		forwarder, err := ssh.AcquireLocalForwarder(runConfig.SSH, runConfig.Host, runConfig.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		e.forwarder = forwarder

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
		logger.Infof("Elasticsearch 通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	}

	// SSL 回退尝试
	attempts := []connection.ConnectionConfig{runConfig}
	if shouldTrySSLPreferredFallback(runConfig) {
		attempts = append(attempts, withSSLDisabled(runConfig))
	}

	var lastErr error
	for idx, attempt := range attempts {
		sslLabel := esSSLAttemptLabel(attempt, idx > 0)
		logger.Infof("Elasticsearch 连接尝试：%d/%d 模式=%s 地址=%s:%d",
			idx+1, len(attempts), sslLabel, attempt.Host, attempt.Port)

		esCfg := buildESClientConfig(attempt)
		client, err := elasticsearch.NewClient(esCfg)
		if err != nil {
			logger.Warnf("Elasticsearch 创建客户端失败：%d/%d 模式=%s 错误=%v", idx+1, len(attempts), sslLabel, err)
			lastErr = err
			continue
		}
		consoleCfg := esCfg
		consoleCfg.DisableRetry = true
		consoleCfg.MaxRetries = 0
		consoleCfg.RetryOnStatus = nil
		consoleCfg.RetryOnError = nil
		consoleClient, err := elasticsearch.NewClient(consoleCfg)
		if err != nil {
			logger.Warnf("Elasticsearch 创建 Console 客户端失败：%d/%d 模式=%s 错误=%v", idx+1, len(attempts), sslLabel, err)
			lastErr = err
			continue
		}

		e.client = client
		e.consoleClient = consoleClient
		verificationStartedAt := time.Now()
		if err := e.Ping(); err != nil {
			e.client = nil
			e.consoleClient = nil
			if e.forwarder != nil {
				err = wrapDatabaseConnectionVerifyErrorWithForwarder(err, e.forwarder, verificationStartedAt)
			}
			logger.Warnf("Elasticsearch 连接验证失败：%d/%d 模式=%s 错误=%v", idx+1, len(attempts), sslLabel, err)
			lastErr = err
			continue
		}
		probeTimeout := e.pingTimeout
		if probeTimeout <= 0 {
			probeTimeout = defaultEsPingTimeout
		}
		probeCtx, cancelProbe := context.WithTimeout(context.Background(), probeTimeout)
		major, probeErr := e.probeServerMajor(probeCtx)
		cancelProbe()
		if probeErr != nil {
			logger.Warnf("Elasticsearch 版本探测失败，将使用通用 Console 模板：%v", probeErr)
		} else {
			e.serverMajor = major
		}
		logger.Infof("Elasticsearch 连接成功：%d/%d 模式=%s", idx+1, len(attempts), sslLabel)
		if idx > 0 {
			logger.Warnf("Elasticsearch SSL 优先连接失败，已回退至明文连接")
		}
		return nil
	}

	if lastErr != nil {
		return fmt.Errorf("Elasticsearch 连接失败：%w", lastErr)
	}
	return fmt.Errorf("Elasticsearch 连接失败：无可用连接方案")
}

func (e *ElasticsearchDB) probeServerMajor(ctx context.Context) (int, error) {
	if e.client == nil {
		return 0, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "/", nil)
	if err != nil {
		return 0, err
	}
	response, err := e.client.Perform(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return 0, fmt.Errorf("版本端点返回 HTTP %d", response.StatusCode)
	}
	var payload struct {
		Version struct {
			Number string `json:"number"`
		} `json:"version"`
	}
	body, err := readResponseBodyWithLimit(response.Body, 1<<20, "Elasticsearch 版本响应")
	if err != nil {
		return 0, fmt.Errorf("读取版本响应失败：%w", err)
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return 0, fmt.Errorf("解析版本响应失败：%w", err)
	}
	majorText, _, _ := strings.Cut(strings.TrimSpace(payload.Version.Number), ".")
	major, err := strconv.Atoi(majorText)
	if err != nil || major <= 0 {
		return 0, fmt.Errorf("无效的 Elasticsearch 版本号 %q", payload.Version.Number)
	}
	return major, nil
}

// Close 关闭 Elasticsearch 连接并释放底层资源。
func (e *ElasticsearchDB) Close() error {
	if e.forwarder != nil {
		if err := e.forwarder.Release(); err != nil {
			logger.Warnf("关闭 Elasticsearch SSH 端口转发失败：%v", err)
		}
		e.forwarder = nil
	}
	if e.consoleClient != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := e.consoleClient.Close(ctx); err != nil {
			logger.Warnf("关闭 Elasticsearch Console 客户端失败：%v", err)
		}
		cancel()
		e.consoleClient = nil
	}
	if e.client != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := e.client.Close(ctx); err != nil {
			logger.Warnf("关闭 Elasticsearch 客户端失败：%v", err)
		}
		cancel()
		e.client = nil
	}
	e.serverMajor = 0
	return nil
}

// Ping 检测 Elasticsearch 连通性。
func (e *ElasticsearchDB) Ping() error {
	if e.client == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	timeout := e.pingTimeout
	if timeout <= 0 {
		timeout = defaultEsPingTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	res, err := e.client.Ping(e.client.Ping.WithContext(ctx))
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.IsError() {
		return fmt.Errorf("Elasticsearch Ping 失败：%s", res.Status())
	}
	return nil
}
