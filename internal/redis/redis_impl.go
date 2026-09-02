package redis

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"math"
	"math/big"
	"net"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

var (
	ErrRedisKeyGone         = errors.New("Redis Key 不存在或已过期")
	ErrRedisListItemChanged = errors.New("Redis 列表项已变化，请刷新后重试")
)

// RedisClientImpl implements RedisClient using go-redis
type RedisClientImpl struct {
	client        redis.UniversalClient
	singleClient  *redis.Client
	clusterClient *redis.ClusterClient
	config        connection.ConnectionConfig
	currentDB     int
	isCluster     bool
	seedAddrs     []string
	forwarder     *ssh.LocalForwarder
}

const (
	redisDefaultDatabaseCount         = 16
	redisClusterLogicalDBCount        = 16
	redisScanDefaultTargetCount int64 = 2000
	redisScanMaxTargetCount     int64 = 10000
	redisKeyScanMinStepCount    int64 = 100
	redisScanMaxStepCount       int64 = 2000
	redisHashScanStepCount      int64 = 200
	redisScanMaxRounds                = 64
	redisScanMaxDuration              = 12 * time.Second
	redisSearchMaxTargetCount   int64 = 1000
	redisSearchMaxStepCount     int64 = 1000
	redisSearchMaxResultCount         = 10000
	redisSearchMaxDuration            = 3 * time.Second
	redisListRemoveAtScript           = `
local current = redis.call("LINDEX", KEYS[1], ARGV[1])
if current == false or current ~= ARGV[2] then
    return 0
end
redis.call("LSET", KEYS[1], ARGV[1], ARGV[3])
local removed = redis.pcall("LREM", KEYS[1], 1, ARGV[3])
if type(removed) == "table" and removed.err then
    local restored = redis.pcall("LSET", KEYS[1], ARGV[1], ARGV[2])
    if type(restored) == "table" and restored.err then
        return redis.error_reply(removed.err .. "; rollback failed: " .. restored.err)
    end
    return redis.error_reply(removed.err)
end
if removed ~= 1 then
    local restored = redis.pcall("LSET", KEYS[1], ARGV[1], ARGV[2])
    if type(restored) == "table" and restored.err then
        return redis.error_reply("Redis list delete rollback failed: " .. restored.err)
    end
    return -1
end
return 1
`
)

var redisDBSwitchConnect = func(client *RedisClientImpl, config connection.ConnectionConfig) error {
	return client.Connect(config)
}

// NewRedisClient creates a new Redis client instance
func NewRedisClient() RedisClient {
	return &RedisClientImpl{}
}

func normalizeRedisTimeout(timeoutSeconds int) time.Duration {
	if timeoutSeconds <= 0 {
		return 30 * time.Second
	}
	return time.Duration(timeoutSeconds) * time.Second
}

func normalizeRedisSeedAddress(raw string, defaultPort int) (string, error) {
	addr := strings.TrimSpace(raw)
	if addr == "" {
		return "", localizedRedisBackendError("redis.backend.error.node_address_required", nil)
	}

	if host, port, err := net.SplitHostPort(addr); err == nil {
		host = strings.TrimSpace(host)
		port = strings.TrimSpace(port)
		if host == "" {
			return "", localizedRedisBackendError("redis.backend.error.invalid_node_address", map[string]any{"address": addr})
		}
		if _, err := strconv.Atoi(port); err != nil {
			return "", localizedRedisBackendError("redis.backend.error.invalid_port", map[string]any{"address": addr})
		}
		return net.JoinHostPort(host, port), nil
	}

	if !strings.Contains(addr, ":") {
		return net.JoinHostPort(addr, strconv.Itoa(defaultPort)), nil
	}

	// 尝试兼容 host:port 但端口格式异常的场景。
	host, port, ok := strings.Cut(addr, ":")
	if !ok {
		return "", localizedRedisBackendError("redis.backend.error.invalid_node_address", map[string]any{"address": addr})
	}
	host = strings.TrimSpace(host)
	port = strings.TrimSpace(port)
	if host == "" {
		return "", localizedRedisBackendError("redis.backend.error.invalid_node_address", map[string]any{"address": addr})
	}
	if _, err := strconv.Atoi(port); err != nil {
		return "", localizedRedisBackendError("redis.backend.error.invalid_port", map[string]any{"address": addr})
	}
	return net.JoinHostPort(host, port), nil
}

func buildRedisSeedAddrs(config connection.ConnectionConfig) ([]string, error) {
	defaultPort := config.Port
	if defaultPort <= 0 {
		defaultPort = 6379
	}

	candidates := make([]string, 0, 1+len(config.Hosts))
	if strings.TrimSpace(config.Host) != "" {
		candidates = append(candidates, fmt.Sprintf("%s:%d", strings.TrimSpace(config.Host), defaultPort))
	}
	candidates = append(candidates, config.Hosts...)

	seen := make(map[string]struct{}, len(candidates))
	addrs := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		normalized, err := normalizeRedisSeedAddress(candidate, defaultPort)
		if err != nil {
			return nil, err
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		addrs = append(addrs, normalized)
	}
	if len(addrs) == 0 {
		return nil, localizedRedisBackendError("redis.backend.error.address_required", nil)
	}
	return addrs, nil
}

func redisTopologyDisplayName(topology string) string {
	switch strings.ToLower(strings.TrimSpace(topology)) {
	case "sentinel":
		return localizedRedisBackendText("redis.backend.label.topology_sentinel", nil)
	case "cluster":
		return localizedRedisBackendText("redis.backend.label.topology_cluster", nil)
	default:
		return localizedRedisBackendText("redis.backend.label.topology_multi_node", nil)
	}
}

func redisConnectAttemptFailureMessage(key string, attempt int, detail any) string {
	return localizedRedisBackendText(key, map[string]any{
		"attempt": attempt,
		"detail":  strings.TrimSpace(fmt.Sprint(detail)),
	})
}

func joinRedisFailures(failures []string) string {
	return strings.Join(failures, "; ")
}

func (r *RedisClientImpl) redisNamespacePrefixForDB(index int) string {
	if !r.isCluster || index <= 0 {
		return ""
	}
	// Redis Cluster 仅支持物理 db0；这里用固定前缀模拟逻辑库隔离。
	return fmt.Sprintf("__gonavi_db_%d__:", index)
}

func (r *RedisClientImpl) redisNamespacePrefix() string {
	return r.redisNamespacePrefixForDB(r.currentDB)
}

func (r *RedisClientImpl) toPhysicalKey(key string) string {
	trimmed := strings.TrimSpace(key)
	if trimmed == "" {
		return ""
	}
	prefix := r.redisNamespacePrefix()
	if prefix == "" || strings.HasPrefix(trimmed, prefix) {
		return trimmed
	}
	return prefix + trimmed
}

func (r *RedisClientImpl) toPhysicalPattern(pattern string) string {
	normalized := strings.TrimSpace(pattern)
	if normalized == "" {
		normalized = "*"
	}
	prefix := r.redisNamespacePrefix()
	if prefix == "" {
		return normalized
	}
	return prefix + normalized
}

