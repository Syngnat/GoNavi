package redis

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"

	"github.com/redis/go-redis/v9"
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
	redisScanDefaultTargetCount int64 = 2000
	redisScanMaxTargetCount     int64 = 10000
	redisScanMinStepCount       int64 = 200
	redisScanMaxStepCount       int64 = 2000
	redisScanMaxRounds                = 64
	redisScanMaxDuration              = 12 * time.Second
	redisSearchMaxTargetCount   int64 = 1000
	redisSearchMaxStepCount     int64 = 1000
	redisSearchMaxRounds              = 16
	redisSearchMaxDuration            = 3 * time.Second
)

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
		return "", fmt.Errorf("Redis 节点地址不能为空")
	}

	if _, _, err := net.SplitHostPort(addr); err == nil {
		return addr, nil
	}

	if !strings.Contains(addr, ":") {
		return net.JoinHostPort(addr, strconv.Itoa(defaultPort)), nil
	}

	// 尝试兼容 host:port 但端口格式异常的场景。
	host, port, ok := strings.Cut(addr, ":")
	if !ok {
		return "", fmt.Errorf("无效 Redis 节点地址: %s", addr)
	}
	host = strings.TrimSpace(host)
	port = strings.TrimSpace(port)
	if host == "" {
		return "", fmt.Errorf("无效 Redis 节点地址: %s", addr)
	}
	if _, err := strconv.Atoi(port); err != nil {
		return "", fmt.Errorf("无效 Redis 端口: %s", addr)
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
		return nil, fmt.Errorf("Redis 连接地址不能为空")
	}
	return addrs, nil
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

