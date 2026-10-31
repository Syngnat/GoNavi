package sync

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/hivesql"
)

type hiveMigrationPlanner struct{}

func (hiveMigrationPlanner) Name() string { return "hive-table-planner" }

func supportsHiveMigrationPair(source, target string) bool {
	source, target = normalizeMigrationDBType(source), normalizeMigrationDBType(target)
	if target == "hive" {
		return source == "hive" || isCrossDialectAutoCreateSourceType(source) || source == "clickhouse"
	}
	return source == "hive" && isCrossDialectAutoCreateTargetType(target)
}

func (hiveMigrationPlanner) SupportLevel(ctx MigrationBuildContext) MigrationSupportLevel {
	if supportsHiveMigrationPair(resolveMigrationDBType(ctx.Config.SourceConfig), resolveMigrationDBType(ctx.Config.TargetConfig)) {
		return MigrationSupportLevelFull
	}
	return MigrationSupportLevelUnsupported
}

func (hiveMigrationPlanner) BuildPlan(ctx MigrationBuildContext) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	config := ctx.Config
	source, target := resolveMigrationDBType(config.SourceConfig), resolveMigrationDBType(config.TargetConfig)
	plan := SchemaMigrationPlan{}
	plan.SourceSchema, plan.SourceTable = normalizeSyncSourceSchemaAndTable(config, ctx.TableName)
	plan.TargetSchema, plan.TargetTable = normalizeSyncTargetSchemaAndTable(config, ctx.TableName)
	plan.SourceQueryTable = qualifiedNameForQuery(source, plan.SourceSchema, plan.SourceTable, ctx.TableName)
	plan.TargetQueryTable = qualifiedTargetNameForQuery(target, plan.TargetSchema, plan.TargetTable)
	sourceCols, exists, err := inspectTableColumns(ctx.SourceDB, plan.SourceSchema, plan.SourceTable)
	if err != nil {
		return plan, nil, nil, err
	}
	if !exists {
		return plan, nil, nil, syncTextError("data_sync.backend.error.source_table_missing_or_no_columns", map[string]any{"table": ctx.TableName})
	}
	if !strings.EqualFold(strings.TrimSpace(config.Content), "schema") {
		if err := validateHiveSourceReadability(source, target, sourceCols); err != nil {
			return plan, sourceCols, nil, err
		}
	}
	targetCols, exists, err := inspectHiveMigrationTargetColumns(ctx.TargetDB, target, plan.TargetSchema, plan.TargetTable)
	if err != nil {
		return plan, sourceCols, nil, err
	}
	plan.TargetTableExists = exists
	if err := validateHivePairTypeSemantics(config, sourceCols); err != nil {
		return plan, sourceCols, targetCols, err
	}
	if target == "hive" {
		definitions := targetCols
		if !exists {
			definitions, err = hiveMappedTargetDefinitions(source, target, sourceCols)
		}
		if err != nil {
			return plan, sourceCols, targetCols, err
		}
		if err := validateHiveTargetTypeSupport(config.TargetConfig, definitions, !exists); err != nil {
			return plan, sourceCols, targetCols, err
		}
	}
	if target == "hive" {
		plan.Warnings = append(plan.Warnings, localizedSyncBackendText("data_sync.backend.warning.hive_schema_semantics", nil))
	} else {
		for _, col := range sourceCols {
			if isHivePartitionColumn(col) {
				plan.Warnings = append(plan.Warnings, localizedSyncBackendText("data_sync.backend.warning.hive_partition_flattened", nil))
				break
			}
		}
	}
	if exists {
		if err := validateHiveMigrationColumns(source, target, sourceCols, targetCols, config.AutoAddColumns); err != nil {
			return plan, sourceCols, targetCols, err
		}
		if config.AutoAddColumns {
			for _, col := range sourceCols {
				if _, found := columnDefinitionFold(targetCols, col.Name); found {
					continue
				}
				statement, _, err := buildHiveAddColumnSQL(source, target, plan.TargetQueryTable, col)
				if err != nil {
					return plan, sourceCols, targetCols, err
				}
				plan.PreDataSQL = append(plan.PreDataSQL, statement)
			}
		}
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}
	// Validate even an existing-only plan: analysis must not advertise a lossy
	// migration and allow execution to discover it only after target creation.
	createSQL, err := buildHiveCreateTableSQLFor(config.TargetConfig, ctx.TargetDB, source, target, plan.TargetQueryTable, sourceCols)
	if err != nil {
		return plan, sourceCols, targetCols, err
	}
	if normalizeTargetTableStrategy(config.TargetTableStrategy) != "existing_only" {
		plan.AutoCreate = true
		plan.CreateTableSQL = createSQL
		if target == "hive" {
			plan.Warnings = append(plan.Warnings, localizedSyncBackendText("data_sync.backend.warning.hive_rebuild_storage", nil))
		}
	}
	return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
}

// buildHiveCreateTableSQLFor keeps the plain CREATE TABLE contract for callers
// without a live target, and upgrades to Hive 4's managed form when the server
// would otherwise translate the table into a non-truncatable external table.
func buildHiveCreateTableSQLFor(targetConfig connection.ConnectionConfig, database db.Database, source, target, table string, columns []connection.ColumnDefinition) (string, error) {
	statement, err := buildHiveCreateTableSQL(source, target, table, columns)
	if err != nil {
		return "", err
	}
	if target == "hive" && hiveServerSupportsManagedTableDDL(targetConfig, database) {
		statement = strings.Replace(statement, "CREATE TABLE ", "CREATE MANAGED TABLE ", 1)
	}
	return statement, nil
}

