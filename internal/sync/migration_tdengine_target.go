package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"fmt"
	"strconv"
	"strings"
)

type mySQLLikeToTDenginePlanner struct{}

type pgLikeToTDenginePlanner struct{}

type clickHouseToTDenginePlanner struct{}

type tdengineToTDenginePlanner struct{}

func (mySQLLikeToTDenginePlanner) Name() string { return "mysqllike-tdengine-planner" }

func (mySQLLikeToTDenginePlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	sourceType := resolveMigrationDBType(ctx.Config.SourceConfig)
	targetType := resolveMigrationDBType(ctx.Config.TargetConfig)
	if isMySQLLikeSourceType(sourceType) && targetType == "tdengine" {
		return MigrationSupportLevelFull
	}
	return MigrationSupportLevelUnsupported
}

func (mySQLLikeToTDenginePlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildMySQLLikeToTDenginePlan(ctx.Config, ctx.TableName, ctx.SourceDB, ctx.TargetDB)
}

func (pgLikeToTDenginePlanner) Name() string { return "pglike-tdengine-planner" }

func (pgLikeToTDenginePlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	sourceType := resolveMigrationDBType(ctx.Config.SourceConfig)
	targetType := resolveMigrationDBType(ctx.Config.TargetConfig)
	if isPGLikeSource(sourceType) && targetType == "tdengine" {
		return MigrationSupportLevelFull
	}
	return MigrationSupportLevelUnsupported
}

func (pgLikeToTDenginePlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildPGLikeToTDenginePlan(ctx.Config, ctx.TableName, ctx.SourceDB, ctx.TargetDB)
}

func buildMySQLLikeToTDenginePlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildSourceToTDenginePlan(config, tableName, sourceDB, targetDB, isMySQLLikeTDengineTimestampCandidate, buildMySQLLikeToTDengineCreateTableSQL)
}

func buildPGLikeToTDenginePlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildSourceToTDenginePlan(config, tableName, sourceDB, targetDB, isPGLikeTDengineTimestampCandidate, buildPGLikeToTDengineCreateTableSQL)
}

func buildClickHouseToTDenginePlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildSourceToTDenginePlan(config, tableName, sourceDB, targetDB, isClickHouseTDengineTimestampCandidate, buildClickHouseToTDengineCreateTableSQL)
}

func buildTDengineToTDenginePlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildSourceToTDenginePlan(config, tableName, sourceDB, targetDB, isTDengineTDengineTimestampCandidate, buildTDengineToTDengineCreateTableSQL)
}

func (clickHouseToTDenginePlanner) Name() string { return "clickhouse-tdengine-planner" }

func (clickHouseToTDenginePlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	sourceType := resolveMigrationDBType(ctx.Config.SourceConfig)
	targetType := resolveMigrationDBType(ctx.Config.TargetConfig)
	if sourceType == "clickhouse" && targetType == "tdengine" {
		return MigrationSupportLevelFull
	}
	return MigrationSupportLevelUnsupported
}

func (clickHouseToTDenginePlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildClickHouseToTDenginePlan(ctx.Config, ctx.TableName, ctx.SourceDB, ctx.TargetDB)
}

func (tdengineToTDenginePlanner) Name() string { return "tdengine-tdengine-planner" }

func (tdengineToTDenginePlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	sourceType := resolveMigrationDBType(ctx.Config.SourceConfig)
	targetType := resolveMigrationDBType(ctx.Config.TargetConfig)
	if sourceType == "tdengine" && targetType == "tdengine" {
		return MigrationSupportLevelFull
	}
	return MigrationSupportLevelUnsupported
}

func (tdengineToTDenginePlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildTDengineToTDenginePlan(ctx.Config, ctx.TableName, ctx.SourceDB, ctx.TargetDB)
}

type tdengineTimestampCandidate func(connection.ColumnDefinition) bool

type tdengineCreateTableBuilder func(string, []connection.ColumnDefinition, int) (string, []string, []string)

func buildSourceToTDenginePlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database, isTimestamp tdengineTimestampCandidate, buildCreateSQL tdengineCreateTableBuilder) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	plan := SchemaMigrationPlan{}
	sourceType := resolveMigrationDBType(config.SourceConfig)
	targetType := resolveMigrationDBType(config.TargetConfig)
	plan.SourceSchema, plan.SourceTable = normalizeSyncSourceSchemaAndTable(config, tableName)
	plan.TargetSchema, plan.TargetTable = normalizeSyncTargetSchemaAndTable(config, tableName)
	plan.SourceQueryTable = qualifiedNameForQuery(sourceType, plan.SourceSchema, plan.SourceTable, tableName)
	plan.TargetQueryTable = qualifiedTargetNameForQuery(targetType, plan.TargetSchema, plan.TargetTable)
	plan.PlannedAction = "使用已有目标表导入"

	sourceCols, sourceExists, err := inspectTableColumns(sourceDB, plan.SourceSchema, plan.SourceTable)
	if err != nil {
		return plan, nil, nil, syncWrapDetailError("data_sync.backend.error.source_table_columns_failed", err)
	}
	if !sourceExists {
		return plan, nil, nil, syncTextError("data_sync.backend.error.source_table_missing_or_no_columns", map[string]any{
			"table": tableName,
		})
	}

	plan.Warnings = append(plan.Warnings, tdengineTargetBaseWarnings()...)
	timestampIndex := findTDengineTimestampColumn(sourceCols, isTimestamp)
	if timestampIndex < 0 {
		plan.Warnings = append(plan.Warnings, tdengineTargetMissingTimeWarning())
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
		if strategy != "existing_only" {
			plan.Warnings = append(plan.Warnings, "TDengine 目标端当前不自动补齐已有目标表字段，请先确认目标表结构")
		}
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}

	switch strategy {
	case "existing_only":
		plan.PlannedAction = "目标表不存在，需先手工创建"
		plan.Warnings = append(plan.Warnings, "当前策略要求目标表已存在，执行时不会自动建表")
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	case "smart", "auto_create_if_missing":
		if timestampIndex < 0 {
			plan.PlannedAction = "源表未识别到可映射为 TDengine 首列的时间列，无法自动建表"
			plan.UnsupportedObjects = append(plan.UnsupportedObjects, "TDengine regular table 首列必须为 TIMESTAMP，当前源表缺少可直接映射的时间列")
			return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
		}
		plan.AutoCreate = true
		plan.PlannedAction = "目标表不存在，将自动建表后导入"
		createSQL, warnings, unsupported := buildCreateSQL(plan.TargetQueryTable, sourceCols, timestampIndex)
		plan.CreateTableSQL = createSQL
		plan.Warnings = append(plan.Warnings, warnings...)
		plan.UnsupportedObjects = append(plan.UnsupportedObjects, unsupported...)
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	default:
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}
}

func tdengineTargetBaseWarnings() []string {
	return []string{
		"TDengine 目标端当前仅支持 INSERT 写入；若存在差异 update/delete，执行期会被拒绝",
		"TDengine 目标端 auto-create 当前仅创建基础表；索引、外键、触发器、supertable/TAGS/TTL 不会自动迁移",
	}
}

func tdengineTargetMissingTimeWarning() string {
	return "源表缺少可映射的时间列，自动建表将不可用；如需继续，请先人工准备 TDengine 目标表与时间列"
}

func findTDengineTimestampColumn(sourceCols []connection.ColumnDefinition, candidate tdengineTimestampCandidate) int {
	preferred := []string{"ts", "timestamp", "event_time", "eventtime", "created_at", "create_time", "occurred_at"}
	for _, name := range preferred {
		for idx, col := range sourceCols {
			if !candidate(col) {
				continue
			}
			if strings.EqualFold(strings.TrimSpace(col.Name), name) {
				return idx
			}
		}
	}
	for idx, col := range sourceCols {
		if candidate(col) {
			return idx
		}
	}
	return -1
}

