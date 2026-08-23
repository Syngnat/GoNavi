package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"context"
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"
)

type pagedDiffCounts struct {
	Inserts int
	Updates int
	Deletes int
	Same    int
}

type pagedUpdateDiff struct {
	UpdateRow      connection.UpdateRow
	Source         map[string]interface{}
	Target         map[string]interface{}
	ChangedColumns []string
}

type pagedDiffPage struct {
	Inserts []map[string]interface{}
	Updates []pagedUpdateDiff
	Deletes []map[string]interface{}
	Same    int
}

func (s *SyncEngine) tryApplyDiffInPages(config SyncConfig, res *SyncResult, tableIndex, totalTables int, tableName string, sourceDB db.Database, targetDB db.Database, plan SchemaMigrationPlan, sourceCols, targetCols []connection.ColumnDefinition, opts TableOptions, sourceType, targetType, applyTableName, pkCol string) (bool, pagedDiffCounts, error) {
	if hasExplicitSyncMappings(config) {
		return false, pagedDiffCounts{}, nil
	}
	if normalizeSyncMode(config.Mode) != "insert_update" || !plan.TargetTableExists {
		return false, pagedDiffCounts{}, nil
	}
	if !supportsPagedDiffSelect(sourceType) || !supportsPagedDiffSelect(targetType) {
		return false, pagedDiffCounts{}, nil
	}
	if opts.Delete && (!supportsPagedDiffKeysetSelect(targetType) || !supportsPagedDiffPKLookup(sourceType)) {
		return false, pagedDiffCounts{}, nil
	}

	applier, ok := targetDB.(db.BatchApplier)
	if !ok {
		return true, pagedDiffCounts{}, fmt.Errorf("目标驱动不支持应用数据变更 (ApplyChanges)")
	}

	targetColSet, err := s.prepareDirectImportTargetColumnSet(config, res, targetDB, plan, sourceType, targetType, sourceCols, targetCols)
	if err != nil {
		return true, pagedDiffCounts{}, err
	}

	pageSize, err := normalizedSyncBatchSize(config.BatchSize)
	if err != nil {
		return true, pagedDiffCounts{}, err
	}
	s.appendLog(config.JobID, res, "info", fmt.Sprintf("  -> 启用分页差异同步：按主键 %s 每批读取 %d 行", pkCol, pageSize))
	s.progress(config.JobID, tableIndex, totalTables, tableName, "分页对比数据")

	applied := pagedDiffCounts{}
	rowIndexBase := 0
	handled, _, err := scanTableDiffInPagesContextWithBatchSize(s.context(), sourceDB, targetDB, sourceType, targetType, plan, sourceCols, targetCols, pkCol, targetColSet, opts.Delete, pageSize, func(page pagedDiffPage) error {
		changeSet := connection.ChangeSet{
			Inserts: filterRowsByPKSelection(pkCol, page.Inserts, opts.Insert, opts.SelectedInsertPKs),
			Updates: filterPagedUpdatesByPKSelection(pkCol, page.Updates, opts.Update, opts.SelectedUpdatePKs),
			Deletes: filterRowsByPKSelection(pkCol, page.Deletes, opts.Delete, opts.SelectedDeletePKs),
		}
		if len(targetColSet) > 0 {
			changeSet.Inserts = filterInsertRows(changeSet.Inserts, targetColSet)
			changeSet.Updates = filterUpdateRows(changeSet.Updates, targetColSet)
		}
		if len(changeSet.Inserts) == 0 && len(changeSet.Updates) == 0 && len(changeSet.Deletes) == 0 {
			return nil
		}
		committed, err := s.applySnapshotChanges(config, res, tableName, applyTableName, applier, changeSet, rowIndexBase)
		applied.Inserts += committed.Inserts
		applied.Updates += committed.Updates
		applied.Deletes += committed.Deletes
		rowIndexBase += len(changeSet.Inserts) + len(changeSet.Updates) + len(changeSet.Deletes)
		return err
	})
	if err != nil {
		return true, applied, err
	}
	return handled, applied, nil
}

