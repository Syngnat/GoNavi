package sync

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	redispkg "GoNavi-Wails/internal/redis"
)

func buildRedisToMongoPlan(config SyncConfig, keyName string, targetDB db.Database) (SchemaMigrationPlan, error) {
	collection := deriveRedisMongoCollectionName(config)
	plan := SchemaMigrationPlan{
		SourceSchema:       strconv.Itoa(resolveRedisDBIndex(config.SourceConfig)),
		SourceTable:        keyName,
		SourceQueryTable:   keyName,
		TargetSchema:       strings.TrimSpace(selectedSyncTargetDatabase(config)),
		TargetTable:        collection,
		TargetQueryTable:   collection,
		PlannedAction:      "按 Redis Key 生成 MongoDB 文档导入",
		Warnings:           []string{"Redis -> MongoDB 按 keyspace 语义迁移，不执行表级 schema 校验", "Redis TTL/集合顺序等语义会按文档字段保留，不保证与原系统完全等价"},
		UnsupportedObjects: []string{"Redis Consumer Group / PubSub / Lua 脚本 / 事务状态当前不迁移"},
	}
	exists, err := inspectMongoCollection(targetDB, plan.TargetSchema, collection)
	if err != nil {
		return plan, fmt.Errorf("检查目标集合失败: %w", err)
	}
	plan.TargetTableExists = exists
	strategy := normalizeTargetTableStrategy(config.TargetTableStrategy)
	if exists {
		return dedupeSchemaMigrationPlan(plan), nil
	}
	if strategy == "existing_only" {
		plan.PlannedAction = "目标集合不存在，需先手工创建"
		plan.Warnings = append(plan.Warnings, "当前策略要求目标集合已存在，执行时不会自动建集合")
		return dedupeSchemaMigrationPlan(plan), nil
	}
	createCommand, err := buildMongoCreateCollectionCommand(collection)
	if err != nil {
		return plan, err
	}
	plan.AutoCreate = true
	plan.PlannedAction = "目标集合不存在，将自动创建集合后导入"
	plan.PreDataSQL = []string{createCommand}
	return dedupeSchemaMigrationPlan(plan), nil
}

func listRedisMigrationKeys(client redisMigrationClient, selected []string) ([]string, error) {
	return listRedisMigrationKeysContext(context.Background(), client, selected)
}

func listRedisMigrationKeysContext(ctx context.Context, client redisMigrationClient, selected []string) ([]string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(selected) > 0 {
		return dedupeStrings(selected), nil
	}
	cursor := uint64(0)
	keys := make([]string, 0, 64)
	seen := map[string]struct{}{}
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		result, err := client.ScanKeys("*", cursor, 1000)
		if err != nil {
			return nil, err
		}
		if result != nil {
			for _, item := range result.Keys {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				key := strings.TrimSpace(item.Key)
				if key == "" {
					continue
				}
				if _, ok := seen[key]; ok {
					continue
				}
				seen[key] = struct{}{}
				keys = append(keys, key)
			}
			if strings.TrimSpace(result.Cursor) == "" || strings.TrimSpace(result.Cursor) == "0" {
				break
			}
			next, err := strconv.ParseUint(strings.TrimSpace(result.Cursor), 10, 64)
			if err != nil || next == cursor {
				break
			}
			cursor = next
			continue
		}
		break
	}
	sort.Strings(keys)
	return keys, nil
}

func buildRedisMongoDocument(dbIndex int, key string, value *redispkg.RedisValue) map[string]interface{} {
	doc := map[string]interface{}{
		"_id":     fmt.Sprintf("db%d:%s", dbIndex, key),
		"redisDb": dbIndex,
		"key":     key,
		"source":  "redis",
	}
	if value == nil {
		return doc
	}
	doc["type"] = value.Type
	doc["ttl"] = value.TTL
	doc["length"] = value.Length
	doc["value"] = normalizeRedisMongoValue(value.Value)
	return doc
}

func normalizeRedisMongoValue(value interface{}) interface{} {
	switch typed := value.(type) {
	case nil:
		return nil
	case []byte:
		return string(typed)
	case map[string]string:
		result := make(map[string]interface{}, len(typed))
		for k, v := range typed {
			result[k] = v
		}
		return result
	case []string:
		result := make([]interface{}, 0, len(typed))
		for _, item := range typed {
			result = append(result, item)
		}
		return result
	case []redispkg.ZSetMember:
		result := make([]map[string]interface{}, 0, len(typed))
		for _, item := range typed {
			result = append(result, map[string]interface{}{"member": item.Member, "score": item.Score})
		}
		return result
	case []redispkg.StreamEntry:
		result := make([]map[string]interface{}, 0, len(typed))
		for _, item := range typed {
			fields := make(map[string]interface{}, len(item.Fields))
			for k, v := range item.Fields {
				fields[k] = v
			}
			result = append(result, map[string]interface{}{"id": item.ID, "fields": fields})
		}
		return result
	case map[string]interface{}:
		result := make(map[string]interface{}, len(typed))
		for k, v := range typed {
			result[k] = normalizeRedisMongoValue(v)
		}
		return result
	case []interface{}:
		result := make([]interface{}, 0, len(typed))
		for _, item := range typed {
			result = append(result, normalizeRedisMongoValue(item))
		}
		return result
	default:
		return typed
	}
}

