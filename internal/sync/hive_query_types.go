package sync

import (
	"context"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func validateHiveQueryColumnTypes(config SyncConfig, table string, source, target []connection.ColumnDefinition, projection *CompiledProjection) error {
	if err := validateHiveSourceReadability("hive", resolveMigrationDBType(config.TargetConfig), source); err != nil {
		return err
	}
	for _, column := range source {
		if strings.TrimSpace(column.Type) == "" {
			return fmt.Errorf("hive query column %s has no exact type", column.Name)
		}
	}
	if err := projection.ValidateSourceColumns(source); err != nil {
		return err
	}
	mapped := hiveProjectedColumnDefinitions(config, table, source, projection)
	return validateHiveMigrationColumns("hive", resolveMigrationDBType(config.TargetConfig), mapped, target, false, false)
}

func querySyncSourceQueryContext(ctx context.Context, config SyncConfig, sourceDB db.Database, targetColumns []connection.ColumnDefinition, projection *CompiledProjection) ([]map[string]interface{}, []string, error) {
	if resolveMigrationDBType(config.SourceConfig) != "hive" {
		return querySyncDatabaseContext(ctx, sourceDB, strings.TrimSpace(config.SourceQuery))
	}
	var rows []map[string]interface{}
	var definitions []connection.ColumnDefinition
	columns, err := streamHiveSourceQueryRows(ctx, config, sourceDB, defaultSyncReadPageSize, func(batch []map[string]interface{}) error {
		batch, err := restoreHiveBinaryRows(config, definitions, batch)
		if err != nil {
			return err
		}
		rows = append(rows, batch...)
		return nil
	}, func(columns []connection.ColumnDefinition) error {
		definitions = append([]connection.ColumnDefinition(nil), columns...)
		return validateHiveQueryColumnTypes(config, "", columns, targetColumns, projection)
	})
	return rows, columns, err
}
