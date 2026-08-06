package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

const defaultSyncApplyBatchSize = 1000

type appliedChangeCounts struct {
	Inserts int
	Updates int
	Deletes int
}

func (counts appliedChangeCounts) total() int {
	return counts.Inserts + counts.Updates + counts.Deletes
}

func (counts appliedChangeCounts) addToResult(result *SyncResult) {
	if result == nil {
		return
	}
	result.RowsInserted += counts.Inserts
	result.RowsUpdated += counts.Updates
	result.RowsDeleted += counts.Deletes
}

// SyncConfig defines the parameters for a synchronization task
type SyncConfig struct {
	SourceConfig        connection.ConnectionConfig `json:"sourceConfig"`
	TargetConfig        connection.ConnectionConfig `json:"targetConfig"`
	SourceDatabase      string                      `json:"sourceDatabase,omitempty"`
	TargetDatabase      string                      `json:"targetDatabase,omitempty"`
	TargetSchema        string                      `json:"targetSchema,omitempty"`
	Tables              []string                    `json:"tables"`
	SourceQuery         string                      `json:"sourceQuery,omitempty"`
	Content             string                      `json:"content,omitempty"` // "data", "schema", "both"
	Mode                string                      `json:"mode"`              // "insert_update", "insert_only", "full_overwrite"
	JobID               string                      `json:"jobId,omitempty"`
	AutoAddColumns      bool                        `json:"autoAddColumns,omitempty"` // 自动补齐缺失字段
	TargetTableStrategy string                      `json:"targetTableStrategy,omitempty"`
	CreateIndexes       bool                        `json:"createIndexes,omitempty"`
	MongoCollectionName string                      `json:"mongoCollectionName,omitempty"`
	TableOptions        map[string]TableOptions     `json:"tableOptions,omitempty"`
}

// SyncResult holds the result of the sync operation
type SyncResult struct {
	Success      bool     `json:"success"`
	Message      string   `json:"message"`
	Logs         []string `json:"logs"`
	TablesSynced int      `json:"tablesSynced"`
	RowsInserted int      `json:"rowsInserted"`
	RowsUpdated  int      `json:"rowsUpdated"`
	RowsDeleted  int      `json:"rowsDeleted"`
}

type SyncEngine struct {
	reporter Reporter
}

func NewSyncEngine(reporter Reporter) *SyncEngine {
	return &SyncEngine{reporter: reporter}
}

