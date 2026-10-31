package sync

import (
	"context"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/hivesql"
)

func hiveTargetHasRequiredColumns(columns []connection.ColumnDefinition) bool {
	for _, column := range columns {
		if normalizeColumnNullable(column.Nullable) == "NO" {
			return true
		}
	}
	return false
}

func hiveCapsUseMicroseconds(config connection.ConnectionConfig, caps db.HiveTableWriteCapabilities) bool {
	family := strings.ToLower(caps.Family)
	if family == "" {
		family = hiveSyncFamily(config)
	}
	if family == "spark" {
		return true
	}
	if family != "impala" {
		return false
	}
	if caps.Update || caps.Delete {
		return true
	}
	for key, value := range caps.Properties {
		if strings.Contains(strings.ToLower(key+"="+value), "kudu") {
			return true
		}
	}
	return false
}

func validateHiveTargetRows(columns []connection.ColumnDefinition, rows []map[string]interface{}, complete bool) error {
	for _, row := range rows {
		if complete {
			for _, column := range columns {
				if !isHivePartitionColumn(column) && normalizeColumnNullable(column.Nullable) != "NO" {
					continue
				}
				value, present, ambiguous := lookupProjectionSourceValue(row, column.Name)
				if !present || ambiguous {
					return fmt.Errorf("hive target required/partition column %s is missing or ambiguous", column.Name)
				}
				if value == nil && normalizeColumnNullable(column.Nullable) == "NO" {
					return fmt.Errorf("hive target required column %s is NULL", column.Name)
				}
			}
		}
		seen := make(map[string]struct{}, len(row))
		for name, value := range row {
			key := strings.ToLower(name)
			if _, duplicate := seen[key]; duplicate {
				return fmt.Errorf("hive target row contains ambiguous column %s", name)
			}
			seen[key] = struct{}{}
			column, exists := columnDefinitionFold(columns, name)
			if !exists {
				return fmt.Errorf("hive target column %q is unknown", name)
			}
			if value == nil && normalizeColumnNullable(column.Nullable) == "NO" {
				return fmt.Errorf("hive target required column %s is NULL", name)
			}
			if !complete && isHivePartitionColumn(column) {
				return fmt.Errorf("hive partition column %s cannot be updated", name)
			}
			if _, err := hivesql.Value(column.Type, value); err != nil {
				return fmt.Errorf("hive target column %s: %w", name, err)
			}
		}
	}
	return nil
}

func validateHiveWritePrecision(ctx context.Context, config SyncConfig, database db.Database, table string, columns []connection.ColumnDefinition, changes connection.ChangeSet) error {
	if resolveMigrationDBType(config.TargetConfig) != "hive" {
		return nil
	}
	caps, err := hiveWriteCapabilities(ctx, database, table)
	if err != nil {
		return err
	}
	if !hiveCapsUseMicroseconds(config.TargetConfig, caps) {
		return nil
	}
	rows := append([]map[string]interface{}(nil), changes.Inserts...)
	for _, patch := range changes.Updates {
		rows = append(rows, patch.Values)
	}
	for _, row := range rows {
		for name, value := range row {
			if value == nil {
				continue
			}
			column, found := columnDefinitionFold(columns, name)
			if !found {
				continue
			}
			typ, err := hivesql.ParseType(column.Type)
			if err != nil {
				return err
			}
			if typ.Complex() && strings.Contains(typ.String(), "TIMESTAMP") && !(resolveMigrationDBType(config.SourceConfig) == "hive" && hiveSyncFamily(config.SourceConfig) == "spark") {
				return hiveTypeError(column, resolveMigrationDBType(config.SourceConfig), "hive/"+caps.Family, "nested timestamps require an explicit microsecond-safe scalar projection")
			}
			if typ.Kind != "timestamp" {
				continue
			}
			parsed, err := watermarkTimestampValue(value)
			if err != nil {
				return err
			}
			if parsed.Nanosecond()%1000 != 0 {
				return hiveTypeError(column, resolveMigrationDBType(config.SourceConfig), "hive/"+caps.Family, "target TIMESTAMP preserves only microseconds; explicitly convert source precision")
			}
		}
	}
	return nil
}