func scanTableDiffInPages(sourceDB db.Database, targetDB db.Database, sourceType, targetType string, plan SchemaMigrationPlan, sourceCols, targetCols []connection.ColumnDefinition, pkCol string, targetColSet map[string]struct{}, includeDeletes bool, consume func(page pagedDiffPage) error) (bool, pagedDiffCounts, error) {
	return scanTableDiffInPagesContext(context.Background(), sourceDB, targetDB, sourceType, targetType, plan, sourceCols, targetCols, pkCol, targetColSet, includeDeletes, consume)
}

func scanTableDiffInPagesContext(ctx context.Context, sourceDB db.Database, targetDB db.Database, sourceType, targetType string, plan SchemaMigrationPlan, sourceCols, targetCols []connection.ColumnDefinition, pkCol string, targetColSet map[string]struct{}, includeDeletes bool, consume func(page pagedDiffPage) error) (bool, pagedDiffCounts, error) {
	return scanTableDiffInPagesContextWithBatchSize(ctx, sourceDB, targetDB, sourceType, targetType, plan, sourceCols, targetCols, pkCol, targetColSet, includeDeletes, defaultSyncReadPageSize, consume)
}

func scanTableDiffInPagesContextWithBatchSize(ctx context.Context, sourceDB db.Database, targetDB db.Database, sourceType, targetType string, plan SchemaMigrationPlan, sourceCols, targetCols []connection.ColumnDefinition, pkCol string, targetColSet map[string]struct{}, includeDeletes bool, batchSize int, consume func(page pagedDiffPage) error) (bool, pagedDiffCounts, error) {
	pageSize, err := normalizedSyncBatchSize(batchSize)
	if err != nil {
		return false, pagedDiffCounts{}, err
	}
	if !supportsPagedDiffSelect(sourceType) || !supportsPagedDiffPKLookup(targetType) {
		return false, pagedDiffCounts{}, nil
	}
	if includeDeletes && (!supportsPagedDiffKeysetSelect(targetType) || !supportsPagedDiffPKLookup(sourceType)) {
		return false, pagedDiffCounts{}, nil
	}

	sourceReadCols := diffReadableColumns(sourceCols, targetColSet, pkCol)
	if len(sourceReadCols) == 0 {
		return false, pagedDiffCounts{}, nil
	}
	targetLookupCols := diffLookupColumns(sourceReadCols, targetCols, targetColSet, pkCol)
	if len(targetLookupCols) == 0 {
		return false, pagedDiffCounts{}, nil
	}

	totals := pagedDiffCounts{}
	for offset := 0; ; offset += pageSize {
		query := buildPagedSourceTableQuery(sourceType, plan.SourceQueryTable, sourceReadCols, pkCol, pageSize, offset)
		if strings.TrimSpace(query) == "" {
			return false, pagedDiffCounts{}, nil
		}
		sourceRows, _, err := querySyncDatabaseContext(ctx, sourceDB, query)
		if err != nil {
			return true, totals, fmt.Errorf("分页读取源表失败(offset=%d): %w", offset, err)
		}
		if len(sourceRows) == 0 {
			break
		}

		pkValues := collectPKValues(sourceRows, pkCol)
		targetRows := make([]map[string]interface{}, 0)
		if len(pkValues) > 0 {
			targetQuery := buildPKInSelectQuery(targetType, plan.TargetQueryTable, targetLookupCols, pkCol, pkValues)
			if strings.TrimSpace(targetQuery) == "" {
				return false, pagedDiffCounts{}, nil
			}
			targetRows, _, err = querySyncDatabaseContext(ctx, targetDB, targetQuery)
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
		if len(sourceRows) < pageSize {
			break
		}
	}

	if includeDeletes {
		lastPK, hasLastPK := interface{}(nil), false
		targetPKCols := []connection.ColumnDefinition{{Name: pkCol}}
		for {
			query := buildKeysetPagedTableQuery(targetType, plan.TargetQueryTable, targetPKCols, pkCol, lastPK, hasLastPK, pageSize)
			if strings.TrimSpace(query) == "" {
				return false, pagedDiffCounts{}, nil
			}
			targetRows, _, err := querySyncDatabaseContext(ctx, targetDB, query)
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
				sourceQuery := buildPKInSelectQuery(sourceType, plan.SourceQueryTable, targetPKCols, pkCol, pkValues)
				if strings.TrimSpace(sourceQuery) == "" {
					return false, pagedDiffCounts{}, nil
				}
				sourcePKRows, _, err = querySyncDatabaseContext(ctx, sourceDB, sourceQuery)
				if err != nil {
					return true, totals, fmt.Errorf("按主键反查源表失败: %w", err)
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
			if len(targetRows) < pageSize {
				break
			}
		}
	}

	return true, totals, nil
}

func diffSourcePageByPK(pkCol string, sourceRows, targetRows []map[string]interface{}) pagedDiffPage {
	targetMap := make(map[string]map[string]interface{}, len(targetRows))
	for _, row := range targetRows {
		pkKey, ok := pkValueKey(row[pkCol])
		if !ok {
			continue
		}
		targetMap[pkKey] = row
	}

	page := pagedDiffPage{
		Inserts: make([]map[string]interface{}, 0),
		Updates: make([]pagedUpdateDiff, 0),
	}
	for _, sourceRow := range sourceRows {
		pkKey, ok := pkValueKey(sourceRow[pkCol])
		if !ok {
			continue
		}
		targetRow, exists := targetMap[pkKey]
		if !exists {
			page.Inserts = append(page.Inserts, sourceRow)
			continue
		}

		changes := make(map[string]interface{})
		changedColumns := make([]string, 0)
		for key, value := range sourceRow {
			if fmt.Sprintf("%v", value) == fmt.Sprintf("%v", targetRow[key]) {
				continue
			}
			changes[key] = value
			changedColumns = append(changedColumns, key)
		}
		if len(changes) == 0 {
			page.Same++
			continue
		}
		sort.Strings(changedColumns)
		page.Updates = append(page.Updates, pagedUpdateDiff{
			UpdateRow: connection.UpdateRow{
				Keys:   map[string]interface{}{pkCol: sourceRow[pkCol]},
				Values: changes,
			},
			Source:         sourceRow,
			Target:         targetRow,
			ChangedColumns: changedColumns,
		})
	}
	return page
}

func filterPagedUpdatesByPKSelection(pkCol string, updates []pagedUpdateDiff, enabled bool, selectedPKs []string) []connection.UpdateRow {
	if !enabled {
		return nil
	}
	if len(updates) == 0 {
		return nil
	}
	out := make([]connection.UpdateRow, 0, len(updates))
	for _, update := range updates {
		out = append(out, update.UpdateRow)
	}
	return filterUpdatesByPKSelection(pkCol, out, true, selectedPKs)
}

func diffReadableColumns(sourceCols []connection.ColumnDefinition, allowedLower map[string]struct{}, pkCol string) []connection.ColumnDefinition {
	out := make([]connection.ColumnDefinition, 0, len(sourceCols))
	seen := map[string]struct{}{}
	add := func(col connection.ColumnDefinition) {
		name := strings.TrimSpace(col.Name)
		lower := strings.ToLower(name)
		if name == "" {
			return
		}
		if _, ok := seen[lower]; ok {
			return
		}
		seen[lower] = struct{}{}
		out = append(out, col)
	}
	for _, col := range sourceCols {
		name := strings.TrimSpace(col.Name)
		lower := strings.ToLower(name)
		if name == "" {
			continue
		}
		if strings.EqualFold(name, pkCol) {
			add(col)
			continue
		}
		if len(allowedLower) > 0 {
			if _, ok := allowedLower[lower]; !ok {
				continue
			}
		}
		add(col)
	}
	if _, ok := seen[strings.ToLower(strings.TrimSpace(pkCol))]; !ok && strings.TrimSpace(pkCol) != "" {
		add(connection.ColumnDefinition{Name: pkCol})
	}
	return out
}

func diffLookupColumns(sourceReadCols, targetCols []connection.ColumnDefinition, allowedLower map[string]struct{}, pkCol string) []connection.ColumnDefinition {
	targetByLower := make(map[string]connection.ColumnDefinition, len(targetCols))
	for _, col := range targetCols {
		name := strings.TrimSpace(col.Name)
		if name != "" {
			targetByLower[strings.ToLower(name)] = col
		}
	}

	out := make([]connection.ColumnDefinition, 0, len(sourceReadCols))
	seen := map[string]struct{}{}
	for _, sourceCol := range sourceReadCols {
		name := strings.TrimSpace(sourceCol.Name)
		lower := strings.ToLower(name)
		if name == "" {
			continue
		}
		if _, ok := seen[lower]; ok {
			continue
		}
		if !strings.EqualFold(name, pkCol) && len(allowedLower) > 0 {
			if _, ok := allowedLower[lower]; !ok {
				continue
			}
		}
		if targetCol, ok := targetByLower[lower]; ok {
			out = append(out, targetCol)
		} else {
			out = append(out, connection.ColumnDefinition{Name: name})
		}
		seen[lower] = struct{}{}
	}
	if _, ok := seen[strings.ToLower(strings.TrimSpace(pkCol))]; !ok && strings.TrimSpace(pkCol) != "" {
		out = append(out, connection.ColumnDefinition{Name: pkCol})
	}
	return out
}

func collectPKValues(rows []map[string]interface{}, pkCol string) []interface{} {
	values := make([]interface{}, 0, len(rows))
	seen := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		key, ok := pkValueKey(row[pkCol])
		if !ok {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		values = append(values, row[pkCol])
	}
	return values
}

func buildPKSet(rows []map[string]interface{}, pkCol string) map[string]struct{} {
	set := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		key, ok := pkValueKey(row[pkCol])
		if ok {
			set[key] = struct{}{}
		}
	}
	return set
}

func lastValidPKValue(rows []map[string]interface{}, pkCol string) (interface{}, bool) {
	for i := len(rows) - 1; i >= 0; i-- {
		if _, ok := pkValueKey(rows[i][pkCol]); ok {
			return rows[i][pkCol], true
		}
	}
	return nil, false
}

func pkValueKey(value interface{}) (string, bool) {
	if value == nil {
		return "", false
	}
	key := strings.TrimSpace(fmt.Sprintf("%v", value))
	if key == "" || key == "<nil>" {
		return "", false
	}
	return key, true
}

func buildPKInSelectQuery(dbType, queryTable string, cols []connection.ColumnDefinition, pkCol string, pkValues []interface{}) string {
	if len(pkValues) == 0 {
		return ""
	}
	selectList := buildColumnSelectListForSync(dbType, cols)
	if strings.TrimSpace(selectList) == "" {
		selectList = "*"
	}
	literals := make([]string, 0, len(pkValues))
	for _, value := range pkValues {
		literal, ok := formatSyncSQLLiteral(dbType, value)
		if !ok {
			continue
		}
		literals = append(literals, literal)
	}
	if len(literals) == 0 {
		return ""
	}
	return fmt.Sprintf("SELECT %s FROM %s WHERE %s IN (%s)",
		selectList,
		quoteQualifiedIdentByType(dbType, queryTable),
		quoteIdentByType(dbType, pkCol),
		strings.Join(literals, ", "))
}

func buildKeysetPagedTableQuery(dbType, queryTable string, cols []connection.ColumnDefinition, orderCol string, lastValue interface{}, hasLastValue bool, limit int) string {
	selectList := buildColumnSelectListForSync(dbType, cols)
	if strings.TrimSpace(selectList) == "" {
		selectList = "*"
	}
	safeLimit := limit
	if safeLimit <= 0 {
		safeLimit = defaultSyncReadPageSize
	}
	where := ""
	if hasLastValue {
		literal, ok := formatSyncSQLLiteral(dbType, lastValue)
		if !ok {
			return ""
		}
		where = fmt.Sprintf(" WHERE %s > %s", quoteIdentByType(dbType, orderCol), literal)
	}
	orderBy := fmt.Sprintf(" ORDER BY %s ASC", quoteIdentByType(dbType, orderCol))
	if normalizeMigrationDBType(dbType) == "sqlserver" {
		return fmt.Sprintf("SELECT TOP (%d) %s FROM %s%s%s", safeLimit, selectList, quoteQualifiedIdentByType(dbType, queryTable), where, orderBy)
	}
	return fmt.Sprintf("SELECT %s FROM %s%s%s LIMIT %d", selectList, quoteQualifiedIdentByType(dbType, queryTable), where, orderBy, safeLimit)
}

func countTableRowsForSync(database db.Database, dbType, queryTable string) (int, bool, error) {
	query := fmt.Sprintf("SELECT COUNT(*) AS __gonavi_count__ FROM %s", quoteQualifiedIdentByType(dbType, queryTable))
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

func intFromSyncValue(value interface{}) (int, bool) {
	if value == nil {
		return 0, false
	}
	switch v := value.(type) {
	case int:
		return v, true
	case int8:
		return int(v), true
	case int16:
		return int(v), true
	case int32:
		return int(v), true
	case int64:
		return int(v), true
	case uint:
		return int(v), true
	case uint8:
		return int(v), true
	case uint16:
		return int(v), true
	case uint32:
		return int(v), true
	case uint64:
		return int(v), true
	case float32:
		return int(v), true
	case float64:
		return int(v), true
	case []byte:
		i, err := strconv.Atoi(strings.TrimSpace(string(v)))
		return i, err == nil
	case string:
		i, err := strconv.Atoi(strings.TrimSpace(v))
		return i, err == nil
	default:
		rv := reflect.ValueOf(value)
		switch rv.Kind() {
		case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
			i := rv.Int()
			if i > int64(^uint(0)>>1) {
				return 0, false
			}
			return int(i), true
		case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
			u := rv.Uint()
			if u > uint64(^uint(0)>>1) {
				return 0, false
			}
			return int(u), true
		}
	}
	return 0, false
}

func buildColumnSelectListForSync(dbType string, cols []connection.ColumnDefinition) string {
	quoted := make([]string, 0, len(cols))
	seen := map[string]struct{}{}
	for _, col := range cols {
		name := strings.TrimSpace(col.Name)
		lower := strings.ToLower(name)
		if name == "" {
			continue
		}
		if _, ok := seen[lower]; ok {
			continue
		}
		seen[lower] = struct{}{}
		quoted = append(quoted, quoteIdentByType(dbType, name))
	}
	return strings.Join(quoted, ", ")
}

func formatSyncSQLLiteral(dbType string, value interface{}) (string, bool) {
	if value == nil {
		return "", false
	}
	switch v := value.(type) {
	case time.Time:
		return quoteSyncSQLString(dbType, v.Format("2006-01-02 15:04:05.999999999")), true
	case []byte:
		return quoteSyncSQLString(dbType, string(v)), true
	case string:
		if strings.TrimSpace(v) == "" {
			return "", false
		}
		return quoteSyncSQLString(dbType, v), true
	case bool:
		if v {
			return "1", true
		}
		return "0", true
	default:
		text := strings.TrimSpace(fmt.Sprintf("%v", value))
		if text == "" || text == "<nil>" {
			return "", false
		}
		switch value.(type) {
		case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
			return text, true
		default:
			return quoteSyncSQLString(dbType, text), true
		}
	}
}

// syncDialectEscapesBackslash 判断方言是否把反斜杠当作字符串字面量里的转义符。
//
// 只需覆盖 supportsDirectImportPagination 白名单中的方言：mysql 系与 ClickHouse/TDengine
// 的字面量都以反斜杠转义，而 postgres 系（standard_conforming_strings=on）、sqlserver、
// sqlite、duckdb 的反斜杠是普通字面字符，翻倍反而会写入两个反斜杠并损坏比对结果。
func syncDialectEscapesBackslash(dbType string) bool {
	switch normalizeMigrationDBType(dbType) {
	case "mysql", "mariadb", "clickhouse", "tdengine", "starrocks", "diros", "oceanbase":
		return true
	default:
		return false
	}
}

// quoteSyncSQLString 生成内联进比对 SQL 的字符串字面量。
//
// 反斜杠必须先于单引号处理。原先只翻倍单引号：含反斜杠的主键（Windows 路径、正则、
// 转义 JSON）在 MySQL/ClickHouse 等目标上会被解释成别的字符串，导致 IN 列表匹配不到，
// 于是源端存在的行先被判为需要插入、随后又被判为需要删除并真的从目标删掉。
func quoteSyncSQLString(dbType string, value string) string {
	if syncDialectEscapesBackslash(dbType) {
		value = strings.ReplaceAll(value, `\`, `\\`)
	}
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func supportsPagedDiffSelect(dbType string) bool {
	return supportsDirectImportPagination(dbType)
}

func supportsPagedDiffPKLookup(dbType string) bool {
	return supportsDirectImportPagination(dbType)
}

func supportsPagedDiffKeysetSelect(dbType string) bool {
	return supportsDirectImportPagination(dbType)
}
