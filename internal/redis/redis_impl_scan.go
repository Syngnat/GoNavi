package redis

import (
	"context"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

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