// CompareAndSync performs the synchronization
func (s *SyncEngine) RunSync(config SyncConfig) SyncResult {
	config = normalizeSyncConnectionDatabases(config)
	result := SyncResult{Success: true, Logs: []string{}}
	logger.Infof("开始数据同步：源=%s 目标=%s 表数量=%d", formatConnSummaryForSync(config.SourceConfig), formatConnSummaryForSync(config.TargetConfig), len(config.Tables))
	if isRedisToMongoKeyspacePair(config) {
		return s.runRedisToMongoSync(config, result)
	}
	if isMongoToRedisKeyspacePair(config) {
		return s.runMongoToRedisSync(config, result)
	}
	if hasSourceQuery(config) {
		return s.runSourceQuerySync(config)
	}

	totalTables := len(config.Tables)
	syncStartedStage := localizedSyncBackendText("data_sync.progress.stage.sync_started", nil)
	connectingSourceStage := localizedSyncBackendText("data_sync.progress.stage.connecting_source", nil)
	connectingTargetStage := localizedSyncBackendText("data_sync.progress.stage.connecting_target", nil)
	tableCompletedStage := localizedSyncBackendText("data_sync.progress.stage.table_completed", nil)
	syncCompletedStage := localizedSyncBackendText("data_sync.progress.stage.completed", nil)
	s.progress(config.JobID, 0, totalTables, "", syncStartedStage)

	contentRaw := strings.ToLower(strings.TrimSpace(config.Content))
	syncSchema := false
	syncData := true
	switch contentRaw {
	case "", "data":
		syncData = true
	case "schema":
		syncSchema = true
		syncData = false
	case "both":
		syncSchema = true
		syncData = true
	default:
		s.appendLog(config.JobID, &result, "warn", fmt.Sprintf("未知同步内容 %q，已自动使用仅同步数据", config.Content))
		syncData = true
	}

	modeRaw := strings.ToLower(strings.TrimSpace(config.Mode))
	if modeRaw != "" && modeRaw != "insert_update" && modeRaw != "insert_only" && modeRaw != "full_overwrite" {
		s.appendLog(config.JobID, &result, "warn", fmt.Sprintf("未知同步模式 %q，已自动使用 insert_update", config.Mode))
	}
	defaultMode := normalizeSyncMode(config.Mode)
	strategy := normalizeTargetTableStrategy(config.TargetTableStrategy)

	contentLabel := "仅同步数据"
	if syncSchema && syncData {
		contentLabel = "同步结构+数据"
	} else if syncSchema {
		contentLabel = "仅同步结构"
	}
	s.appendLog(config.JobID, &result, "info", fmt.Sprintf("同步内容：%s；模式：%s；自动补字段：%v；目标表策略：%s；创建索引：%v", contentLabel, defaultMode, config.AutoAddColumns, strategy, config.CreateIndexes))

	sourceDB, err := newSyncDatabase(config.SourceConfig.Type)
	if err != nil {
		logger.Error(err, "初始化源数据库驱动失败：类型=%s", config.SourceConfig.Type)
		return s.fail(config.JobID, totalTables, result, localizedSyncBackendDetailText("data_sync.backend.error.init_source_driver_failed", err))
	}
	if config.SourceConfig.Type == "custom" {
		// Custom DB setup would go here if needed
	}

	targetDB, err := newSyncDatabase(config.TargetConfig.Type)
	if err != nil {
		logger.Error(err, "初始化目标数据库驱动失败：类型=%s", config.TargetConfig.Type)
		return s.fail(config.JobID, totalTables, result, localizedSyncBackendDetailText("data_sync.backend.error.init_target_driver_failed", err))
	}

	// Connect Source
	s.appendLog(config.JobID, &result, "info", fmt.Sprintf("正在连接源数据库: %s...", config.SourceConfig.Host))
	s.progress(config.JobID, 0, totalTables, "", connectingSourceStage)
	if err := sourceDB.Connect(config.SourceConfig); err != nil {
		logger.Error(err, "源数据库连接失败：%s", formatConnSummaryForSync(config.SourceConfig))
		return s.fail(config.JobID, totalTables, result, localizedSyncBackendDetailText("data_sync.backend.error.connect_source_failed", err))
	}
	defer sourceDB.Close()

	// Connect Target
	s.appendLog(config.JobID, &result, "info", fmt.Sprintf("正在连接目标数据库: %s...", config.TargetConfig.Host))
	s.progress(config.JobID, 0, totalTables, "", connectingTargetStage)
	if err := targetDB.Connect(config.TargetConfig); err != nil {
		logger.Error(err, "目标数据库连接失败：%s", formatConnSummaryForSync(config.TargetConfig))
		return s.fail(config.JobID, totalTables, result, localizedSyncBackendDetailText("data_sync.backend.error.connect_target_failed", err))
	}
	defer targetDB.Close()

	tableFailures := make([]string, 0)
	for i, tableName := range config.Tables {
		tableFailure := ""
		tableCompleted := false
		markTableFailure := func(message string) {
			if tableFailure == "" {
				tableFailure = strings.TrimSpace(message)
			}
		}
		func() {
			tableMode := defaultMode
			s.appendLog(config.JobID, &result, "info", fmt.Sprintf("正在同步表: %s", tableName))
			s.progress(config.JobID, i, totalTables, tableName, localizedSyncBackendText("data_sync.progress.stage.syncing_table", map[string]any{
				"current": i + 1,
				"total":   totalTables,
			}))
			defer s.progress(config.JobID, i+1, totalTables, tableName, tableCompletedStage)

			plan, cols, targetCols, err := buildSchemaMigrationPlan(config, tableName, sourceDB, targetDB)
			if err != nil {
				message := fmt.Sprintf("生成迁移计划失败：表=%s 错误=%v", tableName, err)
				s.appendLog(config.JobID, &result, "error", message)
				markTableFailure(message)
				return
			}
			for _, warning := range plan.Warnings {
				s.appendLog(config.JobID, &result, "warn", fmt.Sprintf("  -> %s", warning))
			}
			for _, unsupported := range plan.UnsupportedObjects {
				s.appendLog(config.JobID, &result, "warn", fmt.Sprintf("  -> %s", unsupported))
			}
			if strings.TrimSpace(plan.PlannedAction) != "" {
				s.appendLog(config.JobID, &result, "info", fmt.Sprintf("  -> %s", plan.PlannedAction))
			}

			if !plan.TargetTableExists && !plan.AutoCreate {
				message := fmt.Sprintf("表 %s 目标表不存在，当前策略不允许自动建表，已跳过", tableName)
				s.appendLog(config.JobID, &result, "warn", message)
				markTableFailure(message)
				return
			}

			if !plan.TargetTableExists && plan.AutoCreate {
				s.progress(config.JobID, i, totalTables, tableName, "创建目标表")
				if len(plan.PreDataSQL) > 0 {
					if err := executeSQLStatements(targetDB.Exec, plan.PreDataSQL); err != nil {
						message := fmt.Sprintf("预执行建表 SQL 失败：表=%s 错误=%v", tableName, err)
						s.appendLog(config.JobID, &result, "error", message)
						markTableFailure(message)
						return
					}
				}
				if strings.TrimSpace(plan.CreateTableSQL) == "" && len(plan.PreDataSQL) == 0 {
					message := fmt.Sprintf("表 %s 自动建表失败：建表/建集合 SQL 为空", tableName)
					s.appendLog(config.JobID, &result, "error", message)
					markTableFailure(message)
					return
				}
				if strings.TrimSpace(plan.CreateTableSQL) != "" {
					if _, err := targetDB.Exec(plan.CreateTableSQL); err != nil {
						message := fmt.Sprintf("创建目标表失败：表=%s 错误=%v", tableName, err)
						s.appendLog(config.JobID, &result, "error", message)
						markTableFailure(message)
						return
					}
				}
				s.appendLog(config.JobID, &result, "info", fmt.Sprintf("目标对象创建成功：%s", tableName))
				targetCols, err = targetDB.GetColumns(plan.TargetSchema, plan.TargetTable)
				if err != nil {
					message := fmt.Sprintf("创建目标表后获取字段失败：表=%s 错误=%v", tableName, err)
					s.appendLog(config.JobID, &result, "error", message)
					markTableFailure(message)
					return
				}
			} else if len(plan.PreDataSQL) > 0 {
				s.progress(config.JobID, i, totalTables, tableName, "同步表结构")
				if err := executeSQLStatements(targetDB.Exec, plan.PreDataSQL); err != nil {
					message := fmt.Sprintf("同步表结构失败：表=%s 错误=%v", tableName, err)
					s.appendLog(config.JobID, &result, "error", message)
					markTableFailure(message)
					return
				}
				targetCols, err = targetDB.GetColumns(plan.TargetSchema, plan.TargetTable)
				if err != nil {
					message := fmt.Sprintf("补字段后刷新目标字段失败：表=%s 错误=%v", tableName, err)
					s.appendLog(config.JobID, &result, "error", message)
					markTableFailure(message)
					return
				}
			}

			if !syncData {
				if len(plan.PostDataSQL) > 0 {
					s.progress(config.JobID, i, totalTables, tableName, "创建索引")
					if err := executeSQLStatements(targetDB.Exec, plan.PostDataSQL); err != nil {
						message := fmt.Sprintf("创建索引失败：表=%s 错误=%v", tableName, err)
						s.appendLog(config.JobID, &result, "error", message)
						markTableFailure(message)
						return
					}
				}
				tableCompleted = true
				return
			}

			targetType := resolveMigrationDBType(config.TargetConfig)
			sourceType := resolveMigrationDBType(config.SourceConfig)
			targetTable := plan.TargetTable
			sourceQueryTable, targetQueryTable := plan.SourceQueryTable, plan.TargetQueryTable
			applyTableName := targetTable
			if shouldUseQualifiedSyncApplyTable(config.TargetConfig) {
				applyTableName = targetQueryTable
			}

			opts := TableOptions{Insert: true, Update: true, Delete: false}
			if config.TableOptions != nil {
				if configured, ok := config.TableOptions[tableName]; ok {
					opts = configured
				}
			}
			if !hasEffectiveSyncDataOperation(tableMode, opts) {
				if tableMode == "insert_update" {
					s.appendLog(config.JobID, &result, "info", fmt.Sprintf("表 %s 未选择数据变更，按无变更处理", tableName))
					if len(plan.PostDataSQL) > 0 {
						s.progress(config.JobID, i, totalTables, tableName, "创建索引")
						if err := executeSQLStatements(targetDB.Exec, plan.PostDataSQL); err != nil {
							message := fmt.Sprintf("创建索引失败：表=%s 错误=%v", tableName, err)
							s.appendLog(config.JobID, &result, "error", message)
							markTableFailure(message)
							return
						}
					}
					tableCompleted = true
					return
				}
				message := fmt.Sprintf("表 %s 在 %s 模式下未启用有效数据操作，已拒绝执行", tableName, tableMode)
				s.appendLog(config.JobID, &result, "warn", message)
				markTableFailure(message)
				return
			}

			sourceColsByLower := make(map[string]connection.ColumnDefinition, len(cols))
			for _, col := range cols {
				if strings.TrimSpace(col.Name) == "" {
					continue
				}
				sourceColsByLower[strings.ToLower(strings.TrimSpace(col.Name))] = col
			}

			pkCols := make([]string, 0, 2)
			for _, col := range cols {
				if col.Key == "PRI" || col.Key == "PK" {
					pkCols = append(pkCols, col.Name)
				}
			}
			requirePK := tableMode == "insert_update" && plan.TargetTableExists
			pkCol := ""
			if requirePK {
				if len(pkCols) == 0 {
					message := fmt.Sprintf("表 %s 未找到主键，当前模式需要差异对比，已跳过", tableName)
					s.appendLog(config.JobID, &result, "warn", message)
					markTableFailure(message)
					return
				}
				if len(pkCols) > 1 {
					message := fmt.Sprintf("表 %s 为复合主键（%s），当前暂不支持差异同步", tableName, strings.Join(pkCols, ","))
					s.appendLog(config.JobID, &result, "warn", message)
					markTableFailure(message)
					return
				}
				pkCol = pkCols[0]
			}

			if handled, inserted, err := s.tryApplyDirectImportInPages(config, &result, i, totalTables, tableName, sourceDB, targetDB, plan, cols, targetCols, opts, sourceType, targetType, applyTableName); handled {
				result.RowsInserted += inserted
				if err != nil {
					logger.Error(err, "分页流式导入失败：表=%s", tableName)
					message := fmt.Sprintf("分页流式导入失败: %v", err)
					s.appendLog(config.JobID, &result, "error", "  -> "+message)
					markTableFailure(message)
					return
				}
				if inserted > 0 {
					s.appendLog(config.JobID, &result, "info", fmt.Sprintf("  -> 分页流式导入完成：插入=%d 行", inserted))
				} else {
					s.appendLog(config.JobID, &result, "info", "  -> 源表无可导入数据")
				}
				if len(plan.PostDataSQL) > 0 {
					s.progress(config.JobID, i, totalTables, tableName, "创建索引")
					if err := executeSQLStatements(targetDB.Exec, plan.PostDataSQL); err != nil {
						message := fmt.Sprintf("创建索引失败：表=%s 错误=%v", tableName, err)
						s.appendLog(config.JobID, &result, "error", message)
						markTableFailure(message)
						return
					}
				}
				tableCompleted = true
				return
			}

			if handled, counts, err := s.tryApplyDiffInPages(config, &result, i, totalTables, tableName, sourceDB, targetDB, plan, cols, targetCols, opts, sourceType, targetType, applyTableName, pkCol); handled {
				result.RowsInserted += counts.Inserts
				result.RowsUpdated += counts.Updates
				result.RowsDeleted += counts.Deletes
				if err != nil {
					logger.Error(err, "分页差异同步失败：表=%s", tableName)
					message := fmt.Sprintf("分页差异同步失败: %v", err)
					s.appendLog(config.JobID, &result, "error", "  -> "+message)
					markTableFailure(message)
					return
				}
				if counts.Inserts > 0 || counts.Updates > 0 || counts.Deletes > 0 {
					s.appendLog(config.JobID, &result, "info", fmt.Sprintf("  -> 分页差异同步完成：插入=%d 更新=%d 删除=%d", counts.Inserts, counts.Updates, counts.Deletes))
				} else {
					s.appendLog(config.JobID, &result, "info", "  -> 数据一致，无需变更.")
				}
				if len(plan.PostDataSQL) > 0 {
					s.progress(config.JobID, i, totalTables, tableName, "创建索引")
					if err := executeSQLStatements(targetDB.Exec, plan.PostDataSQL); err != nil {
						message := fmt.Sprintf("创建索引失败：表=%s 错误=%v", tableName, err)
						s.appendLog(config.JobID, &result, "error", message)
						markTableFailure(message)
						return
					}
				}
				tableCompleted = true
				return
			}

			s.progress(config.JobID, i, totalTables, tableName, "读取源表数据")
			sourceRows, _, err := sourceDB.Query(fmt.Sprintf("SELECT * FROM %s", quoteQualifiedIdentByType(sourceType, sourceQueryTable)))
			if err != nil {
				logger.Error(err, "读取源表失败：表=%s", tableName)
				message := fmt.Sprintf("读取源表 %s 失败: %v", tableName, err)
				s.appendLog(config.JobID, &result, "error", message)
				markTableFailure(message)
				return
			}

			var inserts []map[string]interface{}
			var updates []connection.UpdateRow
			var deletes []map[string]interface{}

			if tableMode == "insert_update" && plan.TargetTableExists {
				s.progress(config.JobID, i, totalTables, tableName, "读取目标表数据")
				targetRows, _, err := targetDB.Query(fmt.Sprintf("SELECT * FROM %s", quoteQualifiedIdentByType(targetType, targetQueryTable)))
				if err != nil {
					logger.Error(err, "读取目标表失败：表=%s", tableName)
					message := fmt.Sprintf("读取目标表 %s 失败: %v", tableName, err)
					s.appendLog(config.JobID, &result, "error", message)
					markTableFailure(message)
					return
				}

				s.progress(config.JobID, i, totalTables, tableName, "对比差异")
				targetMap := make(map[string]map[string]interface{}, len(targetRows))
				for _, row := range targetRows {
					if row[pkCol] == nil {
						continue
					}
					pkVal := fmt.Sprintf("%v", row[pkCol])
					if strings.TrimSpace(pkVal) == "" || pkVal == "<nil>" {
						continue
					}
					targetMap[pkVal] = row
				}
				sourcePKSet := make(map[string]struct{}, len(sourceRows))
				for _, sRow := range sourceRows {
					if sRow[pkCol] == nil {
						continue
					}
					pkVal := fmt.Sprintf("%v", sRow[pkCol])
					if strings.TrimSpace(pkVal) == "" || pkVal == "<nil>" {
						continue
					}
					sourcePKSet[pkVal] = struct{}{}
					if tRow, exists := targetMap[pkVal]; exists {
						changes := make(map[string]interface{})
						for k, v := range sRow {
							if fmt.Sprintf("%v", v) != fmt.Sprintf("%v", tRow[k]) {
								changes[k] = v
							}
						}
						if len(changes) > 0 {
							updates = append(updates, connection.UpdateRow{Keys: map[string]interface{}{pkCol: sRow[pkCol]}, Values: changes})
						}
					} else {
						inserts = append(inserts, sRow)
					}
				}
				if opts.Delete {
					for pkStr, row := range targetMap {
						if _, ok := sourcePKSet[pkStr]; ok {
							continue
						}
						deletes = append(deletes, map[string]interface{}{pkCol: row[pkCol]})
					}
				}
				inserts = filterRowsByPKSelection(pkCol, inserts, opts.Insert, opts.SelectedInsertPKs)
				updates = filterUpdatesByPKSelection(pkCol, updates, opts.Update, opts.SelectedUpdatePKs)
				deletes = filterRowsByPKSelection(pkCol, deletes, opts.Delete, opts.SelectedDeletePKs)
			} else {
				inserts = sourceRows
				if !opts.Insert {
					inserts = nil
				}
			}

			changeSet := connection.ChangeSet{Inserts: inserts, Updates: updates, Deletes: deletes}
			s.progress(config.JobID, i, totalTables, tableName, "检查字段一致性")
			targetColsResolved := targetCols
			if len(targetColsResolved) == 0 {
				targetColsResolved, err = targetDB.GetColumns(plan.TargetSchema, plan.TargetTable)
				if err != nil {
					message := fmt.Sprintf("获取目标表字段失败: %v", err)
					s.appendLog(config.JobID, &result, "error", "  -> "+message)
					markTableFailure(message)
					return
				}
			}
			if len(targetColsResolved) > 0 {
				targetColSet := make(map[string]struct{}, len(targetColsResolved))
				for _, c := range targetColsResolved {
					name := strings.ToLower(strings.TrimSpace(c.Name))
					if name == "" {
						continue
					}
					targetColSet[name] = struct{}{}
				}
				requiredCols := collectRequiredColumns(changeSet.Inserts, changeSet.Updates)
				missing := make([]string, 0)
				for lower, original := range requiredCols {
					if _, ok := targetColSet[lower]; !ok {
						missing = append(missing, original)
					}
				}
				sort.Strings(missing)
				if len(missing) > 0 {
					if config.AutoAddColumns && supportsAutoAddColumnsForPair(sourceType, targetType) {
						s.appendLog(config.JobID, &result, "warn", fmt.Sprintf("  -> 目标表缺少字段 %d 个，开始自动补齐: %s", len(missing), strings.Join(missing, ", ")))
						added := 0
						for _, colName := range missing {
							colLower := strings.ToLower(strings.TrimSpace(colName))
							srcCol, ok := sourceColsByLower[colLower]
							if !ok {
								message := fmt.Sprintf("自动补字段失败：未找到源字段元数据，字段=%s", colName)
								s.appendLog(config.JobID, &result, "error", "  -> "+message)
								markTableFailure(message)
								continue
							}
							alterSQL, err := buildAddColumnSQLForPair(sourceType, targetType, targetQueryTable, srcCol)
							if err != nil {
								message := fmt.Sprintf("自动补字段失败：字段=%s 错误=%v", colName, err)
								s.appendLog(config.JobID, &result, "error", "  -> "+message)
								markTableFailure(message)
								continue
							}
							if _, err := targetDB.Exec(alterSQL); err != nil {
								message := fmt.Sprintf("自动补字段失败：字段=%s 错误=%v", colName, err)
								s.appendLog(config.JobID, &result, "error", "  -> "+message)
								markTableFailure(message)
								continue
							}
							added++
							targetColSet[colLower] = struct{}{}
						}
						s.appendLog(config.JobID, &result, "info", fmt.Sprintf("  -> 自动补字段完成：成功=%d 失败=%d", added, len(missing)-added))
					} else {
						s.appendLog(config.JobID, &result, "warn", fmt.Sprintf("  -> 目标表缺少字段 %d 个（未开启自动补齐），将自动忽略：%s", len(missing), strings.Join(missing, ", ")))
					}
					changeSet.Inserts = filterInsertRows(changeSet.Inserts, targetColSet)
					changeSet.Updates = filterUpdateRows(changeSet.Updates, targetColSet)
				}
			}
			if tableFailure != "" {
				return
			}

			hasChanges := len(changeSet.Inserts) > 0 || len(changeSet.Updates) > 0 || len(changeSet.Deletes) > 0
			var applier db.BatchApplier
			if hasChanges {
				var ok bool
				applier, ok = targetDB.(db.BatchApplier)
				if !ok {
					message := "目标驱动不支持应用数据变更 (ApplyChanges)."
					s.appendLog(config.JobID, &result, "warn", "  -> "+message)
					markTableFailure(message)
					return
				}
			}

			if tableMode == "full_overwrite" && plan.TargetTableExists {
				s.appendLog(config.JobID, &result, "warn", fmt.Sprintf("  -> 全量覆盖模式：即将清空目标表 %s", tableName))
				s.progress(config.JobID, i, totalTables, tableName, "清空目标表")
				clearSQL := ""
				if targetType == "mysql" {
					clearSQL = fmt.Sprintf("TRUNCATE TABLE %s", quoteQualifiedIdentByType(targetType, targetQueryTable))
				} else {
					clearSQL = fmt.Sprintf("DELETE FROM %s", quoteQualifiedIdentByType(targetType, targetQueryTable))
				}
				if _, err := targetDB.Exec(clearSQL); err != nil {
					message := fmt.Sprintf("清空目标表失败: %v", err)
					s.appendLog(config.JobID, &result, "error", "  -> "+message)
					markTableFailure(message)
					return
				}
			}

			s.progress(config.JobID, i, totalTables, tableName, "应用变更")
			if hasChanges {
				s.appendLog(config.JobID, &result, "info", fmt.Sprintf("  -> 需插入: %d 行, 需更新: %d 行, 需删除: %d 行", len(changeSet.Inserts), len(changeSet.Updates), len(changeSet.Deletes)))
				applied, err := s.applyChangesInBatches(config.JobID, &result, applyTableName, applier, changeSet)
				applied.addToResult(&result)
				if err != nil {
					message := fmt.Sprintf("应用变更失败: %v", err)
					s.appendLog(config.JobID, &result, "error", "  -> "+message)
					markTableFailure(message)
					return
				}
			} else {
				s.appendLog(config.JobID, &result, "info", "  -> 数据一致，无需变更.")
			}

			if len(plan.PostDataSQL) > 0 {
				s.progress(config.JobID, i, totalTables, tableName, "创建索引")
				if err := executeSQLStatements(targetDB.Exec, plan.PostDataSQL); err != nil {
					message := fmt.Sprintf("创建索引失败：表=%s 错误=%v", tableName, err)
					s.appendLog(config.JobID, &result, "error", message)
					markTableFailure(message)
					return
				}
			}

			tableCompleted = true
		}()
		if tableFailure != "" {
			tableFailures = append(tableFailures, fmt.Sprintf("%s: %s", tableName, tableFailure))
		} else if tableCompleted {
			result.TablesSynced++
		}
	}

	if len(tableFailures) > 0 {
		message := fmt.Sprintf("数据同步未全部完成：成功 %d/%d 个表，失败 %d 个；%s", result.TablesSynced, totalTables, len(tableFailures), strings.Join(tableFailures, "；"))
		return s.fail(config.JobID, totalTables, result, message)
	}
	s.progress(config.JobID, totalTables, totalTables, "", syncCompletedStage)
	return result
}

