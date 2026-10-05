package sync

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

type SchemaMigrationPlan struct {
	SourceSchema       string
	SourceTable        string
	SourceQueryTable   string
	TargetSchema       string
	TargetTable        string
	TargetQueryTable   string
	TargetTableExists  bool
	AutoCreate         bool
	PlannedAction      string
	Warnings           []string
	UnsupportedObjects []string
	UnmigratedIndexes  []UnmigratedIndex
	IndexesToCreate    int
	IndexesSkipped     int
	CreateTableSQL     string
	PreDataSQL         []string
	PostDataSQL        []string
}

type IndexMigrationColumn struct {
	Name         string `json:"name"`
	PrefixLength int    `json:"prefixLength,omitempty"`
}

type UnmigratedIndex struct {
	Name                  string                 `json:"name"`
	Columns               []IndexMigrationColumn `json:"columns"`
	Unique                bool                   `json:"unique"`
	IndexType             string                 `json:"indexType"`
	ReasonCode            string                 `json:"reasonCode"`
	Reason                string                 `json:"reason"`
	RemediationStatements []string               `json:"remediationStatements,omitempty"`
}

type groupedIndex struct {
	Name      string
	Columns   []IndexMigrationColumn
	Unique    bool
	IndexType string
}

func normalizeTargetTableStrategy(strategy string) string {
	switch strings.ToLower(strings.TrimSpace(strategy)) {
	case "smart":
		return "smart"
	case "auto_create_if_missing":
		return "auto_create_if_missing"
	case "existing_only", "":
		return "existing_only"
	default:
		return "existing_only"
	}
}

// supportsAutoCreateMigration 判定 legacy 路径能否为该组合生成建表语句。
//
// capability 侧只在 planner 为 generic-legacy-planner 时才查询这里，所以专用
// planner 已覆盖的组合不会走到这个判断；剩下的组合交给通用互转层。
// 传入的可能是原始 Type（custom）或已解析类型：custom 只有经过
// resolveMigrationDBType 看 Driver 才能落到达梦等具体类型，所以调用方应传
// 已解析的类型；此处再做一次 normalize 兜底双写归一。
func supportsAutoCreateMigration(sourceType, targetType string) bool {
	return supportsCrossDialectAutoCreate(
		normalizeMigrationDBType(sourceType),
		normalizeMigrationDBType(targetType),
	)
}

func inspectTableColumns(database db.Database, schema, table string) ([]connection.ColumnDefinition, bool, error) {
	cols, err := database.GetColumns(schema, table)
	if err != nil {
		if isLikelyTableNotFound(err) {
			return nil, false, nil
		}
		return nil, false, err
	}
	if len(cols) == 0 {
		return cols, false, nil
	}
	return cols, true, nil
}

func isLikelyTableNotFound(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(strings.TrimSpace(err.Error()))
	if text == "" {
		return false
	}
	keywords := []string{
		"doesn't exist",
		"does not exist",
		"not exist",
		"unknown table",
		"未找到表",
		"不存在",
		"invalid object",
		"relation",
	}
	for _, keyword := range keywords {
		if strings.Contains(text, keyword) {
			return true
		}
	}
	return false
}

