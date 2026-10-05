package sync

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"GoNavi-Wails/internal/db"
	redispkg "GoNavi-Wails/internal/redis"
)

func isMongoToRedisKeyspacePair(config SyncConfig) bool {
	return resolveMigrationDBType(config.SourceConfig) == "mongodb" && resolveMigrationDBType(config.TargetConfig) == "redis"
}

type mongoRedisKeyDocument struct {
	Key       string
	Type      string
	TTL       int64
	Value     interface{}
	SourceRow map[string]interface{}
	Desired   *redispkg.RedisValue
}

type mongoRedisKeyDiff struct {
	Collection     string
	Document       mongoRedisKeyDocument
	Current        *redispkg.RedisValue
	Exists         bool
	Action         string
	ChangedColumns []string
}

func deriveRedisTargetLabel(config SyncConfig) string {
	return fmt.Sprintf("Redis DB %d", resolveRedisDBIndex(config.TargetConfig))
}

func deriveDefaultMongoRedisCollection(config SyncConfig) string {
	return resolveMongoCollectionName(config)
}

func listMongoRedisCollections(sourceDB db.Database, config SyncConfig) ([]string, error) {
	return listMongoRedisCollectionsContext(context.Background(), sourceDB, config)
}

func listMongoRedisCollectionsContext(ctx context.Context, sourceDB db.Database, config SyncConfig) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(config.Tables) > 0 {
		return dedupeStrings(config.Tables), nil
	}
	tables, err := sourceDB.GetTables(strings.TrimSpace(selectedSyncSourceDatabase(config)))
	if contextErr := ctx.Err(); contextErr != nil {
		return nil, contextErr
	}
	if err == nil && len(tables) > 0 {
		return dedupeStrings(tables), nil
	}
	return []string{deriveDefaultMongoRedisCollection(config)}, nil
}