func redisGlobPatternLiteralKey(pattern string) (string, bool) {
	if pattern == "" {
		return "", false
	}

	var builder strings.Builder
	for i := 0; i < len(pattern); i++ {
		char := pattern[i]
		if char == '\\' {
			if i+1 >= len(pattern) {
				return "", false
			}
			i++
			builder.WriteByte(pattern[i])
			continue
		}
		if char == '*' || char == '?' || char == '[' {
			return "", false
		}
		builder.WriteByte(char)
	}
	return builder.String(), true
}

func escapeRedisGlobLiteral(value string) string {
	var builder strings.Builder
	for i := 0; i < len(value); i++ {
		char := value[i]
		if char == '*' || char == '?' || char == '[' || char == ']' || char == '\\' {
			builder.WriteByte('\\')
		}
		builder.WriteByte(char)
	}
	return builder.String()
}

func redisExactSearchPattern(literalKey string) (string, string) {
	return literalKey, escapeRedisGlobLiteral(literalKey) + ":*"
}

func (r *RedisClientImpl) toPhysicalKeys(keys []string) []string {
	if len(keys) == 0 {
		return nil
	}
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		physical := r.toPhysicalKey(key)
		if physical == "" {
			continue
		}
		result = append(result, physical)
	}
	return result
}

func (r *RedisClientImpl) toDisplayKey(key string) string {
	prefix := r.redisNamespacePrefix()
	if prefix == "" {
		return key
	}
	return strings.TrimPrefix(key, prefix)
}

// sanitizeRedisPassword 对 Redis 密码进行防御性 URL 解码。
// 当密码中包含 URL 编码序列（如 %40）时，尝试解码还原原始字符。
// 这可以防止前端 URI 构建中 encodeURIComponent 编码后的密码被误传入。
func sanitizeRedisPassword(password string) string {
	if password == "" {
		return password
	}
	// 仅当密码中包含 '%' 且后跟两位十六进制数字时，才尝试 URL 解码
	if !strings.Contains(password, "%") {
		return password
	}
	decoded, err := url.QueryUnescape(password)
	if err != nil {
		// 解码失败，使用原始密码
		return password
	}
	if decoded != password {
		logger.Warnf("Redis 密码检测到 URL 编码，已自动解码（原长度=%d 解码后长度=%d）", len(password), len(decoded))
	}
	return decoded
}

// Connect establishes a connection to Redis
func (r *RedisClientImpl) Connect(config connection.ConnectionConfig) (err error) {
	_ = r.Close()
	defer func() {
		if err != nil {
			_ = r.Close()
		}
	}()

	config.Password = sanitizeRedisPassword(config.Password)
	config.RedisSentinelPassword = sanitizeRedisPassword(config.RedisSentinelPassword)
	r.config = config
	if r.config.RedisDB < 0 {
		r.config.RedisDB = 0
	}
	seedAddrs, err := buildRedisSeedAddrs(config)
	if err != nil {
		return err
	}
	r.seedAddrs = append([]string(nil), seedAddrs...)

	topology := strings.ToLower(strings.TrimSpace(config.Topology))
	isSentinel := topology == "sentinel"
	r.isCluster = !isSentinel && (topology == "cluster" || len(seedAddrs) > 1)
	if r.isCluster && r.config.RedisDB >= redisClusterLogicalDBCount {
		r.config.RedisDB = 0
	}
	r.currentDB = r.config.RedisDB

	if (r.isCluster || isSentinel) && config.UseSSH {
		return localizedRedisBackendError("redis.backend.error.topology_ssh_tunnel_unsupported", map[string]any{
			"topology": redisTopologyDisplayName(topology),
		})
	}

	timeout := normalizeRedisTimeout(config.Timeout)
	if isSentinel {
		masterName := strings.TrimSpace(config.RedisSentinelMaster)
		if masterName == "" {
			return localizedRedisBackendError("redis.backend.error.sentinel_master_required", nil)
		}
		attempts := []connection.ConnectionConfig{config}
		if shouldTryRedisSSLPreferredFallback(config) {
			attempts = append(attempts, withRedisSSLDisabled(config))
		}

		var failures []string
		for idx, attempt := range attempts {
			var tlsConfig *tls.Config
			if cfg, err := resolveRedisTLSConfig(attempt); err != nil {
				failures = append(failures, redisConnectAttemptFailureMessage("redis.backend.error.connect_tls_setup_failed", idx+1, err))
				continue
			} else if cfg != nil {
				if host, _, err := net.SplitHostPort(seedAddrs[0]); err == nil && host != "" {
					cfg.ServerName = host
				}
				tlsConfig = cfg
			}
			opts := &redis.FailoverOptions{
				MasterName:       masterName,
				SentinelAddrs:    seedAddrs,
				Username:         strings.TrimSpace(attempt.User),
				Password:         attempt.Password,
				SentinelUsername: strings.TrimSpace(attempt.RedisSentinelUser),
				SentinelPassword: attempt.RedisSentinelPassword,
				DB:               r.currentDB,
				DialTimeout:      timeout,
				ReadTimeout:      timeout,
				WriteTimeout:     timeout,
				TLSConfig:        tlsConfig,
			}
			sentinelClient := redis.NewFailoverClient(opts)
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			pingErr := sentinelClient.Ping(ctx).Err()
			cancel()
			if pingErr != nil {
				sentinelClient.Close()
				failures = append(failures, redisConnectAttemptFailureMessage("redis.backend.error.connect_attempt_failed", idx+1, pingErr))
				continue
			}
			r.client = sentinelClient
			r.singleClient = sentinelClient
			r.config = attempt
			if idx > 0 {
				logger.Warnf("Redis Sentinel SSL 优先连接失败，已回退至明文连接")
			}
			logger.Infof("Redis Sentinel 连接成功: sentinels=%s master=%s DB=%d", strings.Join(seedAddrs, ","), masterName, r.currentDB)
			return nil
		}
		return localizedRedisBackendError("redis.backend.error.sentinel_connect_failed", map[string]any{
			"detail": joinRedisFailures(failures),
		})
	}

	if r.isCluster {
		attempts := []connection.ConnectionConfig{config}
		if shouldTryRedisSSLPreferredFallback(config) {
			attempts = append(attempts, withRedisSSLDisabled(config))
		}

		var failures []string
		for idx, attempt := range attempts {
			var tlsConfig *tls.Config
			if cfg, err := resolveRedisTLSConfig(attempt); err != nil {
				failures = append(failures, redisConnectAttemptFailureMessage("redis.backend.error.connect_tls_setup_failed", idx+1, err))
				continue
			} else if cfg != nil {
				if host, _, err := net.SplitHostPort(seedAddrs[0]); err == nil && host != "" {
					cfg.ServerName = host
				}
				tlsConfig = cfg
			}
			opts := &redis.ClusterOptions{
				Addrs:                 seedAddrs,
				Username:              strings.TrimSpace(attempt.User),
				Password:              attempt.Password,
				DialTimeout:           timeout,
				ReadTimeout:           timeout,
				WriteTimeout:          timeout,
				ContextTimeoutEnabled: true,
				TLSConfig:             tlsConfig,
			}
			clusterClient := redis.NewClusterClient(opts)
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			pingErr := clusterClient.Ping(ctx).Err()
			cancel()
			if pingErr != nil {
				clusterClient.Close()
				failures = append(failures, redisConnectAttemptFailureMessage("redis.backend.error.connect_attempt_failed", idx+1, pingErr))
				continue
			}
			r.client = clusterClient
			r.clusterClient = clusterClient
			r.config = attempt
			if idx > 0 {
				logger.Warnf("Redis 集群 SSL 优先连接失败，已回退至明文连接")
			}
			logger.Infof("Redis 集群连接成功: seeds=%s 逻辑库=db%d", strings.Join(seedAddrs, ","), r.currentDB)
			return nil
		}
		return localizedRedisBackendError("redis.backend.error.cluster_connect_failed", map[string]any{
			"detail": joinRedisFailures(failures),
		})
	}

	addr := seedAddrs[0]
	if config.UseSSH {
		forwarder, err := ssh.AcquireLocalForwarder(config.SSH, config.Host, config.Port)
		if err != nil {
			return localizedRedisBackendErrorWithCause("redis.backend.error.ssh_tunnel_create_failed", map[string]any{
				"detail": err.Error(),
			}, err)
		}
		r.forwarder = forwarder
		addr = forwarder.LocalAddr
		logger.Infof("Redis 通过 SSH 隧道连接: %s -> %s:%d", addr, config.Host, config.Port)
	}

	attempts := []connection.ConnectionConfig{config}
	if shouldTryRedisSSLPreferredFallback(config) {
		attempts = append(attempts, withRedisSSLDisabled(config))
	}

	var failures []string
	for idx, attempt := range attempts {
		var tlsConfig *tls.Config
		if cfg, err := resolveRedisTLSConfig(attempt); err != nil {
			failures = append(failures, redisConnectAttemptFailureMessage("redis.backend.error.connect_tls_setup_failed", idx+1, err))
			continue
		} else if cfg != nil {
			if host, _, err := net.SplitHostPort(addr); err == nil && host != "" {
				cfg.ServerName = host
			}
			tlsConfig = cfg
		}

		opts := &redis.Options{
			Addr:         addr,
			Username:     strings.TrimSpace(attempt.User),
			Password:     attempt.Password,
			DB:           r.currentDB,
			DialTimeout:  timeout,
			ReadTimeout:  timeout,
			WriteTimeout: timeout,
			TLSConfig:    tlsConfig,
		}

		singleClient := redis.NewClient(opts)
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		pingErr := singleClient.Ping(ctx).Err()
		cancel()
		if pingErr != nil {
			singleClient.Close()
			failures = append(failures, redisConnectAttemptFailureMessage("redis.backend.error.connect_attempt_failed", idx+1, pingErr))
			continue
		}

		r.client = singleClient
		r.singleClient = singleClient
		r.config = attempt
		if idx > 0 {
			logger.Warnf("Redis SSL 优先连接失败，已回退至明文连接")
		}
		logger.Infof("Redis 连接成功: %s DB=%d", addr, r.currentDB)
		return nil
	}

	return localizedRedisBackendError("redis.backend.error.connect_failed", map[string]any{
		"detail": joinRedisFailures(failures),
	})
}