func reorderTDengineColumns(sourceCols []connection.ColumnDefinition, timestampIndex int) []connection.ColumnDefinition {
	if timestampIndex <= 0 || timestampIndex >= len(sourceCols) {
		cloned := make([]connection.ColumnDefinition, len(sourceCols))
		copy(cloned, sourceCols)
		return cloned
	}
	ordered := make([]connection.ColumnDefinition, 0, len(sourceCols))
	ordered = append(ordered, sourceCols[timestampIndex])
	for idx, col := range sourceCols {
		if idx == timestampIndex {
			continue
		}
		ordered = append(ordered, col)
	}
	return ordered
}

func buildMySQLLikeToTDengineCreateTableSQL(targetQueryTable string, sourceCols []connection.ColumnDefinition, timestampIndex int) (string, []string, []string) {
	ordered := reorderTDengineColumns(sourceCols, timestampIndex)
	columnDefs := make([]string, 0, len(ordered))
	warnings := make([]string, 0)
	unsupported := []string{"源表索引/外键/触发器/唯一约束/自增语义当前不会自动迁移到 TDengine"}
	if timestampIndex != 0 && timestampIndex >= 0 && timestampIndex < len(sourceCols) {
		warnings = append(warnings, fmt.Sprintf("TDengine 基础表要求时间列优先，已将字段 %s 调整为首列", sourceCols[timestampIndex].Name))
	}
	for idx, col := range ordered {
		def, colWarnings := mapMySQLLikeColumnToTDengine(col, idx == 0)
		warnings = append(warnings, colWarnings...)
		columnDefs = append(columnDefs, fmt.Sprintf("%s %s", quoteIdentByType("tdengine", col.Name), def))
	}
	createSQL := fmt.Sprintf("CREATE TABLE %s (\n  %s\n)", quoteQualifiedIdentByType("tdengine", targetQueryTable), strings.Join(columnDefs, ",\n  "))
	return createSQL, dedupeStrings(warnings), dedupeStrings(unsupported)
}

func buildPGLikeToTDengineCreateTableSQL(targetQueryTable string, sourceCols []connection.ColumnDefinition, timestampIndex int) (string, []string, []string) {
	ordered := reorderTDengineColumns(sourceCols, timestampIndex)
	columnDefs := make([]string, 0, len(ordered))
	warnings := make([]string, 0)
	unsupported := []string{"源表索引/外键/触发器/唯一约束/identity/sequence 语义当前不会自动迁移到 TDengine"}
	if timestampIndex != 0 && timestampIndex >= 0 && timestampIndex < len(sourceCols) {
		warnings = append(warnings, fmt.Sprintf("TDengine 基础表要求时间列优先，已将字段 %s 调整为首列", sourceCols[timestampIndex].Name))
	}
	for idx, col := range ordered {
		def, colWarnings := mapPGLikeColumnToTDengine(col, idx == 0)
		warnings = append(warnings, colWarnings...)
		columnDefs = append(columnDefs, fmt.Sprintf("%s %s", quoteIdentByType("tdengine", col.Name), def))
	}
	createSQL := fmt.Sprintf("CREATE TABLE %s (\n  %s\n)", quoteQualifiedIdentByType("tdengine", targetQueryTable), strings.Join(columnDefs, ",\n  "))
	return createSQL, dedupeStrings(warnings), dedupeStrings(unsupported)
}

