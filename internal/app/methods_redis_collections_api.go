package app

import (
	"errors"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/redis"
)

// RedisDeleteHashField deletes fields from a hash
func (a *App) RedisDeleteHashField(config connection.ConnectionConfig, key string, fields any) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	normalizedFields, err := normalizeRedisStringArgs(fields, "fields", a.appText)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.DeleteHashField(key, normalizedFields...); err != nil {
		logger.Error(err, "RedisDeleteHashField 删除失败：key=%s fields=%v", key, normalizedFields)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.delete_success", nil)}
}

// RedisListPush pushes values to a list
func (a *App) RedisListPush(config connection.ConnectionConfig, key string, options RedisListPushOptions) connection.QueryResult {
	if len(options.Values) == 0 {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("redis.backend.error.argument_required", map[string]any{"name": "values"}),
		}
	}
	if options.Position != "left" && options.Position != "right" {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("redis.backend.error.list_position_invalid", nil),
		}
	}

	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	push := client.ListPush
	if options.Position == "left" {
		push = client.ListPushLeft
	}
	if err := push(key, options.Values...); err != nil {
		logger.Error(err, "RedisListPush 添加失败：key=%s", key)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.add_success", nil)}
}

// RedisListSet sets a value at an index in a list
func (a *App) RedisListSet(config connection.ConnectionConfig, key string, index int64, value string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.ListSet(key, index, value); err != nil {
		logger.Error(err, "RedisListSet 设置失败：key=%s index=%d", key, index)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.set_success", nil)}
}

// RedisListRemove removes the expected value at an index in a list.
func (a *App) RedisListRemove(config connection.ConnectionConfig, key string, index int64, value string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.ListRemoveAt(key, index, value); err != nil {
		if errors.Is(err, redis.ErrRedisListItemChanged) {
			return connection.QueryResult{
				Success: false,
				Message: a.appText("redis.backend.error.list_item_changed", nil),
			}
		}
		logger.Error(err, "RedisListRemove 删除失败：key=%s index=%d", key, index)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.delete_success", nil)}
}

// RedisSetAdd adds members to a set
func (a *App) RedisSetAdd(config connection.ConnectionConfig, key string, members []string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.SetAdd(key, members...); err != nil {
		logger.Error(err, "RedisSetAdd 添加失败：key=%s", key)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.add_success", nil)}
}

// RedisSetRemove removes members from a set
func (a *App) RedisSetRemove(config connection.ConnectionConfig, key string, members []string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.SetRemove(key, members...); err != nil {
		logger.Error(err, "RedisSetRemove 删除失败：key=%s", key)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.delete_success", nil)}
}

// RedisZSetAdd adds members to a sorted set
func (a *App) RedisZSetAdd(config connection.ConnectionConfig, key string, members []redis.ZSetMember) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.ZSetAdd(key, members...); err != nil {
		logger.Error(err, "RedisZSetAdd 添加失败：key=%s", key)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.add_success", nil)}
}

// RedisZSetRemove removes members from a sorted set
func (a *App) RedisZSetRemove(config connection.ConnectionConfig, key string, members []string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.ZSetRemove(key, members...); err != nil {
		logger.Error(err, "RedisZSetRemove 删除失败：key=%s", key)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.delete_success", nil)}
}

// RedisStreamAdd adds an entry to a stream
func (a *App) RedisStreamAdd(config connection.ConnectionConfig, key string, fields map[string]string, id string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	newID, err := client.StreamAdd(key, fields, id)
	if err != nil {
		logger.Error(err, "RedisStreamAdd 添加失败：key=%s id=%s", key, id)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.add_success", nil), Data: map[string]string{"id": newID}}
}

// RedisStreamDelete deletes stream entries by IDs
func (a *App) RedisStreamDelete(config connection.ConnectionConfig, key string, ids []string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	deleted, err := client.StreamDelete(key, ids...)
	if err != nil {
		logger.Error(err, "RedisStreamDelete 删除失败：key=%s ids=%v", key, ids)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.delete_success", nil), Data: map[string]int64{"deleted": deleted}}
}

// RedisFlushDB flushes the current database
func (a *App) RedisFlushDB(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.FlushDB(); err != nil {
		logger.Error(err, "RedisFlushDB 清空失败")
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.flush_success", nil)}
}
