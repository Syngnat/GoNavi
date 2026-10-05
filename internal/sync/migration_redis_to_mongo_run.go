package sync

import (
	"fmt"
	"sort"
	"strings"

	"GoNavi-Wails/internal/db"
)

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
