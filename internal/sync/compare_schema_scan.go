package sync

import (
	"sync"
	"sync/atomic"

	"GoNavi-Wails/internal/db"
)

// compareSchemaScanConcurrency 是只读结构对比的并发度。
//
// 成本全在元数据往返（源列、目标存在性、目标列），与本地 CPU 无关，所以并发
// 近似线性压缩总时长。上限对齐驱动连接池：默认池是 db.defaultSQLMaxOpenConns=4，
// 再高的并发只会在池上排队、白增调度开销，真正要再快就得减少往返次数（批量
// 列读取）或放大池，而不是继续加 goroutine。
const compareSchemaScanConcurrency = 4

// scanCompareSchemaTables 并发扫描只读结构对比的每一张表。
//
// 结果按 config.Tables 原顺序落位：并发不能改变结果顺序，否则界面上的表列表会
// 随调度抖动。任何单表失败只写该表的 Message，不影响其它表 —— 对比的价值就是
// 把每张表的差异/异常分开报告。
func (s *SyncEngine) scanCompareSchemaTables(
	config SyncConfig,
	sourceDB, targetDB db.Database,
	totalTables int,
) []TableDiffSummary {
	tables := config.Tables
	// 先把两端整库元数据各拉一次：逐表查询全部命中内存，往返从千级降到个位。
	sourceDB, _ = prefetchCompareDatabase(sourceDB, config.SourceDatabase, compareSourceTableNames(config))
	targetDB, _ = prefetchCompareDatabase(targetDB, config.TargetDatabase, compareTargetTableNames(config))
	results := make([][]TableDiffSummary, len(tables))
	limit := compareSchemaScanConcurrency
	if limit > len(tables) {
		limit = len(tables)
	}
	if limit < 1 {
		limit = 1
	}
	slots := make(chan struct{}, limit)
	var wg sync.WaitGroup
	var completed int64
	for index, tableName := range tables {
		if s.contextError() != nil {
			break
		}
		slots <- struct{}{}
		wg.Add(1)
		go func(position int, table string) {
			defer wg.Done()
			defer func() { <-slots }()
			summary := s.compareSchemaTable(config, table, sourceDB, targetDB)
			results[position] = []TableDiffSummary{summary}
			current := int(atomic.AddInt64(&completed, 1))
			s.progress(config.JobID, current, totalTables, table, localizedSyncBackendText("data_sync.progress.stage.analyzing_table", map[string]any{
				"current": current,
				"total":   totalTables,
			}))
		}(index, tableName)
	}
	wg.Wait()
	summaries := make([]TableDiffSummary, 0, len(tables))
	for _, item := range results {
		summaries = append(summaries, item...)
	}
	return summaries
}

// compareSchemaTable 对比一张表的结构。
//
// 目标缺表时把源列全部标成 missing_in_target，前端据此渲染整表缺表并生成
// CREATE TABLE；目标存在时按列差异与结构差异双口径报告。
func (s *SyncEngine) compareSchemaTable(
	config SyncConfig,
	tableName string,
	sourceDB, targetDB db.Database,
) TableDiffSummary {
	summary := TableDiffSummary{
		Table:     tableName,
		CanSync:   false,
		HasSchema: true,
	}
	plan, cols, targetCols, err := s.buildPreflightMigrationPlan(config, tableName, sourceDB, targetDB)
	if err != nil {
		summary.Message = err.Error()
		return summary
	}
	summary.TargetTableExists = plan.TargetTableExists
	summary.SourceObject = plan.SourceQueryTable
	summary.TargetObject = plan.TargetQueryTable
	summary.PlannedAction = plan.PlannedAction
	summary.UnsupportedObjects = append(summary.UnsupportedObjects, plan.UnsupportedObjects...)
	summary.UnmigratedIndexes = append(summary.UnmigratedIndexes, plan.UnmigratedIndexes...)
	summary.IndexesToCreate = plan.IndexesToCreate
	summary.IndexesSkipped = plan.IndexesSkipped
	summary.CanSync = true

	if !plan.TargetTableExists {
		// 只读对比不写目标：「要求目标表已存在」「不会自动建表」这类写任务提示一律不继承，
		// 否则用户会以为这里需要先去目标库建表。
		summary.MissingColumns, summary.ColumnDiffs = compareMissingTargetColumns(cols)
		summary.SchemaDiffCount = len(summary.ColumnDiffs)
		if summary.SchemaDiffCount == 0 {
			// 源列读不到（受限账号/同义词）时也要标成差异，否则整表会被当成一致。
			summary.SchemaDiffCount = 1
		}
		summary.Message = localizedSyncBackendText("data_sync.plan.target_missing_compare", map[string]any{"count": len(summary.MissingColumns)})
		// 目标整表不存在时索引差异没有意义：索引会随建表一起生成。
		summary.DiffStats = buildTableDiffStats(summary.ColumnDiffs, nil, true)
		return summary
	}

	summary.Warnings = append(summary.Warnings, plan.Warnings...)
	summary.MissingColumns = diffMissingColumnNames(cols, targetCols)
	summary.ColumnDiffs = diffColumnStructures(
		cols,
		targetCols,
		resolveMigrationDBType(config.SourceConfig),
		resolveMigrationDBType(config.TargetConfig),
	)
	summary.AttributeDiffs = diffColumnAttributes(cols, targetCols)
	summary.IndexDiffs = compareTableIndexes(
		sourceDB,
		targetDB,
		plan.SourceSchema,
		plan.SourceTable,
		plan.TargetSchema,
		plan.TargetTable,
	)
	summary.SchemaDiffCount = len(plan.PreDataSQL) + len(plan.PostDataSQL)
	if len(summary.ColumnDiffs) > summary.SchemaDiffCount {
		summary.SchemaDiffCount = len(summary.ColumnDiffs)
	}
	summary.DiffStats = buildTableDiffStats(summary.ColumnDiffs, summary.IndexDiffs, false)
	switch {
	case len(summary.ColumnDiffs) > 0:
		// 结构差异以列级明细为准：plan 没有 ALTER 可生成时 PlannedAction 会说
		// 「表结构已一致」，那会掩盖类型/可空性漂移。
		summary.Message = summarizeColumnStructureDiffs(summary.ColumnDiffs)
	case summary.SchemaDiffCount > 0:
		summary.Message = firstNonEmpty(plan.PlannedAction, localizedSyncBackendText("data_sync.plan.schema_changes_detected", map[string]any{
			"count": summary.SchemaDiffCount,
		}))
	default:
		summary.Message = firstNonEmpty(plan.PlannedAction, localizedSyncBackendText("data_sync.plan.schema_only_no_data_diff", nil))
	}
	return summary
}