func buildClickHouseToTDengineCreateTableSQL(targetQueryTable string, sourceCols []connection.ColumnDefinition, timestampIndex int) (string, []string, []string) {
	ordered := reorderTDengineColumns(sourceCols, timestampIndex)
	columnDefs := make([]string, 0, len(ordered))
	warnings := make([]string, 0)
	unsupported := []string{"源表 ORDER BY/PARTITION/TTL/Projection/物化视图 语义当前不会自动迁移到 TDengine"}
	if timestampIndex != 0 && timestampIndex >= 0 && timestampIndex < len(sourceCols) {
		warnings = append(warnings, fmt.Sprintf("TDengine 基础表要求时间列优先，已将字段 %s 调整为首列", sourceCols[timestampIndex].Name))
	}
	for idx, col := range ordered {
		def, colWarnings := mapClickHouseColumnToTDengine(col, idx == 0)
		warnings = append(warnings, colWarnings...)
		columnDefs = append(columnDefs, fmt.Sprintf("%s %s", quoteIdentByType("tdengine", col.Name), def))
	}
	createSQL := fmt.Sprintf("CREATE TABLE %s (\n  %s\n)", quoteQualifiedIdentByType("tdengine", targetQueryTable), strings.Join(columnDefs, ",\n  "))
	return createSQL, dedupeStrings(warnings), dedupeStrings(unsupported)
}

func buildTDengineToTDengineCreateTableSQL(targetQueryTable string, sourceCols []connection.ColumnDefinition, timestampIndex int) (string, []string, []string) {
	ordered := reorderTDengineColumns(sourceCols, timestampIndex)
	columnDefs := make([]string, 0, len(ordered))
	warnings := make([]string, 0)
	unsupported := []string{"源表 supertable/TAGS/TTL/保留策略/索引 语义当前不会自动迁移到 TDengine regular table"}
	if timestampIndex != 0 && timestampIndex >= 0 && timestampIndex < len(sourceCols) {
		warnings = append(warnings, fmt.Sprintf("TDengine 基础表要求时间列优先，已将字段 %s 调整为首列", sourceCols[timestampIndex].Name))
	}
	for idx, col := range ordered {
		def, colWarnings := mapTDengineColumnToTDengine(col, idx == 0)
		warnings = append(warnings, colWarnings...)
		columnDefs = append(columnDefs, fmt.Sprintf("%s %s", quoteIdentByType("tdengine", col.Name), def))
	}
	createSQL := fmt.Sprintf("CREATE TABLE %s (\n  %s\n)", quoteQualifiedIdentByType("tdengine", targetQueryTable), strings.Join(columnDefs, ",\n  "))
	return createSQL, dedupeStrings(warnings), dedupeStrings(unsupported)
}

func isMySQLLikeTDengineTimestampCandidate(col connection.ColumnDefinition) bool {
	raw := strings.ToLower(strings.TrimSpace(col.Type))
	clean := strings.ReplaceAll(raw, " unsigned", "")
	clean = strings.ReplaceAll(clean, " zerofill", "")
	return strings.HasPrefix(clean, "timestamp") || strings.HasPrefix(clean, "datetime")
}

func isPGLikeTDengineTimestampCandidate(col connection.ColumnDefinition) bool {
	raw := strings.ToLower(strings.TrimSpace(col.Type))
	return strings.HasPrefix(raw, "timestamp")
}

func isClickHouseTDengineTimestampCandidate(col connection.ColumnDefinition) bool {
	lower, _ := unwrapClickHouseTDengineType(col.Type)
	return strings.HasPrefix(lower, "datetime")
}

func isTDengineTDengineTimestampCandidate(col connection.ColumnDefinition) bool {
	base, _ := parseTDengineType(col.Type)
	return base == "TIMESTAMP"
}

