package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/nacos"
	"GoNavi-Wails/internal/uievents"
	"golang.org/x/sync/singleflight"
)

var (
	nacosCache                 = make(map[string]nacos.Client)
	nacosCacheMu               sync.Mutex
	nacosCacheGeneration       uint64
	nacosCacheGenerationCtx    context.Context
	nacosCacheGenerationCancel context.CancelFunc
	nacosConnectGroup          singleflight.Group
	newNacosClientFunc         = nacos.NewClient
)

var errNacosCacheInvalidated = errors.New("Nacos 连接缓存已关闭")

const defaultNacosOperationTimeoutSeconds = 30

const nacosNamespaceListForbiddenErrorCode = "nacos_namespace_list_forbidden"

const connectionTestQueryPrefix = "connection-test:"

type nacosContextConnector interface {
	ConnectContext(context.Context, connection.ConnectionConfig) error
}

func init() {
	nacosCacheGenerationCtx, nacosCacheGenerationCancel = context.WithCancel(context.Background())
}

// NacosConfigQuery is the frontend search payload.
type NacosConfigQuery struct {
	NamespaceID string `json:"namespaceId"`
	DataID      string `json:"dataId,omitempty"`
	Group       string `json:"group,omitempty"`
	AppName     string `json:"appName,omitempty"`
	PageNo      int    `json:"pageNo,omitempty"`
	PageSize    int    `json:"pageSize,omitempty"`
	Search      string `json:"search,omitempty"`
}

// NacosPublishConfigPayload is the frontend publish payload.
type NacosPublishConfigPayload struct {
	NamespaceID string `json:"namespaceId"`
	DataID      string `json:"dataId"`
	Group       string `json:"group"`
	Content     string `json:"content"`
	Type        string `json:"type,omitempty"`
	AppName     string `json:"appName,omitempty"`
	Desc        string `json:"desc,omitempty"`
	BetaIPs     string `json:"betaIps,omitempty"`
}

// NacosConfigIdentity identifies one config by dataId + group.
// Named type (not anonymous) so wailsjs models.ts generation stays valid.
type NacosConfigIdentity struct {
	DataID string `json:"dataId"`
	Group  string `json:"group"`
	Index  *int   `json:"index,omitempty"`
}

// NacosExportConfigsOptions controls config export.
type NacosExportConfigsOptions struct {
	NamespaceID   string                `json:"namespaceId"`
	NamespaceName string                `json:"namespaceName,omitempty"`
	Scope         string                `json:"scope,omitempty"` // all | selected
	Items         []NacosConfigIdentity `json:"items,omitempty"`
}

// NacosImportConfigsOptions controls config import.
type NacosImportConfigsOptions struct {
	NamespaceID  string                `json:"namespaceId"`
	ConflictMode string                `json:"conflictMode,omitempty"` // skip | overwrite
	File         string                `json:"file,omitempty"`
	Scope        string                `json:"scope,omitempty"` // all | selected
	Items        []NacosConfigIdentity `json:"items,omitempty"`
}

// NacosCreateNamespacePayload creates a namespace.
type NacosCreateNamespacePayload struct {
	ID          string `json:"id"`
	ShowName    string `json:"showName"`
	Description string `json:"description,omitempty"`
}

// NacosUpdateNamespacePayload updates a namespace.
type NacosUpdateNamespacePayload struct {
	ID          string `json:"id"`
	ShowName    string `json:"showName"`
	Description string `json:"description,omitempty"`
}

// NacosHistoryQuery lists config history.
type NacosHistoryQuery struct {
	NamespaceID string `json:"namespaceId"`
	DataID      string `json:"dataId"`
	Group       string `json:"group"`
	PageNo      int    `json:"pageNo,omitempty"`
	PageSize    int    `json:"pageSize,omitempty"`
}

// NacosServiceQuery lists services.
type NacosServiceQuery struct {
	NamespaceID string `json:"namespaceId"`
	ServiceName string `json:"serviceName,omitempty"`
	GroupName   string `json:"groupName,omitempty"`
	PageNo      int    `json:"pageNo,omitempty"`
	PageSize    int    `json:"pageSize,omitempty"`
}