func buildMongoRedisFindQuery(collection string, limit int) (string, error) {
	command := map[string]interface{}{
		"find":   strings.TrimSpace(collection),
		"filter": map[string]interface{}{},
	}
	if limit > 0 {
		command["limit"] = limit
	}
	data, err := json.Marshal(command)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func loadMongoRedisDocuments(sourceDB db.Database, collection string, limit int) ([]map[string]interface{}, error) {
	return loadMongoRedisDocumentsContext(context.Background(), sourceDB, collection, limit)
}

func loadMongoRedisDocumentsContext(ctx context.Context, sourceDB db.Database, collection string, limit int) ([]map[string]interface{}, error) {
	query, err := buildMongoRedisFindQuery(collection, limit)
	if err != nil {
		return nil, err
	}
	rows, _, err := querySyncDatabaseContext(ctx, sourceDB, query)
	if err != nil {
		return nil, err
	}
	return rows, nil
}

func parseMongoRedisDocument(row map[string]interface{}) (mongoRedisKeyDocument, error) {
	key := strings.TrimSpace(asRedisMigrationString(row["key"]))
	if key == "" {
		if rawID := strings.TrimSpace(asRedisMigrationString(row["_id"])); rawID != "" {
			if _, tail, ok := strings.Cut(rawID, ":"); ok {
				key = strings.TrimSpace(tail)
			}
		}
	}
	if key == "" {
		return mongoRedisKeyDocument{}, fmt.Errorf("文档缺少 key 字段")
	}

	redisType := strings.ToLower(strings.TrimSpace(asRedisMigrationString(row["type"])))
	if redisType == "" {
		return mongoRedisKeyDocument{}, fmt.Errorf("文档缺少 type 字段: key=%s", key)
	}

	ttl := normalizeRedisMigrationTTL(asRedisMigrationInt64(row["ttl"], -1))
	desired := &redispkg.RedisValue{Type: redisType, TTL: ttl}

	sourceRow := cloneMapWithoutKeys(row)
	sourceRow["key"] = key
	sourceRow["type"] = redisType
	sourceRow["ttl"] = ttl

	switch redisType {
	case "string":
		value := asRedisMigrationString(row["value"])
		desired.Value = value
		desired.Length = int64(len(value))
		sourceRow["value"] = value
	case "hash":
		value, err := asRedisMigrationStringMap(row["value"])
		if err != nil {
			return mongoRedisKeyDocument{}, fmt.Errorf("key=%s hash 值无效: %w", key, err)
		}
		desired.Value = value
		desired.Length = int64(len(value))
		sourceRow["value"] = normalizeRedisMongoValue(value)
	case "list":
		value, err := asRedisMigrationStringSlice(row["value"])
		if err != nil {
			return mongoRedisKeyDocument{}, fmt.Errorf("key=%s list 值无效: %w", key, err)
		}
		desired.Value = value
		desired.Length = int64(len(value))
		sourceRow["value"] = normalizeRedisMongoValue(value)
	case "set":
		value, err := asRedisMigrationStringSlice(row["value"])
		if err != nil {
			return mongoRedisKeyDocument{}, fmt.Errorf("key=%s set 值无效: %w", key, err)
		}
		sort.Strings(value)
		desired.Value = value
		desired.Length = int64(len(value))
		sourceRow["value"] = normalizeRedisMongoValue(value)
	case "zset":
		value, err := asRedisMigrationZSetMembers(row["value"])
		if err != nil {
			return mongoRedisKeyDocument{}, fmt.Errorf("key=%s zset 值无效: %w", key, err)
		}
		sort.Slice(value, func(i, j int) bool {
			if value[i].Score == value[j].Score {
				return value[i].Member < value[j].Member
			}
			return value[i].Score < value[j].Score
		})
		desired.Value = value
		desired.Length = int64(len(value))
		sourceRow["value"] = normalizeRedisMongoValue(value)
	case "stream":
		value, err := asRedisMigrationStreamEntries(row["value"])
		if err != nil {
			return mongoRedisKeyDocument{}, fmt.Errorf("key=%s stream 值无效: %w", key, err)
		}
		sort.Slice(value, func(i, j int) bool { return value[i].ID < value[j].ID })
		desired.Value = value
		desired.Length = int64(len(value))
		sourceRow["value"] = normalizeRedisMongoValue(value)
	default:
		return mongoRedisKeyDocument{}, fmt.Errorf("key=%s 暂不支持 Redis 类型 %s", key, redisType)
	}

	return mongoRedisKeyDocument{Key: key, Type: redisType, TTL: ttl, Value: desired.Value, SourceRow: sourceRow, Desired: desired}, nil
}

func buildMongoToRedisDiffs(sourceDB db.Database, targetClient redisMigrationClient, collection string, mode string) ([]mongoRedisKeyDiff, error) {
	return buildMongoToRedisDiffsContext(context.Background(), sourceDB, targetClient, collection, mode)
}

func buildMongoToRedisDiffsContext(ctx context.Context, sourceDB db.Database, targetClient redisMigrationClient, collection string, mode string) ([]mongoRedisKeyDiff, error) {
	rows, err := loadMongoRedisDocumentsContext(ctx, sourceDB, collection, 0)
	if err != nil {
		return nil, err
	}
	diffs := make([]mongoRedisKeyDiff, 0, len(rows))
	effectiveMode := normalizeSyncMode(mode)
	for _, row := range rows {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		doc, err := parseMongoRedisDocument(row)
		if err != nil {
			return nil, err
		}
		current, exists, err := loadExistingRedisMigrationValueContext(ctx, targetClient, doc.Key)
		if err != nil {
			return nil, fmt.Errorf("读取目标 Redis Key 失败: key=%s err=%w", doc.Key, err)
		}
		action := "insert"
		changedColumns := []string{"type", "ttl", "value"}
		if exists {
			if sameRedisMigrationValue(current, doc.Desired) {
				action = "same"
				changedColumns = nil
			} else if effectiveMode == "insert_only" {
				action = "same"
				changedColumns = nil
			} else {
				action = "update"
				changedColumns = diffRedisMigrationColumns(current, doc.Desired)
			}
		}
		diffs = append(diffs, mongoRedisKeyDiff{
			Collection:     collection,
			Document:       doc,
			Current:        current,
			Exists:         exists,
			Action:         action,
			ChangedColumns: changedColumns,
		})
	}
	sort.Slice(diffs, func(i, j int) bool { return diffs[i].Document.Key < diffs[j].Document.Key })
	return diffs, nil
}

func loadExistingRedisMigrationValue(client redisMigrationClient, key string) (*redispkg.RedisValue, bool, error) {
	return loadExistingRedisMigrationValueContext(context.Background(), client, key)
}

func loadExistingRedisMigrationValueContext(ctx context.Context, client redisMigrationClient, key string) (*redispkg.RedisValue, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	keyType, err := client.GetKeyType(key)
	if err != nil {
		return nil, false, err
	}
	keyType = strings.ToLower(strings.TrimSpace(keyType))
	if keyType == "" || keyType == "none" {
		return nil, false, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	value, err := client.GetValue(key)
	if err != nil {
		return nil, false, err
	}
	if value == nil {
		return nil, false, nil
	}
	value.Type = keyType
	value.TTL = normalizeRedisMigrationTTL(value.TTL)
	return value, true, nil
}

func normalizeRedisMigrationTTL(ttl int64) int64 {
	if ttl > 0 {
		return ttl
	}
	return -1
}

func sameRedisMigrationValue(current *redispkg.RedisValue, desired *redispkg.RedisValue) bool {
	if current == nil || desired == nil {
		return current == nil && desired == nil
	}
	if strings.ToLower(strings.TrimSpace(current.Type)) != strings.ToLower(strings.TrimSpace(desired.Type)) {
		return false
	}
	if normalizeRedisMigrationTTL(current.TTL) != normalizeRedisMigrationTTL(desired.TTL) {
		return false
	}
	return canonicalRedisMigrationValue(current) == canonicalRedisMigrationValue(desired)
}

func canonicalRedisMigrationValue(value *redispkg.RedisValue) string {
	if value == nil {
		return "null"
	}
	payload := map[string]interface{}{
		"type":  strings.ToLower(strings.TrimSpace(value.Type)),
		"ttl":   normalizeRedisMigrationTTL(value.TTL),
		"value": normalizeRedisComparablePayload(strings.ToLower(strings.TrimSpace(value.Type)), value.Value),
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Sprintf("%v", payload)
	}
	return string(data)
}

func normalizeRedisComparablePayload(redisType string, value interface{}) interface{} {
	switch redisType {
	case "string":
		return asRedisMigrationString(value)
	case "hash":
		mapped, err := asRedisMigrationStringMap(value)
		if err != nil {
			return fmt.Sprintf("%v", value)
		}
		return normalizeRedisMongoValue(mapped)
	case "list":
		items, err := asRedisMigrationStringSlice(value)
		if err != nil {
			return fmt.Sprintf("%v", value)
		}
		return normalizeRedisMongoValue(items)
	case "set":
		items, err := asRedisMigrationStringSlice(value)
		if err != nil {
			return fmt.Sprintf("%v", value)
		}
		sort.Strings(items)
		return normalizeRedisMongoValue(items)
	case "zset":
		members, err := asRedisMigrationZSetMembers(value)
		if err != nil {
			return fmt.Sprintf("%v", value)
		}
		sort.Slice(members, func(i, j int) bool {
			if members[i].Score == members[j].Score {
				return members[i].Member < members[j].Member
			}
			return members[i].Score < members[j].Score
		})
		return normalizeRedisMongoValue(members)
	case "stream":
		entries, err := asRedisMigrationStreamEntries(value)
		if err != nil {
			return fmt.Sprintf("%v", value)
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].ID < entries[j].ID })
		return normalizeRedisMongoValue(entries)
	default:
		return normalizeRedisMongoValue(value)
	}
}