func buildSchemaMigrationPlanLegacy(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	plan := SchemaMigrationPlan{}
	sourceType := resolveMigrationDBType(config.SourceConfig)
	targetType := resolveMigrationDBType(config.TargetConfig)
	plan.SourceSchema, plan.SourceTable = normalizeSyncSourceSchemaAndTable(config, tableName)
	plan.TargetSchema, plan.TargetTable = normalizeSyncTargetSchemaAndTable(config, tableName)
	plan.SourceQueryTable = qualifiedNameForQuery(sourceType, plan.SourceSchema, plan.SourceTable, tableName)
	plan.TargetQueryTable = qualifiedTargetNameForQuery(targetType, plan.TargetSchema, plan.TargetTable)
	plan.PlannedAction = "使用已有目标表导入"
	if targetType == "tdengine" {
		plan.Warnings = append(plan.Warnings, "TDengine 目标端当前仅支持 INSERT 写入；若存在差异更新/删除，执行期会被拒绝，请优先使用仅插入或全量覆盖模式")
	} else if targetType == "iotdb" {
		plan.Warnings = append(plan.Warnings, "IoTDB 目标端当前仅支持 INSERT 写入；若存在差异更新/删除，执行期会被拒绝，请优先使用仅插入模式")
	}

	sourceCols, sourceExists, err := inspectTableColumns(sourceDB, plan.SourceSchema, plan.SourceTable)
	if err != nil {
		return plan, nil, nil, syncWrapDetailError("data_sync.backend.error.source_table_columns_failed", err)
	}
	if !sourceExists {
		return plan, nil, nil, syncTextError("data_sync.backend.error.source_table_missing_or_no_columns", map[string]any{
			"table": tableName,
		})
	}

	targetCols, targetExists, err := inspectTableColumns(targetDB, plan.TargetSchema, plan.TargetTable)
	if err != nil {
		return plan, sourceCols, nil, syncWrapDetailError("data_sync.backend.error.target_table_columns_failed", err)
	}
	plan.TargetTableExists = targetExists

	strategy := normalizeTargetTableStrategy(config.TargetTableStrategy)
	if targetExists {
		missing := diffMissingColumnNames(sourceCols, targetCols)
		if len(missing) > 0 {
			plan.Warnings = append(plan.Warnings, fmt.Sprintf("目标表缺失字段 %d 个：%s", len(missing), strings.Join(missing, ", ")))
		}
		if len(missing) == 0 {
			plan.PlannedAction = "表结构已一致"
		} else if config.AutoAddColumns && supportsAutoAddColumnsForPair(sourceType, targetType) {
			targetSet := make(map[string]struct{}, len(targetCols))
			for _, col := range targetCols {
				key := strings.ToLower(strings.TrimSpace(col.Name))
				if key == "" {
					continue
				}
				targetSet[key] = struct{}{}
			}
			for _, col := range sourceCols {
				key := strings.ToLower(strings.TrimSpace(col.Name))
				if key == "" {
					continue
				}
				if _, ok := targetSet[key]; ok {
					continue
				}
				addSQL, addWarnings, err := buildAddColumnSQLForPair(sourceType, targetType, plan.TargetQueryTable, col)
				if err != nil {
					plan.Warnings = append(plan.Warnings, fmt.Sprintf("字段 %s 自动补齐 SQL 生成失败：%v", col.Name, err))
					continue
				}
				plan.Warnings = append(plan.Warnings, addWarnings...)
				plan.PreDataSQL = append(plan.PreDataSQL, addSQL)
				if warning := relaxedNotNullAddColumnWarning(col); warning != "" {
					plan.Warnings = append(plan.Warnings, warning)
				}
			}
			if len(plan.PreDataSQL) > 0 {
				plan.PlannedAction = fmt.Sprintf("补齐缺失字段(%d)后导入", len(plan.PreDataSQL))
			} else {
				plan.PlannedAction = fmt.Sprintf("目标表缺失字段(%d)，但未生成可执行补齐 SQL", len(missing))
			}
		} else {
			if config.AutoAddColumns {
				plan.PlannedAction = fmt.Sprintf("目标表缺失字段(%d)，当前库对暂不支持自动补齐", len(missing))
			} else {
				plan.PlannedAction = fmt.Sprintf("目标表缺失字段(%d)，未开启自动补齐", len(missing))
			}
		}
		if strategy != "existing_only" {
			plan.Warnings = append(plan.Warnings, "目标表已存在，当前仅执行数据导入；不会自动重建已有索引/约束")
		}
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}

	switch strategy {
	case "existing_only":
		plan.PlannedAction = "目标表不存在，需先手工创建"
		plan.Warnings = append(plan.Warnings, "当前策略要求目标表已存在，执行时不会自动建表")
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	case "smart", "auto_create_if_missing":
		if !supportsAutoCreateMigration(resolveMigrationDBType(config.SourceConfig), resolveMigrationDBType(config.TargetConfig)) {
			plan.PlannedAction = "当前库对暂不支持自动建表"
			plan.Warnings = append(plan.Warnings, fmt.Sprintf("当前组合未接入专用自动建表规划器：%s -> %s", config.SourceConfig.Type, config.TargetConfig.Type))
			return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
		}
		plan.AutoCreate = true
		plan.PlannedAction = "目标表不存在，将自动建表后导入"
		createSQL, postSQL, warnings, unsupported, unmigrated, idxCreate, idxSkip, err := buildLegacyAutoCreateTablePlan(targetType, config, plan.TargetQueryTable, sourceCols, sourceDB, plan.SourceSchema, plan.SourceTable)
		if err != nil {
			return plan, sourceCols, targetCols, err
		}
		plan.CreateTableSQL = createSQL
		plan.PostDataSQL = append(plan.PostDataSQL, postSQL...)
		plan.Warnings = append(plan.Warnings, warnings...)
		plan.UnsupportedObjects = append(plan.UnsupportedObjects, unsupported...)
		plan.UnmigratedIndexes = append(plan.UnmigratedIndexes, unmigrated...)
		plan.IndexesToCreate = idxCreate
		plan.IndexesSkipped = idxSkip
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	default:
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}
}

func dedupeSchemaMigrationPlan(plan SchemaMigrationPlan) SchemaMigrationPlan {
	plan.Warnings = dedupeStrings(plan.Warnings)
	plan.UnsupportedObjects = dedupeStrings(plan.UnsupportedObjects)
	return plan
}

func InspectSchemaMigrationPlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, error) {
	plan, _, _, err := buildSchemaMigrationPlan(config, tableName, sourceDB, targetDB)
	return plan, err
}

func dedupeStrings(items []string) []string {
	if len(items) == 0 {
		return items
	}
	seen := make(map[string]struct{}, len(items))
	out := make([]string, 0, len(items))
	for _, item := range items {
		text := strings.TrimSpace(item)
		if text == "" {
			continue
		}
		if _, ok := seen[text]; ok {
			continue
		}
		seen[text] = struct{}{}
		out = append(out, text)
	}
	return out
}