// NacosServicePayload creates/updates a service.
type NacosServicePayload struct {
	NamespaceID      string            `json:"namespaceId"`
	ServiceName      string            `json:"serviceName"`
	GroupName        string            `json:"groupName,omitempty"`
	Ephemeral        *bool             `json:"ephemeral,omitempty"`
	ProtectThreshold float64           `json:"protectThreshold,omitempty"`
	Metadata         map[string]string `json:"metadata,omitempty"`
}

// NacosInstanceQuery lists instances.
type NacosInstanceQuery struct {
	NamespaceID string `json:"namespaceId"`
	ServiceName string `json:"serviceName"`
	GroupName   string `json:"groupName,omitempty"`
	Clusters    string `json:"clusters,omitempty"`
	HealthyOnly bool   `json:"healthyOnly,omitempty"`
}

// NacosInstancePayload mutates an instance.
type NacosInstancePayload struct {
	NamespaceID string            `json:"namespaceId"`
	ServiceName string            `json:"serviceName"`
	GroupName   string            `json:"groupName,omitempty"`
	IP          string            `json:"ip"`
	Port        int               `json:"port"`
	ClusterName string            `json:"clusterName,omitempty"`
	Weight      *float64          `json:"weight,omitempty"`
	Enabled     *bool             `json:"enabled,omitempty"`
	Healthy     *bool             `json:"healthy,omitempty"`
	Ephemeral   *bool             `json:"ephemeral,omitempty"`
	Metadata    map[string]string `json:"metadata,omitempty"`
}

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

// NacosListNamespaces lists namespaces for a connection.
func (a *App) NacosListNamespaces(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "nacos"
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	namespaces, err := client.ListNamespaces(ctx)
	if err != nil {
		logger.Error(err, "NacosListNamespaces 失败：%s", formatNacosConnSummary(config))
		result := connection.QueryResult{Success: false, Message: err.Error()}
		if status, ok := nacos.HTTPStatusCode(err); ok && status == http.StatusForbidden {
			result.Data = map[string]any{
				"errorCode": nacosNamespaceListForbiddenErrorCode,
			}
		}
		return result
	}
	return connection.QueryResult{Success: true, Data: namespaces}
}

