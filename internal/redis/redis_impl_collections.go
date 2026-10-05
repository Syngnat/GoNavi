package redis

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

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
