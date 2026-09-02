package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	redispkg "GoNavi-Wails/internal/redis"
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
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

func (s *SyncEngine) runRedisToMongoSync(config SyncConfig, result SyncResult) SyncResult {
	tables := config.Tables
	strategy := normalizeTargetTableStrategy(config.TargetTableStrategy)
	mode := normalizeSyncMode(config.Mode)
	s.progress(config.JobID, 0, len(tables), "", "开始 Redis 键空间迁移")
	s.appendLog(config.JobID, &result, "info", fmt.Sprintf("Redis -> MongoDB 键空间迁移；模式：%s；目标策略：%s", mode, strategy))
	if mode == "full_overwrite" {
		s.appendLog(config.JobID, &result, "warn", "Redis -> MongoDB 第一版暂不执行集合级 full_overwrite 删除，已降级为 insert_update")
	}

	sourceClient := newRedisSourceClient()
	sourceConfig := withResolvedRedisDB(config.SourceConfig)
	if err := sourceClient.Connect(sourceConfig); err != nil {
		return s.fail(config.JobID, len(tables), result, "源 Redis 连接失败: "+err.Error())
	}
	defer sourceClient.Close()

	targetDB, err := newSyncDatabase(config.TargetConfig.Type)
	if err != nil {
		return s.fail(config.JobID, len(tables), result, "初始化目标数据库驱动失败: "+err.Error())
	}
	if err := targetDB.Connect(config.TargetConfig); err != nil {
		return s.fail(config.JobID, len(tables), result, "目标数据库连接失败: "+err.Error())
	}
	defer targetDB.Close()

	keys, err := listRedisMigrationKeys(sourceClient, config.Tables)
	if err != nil {
		return s.fail(config.JobID, len(tables), result, "扫描 Redis Key 失败: "+err.Error())
	}
	if len(keys) == 0 {
		result.Message = "未发现可迁移的 Redis Key"
		s.progress(config.JobID, 0, 0, "", "同步完成")
		return result
	}
	totalKeys := len(keys)
	collection := deriveRedisMongoCollectionName(config)
	plan, err := buildRedisToMongoPlan(config, firstNonEmpty(keys[0], collection), targetDB)
	if err != nil {
		return s.fail(config.JobID, totalKeys, result, err.Error())
	}
	for _, warning := range plan.Warnings {
		s.appendLog(config.JobID, &result, "warn", "  -> "+warning)
	}
	for _, unsupported := range plan.UnsupportedObjects {
		s.appendLog(config.JobID, &result, "warn", "  -> "+unsupported)
	}
	if strings.TrimSpace(plan.PlannedAction) != "" {
		s.appendLog(config.JobID, &result, "info", "  -> "+plan.PlannedAction)
	}
	if !plan.TargetTableExists && !plan.AutoCreate {
		result.Message = firstNonEmpty(plan.PlannedAction, "目标集合不存在，当前策略不允许自动创建")
		return result
	}
	if !plan.TargetTableExists && len(plan.PreDataSQL) > 0 {
		s.progress(config.JobID, 0, totalKeys, collection, "创建目标集合")
		if err := executeSQLStatements(targetDB.Exec, plan.PreDataSQL); err != nil {
			return s.fail(config.JobID, totalKeys, result, "创建目标集合失败: "+err.Error())
		}
	}

	changeSet, documents, err := buildRedisMongoChanges(config, keys, sourceClient, targetDB, collection)
	if err != nil {
		return s.fail(config.JobID, totalKeys, result, "构建 Redis 迁移变更失败: "+err.Error())
	}
	for idx, key := range keys {
		s.appendLog(config.JobID, &result, "info", fmt.Sprintf("正在迁移 Key: %s", key))
		s.progress(config.JobID, idx, totalKeys, key, fmt.Sprintf("迁移 Key(%d/%d)", idx+1, totalKeys))
	}
	if len(changeSet.Inserts) == 0 && len(changeSet.Updates) == 0 && len(changeSet.Deletes) == 0 {
		s.appendLog(config.JobID, &result, "info", "  -> 目标集合中对应文档已是最新状态")
		result.TablesSynced = totalKeys
		result.Message = fmt.Sprintf("Redis 键空间迁移完成，共处理 %d 个 Key", totalKeys)
		s.progress(config.JobID, totalKeys, totalKeys, collection, "同步完成")
		return result
	}
	applier, ok := targetDB.(db.BatchApplier)
	if !ok {
		return s.fail(config.JobID, totalKeys, result, "目标驱动不支持 MongoDB 文档写入")
	}
	_ = documents
	if err := applier.ApplyChanges(collection, changeSet); err != nil {
		return s.fail(config.JobID, totalKeys, result, "应用 Redis 迁移变更失败: "+err.Error())
	}
	result.RowsInserted += len(changeSet.Inserts)
	result.RowsUpdated += len(changeSet.Updates)
	result.RowsDeleted += len(changeSet.Deletes)
	result.TablesSynced = totalKeys
	result.Message = fmt.Sprintf("Redis 键空间迁移完成，共处理 %d 个 Key", totalKeys)
	s.progress(config.JobID, totalKeys, totalKeys, collection, "同步完成")
	return result
}

