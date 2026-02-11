package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"sync"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/redis"
)

// Redis client cache
var (
	redisCache   = make(map[string]redis.RedisClient)
	redisCacheMu sync.Mutex
)

// getRedisClient gets or creates a Redis client from cache
func (a *App) getRedisClient(config connection.ConnectionConfig) (redis.RedisClient, error) {
	key := getRedisClientCacheKey(config)
	shortKey := key
	if len(shortKey) > 12 {
		shortKey = shortKey[:12]
	}
	logger.Infof("获取 Redis 连接：%s 缓存Key=%s", formatRedisConnSummary(config), shortKey)

	redisCacheMu.Lock()
	defer redisCacheMu.Unlock()

	if client, ok := redisCache[key]; ok {
		logger.Infof("命中 Redis 连接缓存，开始检测可用性：缓存Key=%s", shortKey)
		if err := client.Ping(); err == nil {
			logger.Infof("缓存 Redis 连接可用：缓存Key=%s", shortKey)
			return client, nil
		} else {
			logger.Error(err, "缓存 Redis 连接不可用，准备重建：缓存Key=%s", shortKey)
		}
		client.Close()
		delete(redisCache, key)
	}

	logger.Infof("创建 Redis 客户端实例：缓存Key=%s", shortKey)
	client := redis.NewRedisClient()
	if err := client.Connect(config); err != nil {
		logger.Error(err, "Redis 连接失败：%s 缓存Key=%s", formatRedisConnSummary(config), shortKey)
		return nil, err
	}

	redisCache[key] = client
	logger.Infof("Redis 连接成功并写入缓存：%s 缓存Key=%s", formatRedisConnSummary(config), shortKey)
	return client, nil
}

func getRedisClientCacheKey(config connection.ConnectionConfig) string {
	if !config.UseSSH {
		config.SSH = connection.SSHConfig{}
	}
	b, _ := json.Marshal(config)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func formatRedisConnSummary(config connection.ConnectionConfig) string {
	timeoutSeconds := config.Timeout
	if timeoutSeconds <= 0 {
		timeoutSeconds = 30
	}

	var b strings.Builder
	b.WriteString("类型=redis 地址=")
	b.WriteString(config.Host)
	b.WriteString(":")
	b.WriteString(string(rune(config.Port + '0')))
	b.WriteString(" DB=")
	b.WriteString(string(rune(config.RedisDB + '0')))

	if config.UseSSH {
		b.WriteString(" SSH=")
		b.WriteString(config.SSH.Host)
		b.WriteString(":")
		b.WriteString(string(rune(config.SSH.Port + '0')))
		b.WriteString(" 用户=")
		b.WriteString(config.SSH.User)
	}

	return b.String()
}

// RedisConnect tests a Redis connection
func (a *App) RedisConnect(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "redis"
	_, err := a.getRedisClient(config)
	if err != nil {
		logger.Error(err, "RedisConnect 连接失败：%s", formatRedisConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	logger.Infof("RedisConnect 连接成功：%s", formatRedisConnSummary(config))
	return connection.QueryResult{Success: true, Message: "连接成功"}
}

// RedisTestConnection tests a Redis connection (alias for RedisConnect)
func (a *App) RedisTestConnection(config connection.ConnectionConfig) connection.QueryResult {
	return a.RedisConnect(config)
}

// RedisScanKeys scans keys matching a pattern
func (a *App) RedisScanKeys(config connection.ConnectionConfig, pattern string, cursor uint64, count int64) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	result, err := client.ScanKeys(pattern, cursor, count)
	if err != nil {
		logger.Error(err, "RedisScanKeys 扫描失败：pattern=%s", pattern)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: result}
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

	return connection.QueryResult{Success: true, Message: "设置成功"}
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

	return connection.QueryResult{Success: true, Message: "设置成功"}
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

	return connection.QueryResult{Success: true, Message: "设置成功"}
}

// RedisExecuteCommand executes a raw Redis command
func (a *App) RedisExecuteCommand(config connection.ConnectionConfig, command string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	// Parse command string into args
	args := parseRedisCommand(command)
	if len(args) == 0 {
		return connection.QueryResult{Success: false, Message: "命令不能为空"}
	}

	result, err := client.ExecuteCommand(args)
	if err != nil {
		logger.Error(err, "RedisExecuteCommand 执行失败：command=%s", command)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: result}
}

// parseRedisCommand parses a Redis command string into arguments
func parseRedisCommand(command string) []string {
	command = strings.TrimSpace(command)
	if command == "" {
		return nil
	}

	var args []string
	var current strings.Builder
	inQuote := false
	quoteChar := rune(0)

	for _, ch := range command {
		if inQuote {
			if ch == quoteChar {
				inQuote = false
				args = append(args, current.String())
				current.Reset()
			} else {
				current.WriteRune(ch)
			}
		} else {
			if ch == '"' || ch == '\'' {
				inQuote = true
				quoteChar = ch
			} else if ch == ' ' || ch == '\t' {
				if current.Len() > 0 {
					args = append(args, current.String())
					current.Reset()
				}
			} else {
				current.WriteRune(ch)
			}
		}
	}

	if current.Len() > 0 {
		args = append(args, current.String())
	}

	return args
}

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

	return connection.QueryResult{Success: true, Message: "切换成功"}
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

	return connection.QueryResult{Success: true, Message: "重命名成功"}
}

// RedisDeleteHashField deletes fields from a hash
func (a *App) RedisDeleteHashField(config connection.ConnectionConfig, key string, fields []string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.DeleteHashField(key, fields...); err != nil {
		logger.Error(err, "RedisDeleteHashField 删除失败：key=%s fields=%v", key, fields)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: "删除成功"}
}

// RedisListPush pushes values to a list
func (a *App) RedisListPush(config connection.ConnectionConfig, key string, values []string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.ListPush(key, values...); err != nil {
		logger.Error(err, "RedisListPush 添加失败：key=%s", key)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: "添加成功"}
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

	return connection.QueryResult{Success: true, Message: "设置成功"}
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

	return connection.QueryResult{Success: true, Message: "添加成功"}
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

	return connection.QueryResult{Success: true, Message: "删除成功"}
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

	return connection.QueryResult{Success: true, Message: "添加成功"}
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

	return connection.QueryResult{Success: true, Message: "删除成功"}
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

	return connection.QueryResult{Success: true, Message: "添加成功", Data: map[string]string{"id": newID}}
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

	return connection.QueryResult{Success: true, Message: "删除成功", Data: map[string]int64{"deleted": deleted}}
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

	return connection.QueryResult{Success: true, Message: "清空成功"}
}

// CloseAllRedisClients closes all cached Redis clients (called on shutdown)
func CloseAllRedisClients() {
	redisCacheMu.Lock()
	defer redisCacheMu.Unlock()

	for key, client := range redisCache {
		if client != nil {
			client.Close()
			logger.Infof("已关闭 Redis 连接：%s", key[:12])
		}
	}
	redisCache = make(map[string]redis.RedisClient)
}