// Close closes the Redis connection
func (r *RedisClientImpl) Close() error {
	var firstErr error
	if r.client != nil {
		firstErr = r.client.Close()
	}
	r.client = nil
	r.singleClient = nil
	r.clusterClient = nil
	r.isCluster = false
	r.seedAddrs = nil
	if r.forwarder != nil {
		if err := r.forwarder.Release(); err != nil && firstErr == nil {
			firstErr = err
		}
		r.forwarder = nil
	}
	return firstErr
}

// Ping tests the connection
func (r *RedisClientImpl) Ping() error {
	if r.client == nil {
		return fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return r.client.Ping(ctx).Err()
}

// ScanKeys scans keys matching a pattern
func (r *RedisClientImpl) ScanKeys(pattern string, cursor uint64, count int64) (*RedisScanResult, error) {
	if r.client == nil {
		return nil, fmt.Errorf("Redis 客户端未连接")
	}

	if pattern == "" {
		pattern = "*"
	}
	exactPhysicalKey := ""
	isExactPattern := false
	if literalKey, ok := redisGlobPatternLiteralKey(pattern); ok {
		isExactPattern = true
		exactKey, namespacePattern := redisExactSearchPattern(literalKey)
		exactPhysicalKey = r.toPhysicalKey(exactKey)
		if exactPhysicalKey == "" {
			return &RedisScanResult{Keys: []RedisKeyInfo{}, Cursor: "0"}, nil
		}
		pattern = namespacePattern
	}
	physicalPattern := r.toPhysicalPattern(pattern)

	isSearchPattern := pattern != "*"
	targetCount := normalizeRedisScanTargetCount(count)
	scanStepCount := normalizeRedisScanStepCount(targetCount)
	maxRounds := redisScanMaxRounds
	maxDuration := redisScanMaxDuration
	if isSearchPattern {
		if targetCount > redisSearchMaxTargetCount {
			targetCount = redisSearchMaxTargetCount
		}
		if scanStepCount > redisSearchMaxStepCount {
			scanStepCount = redisSearchMaxStepCount
		}
		// SCAN MATCH 可能连续返回空批次，但后续 cursor 页仍然存在匹配 key。
		// 搜索模式不使用固定轮数限制，改由 maxDuration 和 targetCount 兜底。
		maxRounds = 0
		maxDuration = redisSearchMaxDuration
	}

	ctx, cancel := context.WithTimeout(metadataContextFor(r), maxDuration+5*time.Second)
	defer cancel()

	// 集群模式：逐 master 节点 SCAN 后合并去重
	if r.isCluster && r.clusterClient != nil {
		if isSearchPattern && !isExactPattern {
			searchCtx, searchCancel := context.WithTimeout(metadataContextFor(r), maxDuration)
			defer searchCancel()

			keys := make([]string, 0, int(targetCount))
			seen := make(map[string]struct{}, int(targetCount))
			var mu sync.Mutex
			if exactPhysicalKey != "" {
				exists, err := r.client.Exists(searchCtx, exactPhysicalKey).Result()
				if err != nil {
					return nil, fmt.Errorf("Redis 集群搜索检查精确 Key 失败: %w", err)
				}
				if exists > 0 {
					keys = append(keys, exactPhysicalKey)
					seen[exactPhysicalKey] = struct{}{}
				}
			}

			err := r.clusterClient.ForEachMaster(searchCtx, func(nodeCtx context.Context, node *redis.Client) error {
				var nodeCursor uint64
				for {
					batch, nextCursor, err := node.Scan(nodeCtx, nodeCursor, physicalPattern, scanStepCount).Result()
					if err != nil {
						searchCancel()
						return err
					}

					mu.Lock()
					for _, key := range batch {
						if _, ok := seen[key]; ok {
							continue
						}
						if len(keys) >= redisSearchMaxResultCount {
							mu.Unlock()
							searchCancel()
							return fmt.Errorf("Redis 集群搜索结果超过安全上限 %d", redisSearchMaxResultCount)
						}
						seen[key] = struct{}{}
						keys = append(keys, key)
					}
					mu.Unlock()

					nodeCursor = nextCursor
					if nodeCursor == 0 {
						return nil
					}
				}
			})
			if err != nil {
				return nil, fmt.Errorf("Redis 集群搜索未完成: %w", err)
			}

			keyInfos, err := r.loadRedisKeyInfosStrict(searchCtx, keys)
			if err != nil {
				return nil, fmt.Errorf("Redis 集群搜索读取 Key 元数据失败: %w", err)
			}
			return &RedisScanResult{Keys: keyInfos, Cursor: "0"}, nil
		}

		keys := make([]string, 0, int(targetCount))
		seen := make(map[string]struct{}, int(targetCount))
		var mu sync.Mutex
		if exactPhysicalKey != "" {
			keys = append(keys, exactPhysicalKey)
			seen[exactPhysicalKey] = struct{}{}
		}

		err := r.clusterClient.ForEachMaster(ctx, func(nodeCtx context.Context, node *redis.Client) error {
			var nodeCursor uint64
			round := 0
			scanStartedAt := time.Now()
			for {
				if time.Since(scanStartedAt) >= maxDuration {
					break
				}
				mu.Lock()
				enough := len(keys) >= int(targetCount)
				mu.Unlock()
				if enough {
					break
				}

				batch, nextCursor, err := node.Scan(nodeCtx, nodeCursor, physicalPattern, scanStepCount).Result()
				if err != nil {
					return err
				}

				mu.Lock()
				for _, key := range batch {
					if _, ok := seen[key]; ok {
						continue
					}
					seen[key] = struct{}{}
					keys = append(keys, key)
					if len(keys) >= int(targetCount) {
						break
					}
				}
				mu.Unlock()

				nodeCursor = nextCursor
				round++
				if nodeCursor == 0 || (maxRounds > 0 && round >= maxRounds) {
					break
				}
			}
			return nil
		})
		if err != nil {
			return nil, err
		}

		// 集群模式 cursor 无意义，始终返回 "0" 表示扫描完成
		return &RedisScanResult{
			Keys:   r.loadRedisKeyInfos(ctx, keys),
			Cursor: "0",
		}, nil
	}

	// 非集群模式：原逻辑
	currentCursor := cursor
	round := 0
	scanStartedAt := time.Now()

	keys := make([]string, 0, int(targetCount))
	seen := make(map[string]struct{}, int(targetCount))
	if exactPhysicalKey != "" && currentCursor == 0 {
		keys = append(keys, exactPhysicalKey)
		seen[exactPhysicalKey] = struct{}{}
	}

	for len(keys) < int(targetCount) {
		if time.Since(scanStartedAt) >= maxDuration {
			break
		}

		batch, nextCursor, err := r.client.Scan(ctx, currentCursor, physicalPattern, scanStepCount).Result()
		if err != nil {
			return nil, err
		}

		for _, key := range batch {
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			keys = append(keys, key)
		}

		currentCursor = nextCursor
		round++
		if currentCursor == 0 || (maxRounds > 0 && round >= maxRounds) {
			break
		}
	}

	return &RedisScanResult{
		Keys:   r.loadRedisKeyInfos(ctx, keys),
		Cursor: strconv.FormatUint(currentCursor, 10),
	}, nil
}

func normalizeRedisScanTargetCount(count int64) int64 {
	if count <= 0 {
		return redisScanDefaultTargetCount
	}
	if count > redisScanMaxTargetCount {
		return redisScanMaxTargetCount
	}
	return count
}

func normalizeRedisScanStepCount(targetCount int64) int64 {
	if targetCount < redisKeyScanMinStepCount {
		return redisKeyScanMinStepCount
	}
	if targetCount > redisScanMaxStepCount {
		return redisScanMaxStepCount
	}
	return targetCount
}

func (r *RedisClientImpl) loadRedisKeyInfosStrict(ctx context.Context, keys []string) ([]RedisKeyInfo, error) {
	result := make([]RedisKeyInfo, 0, len(keys))
	if len(keys) == 0 {
		return result, nil
	}

	pipe := r.client.Pipeline()
	typeResults := make([]*redis.StatusCmd, len(keys))
	ttlResults := make([]*redis.DurationCmd, len(keys))
	for i, key := range keys {
		typeResults[i] = pipe.Type(ctx, key)
		ttlResults[i] = pipe.TTL(ctx, key)
	}
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		return nil, err
	}

	for i, key := range keys {
		keyType, err := typeResults[i].Result()
		if err != nil && err != redis.Nil {
			return nil, err
		}
		ttlValue, err := ttlResults[i].Result()
		if err != nil && err != redis.Nil {
			return nil, err
		}
		ttlSeconds := toRedisTTLSeconds(ttlValue)
		if isRedisKeyGone(keyType, ttlSeconds) {
			continue
		}
		result = append(result, RedisKeyInfo{
			Key:  r.toDisplayKey(key),
			Type: keyType,
			TTL:  ttlSeconds,
		})
	}
	return result, nil
}

