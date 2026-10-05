package redis

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/logger"

	"github.com/redis/go-redis/v9"
)

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
