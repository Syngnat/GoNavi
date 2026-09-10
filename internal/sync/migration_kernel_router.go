package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"fmt"
	"strings"
)

type genericLegacyPlanner struct{}

type mysqlToMySQLPlanner struct{}

type pgLikeToPGLikePlanner struct{}

type clickHouseToClickHousePlanner struct{}

type mongoToMongoPlanner struct{}

type mysqlToPGLikePlanner struct{}

type mysqlToClickHousePlanner struct{}

type pgLikeToClickHousePlanner struct{}

type clickHouseToMySQLPlanner struct{}

type clickHouseToPGLikePlanner struct{}

type mysqlToMongoPlanner struct{}

type pgLikeToMongoPlanner struct{}

type clickHouseToMongoPlanner struct{}

type tdengineToMongoPlanner struct{}

type mongoToMySQLPlanner struct{}

type mongoToPGLikePlanner struct{}

type pgLikeToMySQLPlanner struct{}

type tdengineToMySQLPlanner struct{}

type tdengineToPGLikePlanner struct{}

type mongoToRelationalPlanner struct{}

func buildSchemaMigrationPlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	if hasExplicitSyncMappings(config) {
		mapping, err := explicitSyncMappingForTable(config, tableName)
		if err != nil {
			return SchemaMigrationPlan{}, nil, nil, err
		}
		if isIdentitySyncObjectMapping(mapping) {
			// Object renames have no field projection, so use the normal migration
			// planner and supply only its target object override. This preserves
			// auto-create, index creation, and cross-dialect type mapping.
			plannerConfig := config
			plannerConfig.Mappings = nil
			plannerConfig.identityMappingTarget = mapping.Target
			return buildSchemaMigrationPlan(plannerConfig, tableName, sourceDB, targetDB)
		}
		return buildMappedExistingTargetPlan(config, tableName, sourceDB, targetDB)
	}
	ctx := MigrationBuildContext{
		Config:    config,
		TableName: tableName,
		SourceDB:  sourceDB,
		TargetDB:  targetDB,
	}
	planner := resolveMigrationPlanner(ctx)
	if planner == nil {
		plan, sourceCols, targetCols, err := buildSchemaMigrationPlanLegacy(config, tableName, sourceDB, targetDB)
		return withDistributionClauseTargetGuard(config, plan), sourceCols, targetCols, err
	}
	plan, sourceCols, targetCols, err := planner.BuildPlan(ctx)
	return withDistributionClauseTargetGuard(config, plan), sourceCols, targetCols, err
}

// withDistributionClauseTargetGuard 收口 Doris/StarRocks 目标的自动建表。
//
// 这两个目标的 CREATE TABLE 必须带 key model 与 DISTRIBUTED BY 分桶定义，而
// isMySQLCoreType 把它们当作 MySQL 系可写目标，各条 MySQL 系 planner 会生成
// 普通 MySQL DDL —— 下发即失败。
//
// 收口必须放在统一出口：AutoCreate 散落在十几个 planner 里各自赋值，逐个改必然
// 漏。而且只改 capability 层不够 —— capability 只驱动 UI 与 preflight，plan 层
// 仍会带着 AutoCreate=true 与 CreateTableSQL 进入执行期，等于把"UI 说能建、
// 执行期报错"换成了"UI 说不能建、执行期照样建失败"，两层判定不一致的老毛病。
func withDistributionClauseTargetGuard(config SyncConfig, plan SchemaMigrationPlan) SchemaMigrationPlan {
	if !plan.AutoCreate || !requiresDistributionClauseTarget(resolveMigrationDBType(config.TargetConfig)) {
		return plan
	}
	plan.AutoCreate = false
	plan.CreateTableSQL = ""
	// 文案按表是否存在区分：planner 路径可能带着 AutoCreate=true 与已存在的
	// 目标表走到这里，统一写"目标表不存在"会误导。
	if plan.TargetTableExists {
		plan.PlannedAction = "目标为 Doris/StarRocks，使用已存在的目标表导入"
	} else {
		plan.PlannedAction = "目标表不存在，需先手工创建"
	}
	plan.Warnings = append(plan.Warnings,
		"Doris/StarRocks 建表需要显式指定 key model 与 DISTRIBUTED BY 分桶定义，当前不支持自动建表；请先手工创建目标表后重试")
	return dedupeSchemaMigrationPlan(plan)
}

