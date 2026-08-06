package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"fmt"
	"strings"
)

type sourceQuerySyncContext struct {
	TableName        string
	TargetSchema     string
	TargetTable      string
	TargetQueryTable string
	TargetType       string
	TargetCols       []connection.ColumnDefinition
	PKColumn         string
	SourceRows       []map[string]interface{}
	TargetRows       []map[string]interface{}
}

func hasSourceQuery(config SyncConfig) bool {
	return strings.TrimSpace(config.SourceQuery) != ""
}

func localizedSyncBackendDetailText(key string, err error) string {
	detail := ""
	if err != nil {
		detail = err.Error()
	}
	return localizedSyncBackendText(key, map[string]any{
		"detail": detail,
	})
}

func syncWrapDetailError(key string, err error) error {
	return syncWrapError(key, map[string]any{
		"detail": err.Error(),
	}, err)
}

func validateSourceQuerySyncConfig(config SyncConfig) (string, error) {
	sourceQuery := strings.TrimSpace(config.SourceQuery)
	if sourceQuery == "" {
		return "", syncTextError("data_sync.backend.validation.source_query_required", nil)
	}

	content := strings.ToLower(strings.TrimSpace(config.Content))
	if content != "" && content != "data" {
		return "", syncTextError("data_sync.backend.validation.query_mode_data_only", nil)
	}

	if len(config.Tables) != 1 {
		return "", syncTextError("data_sync.backend.validation.single_target_table_required", nil)
	}

	tableName := strings.TrimSpace(config.Tables[0])
	if tableName == "" {
		return "", syncTextError("data_sync.backend.validation.target_table_required", nil)
	}
	return tableName, nil
}

func resolveTargetQueryTable(config SyncConfig, tableName string) (string, string, string, string) {
	targetType := resolveMigrationDBType(config.TargetConfig)
	targetSchema, targetTable := normalizeSyncTargetSchemaAndTable(config, tableName)
	targetQueryTable := qualifiedNameForQuery(targetType, targetSchema, targetTable, tableName)
	return targetType, targetSchema, targetTable, targetQueryTable
}

func resolveSinglePKColumn(cols []connection.ColumnDefinition) (string, error) {
	pkCols := make([]string, 0, 2)
	for _, col := range cols {
		if col.Key == "PRI" || col.Key == "PK" {
			pkCols = append(pkCols, col.Name)
		}
	}
	if len(pkCols) == 0 {
		return "", syncTextError("data_sync.backend.error.target_pk_required_for_query_diff", nil)
	}
	if len(pkCols) > 1 {
		return "", syncTextError("data_sync.backend.error.target_composite_pk_query_diff_unsupported", map[string]any{
			"columns": strings.Join(pkCols, ","),
		})
	}
	return pkCols[0], nil
}

func loadSourceQuerySyncContext(config SyncConfig, sourceDB db.Database, targetDB db.Database, needSourceRows bool, needTargetRows bool, requirePK bool) (sourceQuerySyncContext, error) {
	tableName, err := validateSourceQuerySyncConfig(config)
	if err != nil {
		return sourceQuerySyncContext{}, err
	}

	targetType, targetSchema, targetTable, targetQueryTable := resolveTargetQueryTable(config, tableName)
	targetCols, err := targetDB.GetColumns(targetSchema, targetTable)
	if err != nil {
		return sourceQuerySyncContext{}, syncWrapDetailError("data_sync.backend.error.load_target_columns_failed", err)
	}
	if len(targetCols) == 0 {
		return sourceQuerySyncContext{}, syncTextError("data_sync.backend.error.target_table_columns_missing", map[string]any{
			"table": tableName,
		})
	}

	ctx := sourceQuerySyncContext{
		TableName:        tableName,
		TargetSchema:     targetSchema,
		TargetTable:      targetTable,
		TargetQueryTable: targetQueryTable,
		TargetType:       targetType,
		TargetCols:       targetCols,
		SourceRows:       make([]map[string]interface{}, 0),
		TargetRows:       make([]map[string]interface{}, 0),
	}

	if needSourceRows {
		sourceRows, _, err := sourceDB.Query(strings.TrimSpace(config.SourceQuery))
		if err != nil {
			return sourceQuerySyncContext{}, syncWrapDetailError("data_sync.backend.error.execute_source_query_failed", err)
		}
		ctx.SourceRows = sourceRows
	}

	if requirePK {
		pkColumn, err := resolveSinglePKColumn(targetCols)
		if err != nil {
			return sourceQuerySyncContext{}, err
		}
		ctx.PKColumn = pkColumn
	}

	if needTargetRows {
		targetRows, _, err := targetDB.Query(fmt.Sprintf("SELECT * FROM %s", quoteQualifiedIdentByType(targetType, targetQueryTable)))
		if err != nil {
			return sourceQuerySyncContext{}, syncWrapDetailError("data_sync.backend.error.read_target_table_failed", err)
		}
		ctx.TargetRows = targetRows
	}

	return ctx, nil
}

