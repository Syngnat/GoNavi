package redis

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"

	"github.com/redis/go-redis/v9"
)

// RedisClientImpl implements RedisClient using go-redis
type RedisClientImpl struct {
	client    *redis.Client
	config    connection.ConnectionConfig
	currentDB int
	forwarder *ssh.LocalForwarder
}

// NewRedisClient creates a new Redis client instance
func NewRedisClient() RedisClient {
	return &RedisClientImpl{}
}

// Connect establishes a connection to Redis
func (r *RedisClientImpl) Connect(config connection.ConnectionConfig) error {
	r.config = config
	r.currentDB = config.RedisDB

	addr := fmt.Sprintf("%s:%d", config.Host, config.Port)

	// Handle SSH tunnel if enabled
	if config.UseSSH {
		forwarder, err := ssh.GetOrCreateLocalForwarder(config.SSH, config.Host, config.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败: %w", err)
		}
		r.forwarder = forwarder
		addr = forwarder.LocalAddr
		logger.Infof("Redis 通过 SSH 隧道连接: %s -> %s:%d", addr, config.Host, config.Port)
	}

	opts := &redis.Options{
		Addr:         addr,
		Password:     config.Password,
		DB:           config.RedisDB,
		DialTimeout:  time.Duration(config.Timeout) * time.Second,
		ReadTimeout:  time.Duration(config.Timeout) * time.Second,
		WriteTimeout: time.Duration(config.Timeout) * time.Second,
	}

	if opts.DialTimeout == 0 {
		opts.DialTimeout = 30 * time.Second
		opts.ReadTimeout = 30 * time.Second
		opts.WriteTimeout = 30 * time.Second
	}

	r.client = redis.NewClient(opts)

	// Test connection
	ctx, cancel := context.WithTimeout(context.Background(), opts.DialTimeout)
	defer cancel()

	if err := r.client.Ping(ctx).Err(); err != nil {
		r.client.Close()
		r.client = nil
		return fmt.Errorf("Redis 连接失败: %w", err)
	}

	logger.Infof("Redis 连接成功: %s DB=%d", addr, config.RedisDB)
	return nil
}

