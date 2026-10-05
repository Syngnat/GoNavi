package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/nacos"
	"GoNavi-Wails/internal/uievents"

	"golang.org/x/sync/singleflight"
)

func formatNacosConnSummary(config connection.ConnectionConfig) string {
	var b strings.Builder
	b.WriteString("类型=nacos 地址=")
	b.WriteString(strings.TrimSpace(config.Host))
	b.WriteString(":")
	b.WriteString(strconv.Itoa(config.Port))
	if config.UseSSL {
		b.WriteString(" SSL=on")
	}
	if user := strings.TrimSpace(config.User); user != "" {
		b.WriteString(" 用户=")
		b.WriteString(user)
	}
	if contextPath := nacosContextPathForSummary(config.ConnectionParams); contextPath != "" {
		b.WriteString(" contextPath=")
		b.WriteString(contextPath)
	}
	return b.String()
}

func nacosContextPathForSummary(raw string) string {
	normalized := strings.NewReplacer(";", "&", "\r", "&", "\n", "&").Replace(raw)
	values, _ := url.ParseQuery(normalized)
	contextPath := strings.TrimSpace(values.Get("contextPath"))
	if contextPath == "" {
		return ""
	}
	for _, char := range contextPath {
		if char < 0x20 || char == 0x7f {
			return ""
		}
	}
	if contextPath == "/" {
		return "/"
	}
	if !strings.HasPrefix(contextPath, "/") {
		contextPath = "/" + contextPath
	}
	return strings.TrimRight(contextPath, "/")
}

