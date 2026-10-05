package sync

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	redispkg "GoNavi-Wails/internal/redis"
)

func applyMongoRedisDiff(targetClient redisMigrationClient, diff mongoRedisKeyDiff) error {
	desired := diff.Document.Desired
	if desired == nil {
		return fmt.Errorf("空的 Redis 目标值: key=%s", diff.Document.Key)
	}
	redisType := strings.ToLower(strings.TrimSpace(desired.Type))
	ttl := normalizeRedisMigrationTTL(desired.TTL)
	if diff.Exists && diff.Action == "update" && redisType != "string" {
		if _, err := targetClient.DeleteKeys([]string{diff.Document.Key}); err != nil {
			return err
		}
	}

	switch redisType {
	case "string":
		return targetClient.SetString(diff.Document.Key, asRedisMigrationString(desired.Value), ttl)
	case "hash":
		mapped, err := asRedisMigrationStringMap(desired.Value)
		if err != nil {
			return err
		}
		fields := make([]string, 0, len(mapped))
		for field := range mapped {
			fields = append(fields, field)
		}
		sort.Strings(fields)
		for _, field := range fields {
			if err := targetClient.SetHashField(diff.Document.Key, field, mapped[field]); err != nil {
				return err
			}
		}
		return targetClient.SetTTL(diff.Document.Key, ttl)
	case "list":
		items, err := asRedisMigrationStringSlice(desired.Value)
		if err != nil {
			return err
		}
		if len(items) > 0 {
			if err := targetClient.ListPush(diff.Document.Key, items...); err != nil {
				return err
			}
		}
		return targetClient.SetTTL(diff.Document.Key, ttl)
	case "set":
		items, err := asRedisMigrationStringSlice(desired.Value)
		if err != nil {
			return err
		}
		if len(items) > 0 {
			if err := targetClient.SetAdd(diff.Document.Key, items...); err != nil {
				return err
			}
		}
		return targetClient.SetTTL(diff.Document.Key, ttl)
	case "zset":
		members, err := asRedisMigrationZSetMembers(desired.Value)
		if err != nil {
			return err
		}
		if len(members) > 0 {
			if err := targetClient.ZSetAdd(diff.Document.Key, members...); err != nil {
				return err
			}
		}
		return targetClient.SetTTL(diff.Document.Key, ttl)
	case "stream":
		entries, err := asRedisMigrationStreamEntries(desired.Value)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if _, err := targetClient.StreamAdd(diff.Document.Key, entry.Fields, entry.ID); err != nil {
				return err
			}
		}
		return targetClient.SetTTL(diff.Document.Key, ttl)
	default:
		return fmt.Errorf("暂不支持 Redis 类型 %s", redisType)
	}
}

func asRedisMigrationString(value interface{}) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case []byte:
		return string(typed)
	default:
		return fmt.Sprintf("%v", typed)
	}
}

func asRedisMigrationInt64(value interface{}, defaultValue int64) int64 {
	switch typed := value.(type) {
	case nil:
		return defaultValue
	case int:
		return int64(typed)
	case int8:
		return int64(typed)
	case int16:
		return int64(typed)
	case int32:
		return int64(typed)
	case int64:
		return typed
	case uint:
		return int64(typed)
	case uint8:
		return int64(typed)
	case uint16:
		return int64(typed)
	case uint32:
		return int64(typed)
	case uint64:
		return int64(typed)
	case float32:
		return int64(typed)
	case float64:
		return int64(typed)
	case json.Number:
		if n, err := typed.Int64(); err == nil {
			return n
		}
	case string:
		if n, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64); err == nil {
			return n
		}
	}
	return defaultValue
}

func asRedisMigrationFloat64(value interface{}) (float64, error) {
	switch typed := value.(type) {
	case float64:
		return typed, nil
	case float32:
		return float64(typed), nil
	case int:
		return float64(typed), nil
	case int8:
		return float64(typed), nil
	case int16:
		return float64(typed), nil
	case int32:
		return float64(typed), nil
	case int64:
		return float64(typed), nil
	case uint:
		return float64(typed), nil
	case uint8:
		return float64(typed), nil
	case uint16:
		return float64(typed), nil
	case uint32:
		return float64(typed), nil
	case uint64:
		return float64(typed), nil
	case json.Number:
		return typed.Float64()
	case string:
		return strconv.ParseFloat(strings.TrimSpace(typed), 64)
	default:
		return 0, fmt.Errorf("无法转换为 float64: %T", value)
	}
}

func asRedisMigrationStringMap(value interface{}) (map[string]string, error) {
	switch typed := value.(type) {
	case nil:
		return map[string]string{}, nil
	case map[string]string:
		result := make(map[string]string, len(typed))
		for k, v := range typed {
			result[k] = v
		}
		return result, nil
	case map[string]interface{}:
		result := make(map[string]string, len(typed))
		for k, v := range typed {
			result[k] = asRedisMigrationString(v)
		}
		return result, nil
	default:
		return nil, fmt.Errorf("期望对象，实际=%T", value)
	}
}

func asRedisMigrationStringSlice(value interface{}) ([]string, error) {
	switch typed := value.(type) {
	case nil:
		return []string{}, nil
	case []string:
		result := append([]string(nil), typed...)
		return result, nil
	case []interface{}:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			result = append(result, asRedisMigrationString(item))
		}
		return result, nil
	default:
		return nil, fmt.Errorf("期望数组，实际=%T", value)
	}
}

func asRedisMigrationZSetMembers(value interface{}) ([]redispkg.ZSetMember, error) {
	switch typed := value.(type) {
	case nil:
		return []redispkg.ZSetMember{}, nil
	case []redispkg.ZSetMember:
		result := append([]redispkg.ZSetMember(nil), typed...)
		return result, nil
	case []interface{}:
		result := make([]redispkg.ZSetMember, 0, len(typed))
		for _, item := range typed {
			mapped, ok := item.(map[string]interface{})
			if !ok {
				return nil, fmt.Errorf("zset 成员格式无效: %T", item)
			}
			score, err := asRedisMigrationFloat64(mapped["score"])
			if err != nil {
				return nil, err
			}
			result = append(result, redispkg.ZSetMember{Member: asRedisMigrationString(mapped["member"]), Score: score})
		}
		return result, nil
	default:
		return nil, fmt.Errorf("期望 zset 数组，实际=%T", value)
	}
}

func asRedisMigrationStreamEntries(value interface{}) ([]redispkg.StreamEntry, error) {
	switch typed := value.(type) {
	case nil:
		return []redispkg.StreamEntry{}, nil
	case []redispkg.StreamEntry:
		result := append([]redispkg.StreamEntry(nil), typed...)
		return result, nil
	case []interface{}:
		result := make([]redispkg.StreamEntry, 0, len(typed))
		for _, item := range typed {
			mapped, ok := item.(map[string]interface{})
			if !ok {
				return nil, fmt.Errorf("stream 条目格式无效: %T", item)
			}
			fields, err := asRedisMigrationStringMap(mapped["fields"])
			if err != nil {
				return nil, err
			}
			result = append(result, redispkg.StreamEntry{ID: asRedisMigrationString(mapped["id"]), Fields: fields})
		}
		return result, nil
	default:
		return nil, fmt.Errorf("期望 stream 数组，实际=%T", value)
	}
}
