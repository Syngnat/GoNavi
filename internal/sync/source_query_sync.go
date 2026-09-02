package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"context"
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
	PKColumns        []string
	SourceRows       []map[string]interface{}
	TargetRows       []map[string]interface{}
	SkippedRows      int
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

	mapping, mapped, err := sourceQueryMapping(config)
	if err != nil {
		return "", err
	}
	if mapped {
		if len(config.Tables) > 1 {
			return "", syncTextError("data_sync.backend.validation.single_target_table_required", nil)
		}
		return syncObjectRefIdentifier(mapping.Source), nil
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
	if mapping, mapped, err := sourceQueryMapping(config); err == nil && mapped {
		if value := strings.TrimSpace(mapping.Target.Schema); value != "" {
			targetSchema = value
		}
		if value := strings.TrimSpace(mapping.Target.Name); value != "" {
			targetTable = value
		}
		tableName = syncObjectRefIdentifier(mapping.Target)
	}
	targetQueryTable := qualifiedNameForQuery(targetType, targetSchema, targetTable, tableName)
	return targetType, targetSchema, targetTable, targetQueryTable
}

func resolvePKColumns(cols []connection.ColumnDefinition) ([]string, error) {
	pkCols := make([]string, 0, 2)
	for _, col := range cols {
		if col.Key == "PRI" || col.Key == "PK" {
			pkCols = append(pkCols, col.Name)
		}
	}
	if len(pkCols) == 0 {
		return nil, syncTextError("data_sync.backend.error.target_pk_required_for_query_diff", nil)
	}
	return pkCols, nil
}

func loadSourceQuerySyncContext(config SyncConfig, sourceDB db.Database, targetDB db.Database, needSourceRows bool, needTargetRows bool, requirePK bool) (sourceQuerySyncContext, error) {
	return loadSourceQuerySyncContextWithContext(context.Background(), config, sourceDB, targetDB, needSourceRows, needTargetRows, requirePK)
}

func loadSourceQuerySyncContextWithContext(runCtx context.Context, config SyncConfig, sourceDB db.Database, targetDB db.Database, needSourceRows bool, needTargetRows bool, requirePK bool) (sourceQuerySyncContext, error) {
	if runCtx == nil {
		runCtx = context.Background()
	}
	if err := runCtx.Err(); err != nil {
		return sourceQuerySyncContext{}, err
	}
	tableName, err := validateSourceQuerySyncConfig(config)
	if err != nil {
		return sourceQuerySyncContext{}, err
	}

	targetType, targetSchema, targetTable, targetQueryTable := resolveTargetQueryTable(config, tableName)
	targetCols, err := targetDB.GetColumns(targetSchema, targetTable)
	if err != nil {
		return sourceQuerySyncContext{}, syncWrapDetailError("data_sync.backend.error.load_target_columns_failed", err)
	}
	if err := runCtx.Err(); err != nil {
		return sourceQuerySyncContext{}, err
	}
	if len(targetCols) == 0 {
		return sourceQuerySyncContext{}, syncTextError("data_sync.backend.error.target_table_columns_missing", map[string]any{
			"table": tableName,
		})
	}
	projection, err := projectionForSourceQuery(config)
	if err != nil {
		return sourceQuerySyncContext{}, err
	}
	if missing := projection.MissingTargetColumns(targetCols, nil); len(missing) > 0 {
		return sourceQuerySyncContext{}, fmt.Errorf("SQL 结果映射目标表缺少字段：%s", strings.Join(missing, ", "))
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
		sourceRows, _, err := querySyncDatabaseContext(runCtx, sourceDB, strings.TrimSpace(config.SourceQuery))
		if err != nil {
			return sourceQuerySyncContext{}, syncWrapDetailError("data_sync.backend.error.execute_source_query_failed", err)
		}
		projectedRows, skippedRows, err := projectSnapshotRowsWithPolicy(runCtx, config, tableName, projection, sourceRows)
		if err != nil {
			return sourceQuerySyncContext{}, fmt.Errorf("SQL 结果字段投影失败: %w", err)
		}
		ctx.SourceRows = projectedRows
		ctx.SkippedRows = skippedRows
	}

	if requirePK {
		keyColumns, err := sourceQueryComparisonKeyColumns(config, targetCols)
		if err != nil {
			return sourceQuerySyncContext{}, err
		}
		ctx.PKColumns = keyColumns
		ctx.PKColumn = strings.Join(keyColumns, ",")
	}

	if needTargetRows {
		targetRows, _, err := querySyncDatabaseContext(runCtx, targetDB, fmt.Sprintf("SELECT * FROM %s", quoteQualifiedIdentByType(targetType, targetQueryTable)))
		if err != nil {
			return sourceQuerySyncContext{}, syncWrapDetailError("data_sync.backend.error.read_target_table_failed", err)
		}
		ctx.TargetRows = targetRows
	}
	if requirePK {
		if err := validateSourceQueryUniqueKeyRows(ctx.SourceRows, ctx.PKColumns, "source query result"); err != nil {
			return sourceQuerySyncContext{}, err
		}
		if err := validateSourceQueryUniqueKeyRows(ctx.TargetRows, ctx.PKColumns, "target table"); err != nil {
			return sourceQuerySyncContext{}, err
		}
	}

	return ctx, nil
}

