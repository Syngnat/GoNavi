package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"fmt"
	"strings"
)

func (s *SyncEngine) tryApplySourceQueryInPages(config SyncConfig, res *SyncResult, tableName string, sourceDB db.Database, targetDB db.Database, ctx sourceQuerySyncContext, opts TableOptions, tableMode string, applyTableName string) (bool, pagedDiffCounts, error) {
	sourceType := resolveMigrationDBType(config.SourceConfig)
	if !supportsPagedSourceQuery(sourceType) || !supportsPagedDiffPKLookup(ctx.TargetType) {
		return false, pagedDiffCounts{}, nil
	}
	if strings.TrimSpace(buildSourceQueryPageSQL(sourceType, config.SourceQuery, ctx.PKColumn, defaultSyncReadPageSize, 0)) == "" {
		return false, pagedDiffCounts{}, nil
	}

	applier, ok := targetDB.(db.BatchApplier)
	if !ok {
		return true, pagedDiffCounts{}, fmt.Errorf("目标驱动不支持应用数据变更 (ApplyChanges)")
	}
	targetColSet := buildTargetColumnSet(ctx.TargetCols)
	counts := pagedDiffCounts{}

	if tableMode == "insert_update" {
		includeDeletes := opts.Delete
		handled, _, err := scanSourceQueryDiffInPages(sourceDB, targetDB, sourceType, ctx.TargetType, strings.TrimSpace(config.SourceQuery), ctx.TargetQueryTable, ctx.TargetCols, ctx.PKColumn, includeDeletes, func(page pagedDiffPage) error {
			changeSet := connection.ChangeSet{
				Inserts: filterRowsByPKSelection(ctx.PKColumn, page.Inserts, opts.Insert, opts.SelectedInsertPKs),
				Updates: filterPagedUpdatesByPKSelection(ctx.PKColumn, page.Updates, opts.Update, opts.SelectedUpdatePKs),
				Deletes: filterRowsByPKSelection(ctx.PKColumn, page.Deletes, opts.Delete, opts.SelectedDeletePKs),
			}
			changeSet.Inserts = filterInsertRows(changeSet.Inserts, targetColSet)
			changeSet.Updates = filterUpdateRows(changeSet.Updates, targetColSet)
			if len(changeSet.Inserts) == 0 && len(changeSet.Updates) == 0 && len(changeSet.Deletes) == 0 {
				return nil
			}
			if err := s.applyChangesInBatches(config.JobID, res, applyTableName, applier, changeSet); err != nil {
				return err
			}
			counts.Inserts += len(changeSet.Inserts)
			counts.Updates += len(changeSet.Updates)
			counts.Deletes += len(changeSet.Deletes)
			return nil
		})
		if err != nil {
			return true, counts, err
		}
		return handled, counts, nil
	}

	clearTarget := func() error {
		clearSQL := buildClearTargetTableSQL(ctx.TargetType, ctx.TargetQueryTable)
		if _, err := targetDB.Exec(clearSQL); err != nil {
			return fmt.Errorf("清空目标表失败: %w", err)
		}
		return nil
	}

	if tableMode == "full_overwrite" {
		// 源是任意 SQL，无法可靠判断它是否引用了目标表。只要源与目标是同一物理端点就退回
		// 非分页路径（该路径先把源行全部读入内存、之后才清空目标，语义安全）。
		// 分页 + 自表覆盖本质上不可行：清空之后的分页会读到空表，目标最终只剩第一页数据。
		if isSameSyncEndpoint(config, sourceType, ctx.TargetType) {
			return false, pagedDiffCounts{}, nil
		}
	}

	if !opts.Insert {
		// 不插入任何数据时无需预读，按既有语义仅清空目标表。
		if tableMode == "full_overwrite" {
			if err := clearTarget(); err != nil {
				return true, counts, err
			}
		}
		return true, counts, nil
	}

	// 先读首页、成功后才清空目标（与 tryApplyDirectImportInPages 一致）。
	// 原先的顺序是先 TRUNCATE 再首读，一旦源查询报错就留下一张被清空且无法恢复的目标表，
	// 而函数还会把「读到 0 行」当成同步成功返回。
	firstQuery := buildSourceQueryPageSQL(sourceType, config.SourceQuery, ctx.PKColumn, defaultSyncReadPageSize, 0)
	firstRows, _, err := sourceDB.Query(firstQuery)
	if err != nil {
		return true, counts, fmt.Errorf("分页读取源查询失败(offset=%d): %w", 0, err)
	}

	if tableMode == "full_overwrite" {
		if err := clearTarget(); err != nil {
			return true, counts, err
		}
	}

	applyPage := func(rows []map[string]interface{}) error {
		insertRows := filterRowsByPKSelection(ctx.PKColumn, rows, opts.Insert, opts.SelectedInsertPKs)
		insertRows = filterInsertRows(insertRows, targetColSet)
		if len(insertRows) == 0 {
			return nil
		}
		if err := s.applyChangesInBatches(config.JobID, res, applyTableName, applier, connection.ChangeSet{Inserts: insertRows}); err != nil {
			return err
		}
		counts.Inserts += len(insertRows)
		return nil
	}

	if len(firstRows) == 0 {
		return true, counts, nil
	}
	if err := applyPage(firstRows); err != nil {
		return true, counts, err
	}
	if len(firstRows) < defaultSyncReadPageSize {
		return true, counts, nil
	}

	for offset := defaultSyncReadPageSize; ; offset += defaultSyncReadPageSize {
		query := buildSourceQueryPageSQL(sourceType, config.SourceQuery, ctx.PKColumn, defaultSyncReadPageSize, offset)
		rows, _, err := sourceDB.Query(query)
		if err != nil {
			return true, counts, fmt.Errorf("分页读取源查询失败(offset=%d): %w", offset, err)
		}
		if len(rows) == 0 {
			return true, counts, nil
		}
		if err := applyPage(rows); err != nil {
			return true, counts, err
		}
		if len(rows) < defaultSyncReadPageSize {
			return true, counts, nil
		}
	}
}