// NacosListConfigGroups lists unique config groups under a namespace.
func (a *App) NacosListConfigGroups(config connection.ConnectionConfig, namespaceID string) connection.QueryResult {
	config.Type = "nacos"
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	groups, err := client.ListConfigGroups(ctx, namespaceID)
	if err != nil {
		logger.Error(err, "NacosListConfigGroups 失败：%s", formatNacosConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: groups}
}

// NacosSearchConfigs searches configs under a namespace.
func (a *App) NacosSearchConfigs(config connection.ConnectionConfig, query NacosConfigQuery) connection.QueryResult {
	config.Type = "nacos"
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	page, err := client.SearchConfigs(ctx, nacos.ConfigQuery{
		NamespaceID: query.NamespaceID,
		DataID:      query.DataID,
		Group:       query.Group,
		AppName:     query.AppName,
		PageNo:      query.PageNo,
		PageSize:    query.PageSize,
		Search:      query.Search,
	})
	if err != nil {
		logger.Error(err, "NacosSearchConfigs 失败：%s", formatNacosConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: page}
}

// NacosGetConfig loads one config.
func (a *App) NacosGetConfig(config connection.ConnectionConfig, namespaceID, group, dataID string) connection.QueryResult {
	config.Type = "nacos"
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	detail, err := client.GetConfig(ctx, namespaceID, group, dataID)
	if err != nil {
		logger.Error(err, "NacosGetConfig 失败：dataId=%s group=%s", dataID, group)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: detail}
}

// NacosPublishConfig creates or updates a config.
func (a *App) NacosPublishConfig(config connection.ConnectionConfig, payload NacosPublishConfigPayload) connection.QueryResult {
	config.Type = "nacos"
	if err := a.ensureNacosDataEditAllowed(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := client.PublishConfig(ctx, nacos.PublishRequest{
		NamespaceID: payload.NamespaceID,
		DataID:      payload.DataID,
		Group:       payload.Group,
		Content:     payload.Content,
		Type:        payload.Type,
		AppName:     payload.AppName,
		Desc:        payload.Desc,
		BetaIPs:     payload.BetaIPs,
	}); err != nil {
		logger.Error(err, "NacosPublishConfig 失败：dataId=%s group=%s", payload.DataID, payload.Group)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(payload.BetaIPs) != "" {
		return connection.QueryResult{
			Success: true,
			Message: a.appText("nacos.backend.message.beta_publish_success", nil),
		}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("nacos.backend.message.publish_success", nil),
	}
}

// NacosGetBetaConfig loads beta config for one dataId/group.
func (a *App) NacosGetBetaConfig(config connection.ConnectionConfig, namespaceID, group, dataID string) connection.QueryResult {
	config.Type = "nacos"
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	detail, err := client.GetBetaConfig(ctx, namespaceID, group, dataID)
	if err != nil {
		logger.Error(err, "NacosGetBetaConfig 失败：dataId=%s group=%s", dataID, group)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: detail}
}

// NacosStopBetaConfig stops beta publish.
func (a *App) NacosStopBetaConfig(config connection.ConnectionConfig, namespaceID, group, dataID string) connection.QueryResult {
	config.Type = "nacos"
	if err := a.ensureNacosDataEditAllowed(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := client.StopBetaConfig(ctx, namespaceID, group, dataID); err != nil {
		logger.Error(err, "NacosStopBetaConfig 失败：dataId=%s group=%s", dataID, group)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("nacos.backend.message.beta_stop_success", nil),
	}
}

// NacosDeleteConfig deletes a config.
func (a *App) NacosDeleteConfig(config connection.ConnectionConfig, namespaceID, group, dataID string) connection.QueryResult {
	config.Type = "nacos"
	if err := a.ensureNacosDataEditAllowed(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := client.DeleteConfig(ctx, namespaceID, group, dataID); err != nil {
		logger.Error(err, "NacosDeleteConfig 失败：dataId=%s group=%s", dataID, group)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("nacos.backend.message.delete_success", nil),
	}
}

// NacosCreateNamespace creates a namespace.
func (a *App) NacosCreateNamespace(config connection.ConnectionConfig, payload NacosCreateNamespacePayload) connection.QueryResult {
	config.Type = "nacos"
	if err := a.ensureNacosStructureEditAllowed(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := client.CreateNamespace(ctx, nacos.CreateNamespaceRequest{
		ID:          payload.ID,
		ShowName:    payload.ShowName,
		Description: payload.Description,
	}); err != nil {
		logger.Error(err, "NacosCreateNamespace 失败：id=%s name=%s", payload.ID, payload.ShowName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("nacos.backend.message.namespace_create_success", nil),
	}
}

// NacosUpdateNamespace updates a namespace.
func (a *App) NacosUpdateNamespace(config connection.ConnectionConfig, payload NacosUpdateNamespacePayload) connection.QueryResult {
	config.Type = "nacos"
	if err := a.ensureNacosStructureEditAllowed(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := client.UpdateNamespace(ctx, nacos.UpdateNamespaceRequest{
		ID:          payload.ID,
		ShowName:    payload.ShowName,
		Description: payload.Description,
	}); err != nil {
		logger.Error(err, "NacosUpdateNamespace 失败：id=%s", payload.ID)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("nacos.backend.message.namespace_update_success", nil),
	}
}

// NacosDeleteNamespace deletes a namespace.
func (a *App) NacosDeleteNamespace(config connection.ConnectionConfig, namespaceID string) connection.QueryResult {
	config.Type = "nacos"
	if err := a.ensureNacosStructureEditAllowed(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := client.DeleteNamespace(ctx, namespaceID); err != nil {
		logger.Error(err, "NacosDeleteNamespace 失败：id=%s", namespaceID)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("nacos.backend.message.namespace_delete_success", nil),
	}
}

// NacosListConfigHistory lists history for one config.
func (a *App) NacosListConfigHistory(config connection.ConnectionConfig, query NacosHistoryQuery) connection.QueryResult {
	config.Type = "nacos"
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	page, err := client.ListConfigHistory(ctx, nacos.HistoryQuery{
		NamespaceID: query.NamespaceID,
		DataID:      query.DataID,
		Group:       query.Group,
		PageNo:      query.PageNo,
		PageSize:    query.PageSize,
	})
	if err != nil {
		logger.Error(err, "NacosListConfigHistory 失败：dataId=%s group=%s", query.DataID, query.Group)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: page}
}

// NacosGetConfigHistory loads one history detail.
func (a *App) NacosGetConfigHistory(config connection.ConnectionConfig, namespaceID, group, dataID, nid string) connection.QueryResult {
	config.Type = "nacos"
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	item, err := client.GetConfigHistory(ctx, namespaceID, group, dataID, nid)
	if err != nil {
		logger.Error(err, "NacosGetConfigHistory 失败：nid=%s dataId=%s", nid, dataID)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: item}
}

// NacosListServices lists services under a namespace.
func (a *App) NacosListServices(config connection.ConnectionConfig, query NacosServiceQuery) connection.QueryResult {
	config.Type = "nacos"
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	page, err := client.ListServices(ctx, nacos.ServiceQuery{
		NamespaceID: query.NamespaceID,
		ServiceName: query.ServiceName,
		GroupName:   query.GroupName,
		PageNo:      query.PageNo,
		PageSize:    query.PageSize,
	})
	if err != nil {
		logger.Error(err, "NacosListServices 失败：%s", formatNacosConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: page}
}

// NacosGetService loads service detail.
func (a *App) NacosGetService(config connection.ConnectionConfig, namespaceID, serviceName, groupName string) connection.QueryResult {
	config.Type = "nacos"
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	detail, err := client.GetService(ctx, namespaceID, serviceName, groupName)
	if err != nil {
		logger.Error(err, "NacosGetService 失败：service=%s", serviceName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: detail}
}

// NacosCreateService creates a service.
func (a *App) NacosCreateService(config connection.ConnectionConfig, payload NacosServicePayload) connection.QueryResult {
	config.Type = "nacos"
	if err := a.ensureNacosStructureEditAllowed(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := client.CreateService(ctx, nacos.CreateServiceRequest{
		NamespaceID:      payload.NamespaceID,
		ServiceName:      payload.ServiceName,
		GroupName:        payload.GroupName,
		Ephemeral:        payload.Ephemeral,
		ProtectThreshold: payload.ProtectThreshold,
		Metadata:         payload.Metadata,
	}); err != nil {
		logger.Error(err, "NacosCreateService 失败：service=%s", payload.ServiceName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("nacos.backend.message.service_create_success", nil)}
}

// NacosUpdateService updates a service.
func (a *App) NacosUpdateService(config connection.ConnectionConfig, payload NacosServicePayload) connection.QueryResult {
	config.Type = "nacos"
	if err := a.ensureNacosStructureEditAllowed(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := client.UpdateService(ctx, nacos.UpdateServiceRequest{
		NamespaceID:      payload.NamespaceID,
		ServiceName:      payload.ServiceName,
		GroupName:        payload.GroupName,
		ProtectThreshold: payload.ProtectThreshold,
		Metadata:         payload.Metadata,
	}); err != nil {
		logger.Error(err, "NacosUpdateService 失败：service=%s", payload.ServiceName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("nacos.backend.message.service_update_success", nil)}
}

// NacosDeleteService deletes a service.
func (a *App) NacosDeleteService(config connection.ConnectionConfig, namespaceID, serviceName, groupName string) connection.QueryResult {
	config.Type = "nacos"
	if err := a.ensureNacosStructureEditAllowed(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := client.DeleteService(ctx, namespaceID, serviceName, groupName); err != nil {
		logger.Error(err, "NacosDeleteService 失败：service=%s", serviceName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("nacos.backend.message.service_delete_success", nil)}
}

// NacosListInstances lists instances of a service.
func (a *App) NacosListInstances(config connection.ConnectionConfig, query NacosInstanceQuery) connection.QueryResult {
	config.Type = "nacos"
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	list, err := client.ListInstances(ctx, nacos.InstanceQuery{
		NamespaceID: query.NamespaceID,
		ServiceName: query.ServiceName,
		GroupName:   query.GroupName,
		Clusters:    query.Clusters,
		HealthyOnly: query.HealthyOnly,
	})
	if err != nil {
		logger.Error(err, "NacosListInstances 失败：service=%s", query.ServiceName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: list}
}

// NacosGetInstance loads one instance.
func (a *App) NacosGetInstance(config connection.ConnectionConfig, payload NacosInstancePayload) connection.QueryResult {
	config.Type = "nacos"
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	inst, err := client.GetInstance(ctx, toNacosInstanceRequest(payload))
	if err != nil {
		logger.Error(err, "NacosGetInstance 失败：%s:%d", payload.IP, payload.Port)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: inst}
}

// NacosRegisterInstance registers an instance.
func (a *App) NacosRegisterInstance(config connection.ConnectionConfig, payload NacosInstancePayload) connection.QueryResult {
	config.Type = "nacos"
	if err := a.ensureNacosDataEditAllowed(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := client.RegisterInstance(ctx, toNacosInstanceRequest(payload)); err != nil {
		logger.Error(err, "NacosRegisterInstance 失败：%s:%d", payload.IP, payload.Port)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("nacos.backend.message.instance_register_success", nil)}
}

// NacosUpdateInstance updates an instance.
func (a *App) NacosUpdateInstance(config connection.ConnectionConfig, payload NacosInstancePayload) connection.QueryResult {
	config.Type = "nacos"
	if err := a.ensureNacosDataEditAllowed(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := client.UpdateInstance(ctx, toNacosInstanceRequest(payload)); err != nil {
		logger.Error(err, "NacosUpdateInstance 失败：%s:%d", payload.IP, payload.Port)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("nacos.backend.message.instance_update_success", nil)}
}

// NacosDeregisterInstance deregisters an instance.
func (a *App) NacosDeregisterInstance(config connection.ConnectionConfig, payload NacosInstancePayload) connection.QueryResult {
	config.Type = "nacos"
	if err := a.ensureNacosDataEditAllowed(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := client.DeregisterInstance(ctx, toNacosInstanceRequest(payload)); err != nil {
		logger.Error(err, "NacosDeregisterInstance 失败：%s:%d", payload.IP, payload.Port)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("nacos.backend.message.instance_deregister_success", nil)}
}

// NacosUpdateInstanceHealth updates instance health.
func (a *App) NacosUpdateInstanceHealth(config connection.ConnectionConfig, payload NacosInstancePayload) connection.QueryResult {
	config.Type = "nacos"
	if err := a.ensureNacosDataEditAllowed(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := client.UpdateInstanceHealth(ctx, toNacosInstanceRequest(payload)); err != nil {
		logger.Error(err, "NacosUpdateInstanceHealth 失败：%s:%d", payload.IP, payload.Port)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("nacos.backend.message.instance_health_success", nil)}
}

func toNacosInstanceRequest(payload NacosInstancePayload) nacos.InstanceRequest {
	return nacos.InstanceRequest{
		NamespaceID: payload.NamespaceID,
		ServiceName: payload.ServiceName,
		GroupName:   payload.GroupName,
		IP:          payload.IP,
		Port:        payload.Port,
		ClusterName: payload.ClusterName,
		Weight:      payload.Weight,
		Enabled:     payload.Enabled,
		Healthy:     payload.Healthy,
		Ephemeral:   payload.Ephemeral,
		Metadata:    payload.Metadata,
	}
}

func (a *App) ensureNacosDataEditAllowed(config connection.ConnectionConfig) error {
	// Keep the Nacos-specific message while honoring the shared production guard.
	if config.ReadOnly || config.Protection.RestrictDataEdit {
		return fmt.Errorf("%s", a.appText("nacos.backend.error.read_only", nil))
	}
	return nil
}

func (a *App) ensureNacosStructureEditAllowed(config connection.ConnectionConfig) error {
	if config.ReadOnly || config.Protection.RestrictStructureEdit {
		return fmt.Errorf("%s", a.appText("nacos.backend.error.read_only", nil))
	}
	return nil
}