func buildRedisMongoExistingDocsQuery(collection string, ids []string) (string, error) {
	command := map[string]interface{}{
		"find": collection,
		"filter": map[string]interface{}{
			"_id": map[string]interface{}{"$in": ids},
		},
	}
	data, err := json.Marshal(command)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func loadExistingRedisMongoDocs(targetDB db.Database, collection string, ids []string) (map[string]map[string]interface{}, error) {
	return loadExistingRedisMongoDocsContext(context.Background(), targetDB, collection, ids)
}

func loadExistingRedisMongoDocsContext(ctx context.Context, targetDB db.Database, collection string, ids []string) (map[string]map[string]interface{}, error) {
	result := make(map[string]map[string]interface{}, len(ids))
	if len(ids) == 0 {
		return result, nil
	}
	query, err := buildRedisMongoExistingDocsQuery(collection, ids)
	if err != nil {
		return nil, err
	}
	rows, _, err := querySyncDatabaseContext(ctx, targetDB, query)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		id := strings.TrimSpace(fmt.Sprintf("%v", row["_id"]))
		if id == "" || id == "<nil>" {
			continue
		}
		result[id] = row
	}
	return result, nil
}

func buildRedisMongoChanges(config SyncConfig, keys []string, client redisMigrationClient, targetDB db.Database, collection string) (connection.ChangeSet, []map[string]interface{}, error) {
	return buildRedisMongoChangesContext(context.Background(), config, keys, client, targetDB, collection)
}

func buildRedisMongoChangesContext(ctx context.Context, config SyncConfig, keys []string, client redisMigrationClient, targetDB db.Database, collection string) (connection.ChangeSet, []map[string]interface{}, error) {
	changeSet := connection.ChangeSet{Inserts: []map[string]interface{}{}, Updates: []connection.UpdateRow{}, Deletes: []map[string]interface{}{}}
	documents := make([]map[string]interface{}, 0, len(keys))
	dbIndex := resolveRedisDBIndex(config.SourceConfig)
	for _, key := range keys {
		if err := ctx.Err(); err != nil {
			return changeSet, nil, err
		}
		value, err := client.GetValue(key)
		if err != nil {
			return changeSet, nil, fmt.Errorf("读取 Redis Key 失败: key=%s err=%w", key, err)
		}
		documents = append(documents, buildRedisMongoDocument(dbIndex, key, value))
	}
	ids := make([]string, 0, len(documents))
	for _, doc := range documents {
		ids = append(ids, fmt.Sprintf("%v", doc["_id"]))
	}
	existing, err := loadExistingRedisMongoDocsContext(ctx, targetDB, collection, ids)
	if err != nil {
		return changeSet, nil, err
	}
	mode := normalizeSyncMode(config.Mode)
	for _, doc := range documents {
		if err := ctx.Err(); err != nil {
			return changeSet, nil, err
		}
		id := fmt.Sprintf("%v", doc["_id"])
		existingDoc, ok := existing[id]
		if !ok {
			changeSet.Inserts = append(changeSet.Inserts, doc)
			continue
		}
		if mode == "insert_only" {
			continue
		}
		values := cloneMapWithoutKeys(doc, "_id")
		if sameRedisMongoDocument(existingDoc, doc) {
			continue
		}
		changeSet.Updates = append(changeSet.Updates, connection.UpdateRow{Keys: map[string]interface{}{"_id": id}, Values: values})
	}
	return changeSet, documents, nil
}

func sameRedisMongoDocument(existing map[string]interface{}, desired map[string]interface{}) bool {
	for k, v := range desired {
		if k == "_id" {
			continue
		}
		if fmt.Sprintf("%v", normalizeRedisMongoValue(v)) != fmt.Sprintf("%v", normalizeRedisMongoValue(existing[k])) {
			return false
		}
	}
	return true
}

func cloneMapWithoutKeys(input map[string]interface{}, skipKeys ...string) map[string]interface{} {
	skip := make(map[string]struct{}, len(skipKeys))
	for _, key := range skipKeys {
		skip[key] = struct{}{}
	}
	result := make(map[string]interface{}, len(input))
	for k, v := range input {
		if _, ok := skip[k]; ok {
			continue
		}
		result[k] = v
	}
	return result
}