func scanSourceQueryDiffInPages(sourceDB db.Database, targetDB db.Database, sourceType, targetType, sourceQuery, targetQueryTable string, targetCols []connection.ColumnDefinition, pkCol string, includeDeletes bool, consume func(page pagedDiffPage) error) (bool, pagedDiffCounts, error) {
	if !supportsPagedSourceQuery(sourceType) || !supportsPagedDiffPKLookup(targetType) {
		return false, pagedDiffCounts{}, nil
	}
	if includeDeletes && (!supportsPagedDiffKeysetSelect(targetType) || !supportsPagedSourceQueryPKLookup(sourceType)) {
		return false, pagedDiffCounts{}, nil
	}

	sourcePageQuery := buildSourceQueryPageSQL(sourceType, sourceQuery, pkCol, defaultSyncReadPageSize, 0)
	if strings.TrimSpace(sourcePageQuery) == "" {
		return false, pagedDiffCounts{}, nil
	}
	targetLookupCols := diffLookupColumns(targetCols, targetCols, buildTargetColumnSet(targetCols), pkCol)
	if len(targetLookupCols) == 0 {
		targetLookupCols = []connection.ColumnDefinition{{Name: pkCol}}
	}

	totals := pagedDiffCounts{}
	for offset := 0; ; offset += defaultSyncReadPageSize {
		query := buildSourceQueryPageSQL(sourceType, sourceQuery, pkCol, defaultSyncReadPageSize, offset)
		sourceRows, _, err := sourceDB.Query(query)
		if err != nil {
			return true, totals, fmt.Errorf("分页读取源查询失败(offset=%d): %w", offset, err)
		}
		if len(sourceRows) == 0 {
			break
		}

		pkValues := collectPKValues(sourceRows, pkCol)
		targetRows := make([]map[string]interface{}, 0)
		if len(pkValues) > 0 {
			targetQuery := buildPKInSelectQuery(targetType, targetQueryTable, targetLookupCols, pkCol, pkValues)
			if strings.TrimSpace(targetQuery) == "" {
				return false, pagedDiffCounts{}, nil
			}
			targetRows, _, err = targetDB.Query(targetQuery)
			if err != nil {
				return true, totals, fmt.Errorf("按主键读取目标表失败(offset=%d): %w", offset, err)
			}
		}

		page := diffSourcePageByPK(pkCol, sourceRows, targetRows)
		totals.Inserts += len(page.Inserts)
		totals.Updates += len(page.Updates)
		totals.Same += page.Same
		if consume != nil {
			if err := consume(page); err != nil {
				return true, totals, err
			}
		}
		if len(sourceRows) < defaultSyncReadPageSize {
			break
		}
	}

	if includeDeletes {
		lastPK, hasLastPK := interface{}(nil), false
		targetPKCols := []connection.ColumnDefinition{{Name: pkCol}}
		for {
			query := buildKeysetPagedTableQuery(targetType, targetQueryTable, targetPKCols, pkCol, lastPK, hasLastPK, defaultSyncReadPageSize)
			targetRows, _, err := targetDB.Query(query)
			if err != nil {
				return true, totals, fmt.Errorf("分页读取目标主键失败: %w", err)
			}
			if len(targetRows) == 0 {
				break
			}

			nextLastPK, ok := lastValidPKValue(targetRows, pkCol)
			if !ok {
				break
			}
			lastPK, hasLastPK = nextLastPK, true

			pkValues := collectPKValues(targetRows, pkCol)
			sourcePKRows := make([]map[string]interface{}, 0)
			if len(pkValues) > 0 {
				sourceQuery := buildSourceQueryPKInSelectSQL(sourceType, sourceQuery, []connection.ColumnDefinition{{Name: pkCol}}, pkCol, pkValues)
				if strings.TrimSpace(sourceQuery) == "" {
					return false, pagedDiffCounts{}, nil
				}
				sourcePKRows, _, err = sourceDB.Query(sourceQuery)
				if err != nil {
					return true, totals, fmt.Errorf("按主键反查源查询失败: %w", err)
				}
			}

			sourcePKSet := buildPKSet(sourcePKRows, pkCol)
			deletes := make([]map[string]interface{}, 0)
			for _, row := range targetRows {
				pkKey, ok := pkValueKey(row[pkCol])
				if !ok {
					continue
				}
				if _, exists := sourcePKSet[pkKey]; exists {
					continue
				}
				deletes = append(deletes, map[string]interface{}{pkCol: row[pkCol]})
			}
			if len(deletes) > 0 {
				totals.Deletes += len(deletes)
				if consume != nil {
					if err := consume(pagedDiffPage{Deletes: deletes}); err != nil {
						return true, totals, err
					}
				}
			}
			if len(targetRows) < defaultSyncReadPageSize {
				break
			}
		}
	}
	return true, totals, nil
}

