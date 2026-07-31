package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"fmt"
	"strings"
)

const defaultSyncReadPageSize = defaultSyncApplyBatchSize

func (s *SyncEngine) tryApplyDirectImportInPages(config SyncConfig, res *SyncResult, tableIndex, totalTables int, tableName string, sourceDB db.Database, targetDB db.Database, plan SchemaMigrationPlan, sourceCols, targetCols []connection.ColumnDefinition, opts TableOptions, sourceType, targetType, applyTableName string) (bool, int, error) {
	tableMode := normalizeSyncMode(config.Mode)
	if tableMode == "insert_update" && plan.TargetTableExists {
		return false, 0, nil
	}
	if tableMode == "full_overwrite" && plan.TargetTableExists && isSamePhysicalSyncTable(config, plan, sourceType, targetType) {
		return false, 0, nil
	}
	if !opts.Insert {
		return false, 0, nil
	}

	pkCol, ok := directImportPaginationPK(sourceType, sourceCols)
	if !ok && !supportsDirectImportPagination(sourceType) {
		return false, 0, nil
	}
	if !ok && len(opts.SelectedInsertPKs) > 0 {
		return false, 0, nil
	}

	firstPageQuery := buildPagedSourceTableQuery(sourceType, plan.SourceQueryTable, sourceCols, pkCol, defaultSyncReadPageSize, 0)
	if strings.TrimSpace(firstPageQuery) == "" {
		return false, 0, nil
	}

	applier, ok := targetDB.(db.BatchApplier)
	if !ok {
		return true, 0, fmt.Errorf("目标驱动不支持应用数据变更 (ApplyChanges)")
	}

	if strings.TrimSpace(pkCol) != "" {
		s.appendLog(config.JobID, res, "info", fmt.Sprintf("  -> 启用分页流式导入：按主键 %s 每批读取 %d 行", pkCol, defaultSyncReadPageSize))
	} else {
		s.appendLog(config.JobID, res, "info", fmt.Sprintf("  -> 启用分页流式导入：每批读取 %d 行", defaultSyncReadPageSize))
	}
	s.progress(config.JobID, tableIndex, totalTables, tableName, "分页读取源表数据")
	firstRows, _, err := sourceDB.Query(firstPageQuery)
	if err != nil {
		return true, 0, fmt.Errorf("分页读取源表失败: %w", err)
	}

	if tableMode == "full_overwrite" && plan.TargetTableExists {
		s.appendLog(config.JobID, res, "warn", fmt.Sprintf("  -> 全量覆盖模式：即将清空目标表 %s", tableName))
		s.progress(config.JobID, tableIndex, totalTables, tableName, "清空目标表")
		clearSQL := buildClearTargetTableSQL(targetType, plan.TargetQueryTable)
		if _, err := targetDB.Exec(clearSQL); err != nil {
			return true, 0, fmt.Errorf("清空目标表失败: %w", err)
		}
	}

	targetColSet, err := s.prepareDirectImportTargetColumnSet(config, res, targetDB, plan, sourceType, targetType, sourceCols, targetCols)
	if err != nil {
		return true, 0, err
	}

	inserted, err := s.applyDirectImportPage(config.JobID, res, applyTableName, applier, targetColSet, pkCol, opts, firstRows)
	if err != nil {
		return true, inserted, err
	}
	if len(firstRows) < defaultSyncReadPageSize {
		return true, inserted, nil
	}

	for offset := defaultSyncReadPageSize; ; offset += defaultSyncReadPageSize {
		s.progress(config.JobID, tableIndex, totalTables, tableName, fmt.Sprintf("分页读取源表数据(%d+)", offset))
		query := buildPagedSourceTableQuery(sourceType, plan.SourceQueryTable, sourceCols, pkCol, defaultSyncReadPageSize, offset)
		rows, _, err := sourceDB.Query(query)
		if err != nil {
			return true, inserted, fmt.Errorf("分页读取源表失败(offset=%d): %w", offset, err)
		}
		if len(rows) == 0 {
			return true, inserted, nil
		}
		applied, err := s.applyDirectImportPage(config.JobID, res, applyTableName, applier, targetColSet, pkCol, opts, rows)
		inserted += applied
		if err != nil {
			return true, inserted, err
		}
		if len(rows) < defaultSyncReadPageSize {
			return true, inserted, nil
		}
	}
}

