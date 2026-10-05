package app

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

// RedisConnect tests a Redis connection
func (a *App) RedisConnect(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "redis"
	_, err := a.getRedisClient(config)
	if err != nil {
		if trustResult, ok := a.sshHostKeyTrustRequiredResult(err); ok {
			logger.Warnf("RedisConnect 需要确认 SSH 服务端身份：%s", formatRedisConnSummary(config))
			return trustResult
		}
		logger.Error(err, "RedisConnect 连接失败：%s", formatRedisConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	logger.Infof("RedisConnect 连接成功：%s", formatRedisConnSummary(config))
	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.connect_success", nil)}
}

// RedisTestConnection tests a Redis connection (alias for RedisConnect)
func (a *App) RedisTestConnection(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "redis"
	client, err := a.openRedisClientIsolated(config)
	if err != nil {
		if trustResult, ok := a.sshHostKeyTrustRequiredResult(err); ok {
			logger.Warnf("RedisTestConnection 需要确认 SSH 服务端身份：%s", formatRedisConnSummary(config))
			return trustResult
		}
		logger.Error(err, "RedisTestConnection 连接失败：%s", formatRedisConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if client != nil {
		if closeErr := client.Close(); closeErr != nil {
			logger.Error(closeErr, "RedisTestConnection 释放临时连接失败：%s", formatRedisConnSummary(config))
			return connection.QueryResult{Success: false, Message: a.appText("redis.backend.error.test_connection_close_failed", map[string]any{"detail": closeErr.Error()})}
		}
	}
	logger.Infof("RedisTestConnection 连接成功：%s", formatRedisConnSummary(config))
	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.connect_success", nil)}
}

// RedisScanKeys scans keys matching a pattern
func (a *App) RedisScanKeys(config connection.ConnectionConfig, pattern string, cursor any, count int64) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	parsedCursor, err := parseRedisScanCursor(cursor)
	if err != nil {
		logger.Warnf("RedisScanKeys 游标解析失败，已回退到起始游标：cursor=%v err=%v", cursor, err)
		parsedCursor = 0
	}

	result, err := client.ScanKeys(pattern, parsedCursor, count)
	if err != nil {
		logger.Error(err, "RedisScanKeys 扫描失败：pattern=%s", pattern)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: result}
}

func parseRedisScanCursor(cursor any) (uint64, error) {
	switch v := cursor.(type) {
	case nil:
		return 0, nil
	case uint64:
		return v, nil
	case uint32:
		return uint64(v), nil
	case uint16:
		return uint64(v), nil
	case uint8:
		return uint64(v), nil
	case uint:
		return uint64(v), nil
	case int64:
		if v < 0 {
			return 0, fmt.Errorf("cursor must not be negative: %d", v)
		}
		return uint64(v), nil
	case int32:
		if v < 0 {
			return 0, fmt.Errorf("cursor must not be negative: %d", v)
		}
		return uint64(v), nil
	case int16:
		if v < 0 {
			return 0, fmt.Errorf("cursor must not be negative: %d", v)
		}
		return uint64(v), nil
	case int8:
		if v < 0 {
			return 0, fmt.Errorf("cursor must not be negative: %d", v)
		}
		return uint64(v), nil
	case int:
		if v < 0 {
			return 0, fmt.Errorf("cursor must not be negative: %d", v)
		}
		return uint64(v), nil
	case float64:
		return parseRedisScanCursorFromFloat(v)
	case float32:
		return parseRedisScanCursorFromFloat(float64(v))
	case json.Number:
		return parseRedisScanCursor(strings.TrimSpace(v.String()))
	case string:
		trimmed := strings.TrimSpace(v)
		if trimmed == "" {
			return 0, nil
		}
		parsed, err := strconv.ParseUint(trimmed, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("invalid cursor: %q", v)
		}
		return parsed, nil
	default:
		return 0, fmt.Errorf("unsupported cursor type: %T", cursor)
	}
}

func parseRedisScanCursorFromFloat(value float64) (uint64, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, fmt.Errorf("invalid float cursor: %v", value)
	}
	if value < 0 {
		return 0, fmt.Errorf("cursor must not be negative: %v", value)
	}
	if math.Trunc(value) != value {
		return 0, fmt.Errorf("cursor must be an integer: %v", value)
	}
	if value > float64(math.MaxUint64) {
		return 0, fmt.Errorf("cursor is out of range: %v", value)
	}
	return uint64(value), nil
}

// RedisGetValue gets the value of a key
func (a *App) RedisGetValue(config connection.ConnectionConfig, key string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	value, err := client.GetValue(key)
	if err != nil {
		logger.Error(err, "RedisGetValue 获取失败：key=%s", key)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: value}
}

// RedisGetListValue gets a list in its requested display order.
func (a *App) RedisGetListValue(config connection.ConnectionConfig, key string, descending bool) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	value, err := client.GetValue(key)
	if err != nil {
		logger.Error(err, "RedisGetListValue 获取失败：key=%s", key)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if value.Type != "list" {
		return connection.QueryResult{Success: false, Message: a.appText("redis.backend.error.argument_invalid_type", map[string]any{"name": "Redis Key"})}
	}

	values, ok := value.Value.([]string)
	if !ok {
		return connection.QueryResult{Success: false, Message: a.appText("redis.backend.error.argument_invalid_type", map[string]any{"name": "Redis List"})}
	}
	if !descending {
		return connection.QueryResult{Success: true, Data: value}
	}

	windowSize := int64(len(values))
	needsTailFetch := value.Length > windowSize
	if windowSize == 0 && value.Length > 0 {
		windowSize = 1000
		if value.Length < windowSize {
			windowSize = value.Length
		}
		needsTailFetch = true
	}
	if needsTailFetch {
		values, err = client.GetList(key, value.Length-windowSize, -1)
		if err != nil {
			logger.Error(err, "RedisGetListValue 获取尾部数据失败：key=%s", key)
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	} else {
		values = append([]string(nil), values...)
	}
	for left, right := 0, len(values)-1; left < right; left, right = left+1, right-1 {
		values[left], values[right] = values[right], values[left]
	}
	value.Value = values

	return connection.QueryResult{Success: true, Data: value}
}

// RedisSetString sets a string value
func (a *App) RedisSetString(config connection.ConnectionConfig, key, value string, ttl int64) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.SetString(key, value, ttl); err != nil {
		logger.Error(err, "RedisSetString 设置失败：key=%s", key)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.set_success", nil)}
}

// RedisSetHashField sets a field in a hash
func (a *App) RedisSetHashField(config connection.ConnectionConfig, key, field, value string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.SetHashField(key, field, value); err != nil {
		logger.Error(err, "RedisSetHashField 设置失败：key=%s field=%s", key, field)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.set_success", nil)}
}

// RedisDeleteKeys deletes one or more keys
func (a *App) RedisDeleteKeys(config connection.ConnectionConfig, keys []string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	deleted, err := client.DeleteKeys(keys)
	if err != nil {
		logger.Error(err, "RedisDeleteKeys 删除失败：keys=%v", keys)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: map[string]int64{"deleted": deleted}}
}

// RedisSetTTL sets the TTL of a key
func (a *App) RedisSetTTL(config connection.ConnectionConfig, key string, ttl int64) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.SetTTL(key, ttl); err != nil {
		logger.Error(err, "RedisSetTTL 设置失败：key=%s ttl=%d", key, ttl)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.set_success", nil)}
}