func diffRowsByPK(pkCol string, sourceRows, targetRows []map[string]interface{}) ([]map[string]interface{}, []connection.UpdateRow, []map[string]interface{}, int) {
	targetMap := make(map[string]map[string]interface{}, len(targetRows))
	for _, row := range targetRows {
		if row[pkCol] == nil {
			continue
		}
		pkVal := strings.TrimSpace(fmt.Sprintf("%v", row[pkCol]))
		if pkVal == "" || pkVal == "<nil>" {
			continue
		}
		targetMap[pkVal] = row
	}

	sourcePKSet := make(map[string]struct{}, len(sourceRows))
	inserts := make([]map[string]interface{}, 0)
	updates := make([]connection.UpdateRow, 0)
	same := 0
	for _, sourceRow := range sourceRows {
		if sourceRow[pkCol] == nil {
			continue
		}
		pkVal := strings.TrimSpace(fmt.Sprintf("%v", sourceRow[pkCol]))
		if pkVal == "" || pkVal == "<nil>" {
			continue
		}
		sourcePKSet[pkVal] = struct{}{}
		if targetRow, exists := targetMap[pkVal]; exists {
			changes := make(map[string]interface{})
			for key, value := range sourceRow {
				if fmt.Sprintf("%v", value) != fmt.Sprintf("%v", targetRow[key]) {
					changes[key] = value
				}
			}
			if len(changes) == 0 {
				same++
				continue
			}
			updates = append(updates, connection.UpdateRow{
				Keys:   map[string]interface{}{pkCol: sourceRow[pkCol]},
				Values: changes,
			})
			continue
		}
		inserts = append(inserts, sourceRow)
	}

	deletes := make([]map[string]interface{}, 0)
	for pkVal, row := range targetMap {
		if _, exists := sourcePKSet[pkVal]; exists {
			continue
		}
		deletes = append(deletes, map[string]interface{}{pkCol: row[pkCol]})
	}
	return inserts, updates, deletes, same
}

func buildTargetColumnSet(cols []connection.ColumnDefinition) map[string]struct{} {
	targetColSet := make(map[string]struct{}, len(cols))
	for _, col := range cols {
		lowerName := strings.ToLower(strings.TrimSpace(col.Name))
		if lowerName == "" {
			continue
		}
		targetColSet[lowerName] = struct{}{}
	}
	return targetColSet
}

func applyQuerySourceColumnFilter(changeSet connection.ChangeSet, targetCols []connection.ColumnDefinition) connection.ChangeSet {
	targetColSet := buildTargetColumnSet(targetCols)
	changeSet.Inserts = filterInsertRows(changeSet.Inserts, targetColSet)
	changeSet.Updates = filterUpdateRows(changeSet.Updates, targetColSet)
	return changeSet
}