func mapMySQLLikeColumnToTDengine(col connection.ColumnDefinition, forceTimestamp bool) (string, []string) {
	warnings := make([]string, 0)
	if forceTimestamp {
		if !isMySQLLikeTDengineTimestampCandidate(col) {
			warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 已提升为 TDengine 首列 TIMESTAMP", col.Name, col.Type))
		}
		return "TIMESTAMP", warnings
	}

	raw := strings.ToLower(strings.TrimSpace(col.Type))
	if raw == "" {
		return "VARCHAR(1024)", []string{fmt.Sprintf("字段 %s 类型为空，已降级为 VARCHAR(1024)", col.Name)}
	}
	unsigned := strings.Contains(raw, "unsigned")
	clean := strings.ReplaceAll(raw, " unsigned", "")
	clean = strings.ReplaceAll(clean, " zerofill", "")
	isAutoIncrement := strings.Contains(strings.ToLower(strings.TrimSpace(col.Extra)), "auto_increment")
	if isAutoIncrement {
		warnings = append(warnings, fmt.Sprintf("字段 %s 自增语义不会迁移到 TDengine", col.Name))
	}
	if col.Key == "PRI" || col.Key == "PK" {
		warnings = append(warnings, fmt.Sprintf("字段 %s 主键语义不会按关系型约束迁移到 TDengine", col.Name))
	}

	switch {
	case strings.HasPrefix(clean, "tinyint(1)") && !unsigned && !isAutoIncrement:
		return "BOOL", warnings
	case strings.HasPrefix(clean, "tinyint"):
		if unsigned {
			return "UTINYINT", warnings
		}
		return "TINYINT", warnings
	case strings.HasPrefix(clean, "smallint"):
		if unsigned {
			return "USMALLINT", warnings
		}
		return "SMALLINT", warnings
	case strings.HasPrefix(clean, "mediumint"), strings.HasPrefix(clean, "int"), strings.HasPrefix(clean, "integer"):
		if unsigned {
			return "UINT", warnings
		}
		return "INT", warnings
	case strings.HasPrefix(clean, "bigint"):
		if unsigned {
			return "UBIGINT", warnings
		}
		return "BIGINT", warnings
	case strings.HasPrefix(clean, "decimal"), strings.HasPrefix(clean, "numeric"):
		return normalizeTDengineDecimalType(clean), warnings
	case strings.HasPrefix(clean, "float"):
		return "FLOAT", warnings
	case strings.HasPrefix(clean, "double"):
		return "DOUBLE", warnings
	case strings.HasPrefix(clean, "date"):
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 date 已降级映射为 TIMESTAMP", col.Name))
		return "TIMESTAMP", warnings
	case strings.HasPrefix(clean, "timestamp"), strings.HasPrefix(clean, "datetime"):
		return "TIMESTAMP", warnings
	case strings.HasPrefix(clean, "time"):
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 暂无稳定 TDengine 时间-only 映射，已降级为 VARCHAR(64)", col.Name, col.Type))
		return "VARCHAR(64)", warnings
	case strings.HasPrefix(clean, "char("), strings.HasPrefix(clean, "varchar("):
		return fmt.Sprintf("VARCHAR(%d)", normalizeTDengineVarcharLength(extractFirstTypeLength(clean), 255)), warnings
	case strings.HasPrefix(clean, "tinytext"), strings.HasPrefix(clean, "text"), strings.HasPrefix(clean, "mediumtext"), strings.HasPrefix(clean, "longtext"):
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 已降级为 VARCHAR(4096)", col.Name, col.Type))
		return "VARCHAR(4096)", warnings
	case strings.HasPrefix(clean, "json"):
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 因 TDengine JSON 仅适用于 TAG，已降级为 VARCHAR(4096)", col.Name, col.Type))
		return "VARCHAR(4096)", warnings
	case strings.HasPrefix(clean, "enum"), strings.HasPrefix(clean, "set"):
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 已降级为 VARCHAR(255)", col.Name, col.Type))
		return "VARCHAR(255)", warnings
	case strings.HasPrefix(clean, "binary"), strings.HasPrefix(clean, "varbinary"), strings.HasPrefix(clean, "tinyblob"), strings.HasPrefix(clean, "blob"), strings.HasPrefix(clean, "mediumblob"), strings.HasPrefix(clean, "longblob"):
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 已按字符串语义降级为 VARCHAR(4096)", col.Name, col.Type))
		return "VARCHAR(4096)", warnings
	default:
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 暂无专门 TDengine 映射，已降级为 VARCHAR(1024)", col.Name, col.Type))
		return "VARCHAR(1024)", warnings
	}
}