// Close closes the Redis connection
func (r *RedisClientImpl) Close() error {
	if r.client != nil {
		err := r.client.Close()
		r.client = nil
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

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if pattern == "" {
		pattern = "*"
	}
	if count <= 0 {
		count = 100
	}

	keys, nextCursor, err := r.client.Scan(ctx, cursor, pattern, count).Result()
	if err != nil {
		return nil, err
	}

	result := &RedisScanResult{
		Keys:   make([]RedisKeyInfo, 0, len(keys)),
		Cursor: nextCursor,
	}

	// Get type and TTL for each key
	pipe := r.client.Pipeline()
	typeResults := make([]*redis.StatusCmd, len(keys))
	ttlResults := make([]*redis.DurationCmd, len(keys))

	for i, key := range keys {
		typeResults[i] = pipe.Type(ctx, key)
		ttlResults[i] = pipe.TTL(ctx, key)
	}

	_, err = pipe.Exec(ctx)
	if err != nil && err != redis.Nil {
		// Fallback: get info one by one
		for _, key := range keys {
			keyType, _ := r.GetKeyType(key)
			ttl, _ := r.GetTTL(key)
			result.Keys = append(result.Keys, RedisKeyInfo{
				Key:  key,
				Type: keyType,
				TTL:  ttl,
			})
		}
		return result, nil
	}

	for i, key := range keys {
		keyType := typeResults[i].Val()
		ttl := int64(ttlResults[i].Val().Seconds())
		if ttlResults[i].Val() == -1 {
			ttl = -1
		} else if ttlResults[i].Val() == -2 {
			ttl = -2
		}
		result.Keys = append(result.Keys, RedisKeyInfo{
			Key:  key,
			Type: keyType,
			TTL:  ttl,
		})
	}

	return result, nil
}

// GetKeyType returns the type of a key
func (r *RedisClientImpl) GetKeyType(key string) (string, error) {
	if r.client == nil {
		return "", fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return r.client.Type(ctx, key).Result()
}

// GetTTL returns the TTL of a key in seconds
func (r *RedisClientImpl) GetTTL(key string) (int64, error) {
	if r.client == nil {
		return 0, fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	ttl, err := r.client.TTL(ctx, key).Result()
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
		return r.client.Persist(ctx, key).Err()
	}
	return r.client.Expire(ctx, key, time.Duration(ttl)*time.Second).Err()
}

// DeleteKeys deletes one or more keys
func (r *RedisClientImpl) DeleteKeys(keys []string) (int64, error) {
	if r.client == nil {
		return 0, fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return r.client.Del(ctx, keys...).Result()
}

// RenameKey renames a key
func (r *RedisClientImpl) RenameKey(oldKey, newKey string) error {
	if r.client == nil {
		return fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return r.client.Rename(ctx, oldKey, newKey).Err()
}

// KeyExists checks if a key exists
func (r *RedisClientImpl) KeyExists(key string) (bool, error) {
	if r.client == nil {
		return false, fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	n, err := r.client.Exists(ctx, key).Result()
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

	result := &RedisValue{
		Type: keyType,
		TTL:  ttl,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	switch keyType {
	case "string":
		val, err := r.client.Get(ctx, key).Result()
		if err != nil {
			return nil, err
		}
		result.Value = val
		result.Length = int64(len(val))

	case "hash":
		val, err := r.client.HGetAll(ctx, key).Result()
		if err != nil {
			return nil, err
		}
		result.Value = val
		result.Length = int64(len(val))

	case "list":
		length, err := r.client.LLen(ctx, key).Result()
		if err != nil {
			return nil, err
		}
		// Get first 1000 items
		limit := int64(1000)
		if length < limit {
			limit = length
		}
		val, err := r.client.LRange(ctx, key, 0, limit-1).Result()
		if err != nil {
			return nil, err
		}
		result.Value = val
		result.Length = length

	case "set":
		length, err := r.client.SCard(ctx, key).Result()
		if err != nil {
			return nil, err
		}
		// Get members using SMembers (limited by Redis server)
		members, err := r.client.SMembers(ctx, key).Result()
		if err != nil {
			return nil, err
		}
		result.Value = members
		result.Length = length

	case "zset":
		length, err := r.client.ZCard(ctx, key).Result()
		if err != nil {
			return nil, err
		}
		// Get first 1000 members with scores
		limit := int64(1000)
		if length < limit {
			limit = length
		}
		val, err := r.client.ZRangeWithScores(ctx, key, 0, limit-1).Result()
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
		length, err := r.client.XLen(ctx, key).Result()
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
		val, err := r.client.XRangeN(ctx, key, "-", "+", limit).Result()
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
	return r.client.Get(ctx, key).Result()
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
	return r.client.Set(ctx, key, value, expiration).Err()
}

// GetHash gets all fields of a hash
func (r *RedisClientImpl) GetHash(key string) (map[string]string, error) {
	if r.client == nil {
		return nil, fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return r.client.HGetAll(ctx, key).Result()
}

// SetHashField sets a field in a hash
func (r *RedisClientImpl) SetHashField(key, field, value string) error {
	if r.client == nil {
		return fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return r.client.HSet(ctx, key, field, value).Err()
}

// DeleteHashField deletes fields from a hash
func (r *RedisClientImpl) DeleteHashField(key string, fields ...string) error {
	if r.client == nil {
		return fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return r.client.HDel(ctx, key, fields...).Err()
}

// GetList gets a range of elements from a list
func (r *RedisClientImpl) GetList(key string, start, stop int64) ([]string, error) {
	if r.client == nil {
		return nil, fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return r.client.LRange(ctx, key, start, stop).Result()
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
	return r.client.RPush(ctx, key, args...).Err()
}

// ListSet sets the value at an index in a list
func (r *RedisClientImpl) ListSet(key string, index int64, value string) error {
	if r.client == nil {
		return fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return r.client.LSet(ctx, key, index, value).Err()
}

// GetSet gets all members of a set
func (r *RedisClientImpl) GetSet(key string) ([]string, error) {
	if r.client == nil {
		return nil, fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return r.client.SMembers(ctx, key).Result()
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
	return r.client.SAdd(ctx, key, args...).Err()
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
	return r.client.SRem(ctx, key, args...).Err()
}

// GetZSet gets members with scores from a sorted set
func (r *RedisClientImpl) GetZSet(key string, start, stop int64) ([]ZSetMember, error) {
	if r.client == nil {
		return nil, fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	val, err := r.client.ZRangeWithScores(ctx, key, start, stop).Result()
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
	return r.client.ZAdd(ctx, key, zMembers...).Err()
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
	return r.client.ZRem(ctx, key, args...).Err()
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

	val, err := r.client.XRangeN(ctx, key, start, stop, count).Result()
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
		Stream: key,
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
	return r.client.XDel(ctx, key, ids...).Result()
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
	if index < 0 || index > 15 {
		return fmt.Errorf("数据库索引必须在 0-15 之间")
	}

	// Create new client with different DB
	addr := fmt.Sprintf("%s:%d", r.config.Host, r.config.Port)
	if r.forwarder != nil {
		addr = r.forwarder.LocalAddr
	}

	opts := &redis.Options{
		Addr:         addr,
		Password:     r.config.Password,
		DB:           index,
		DialTimeout:  time.Duration(r.config.Timeout) * time.Second,
		ReadTimeout:  time.Duration(r.config.Timeout) * time.Second,
		WriteTimeout: time.Duration(r.config.Timeout) * time.Second,
	}

	if opts.DialTimeout == 0 {
		opts.DialTimeout = 30 * time.Second
		opts.ReadTimeout = 30 * time.Second
		opts.WriteTimeout = 30 * time.Second
	}

	newClient := redis.NewClient(opts)

	ctx, cancel := context.WithTimeout(context.Background(), opts.DialTimeout)
	defer cancel()

	if err := newClient.Ping(ctx).Err(); err != nil {
		newClient.Close()
		return fmt.Errorf("切换数据库失败: %w", err)
	}

	// Close old client and replace
	r.client.Close()
	r.client = newClient
	r.currentDB = index

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
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return r.client.FlushDB(ctx).Err()
}
