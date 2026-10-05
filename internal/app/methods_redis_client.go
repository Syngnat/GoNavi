package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/redis"
)

// getRedisClient gets or creates a Redis client from cache
func (a *App) getRedisClient(config connection.ConnectionConfig) (redis.RedisClient, error) {
	if a != nil && a.metadataSession != nil {
		return a.metadataSession.openRedisClient(config)
	}

	resolvedConfig, err := a.resolveConnectionSecrets(config)
	if err != nil {
		wrapped := wrapConnectError(config, err)
		logger.Error(wrapped, "Redis 密文解析失败：%s", formatRedisConnSummary(config))
		return nil, wrapped
	}

	effectiveConfig := a.withManagedSSHHostKeyTrustStore(resolvedConfig)
	connectConfig, proxyErr := resolveDialConfigWithProxyFunc(effectiveConfig)
	if proxyErr != nil {
		wrapped := wrapConnectError(effectiveConfig, proxyErr)
		logger.Error(wrapped, "Redis 代理准备失败：%s", formatRedisConnSummary(effectiveConfig))
		return nil, wrapped
	}

	key := getRedisClientCacheKey(connectConfig)
	shortKey := key
	if len(shortKey) > 12 {
		shortKey = shortKey[:12]
	}
	logger.Infof("获取 Redis 连接：%s 缓存Key=%s", formatRedisConnSummary(effectiveConfig), shortKey)

	redisCacheMu.Lock()
	defer redisCacheMu.Unlock()

	if client, ok := redisCache[key]; ok {
		logger.Infof("命中 Redis 连接缓存，开始检测可用性：缓存Key=%s", shortKey)
		if err := client.Ping(); err == nil {
			logger.Infof("缓存 Redis 连接可用：缓存Key=%s", shortKey)
			return client, nil
		} else {
			logger.Error(err, "缓存 Redis 连接不可用，准备重建：缓存Key=%s", shortKey)
		}
		client.Close()
		delete(redisCache, key)
		delete(redisCacheConfigs, key)
	}

	logger.Infof("创建 Redis 客户端实例：缓存Key=%s", shortKey)
	client, connectedConfig, connectErr := connectRedisClientWithLegacyRootFallback(connectConfig)
	if connectErr != nil {
		wrapped := wrapConnectError(connectedConfig, connectErr)
		logger.Error(wrapped, "Redis 连接失败：%s 缓存Key=%s", formatRedisConnSummary(connectedConfig), shortKey)
		return nil, wrapped
	}

	redisCache[key] = client
	redisCacheConfigs[key] = normalizeCacheKeyConfig(connectedConfig)
	logger.Infof("Redis 连接成功并写入缓存：%s 缓存Key=%s", formatRedisConnSummary(connectedConfig), shortKey)
	return client, nil
}

func (a *App) openRedisClientIsolated(config connection.ConnectionConfig) (redis.RedisClient, error) {
	resolvedConfig, err := a.resolveConnectionSecrets(config)
	if err != nil {
		wrapped := wrapConnectError(config, err)
		logger.Error(wrapped, "Redis 密文解析失败：%s", formatRedisConnSummary(config))
		return nil, wrapped
	}

	effectiveConfig := a.withManagedSSHHostKeyTrustStore(resolvedConfig)
	connectConfig, proxyErr := resolveDialConfigWithProxyFunc(effectiveConfig)
	if proxyErr != nil {
		wrapped := wrapConnectError(effectiveConfig, proxyErr)
		logger.Error(wrapped, "Redis 代理准备失败：%s", formatRedisConnSummary(effectiveConfig))
		return nil, wrapped
	}

	client, connectedConfig, connectErr := connectRedisClientWithLegacyRootFallback(connectConfig)
	if connectErr != nil {
		wrapped := wrapConnectError(connectedConfig, connectErr)
		logger.Error(wrapped, "Redis 临时连接失败：%s", formatRedisConnSummary(connectedConfig))
		return nil, wrapped
	}
	return client, nil
}

func connectRedisClientWithLegacyRootFallback(config connection.ConnectionConfig) (redis.RedisClient, connection.ConnectionConfig, error) {
	client := newRedisClientFunc()
	if err := client.Connect(config); err == nil {
		return client, config, nil
	} else {
		client.Close()
		if !shouldRetryRedisWithClearedLegacyRoot(config, err) {
			return nil, config, err
		}

		fallbackConfig := config
		fallbackConfig.User = ""
		logger.Warnf("Redis 使用用户名 root 认证失败，已按历史默认值回退为空用户名重试：%s", formatRedisConnSummary(config))

		fallbackClient := newRedisClientFunc()
		if retryErr := fallbackClient.Connect(fallbackConfig); retryErr != nil {
			fallbackClient.Close()
			return nil, fallbackConfig, retryErr
		}
		return fallbackClient, fallbackConfig, nil
	}
}