// Connect establishes a connection to Redis
func (r *RedisClientImpl) Connect(config connection.ConnectionConfig) error {
	r.config = config
	if r.config.RedisDB < 0 || r.config.RedisDB > 15 {
		r.config.RedisDB = 0
	}
	r.currentDB = r.config.RedisDB
	r.forwarder = nil
	r.client = nil
	r.singleClient = nil
	r.clusterClient = nil
	r.isCluster = false

	seedAddrs, err := buildRedisSeedAddrs(config)
	if err != nil {
		return err
	}
	r.seedAddrs = append([]string(nil), seedAddrs...)

	topology := strings.ToLower(strings.TrimSpace(config.Topology))
	r.isCluster = topology == "cluster" || len(seedAddrs) > 1

	if r.isCluster && config.UseSSH {
		return fmt.Errorf("Redis 集群模式暂不支持 SSH 隧道，请关闭 SSH 后重试")
	}

	timeout := normalizeRedisTimeout(config.Timeout)
	if r.isCluster {
		attempts := []connection.ConnectionConfig{config}
		if shouldTryRedisSSLPreferredFallback(config) {
			attempts = append(attempts, withRedisSSLDisabled(config))
		}

		var failures []string
		for idx, attempt := range attempts {
			var tlsConfig *tls.Config
			if cfg := resolveRedisTLSConfig(attempt); cfg != nil {
				if host, _, err := net.SplitHostPort(seedAddrs[0]); err == nil && host != "" {
					cfg.ServerName = host
				}
				tlsConfig = cfg
			}
			opts := &redis.ClusterOptions{
				Addrs:        seedAddrs,
				Username:     strings.TrimSpace(attempt.User),
				Password:     attempt.Password,
				DialTimeout:  timeout,
				ReadTimeout:  timeout,
				WriteTimeout: timeout,
				TLSConfig:    tlsConfig,
			}
			clusterClient := redis.NewClusterClient(opts)
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			pingErr := clusterClient.Ping(ctx).Err()
			cancel()
			if pingErr != nil {
				clusterClient.Close()
				failures = append(failures, fmt.Sprintf("第%d次连接失败: %v", idx+1, pingErr))
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
		return fmt.Errorf("Redis 集群连接失败: %s", strings.Join(failures, "；"))
	}

	addr := seedAddrs[0]
	if config.UseSSH {
		forwarder, err := ssh.GetOrCreateLocalForwarder(config.SSH, config.Host, config.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败: %w", err)
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
		if cfg := resolveRedisTLSConfig(attempt); cfg != nil {
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
			failures = append(failures, fmt.Sprintf("第%d次连接失败: %v", idx+1, pingErr))
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

	return fmt.Errorf("Redis 连接失败: %s", strings.Join(failures, "；"))
}

// Close closes the Redis connection
func (r *RedisClientImpl) Close() error {
	if r.client != nil {
		err := r.client.Close()
		r.client = nil
		r.singleClient = nil
		r.clusterClient = nil
		r.isCluster = false
		r.seedAddrs = nil
		r.forwarder = nil
		return err
	}
	return nil
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
		maxRounds = redisSearchMaxRounds
		maxDuration = redisSearchMaxDuration
	}

	ctx, cancel := context.WithTimeout(context.Background(), maxDuration+5*time.Second)
	defer cancel()

	currentCursor := cursor
	round := 0
	scanStartedAt := time.Now()

	keys := make([]string, 0, int(targetCount))
	seen := make(map[string]struct{}, int(targetCount))

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
			if len(keys) >= int(targetCount) {
				break
			}
		}

		currentCursor = nextCursor
		round++
		if currentCursor == 0 || round >= maxRounds {
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
	if targetCount < redisScanMinStepCount {
		return redisScanMinStepCount
	}
	if targetCount > redisScanMaxStepCount {
		return redisScanMaxStepCount
	}
	return targetCount
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
			result = append(result, RedisKeyInfo{
				Key:  r.toDisplayKey(key),
				Type: keyType,
				TTL:  toRedisTTLSeconds(ttlValue),
			})
		}
		return result
	}

	for i, key := range keys {
		result = append(result, RedisKeyInfo{
			Key:  r.toDisplayKey(key),
			Type: typeResults[i].Val(),
			TTL:  toRedisTTLSeconds(ttlResults[i].Val()),
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

// GetKeyType returns the type of a key
func (r *RedisClientImpl) GetKeyType(key string) (string, error) {
	if r.client == nil {
		return "", fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return r.client.Type(ctx, r.toPhysicalKey(key)).Result()
}

// GetTTL returns the TTL of a key in seconds
func (r *RedisClientImpl) GetTTL(key string) (int64, error) {
	if r.client == nil {
		return 0, fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
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
	physicalKey := r.toPhysicalKey(key)

	result := &RedisValue{
		Type: keyType,
		TTL:  ttl,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
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
		val, err := r.client.HGetAll(ctx, physicalKey).Result()
		if err != nil {
			return nil, err
		}
		result.Value = val
		result.Length = int64(len(val))

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
	return r.client.HGetAll(ctx, r.toPhysicalKey(key)).Result()
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

// ListSet sets the value at an index in a list
func (r *RedisClientImpl) ListSet(key string, index int64, value string) error {
	if r.client == nil {
		return fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return r.client.LSet(ctx, r.toPhysicalKey(key), index, value).Err()
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
				return nil, fmt.Errorf("SELECT 命令缺少数据库索引")
			}
			index, err := strconv.Atoi(strings.TrimSpace(args[1]))
			if err != nil {
				return nil, fmt.Errorf("无效数据库索引: %s", args[1])
			}
			if index < 0 || index > 15 {
				return nil, fmt.Errorf("数据库索引必须在 0-15 之间")
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

// formatCommandResult formats the command result for display
func formatCommandResult(result interface{}) interface{} {
	switch v := result.(type) {
	case []interface{}:
		formatted := make([]interface{}, len(v))
		for i, item := range v {
			formatted[i] = formatCommandResult(item)
		}
		return formatted
	case []byte:
		return string(v)
	default:
		return v
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

// GetDatabases returns information about all databases
func (r *RedisClientImpl) GetDatabases() ([]RedisDBInfo, error) {
	if r.client == nil {
		return nil, fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
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
		result := make([]RedisDBInfo, 16)
		for i := 0; i < 16; i++ {
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

	// Parse keyspace info
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
			// Parse keys count
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

	// Return all 16 databases (0-15)
	result := make([]RedisDBInfo, 16)
	for i := 0; i < 16; i++ {
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
		if index < 0 || index > 15 {
			return fmt.Errorf("数据库索引必须在 0-15 之间")
		}
		r.currentDB = index
		r.config.RedisDB = index
		return nil
	}

	if index < 0 || index > 15 {
		return fmt.Errorf("数据库索引必须在 0-15 之间")
	}

	// Create new client with different DB
	addr := ""
	if len(r.seedAddrs) > 0 {
		addr = r.seedAddrs[0]
	}
	if r.forwarder != nil {
		addr = r.forwarder.LocalAddr
	}
	if addr == "" {
		addr = fmt.Sprintf("%s:%d", r.config.Host, r.config.Port)
	}

	timeout := normalizeRedisTimeout(r.config.Timeout)

	opts := &redis.Options{
		Addr:         addr,
		Username:     strings.TrimSpace(r.config.User),
		Password:     r.config.Password,
		DB:           index,
		DialTimeout:  timeout,
		ReadTimeout:  timeout,
		WriteTimeout: timeout,
	}

	newClient := redis.NewClient(opts)

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	if err := newClient.Ping(ctx).Err(); err != nil {
		newClient.Close()
		return fmt.Errorf("切换数据库失败: %w", err)
	}

	// Close old client and replace
	if r.client != nil {
		_ = r.client.Close()
	}
	r.client = newClient
	r.singleClient = newClient
	r.clusterClient = nil
	r.currentDB = index
	r.config.RedisDB = index

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