func validateSourceQueryUniqueKeyRows(rows []map[string]interface{}, keyColumns []string, side string) error {
	seen := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		key, ok := syncRowKey(row, keyColumns)
		if !ok {
			return fmt.Errorf("%s contains a row without a complete stable key (%s)", side, strings.Join(keyColumns, ", "))
		}
		if _, exists := seen[key]; exists {
			return fmt.Errorf("%s contains duplicate stable key values (%s)", side, strings.Join(keyColumns, ", "))
		}
		seen[key] = struct{}{}
	}
	return nil
}

func projectionForSourceQuery(config SyncConfig) (*CompiledProjection, error) {
	mapping, mapped, err := sourceQueryMapping(config)
	if err != nil {
		return nil, err
	}
	if !mapped {
		return CompileProjection(SyncObjectMapping{})
	}
	return CompileProjection(mapping)
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

// sourceQuerySelectionKeyColumns returns the key exposed to row selection for
// a direct query import. A mapped query may declare its own stable key; an
// unmapped query falls back to the target table's physical primary key.
// Unlike insert_update, direct imports do not require either kind of key.
func sourceQuerySelectionKeyColumns(config SyncConfig, targetCols []connection.ColumnDefinition) ([]string, error) {
	mapping, mapped, err := sourceQueryMapping(config)
	if err != nil {
		return nil, err
	}
	if mapped {
		if len(mapping.KeyColumns) == 0 {
			return nil, nil
		}
		projection, err := CompileProjection(mapping)
		if err != nil {
			return nil, err
		}
		keyColumns := make([]string, 0, len(mapping.KeyColumns))
		for _, sourceKey := range mapping.KeyColumns {
			targetKey, ok := projection.TargetColumn(sourceKey)
			if !ok || strings.TrimSpace(targetKey) == "" {
				return nil, fmt.Errorf("SQL 结果映射稳定 key %s 未映射到目标字段", sourceKey)
			}
			keyColumns = append(keyColumns, targetKey)
		}
		return keyColumns, nil
	}

	keyColumns, err := resolvePKColumns(targetCols)
	if err != nil {
		// A key is optional for insert_only/full_overwrite. Callers requiring a
		// comparison key use loadSourceQuerySyncContext(..., requirePK=true).
		return nil, nil
	}
	return keyColumns, nil
}

// sourceQueryComparisonKeyColumns resolves the stable key required by an
// insert_update query sync. An explicit mapping key is a valid business key;
// requiring the target table to also declare it as a physical PK would make
// KeyColumns ineffective for legacy tables.
func sourceQueryComparisonKeyColumns(config SyncConfig, targetCols []connection.ColumnDefinition) ([]string, error) {
	mapping, mapped, err := sourceQueryMapping(config)
	if err != nil {
		return nil, err
	}
	if mapped && len(mapping.KeyColumns) > 0 {
		return sourceQuerySelectionKeyColumns(config, targetCols)
	}
	return resolvePKColumns(targetCols)
}

func hasSourceQueryRowSelection(opts TableOptions) bool {
	return len(opts.SelectedInsertPKs) > 0 || len(opts.SelectedUpdatePKs) > 0 || len(opts.SelectedDeletePKs) > 0
}

func sourceQueryRowsHaveSelectionKey(rows []map[string]interface{}, keyColumns []string) bool {
	if len(keyColumns) == 0 {
		return false
	}
	for _, row := range rows {
		if _, ok := selectionRowKey(row, keyColumns); !ok {
			return false
		}
	}
	return true
}

func (s *SyncEngine) analyzeSourceQuery(config SyncConfig) SyncAnalyzeResult {
	// validateSourceQuerySyncConfig rejects any content other than "data", so
	// echo it explicitly instead of leaving the field empty and letting the UI
	// fall back to the task's compareMode.
	result := SyncAnalyzeResult{Success: true, Content: "data", Tables: []TableDiffSummary{}}
	cancelledResult := func(summary *TableDiffSummary) SyncAnalyzeResult {
		err := s.contextError()
		if err == nil {
			return result
		}
		result.Success = false
		result.Message = err.Error()
		if summary != nil {
			summary.Message = err.Error()
			result.Tables = append(result.Tables, *summary)
		}
		return result
	}
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
		if s.contextError() != nil {
			return cancelledResult(nil)
		}
		return SyncAnalyzeResult{Success: false, Message: localizedSyncBackendDetailText("data_sync.backend.error.connect_source_failed", err)}
	}
	if s.contextError() != nil {
		_ = sourceDB.Close()
		return cancelledResult(nil)
	}
	defer sourceDB.Close()
	db.BindMetadataContext(sourceDB, s.context())
	defer db.ClearMetadataContext(sourceDB)

	if err := targetDB.Connect(config.TargetConfig); err != nil {
		if s.contextError() != nil {
			return cancelledResult(nil)
		}
		return SyncAnalyzeResult{Success: false, Message: localizedSyncBackendDetailText("data_sync.backend.error.connect_target_failed", err)}
	}
	if s.contextError() != nil {
		_ = targetDB.Close()
		return cancelledResult(nil)
	}
	defer targetDB.Close()
	db.BindMetadataContext(targetDB, s.context())
	defer db.ClearMetadataContext(targetDB)

	summary := TableDiffSummary{
		Table:   tableName,
		CanSync: false,
	}
	tableMode := normalizeSyncMode(config.Mode)
	requiresComparisonKey := tableMode == "insert_update"
	ctx, err := loadSourceQuerySyncContextWithContext(s.context(), config, sourceDB, targetDB, false, false, requiresComparisonKey)
	if err != nil {
		if s.contextError() != nil {
			return cancelledResult(&summary)
		}
		summary.Message = err.Error()
		result.Tables = append(result.Tables, summary)
		result.Message = analyzedTargetTablesMessage
		s.progress(config.JobID, totalTables, totalTables, tableName, analysisCompletedStage)
		return result
	}
	if !requiresComparisonKey {
		sourceType := resolveMigrationDBType(config.SourceConfig)
		sourceCount, counted, err := countSourceQueryRowsForSyncContext(s.context(), sourceDB, sourceType, config.SourceQuery)
		if err != nil {
			if s.contextError() != nil {
				return cancelledResult(&summary)
			}
			summary.Message = localizedSyncBackendDetailText("data_sync.backend.error.execute_source_query_failed", err)
			result.Tables = append(result.Tables, summary)
			result.Message = analyzedTargetTablesMessage
			s.progress(config.JobID, totalTables, totalTables, tableName, analysisCompletedStage)
			return result
		}
		if !counted {
			sourceRows, _, err := querySyncDatabaseContext(s.context(), sourceDB, strings.TrimSpace(config.SourceQuery))
			if err != nil {
				summary.Message = localizedSyncBackendDetailText("data_sync.backend.error.execute_source_query_failed", err)
				result.Tables = append(result.Tables, summary)
				result.Message = analyzedTargetTablesMessage
				s.progress(config.JobID, totalTables, totalTables, tableName, analysisCompletedStage)
				return result
			}
			sourceCount = len(sourceRows)
		}
		summary.CanSync = true
		summary.Inserts = sourceCount
		summary.TargetTableExists = true
		summary.Message = localizedSyncBackendText("data_sync.plan.data_import_without_diff", nil)
		result.Tables = append(result.Tables, summary)
		result.Message = analyzedTargetTablesMessage
		s.progress(config.JobID, totalTables, totalTables, tableName, analysisCompletedStage)
		return result
	}

	sourceType := resolveMigrationDBType(config.SourceConfig)
	handled := false
	counts := pagedDiffCounts{}
	var scanErr error
	if !hasExplicitSyncMappings(config) && len(ctx.PKColumns) == 1 {
		handled, counts, scanErr = scanSourceQueryDiffInPagesContext(s.context(), sourceDB, targetDB, sourceType, ctx.TargetType, strings.TrimSpace(config.SourceQuery), ctx.TargetQueryTable, ctx.TargetCols, ctx.PKColumn, true, nil)
	}
	if handled {
		if scanErr != nil {
			if s.contextError() != nil {
				return cancelledResult(&summary)
			}
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

	ctx, err = loadSourceQuerySyncContextWithContext(s.context(), config, sourceDB, targetDB, true, true, true)
	if err != nil {
		if s.contextError() != nil {
			return cancelledResult(&summary)
		}
		summary.Message = err.Error()
		result.Tables = append(result.Tables, summary)
		result.Message = analyzedTargetTablesMessage
		s.progress(config.JobID, totalTables, totalTables, tableName, analysisCompletedStage)
		return result
	}

	inserts, updates, deletes, same := diffRowsByKeyColumns(ctx.PKColumns, ctx.SourceRows, ctx.TargetRows)
	if s.contextError() != nil {
		return cancelledResult(&summary)
	}
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
		if contextErr := s.contextError(); contextErr != nil {
			return TableDiffPreview{}, contextErr
		}
		return TableDiffPreview{}, syncWrapDetailError("data_sync.backend.error.connect_source_failed", err)
	}
	if err := s.contextError(); err != nil {
		_ = sourceDB.Close()
		return TableDiffPreview{}, err
	}
	defer sourceDB.Close()
	db.BindMetadataContext(sourceDB, s.context())
	defer db.ClearMetadataContext(sourceDB)

	if err := targetDB.Connect(config.TargetConfig); err != nil {
		if contextErr := s.contextError(); contextErr != nil {
			return TableDiffPreview{}, contextErr
		}
		return TableDiffPreview{}, syncWrapDetailError("data_sync.backend.error.connect_target_failed", err)
	}
	if err := s.contextError(); err != nil {
		_ = targetDB.Close()
		return TableDiffPreview{}, err
	}
	defer targetDB.Close()
	db.BindMetadataContext(targetDB, s.context())
	defer db.ClearMetadataContext(targetDB)

	tableMode := normalizeSyncMode(config.Mode)
	requiresComparisonKey := tableMode == "insert_update"
	ctx, err := loadSourceQuerySyncContextWithContext(s.context(), config, sourceDB, targetDB, false, false, requiresComparisonKey)
	if err != nil {
		return TableDiffPreview{}, err
	}

	previewSummary := localizedSyncBackendText("data_sync.plan.source_query_preview", nil)
	if !requiresComparisonKey {
		ctx, err = loadSourceQuerySyncContextWithContext(s.context(), config, sourceDB, targetDB, true, false, false)
		if err != nil {
			return TableDiffPreview{}, err
		}
		selectionKeyColumns, err := sourceQuerySelectionKeyColumns(config, ctx.TargetCols)
		if err != nil {
			return TableDiffPreview{}, err
		}
		selectionSupported := sourceQueryRowsHaveSelectionKey(ctx.SourceRows, selectionKeyColumns)
		out := TableDiffPreview{
			Table:                 ctx.TableName,
			RowSelectionSupported: selectionSupported,
			ColumnTypes:           make(map[string]string, len(ctx.TargetCols)),
			SchemaSummary:         previewSummary,
			TotalInserts:          len(ctx.SourceRows),
			Inserts:               make([]PreviewRow, 0, minInt(limit, len(ctx.SourceRows))),
			Updates:               make([]PreviewUpdateRow, 0),
			Deletes:               make([]PreviewRow, 0),
		}
		if selectionSupported {
			out.PKColumns = append([]string(nil), selectionKeyColumns...)
			out.PKColumn = strings.Join(selectionKeyColumns, ",")
		}
		for _, col := range ctx.TargetCols {
			name := strings.ToLower(strings.TrimSpace(col.Name))
			typ := strings.TrimSpace(col.Type)
			if name != "" && typ != "" {
				out.ColumnTypes[name] = typ
			}
		}
		for _, row := range ctx.SourceRows {
			if err := s.contextError(); err != nil {
				return TableDiffPreview{}, err
			}
			if len(out.Inserts) >= limit {
				break
			}
			key := ""
			if selectionSupported {
				key, _ = selectionRowKey(row, selectionKeyColumns)
			}
			out.Inserts = append(out.Inserts, PreviewRow{PK: key, Row: row})
		}
		return out, nil
	}

	sourceType := resolveMigrationDBType(config.SourceConfig)
	out := TableDiffPreview{
		Table:                 ctx.TableName,
		PKColumn:              ctx.PKColumn,
		PKColumns:             append([]string(nil), ctx.PKColumns...),
		RowSelectionSupported: true,
		ColumnTypes:           make(map[string]string, len(ctx.TargetCols)),
		SchemaSummary:         previewSummary,
		Inserts:               make([]PreviewRow, 0, limit),
		Updates:               make([]PreviewUpdateRow, 0, limit),
		Deletes:               make([]PreviewRow, 0, limit),
	}
	for _, col := range ctx.TargetCols {
		name := strings.ToLower(strings.TrimSpace(col.Name))
		typ := strings.TrimSpace(col.Type)
		if name == "" || typ == "" {
			continue
		}
		out.ColumnTypes[name] = typ
	}

	handled := false
	var scanErr error
	if !hasExplicitSyncMappings(config) && len(ctx.PKColumns) == 1 {
		handled, _, scanErr = scanSourceQueryDiffInPagesContext(s.context(), sourceDB, targetDB, sourceType, ctx.TargetType, strings.TrimSpace(config.SourceQuery), ctx.TargetQueryTable, ctx.TargetCols, ctx.PKColumn, true, func(page pagedDiffPage) error {
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
	}
	if handled {
		if scanErr != nil {
			return TableDiffPreview{}, scanErr
		}
		return out, nil
	}

	ctx, err = loadSourceQuerySyncContextWithContext(s.context(), config, sourceDB, targetDB, true, true, true)
	if err != nil {
		return TableDiffPreview{}, err
	}

	inserts, updates, deletes, _ := diffRowsByKeyColumns(ctx.PKColumns, ctx.SourceRows, ctx.TargetRows)
	if err := s.contextError(); err != nil {
		return TableDiffPreview{}, err
	}
	out = TableDiffPreview{
		Table:                 ctx.TableName,
		PKColumn:              ctx.PKColumn,
		PKColumns:             append([]string(nil), ctx.PKColumns...),
		RowSelectionSupported: true,
		ColumnTypes:           make(map[string]string, len(ctx.TargetCols)),
		SchemaSummary:         previewSummary,
		TotalInserts:          len(inserts),
		TotalUpdates:          len(updates),
		TotalDeletes:          len(deletes),
		Inserts:               make([]PreviewRow, 0, minInt(limit, len(inserts))),
		Updates:               make([]PreviewUpdateRow, 0, minInt(limit, len(updates))),
		Deletes:               make([]PreviewRow, 0, minInt(limit, len(deletes))),
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
		key, ok := selectionRowKey(row, ctx.PKColumns)
		if ok {
			out.Inserts = append(out.Inserts, PreviewRow{PK: key, Row: row})
		}
	}
	for idx, update := range updates {
		if idx >= limit {
			break
		}
		identityKey, ok := syncRowKey(update.Keys, ctx.PKColumns)
		if !ok {
			continue
		}
		displayKey, _ := selectionRowKey(update.Keys, ctx.PKColumns)
		targetRow := map[string]interface{}{}
		for _, row := range ctx.TargetRows {
			rowKey, rowOK := syncRowKey(row, ctx.PKColumns)
			if rowOK && rowKey == identityKey {
				targetRow = row
				break
			}
		}
		sourceRow := map[string]interface{}{}
		for _, row := range ctx.SourceRows {
			rowKey, rowOK := syncRowKey(row, ctx.PKColumns)
			if rowOK && rowKey == identityKey {
				sourceRow = row
				break
			}
		}
		changedColumns := make([]string, 0, len(update.Values))
		for column := range update.Values {
			changedColumns = append(changedColumns, column)
		}
		out.Updates = append(out.Updates, PreviewUpdateRow{
			PK:             displayKey,
			ChangedColumns: changedColumns,
			Source:         sourceRow,
			Target:         targetRow,
		})
	}
	for idx, row := range deletes {
		if idx >= limit {
			break
		}
		key, ok := selectionRowKey(row, ctx.PKColumns)
		if ok {
			out.Deletes = append(out.Deletes, PreviewRow{PK: key, Row: row})
		}
	}
	return out, nil
}

func (s *SyncEngine) runSourceQuerySync(config SyncConfig) SyncResult {
	result := SyncResult{Success: true, Logs: []string{}}
	if err := s.contextError(); err != nil {
		return s.fail(config.JobID, 1, result, err.Error())
	}
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

	if err := s.contextError(); err != nil {
		return s.fail(config.JobID, totalTables, result, err.Error())
	}
	if err := sourceDB.Connect(config.SourceConfig); err != nil {
		return s.fail(config.JobID, totalTables, result, localizedSyncBackendDetailText("data_sync.backend.error.connect_source_failed", err))
	}
	defer sourceDB.Close()
	if err := s.contextError(); err != nil {
		return s.fail(config.JobID, totalTables, result, err.Error())
	}

	if err := targetDB.Connect(config.TargetConfig); err != nil {
		return s.fail(config.JobID, totalTables, result, localizedSyncBackendDetailText("data_sync.backend.error.connect_target_failed", err))
	}
	defer targetDB.Close()
	if err := s.contextError(); err != nil {
		return s.fail(config.JobID, totalTables, result, err.Error())
	}

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
	ctx, err := loadSourceQuerySyncContextWithContext(s.context(), config, sourceDB, targetDB, false, false, requirePK)
	if err != nil {
		return s.fail(config.JobID, totalTables, result, err.Error())
	}
	selectionKeyColumns := append([]string(nil), ctx.PKColumns...)
	if !requirePK {
		selectionKeyColumns, err = sourceQuerySelectionKeyColumns(config, ctx.TargetCols)
		if err != nil {
			return s.fail(config.JobID, totalTables, result, err.Error())
		}
	}
	if hasSourceQueryRowSelection(opts) && len(selectionKeyColumns) == 0 {
		return s.fail(config.JobID, totalTables, result, fmt.Sprintf("SQL 结果目标表 %s 未找到主键或映射稳定 key，不能按指定行同步", tableName))
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

	ctx, err = loadSourceQuerySyncContextWithContext(s.context(), config, sourceDB, targetDB, true, needTargetRows, requirePK)
	if err != nil {
		return s.fail(config.JobID, totalTables, result, err.Error())
	}
	result.RowsSkipped += ctx.SkippedRows
	if tableMode == "insert_update" {
		inserts, updates, deletes, _ = diffRowsByKeyColumns(ctx.PKColumns, ctx.SourceRows, ctx.TargetRows)
		inserts = filterRowsByKeySelection(ctx.PKColumns, inserts, opts.Insert, opts.SelectedInsertPKs)
		updates = filterUpdatesByKeySelection(ctx.PKColumns, updates, opts.Update, opts.SelectedUpdatePKs)
		deletes = filterRowsByKeySelection(ctx.PKColumns, deletes, opts.Delete, opts.SelectedDeletePKs)
	} else {
		inserts = ctx.SourceRows
		if !opts.Insert {
			inserts = nil
		} else if len(opts.SelectedInsertPKs) > 0 {
			if !sourceQueryRowsHaveSelectionKey(inserts, selectionKeyColumns) {
				return s.fail(config.JobID, totalTables, result, fmt.Sprintf("SQL 结果目标表 %s 缺少稳定 key 字段，不能按指定行同步", tableName))
			}
			inserts = filterRowsByKeySelection(selectionKeyColumns, inserts, true, opts.SelectedInsertPKs)
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
		if _, err := execSyncDatabaseContext(s.context(), targetDB, clearSQL); err != nil {
			return s.fail(config.JobID, totalTables, result, "清空目标表失败: "+err.Error())
		}
	}

	if !hasChanges {
		if err := s.contextError(); err != nil {
			return s.fail(config.JobID, totalTables, result, err.Error())
		}
		s.appendLog(config.JobID, &result, "info", "SQL 结果集与目标表一致，无需应用变更")
		result.TablesSynced++
		s.progress(config.JobID, totalTables, totalTables, tableName, "同步完成")
		return result
	}

	applied, err := s.applySnapshotChanges(config, &result, tableName, applyTableName, applier, changeSet, 0)
	applied.addToResult(&result)
	if err != nil {
		return s.fail(config.JobID, totalTables, result, "应用 SQL 结果集变更失败: "+err.Error())
	}

	result.TablesSynced++
	s.appendLog(config.JobID, &result, "info", fmt.Sprintf("SQL 结果集同步完成：插入=%d 更新=%d 删除=%d", applied.Inserts, applied.Updates, applied.Deletes))
	s.progress(config.JobID, totalTables, totalTables, tableName, "同步完成")
	return result
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