func (s *SyncEngine) analyzeSourceQuery(config SyncConfig) SyncAnalyzeResult {
	result := SyncAnalyzeResult{Success: true, Tables: []TableDiffSummary{}}
	tableName, err := validateSourceQuerySyncConfig(config)
	if err != nil {
		return SyncAnalyzeResult{Success: false, Message: err.Error()}
	}

	totalTables := 1
	analysisStartedStage := localizedSyncBackendText("data_sync.progress.stage.analysis_started", nil)
	analysisCompletedStage := localizedSyncBackendText("data_sync.progress.stage.analysis_completed", nil)
	analyzedTargetTablesMessage := localizedSyncBackendText("data_sync.backend.result.analyzed_target_tables", map[string]any{
		"count": totalTables,
	})
	sourceQueryDiffCompletedSummary := localizedSyncBackendText("data_sync.backend.summary.source_query_diff_completed", nil)
	s.progress(config.JobID, 0, totalTables, tableName, analysisStartedStage)

	sourceDB, err := newSyncDatabase(config.SourceConfig.Type)
	if err != nil {
		return SyncAnalyzeResult{Success: false, Message: localizedSyncBackendDetailText("data_sync.backend.error.init_source_driver_failed", err)}
	}
	targetDB, err := newSyncDatabase(config.TargetConfig.Type)
	if err != nil {
		return SyncAnalyzeResult{Success: false, Message: localizedSyncBackendDetailText("data_sync.backend.error.init_target_driver_failed", err)}
	}

	if err := sourceDB.Connect(config.SourceConfig); err != nil {
		return SyncAnalyzeResult{Success: false, Message: localizedSyncBackendDetailText("data_sync.backend.error.connect_source_failed", err)}
	}
	defer sourceDB.Close()

	if err := targetDB.Connect(config.TargetConfig); err != nil {
		return SyncAnalyzeResult{Success: false, Message: localizedSyncBackendDetailText("data_sync.backend.error.connect_target_failed", err)}
	}
	defer targetDB.Close()

	summary := TableDiffSummary{
		Table:   tableName,
		CanSync: false,
	}
	ctx, err := loadSourceQuerySyncContext(config, sourceDB, targetDB, false, false, true)
	if err != nil {
		summary.Message = err.Error()
		result.Tables = append(result.Tables, summary)
		result.Message = analyzedTargetTablesMessage
		s.progress(config.JobID, totalTables, totalTables, tableName, analysisCompletedStage)
		return result
	}

	sourceType := resolveMigrationDBType(config.SourceConfig)
	handled, counts, scanErr := scanSourceQueryDiffInPages(sourceDB, targetDB, sourceType, ctx.TargetType, strings.TrimSpace(config.SourceQuery), ctx.TargetQueryTable, ctx.TargetCols, ctx.PKColumn, true, nil)
	if handled {
		if scanErr != nil {
			summary.Message = scanErr.Error()
			result.Tables = append(result.Tables, summary)
			result.Message = analyzedTargetTablesMessage
			s.progress(config.JobID, totalTables, totalTables, tableName, analysisCompletedStage)
			return result
		}
		summary.CanSync = true
		summary.PKColumn = ctx.PKColumn
		summary.Inserts = counts.Inserts
		summary.Updates = counts.Updates
		summary.Deletes = counts.Deletes
		summary.Same = counts.Same
		summary.TargetTableExists = true
		summary.Message = sourceQueryDiffCompletedSummary
		result.Tables = append(result.Tables, summary)
		result.Message = analyzedTargetTablesMessage
		s.progress(config.JobID, totalTables, totalTables, tableName, analysisCompletedStage)
		return result
	}

	ctx, err = loadSourceQuerySyncContext(config, sourceDB, targetDB, true, true, true)
	if err != nil {
		summary.Message = err.Error()
		result.Tables = append(result.Tables, summary)
		result.Message = analyzedTargetTablesMessage
		s.progress(config.JobID, totalTables, totalTables, tableName, analysisCompletedStage)
		return result
	}

	inserts, updates, deletes, same := diffRowsByPK(ctx.PKColumn, ctx.SourceRows, ctx.TargetRows)
	summary.CanSync = true
	summary.PKColumn = ctx.PKColumn
	summary.Inserts = len(inserts)
	summary.Updates = len(updates)
	summary.Deletes = len(deletes)
	summary.Same = same
	summary.TargetTableExists = true
	summary.Message = sourceQueryDiffCompletedSummary
	result.Tables = append(result.Tables, summary)
	result.Message = analyzedTargetTablesMessage
	s.progress(config.JobID, totalTables, totalTables, tableName, analysisCompletedStage)
	return result
}

