package sync

import (
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
	"context"
	"errors"
	"fmt"
	"strings"
)

type TableDiffSummary struct {
	Table           string   `json:"table"`
	SourceObject    string   `json:"sourceObject,omitempty"`
	TargetObject    string   `json:"targetObject,omitempty"`
	PKColumn        string   `json:"pkColumn,omitempty"`
	CanSync         bool     `json:"canSync"`
	Inserts         int      `json:"inserts"`
	Updates         int      `json:"updates"`
	Deletes         int      `json:"deletes"`
	Same            int      `json:"same"`
	SchemaDiffCount int      `json:"schemaDiffCount,omitempty"`
	MissingColumns  []string `json:"missingColumns,omitempty"`
	// ColumnDiffs carries every column-level structural difference, in both
	// directions and including type/nullability drift. MissingColumns stays for
	// backward compatibility but only covers source columns absent downstream.
	ColumnDiffs        []ColumnStructureDiff `json:"columnDiffs,omitempty"`
	Message            string                `json:"message,omitempty"`
	HasSchema          bool                  `json:"hasSchema,omitempty"`
	TargetTableExists  bool                  `json:"targetTableExists,omitempty"`
	PlannedAction      string                `json:"plannedAction,omitempty"`
	Warnings           []string              `json:"warnings,omitempty"`
	UnsupportedObjects []string              `json:"unsupportedObjects,omitempty"`
	UnmigratedIndexes  []UnmigratedIndex     `json:"unmigratedIndexes,omitempty"`
	IndexesToCreate    int                   `json:"indexesToCreate,omitempty"`
	IndexesSkipped     int                   `json:"indexesSkipped,omitempty"`
}

type SyncAnalyzeResult struct {
	Success bool               `json:"success"`
	Message string             `json:"message"`
	Content string             `json:"content,omitempty"`
	Tables  []TableDiffSummary `json:"tables"`
}

func (s *SyncEngine) Analyze(config SyncConfig) SyncAnalyzeResult {
	runner := &SyncEngine{reporter: s.reporter, ctx: context.Background()}
	return runner.analyze(config)
}

func (s *SyncEngine) AnalyzeContext(ctx context.Context, config SyncConfig) SyncAnalyzeResult {
	if ctx == nil {
		ctx = context.Background()
	}
	runner := &SyncEngine{reporter: s.reporter, ctx: markSyncDriverContext(ctx)}
	return runner.analyze(config)
}