func (r *RedisClientImpl) loadRedisKeyInfos(ctx context.Context, keys []string) []RedisKeyInfo {
	result := make([]RedisKeyInfo, 0, len(keys))
	if len(keys) == 0 {
		return result
	}

	pipe := r.client.Pipeline()
	typeResults := make([]*redis.StatusCmd, len(keys))
	ttlResults := make([]*redis.DurationCmd, len(keys))

	for i, key := range keys {
		typeResults[i] = pipe.Type(ctx, key)
		ttlResults[i] = pipe.TTL(ctx, key)
	}

	_, err := pipe.Exec(ctx)
	if err != nil && err != redis.Nil {
		for _, key := range keys {
			keyType, typeErr := r.client.Type(ctx, key).Result()
			if typeErr != nil && typeErr != redis.Nil {
				keyType = ""
			}
			ttlValue, ttlErr := r.client.TTL(ctx, key).Result()
			if ttlErr != nil && ttlErr != redis.Nil {
				ttlValue = -2
			}
			ttlSeconds := toRedisTTLSeconds(ttlValue)
			if isRedisKeyGone(keyType, ttlSeconds) {
				continue
			}
			result = append(result, RedisKeyInfo{
				Key:  r.toDisplayKey(key),
				Type: keyType,
				TTL:  ttlSeconds,
			})
		}
		return result
	}

	for i, key := range keys {
		keyType := typeResults[i].Val()
		ttlSeconds := toRedisTTLSeconds(ttlResults[i].Val())
		if isRedisKeyGone(keyType, ttlSeconds) {
			continue
		}
		result = append(result, RedisKeyInfo{
			Key:  r.toDisplayKey(key),
			Type: keyType,
			TTL:  ttlSeconds,
		})
	}
	return result
}

func toRedisTTLSeconds(ttl time.Duration) int64 {
	if ttl == -1 {
		return -1
	}
	if ttl == -2 {
		return -2
	}
	return int64(ttl.Seconds())
}