func resolveMigrationPlanner(ctx MigrationBuildContext) MigrationPlanner {
	planners := []MigrationPlanner{
		mysqlToMySQLPlanner{},
		pgLikeToPGLikePlanner{},
		clickHouseToClickHousePlanner{},
		mongoToMongoPlanner{},
		mysqlToPGLikePlanner{},
		mySQLLikeToTDenginePlanner{},
		pgLikeToTDenginePlanner{},
		clickHouseToTDenginePlanner{},
		tdengineToTDenginePlanner{},
		tdengineToPGLikePlanner{},
		tdengineToMySQLPlanner{},
		mysqlToClickHousePlanner{},
		pgLikeToClickHousePlanner{},
		clickHouseToMySQLPlanner{},
		clickHouseToPGLikePlanner{},
		mysqlToMongoPlanner{},
		pgLikeToMongoPlanner{},
		clickHouseToMongoPlanner{},
		tdengineToMongoPlanner{},
		mongoToMySQLPlanner{},
		mongoToPGLikePlanner{},
		pgLikeToMySQLPlanner{},
		mongoToRelationalPlanner{},
		genericLegacyPlanner{},
	}
	bestLevel := MigrationSupportLevelUnsupported
	var bestPlanner MigrationPlanner
	for _, planner := range planners {
		level := planner.SupportLevel(ctx)
		if migrationSupportRank(level) > migrationSupportRank(bestLevel) {
			bestLevel = level
			bestPlanner = planner
		}
	}
	return bestPlanner
}

func migrationSupportRank(level MigrationSupportLevel) int {
	switch level {
	case MigrationSupportLevelFull:
		return 4
	case MigrationSupportLevelPlanned:
		return 3
	case MigrationSupportLevelPartial:
		return 2
	default:
		return 1
	}
}

func isMySQLLikeType(dbType string) bool {
	return isMySQLLikeWritableTargetType(dbType)
}

func classifyMigrationDataModel(dbType string) MigrationDataModel {
	switch normalizeMigrationDBType(dbType) {
	case "mysql", "mariadb", "oceanbase", "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "oracle", "sqlserver", "dameng", "sqlite", "duckdb", "iris", "trino":
		return MigrationDataModelRelational
	case "mongodb":
		return MigrationDataModelDocument
	case "clickhouse", "diros", "starrocks", "sphinx":
		return MigrationDataModelColumnar
	case "tdengine", "iotdb":
		return MigrationDataModelTimeSeries
	case "redis":
		return MigrationDataModelKeyValue
	default:
		return MigrationDataModelCustom
	}
}

func (genericLegacyPlanner) Name() string { return "generic-legacy-planner" }

func (genericLegacyPlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	_ = ctx
	return MigrationSupportLevelPartial
}

func (genericLegacyPlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildSchemaMigrationPlanLegacy(ctx.Config, ctx.TableName, ctx.SourceDB, ctx.TargetDB)
}

func (mysqlToMySQLPlanner) Name() string { return "mysql-mysql-planner" }

func (mysqlToMySQLPlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	sourceType := resolveMigrationDBType(ctx.Config.SourceConfig)
	targetType := resolveMigrationDBType(ctx.Config.TargetConfig)
	if isMySQLRowStoreType(sourceType) && isMySQLRowStoreType(targetType) {
		return MigrationSupportLevelFull
	}
	return MigrationSupportLevelUnsupported
}

func (mysqlToMySQLPlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildMySQLToMySQLPlan(ctx.Config, ctx.TableName, ctx.SourceDB, ctx.TargetDB)
}

func (pgLikeToPGLikePlanner) Name() string { return "pglike-pglike-planner" }

func (pgLikeToPGLikePlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	sourceType := resolveMigrationDBType(ctx.Config.SourceConfig)
	targetType := resolveMigrationDBType(ctx.Config.TargetConfig)
	if isPGLikeSameFamilyDDLType(sourceType) && isPGLikeSameFamilyDDLType(targetType) {
		return MigrationSupportLevelFull
	}
	return MigrationSupportLevelUnsupported
}

