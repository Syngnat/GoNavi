package sync

import (
	"context"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/hivesql"
)

func validateHiveWatermarkPreflight(ctx context.Context, plan watermarkRuntimePlan, sourceDB, targetDB db.Database) error {
	if !isHiveMigrationPair(plan.sourceType, plan.targetType) {
		return nil
	}
	if err := validateHiveSourceReadability(plan.sourceType, plan.targetType, plan.sourceColumns); err != nil {
		return err
	}
	config := plan.config
	config.Mode = plan.mode
	if plan.targetType == "hive" {
		caps, err := hiveWriteCapabilities(ctx, targetDB, plan.targetQueryTable)
		if err != nil {
			return err
		}
		config.hiveMicrosecondTarget = hiveCapsUseMicroseconds(config.TargetConfig, caps)
	}
	if err := validateHiveTargetMode(ctx, config, targetDB, plan.targetQueryTable, true, TableOptions{Insert: true, Update: plan.mode == "insert_update"}); err != nil {
		return err
	}
	mapped := hiveProjectedColumnDefinitions(config, plan.tableName, plan.sourceColumns, plan.projection)
	if err := validateHivePairTypeSemantics(config, mapped); err != nil {
		return err
	}
	if err := validateHiveMigrationColumns(plan.sourceType, plan.targetType, mapped, plan.targetColumns, false); err != nil {
		return err
	}
	if err := validateHiveWatermarkScalarKeys(plan); err != nil {
		return err
	}
	if err := validateHiveWatermarkProjectionKeys(plan); err != nil {
		return err
	}
	if err := validateHiveLogicalKeyData(ctx, sourceDB, plan.sourceType, plan.sourceQueryTable, plan.sourceColumns, plan.tieColumns, append([]string{plan.watermarkColumn}, plan.tieColumns...)); err != nil {
		return err
	}
	if plan.mode == "insert_update" {
		return validateHiveLogicalKeyData(ctx, targetDB, plan.targetType, plan.targetQueryTable, plan.targetColumns, plan.targetTieColumns, plan.targetTieColumns)
	}
	return nil
}

// Hive does not enforce logical keys. Check both endpoints before the first
// mutation, including non-Hive endpoints when the key was supplied by mapping.
func validateHiveLogicalKeyData(ctx context.Context, database db.Database, dbType, table string, columns []connection.ColumnDefinition, keys, nonNullable []string) error {
	if len(keys) == 0 {
		return fmt.Errorf("hive incremental sync requires a declared stable key")
	}
	quoted := make([]string, len(keys))
	for i, key := range keys {
		quoted[i] = quoteIdentByType(dbType, key)
	}
	query := "SELECT " + strings.Join(quoted, ", ") + " FROM " + quoteQualifiedIdentByType(dbType, table) +
		" GROUP BY " + strings.Join(quoted, ", ") + " HAVING COUNT(*) > 1"
	rows, _, err := querySyncDatabaseContext(ctx, database, hiveBoundedProbeSQL(dbType, query))
	if err != nil {
		return err
	}
	if len(rows) > 0 {
		return fmt.Errorf("sync table %s contains duplicate declared stable keys", table)
	}
	nulls := make([]string, 0, len(nonNullable)*2)
	for _, key := range nonNullable {
		identifier := quoteIdentByType(dbType, key)
		nulls = append(nulls, identifier+" IS NULL")
		column, exists := columnDefinitionFold(columns, key)
		if !exists {
			return fmt.Errorf("stable key column %s is missing", key)
		}
		base := intermediateMySQLTypeBase(strings.ToLower(strings.TrimSpace(column.Type)))
		switch base {
		case "string", "char", "varchar", "text", "nchar", "nvarchar":
			nulls = append(nulls, "LTRIM(RTRIM("+identifier+")) = ''")
		case "binary", "varbinary", "bytea", "blob":
			length := "LENGTH(" + identifier + ")"
			if normalizeMigrationDBType(dbType) == "sqlserver" {
				length = "DATALENGTH(" + identifier + ")"
			}
			nulls = append(nulls, length+" = 0")
		}
	}
	query = "SELECT " + strings.Join(quoted, ", ") + " FROM " + quoteQualifiedIdentByType(dbType, table) + " WHERE " + strings.Join(nulls, " OR ")
	rows, _, err = querySyncDatabaseContext(ctx, database, hiveBoundedProbeSQL(dbType, query))
	if err != nil {
		return err
	}
	if len(rows) > 0 {
		return fmt.Errorf("sync table %s contains NULL/empty watermark or stable keys", table)
	}
	return nil
}