func formatConnSummaryForSync(config connection.ConnectionConfig) string {
	timeoutSeconds := config.Timeout
	if timeoutSeconds <= 0 {
		timeoutSeconds = 30
	}

	dbName := strings.TrimSpace(config.Database)
	if dbName == "" {
		dbName = "(default)"
	}

	return fmt.Sprintf("类型=%s 地址=%s:%d 数据库=%s 用户=%s 超时=%ds",
		config.Type, config.Host, config.Port, dbName, config.User, timeoutSeconds)
}

func (s *SyncEngine) appendLog(jobID string, res *SyncResult, level string, msg string) {
	if res != nil {
		res.Logs = append(res.Logs, msg)
	}
	if s.reporter.OnLog != nil && strings.TrimSpace(jobID) != "" {
		s.reporter.OnLog(SyncLogEvent{
			JobID:   jobID,
			Level:   level,
			Message: msg,
			Ts:      time.Now().UnixMilli(),
		})
	}
}

func (s *SyncEngine) progress(jobID string, current, total int, table string, stage string) {
	if s.reporter.OnProgress == nil || strings.TrimSpace(jobID) == "" {
		return
	}
	percent := 0
	if total <= 0 {
		if current > 0 {
			percent = 100
		}
	} else {
		if current < 0 {
			current = 0
		}
		if current > total {
			current = total
		}
		percent = (current * 100) / total
	}
	s.reporter.OnProgress(SyncProgressEvent{
		JobID:   jobID,
		Percent: percent,
		Current: current,
		Total:   total,
		Table:   table,
		Stage:   stage,
	})
}