func (pgLikeToPGLikePlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildPGLikeToPGLikePlan(ctx.Config, ctx.TableName, ctx.SourceDB, ctx.TargetDB)
}

func (clickHouseToClickHousePlanner) Name() string { return "clickhouse-clickhouse-planner" }

func (clickHouseToClickHousePlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	sourceType := resolveMigrationDBType(ctx.Config.SourceConfig)
	targetType := resolveMigrationDBType(ctx.Config.TargetConfig)
	if sourceType == "clickhouse" && targetType == "clickhouse" {
		return MigrationSupportLevelFull
	}
	return MigrationSupportLevelUnsupported
}

func (clickHouseToClickHousePlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildClickHouseToClickHousePlan(ctx.Config, ctx.TableName, ctx.SourceDB, ctx.TargetDB)
}

func (mongoToMongoPlanner) Name() string { return "mongo-mongo-planner" }

func (mongoToMongoPlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	sourceType := resolveMigrationDBType(ctx.Config.SourceConfig)
	targetType := resolveMigrationDBType(ctx.Config.TargetConfig)
	if sourceType == "mongodb" && targetType == "mongodb" {
		return MigrationSupportLevelFull
	}
	return MigrationSupportLevelUnsupported
}

func (mongoToMongoPlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildMongoToMongoPlan(ctx.Config, ctx.TableName, ctx.SourceDB, ctx.TargetDB)
}

func (mysqlToPGLikePlanner) Name() string { return "mysql-pglike-planner" }

func (mysqlToPGLikePlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	sourceType := resolveMigrationDBType(ctx.Config.SourceConfig)
	targetType := resolveMigrationDBType(ctx.Config.TargetConfig)
	if isMySQLLikeSourceType(sourceType) && isPGLikeTarget(targetType) {
		return MigrationSupportLevelFull
	}
	return MigrationSupportLevelUnsupported
}

func (mysqlToPGLikePlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildMySQLToPGLikePlan(ctx.Config, ctx.TableName, ctx.SourceDB, ctx.TargetDB)
}

func (tdengineToMySQLPlanner) Name() string { return "tdengine-mysql-planner" }

func (tdengineToMySQLPlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	sourceType := resolveMigrationDBType(ctx.Config.SourceConfig)
	targetType := resolveMigrationDBType(ctx.Config.TargetConfig)
	if sourceType == "tdengine" && isMySQLLikeWritableTargetType(targetType) {
		return MigrationSupportLevelFull
	}
	return MigrationSupportLevelUnsupported
}

func (tdengineToMySQLPlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildTDengineToMySQLPlan(ctx.Config, ctx.TableName, ctx.SourceDB, ctx.TargetDB)
}

func (tdengineToPGLikePlanner) Name() string { return "tdengine-pglike-planner" }

func (tdengineToPGLikePlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	sourceType := resolveMigrationDBType(ctx.Config.SourceConfig)
	targetType := resolveMigrationDBType(ctx.Config.TargetConfig)
	if sourceType == "tdengine" && isPGLikeTarget(targetType) {
		return MigrationSupportLevelFull
	}
	return MigrationSupportLevelUnsupported
}

func (tdengineToPGLikePlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildTDengineToPGLikePlan(ctx.Config, ctx.TableName, ctx.SourceDB, ctx.TargetDB)
}

func (mysqlToClickHousePlanner) Name() string { return "mysql-clickhouse-planner" }

func (mysqlToClickHousePlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	sourceType := resolveMigrationDBType(ctx.Config.SourceConfig)
	targetType := resolveMigrationDBType(ctx.Config.TargetConfig)
	if isMySQLCoreType(sourceType) && targetType == "clickhouse" {
		return MigrationSupportLevelFull
	}
	return MigrationSupportLevelUnsupported
}

func (mysqlToClickHousePlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildMySQLToClickHousePlan(ctx.Config, ctx.TableName, ctx.SourceDB, ctx.TargetDB)
}