func buildHiveCreateTableSQL(source, target, table string, columns []connection.ColumnDefinition) (string, error) {
	ordinary := make([]string, 0, len(columns))
	partitions := make([]string, 0)
	seen := make(map[string]struct{}, len(columns))
	for _, column := range columns {
		name := strings.TrimSpace(column.Name)
		key := strings.ToLower(name)
		if name == "" {
			return "", fmt.Errorf("hive migration column name is empty")
		}
		if _, exists := seen[key]; exists {
			return "", fmt.Errorf("duplicate hive migration column %q", name)
		}
		seen[key] = struct{}{}
		typ, err := mapHiveMigrationType(source, target, column)
		if err != nil {
			return "", err
		}
		definition := quoteIdentByType(target, name) + " " + typ
		if target == "hive" && column.Comment != "" {
			comment, err := hivesql.Value("STRING", column.Comment)
			if err != nil {
				return "", err
			}
			definition += " COMMENT " + comment
		}
		if target == "hive" && source == "hive" && isHivePartitionColumn(column) {
			parsed, err := hivesql.ParseType(typ)
			if err != nil {
				return "", err
			}
			switch parsed.Kind {
			case "boolean", "tinyint", "smallint", "int", "bigint", "float", "double", "decimal", "string", "char", "varchar", "date", "timestamp":
			default:
				return "", hiveTypeError(column, source, target, "partition columns must have supported primitive types")
			}
			partitions = append(partitions, definition)
		} else {
			ordinary = append(ordinary, definition)
		}
	}
	if len(ordinary) == 0 {
		return "", fmt.Errorf("hive migration requires at least one non-partition column")
	}
	statement := "CREATE TABLE " + quoteQualifiedIdentByType(target, table) + " (\n  " + strings.Join(ordinary, ",\n  ") + "\n)"
	if len(partitions) > 0 {
		statement += " PARTITIONED BY (" + strings.Join(partitions, ", ") + ")"
	}
	return statement, nil
}

func buildHiveAddColumnSQL(source, target, table string, column connection.ColumnDefinition) (string, []string, error) {
	if target == "hive" && isHivePartitionColumn(column) {
		return "", nil, syncTextError("data_sync.backend.error.hive_partition_mismatch", map[string]any{"column": column.Name})
	}
	typ, err := mapHiveMigrationType(source, target, column)
	if err != nil {
		return "", nil, err
	}
	prefix := "ALTER TABLE " + quoteQualifiedIdentByType(target, table)
	definition := quoteIdentByType(target, column.Name) + " " + typ
	if target == "hive" {
		return prefix + " ADD COLUMNS (" + definition + ")", nil, nil
	}
	if isOracleLikeTargetType(target) {
		return prefix + " ADD " + definition, nil, nil
	}
	return prefix + " ADD COLUMN " + definition, nil, nil
}

func columnDefinitionFold(columns []connection.ColumnDefinition, name string) (connection.ColumnDefinition, bool) {
	for _, column := range columns {
		if strings.EqualFold(column.Name, name) {
			return column, true
		}
	}
	return connection.ColumnDefinition{}, false
}

func validateHiveMigrationColumns(source, target string, sourceCols, targetCols []connection.ColumnDefinition, allowMissing bool, requirePartitions ...bool) error {
	for _, col := range sourceCols {
		expected, err := mapHiveMigrationType(source, target, col)
		if err != nil {
			return err
		}
		actual, exists := columnDefinitionFold(targetCols, col.Name)
		if !exists {
			if !allowMissing || (target == "hive" && isHivePartitionColumn(col)) {
				return hiveTypeError(col, source, target, "the target is missing this column")
			}
			continue
		}
		if !hiveMigrationTypeCompatible(target, expected, actual.Type) {
			return hiveTypeError(col, source, target, "target type "+actual.Type+" cannot preserve "+expected)
		}
		if (len(requirePartitions) == 0 || requirePartitions[0]) && source == "hive" && target == "hive" && isHivePartitionColumn(col) != isHivePartitionColumn(actual) {
			return syncTextError("data_sync.backend.error.hive_partition_mismatch", map[string]any{"column": col.Name})
		}
	}
	return nil
}

func hiveMigrationTypeCompatible(target, expected, actual string) bool {
	if isMySQLLikeWritableTargetType(target) && strings.EqualFold(strings.TrimSpace(expected), "BOOLEAN") {
		raw := strings.ToLower(strings.ReplaceAll(actual, " ", ""))
		if raw == "tinyint(1)" || raw == "tinyint" || raw == "bool" {
			return true
		}
	}

	if target == "hive" {
		return hiveNativeTypeContains(expected, actual)
	}
	normalize := func(value string) string {
		value = normalizeComparableColumnType(target, value)
		value = strings.ReplaceAll(value, "integer", "int")
		value = strings.ReplaceAll(value, "numeric", "decimal")
		if value == "bool" {
			value = "boolean"
		}
		return value
	}
	return normalize(expected) == normalize(actual)
}

var _ MigrationPlanner = hiveMigrationPlanner{}