func (s *SyncEngine) previewSourceQuery(config SyncConfig, limit int) (TableDiffPreview, error) {
	sourceDB, err := newSyncDatabase(config.SourceConfig.Type)
	if err != nil {
		return TableDiffPreview{}, syncWrapDetailError("data_sync.backend.error.init_source_driver_failed", err)
	}
	targetDB, err := newSyncDatabase(config.TargetConfig.Type)
	if err != nil {
		return TableDiffPreview{}, syncWrapDetailError("data_sync.backend.error.init_target_driver_failed", err)
	}

	if err := sourceDB.Connect(config.SourceConfig); err != nil {
		return TableDiffPreview{}, syncWrapDetailError("data_sync.backend.error.connect_source_failed", err)
	}
	defer sourceDB.Close()

	if err := targetDB.Connect(config.TargetConfig); err != nil {
		return TableDiffPreview{}, syncWrapDetailError("data_sync.backend.error.connect_target_failed", err)
	}
	defer targetDB.Close()

	ctx, err := loadSourceQuerySyncContext(config, sourceDB, targetDB, false, false, true)
	if err != nil {
		return TableDiffPreview{}, err
	}

	previewSummary := localizedSyncBackendText("data_sync.plan.source_query_preview", nil)
	sourceType := resolveMigrationDBType(config.SourceConfig)
	out := TableDiffPreview{
		Table:         ctx.TableName,
		PKColumn:      ctx.PKColumn,
		ColumnTypes:   make(map[string]string, len(ctx.TargetCols)),
		SchemaSummary: previewSummary,
		Inserts:       make([]PreviewRow, 0, limit),
		Updates:       make([]PreviewUpdateRow, 0, limit),
		Deletes:       make([]PreviewRow, 0, limit),
	}
	for _, col := range ctx.TargetCols {
		name := strings.ToLower(strings.TrimSpace(col.Name))
		typ := strings.TrimSpace(col.Type)
		if name == "" || typ == "" {
			continue
		}
		out.ColumnTypes[name] = typ
	}

	handled, _, scanErr := scanSourceQueryDiffInPages(sourceDB, targetDB, sourceType, ctx.TargetType, strings.TrimSpace(config.SourceQuery), ctx.TargetQueryTable, ctx.TargetCols, ctx.PKColumn, true, func(page pagedDiffPage) error {
		out.TotalInserts += len(page.Inserts)
		out.TotalUpdates += len(page.Updates)
		out.TotalDeletes += len(page.Deletes)
		for _, row := range page.Inserts {
			if len(out.Inserts) >= limit {
				break
			}
			pk := strings.TrimSpace(fmt.Sprintf("%v", row[ctx.PKColumn]))
			if pk != "" && pk != "<nil>" {
				out.Inserts = append(out.Inserts, PreviewRow{PK: pk, Row: row})
			}
		}
		for _, update := range page.Updates {
			if len(out.Updates) >= limit {
				break
			}
			pk := strings.TrimSpace(fmt.Sprintf("%v", update.UpdateRow.Keys[ctx.PKColumn]))
			if pk == "" || pk == "<nil>" {
				continue
			}
			out.Updates = append(out.Updates, PreviewUpdateRow{
				PK:             pk,
				ChangedColumns: append([]string(nil), update.ChangedColumns...),
				Source:         update.Source,
				Target:         update.Target,
			})
		}
		for _, row := range page.Deletes {
			if len(out.Deletes) >= limit {
				break
			}
			pk := strings.TrimSpace(fmt.Sprintf("%v", row[ctx.PKColumn]))
			if pk != "" && pk != "<nil>" {
				out.Deletes = append(out.Deletes, PreviewRow{PK: pk, Row: row})
			}
		}
		return nil
	})
	if handled {
		if scanErr != nil {
			return TableDiffPreview{}, scanErr
		}
		return out, nil
	}

	ctx, err = loadSourceQuerySyncContext(config, sourceDB, targetDB, true, true, true)
	if err != nil {
		return TableDiffPreview{}, err
	}

	inserts, updates, deletes, _ := diffRowsByPK(ctx.PKColumn, ctx.SourceRows, ctx.TargetRows)
	out = TableDiffPreview{
		Table:         ctx.TableName,
		PKColumn:      ctx.PKColumn,
		ColumnTypes:   make(map[string]string, len(ctx.TargetCols)),
		SchemaSummary: previewSummary,
		TotalInserts:  len(inserts),
		TotalUpdates:  len(updates),
		TotalDeletes:  len(deletes),
		Inserts:       make([]PreviewRow, 0, minInt(limit, len(inserts))),
		Updates:       make([]PreviewUpdateRow, 0, minInt(limit, len(updates))),
		Deletes:       make([]PreviewRow, 0, minInt(limit, len(deletes))),
	}
	for _, col := range ctx.TargetCols {
		name := strings.ToLower(strings.TrimSpace(col.Name))
		typ := strings.TrimSpace(col.Type)
		if name == "" || typ == "" {
			continue
		}
		out.ColumnTypes[name] = typ
	}

	for idx, row := range inserts {
		if idx >= limit {
			break
		}
		pk := strings.TrimSpace(fmt.Sprintf("%v", row[ctx.PKColumn]))
		out.Inserts = append(out.Inserts, PreviewRow{PK: pk, Row: row})
	}
	for idx, update := range updates {
		if idx >= limit {
			break
		}
		pk := strings.TrimSpace(fmt.Sprintf("%v", update.Keys[ctx.PKColumn]))
		targetRow := map[string]interface{}{}
		for _, row := range ctx.TargetRows {
			if fmt.Sprintf("%v", row[ctx.PKColumn]) == fmt.Sprintf("%v", update.Keys[ctx.PKColumn]) {
				targetRow = row
				break
			}
		}
		sourceRow := map[string]interface{}{}
		for _, row := range ctx.SourceRows {
			if fmt.Sprintf("%v", row[ctx.PKColumn]) == fmt.Sprintf("%v", update.Keys[ctx.PKColumn]) {
				sourceRow = row
				break
			}
		}
		changedColumns := make([]string, 0, len(update.Values))
		for column := range update.Values {
			changedColumns = append(changedColumns, column)
		}
		out.Updates = append(out.Updates, PreviewUpdateRow{
			PK:             pk,
			ChangedColumns: changedColumns,
			Source:         sourceRow,
			Target:         targetRow,
		})
	}
	for idx, row := range deletes {
		if idx >= limit {
			break
		}
		pk := strings.TrimSpace(fmt.Sprintf("%v", row[ctx.PKColumn]))
		out.Deletes = append(out.Deletes, PreviewRow{PK: pk, Row: row})
	}
	return out, nil
}