func (s *SyncEngine) analyzeRedisToMongo(config SyncConfig) SyncAnalyzeResult {
	// Keyspace migration compares documents, never table structure. Pin the
	// echoed content to "data" so the UI renders the row counts below instead of
	// falling back to the task's compareMode and hiding them under a schema-only
	// view that this analyzer never populates.
	result := SyncAnalyzeResult{Success: true, Content: "data", Tables: []TableDiffSummary{}}
	cancelledResult := func() SyncAnalyzeResult {
		result.Success = false
		result.Message = s.contextError().Error()
		return result
	}
	sourceClient := newRedisSourceClient()
	sourceConfig := withResolvedRedisDB(config.SourceConfig)
	if err := sourceClient.Connect(sourceConfig); err != nil {
		if s.contextError() != nil {
			return cancelledResult()
		}
		return SyncAnalyzeResult{Success: false, Message: "源 Redis 连接失败: " + err.Error()}
	}
	defer sourceClient.Close()
	if s.contextError() != nil {
		return cancelledResult()
	}
	clearRedisContext := bindRedisMigrationContext(sourceClient, s.context())
	defer clearRedisContext()
	targetDB, err := newSyncDatabase(config.TargetConfig.Type)
	if err != nil {
		return SyncAnalyzeResult{Success: false, Message: "初始化目标数据库驱动失败: " + err.Error()}
	}
	if err := targetDB.Connect(config.TargetConfig); err != nil {
		if s.contextError() != nil {
			return cancelledResult()
		}
		return SyncAnalyzeResult{Success: false, Message: "目标数据库连接失败: " + err.Error()}
	}
	defer targetDB.Close()
	if s.contextError() != nil {
		return cancelledResult()
	}
	db.BindMetadataContext(targetDB, s.context())
	defer db.ClearMetadataContext(targetDB)
	keys, err := listRedisMigrationKeysContext(s.context(), sourceClient, config.Tables)
	if err != nil {
		if s.contextError() != nil {
			return cancelledResult()
		}
		return SyncAnalyzeResult{Success: false, Message: "扫描 Redis Key 失败: " + err.Error()}
	}
	collection := deriveRedisMongoCollectionName(config)
	changeSet, documents, err := buildRedisMongoChangesContext(s.context(), config, keys, sourceClient, targetDB, collection)
	if err != nil {
		if s.contextError() != nil {
			return cancelledResult()
		}
		return SyncAnalyzeResult{Success: false, Message: "分析 Redis 迁移变更失败: " + err.Error()}
	}
	insertSet := make(map[string]struct{}, len(changeSet.Inserts))
	updateSet := make(map[string]struct{}, len(changeSet.Updates))
	for _, row := range changeSet.Inserts {
		insertSet[fmt.Sprintf("%v", row["_id"])] = struct{}{}
	}
	for _, row := range changeSet.Updates {
		updateSet[fmt.Sprintf("%v", row.Keys["_id"])] = struct{}{}
	}
	for _, doc := range documents {
		if s.contextError() != nil {
			return cancelledResult()
		}
		key := fmt.Sprintf("%v", doc["key"])
		id := fmt.Sprintf("%v", doc["_id"])
		summary := TableDiffSummary{
			Table:             key,
			PKColumn:          "_id",
			CanSync:           true,
			TargetTableExists: true,
			PlannedAction:     fmt.Sprintf("迁移到集合 %s", collection),
			Warnings: []string{
				"Redis Key 将按文档写入 MongoDB 集合",
			},
		}
		if _, ok := insertSet[id]; ok {
			summary.Inserts = 1
			summary.Message = "执行时将写入新文档"
		} else if _, ok := updateSet[id]; ok {
			summary.Updates = 1
			summary.Message = "执行时将更新已有文档"
		} else {
			summary.Same = 1
			summary.Message = "目标集合中对应文档已是最新状态"
		}
		result.Tables = append(result.Tables, summary)
	}
	result.Message = fmt.Sprintf("已完成 %d 个 Redis Key 的迁移分析", len(result.Tables))
	return result
}