func (s *SyncEngine) prepareDirectImportTargetColumnSet(config SyncConfig, res *SyncResult, targetDB db.Database, plan SchemaMigrationPlan, sourceType, targetType string, sourceCols, targetCols []connection.ColumnDefinition) (map[string]struct{}, error) {
	targetColsResolved := targetCols
	if len(targetColsResolved) == 0 {
		cols, err := targetDB.GetColumns(plan.TargetSchema, plan.TargetTable)
		if err != nil {
			s.appendLog(config.JobID, res, "warn", fmt.Sprintf("  -> 获取目标表字段失败，已跳过字段一致性检查: %v", err))
			return nil, nil
		}
		targetColsResolved = cols
	}
	if len(targetColsResolved) == 0 {
		return nil, nil
	}

	targetColSet := buildTargetColumnSet(targetColsResolved)
	missing := missingSourceColumns(sourceCols, targetColSet)
	if len(missing) == 0 {
		return targetColSet, nil
	}

	if config.AutoAddColumns && supportsAutoAddColumnsForPair(sourceType, targetType) {
		s.appendLog(config.JobID, res, "warn", fmt.Sprintf("  -> 目标表缺少字段 %d 个，开始自动补齐: %s", len(missing), strings.Join(missing, ", ")))
		added := 0
		sourceColsByLower := make(map[string]connection.ColumnDefinition, len(sourceCols))
		for _, col := range sourceCols {
			key := strings.ToLower(strings.TrimSpace(col.Name))
			if key != "" {
				sourceColsByLower[key] = col
			}
		}
		for _, colName := range missing {
			srcCol, ok := sourceColsByLower[strings.ToLower(strings.TrimSpace(colName))]
			if !ok {
				continue
			}
			alterSQL, err := buildAddColumnSQLForPair(sourceType, targetType, plan.TargetQueryTable, srcCol)
			if err != nil {
				s.appendLog(config.JobID, res, "error", fmt.Sprintf("  -> 自动补字段失败：字段=%s 错误=%v", colName, err))
				continue
			}
			if _, err := targetDB.Exec(alterSQL); err != nil {
				s.appendLog(config.JobID, res, "error", fmt.Sprintf("  -> 自动补字段失败：字段=%s 错误=%v", colName, err))
				continue
			}
			added++
			targetColSet[strings.ToLower(strings.TrimSpace(colName))] = struct{}{}
		}
		s.appendLog(config.JobID, res, "info", fmt.Sprintf("  -> 自动补字段完成：成功=%d 失败=%d", added, len(missing)-added))
		return targetColSet, nil
	}

	s.appendLog(config.JobID, res, "warn", fmt.Sprintf("  -> 目标表缺少字段 %d 个（未开启自动补齐），将自动忽略：%s", len(missing), strings.Join(missing, ", ")))
	return targetColSet, nil
}

func missingSourceColumns(sourceCols []connection.ColumnDefinition, targetColSet map[string]struct{}) []string {
	missing := make([]string, 0)
	seen := make(map[string]struct{}, len(sourceCols))
	for _, col := range sourceCols {
		name := strings.TrimSpace(col.Name)
		lower := strings.ToLower(name)
		if name == "" {
			continue
		}
		if _, ok := seen[lower]; ok {
			continue
		}
		seen[lower] = struct{}{}
		if _, ok := targetColSet[lower]; !ok {
			missing = append(missing, name)
		}
	}
	return missing
}

func (s *SyncEngine) applyDirectImportPage(jobID string, res *SyncResult, tableName string, applier db.BatchApplier, targetColSet map[string]struct{}, pkCol string, opts TableOptions, rows []map[string]interface{}) (int, error) {
	if len(rows) == 0 {
		return 0, nil
	}
	rows = filterRowsByPKSelection(pkCol, rows, opts.Insert, opts.SelectedInsertPKs)
	if len(rows) == 0 {
		return 0, nil
	}
	if len(targetColSet) > 0 {
		rows = filterInsertRows(rows, targetColSet)
	}
	if len(rows) == 0 {
		return 0, nil
	}
	changeSet := connection.ChangeSet{Inserts: rows}
	if err := s.applyChangesInBatches(jobID, res, tableName, applier, changeSet); err != nil {
		return 0, err
	}
	return len(rows), nil
}

func directImportPaginationPK(sourceType string, sourceCols []connection.ColumnDefinition) (string, bool) {
	if !supportsDirectImportPagination(sourceType) {
		return "", false
	}
	pkCols := make([]string, 0, 2)
	for _, col := range sourceCols {
		if col.Key == "PRI" || col.Key == "PK" {
			pkCols = append(pkCols, col.Name)
		}
	}
	if len(pkCols) != 1 || strings.TrimSpace(pkCols[0]) == "" {
		return "", false
	}
	return pkCols[0], true
}

func supportsDirectImportPagination(dbType string) bool {
	switch normalizeMigrationDBType(dbType) {
	case "mysql", "mariadb", "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "sqlserver", "sqlite", "duckdb", "clickhouse", "tdengine", "starrocks", "diros":
		return true
	default:
		return false
	}
}