func getNacosClientCacheKey(config connection.ConnectionConfig) string {
	normalized := normalizeCacheKeyConfig(config)
	identity := struct {
		Type                  string `json:"type"`
		Host                  string `json:"host"`
		Port                  int    `json:"port"`
		User                  string `json:"user"`
		Password              string `json:"password"`
		UseSSL                bool   `json:"useSSL"`
		SSLMode               string `json:"sslMode"`
		SSLCAPath             string `json:"sslCAPath"`
		SSLCertPath           string `json:"sslCertPath"`
		SSLKeyPath            string `json:"sslKeyPath"`
		ConnectionParams      string `json:"connectionParams"`
		Database              string `json:"database"`
		UseSSH                bool   `json:"useSSH"`
		SSHHost               string `json:"sshHost"`
		SSHPort               int    `json:"sshPort"`
		SSHUser               string `json:"sshUser"`
		SSHPassword           string `json:"sshPassword"`
		SSHKeyPath            string `json:"sshKeyPath"`
		SSHKnownHostsPath     string `json:"sshKnownHostsPath"`
		SSHHostKeyFingerprint string `json:"sshHostKeyFingerprint"`
		UseProxy              bool   `json:"useProxy"`
		ProxyType             string `json:"proxyType"`
		ProxyHost             string `json:"proxyHost"`
		ProxyPort             int    `json:"proxyPort"`
		ProxyUser             string `json:"proxyUser"`
		ProxyPassword         string `json:"proxyPassword"`
		UseHTTPTunnel         bool   `json:"useHttpTunnel"`
		HTTPTunnelHost        string `json:"httpTunnelHost"`
		HTTPTunnelPort        int    `json:"httpTunnelPort"`
		HTTPTunnelUser        string `json:"httpTunnelUser"`
		HTTPTunnelPassword    string `json:"httpTunnelPassword"`
	}{
		Type:                  "nacos",
		Host:                  strings.TrimSpace(normalized.Host),
		Port:                  normalized.Port,
		User:                  strings.TrimSpace(normalized.User),
		Password:              normalized.Password,
		UseSSL:                normalized.UseSSL,
		SSLMode:               strings.TrimSpace(normalized.SSLMode),
		SSLCAPath:             strings.TrimSpace(normalized.SSLCAPath),
		SSLCertPath:           strings.TrimSpace(normalized.SSLCertPath),
		SSLKeyPath:            strings.TrimSpace(normalized.SSLKeyPath),
		ConnectionParams:      strings.TrimSpace(normalized.ConnectionParams),
		Database:              strings.TrimSpace(normalized.Database),
		UseSSH:                normalized.UseSSH,
		SSHHost:               strings.TrimSpace(normalized.SSH.Host),
		SSHPort:               normalized.SSH.Port,
		SSHUser:               strings.TrimSpace(normalized.SSH.User),
		SSHPassword:           normalized.SSH.Password,
		SSHKeyPath:            strings.TrimSpace(normalized.SSH.KeyPath),
		SSHKnownHostsPath:     strings.TrimSpace(normalized.SSH.KnownHostsPath),
		SSHHostKeyFingerprint: strings.TrimSpace(normalized.SSH.HostKeyFingerprint),
		UseProxy:              normalized.UseProxy,
		ProxyType:             strings.TrimSpace(normalized.Proxy.Type),
		ProxyHost:             strings.TrimSpace(normalized.Proxy.Host),
		ProxyPort:             normalized.Proxy.Port,
		ProxyUser:             strings.TrimSpace(normalized.Proxy.User),
		ProxyPassword:         normalized.Proxy.Password,
		UseHTTPTunnel:         normalized.UseHTTPTunnel,
		HTTPTunnelHost:        strings.TrimSpace(normalized.HTTPTunnel.Host),
		HTTPTunnelPort:        normalized.HTTPTunnel.Port,
		HTTPTunnelUser:        strings.TrimSpace(normalized.HTTPTunnel.User),
		HTTPTunnelPassword:    normalized.HTTPTunnel.Password,
	}
	raw, _ := json.Marshal(identity)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func (a *App) getNacosClient(config connection.ConnectionConfig) (nacos.Client, error) {
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	return a.getNacosClientWithContext(ctx, config)
}

func (a *App) getNacosClientWithContext(ctx context.Context, config connection.ConnectionConfig) (nacos.Client, error) {
	if ctx == nil {
		return nil, fmt.Errorf("Nacos 连接上下文不能为空")
	}

	nacosCacheMu.Lock()
	requestGeneration := nacosCacheGeneration
	requestGenerationCtx := nacosCacheGenerationCtx
	nacosCacheMu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	resolvedConfig, err := a.resolveConnectionSecrets(config)
	if err != nil {
		wrapped := wrapConnectError(config, err)
		logger.Error(wrapped, "Nacos 密文解析失败：%s", formatNacosConnSummary(config))
		return nil, wrapped
	}

	effectiveConfig := a.withManagedSSHHostKeyTrustStore(resolvedConfig)
	connectConfig, proxyErr := resolveDialConfigWithProxyFunc(effectiveConfig)
	if proxyErr != nil {
		wrapped := wrapConnectError(effectiveConfig, proxyErr)
		logger.Error(wrapped, "Nacos 代理准备失败：%s", formatNacosConnSummary(effectiveConfig))
		return nil, wrapped
	}
	connectConfig.Type = "nacos"
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	cacheIdentityConfig := effectiveConfig
	cacheIdentityConfig.Type = "nacos"
	key := getNacosClientCacheKey(cacheIdentityConfig)

	flightKey := strconv.FormatUint(requestGeneration, 10) + ":" + key + ":" +
		strconv.Itoa(nacosOperationTimeoutSeconds(connectConfig))

	resultCh := nacosConnectGroup.DoChan(flightKey, func() (any, error) {
		if requestGenerationCtx.Err() != nil {
			return nil, errNacosCacheInvalidated
		}
		nacosCacheMu.Lock()
		if nacosCacheGeneration != requestGeneration {
			nacosCacheMu.Unlock()
			return nil, errNacosCacheInvalidated
		}
		cachedClient := nacosCache[key]
		nacosCacheMu.Unlock()

		if cachedClient != nil {
			// net/http transports reconnect on demand. Returning the published
			// client directly also prevents timeout-specific flights from racing
			// to evict and close the same cached client.
			return cachedClient, nil
		}

		// Another cache publisher may have won after this timeout-specific cold
		// connection flight started. Recheck before opening a physical client.
		nacosCacheMu.Lock()
		if nacosCacheGeneration != requestGeneration {
			nacosCacheMu.Unlock()
			return nil, errNacosCacheInvalidated
		}
		cachedClient = nacosCache[key]
		nacosCacheMu.Unlock()
		if cachedClient != nil {
			return cachedClient, nil
		}
		if requestGenerationCtx.Err() != nil {
			return nil, errNacosCacheInvalidated
		}

		client := newNacosClientFunc()
		if err := client.Connect(connectConfig); err != nil {
			_ = client.Close()
			wrapped := wrapConnectError(connectConfig, err)
			logger.Error(wrapped, "Nacos 连接失败：%s", formatNacosConnSummary(connectConfig))
			return nil, wrapped
		}
		if requestGenerationCtx.Err() != nil {
			_ = client.Close()
			return nil, errNacosCacheInvalidated
		}

		nacosCacheMu.Lock()
		cacheInvalidated := nacosCacheGeneration != requestGeneration
		if !cacheInvalidated {
			cachedClient = nacosCache[key]
		}
		if !cacheInvalidated && cachedClient == nil {
			nacosCache[key] = client
		}
		nacosCacheMu.Unlock()
		if cacheInvalidated {
			_ = client.Close()
			return nil, errNacosCacheInvalidated
		}
		if cachedClient != nil {
			// Defensive loser cleanup: a cache writer outside this keyed flight
			// must never leave an unpublished physical client alive.
			_ = client.Close()
			return cachedClient, nil
		}

		logger.Infof("Nacos 连接成功并写入缓存：%s", formatNacosConnSummary(connectConfig))
		return client, nil
	})

	var result singleflight.Result
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case result = <-resultCh:
	}
	if result.Err != nil {
		return nil, result.Err
	}
	client, ok := result.Val.(nacos.Client)
	if !ok || client == nil {
		return nil, fmt.Errorf("Nacos 连接缓存返回了无效实例")
	}
	return client, nil
}