func (s *SyncEngine) analyze(config SyncConfig) SyncAnalyzeResult {
	config = normalizeSyncConnectionDatabases(config)
	config = normalizeMappedSyncTables(config)
	result := SyncAnalyzeResult{Success: true, Tables: []TableDiffSummary{}}
	if err := s.contextError(); err != nil {
		return SyncAnalyzeResult{Success: false, Message: err.Error(), Tables: []TableDiffSummary{}}
	}
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
	// Content echoes the mode actually applied, not the raw request: the empty
	// and unknown cases both degrade to data-only, and reporting the original
	// string would leave the UI with a mode matching neither data nor schema.
	normalizedContent := "data"
	switch contentRaw {
	case "", "data":
		syncData = true
	case "schema":
		syncSchema = true
		syncData = false
		normalizedContent = "schema"
	case "both":
		syncSchema = true
		syncData = true
		normalizedContent = "both"
	default:
		s.appendLog(config.JobID, nil, "warn", fmt.Sprintf("未知同步内容 %q，已自动使用仅同步数据", config.Content))
		syncData = true
	}
	result.Content = normalizedContent

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
		if contextErr := s.contextError(); contextErr != nil {
			return SyncAnalyzeResult{Success: false, Message: contextErr.Error(), Tables: []TableDiffSummary{}}
		}
		logger.Error(err, "源数据库连接失败：%s", formatConnSummaryForSync(config.SourceConfig))
		return SyncAnalyzeResult{Success: false, Message: localizedSyncBackendDetailText("data_sync.backend.error.connect_source_failed", err)}
	}
	if err := s.contextError(); err != nil {
		_ = sourceDB.Close()
		return SyncAnalyzeResult{Success: false, Message: err.Error(), Tables: []TableDiffSummary{}}
	}
	defer sourceDB.Close()
	db.BindMetadataContext(sourceDB, s.context())
	defer db.ClearMetadataContext(sourceDB)

	if err := targetDB.Connect(config.TargetConfig); err != nil {
		if contextErr := s.contextError(); contextErr != nil {
			return SyncAnalyzeResult{Success: false, Message: contextErr.Error(), Tables: []TableDiffSummary{}}
		}
		logger.Error(err, "目标数据库连接失败：%s", formatConnSummaryForSync(config.TargetConfig))
		return SyncAnalyzeResult{Success: false, Message: localizedSyncBackendDetailText("data_sync.backend.error.connect_target_failed", err)}
	}
	if err := s.contextError(); err != nil {
		_ = targetDB.Close()
		return SyncAnalyzeResult{Success: false, Message: err.Error(), Tables: []TableDiffSummary{}}
	}
	defer targetDB.Close()
	db.BindMetadataContext(targetDB, s.context())
	defer db.ClearMetadataContext(targetDB)

	cancelled := false
	recordCancellation := func(err error) bool {
		contextErr := s.contextError()
		if contextErr == nil {
			switch {
			case errors.Is(err, context.Canceled):
				contextErr = context.Canceled
			case errors.Is(err, context.DeadlineExceeded):
				contextErr = context.DeadlineExceeded
			default:
				return false
			}
		}
		cancelled = true
		result.Success = false
		result.Message = contextErr.Error()
		return true
	}

	for i, tableName := range config.Tables {
		if err := s.contextError(); err != nil {
			recordCancellation(err)
			break
		}
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
				recordCancellation(err)
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
			summary.SourceObject = plan.SourceQueryTable
			summary.TargetObject = plan.TargetQueryTable
			summary.Warnings = append(summary.Warnings, plan.Warnings...)
			summary.UnsupportedObjects = append(summary.UnsupportedObjects, plan.UnsupportedObjects...)
			summary.UnmigratedIndexes = append(summary.UnmigratedIndexes, plan.UnmigratedIndexes...)
			summary.IndexesToCreate = plan.IndexesToCreate
			summary.IndexesSkipped = plan.IndexesSkipped
			summary.SchemaDiffCount = len(plan.PreDataSQL) + len(plan.PostDataSQL)
			if plan.TargetTableExists {
				summary.MissingColumns = diffMissingColumnNames(cols, targetCols)
				summary.ColumnDiffs = diffColumnStructures(
					cols,
					targetCols,
					resolveMigrationDBType(config.SourceConfig),
					resolveMigrationDBType(config.TargetConfig),
				)
				// Report the full structural picture, not just the ALTER
				// statements the planner happened to generate: a compare task
				// generates none, so this used to stay 0 and render "identical".
				if len(summary.ColumnDiffs) > summary.SchemaDiffCount {
					summary.SchemaDiffCount = len(summary.ColumnDiffs)
				}
			}

			if !plan.TargetTableExists && !plan.AutoCreate {
				summary.Message = firstNonEmpty(plan.PlannedAction, localizedSyncBackendText("data_sync.plan.target_missing_cannot_sync", nil))
				result.Tables = append(result.Tables, summary)
				return
			}
			if plan.TargetTableExists && syncContentAllowsSchemaChanges(config.Content) {
				unsupportedDiffs := unsupportedExistingTargetSchemaDiffs(summary.ColumnDiffs)
				if len(unsupportedDiffs) > 0 {
					summary.Message = "存在当前不支持自动修复的结构差异（" + summarizeColumnStructureDiffs(unsupportedDiffs) + "）；当前仅支持补齐目标缺失字段"
					result.Tables = append(result.Tables, summary)
					return
				}
			}

			if !syncData {
				summary.CanSync = true
				switch {
				case len(summary.ColumnDiffs) > 0:
					// Do not fall back to plan.PlannedAction here: the planner
					// sets it to "表结构已一致" whenever it has no ALTER to run,
					// which is true for type/nullability drift and would mask it.
					summary.Message = summarizeColumnStructureDiffs(summary.ColumnDiffs)
				case summary.SchemaDiffCount > 0:
					summary.Message = firstNonEmpty(plan.PlannedAction, localizedSyncBackendText("data_sync.plan.schema_changes_detected", map[string]any{
						"count": summary.SchemaDiffCount,
					}))
				default:
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
			if tableMode == "insert_update" && plan.TargetTableExists {
				// A newly created target only receives inserts, so it does not need
				// a comparison key. Existing targets do: an explicit mapping key is
				// valid when configured; legacy table sync falls back to its PK.
				if len(pkCols) == 0 {
					summary.Message = localizedSyncBackendText("data_sync.backend.error.diff_pk_required", nil)
					result.Tables = append(result.Tables, summary)
					return
				}
			}

			sourceType := resolveMigrationDBType(config.SourceConfig)
			targetType := resolveMigrationDBType(config.TargetConfig)
			sourceCount, counted, err := countTableRowsForSyncContext(s.context(), sourceDB, sourceType, plan.SourceQueryTable)
			if err != nil {
				recordCancellation(err)
				summary.Message = localizedSyncBackendDetailText("data_sync.backend.error.read_source_table_failed", err)
				result.Tables = append(result.Tables, summary)
				return
			}
			if !counted {
				sourceRows, _, err := querySyncDatabaseContext(s.context(), sourceDB, fmt.Sprintf("SELECT * FROM %s", quoteQualifiedIdentByType(sourceType, plan.SourceQueryTable)))
				if err != nil {
					recordCancellation(err)
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
				handled, counts, scanErr = scanTableDiffInPagesContext(s.context(), sourceDB, targetDB, sourceType, targetType, plan, cols, targetCols, sourcePKCol, targetColSet, true, nil)
			}
			if handled {
				if scanErr != nil {
					recordCancellation(scanErr)
					summary.Message = scanErr.Error()
					result.Tables = append(result.Tables, summary)
					return
				}
				summary.CanSync = true
				summary.Inserts = counts.Inserts
				summary.Updates = counts.Updates
				summary.Deletes = counts.Deletes
				summary.Same = counts.Same
				// Columns absent on either side are excluded from the row
				// comparison, so these counts describe only the shared columns.
				// The structure section reports the column gap itself.
				if len(summary.MissingColumns) > 0 {
					summary.Warnings = append(summary.Warnings, fmt.Sprintf(
						"目标表缺失 %d 个字段：%s；数据对比仅比较两端共有字段，同步执行前需先补齐目标表结构",
						len(summary.MissingColumns),
						strings.Join(summary.MissingColumns, ", "),
					))
				}
				if strings.TrimSpace(summary.Message) == "" {
					summary.Message = firstNonEmpty(plan.PlannedAction, localizedSyncBackendText("data_sync.backend.summary.diff_completed", nil))
				}
				result.Tables = append(result.Tables, summary)
				return
			}

			sourceRows, _, err := querySyncDatabaseContext(s.context(), sourceDB, fmt.Sprintf("SELECT * FROM %s", quoteQualifiedIdentByType(sourceType, plan.SourceQueryTable)))
			if err != nil {
				recordCancellation(err)
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
			targetRows, _, err := querySyncDatabaseContext(s.context(), targetDB, fmt.Sprintf("SELECT * FROM %s", quoteQualifiedIdentByType(targetType, plan.TargetQueryTable)))
			if err != nil {
				recordCancellation(err)
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
		if cancelled {
			break
		}
	}

	if cancelled || recordCancellation(nil) {
		return result
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

// summarizeColumnStructureDiffs renders a per-kind tally so the compare row
// states what actually diverged instead of only counting missing columns.
func summarizeColumnStructureDiffs(diffs []ColumnStructureDiff) string {
	counts := make(map[string]int, 4)
	for _, diff := range diffs {
		counts[diff.Kind]++
	}
	parts := make([]string, 0, 4)
	if n := counts["missing_in_target"]; n > 0 {
		parts = append(parts, fmt.Sprintf("目标缺失 %d 个字段", n))
	}
	if n := counts["extra_in_target"]; n > 0 {
		parts = append(parts, fmt.Sprintf("目标多出 %d 个字段", n))
	}
	if n := counts["type"]; n > 0 {
		parts = append(parts, fmt.Sprintf("%d 个字段类型不同", n))
	}
	if n := counts["nullable"]; n > 0 {
		parts = append(parts, fmt.Sprintf("%d 个字段可空性不同", n))
	}
	if len(parts) == 0 {
		return ""
	}
	return "表结构存在差异：" + strings.Join(parts, "，")
}
