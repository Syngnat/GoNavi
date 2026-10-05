package app

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

// RedisGetServerInfo returns server information
func (a *App) RedisGetServerInfo(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	info, err := client.GetServerInfo()
	if err != nil {
		logger.Error(err, "RedisGetServerInfo 获取失败")
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: info}
}

// RedisGetDatabases returns information about all databases
func (a *App) RedisGetDatabases(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	dbs, err := client.GetDatabases()
	if err != nil {
		logger.Error(err, "RedisGetDatabases 获取失败")
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: dbs}
}

// RedisSelectDB selects a database
func (a *App) RedisSelectDB(config connection.ConnectionConfig, dbIndex int) connection.QueryResult {
	config.Type = "redis"
	config.RedisDB = dbIndex
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.SelectDB(dbIndex); err != nil {
		logger.Error(err, "RedisSelectDB 切换失败：db=%d", dbIndex)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.select_db_success", nil)}
}

// RedisRenameKey renames a key
func (a *App) RedisRenameKey(config connection.ConnectionConfig, oldKey, newKey string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.RenameKey(oldKey, newKey); err != nil {
		logger.Error(err, "RedisRenameKey 重命名失败：%s -> %s", oldKey, newKey)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.rename_success", nil)}
}

// RedisKeyExists checks whether a key already exists
func (a *App) RedisKeyExists(config connection.ConnectionConfig, key string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	exists, err := client.KeyExists(key)
	if err != nil {
		logger.Error(err, "RedisKeyExists 检查失败：key=%s", key)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: map[string]bool{"exists": exists}}
}

func localizedRedisArgumentError(text func(string, map[string]any) string, key string, argName string) error {
	if text == nil {
		return fmt.Errorf("%s", key)
	}
	return fmt.Errorf("%s", text(key, map[string]any{"name": argName}))
}

func normalizeRedisStringArgs(raw any, argName string, text func(string, map[string]any) string) ([]string, error) {
	switch v := raw.(type) {
	case nil:
		return nil, localizedRedisArgumentError(text, "redis.backend.error.argument_required", argName)
	case string:
		itemText := strings.TrimSpace(v)
		if itemText == "" {
			return nil, localizedRedisArgumentError(text, "redis.backend.error.argument_required", argName)
		}
		return []string{itemText}, nil
	case []string:
		items := make([]string, 0, len(v))
		for _, item := range v {
			itemText := strings.TrimSpace(item)
			if itemText == "" {
				continue
			}
			items = append(items, itemText)
		}
		if len(items) == 0 {
			return nil, localizedRedisArgumentError(text, "redis.backend.error.argument_required", argName)
		}
		return items, nil
	case []interface{}:
		items := make([]string, 0, len(v))
		for _, item := range v {
			itemText := strings.TrimSpace(fmt.Sprintf("%v", item))
			if itemText == "" || itemText == "<nil>" {
				continue
			}
			items = append(items, itemText)
		}
		if len(items) == 0 {
			return nil, localizedRedisArgumentError(text, "redis.backend.error.argument_required", argName)
		}
		return items, nil
	default:
		return nil, localizedRedisArgumentError(text, "redis.backend.error.argument_invalid_type", argName)
	}
}