func buildPagedSourceTableQuery(dbType, queryTable string, cols []connection.ColumnDefinition, orderCol string, limit, offset int) string {
	selectList := buildSourceColumnSelectList(dbType, cols)
	if strings.TrimSpace(selectList) == "" {
		return ""
	}
	pageSelectList := selectList
	if normalizeMigrationDBType(dbType) == "sqlserver" {
		pageSelectList = buildSQLServerPageSelectList(cols)
	}
	baseSQL := fmt.Sprintf("SELECT %s FROM %s", selectList, quoteQualifiedIdentByType(dbType, queryTable))
	orderBy := ""
	if strings.TrimSpace(orderCol) != "" {
		orderBy = fmt.Sprintf(" ORDER BY %s ASC", quoteIdentByType(dbType, orderCol))
	}
	return buildPaginatedSelectSQLForSync(dbType, baseSQL, pageSelectList, orderBy, limit, offset)
}

func buildSourceColumnSelectList(dbType string, cols []connection.ColumnDefinition) string {
	quoted := make([]string, 0, len(cols))
	for _, col := range cols {
		name := strings.TrimSpace(col.Name)
		if name == "" {
			continue
		}
		quoted = append(quoted, quoteIdentByType(dbType, name))
	}
	return strings.Join(quoted, ", ")
}

func buildSQLServerPageSelectList(cols []connection.ColumnDefinition) string {
	quoted := make([]string, 0, len(cols))
	for _, col := range cols {
		name := strings.TrimSpace(col.Name)
		if name == "" {
			continue
		}
		quoted = append(quoted, fmt.Sprintf("[__gonavi_page_result__].%s", quoteIdentByType("sqlserver", name)))
	}
	return strings.Join(quoted, ", ")
}

func buildPaginatedSelectSQLForSync(dbType, baseSQL, selectList, orderBySQL string, limit, offset int) string {
	safeLimit := limit
	if safeLimit <= 0 {
		safeLimit = defaultSyncReadPageSize
	}
	safeOffset := offset
	if safeOffset < 0 {
		safeOffset = 0
	}
	base := strings.TrimSpace(baseSQL)
	orderBy := strings.TrimSpace(orderBySQL)

	switch normalizeMigrationDBType(dbType) {
	case "sqlserver":
		upperBound := safeOffset + safeLimit
		if orderBy == "" {
			orderBy = "ORDER BY (SELECT NULL)"
		}
		return fmt.Sprintf("SELECT %s FROM (SELECT [__gonavi_page__].*, ROW_NUMBER() OVER (%s) AS [__gonavi_rn__] FROM (%s) AS [__gonavi_page__]) AS [__gonavi_page_result__] WHERE [__gonavi_rn__] > %d AND [__gonavi_rn__] <= %d ORDER BY [__gonavi_rn__]", selectList, orderBy, base, safeOffset, upperBound)
	default:
		return fmt.Sprintf("%s %s LIMIT %d OFFSET %d", base, orderBy, safeLimit, safeOffset)
	}
}

func buildClearTargetTableSQL(targetType, targetQueryTable string) string {
	quotedTable := quoteQualifiedIdentByType(targetType, targetQueryTable)
	if normalizeMigrationDBType(targetType) == "mysql" {
		return fmt.Sprintf("TRUNCATE TABLE %s", quotedTable)
	}
	return fmt.Sprintf("DELETE FROM %s", quotedTable)
}

// isSameSyncEndpoint 判断同步的源与目标是否指向同一个物理连接端点。
//
// 不比较表名，因此也适用于「源是任意 SQL 查询」的场景：此时无法可靠判断查询是否引用了
// 目标表，只能保守地按端点相同就退回安全路径。
func isSameSyncEndpoint(config SyncConfig, sourceType, targetType string) bool {
	if normalizeMigrationDBType(sourceType) != normalizeMigrationDBType(targetType) {
		return false
	}
	source := config.SourceConfig
	target := config.TargetConfig
	return strings.EqualFold(strings.TrimSpace(source.Host), strings.TrimSpace(target.Host)) &&
		source.Port == target.Port &&
		strings.EqualFold(strings.TrimSpace(source.Database), strings.TrimSpace(target.Database)) &&
		strings.EqualFold(strings.TrimSpace(source.Driver), strings.TrimSpace(target.Driver)) &&
		strings.EqualFold(strings.TrimSpace(source.DSN), strings.TrimSpace(target.DSN))
}

func isSamePhysicalSyncTable(config SyncConfig, plan SchemaMigrationPlan, sourceType, targetType string) bool {
	if !strings.EqualFold(strings.TrimSpace(plan.SourceQueryTable), strings.TrimSpace(plan.TargetQueryTable)) {
		return false
	}
	return isSameSyncEndpoint(config, sourceType, targetType)
}