func (a *App) openNacosClientIsolated(config connection.ConnectionConfig) (nacos.Client, error) {
	return a.openNacosClientIsolatedWithContext(context.Background(), config)
}

func (a *App) openNacosClientIsolatedWithContext(ctx context.Context, config connection.ConnectionConfig) (nacos.Client, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	resolvedConfig, err := a.resolveConnectionSecrets(config)
	if err != nil {
		wrapped := wrapConnectError(config, err)
		logger.Error(wrapped, "Nacos 密文解析失败：%s", formatNacosConnSummary(config))
		return nil, wrapped
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	effectiveConfig := a.withManagedSSHHostKeyTrustStore(resolvedConfig)
	connectConfig, proxyErr := resolveDialConfigWithProxyFunc(effectiveConfig)
	if proxyErr != nil {
		wrapped := wrapConnectError(effectiveConfig, proxyErr)
		logger.Error(wrapped, "Nacos 代理准备失败：%s", formatNacosConnSummary(effectiveConfig))
		return nil, wrapped
	}
	connectConfig.Type = "nacos"
	client := newNacosClientFunc()
	if err := connectNacosClientWithContext(ctx, client, connectConfig); err != nil {
		_ = client.Close()
		wrapped := wrapConnectError(connectConfig, err)
		if !errors.Is(ctx.Err(), context.Canceled) {
			logger.Error(wrapped, "Nacos 临时连接失败：%s", formatNacosConnSummary(connectConfig))
		}
		return nil, wrapped
	}
	return client, nil
}

func connectNacosClientWithContext(ctx context.Context, client nacos.Client, config connection.ConnectionConfig) error {
	if connector, ok := client.(nacosContextConnector); ok {
		return connector.ConnectContext(ctx, config)
	}

	resultCh := make(chan error, 1)
	go func() {
		resultCh <- client.Connect(config)
	}()
	select {
	case err := <-resultCh:
		return err
	case <-ctx.Done():
		_ = client.Close()
		trackConnectionHealthCleanup(ctx, func() {
			<-resultCh
			_ = client.Close()
		})
		return ctx.Err()
	}
}

func (a *App) nacosOperationContext(config connection.ConnectionConfig) (context.Context, context.CancelFunc) {
	return context.WithTimeout(
		context.Background(),
		time.Duration(nacosOperationTimeoutSeconds(config))*time.Second,
	)
}

func nacosOperationTimeoutSeconds(config connection.ConnectionConfig) int {
	if config.Timeout <= 0 {
		return defaultNacosOperationTimeoutSeconds
	}
	return config.Timeout
}

// NacosConnect establishes and caches a Nacos connection.
func (a *App) NacosConnect(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "nacos"
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	_, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		if trustResult, ok := a.sshHostKeyTrustRequiredResult(err); ok {
			logger.Warnf("NacosConnect 需要确认 SSH 服务端身份：%s", formatNacosConnSummary(config))
			return trustResult
		}
		logger.Error(err, "NacosConnect 连接失败：%s", formatNacosConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	logger.Infof("NacosConnect 连接成功：%s", formatNacosConnSummary(config))
	return connection.QueryResult{Success: true, Message: a.appText("nacos.backend.message.connect_success", nil)}
}

// NacosTestConnection tests connectivity without reusing long-lived cache.
func (a *App) NacosTestConnection(config connection.ConnectionConfig) connection.QueryResult {
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	return a.nacosTestConnection(ctx, config, nil)
}

// NacosTestConnectionWithProgress tests a Nacos connection through SSH while
// emitting the same non-sensitive connection stages as database test runs.
// It deliberately uses an isolated Nacos client so every interactive test
// establishes and verifies its own SSH tunnel instead of reusing a cached one.
func (a *App) NacosTestConnectionWithProgress(config connection.ConnectionConfig, runID string) connection.QueryResult {
	runID = strings.TrimSpace(runID)
	if runID == "" {
		return a.NacosTestConnection(config)
	}
	ctx, cancel := a.nacosOperationContext(config)
	queryID := connectionTestQueryPrefix + runID
	cleanup, registered := a.registerExclusiveRunningQuery(queryID, cancel, true)
	if !registered {
		cancel()
		return connection.QueryResult{Success: false, Message: "connection test is already running"}
	}
	defer func() {
		cancel()
		cleanup()
	}()

	var report connectionTestProgressReporter
	if config.UseSSH {
		report = func(stage string, status string) {
			uievents.Emit(a.ctx, connectionTestProgressEventName, connectionTestProgressEvent{
				RunID:  runID,
				Stage:  stage,
				Status: status,
			})
		}
	}
	return a.nacosTestConnection(ctx, config, report)
}

// CancelConnectionTest cancels one active connection test without touching
// shared database connections or SSH forwarders owned by other connections.
func (a *App) CancelConnectionTest(runID string) connection.QueryResult {
	runID = strings.TrimSpace(runID)
	if runID == "" {
		return connection.QueryResult{Success: false}
	}

	a.queryMu.RLock()
	query, exists := a.runningQueries[connectionTestQueryPrefix+runID]
	a.queryMu.RUnlock()
	if !exists {
		return connection.QueryResult{Success: false}
	}
	query.cancel()
	return connection.QueryResult{
		Success: true,
		Data:    map[string]any{"cancelled": true},
	}
}

func (a *App) nacosTestConnection(ctx context.Context, config connection.ConnectionConfig, report connectionTestProgressReporter) connection.QueryResult {
	if ctx == nil {
		ctx = context.Background()
	}
	config.Type = "nacos"
	if report != nil {
		report("preparing", "running")
		config.SSH = config.SSH.WithProgressReporter(func(event connection.SSHProgressEvent) {
			report(event.Stage, event.Status)
		})
	}
	client, err := a.openNacosClientIsolatedWithContext(ctx, config)
	if err != nil {
		if report != nil {
			report("failed", "error")
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			return connection.QueryResult{
				Success: false,
				Data:    map[string]any{"cancelled": true},
			}
		}
		if trustResult, ok := a.sshHostKeyTrustRequiredResult(err); ok {
			logger.Warnf("NacosTestConnection 需要确认 SSH 服务端身份：%s", formatNacosConnSummary(config))
			return trustResult
		}
		logger.Error(err, "NacosTestConnection 连接失败：%s", formatNacosConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if client != nil {
		if closeErr := client.Close(); closeErr != nil {
			if report != nil {
				report("failed", "error")
			}
			logger.Error(closeErr, "NacosTestConnection 释放临时连接失败：%s", formatNacosConnSummary(config))
			return connection.QueryResult{
				Success: false,
				Message: a.appText("nacos.backend.error.test_connection_close_failed", map[string]any{"detail": closeErr.Error()}),
			}
		}
	}
	if report != nil {
		report("database_connected", "success")
	}
	logger.Infof("NacosTestConnection 连接成功：%s", formatNacosConnSummary(config))
	return connection.QueryResult{Success: true, Message: a.appText("nacos.backend.message.connect_success", nil)}
}
