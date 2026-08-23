package sync

import (
	"GoNavi-Wails/internal/logger"
	"fmt"
	"strings"
)

type TableDiffSummary struct {
	Table              string            `json:"table"`
	PKColumn           string            `json:"pkColumn,omitempty"`
	CanSync            bool              `json:"canSync"`
	Inserts            int               `json:"inserts"`
	Updates            int               `json:"updates"`
	Deletes            int               `json:"deletes"`
	Same               int               `json:"same"`
	SchemaDiffCount    int               `json:"schemaDiffCount,omitempty"`
	Message            string            `json:"message,omitempty"`
	HasSchema          bool              `json:"hasSchema,omitempty"`
	TargetTableExists  bool              `json:"targetTableExists,omitempty"`
	PlannedAction      string            `json:"plannedAction,omitempty"`
	Warnings           []string          `json:"warnings,omitempty"`
	UnsupportedObjects []string          `json:"unsupportedObjects,omitempty"`
	UnmigratedIndexes  []UnmigratedIndex `json:"unmigratedIndexes,omitempty"`
	IndexesToCreate    int               `json:"indexesToCreate,omitempty"`
	IndexesSkipped     int               `json:"indexesSkipped,omitempty"`
}

type SyncAnalyzeResult struct {
	Success bool               `json:"success"`
	Message string             `json:"message"`
	Tables  []TableDiffSummary `json:"tables"`
}

