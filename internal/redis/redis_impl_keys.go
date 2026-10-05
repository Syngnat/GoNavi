package redis

import (
	"context"
	"fmt"
	"time"
)

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
