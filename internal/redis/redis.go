package redis

import (
	"context"
	"reflect"
	"sync"

	"GoNavi-Wails/internal/connection"
)

var metadataContexts sync.Map

type metadataContextKey struct {
	typ reflect.Type
	ptr uintptr
}

func metadataContextKeyFor(client any) (metadataContextKey, bool) {
	value := reflect.ValueOf(client)
	if !value.IsValid() || value.Kind() != reflect.Ptr || value.IsNil() {
		return metadataContextKey{}, false
	}
	return metadataContextKey{typ: value.Type(), ptr: value.Pointer()}, true
}

// BindMetadataContext 将独立 Redis 客户端与请求上下文关联。
func BindMetadataContext(client RedisClient, ctx context.Context) {
	key, ok := metadataContextKeyFor(client)
	if !ok || ctx == nil {
		return
	}
	metadataContexts.Store(key, ctx)
}

// ClearMetadataContext 移除元数据调用创建的上下文关联。
func ClearMetadataContext(client RedisClient) {
	if key, ok := metadataContextKeyFor(client); ok {
		metadataContexts.Delete(key)
	}
}

// MetadataContext 返回绑定到隔离元数据客户端的请求上下文。
func MetadataContext(client RedisClient) context.Context {
	return metadataContextFor(client)
}

func metadataContextFor(client any) context.Context {
	if key, ok := metadataContextKeyFor(client); ok {
		if ctx, ok := metadataContexts.Load(key); ok {
			if requestCtx, ok := ctx.(context.Context); ok && requestCtx != nil {
				return requestCtx
			}
		}
	}
	return context.Background()
}

// RedisValue represents a Redis value with its type and metadata
type RedisValue struct {
	Type   string      `json:"type"`   // string, hash, list, set, zset, stream
	TTL    int64       `json:"ttl"`    // TTL in seconds, -1 means no expiry, -2 means key doesn't exist
	Value  interface{} `json:"value"`  // The actual value
	Length int64       `json:"length"` // Length/size of the value
}

// RedisDBInfo represents information about a Redis database
type RedisDBInfo struct {
	Index int   `json:"index"` // Database index (single/sentinel: server configured range, cluster: logical 0-15)
	Keys  int64 `json:"keys"`  // Number of keys in this database
}

// RedisKeyInfo represents information about a Redis key
type RedisKeyInfo struct {
	Key  string `json:"key"`
	Type string `json:"type"`
	TTL  int64  `json:"ttl"`
}

// RedisScanResult represents the result of a SCAN operation
type RedisScanResult struct {
	Keys   []RedisKeyInfo `json:"keys"`
	Cursor string         `json:"cursor"`
}

// RedisClient defines the interface for Redis operations
type RedisClient interface {
	// Connection management
	Connect(config connection.ConnectionConfig) error
	Close() error
	Ping() error

	// Key operations
	ScanKeys(pattern string, cursor uint64, count int64) (*RedisScanResult, error)
	GetKeyType(key string) (string, error)
	GetTTL(key string) (int64, error)
	SetTTL(key string, ttl int64) error
	DeleteKeys(keys []string) (int64, error)
	RenameKey(oldKey, newKey string) error
	KeyExists(key string) (bool, error)

	// Value operations
	GetValue(key string) (*RedisValue, error)

	// String operations
	GetString(key string) (string, error)
	SetString(key, value string, ttl int64) error

	// Hash operations
	GetHash(key string) (map[string]string, error)
	SetHashField(key, field, value string) error
	DeleteHashField(key string, fields ...string) error

	// List operations
	GetList(key string, start, stop int64) ([]string, error)
	ListPush(key string, values ...string) error
	ListPushLeft(key string, values ...string) error
	ListSet(key string, index int64, value string) error
	ListRemoveAt(key string, index int64, expectedValue string) error

	// Set operations
	GetSet(key string) ([]string, error)
	SetAdd(key string, members ...string) error
	SetRemove(key string, members ...string) error

	// Sorted Set operations
	GetZSet(key string, start, stop int64) ([]ZSetMember, error)
	ZSetAdd(key string, members ...ZSetMember) error
	ZSetRemove(key string, members ...string) error

	// Stream operations
	GetStream(key, start, stop string, count int64) ([]StreamEntry, error)
	StreamAdd(key string, fields map[string]string, id string) (string, error)
	StreamDelete(key string, ids ...string) (int64, error)

	// Command execution
	ExecuteCommand(args []string) (interface{}, error)

	// Server information
	GetServerInfo() (map[string]string, error)
	GetDatabases() ([]RedisDBInfo, error)
	SelectDB(index int) error
	GetCurrentDB() int
	FlushDB() error
}

// ZSetMember represents a member in a sorted set
type ZSetMember struct {
	Member string  `json:"member"`
	Score  float64 `json:"score"`
}

// StreamEntry represents a single stream message
type StreamEntry struct {
	ID     string            `json:"id"`
	Fields map[string]string `json:"fields"`
}