func validateHiveWatermarkScalarKeys(plan watermarkRuntimePlan) error {
	for _, endpoint := range []struct {
		dbType  string
		columns []connection.ColumnDefinition
		keys    []string
	}{
		{plan.sourceType, plan.sourceColumns, append([]string{plan.watermarkColumn}, plan.tieColumns...)},
		{plan.targetType, plan.targetColumns, plan.targetTieColumns},
	} {
		if endpoint.dbType != "hive" {
			continue
		}
		for _, key := range endpoint.keys {
			column, exists := columnDefinitionFold(endpoint.columns, key)
			if !exists {
				return fmt.Errorf("hive cursor key column %s is missing", key)
			}
			typ, err := hivesql.ParseType(column.Type)
			if err != nil {
				return err
			}
			switch typ.Kind {
			case "boolean", "tinyint", "smallint", "int", "bigint", "float", "double", "decimal", "string", "char", "varchar", "binary", "date", "timestamp":
			default:
				return hiveTypeError(column, "hive", "hive", "watermark and logical keys require scalar cursor types")
			}
		}
	}
	return nil
}

func hiveBoundedProbeSQL(dbType, query string) string {
	if normalizeMigrationDBType(dbType) == "sqlserver" {
		return strings.Replace(query, "SELECT ", "SELECT TOP (1) ", 1)
	}
	return query + " LIMIT 1"
}

func validateHiveWatermarkProjectionKeys(plan watermarkRuntimePlan) error {
	mapping, err := explicitSyncMappingForTable(plan.config, plan.tableName)
	if err != nil {
		return nil
	}
	for _, column := range mapping.Columns {
		for _, key := range plan.tieColumns {
			if strings.EqualFold(column.Source, key) && (column.Default != nil || len(column.Transforms) != 0) {
				return fmt.Errorf("hive watermark key %s must be an identity value; transforms/defaults cannot prove global uniqueness", key)
			}
		}
	}
	return nil
}

func hiveProjectedColumnDefinitions(config SyncConfig, table string, columns []connection.ColumnDefinition, projection *CompiledProjection) []connection.ColumnDefinition {
	mappings := config.Mappings
	if hasSourceQuery(config) {
		if mapping, exists, err := sourceQueryMapping(config); err == nil && exists {
			mappings = []SyncObjectMapping{mapping}
		}
	} else if mapping, err := explicitSyncMappingForTable(config, table); err == nil {
		mappings = []SyncObjectMapping{mapping}
	}
	mapped := make([]connection.ColumnDefinition, 0, len(columns))
	for _, column := range columns {
		name, included := projection.TargetColumn(column.Name)
		if !included || name == "" {
			continue
		}
		original := column.Name
		column.Name = name
		for _, mapping := range mappings {
			for _, field := range mapping.Columns {
				if !strings.EqualFold(field.Source, original) || field.Drop {
					continue
				}
				for _, transform := range field.Transforms {
					switch strings.ToLower(transform.Type) {
					case "string", "json":
						column.Type = "string"
						if resolveMigrationDBType(config.SourceConfig) != "hive" {
							column.Type = "text"
						}
					case "int64":
						column.Type = "bigint"
					case "bool":
						column.Type = "boolean"
					case "date":
						column.Type = "date"
					}
				}
			}
		}
		mapped = append(mapped, column)
	}
	return mapped
}