func (pgLikeToClickHousePlanner) Name() string { return "pglike-clickhouse-planner" }

func (pgLikeToClickHousePlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	sourceType := resolveMigrationDBType(ctx.Config.SourceConfig)
	targetType := resolveMigrationDBType(ctx.Config.TargetConfig)
	if isPGLikeSource(sourceType) && targetType == "clickhouse" {
		return MigrationSupportLevelFull
	}
	return MigrationSupportLevelUnsupported
}

func (pgLikeToClickHousePlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildPGLikeToClickHousePlan(ctx.Config, ctx.TableName, ctx.SourceDB, ctx.TargetDB)
}

func (clickHouseToMySQLPlanner) Name() string { return "clickhouse-mysql-planner" }

func (clickHouseToMySQLPlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	sourceType := resolveMigrationDBType(ctx.Config.SourceConfig)
	targetType := resolveMigrationDBType(ctx.Config.TargetConfig)
	if sourceType == "clickhouse" && isMySQLLikeWritableTargetType(targetType) {
		return MigrationSupportLevelFull
	}
	return MigrationSupportLevelUnsupported
}

func (clickHouseToMySQLPlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildClickHouseToMySQLPlan(ctx.Config, ctx.TableName, ctx.SourceDB, ctx.TargetDB)
}

func (clickHouseToPGLikePlanner) Name() string { return "clickhouse-pglike-planner" }

func (clickHouseToPGLikePlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	sourceType := resolveMigrationDBType(ctx.Config.SourceConfig)
	targetType := resolveMigrationDBType(ctx.Config.TargetConfig)
	if sourceType == "clickhouse" && isPGLikeTarget(targetType) {
		return MigrationSupportLevelFull
	}
	return MigrationSupportLevelUnsupported
}

func (clickHouseToPGLikePlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildClickHouseToPGLikePlan(ctx.Config, ctx.TableName, ctx.SourceDB, ctx.TargetDB)
}

func (mysqlToMongoPlanner) Name() string { return "mysql-mongo-planner" }

func (mysqlToMongoPlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	sourceType := resolveMigrationDBType(ctx.Config.SourceConfig)
	targetType := resolveMigrationDBType(ctx.Config.TargetConfig)
	if isMySQLCoreType(sourceType) && targetType == "mongodb" {
		return MigrationSupportLevelFull
	}
	return MigrationSupportLevelUnsupported
}

func (mysqlToMongoPlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildMySQLToMongoPlan(ctx.Config, ctx.TableName, ctx.SourceDB, ctx.TargetDB)
}

func (pgLikeToMongoPlanner) Name() string { return "pglike-mongo-planner" }

func (pgLikeToMongoPlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	sourceType := resolveMigrationDBType(ctx.Config.SourceConfig)
	targetType := resolveMigrationDBType(ctx.Config.TargetConfig)
	if isPGLikeSource(sourceType) && targetType == "mongodb" {
		return MigrationSupportLevelFull
	}
	return MigrationSupportLevelUnsupported
}

func (pgLikeToMongoPlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildPGLikeToMongoPlan(ctx.Config, ctx.TableName, ctx.SourceDB, ctx.TargetDB)
}

func (clickHouseToMongoPlanner) Name() string { return "clickhouse-mongo-planner" }

func (clickHouseToMongoPlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	sourceType := resolveMigrationDBType(ctx.Config.SourceConfig)
	targetType := resolveMigrationDBType(ctx.Config.TargetConfig)
	if sourceType == "clickhouse" && targetType == "mongodb" {
		return MigrationSupportLevelFull
	}
	return MigrationSupportLevelUnsupported
}

func (clickHouseToMongoPlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildClickHouseToMongoPlan(ctx.Config, ctx.TableName, ctx.SourceDB, ctx.TargetDB)
}

func (tdengineToMongoPlanner) Name() string { return "tdengine-mongo-planner" }

func (tdengineToMongoPlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	sourceType := resolveMigrationDBType(ctx.Config.SourceConfig)
	targetType := resolveMigrationDBType(ctx.Config.TargetConfig)
	if sourceType == "tdengine" && targetType == "mongodb" {
		return MigrationSupportLevelFull
	}
	return MigrationSupportLevelUnsupported
}

