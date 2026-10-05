package sync

import (
	"fmt"

	"GoNavi-Wails/internal/db"
)

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