func shouldRetryRedisWithClearedLegacyRoot(config connection.ConnectionConfig, err error) bool {
	if err == nil || strings.ToLower(strings.TrimSpace(config.Type)) != "redis" {
		return false
	}
	if strings.TrimSpace(config.User) != "root" {
		return false
	}
	if _, ok := extractExplicitRedisUsername(config.URI); ok {
		return false
	}

	lower := strings.ToLower(strings.TrimSpace(err.Error()))
	return strings.Contains(lower, "wrongpass") ||
		strings.Contains(lower, "invalid username-password pair") ||
		strings.Contains(lower, "auth failed") ||
		strings.Contains(lower, "wrong number of arguments for 'auth' command") ||
		strings.Contains(lower, "authentication failed")
}

func extractExplicitRedisUsername(rawURI string) (string, bool) {
	trimmed := strings.TrimSpace(rawURI)
	if trimmed == "" {
		return "", false
	}

	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.User == nil {
		return "", false
	}

	username := strings.TrimSpace(parsed.User.Username())
	if username == "" {
		return "", false
	}
	return username, true
}

func getRedisClientCacheKey(config connection.ConnectionConfig) string {
	normalized := normalizeCacheKeyConfig(config)
	b, _ := json.Marshal(normalized)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func (a *App) releaseRedisClientsForConfig(config connection.ConnectionConfig) (int, error) {
	resolvedConfig, err := a.resolveConnectionSecrets(config)
	if err != nil {
		return 0, wrapConnectError(config, err)
	}
	targetKey := getConnectionReleaseMatchKey(resolvedConfig)
	closed := 0

	redisCacheMu.Lock()
	defer redisCacheMu.Unlock()

	for key, client := range redisCache {
		entryConfig := redisCacheConfigs[key]
		if strings.TrimSpace(entryConfig.Type) == "" {
			continue
		}
		if getConnectionReleaseMatchKey(entryConfig) != targetKey {
			continue
		}
		if client != nil {
			client.Close()
		}
		delete(redisCache, key)
		delete(redisCacheConfigs, key)
		closed++
	}
	return closed, nil
}

func formatRedisConnSummary(config connection.ConnectionConfig) string {
	var b strings.Builder
	b.WriteString("类型=redis 地址=")
	b.WriteString(config.Host)
	b.WriteString(":")
	b.WriteString(strconv.Itoa(config.Port))
	if topology := strings.TrimSpace(config.Topology); topology != "" {
		b.WriteString(" 模式=")
		b.WriteString(topology)
	}
	if len(config.Hosts) > 0 {
		b.WriteString(" 节点数=")
		b.WriteString(strconv.Itoa(len(config.Hosts)))
	}
	b.WriteString(" DB=")
	b.WriteString(strconv.Itoa(config.RedisDB))

	if config.UseSSH {
		b.WriteString(" SSH=")
		b.WriteString(config.SSH.Host)
		b.WriteString(":")
		b.WriteString(strconv.Itoa(config.SSH.Port))
		b.WriteString(" 用户=")
		b.WriteString(config.SSH.User)
	}
	if config.UseProxy {
		b.WriteString(" 代理=")
		b.WriteString(strings.ToLower(strings.TrimSpace(config.Proxy.Type)))
		b.WriteString("://")
		b.WriteString(config.Proxy.Host)
		b.WriteString(":")
		b.WriteString(strconv.Itoa(config.Proxy.Port))
		if strings.TrimSpace(config.Proxy.User) != "" {
			b.WriteString(" 代理认证=已配置")
		}
	}
	if config.UseHTTPTunnel {
		b.WriteString(" HTTP隧道=")
		b.WriteString(strings.TrimSpace(config.HTTPTunnel.Host))
		b.WriteString(":")
		b.WriteString(strconv.Itoa(config.HTTPTunnel.Port))
		if strings.TrimSpace(config.HTTPTunnel.User) != "" {
			b.WriteString(" HTTP隧道认证=已配置")
		}
	}

	return b.String()
}

// CloseAllRedisClients closes all cached Redis clients (called on shutdown)
func CloseAllRedisClients() {
	redisCacheMu.Lock()
	defer redisCacheMu.Unlock()

	for key, client := range redisCache {
		if client != nil {
			client.Close()
			logger.Infof("已关闭 Redis 连接：%s", key[:12])
		}
	}
	redisCache = make(map[string]redis.RedisClient)
	redisCacheConfigs = make(map[string]connection.ConnectionConfig)
}