func mapPGLikeColumnToTDengine(col connection.ColumnDefinition, forceTimestamp bool) (string, []string) {
	warnings := make([]string, 0)
	if forceTimestamp {
		if raw := strings.ToLower(strings.TrimSpace(col.Type)); !strings.HasPrefix(raw, "timestamp") {
			warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 已提升为 TDengine 首列 TIMESTAMP", col.Name, col.Type))
		}
		return "TIMESTAMP", warnings
	}

	raw := strings.ToLower(strings.TrimSpace(col.Type))
	if raw == "" {
		return "VARCHAR(1024)", []string{fmt.Sprintf("字段 %s 类型为空，已降级为 VARCHAR(1024)", col.Name)}
	}
	if col.Key == "PRI" || col.Key == "PK" {
		warnings = append(warnings, fmt.Sprintf("字段 %s 主键语义不会按关系型约束迁移到 TDengine", col.Name))
	}
	if strings.Contains(strings.ToLower(strings.TrimSpace(col.Extra)), "identity") || strings.Contains(strings.ToLower(strings.TrimSpace(col.Extra)), "auto_increment") {
		warnings = append(warnings, fmt.Sprintf("字段 %s 自增/identity 语义不会迁移到 TDengine", col.Name))
	}

	switch {
	case raw == "boolean" || strings.HasPrefix(raw, "bool"):
		return "BOOL", warnings
	case raw == "smallint":
		return "SMALLINT", warnings
	case raw == "integer" || raw == "int4":
		return "INT", warnings
	case raw == "bigint" || raw == "int8":
		return "BIGINT", warnings
	case strings.HasPrefix(raw, "numeric"), strings.HasPrefix(raw, "decimal"):
		return normalizeTDengineDecimalType(raw), warnings
	case raw == "real" || raw == "float4":
		return "FLOAT", warnings
	case raw == "double precision" || raw == "float8":
		return "DOUBLE", warnings
	case raw == "date":
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 date 已降级映射为 TIMESTAMP", col.Name))
		return "TIMESTAMP", warnings
	case strings.HasPrefix(raw, "timestamp"):
		return "TIMESTAMP", warnings
	case strings.HasPrefix(raw, "time"):
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 暂无稳定 TDengine 时间-only 映射，已降级为 VARCHAR(64)", col.Name, col.Type))
		return "VARCHAR(64)", warnings
	case strings.HasPrefix(raw, "character varying("), strings.HasPrefix(raw, "varchar("), strings.HasPrefix(raw, "character("), strings.HasPrefix(raw, "char("):
		return fmt.Sprintf("VARCHAR(%d)", normalizeTDengineVarcharLength(extractFirstTypeLength(raw), 255)), warnings
	case raw == "text":
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 text 已降级为 VARCHAR(4096)", col.Name))
		return "VARCHAR(4096)", warnings
	case raw == "uuid":
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 uuid 已降级为 VARCHAR(36)", col.Name))
		return "VARCHAR(36)", warnings
	case raw == "json" || raw == "jsonb":
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 因 TDengine JSON 仅适用于 TAG，已降级为 VARCHAR(4096)", col.Name, col.Type))
		return "VARCHAR(4096)", warnings
	case raw == "bytea":
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 bytea 已按字符串语义降级为 VARCHAR(4096)", col.Name))
		return "VARCHAR(4096)", warnings
	case strings.HasSuffix(raw, "[]") || strings.HasPrefix(raw, "array"):
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 已降级为 VARCHAR(4096)", col.Name, col.Type))
		return "VARCHAR(4096)", warnings
	case raw == "user-defined":
		warnings = append(warnings, fmt.Sprintf("字段 %s 为用户自定义类型，已降级为 VARCHAR(1024)", col.Name))
		return "VARCHAR(1024)", warnings
	default:
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 暂无专门 TDengine 映射，已降级为 VARCHAR(1024)", col.Name, col.Type))
		return "VARCHAR(1024)", warnings
	}
}