func buildSourceQueryPageSQL(dbType, sourceQuery, orderCol string, limit, offset int) string {
	subquery, ok := normalizeSourceQueryForPaging(sourceQuery)
	if !ok {
		return ""
	}
	baseSQL := fmt.Sprintf("SELECT * FROM (%s) AS __gonavi_source_query__", subquery)
	orderBy := ""
	if strings.TrimSpace(orderCol) != "" {
		orderBy = fmt.Sprintf(" ORDER BY %s ASC", quoteIdentByType(dbType, orderCol))
	}
	return buildPaginatedSelectSQLForSync(dbType, baseSQL, "*", orderBy, limit, offset)
}

func buildSourceQueryPKInSelectSQL(dbType, sourceQuery string, cols []connection.ColumnDefinition, pkCol string, pkValues []interface{}) string {
	subquery, ok := normalizeSourceQueryForPaging(sourceQuery)
	if !ok || len(pkValues) == 0 {
		return ""
	}
	selectList := buildColumnSelectListForSync(dbType, cols)
	if strings.TrimSpace(selectList) == "" {
		selectList = "*"
	}
	literals := make([]string, 0, len(pkValues))
	for _, value := range pkValues {
		literal, ok := formatSyncSQLLiteral(dbType, value)
		if ok {
			literals = append(literals, literal)
		}
	}
	if len(literals) == 0 {
		return ""
	}
	return fmt.Sprintf("SELECT %s FROM (%s) AS __gonavi_source_query__ WHERE %s IN (%s)",
		selectList,
		subquery,
		quoteIdentByType(dbType, pkCol),
		strings.Join(literals, ", "))
}

func countSourceQueryRowsForSync(database db.Database, dbType, sourceQuery string) (int, bool, error) {
	subquery, ok := normalizeSourceQueryForPaging(sourceQuery)
	if !ok {
		return 0, false, nil
	}
	query := fmt.Sprintf("SELECT COUNT(*) AS __gonavi_count__ FROM (%s) AS __gonavi_source_query__", subquery)
	rows, _, err := database.Query(query)
	if err != nil {
		return 0, true, err
	}
	if len(rows) == 0 {
		return 0, false, nil
	}
	for _, value := range rows[0] {
		count, ok := intFromSyncValue(value)
		if ok {
			return count, true, nil
		}
	}
	return 0, false, nil
}

func normalizeSourceQueryForPaging(query string) (string, bool) {
	trimmed := strings.TrimSpace(query)
	if trimmed == "" {
		return "", false
	}
	trimmed = strings.TrimSuffix(trimmed, ";")
	trimmed = strings.TrimSpace(trimmed)
	lower := strings.ToLower(trimmed)
	if !(strings.HasPrefix(lower, "select ") || strings.HasPrefix(lower, "with ")) {
		return "", false
	}
	if strings.Contains(trimmed, ";") {
		return "", false
	}
	return trimmed, true
}

func supportsPagedSourceQuery(dbType string) bool {
	return supportsDirectImportPagination(dbType)
}

func supportsPagedSourceQueryPKLookup(dbType string) bool {
	return supportsDirectImportPagination(dbType)
}