func (s *SyncEngine) Analyze(config SyncConfig) SyncAnalyzeResult {
	config = normalizeSyncConnectionDatabases(config)
	config = normalizeMappedSyncTables(config)
	result := SyncAnalyzeResult{Success: true, Tables: []TableDiffSummary{}}
	if err := validateSyncMappings(config); err != nil {
		result.Success = false
		result.Message = err.Error()
		return result
	}
	if isRedisToMongoKeyspacePair(config) {
		return s.analyzeRedisToMongo(config)
	}
	if isMongoToRedisKeyspacePair(config) {
		return s.analyzeMongoToRedis(config)
	}
	if hasSourceQuery(config) {
		return s.analyzeSourceQuery(config)
	}
	if err := ValidateMigrationCapability(config); err != nil {
		result.Success = false
		result.Message = err.Error()
		return result
	}

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
		s.appendLog(config.JobID, nil, "warn", fmt.Sprintf("未知同步内容 %q，已自动使用仅同步数据", config.Content))
		syncData = true
	}

	analysisStartedStage := localizedSyncBackendText("data_sync.progress.stage.analysis_started", nil)
	analysisCompletedStage := localizedSyncBackendText("data_sync.progress.stage.analysis_completed", nil)
	totalTables := len(config.Tables)
	s.progress(config.JobID, 0, totalTables, "", analysisStartedStage)

	sourceDB, err := newSyncDatabase(config.SourceConfig.Type)
	if err != nil {
		logger.Error(err, "初始化源数据库驱动失败：类型=%s", config.SourceConfig.Type)
		return SyncAnalyzeResult{Success: false, Message: localizedSyncBackendDetailText("data_sync.backend.error.init_source_driver_failed", err)}
	}
	targetDB, err := newSyncDatabase(config.TargetConfig.Type)
	if err != nil {
		logger.Error(err, "初始化目标数据库驱动失败：类型=%s", config.TargetConfig.Type)
		return SyncAnalyzeResult{Success: false, Message: localizedSyncBackendDetailText("data_sync.backend.error.init_target_driver_failed", err)}
	}

	if err := sourceDB.Connect(config.SourceConfig); err != nil {
		logger.Error(err, "源数据库连接失败：%s", formatConnSummaryForSync(config.SourceConfig))
		return SyncAnalyzeResult{Success: false, Message: localizedSyncBackendDetailText("data_sync.backend.error.connect_source_failed", err)}
	}
	defer sourceDB.Close()

	if err := targetDB.Connect(config.TargetConfig); err != nil {
		logger.Error(err, "目标数据库连接失败：%s", formatConnSummaryForSync(config.TargetConfig))
		return SyncAnalyzeResult{Success: false, Message: localizedSyncBackendDetailText("data_sync.backend.error.connect_target_failed", err)}
	}
	defer targetDB.Close()

	for i, tableName := range config.Tables {
		func() {
			s.progress(config.JobID, i, totalTables, tableName, localizedSyncBackendText("data_sync.progress.stage.analyzing_table", map[string]any{
				"current": i + 1,
				"total":   totalTables,
			}))

			summary := TableDiffSummary{
				Table:     tableName,
				CanSync:   false,
				Inserts:   0,
				Updates:   0,
				Deletes:   0,
				Same:      0,
				Message:   "",
				HasSchema: syncSchema,
			}

			plan, cols, targetCols, err := buildSchemaMigrationPlan(config, tableName, sourceDB, targetDB)
			if err != nil {
				summary.Message = err.Error()
				result.Tables = append(result.Tables, summary)
				return
			}
			projection, err := projectionForSyncTable(config, tableName)
			if err != nil {
				summary.Message = err.Error()
				result.Tables = append(result.Tables, summary)
				return
			}
			summary.TargetTableExists = plan.TargetTableExists
			summary.PlannedAction = plan.PlannedAction
			summary.Warnings = append(summary.Warnings, plan.Warnings...)
			summary.UnsupportedObjects = append(summary.UnsupportedObjects, plan.UnsupportedObjects...)
			summary.UnmigratedIndexes = append(summary.UnmigratedIndexes, plan.UnmigratedIndexes...)
			summary.IndexesToCreate = plan.IndexesToCreate
			summary.IndexesSkipped = plan.IndexesSkipped
			summary.SchemaDiffCount = len(plan.PreDataSQL) + len(plan.PostDataSQL)

			if !plan.TargetTableExists && !plan.AutoCreate {
				summary.Message = firstNonEmpty(plan.PlannedAction, localizedSyncBackendText("data_sync.plan.target_missing_cannot_sync", nil))
				result.Tables = append(result.Tables, summary)
				return
			}

			if !syncData {
				summary.CanSync = true
				if summary.SchemaDiffCount > 0 {
					summary.Message = firstNonEmpty(plan.PlannedAction, localizedSyncBackendText("data_sync.plan.schema_changes_detected", map[string]any{
						"count": summary.SchemaDiffCount,
					}))
				} else {
					summary.Message = firstNonEmpty(plan.PlannedAction, localizedSyncBackendText("data_sync.plan.schema_only_no_data_diff", nil))
				}
				result.Tables = append(result.Tables, summary)
				return
			}

			tableMode := normalizeSyncMode(config.Mode)
			pkCols, err := syncKeyColumnsForTable(config, tableName, cols)
			if err != nil {
				summary.Message = err.Error()
				result.Tables = append(result.Tables, summary)
				return
			}

			sourceType := resolveMigrationDBType(config.SourceConfig)
			targetType := resolveMigrationDBType(config.TargetConfig)
			sourceCount, counted, err := countTableRowsForSync(sourceDB, sourceType, plan.SourceQueryTable)
			if err != nil {
				summary.Message = localizedSyncBackendDetailText("data_sync.backend.error.read_source_table_failed", err)
				result.Tables = append(result.Tables, summary)
				return
			}
			if !counted {
				sourceRows, _, err := sourceDB.Query(fmt.Sprintf("SELECT * FROM %s", quoteQualifiedIdentByType(sourceType, plan.SourceQueryTable)))
				if err != nil {
					summary.Message = localizedSyncBackendDetailText("data_sync.backend.error.read_source_table_failed", err)
					result.Tables = append(result.Tables, summary)
					return
				}
				sourceCount = len(sourceRows)
			}

			if !plan.TargetTableExists && plan.AutoCreate {
				summary.CanSync = true
				summary.Inserts = sourceCount
				summary.Message = firstNonEmpty(plan.PlannedAction, localizedSyncBackendText("data_sync.plan.target_missing_auto_create_all", nil))
				result.Tables = append(result.Tables, summary)
				return
			}

			if tableMode != "insert_update" {
				summary.CanSync = true
				summary.Inserts = sourceCount
				summary.Message = firstNonEmpty(plan.PlannedAction, localizedSyncBackendText("data_sync.plan.data_import_without_diff", nil))
				result.Tables = append(result.Tables, summary)
				return
			}

			if len(pkCols) == 0 {
				summary.Message = localizedSyncBackendText("data_sync.backend.error.diff_pk_required", nil)
				result.Tables = append(result.Tables, summary)
				return
			}
			sourcePKCol := pkCols[0]
			comparisonPKCols := append([]string(nil), pkCols...)
			if hasExplicitSyncMappings(config) {
				for index, sourceKey := range pkCols {
					mappedPK, ok := projection.TargetColumn(sourceKey)
					if !ok || strings.TrimSpace(mappedPK) == "" {
						summary.Message = fmt.Sprintf("表 %s 的主键字段 %s 未映射到目标字段，无法执行差异分析", tableName, sourceKey)
						result.Tables = append(result.Tables, summary)
						return
					}
					comparisonPKCols[index] = mappedPK
				}
			}
			summary.PKColumn = strings.Join(comparisonPKCols, ",")

			targetColSet := buildTargetColumnSet(targetCols)
			handled := false
			counts := pagedDiffCounts{}
			var scanErr error
			if !hasExplicitSyncMappings(config) && len(pkCols) == 1 {
				handled, counts, scanErr = scanTableDiffInPages(sourceDB, targetDB, sourceType, targetType, plan, cols, targetCols, sourcePKCol, targetColSet, true, nil)
			}
			if handled {
				if scanErr != nil {
					summary.Message = scanErr.Error()
					result.Tables = append(result.Tables, summary)
					return
				}
				summary.CanSync = true
				summary.Inserts = counts.Inserts
				summary.Updates = counts.Updates
				summary.Deletes = counts.Deletes
				summary.Same = counts.Same
				if strings.TrimSpace(summary.Message) == "" {
					summary.Message = firstNonEmpty(plan.PlannedAction, localizedSyncBackendText("data_sync.backend.summary.diff_completed", nil))
				}
				result.Tables = append(result.Tables, summary)
				return
			}

			sourceRows, _, err := sourceDB.Query(fmt.Sprintf("SELECT * FROM %s", quoteQualifiedIdentByType(sourceType, plan.SourceQueryTable)))
			if err != nil {
				summary.Message = localizedSyncBackendDetailText("data_sync.backend.error.read_source_table_failed", err)
				result.Tables = append(result.Tables, summary)
				return
			}
			if hasExplicitSyncMappings(config) {
				sourceRows, err = projectSyncRows(projection, sourceRows)
				if err != nil {
					summary.Message = err.Error()
					result.Tables = append(result.Tables, summary)
					return
				}
			}
			targetRows, _, err := targetDB.Query(fmt.Sprintf("SELECT * FROM %s", quoteQualifiedIdentByType(targetType, plan.TargetQueryTable)))
			if err != nil {
				summary.Message = localizedSyncBackendDetailText("data_sync.backend.error.read_target_table_failed", err)
				result.Tables = append(result.Tables, summary)
				return
			}

			inserts, updates, deletes, same := diffRowsByKeyColumns(comparisonPKCols, sourceRows, targetRows)
			summary.Inserts, summary.Updates, summary.Deletes, summary.Same = len(inserts), len(updates), len(deletes), same

			summary.CanSync = true
			if strings.TrimSpace(summary.Message) == "" {
				summary.Message = firstNonEmpty(plan.PlannedAction, localizedSyncBackendText("data_sync.backend.summary.diff_completed", nil))
			}
			result.Tables = append(result.Tables, summary)
		}()
	}

	s.progress(config.JobID, totalTables, totalTables, "", analysisCompletedStage)
	result.Message = localizedSyncBackendText("data_sync.backend.result.analyzed_tables", map[string]any{
		"count": len(result.Tables),
	})
	return result
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