func mapClickHouseColumnToTDengine(col connection.ColumnDefinition, forceTimestamp bool) (string, []string) {
	warnings := make([]string, 0)
	if forceTimestamp {
		if !isClickHouseTDengineTimestampCandidate(col) {
			warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 已提升为 TDengine 首列 TIMESTAMP", col.Name, col.Type))
		}
		return "TIMESTAMP", warnings
	}

	lower, _ := unwrapClickHouseTDengineType(col.Type)
	if lower == "" {
		return "VARCHAR(1024)", []string{fmt.Sprintf("字段 %s 类型为空，已降级为 VARCHAR(1024)", col.Name)}
	}

	switch {
	case lower == "bool" || lower == "boolean":
		return "BOOL", warnings
	case lower == "int8":
		return "TINYINT", warnings
	case lower == "uint8":
		return "UTINYINT", warnings
	case lower == "int16":
		return "SMALLINT", warnings
	case lower == "uint16":
		return "USMALLINT", warnings
	case lower == "int32":
		return "INT", warnings
	case lower == "uint32":
		return "UINT", warnings
	case lower == "int64":
		return "BIGINT", warnings
	case lower == "uint64":
		return "UBIGINT", warnings
	case lower == "float32":
		return "FLOAT", warnings
	case lower == "float64":
		return "DOUBLE", warnings
	case lower == "date":
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 date 已降级映射为 TIMESTAMP", col.Name))
		return "TIMESTAMP", warnings
	case strings.HasPrefix(lower, "datetime"):
		return "TIMESTAMP", warnings
	case lower == "string":
		return "VARCHAR(1024)", warnings
	case lower == "uuid":
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 uuid 已降级为 VARCHAR(36)", col.Name))
		return "VARCHAR(36)", warnings
	case lower == "json", strings.HasPrefix(lower, "map("), strings.HasPrefix(lower, "array("), strings.HasPrefix(lower, "tuple("), strings.HasPrefix(lower, "nested("):
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 已降级为 VARCHAR(4096)", col.Name, col.Type))
		return "VARCHAR(4096)", warnings
	case strings.HasPrefix(lower, "enum8("), strings.HasPrefix(lower, "enum16("):
		warnings = append(warnings, fmt.Sprintf("字段 %s 枚举类型 %s 已降级为 VARCHAR(255)", col.Name, col.Type))
		return "VARCHAR(255)", warnings
	case clickHouseDecimalPattern.MatchString(lower):
		parts := clickHouseDecimalPattern.FindStringSubmatch(lower)
		return fmt.Sprintf("DECIMAL(%s,%s)", parts[2], parts[3]), warnings
	case clickHouseStringArgsPattern.MatchString(lower):
		parts := clickHouseStringArgsPattern.FindStringSubmatch(lower)
		length, err := strconv.Atoi(parts[1])
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("字段 %s FixedString 长度解析失败，已降级为 VARCHAR(255)", col.Name))
			return "VARCHAR(255)", warnings
		}
		return fmt.Sprintf("VARCHAR(%d)", normalizeTDengineVarcharLength(length, 255)), warnings
	default:
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 暂无专门 TDengine 映射，已降级为 VARCHAR(1024)", col.Name, col.Type))
		return "VARCHAR(1024)", warnings
	}
}