func (s *SyncEngine) previewRedisToMongo(config SyncConfig, keyName string, limit int) (TableDiffPreview, error) {
	_ = limit
	sourceClient := newRedisSourceClient()
	sourceConfig := withResolvedRedisDB(config.SourceConfig)
	if err := sourceClient.Connect(sourceConfig); err != nil {
		if contextErr := s.contextError(); contextErr != nil {
			return TableDiffPreview{}, contextErr
		}
		return TableDiffPreview{}, fmt.Errorf("源 Redis 连接失败: %w", err)
	}
	defer sourceClient.Close()
	if err := s.contextError(); err != nil {
		return TableDiffPreview{}, err
	}
	clearRedisContext := bindRedisMigrationContext(sourceClient, s.context())
	defer clearRedisContext()
	targetDB, err := newSyncDatabase(config.TargetConfig.Type)
	if err != nil {
		return TableDiffPreview{}, fmt.Errorf("初始化目标数据库驱动失败: %w", err)
	}
	if err := targetDB.Connect(config.TargetConfig); err != nil {
		if contextErr := s.contextError(); contextErr != nil {
			return TableDiffPreview{}, contextErr
		}
		return TableDiffPreview{}, fmt.Errorf("目标数据库连接失败: %w", err)
	}
	defer targetDB.Close()
	if err := s.contextError(); err != nil {
		return TableDiffPreview{}, err
	}
	db.BindMetadataContext(targetDB, s.context())
	defer db.ClearMetadataContext(targetDB)
	collection := deriveRedisMongoCollectionName(config)
	changeSet, documents, err := buildRedisMongoChangesContext(s.context(), config, []string{keyName}, sourceClient, targetDB, collection)
	if err != nil {
		return TableDiffPreview{}, err
	}
	preview := TableDiffPreview{Table: keyName, PKColumn: "_id", Inserts: []PreviewRow{}, Updates: []PreviewUpdateRow{}, Deletes: []PreviewRow{}}
	if len(documents) == 0 {
		return preview, nil
	}
	doc := documents[0]
	id := fmt.Sprintf("%v", doc["_id"])
	existingDocs, err := loadExistingRedisMongoDocsContext(s.context(), targetDB, collection, []string{id})
	if err != nil {
		return TableDiffPreview{}, err
	}
	if len(changeSet.Inserts) > 0 {
		preview.TotalInserts = 1
		preview.Inserts = append(preview.Inserts, PreviewRow{PK: id, Row: doc})
		return preview, nil
	}
	if len(changeSet.Updates) > 0 {
		preview.TotalUpdates = 1
		preview.Updates = append(preview.Updates, PreviewUpdateRow{PK: id, ChangedColumns: sortedMapKeys(changeSet.Updates[0].Values), Source: doc, Target: existingDocs[id]})
		return preview, nil
	}
	return preview, nil
}

func sortedMapKeys(values map[string]interface{}) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

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

