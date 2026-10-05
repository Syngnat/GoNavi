package sync

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	redispkg "GoNavi-Wails/internal/redis"
)

type redisMigrationClient interface {
	Connect(config connection.ConnectionConfig) error
	Close() error
	ScanKeys(pattern string, cursor uint64, count int64) (*redispkg.RedisScanResult, error)
	GetKeyType(key string) (string, error)
	GetValue(key string) (*redispkg.RedisValue, error)
	DeleteKeys(keys []string) (int64, error)
	SetTTL(key string, ttl int64) error
	SetString(key, value string, ttl int64) error
	SetHashField(key, field, value string) error
	ListPush(key string, values ...string) error
	SetAdd(key string, members ...string) error
	ZSetAdd(key string, members ...redispkg.ZSetMember) error
	StreamAdd(key string, fields map[string]string, id string) (string, error)
}

var newSyncDatabase = db.NewDatabase
var newRedisSourceClient = func() redisMigrationClient { return redispkg.NewRedisClient() }

func bindRedisMigrationContext(client redisMigrationClient, ctx context.Context) func() {
	redisClient, ok := client.(redispkg.RedisClient)
	if !ok || ctx == nil {
		return func() {}
	}
	redispkg.BindMetadataContext(redisClient, ctx)
	return func() { redispkg.ClearMetadataContext(redisClient) }
}

func isRedisToMongoKeyspacePair(config SyncConfig) bool {
	return resolveMigrationDBType(config.SourceConfig) == "redis" && resolveMigrationDBType(config.TargetConfig) == "mongodb"
}

func resolveRedisDBIndex(config connection.ConnectionConfig) int {
	if config.RedisDB >= 0 && config.RedisDB <= 15 {
		return config.RedisDB
	}
	if text := strings.TrimSpace(config.Database); text != "" {
		if idx, err := strconv.Atoi(text); err == nil && idx >= 0 && idx <= 15 {
			return idx
		}
	}
	return 0
}

func withResolvedRedisDB(config connection.ConnectionConfig) connection.ConnectionConfig {
	next := config
	next.Type = "redis"
	next.RedisDB = resolveRedisDBIndex(config)
	return next
}

func resolveMongoCollectionName(config SyncConfig) string {
	if name := strings.TrimSpace(config.MongoCollectionName); name != "" {
		return name
	}
	if resolveMigrationDBType(config.SourceConfig) == "redis" {
		return fmt.Sprintf("redis_db_%d_keys", resolveRedisDBIndex(config.SourceConfig))
	}
	return fmt.Sprintf("redis_db_%d_keys", resolveRedisDBIndex(config.TargetConfig))
}

func deriveRedisMongoCollectionName(config SyncConfig) string {
	return resolveMongoCollectionName(config)
}