func (tdengineToMongoPlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildTDengineToMongoPlan(ctx.Config, ctx.TableName, ctx.SourceDB, ctx.TargetDB)
}

func (mongoToMySQLPlanner) Name() string { return "mongo-mysql-planner" }

func (mongoToMySQLPlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	sourceType := resolveMigrationDBType(ctx.Config.SourceConfig)
	targetType := resolveMigrationDBType(ctx.Config.TargetConfig)
	if sourceType == "mongodb" && isMySQLLikeWritableTargetType(targetType) {
		return MigrationSupportLevelFull
	}
	return MigrationSupportLevelUnsupported
}

func (mongoToMySQLPlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildMongoToMySQLPlan(ctx.Config, ctx.TableName, ctx.SourceDB, ctx.TargetDB)
}

func (mongoToPGLikePlanner) Name() string { return "mongo-pglike-planner" }

func (mongoToPGLikePlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	sourceType := resolveMigrationDBType(ctx.Config.SourceConfig)
	targetType := resolveMigrationDBType(ctx.Config.TargetConfig)
	if sourceType == "mongodb" && isPGLikeTarget(targetType) {
		return MigrationSupportLevelFull
	}
	return MigrationSupportLevelUnsupported
}

func (mongoToPGLikePlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildMongoToPGLikePlan(ctx.Config, ctx.TableName, ctx.SourceDB, ctx.TargetDB)
}

func (pgLikeToMySQLPlanner) Name() string { return "pglike-mysql-planner" }

func (pgLikeToMySQLPlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	sourceType := resolveMigrationDBType(ctx.Config.SourceConfig)
	targetType := resolveMigrationDBType(ctx.Config.TargetConfig)
	if isPGLikeSource(sourceType) && isMySQLLikeWritableTargetType(targetType) {
		return MigrationSupportLevelFull
	}
	return MigrationSupportLevelUnsupported
}

func (pgLikeToMySQLPlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildPGLikeToMySQLPlan(ctx.Config, ctx.TableName, ctx.SourceDB, ctx.TargetDB)
}

func (mongoToRelationalPlanner) Name() string { return "mongo-relational-inference-planner" }

func (mongoToRelationalPlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	sourceType := resolveMigrationDBType(ctx.Config.SourceConfig)
	targetType := resolveMigrationDBType(ctx.Config.TargetConfig)
	if !shouldUseSchemaInference(sourceType, targetType) {
		return MigrationSupportLevelUnsupported
	}
	return MigrationSupportLevelPlanned
}

func (mongoToRelationalPlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	sourceType := resolveMigrationDBType(ctx.Config.SourceConfig)
	targetType := resolveMigrationDBType(ctx.Config.TargetConfig)
	inference, err := inferSchemaForPair(sourceType, targetType, ctx.TableName)
	if err != nil {
		return SchemaMigrationPlan{}, nil, nil, err
	}
	plan := SchemaMigrationPlan{}
	plan.SourceSchema, plan.SourceTable = normalizeSyncSourceSchemaAndTable(ctx.Config, ctx.TableName)
	plan.TargetSchema, plan.TargetTable = normalizeSyncTargetSchemaAndTable(ctx.Config, ctx.TableName)
	plan.SourceQueryTable = qualifiedNameForQuery(sourceType, plan.SourceSchema, plan.SourceTable, ctx.TableName)
	plan.TargetQueryTable = qualifiedTargetNameForQuery(targetType, plan.TargetSchema, plan.TargetTable)
	plan.PlannedAction = "当前库对已进入迁移内核规划阶段，等待 schema 推断与目标方言生成器落地"
	for _, issue := range inference.Issues {
		msg := strings.TrimSpace(issue.Message)
		if msg == "" {
			continue
		}
		plan.Warnings = append(plan.Warnings, msg)
	}
	plan.Warnings = append(plan.Warnings, fmt.Sprintf("迁移对象=%s，目标类型=%s，当前仅提供规划入口，暂不执行自动建表", inference.Object.Kind, targetType))
	return dedupeSchemaMigrationPlan(plan), nil, nil, nil
}