func (s *SyncEngine) runMongoToRedisSync(config SyncConfig, result SyncResult) SyncResult {
	collections := dedupeStrings(config.Tables)
	sourceDB, err := newSyncDatabase(config.SourceConfig.Type)
	if err != nil {
		return s.fail(config.JobID, len(collections), result, "初始化源数据库驱动失败: "+err.Error())
	}
	if err := sourceDB.Connect(config.SourceConfig); err != nil {
		return s.fail(config.JobID, len(collections), result, "源 MongoDB 连接失败: "+err.Error())
	}
	defer sourceDB.Close()
	if len(collections) == 0 {
		collections, err = listMongoRedisCollections(sourceDB, config)
		if err != nil {
			return s.fail(config.JobID, 0, result, "获取 MongoDB 集合列表失败: "+err.Error())
		}
	}
	if len(collections) == 0 {
		result.Message = "未发现可迁移的 MongoDB 集合"
		s.progress(config.JobID, 0, 0, "", "同步完成")
		return result
	}

	effectiveMode := normalizeSyncMode(config.Mode)
	totalCollections := len(collections)
	s.progress(config.JobID, 0, totalCollections, "", "开始 MongoDB 键空间迁移")
	s.appendLog(config.JobID, &result, "info", fmt.Sprintf("MongoDB -> Redis 键空间迁移；模式：%s；目标：%s", effectiveMode, deriveRedisTargetLabel(config)))
	s.appendLog(config.JobID, &result, "warn", "MongoDB -> Redis 第一版仅支持固定文档格式：key/type/ttl/value")
	if effectiveMode == "full_overwrite" {
		s.appendLog(config.JobID, &result, "warn", "MongoDB -> Redis 第一版暂不执行 Redis DB 级 full_overwrite 删除，已降级为 insert_update")
		effectiveMode = "insert_update"
	}

	targetClient := newRedisSourceClient()
	targetConfig := withResolvedRedisDB(config.TargetConfig)
	if err := targetClient.Connect(targetConfig); err != nil {
		return s.fail(config.JobID, totalCollections, result, "目标 Redis 连接失败: "+err.Error())
	}
	defer targetClient.Close()

	processedKeys := 0
	for idx, collection := range collections {
		s.appendLog(config.JobID, &result, "info", fmt.Sprintf("正在同步集合: %s", collection))
		s.progress(config.JobID, idx, totalCollections, collection, fmt.Sprintf("迁移集合(%d/%d)", idx+1, totalCollections))
		diffs, err := buildMongoToRedisDiffs(sourceDB, targetClient, collection, effectiveMode)
		if err != nil {
			return s.fail(config.JobID, totalCollections, result, fmt.Sprintf("分析集合 %s 失败: %v", collection, err))
		}
		for _, diff := range diffs {
			processedKeys++
			if diff.Action == "same" {
				continue
			}
			s.appendLog(config.JobID, &result, "info", fmt.Sprintf("正在迁移 Key: %s", diff.Document.Key))
			if err := applyMongoRedisDiff(targetClient, diff); err != nil {
				return s.fail(config.JobID, totalCollections, result, fmt.Sprintf("写入 Redis Key %s 失败: %v", diff.Document.Key, err))
			}
			switch diff.Action {
			case "insert":
				result.RowsInserted++
			case "update":
				result.RowsUpdated++
			}
		}
		result.TablesSynced++
		s.progress(config.JobID, idx+1, totalCollections, collection, "集合处理完成")
	}

	if processedKeys == 0 {
		result.Message = "未发现可迁移的 MongoDB Redis 文档"
		return result
	}
	result.Message = fmt.Sprintf("MongoDB 键空间迁移完成，共处理 %d 个集合、%d 个 Key", result.TablesSynced, processedKeys)
	return result
}

func (s *SyncEngine) analyzeMongoToRedis(config SyncConfig) SyncAnalyzeResult {
	// See analyzeRedisToMongo: keyspace migration is data-only, so pin the
	// echoed content rather than letting the UI fall back to compareMode.
	result := SyncAnalyzeResult{Success: true, Content: "data", Tables: []TableDiffSummary{}}
	cancelledResult := func() SyncAnalyzeResult {
		result.Success = false
		result.Message = s.contextError().Error()
		return result
	}
	sourceDB, err := newSyncDatabase(config.SourceConfig.Type)
	if err != nil {
		return SyncAnalyzeResult{Success: false, Message: "初始化源数据库驱动失败: " + err.Error()}
	}
	if err := sourceDB.Connect(config.SourceConfig); err != nil {
		if s.contextError() != nil {
			return cancelledResult()
		}
		return SyncAnalyzeResult{Success: false, Message: "源 MongoDB 连接失败: " + err.Error()}
	}
	defer sourceDB.Close()
	if s.contextError() != nil {
		return cancelledResult()
	}
	db.BindMetadataContext(sourceDB, s.context())
	defer db.ClearMetadataContext(sourceDB)

	collections, err := listMongoRedisCollectionsContext(s.context(), sourceDB, config)
	if err != nil {
		if s.contextError() != nil {
			return cancelledResult()
		}
		return SyncAnalyzeResult{Success: false, Message: "获取 MongoDB 集合列表失败: " + err.Error()}
	}

	effectiveMode := normalizeSyncMode(config.Mode)
	modeWarning := ""
	if effectiveMode == "full_overwrite" {
		modeWarning = "MongoDB -> Redis 第一版会将 full_overwrite 降级为 insert_update，避免误删 DB 内其他 Key"
		effectiveMode = "insert_update"
	}

	targetClient := newRedisSourceClient()
	targetConfig := withResolvedRedisDB(config.TargetConfig)
	if err := targetClient.Connect(targetConfig); err != nil {
		if s.contextError() != nil {
			return cancelledResult()
		}
		return SyncAnalyzeResult{Success: false, Message: "目标 Redis 连接失败: " + err.Error()}
	}
	defer targetClient.Close()
	if s.contextError() != nil {
		return cancelledResult()
	}
	clearRedisContext := bindRedisMigrationContext(targetClient, s.context())
	defer clearRedisContext()

	for _, collection := range collections {
		if s.contextError() != nil {
			return cancelledResult()
		}
		summary := TableDiffSummary{
			Table:             collection,
			PKColumn:          "key",
			CanSync:           true,
			TargetTableExists: true,
			PlannedAction:     fmt.Sprintf("迁移到 %s", deriveRedisTargetLabel(config)),
			Warnings: []string{
				"MongoDB 集合中的文档会按 keyspace 语义写入 Redis",
				"当前仅支持固定文档格式：key/type/ttl/value",
			},
		}
		if modeWarning != "" {
			summary.Warnings = append(summary.Warnings, modeWarning)
		}
		diffs, err := buildMongoToRedisDiffsContext(s.context(), sourceDB, targetClient, collection, effectiveMode)
		if err != nil {
			if s.contextError() != nil {
				return cancelledResult()
			}
			summary.CanSync = false
			summary.Message = err.Error()
			result.Tables = append(result.Tables, summary)
			continue
		}
		for _, diff := range diffs {
			switch diff.Action {
			case "insert":
				summary.Inserts++
			case "update":
				summary.Updates++
			default:
				summary.Same++
			}
		}
		if summary.Inserts == 0 && summary.Updates == 0 {
			if summary.Same == 0 {
				summary.Message = "集合中未发现可迁移文档"
			} else {
				summary.Message = "目标 Redis 中对应 Key 已是最新状态"
			}
		} else {
			summary.Message = fmt.Sprintf("执行时将写入 %d 个新 Key、更新 %d 个已有 Key", summary.Inserts, summary.Updates)
		}
		result.Tables = append(result.Tables, summary)
	}
	result.Message = fmt.Sprintf("已完成 %d 个 MongoDB 集合的 Redis 迁移分析", len(result.Tables))
	return result
}