func diffRedisMigrationColumns(current *redispkg.RedisValue, desired *redispkg.RedisValue) []string {
	changed := make([]string, 0, 3)
	if current == nil || desired == nil {
		return []string{"type", "ttl", "value"}
	}
	if strings.ToLower(strings.TrimSpace(current.Type)) != strings.ToLower(strings.TrimSpace(desired.Type)) {
		changed = append(changed, "type")
	}
	if normalizeRedisMigrationTTL(current.TTL) != normalizeRedisMigrationTTL(desired.TTL) {
		changed = append(changed, "ttl")
	}
	currentComparable := normalizeRedisComparablePayload(strings.ToLower(strings.TrimSpace(desired.Type)), current.Value)
	desiredComparable := normalizeRedisComparablePayload(strings.ToLower(strings.TrimSpace(desired.Type)), desired.Value)
	currentJSON, _ := json.Marshal(currentComparable)
	desiredJSON, _ := json.Marshal(desiredComparable)
	if string(currentJSON) != string(desiredJSON) {
		changed = append(changed, "value")
	}
	return dedupeStrings(changed)
}

func buildRedisPreviewRow(key string, value *redispkg.RedisValue) map[string]interface{} {
	if value == nil {
		return map[string]interface{}{"key": key}
	}
	return map[string]interface{}{
		"key":   key,
		"type":  strings.ToLower(strings.TrimSpace(value.Type)),
		"ttl":   normalizeRedisMigrationTTL(value.TTL),
		"value": normalizeRedisComparablePayload(strings.ToLower(strings.TrimSpace(value.Type)), value.Value),
	}
}