func mapTDengineColumnToTDengine(col connection.ColumnDefinition, forceTimestamp bool) (string, []string) {
	warnings := make([]string, 0)
	if forceTimestamp {
		if !isTDengineTDengineTimestampCandidate(col) {
			warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 已提升为 TDengine 首列 TIMESTAMP", col.Name, col.Type))
		}
		return "TIMESTAMP", warnings
	}

	base, length := parseTDengineType(col.Type)
	if base == "" {
		return "VARCHAR(1024)", []string{fmt.Sprintf("字段 %s 类型为空，已降级为 VARCHAR(1024)", col.Name)}
	}
	if isTDengineTagColumn(col) {
		warnings = append(warnings, fmt.Sprintf("字段 %s 为 TDengine TAG 列，迁移到 regular table 后将降级为普通字段", col.Name))
	}

	switch base {
	case "BOOL", "BOOLEAN":
		return "BOOL", warnings
	case "TINYINT":
		return "TINYINT", warnings
	case "UTINYINT":
		return "UTINYINT", warnings
	case "SMALLINT":
		return "SMALLINT", warnings
	case "USMALLINT":
		return "USMALLINT", warnings
	case "INT", "INTEGER":
		return "INT", warnings
	case "UINT":
		return "UINT", warnings
	case "BIGINT":
		return "BIGINT", warnings
	case "UBIGINT":
		return "UBIGINT", warnings
	case "FLOAT":
		return "FLOAT", warnings
	case "DOUBLE":
		return "DOUBLE", warnings
	case "DECIMAL", "NUMERIC":
		return normalizeTDengineDecimalType(col.Type), warnings
	case "TIMESTAMP":
		return "TIMESTAMP", warnings
	case "DATE":
		return "DATE", warnings
	case "JSON":
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 JSON 在 TDengine regular table 中不保留 TAG 语义，已降级为 VARCHAR(4096)", col.Name))
		return "VARCHAR(4096)", warnings
	case "BINARY", "NCHAR", "VARCHAR", "VARBINARY":
		if length > 0 {
			return fmt.Sprintf("%s(%d)", base, normalizeTDengineVarcharLength(length, length)), warnings
		}
		fallback := 255
		if base == "VARCHAR" {
			fallback = 1024
		}
		return fmt.Sprintf("%s(%d)", base, fallback), warnings
	default:
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 暂无专门 TDengine 同库映射，已降级为 VARCHAR(1024)", col.Name, col.Type))
		return "VARCHAR(1024)", warnings
	}
}

func unwrapClickHouseTDengineType(raw string) (string, bool) {
	text := strings.TrimSpace(raw)
	lower := strings.ToLower(text)
	nullable := false
	for {
		switched := false
		if strings.HasPrefix(lower, "nullable(") && strings.HasSuffix(lower, ")") {
			text = strings.TrimSpace(text[len("Nullable(") : len(text)-1])
			lower = strings.ToLower(text)
			nullable = true
			switched = true
		}
		if strings.HasPrefix(lower, "lowcardinality(") && strings.HasSuffix(lower, ")") {
			text = strings.TrimSpace(text[len("LowCardinality(") : len(text)-1])
			lower = strings.ToLower(text)
			switched = true
		}
		if !switched {
			break
		}
	}
	return lower, nullable
}

func normalizeTDengineDecimalType(raw string) string {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "DECIMAL(38,10)"
	}
	lower := strings.ToLower(text)
	if strings.HasPrefix(lower, "numeric") {
		return "DECIMAL" + text[len("numeric"):]
	}
	if strings.HasPrefix(lower, "decimal") {
		return "DECIMAL" + text[len("decimal"):]
	}
	return "DECIMAL(38,10)"
}

func normalizeTDengineVarcharLength(length int, fallback int) int {
	if fallback <= 0 {
		fallback = 255
	}
	if length <= 0 {
		return fallback
	}
	if length > 16384 {
		return 16384
	}
	return length
}

func extractFirstTypeLength(raw string) int {
	start := strings.Index(raw, "(")
	if start < 0 {
		return 0
	}
	end := strings.Index(raw[start+1:], ")")
	if end < 0 {
		return 0
	}
	inside := strings.TrimSpace(raw[start+1 : start+1+end])
	if inside == "" {
		return 0
	}
	parts := strings.SplitN(inside, ",", 2)
	length, err := strconv.Atoi(strings.TrimSpace(parts[0]))
	if err != nil {
		return 0
	}
	return length
}