func isRedisKeyGone(keyType string, ttl int64) bool {
	return keyType == "none" || ttl == -2
}

func normalizeRedisGetValueError(keyType string, ttl int64) error {
	if isRedisKeyGone(keyType, ttl) {
		return ErrRedisKeyGone
	}
	return nil
}

// GetKeyType returns the type of a key
func (r *RedisClientImpl) GetKeyType(key string) (string, error) {
	if r.client == nil {
		return "", fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(metadataContextFor(r), 5*time.Second)
	defer cancel()
	return r.client.Type(ctx, r.toPhysicalKey(key)).Result()
}

// GetTTL returns the TTL of a key in seconds
func (r *RedisClientImpl) GetTTL(key string) (int64, error) {
	if r.client == nil {
		return 0, fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(metadataContextFor(r), 5*time.Second)
	defer cancel()

	ttl, err := r.client.TTL(ctx, r.toPhysicalKey(key)).Result()
	if err != nil {
		return 0, err
	}

	if ttl == -1 {
		return -1, nil // No expiry
	} else if ttl == -2 {
		return -2, nil // Key doesn't exist
	}
	return int64(ttl.Seconds()), nil
}

// SetTTL sets the TTL of a key
func (r *RedisClientImpl) SetTTL(key string, ttl int64) error {
	if r.client == nil {
		return fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if ttl < 0 {
		// Remove expiry
		return r.client.Persist(ctx, r.toPhysicalKey(key)).Err()
	}
	return r.client.Expire(ctx, r.toPhysicalKey(key), time.Duration(ttl)*time.Second).Err()
}

// DeleteKeys deletes one or more keys
func (r *RedisClientImpl) DeleteKeys(keys []string) (int64, error) {
	if r.client == nil {
		return 0, fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	physicalKeys := r.toPhysicalKeys(keys)
	if len(physicalKeys) == 0 {
		return 0, nil
	}
	return r.client.Del(ctx, physicalKeys...).Result()
}

// RenameKey renames a key
func (r *RedisClientImpl) RenameKey(oldKey, newKey string) error {
	if r.client == nil {
		return fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return r.client.Rename(ctx, r.toPhysicalKey(oldKey), r.toPhysicalKey(newKey)).Err()
}

// KeyExists checks if a key exists
func (r *RedisClientImpl) KeyExists(key string) (bool, error) {
	if r.client == nil {
		return false, fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	n, err := r.client.Exists(ctx, r.toPhysicalKey(key)).Result()
	return n > 0, err
}

// GetValue gets the value of a key with automatic type detection
func (r *RedisClientImpl) GetValue(key string) (*RedisValue, error) {
	if r.client == nil {
		return nil, fmt.Errorf("Redis 客户端未连接")
	}

	keyType, err := r.GetKeyType(key)
	if err != nil {
		return nil, err
	}

	ttl, _ := r.GetTTL(key)
	if err := normalizeRedisGetValueError(keyType, ttl); err != nil {
		return nil, err
	}
	physicalKey := r.toPhysicalKey(key)

	result := &RedisValue{
		Type: keyType,
		TTL:  ttl,
	}

	ctx, cancel := context.WithTimeout(metadataContextFor(r), 30*time.Second)
	defer cancel()

	switch keyType {
	case "string":
		val, err := r.client.Get(ctx, physicalKey).Result()
		if err != nil {
			return nil, err
		}
		result.Value = val
		result.Length = int64(len(val))

	case "hash":
		val, length, err := r.readHashEntries(ctx, physicalKey)
		if err != nil {
			return nil, err
		}
		result.Value = val
		result.Length = length

	case "list":
		length, err := r.client.LLen(ctx, physicalKey).Result()
		if err != nil {
			return nil, err
		}
		// Get first 1000 items
		limit := int64(1000)
		if length < limit {
			limit = length
		}
		val, err := r.client.LRange(ctx, physicalKey, 0, limit-1).Result()
		if err != nil {
			return nil, err
		}
		result.Value = val
		result.Length = length

	case "set":
		length, err := r.client.SCard(ctx, physicalKey).Result()
		if err != nil {
			return nil, err
		}
		// Get members using SMembers (limited by Redis server)
		members, err := r.client.SMembers(ctx, physicalKey).Result()
		if err != nil {
			return nil, err
		}
		result.Value = members
		result.Length = length

	case "zset":
		length, err := r.client.ZCard(ctx, physicalKey).Result()
		if err != nil {
			return nil, err
		}
		// Get first 1000 members with scores
		limit := int64(1000)
		if length < limit {
			limit = length
		}
		val, err := r.client.ZRangeWithScores(ctx, physicalKey, 0, limit-1).Result()
		if err != nil {
			return nil, err
		}
		members := make([]ZSetMember, len(val))
		for i, z := range val {
			members[i] = ZSetMember{
				Member: z.Member.(string),
				Score:  z.Score,
			}
		}
		result.Value = members
		result.Length = length

	case "stream":
		length, err := r.client.XLen(ctx, physicalKey).Result()
		if err != nil {
			return nil, err
		}
		result.Length = length
		if length == 0 {
			result.Value = []StreamEntry{}
			break
		}
		limit := int64(1000)
		if length < limit {
			limit = length
		}
		val, err := r.client.XRangeN(ctx, physicalKey, "-", "+", limit).Result()
		if err != nil {
			return nil, err
		}
		result.Value = toStreamEntries(val)

	default:
		return nil, fmt.Errorf("不支持的 Redis 数据类型: %s", keyType)
	}

	return result, nil
}

// GetString gets a string value
func (r *RedisClientImpl) GetString(key string) (string, error) {
	if r.client == nil {
		return "", fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return r.client.Get(ctx, r.toPhysicalKey(key)).Result()
}

// SetString sets a string value with optional TTL
func (r *RedisClientImpl) SetString(key, value string, ttl int64) error {
	if r.client == nil {
		return fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var expiration time.Duration
	if ttl > 0 {
		expiration = time.Duration(ttl) * time.Second
	}
	return r.client.Set(ctx, r.toPhysicalKey(key), value, expiration).Err()
}

// GetHash gets all fields of a hash
func (r *RedisClientImpl) GetHash(key string) (map[string]string, error) {
	if r.client == nil {
		return nil, fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	values, _, err := r.readHashEntries(ctx, r.toPhysicalKey(key))
	return values, err
}

func (r *RedisClientImpl) readHashEntries(ctx context.Context, physicalKey string) (map[string]string, int64, error) {
	return readRedisHashEntriesWithFallback(
		func() (map[string]string, error) {
			return r.client.HGetAll(ctx, physicalKey).Result()
		},
		func() (int64, error) {
			return r.client.HLen(ctx, physicalKey).Result()
		},
		func(cursor uint64, count int64) ([]string, uint64, error) {
			return r.client.HScan(ctx, physicalKey, cursor, "*", count).Result()
		},
	)
}

func readRedisHashEntriesWithFallback(
	readAll func() (map[string]string, error),
	readLength func() (int64, error),
	scan func(cursor uint64, count int64) ([]string, uint64, error),
) (map[string]string, int64, error) {
	values, err := readAll()
	if err == nil {
		return values, int64(len(values)), nil
	}
	if !shouldFallbackRedisHashScan(err) {
		return nil, 0, err
	}

	entries := make(map[string]string)
	var cursor uint64
	for round := 0; round < redisScanMaxRounds; round++ {
		pairs, nextCursor, scanErr := scan(cursor, redisHashScanStepCount)
		if scanErr != nil {
			return nil, 0, scanErr
		}
		if len(pairs)%2 != 0 {
			return nil, 0, fmt.Errorf("Redis HSCAN 返回结果格式异常")
		}
		for i := 0; i < len(pairs); i += 2 {
			entries[pairs[i]] = pairs[i+1]
		}
		cursor = nextCursor
		if cursor == 0 {
			length, lengthErr := readLength()
			if lengthErr == nil {
				return entries, length, nil
			}
			return entries, int64(len(entries)), nil
		}
	}

	return nil, 0, fmt.Errorf("Redis HSCAN 超出安全轮次，无法完整读取 hash")
}

func shouldFallbackRedisHashScan(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(strings.TrimSpace(err.Error()))
	if !strings.Contains(message, "hgetall") {
		return false
	}
	return strings.Contains(message, "not support for normal user") ||
		strings.Contains(message, "noperm") ||
		strings.Contains(message, "permission")
}

// SetHashField sets a field in a hash
func (r *RedisClientImpl) SetHashField(key, field, value string) error {
	if r.client == nil {
		return fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return r.client.HSet(ctx, r.toPhysicalKey(key), field, value).Err()
}

// DeleteHashField deletes fields from a hash
func (r *RedisClientImpl) DeleteHashField(key string, fields ...string) error {
	if r.client == nil {
		return fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return r.client.HDel(ctx, r.toPhysicalKey(key), fields...).Err()
}

// GetList gets a range of elements from a list
func (r *RedisClientImpl) GetList(key string, start, stop int64) ([]string, error) {
	if r.client == nil {
		return nil, fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return r.client.LRange(ctx, r.toPhysicalKey(key), start, stop).Result()
}

// ListPush pushes values to the end of a list
func (r *RedisClientImpl) ListPush(key string, values ...string) error {
	if r.client == nil {
		return fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	args := make([]interface{}, len(values))
	for i, v := range values {
		args[i] = v
	}
	return r.client.RPush(ctx, r.toPhysicalKey(key), args...).Err()
}

// ListPushLeft pushes values to the start of a list.
func (r *RedisClientImpl) ListPushLeft(key string, values ...string) error {
	if r.client == nil {
		return fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	args := make([]interface{}, len(values))
	for i, value := range values {
		args[i] = value
	}
	return r.client.LPush(ctx, r.toPhysicalKey(key), args...).Err()
}

// ListSet sets the value at an index in a list
func (r *RedisClientImpl) ListSet(key string, index int64, value string) error {
	if r.client == nil {
		return fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return r.client.LSet(ctx, r.toPhysicalKey(key), index, value).Err()
}

// ListRemoveAt removes the expected value at an index atomically.
// The operation requires Redis scripting permission in addition to list command permissions.
func (r *RedisClientImpl) ListRemoveAt(key string, index int64, expectedValue string) error {
	if r.client == nil {
		return fmt.Errorf("Redis 客户端未连接")
	}
	markerID, err := uuid.NewRandom()
	if err != nil {
		return fmt.Errorf("生成 Redis 列表删除标记失败: %w", err)
	}
	marker := "\x00gonavi:list-remove:" + markerID.String()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result, err := r.client.Eval(
		ctx,
		redisListRemoveAtScript,
		[]string{r.toPhysicalKey(key)},
		strconv.FormatInt(index, 10),
		expectedValue,
		marker,
	).Int64()
	if err != nil {
		return err
	}
	switch result {
	case 0:
		return ErrRedisListItemChanged
	case 1:
		return nil
	default:
		return fmt.Errorf("Redis 列表按索引删除返回异常结果: %d", result)
	}
}

// GetSet gets all members of a set
func (r *RedisClientImpl) GetSet(key string) ([]string, error) {
	if r.client == nil {
		return nil, fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return r.client.SMembers(ctx, r.toPhysicalKey(key)).Result()
}

// SetAdd adds members to a set
func (r *RedisClientImpl) SetAdd(key string, members ...string) error {
	if r.client == nil {
		return fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	args := make([]interface{}, len(members))
	for i, m := range members {
		args[i] = m
	}
	return r.client.SAdd(ctx, r.toPhysicalKey(key), args...).Err()
}

// SetRemove removes members from a set
func (r *RedisClientImpl) SetRemove(key string, members ...string) error {
	if r.client == nil {
		return fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	args := make([]interface{}, len(members))
	for i, m := range members {
		args[i] = m
	}
	return r.client.SRem(ctx, r.toPhysicalKey(key), args...).Err()
}

// GetZSet gets members with scores from a sorted set
func (r *RedisClientImpl) GetZSet(key string, start, stop int64) ([]ZSetMember, error) {
	if r.client == nil {
		return nil, fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	val, err := r.client.ZRangeWithScores(ctx, r.toPhysicalKey(key), start, stop).Result()
	if err != nil {
		return nil, err
	}

	members := make([]ZSetMember, len(val))
	for i, z := range val {
		members[i] = ZSetMember{
			Member: z.Member.(string),
			Score:  z.Score,
		}
	}
	return members, nil
}

// ZSetAdd adds members to a sorted set
func (r *RedisClientImpl) ZSetAdd(key string, members ...ZSetMember) error {
	if r.client == nil {
		return fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	zMembers := make([]redis.Z, len(members))
	for i, m := range members {
		zMembers[i] = redis.Z{
			Score:  m.Score,
			Member: m.Member,
		}
	}
	return r.client.ZAdd(ctx, r.toPhysicalKey(key), zMembers...).Err()
}

// ZSetRemove removes members from a sorted set
func (r *RedisClientImpl) ZSetRemove(key string, members ...string) error {
	if r.client == nil {
		return fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	args := make([]interface{}, len(members))
	for i, m := range members {
		args[i] = m
	}
	return r.client.ZRem(ctx, r.toPhysicalKey(key), args...).Err()
}

// GetStream gets stream entries in a range
func (r *RedisClientImpl) GetStream(key, start, stop string, count int64) ([]StreamEntry, error) {
	if r.client == nil {
		return nil, fmt.Errorf("Redis 客户端未连接")
	}
	if start == "" {
		start = "-"
	}
	if stop == "" {
		stop = "+"
	}
	if count <= 0 {
		count = 1000
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	val, err := r.client.XRangeN(ctx, r.toPhysicalKey(key), start, stop, count).Result()
	if err != nil {
		return nil, err
	}
	return toStreamEntries(val), nil
}

// StreamAdd adds an entry to a stream
func (r *RedisClientImpl) StreamAdd(key string, fields map[string]string, id string) (string, error) {
	if r.client == nil {
		return "", fmt.Errorf("Redis 客户端未连接")
	}
	if len(fields) == 0 {
		return "", fmt.Errorf("Stream 字段不能为空")
	}
	if id == "" {
		id = "*"
	}

	values := make(map[string]interface{}, len(fields))
	for field, value := range fields {
		values[field] = value
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	newID, err := r.client.XAdd(ctx, &redis.XAddArgs{
		Stream: r.toPhysicalKey(key),
		ID:     id,
		Values: values,
	}).Result()
	if err != nil {
		return "", err
	}
	return newID, nil
}

// StreamDelete deletes entries from a stream by IDs
func (r *RedisClientImpl) StreamDelete(key string, ids ...string) (int64, error) {
	if r.client == nil {
		return 0, fmt.Errorf("Redis 客户端未连接")
	}
	if len(ids) == 0 {
		return 0, fmt.Errorf("Stream ID 不能为空")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return r.client.XDel(ctx, r.toPhysicalKey(key), ids...).Result()
}

func toStreamEntries(messages []redis.XMessage) []StreamEntry {
	entries := make([]StreamEntry, 0, len(messages))
	for _, msg := range messages {
		fields := make(map[string]string, len(msg.Values))
		for field, value := range msg.Values {
			fields[field] = fmt.Sprint(value)
		}
		entries = append(entries, StreamEntry{
			ID:     msg.ID,
			Fields: fields,
		})
	}
	return entries
}

func parseRedisCommandGetKeysResult(result interface{}) []string {
	items, ok := result.([]interface{})
	if !ok || len(items) == 0 {
		return nil
	}
	keys := make([]string, 0, len(items))
	for _, item := range items {
		switch v := item.(type) {
		case string:
			if v != "" {
				keys = append(keys, v)
			}
		case []byte:
			text := string(v)
			if text != "" {
				keys = append(keys, text)
			}
		}
	}
	return keys
}

func (r *RedisClientImpl) rewriteCommandArgsForNamespace(ctx context.Context, args []string) []string {
	if !r.isCluster || r.currentDB <= 0 || len(args) == 0 {
		return args
	}

	command := strings.ToUpper(strings.TrimSpace(args[0]))
	if command == "COMMAND" || command == "SELECT" || command == "FLUSHDB" {
		return args
	}

	probeArgs := make([]interface{}, 0, len(args)+2)
	probeArgs = append(probeArgs, "COMMAND", "GETKEYS")
	for _, arg := range args {
		probeArgs = append(probeArgs, arg)
	}

	result, err := r.client.Do(ctx, probeArgs...).Result()
	if err != nil {
		return args
	}

	keyCandidates := parseRedisCommandGetKeysResult(result)
	if len(keyCandidates) == 0 {
		return args
	}

	rewritten := append([]string(nil), args...)
	used := make([]bool, len(rewritten))
	for _, key := range keyCandidates {
		for i := 1; i < len(rewritten); i++ {
			if used[i] {
				continue
			}
			if rewritten[i] != key {
				continue
			}
			rewritten[i] = r.toPhysicalKey(rewritten[i])
			used[i] = true
			break
		}
	}
	return rewritten
}

// ExecuteCommand executes a raw Redis command
func (r *RedisClientImpl) ExecuteCommand(args []string) (interface{}, error) {
	if r.client == nil {
		return nil, fmt.Errorf("Redis 客户端未连接")
	}
	if len(args) == 0 {
		return nil, fmt.Errorf("命令不能为空")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if r.isCluster {
		command := strings.ToUpper(strings.TrimSpace(args[0]))
		switch command {
		case "SELECT":
			if len(args) < 2 {
				return nil, localizedRedisBackendError("redis.backend.error.select_db_index_required", nil)
			}
			rawIndex := strings.TrimSpace(args[1])
			index, err := strconv.Atoi(rawIndex)
			if err != nil {
				return nil, localizedRedisBackendError("redis.backend.error.select_db_index_invalid", map[string]any{"value": rawIndex})
			}
			if index < 0 || index >= redisClusterLogicalDBCount {
				return nil, localizedRedisBackendError("redis.backend.error.select_db_index_out_of_range", map[string]any{
					"min": 0,
					"max": redisClusterLogicalDBCount - 1,
				})
			}
			r.currentDB = index
			r.config.RedisDB = index
			return "OK", nil
		case "FLUSHDB":
			if err := r.FlushDB(); err != nil {
				return nil, err
			}
			return "OK", nil
		}
	}

	args = r.rewriteCommandArgsForNamespace(ctx, args)

	// Convert to []interface{}
	cmdArgs := make([]interface{}, len(args))
	for i, arg := range args {
		cmdArgs[i] = arg
	}

	result, err := r.client.Do(ctx, cmdArgs...).Result()
	if err != nil {
		return nil, err
	}

	return formatCommandResult(result), nil
}

// formatCommandResult formats the command result for display.
//
// RESP3 协议（go-redis v9 默认）下，HGETALL / CONFIG GET / XINFO 等命令返回 Map 类型，
// go-redis 用 map[interface{}]interface{} 承载。encoding/json 不支持非 string-key 的 map，
// 如果让原值穿透到 Wails RPC，json.Marshal 会失败，Wails runtime 在 Windows 上会直接 panic
// 让进程退出——用户感知为 GoNavi 闪退（issue: HGETALL 闪退）。
// 平展成 [k1, v1, k2, v2, ...] 交错形式与 RESP2 array 输出一致，前端按 array 渲染。
//
// 这里同时把 RESP3 的 NaN/Inf 浮点、大整数、error 以及其他 map/slice 形态统一收敛为
// JSON-safe 结构，避免 Redis 命令面板再把不可序列化的值透传给 Wails。
func formatCommandResult(result interface{}) interface{} {
	switch v := result.(type) {
	case []interface{}:
		formatted := make([]interface{}, len(v))
		for i, item := range v {
			formatted[i] = formatCommandResult(item)
		}
		return formatted
	case map[interface{}]interface{}:
		flattened := make([]interface{}, 0, len(v)*2)
		for key, val := range v {
			flattened = append(flattened, formatCommandResult(key))
			flattened = append(flattened, formatCommandResult(val))
		}
		return flattened
	case map[string]interface{}:
		formatted := make(map[string]interface{}, len(v))
		for key, val := range v {
			formatted[key] = formatCommandResult(val)
		}
		return formatted
	case []byte:
		return string(v)
	case error:
		return v.Error()
	case *big.Int:
		if v == nil {
			return nil
		}
		return v.String()
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return fmt.Sprint(v)
		}
		return v
	case float32:
		f := float64(v)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return fmt.Sprint(v)
		}
		return v
	default:
		return formatCommandResultByReflection(v)
	}
}

func formatCommandResultByReflection(result interface{}) interface{} {
	value := reflect.ValueOf(result)
	if !value.IsValid() {
		return nil
	}
	switch value.Kind() {
	case reflect.Map:
		if value.Type().Key().Kind() == reflect.String {
			formatted := make(map[string]interface{}, value.Len())
			iter := value.MapRange()
			for iter.Next() {
				formatted[iter.Key().String()] = formatCommandResult(iter.Value().Interface())
			}
			return formatted
		}
		flattened := make([]interface{}, 0, value.Len()*2)
		iter := value.MapRange()
		for iter.Next() {
			flattened = append(flattened, formatCommandResult(iter.Key().Interface()))
			flattened = append(flattened, formatCommandResult(iter.Value().Interface()))
		}
		return flattened
	case reflect.Slice, reflect.Array:
		formatted := make([]interface{}, value.Len())
		for i := 0; i < value.Len(); i++ {
			formatted[i] = formatCommandResult(value.Index(i).Interface())
		}
		return formatted
	default:
		return result
	}
}

// GetServerInfo returns server information
func (r *RedisClientImpl) GetServerInfo() (map[string]string, error) {
	if r.client == nil {
		return nil, fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	info, err := r.client.Info(ctx).Result()
	if err != nil {
		return nil, err
	}

	result := make(map[string]string)
	lines := strings.Split(info, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) == 2 {
			result[parts[0]] = parts[1]
		}
	}
	return result, nil
}

func parseRedisKeyspaceDatabaseKeys(info string) map[int]int64 {
	dbMap := make(map[int]int64)
	lines := strings.Split(info, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "db") {
			// Format: db0:keys=123,expires=0,avg_ttl=0
			parts := strings.SplitN(line, ":", 2)
			if len(parts) != 2 {
				continue
			}
			dbIndex, err := strconv.Atoi(strings.TrimPrefix(parts[0], "db"))
			if err != nil {
				continue
			}
			kvPairs := strings.Split(parts[1], ",")
			for _, kv := range kvPairs {
				if strings.HasPrefix(kv, "keys=") {
					keys, _ := strconv.ParseInt(strings.TrimPrefix(kv, "keys="), 10, 64)
					dbMap[dbIndex] = keys
					break
				}
			}
		}
	}
	return dbMap
}

func parseRedisConfiguredDatabaseCount(config map[string]string) (int, bool) {
	for key, value := range config {
		if !strings.EqualFold(strings.TrimSpace(key), "databases") {
			continue
		}
		count, err := strconv.Atoi(strings.TrimSpace(value))
		if err == nil && count > 0 {
			return count, true
		}
	}
	return 0, false
}

func (r *RedisClientImpl) resolveRedisDatabaseCount(ctx context.Context, dbMap map[int]int64) int {
	count := redisDefaultDatabaseCount
	if r.currentDB >= count {
		count = r.currentDB + 1
	}
	for index := range dbMap {
		if index >= count {
			count = index + 1
		}
	}
	config, err := r.client.ConfigGet(ctx, "databases").Result()
	if err != nil {
		return count
	}
	if configured, ok := parseRedisConfiguredDatabaseCount(config); ok && configured > count {
		count = configured
	}
	return count
}

// GetDatabases returns information about all databases
func (r *RedisClientImpl) GetDatabases() ([]RedisDBInfo, error) {
	if r.client == nil {
		return nil, fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(metadataContextFor(r), 10*time.Second)
	defer cancel()

	if r.isCluster && r.clusterClient != nil {
		var totalKeys int64
		var mu sync.Mutex
		err := r.clusterClient.ForEachMaster(ctx, func(nodeCtx context.Context, node *redis.Client) error {
			keys, err := node.DBSize(nodeCtx).Result()
			if err != nil {
				return err
			}
			mu.Lock()
			totalKeys += keys
			mu.Unlock()
			return nil
		})
		if err != nil {
			logger.Warnf("Redis 集群获取 key 数量失败，回退为 0: %v", err)
			totalKeys = 0
		}
		result := make([]RedisDBInfo, redisClusterLogicalDBCount)
		for i := 0; i < redisClusterLogicalDBCount; i++ {
			result[i] = RedisDBInfo{Index: i, Keys: 0}
		}
		result[0].Keys = totalKeys
		return result, nil
	}

	// Get keyspace info
	info, err := r.client.Info(ctx, "keyspace").Result()
	if err != nil {
		return nil, err
	}

	dbMap := parseRedisKeyspaceDatabaseKeys(info)
	databaseCount := r.resolveRedisDatabaseCount(ctx, dbMap)
	result := make([]RedisDBInfo, databaseCount)
	for i := 0; i < databaseCount; i++ {
		result[i] = RedisDBInfo{
			Index: i,
			Keys:  dbMap[i], // Will be 0 if not in map
		}
	}

	return result, nil
}

// SelectDB selects a database
func (r *RedisClientImpl) SelectDB(index int) error {
	if r.client == nil {
		return fmt.Errorf("Redis 客户端未连接")
	}

	if r.isCluster {
		if index < 0 || index >= redisClusterLogicalDBCount {
			return localizedRedisBackendError("redis.backend.error.select_db_index_out_of_range", map[string]any{
				"min": 0,
				"max": redisClusterLogicalDBCount - 1,
			})
		}
		r.currentDB = index
		r.config.RedisDB = index
		return nil
	}

	if index < 0 {
		return fmt.Errorf("数据库索引必须大于等于 0")
	}

	nextConfig := r.config
	nextConfig.RedisDB = index
	nextClient := &RedisClientImpl{}
	if err := redisDBSwitchConnect(nextClient, nextConfig); err != nil {
		return fmt.Errorf("切换数据库失败: %w", err)
	}

	oldClient := r.client
	*r = *nextClient
	if oldClient != nil {
		_ = oldClient.Close()
	}

	logger.Infof("Redis 切换到数据库: db%d", index)
	return nil
}

// GetCurrentDB returns the current database index
func (r *RedisClientImpl) GetCurrentDB() int {
	return r.currentDB
}

// FlushDB flushes the current database
func (r *RedisClientImpl) FlushDB() error {
	if r.client == nil {
		return fmt.Errorf("Redis 客户端未连接")
	}

	if r.isCluster && r.clusterClient != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()

		namespacePrefix := r.redisNamespacePrefix()
		var deletedTotal int64
		var deletedMu sync.Mutex

		err := r.clusterClient.ForEachMaster(ctx, func(nodeCtx context.Context, node *redis.Client) error {
			var cursor uint64
			for {
				pattern := "*"
				if namespacePrefix != "" {
					pattern = namespacePrefix + "*"
				}
				keys, nextCursor, err := node.Scan(nodeCtx, cursor, pattern, 2000).Result()
				if err != nil {
					return err
				}

				if namespacePrefix == "" {
					filtered := keys[:0]
					for _, key := range keys {
						// db0 保留兼容：不删除逻辑库前缀 key，避免误清理 db1~db15。
						if strings.HasPrefix(key, "__gonavi_db_") {
							continue
						}
						filtered = append(filtered, key)
					}
					keys = filtered
				}

				if len(keys) > 0 {
					deleted, err := node.Del(nodeCtx, keys...).Result()
					if err != nil {
						return err
					}
					deletedMu.Lock()
					deletedTotal += deleted
					deletedMu.Unlock()
				}

				cursor = nextCursor
				if cursor == 0 {
					break
				}
			}
			return nil
		})
		if err != nil {
			return err
		}
		logger.Infof("Redis 集群逻辑库清空完成: db%d deleted=%d", r.currentDB, deletedTotal)
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return r.client.FlushDB(ctx).Err()
}