func (s *SyncEngine) fail(jobID string, totalTables int, res SyncResult, msg string) SyncResult {
	res.Success = false
	res.Message = msg
	s.appendLog(jobID, &res, "error", "致命错误: "+msg)
	s.progress(jobID, res.TablesSynced, totalTables, "", localizedSyncBackendText("data_sync.progress.stage.failed", nil))
	return res
}

func (s *SyncEngine) applyChangesInBatches(jobID string, res *SyncResult, tableName string, applier db.BatchApplier, changes connection.ChangeSet) (appliedChangeCounts, error) {
	applied := appliedChangeCounts{}
	batches := splitChangeSetBatches(changes, defaultSyncApplyBatchSize)
	if len(batches) == 0 {
		return applied, nil
	}
	if len(batches) > 1 {
		s.appendLog(jobID, res, "info", fmt.Sprintf("  -> 大批量变更将拆分为 %d 批提交（每批最多 %d 行）", len(batches), defaultSyncApplyBatchSize))
	}
	for idx, batch := range batches {
		if len(batches) > 1 {
			s.appendLog(jobID, res, "info", fmt.Sprintf("  -> 提交批次 %d/%d：插入=%d 更新=%d 删除=%d",
				idx+1, len(batches), len(batch.Inserts), len(batch.Updates), len(batch.Deletes)))
		}
		if err := applier.ApplyChanges(tableName, batch); err != nil {
			if len(batches) > 1 {
				if applied.total() > 0 {
					return applied, fmt.Errorf(
						"批次 %d/%d 失败（此前已确认完整提交：插入=%d 更新=%d 删除=%d；目标驱动若不支持原子提交，失败批次可能部分落库）: %w",
						idx+1, len(batches), applied.Inserts, applied.Updates, applied.Deletes, err,
					)
				}
				return applied, fmt.Errorf("批次 %d/%d 失败（目标驱动若不支持原子提交，失败批次可能部分落库）: %w", idx+1, len(batches), err)
			}
			return applied, fmt.Errorf("数据批次失败（目标驱动若不支持原子提交，失败批次可能部分落库）: %w", err)
		}
		applied.Inserts += len(batch.Inserts)
		applied.Updates += len(batch.Updates)
		applied.Deletes += len(batch.Deletes)
	}
	return applied, nil
}