func (s *SyncEngine) previewMongoToRedis(config SyncConfig, collection string, limit int) (TableDiffPreview, error) {
	sourceDB, err := newSyncDatabase(config.SourceConfig.Type)
	if err != nil {
		return TableDiffPreview{}, fmt.Errorf("初始化源数据库驱动失败: %w", err)
	}
	if err := sourceDB.Connect(config.SourceConfig); err != nil {
		if contextErr := s.contextError(); contextErr != nil {
			return TableDiffPreview{}, contextErr
		}
		return TableDiffPreview{}, fmt.Errorf("源 MongoDB 连接失败: %w", err)
	}
	defer sourceDB.Close()
	if err := s.contextError(); err != nil {
		return TableDiffPreview{}, err
	}
	db.BindMetadataContext(sourceDB, s.context())
	defer db.ClearMetadataContext(sourceDB)

	targetClient := newRedisSourceClient()
	targetConfig := withResolvedRedisDB(config.TargetConfig)
	if err := targetClient.Connect(targetConfig); err != nil {
		if contextErr := s.contextError(); contextErr != nil {
			return TableDiffPreview{}, contextErr
		}
		return TableDiffPreview{}, fmt.Errorf("目标 Redis 连接失败: %w", err)
	}
	defer targetClient.Close()
	if err := s.contextError(); err != nil {
		return TableDiffPreview{}, err
	}
	clearRedisContext := bindRedisMigrationContext(targetClient, s.context())
	defer clearRedisContext()

	effectiveMode := normalizeSyncMode(config.Mode)
	if effectiveMode == "full_overwrite" {
		effectiveMode = "insert_update"
	}

	diffs, err := buildMongoToRedisDiffsContext(s.context(), sourceDB, targetClient, collection, effectiveMode)
	if err != nil {
		return TableDiffPreview{}, err
	}
	preview := TableDiffPreview{Table: collection, PKColumn: "key", Inserts: []PreviewRow{}, Updates: []PreviewUpdateRow{}, Deletes: []PreviewRow{}}
	for _, diff := range diffs {
		if err := s.contextError(); err != nil {
			return TableDiffPreview{}, err
		}
		switch diff.Action {
		case "insert":
			preview.TotalInserts++
			if len(preview.Inserts) < limit {
				preview.Inserts = append(preview.Inserts, PreviewRow{PK: diff.Document.Key, Row: diff.Document.SourceRow})
			}
		case "update":
			preview.TotalUpdates++
			if len(preview.Updates) < limit {
				preview.Updates = append(preview.Updates, PreviewUpdateRow{PK: diff.Document.Key, ChangedColumns: diff.ChangedColumns, Source: diff.Document.SourceRow, Target: buildRedisPreviewRow(diff.Document.Key, diff.Current)})
			}
		}
	}
	return preview, nil
}
