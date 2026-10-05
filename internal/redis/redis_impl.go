package redis

import (
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/ssh"

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