func (s *SyncEngine) runSourceQuerySync(config SyncConfig) SyncResult {
	result := SyncResult{Success: true, Logs: []string{}}
	tableName, err := validateSourceQuerySyncConfig(config)
	if err != nil {
		return s.fail(config.JobID, 1, result, err.Error())
	}

	totalTables := 1
	tableMode := normalizeSyncMode(config.Mode)
	syncStartedStage := localizedSyncBackendText("data_sync.progress.stage.sync_started", nil)
	syncSourceLog := localizedSyncBackendText("data_sync.backend.log.source_query_sync_source", map[string]any{
		"table": tableName,
		"mode":  tableMode,
	})
	s.progress(config.JobID, 0, totalTables, tableName, syncStartedStage)
	s.appendLog(config.JobID, &result, "info", syncSourceLog)

	sourceDB, err := newSyncDatabase(config.SourceConfig.Type)
	if err != nil {
		return s.fail(config.JobID, totalTables, result, localizedSyncBackendDetailText("data_sync.backend.error.init_source_driver_failed", err))
	}
	targetDB, err := newSyncDatabase(config.TargetConfig.Type)
	if err != nil {
		return s.fail(config.JobID, totalTables, result, localizedSyncBackendDetailText("data_sync.backend.error.init_target_driver_failed", err))
	}

	if err := sourceDB.Connect(config.SourceConfig); err != nil {
		return s.fail(config.JobID, totalTables, result, localizedSyncBackendDetailText("data_sync.backend.error.connect_source_failed", err))
	}
	defer sourceDB.Close()

	if err := targetDB.Connect(config.TargetConfig); err != nil {
		return s.fail(config.JobID, totalTables, result, localizedSyncBackendDetailText("data_sync.backend.error.connect_target_failed", err))
	}
	defer targetDB.Close()

	opts := TableOptions{Insert: true, Update: true, Delete: false}
	if config.TableOptions != nil {
		if configured, ok := config.TableOptions[tableName]; ok {
			opts = configured
		}
	}
	if !hasEffectiveSyncDataOperation(tableMode, opts) {
		if tableMode == "insert_update" {
			s.appendLog(config.JobID, &result, "info", fmt.Sprintf("目标表 %s 未选择数据变更，按无变更处理", tableName))
			result.TablesSynced++
			s.progress(config.JobID, totalTables, totalTables, tableName, "同步完成")
			return result
		}
		return s.fail(config.JobID, totalTables, result, fmt.Sprintf("目标表 %s 在 %s 模式下未启用有效数据操作，已拒绝执行", tableName, tableMode))
	}

	needTargetRows := tableMode == "insert_update"
	requirePK := tableMode == "insert_update"
	ctx, err := loadSourceQuerySyncContext(config, sourceDB, targetDB, false, false, requirePK)
	if err != nil {
		return s.fail(config.JobID, totalTables, result, err.Error())
	}

	inserts := make([]map[string]interface{}, 0)
	updates := make([]connection.UpdateRow, 0)
	deletes := make([]map[string]interface{}, 0)
	applyTableName := ctx.TargetTable
	if shouldUseQualifiedSyncApplyTable(config.TargetConfig) {
		applyTableName = ctx.TargetQueryTable
	}

	if handled, counts, err := s.tryApplySourceQueryInPages(config, &result, tableName, sourceDB, targetDB, ctx, opts, tableMode, applyTableName); handled {
		result.RowsInserted += counts.Inserts
		result.RowsUpdated += counts.Updates
		result.RowsDeleted += counts.Deletes
		if err != nil {
			return s.fail(config.JobID, totalTables, result, "分页同步 SQL 结果集失败: "+err.Error())
		}
		result.TablesSynced++
		if counts.Inserts == 0 && counts.Updates == 0 && counts.Deletes == 0 {
			s.appendLog(config.JobID, &result, "info", "SQL 结果集与目标表一致，无需应用变更")
		} else {
			s.appendLog(config.JobID, &result, "info", fmt.Sprintf("SQL 结果集分页同步完成：插入=%d 更新=%d 删除=%d", counts.Inserts, counts.Updates, counts.Deletes))
		}
		s.progress(config.JobID, totalTables, totalTables, tableName, "同步完成")
		return result
	}

	ctx, err = loadSourceQuerySyncContext(config, sourceDB, targetDB, true, needTargetRows, requirePK)
	if err != nil {
		return s.fail(config.JobID, totalTables, result, err.Error())
	}
	if tableMode == "insert_update" {
		inserts, updates, deletes, _ = diffRowsByPK(ctx.PKColumn, ctx.SourceRows, ctx.TargetRows)
		inserts = filterRowsByPKSelection(ctx.PKColumn, inserts, opts.Insert, opts.SelectedInsertPKs)
		updates = filterUpdatesByPKSelection(ctx.PKColumn, updates, opts.Update, opts.SelectedUpdatePKs)
		deletes = filterRowsByPKSelection(ctx.PKColumn, deletes, opts.Delete, opts.SelectedDeletePKs)
	} else {
		inserts = ctx.SourceRows
		if !opts.Insert {
			inserts = nil
		}
	}

	changeSet := applyQuerySourceColumnFilter(connection.ChangeSet{
		Inserts: inserts,
		Updates: updates,
		Deletes: deletes,
	}, ctx.TargetCols)
	hasChanges := len(changeSet.Inserts) > 0 || len(changeSet.Updates) > 0 || len(changeSet.Deletes) > 0
	var applier db.BatchApplier
	if hasChanges {
		var ok bool
		applier, ok = targetDB.(db.BatchApplier)
		if !ok {
			return s.fail(config.JobID, totalTables, result, "目标驱动不支持应用数据变更 (ApplyChanges)")
		}
	}

	if tableMode == "full_overwrite" {
		s.progress(config.JobID, 0, totalTables, tableName, "清空目标表")
		clearSQL := fmt.Sprintf("DELETE FROM %s", quoteQualifiedIdentByType(ctx.TargetType, ctx.TargetQueryTable))
		if ctx.TargetType == "mysql" {
			clearSQL = fmt.Sprintf("TRUNCATE TABLE %s", quoteQualifiedIdentByType(ctx.TargetType, ctx.TargetQueryTable))
		}
		if _, err := targetDB.Exec(clearSQL); err != nil {
			return s.fail(config.JobID, totalTables, result, "清空目标表失败: "+err.Error())
		}
	}

	if !hasChanges {
		s.appendLog(config.JobID, &result, "info", "SQL 结果集与目标表一致，无需应用变更")
		result.TablesSynced++
		s.progress(config.JobID, totalTables, totalTables, tableName, "同步完成")
		return result
	}

	applied, err := s.applyChangesInBatches(config.JobID, &result, applyTableName, applier, changeSet)
	applied.addToResult(&result)
	if err != nil {
		return s.fail(config.JobID, totalTables, result, "应用 SQL 结果集变更失败: "+err.Error())
	}

	result.TablesSynced++
	s.appendLog(config.JobID, &result, "info", fmt.Sprintf("SQL 结果集同步完成：插入=%d 更新=%d 删除=%d", len(changeSet.Inserts), len(changeSet.Updates), len(changeSet.Deletes)))
	s.progress(config.JobID, totalTables, totalTables, tableName, "同步完成")
	return result
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