func splitChangeSetBatches(changes connection.ChangeSet, batchSize int) []connection.ChangeSet {
	if batchSize <= 0 {
		batchSize = defaultSyncApplyBatchSize
	}
	total := len(changes.Deletes) + len(changes.Updates) + len(changes.Inserts)
	if total == 0 {
		return nil
	}

	batches := make([]connection.ChangeSet, 0, int(math.Ceil(float64(total)/float64(batchSize))))
	current := connection.ChangeSet{LocatorStrategy: changes.LocatorStrategy}
	currentSize := 0
	flush := func() {
		if currentSize == 0 {
			return
		}
		batches = append(batches, current)
		current = connection.ChangeSet{LocatorStrategy: changes.LocatorStrategy}
		currentSize = 0
	}

	for _, row := range changes.Deletes {
		if currentSize >= batchSize {
			flush()
		}
		current.Deletes = append(current.Deletes, row)
		currentSize++
	}
	for _, row := range changes.Updates {
		if currentSize >= batchSize {
			flush()
		}
		current.Updates = append(current.Updates, row)
		currentSize++
	}
	for _, row := range changes.Inserts {
		if currentSize >= batchSize {
			flush()
		}
		current.Inserts = append(current.Inserts, row)
		currentSize++
	}
	flush()
	return batches
}

func (s *SyncEngine) execDDLStatements(jobID string, res *SyncResult, database db.Database, tableName string, stage string, statements []string) error {
	for _, statement := range statements {
		sqlText := strings.TrimSpace(statement)
		if sqlText == "" {
			continue
		}
		if _, err := database.Exec(sqlText); err != nil {
			return fmt.Errorf("%s失败: %w", stage, err)
		}
		s.appendLog(jobID, res, "info", fmt.Sprintf("表 %s %s成功：%s", tableName, stage, shortenSyncSQL(sqlText)))
	}
	return nil
}

func shortenSyncSQL(sqlText string) string {
	text := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(sqlText, "\n", " "), "\t", " "))
	text = strings.Join(strings.Fields(text), " ")
	if len(text) <= 120 {
		return text
	}
	return text[:117] + "..."
}
