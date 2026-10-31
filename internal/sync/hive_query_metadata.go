package sync

import (
	"context"
	"errors"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

var errHiveQueryMetadataReady = errors.New("hive sync query metadata is ready")

// A read-only analysis must reject unsafe query types just like execution.
// Stop at metadata rather than buffering the arbitrary SQL result twice.
func validateHiveSourceQuerySchemaContext(ctx context.Context, config SyncConfig, sourceDB db.Database, targetColumns []connection.ColumnDefinition) error {
	if resolveMigrationDBType(config.SourceConfig) != "hive" {
		return nil
	}
	projection, err := projectionForSourceQuery(config)
	if err != nil {
		return err
	}
	_, err = streamHiveSourceQueryRows(ctx, config, sourceDB, 1, func([]map[string]interface{}) error { return nil }, func(columns []connection.ColumnDefinition) error {
		if err := validateHiveQueryColumnTypes(config, "", columns, targetColumns, projection); err != nil {
			return err
		}
		return errHiveQueryMetadataReady
	})
	if errors.Is(err, errHiveQueryMetadataReady) {
		return nil
	}
	return err
}

func countValidatedSourceQueryRows(ctx context.Context, config SyncConfig, sourceDB db.Database, targetColumns []connection.ColumnDefinition) (int, bool, error) {
	if err := validateHiveSourceQuerySchemaContext(ctx, config, sourceDB, targetColumns); err != nil {
		return 0, false, err
	}
	count, counted, err := countSourceQueryRowsForSyncContext(ctx, sourceDB, resolveMigrationDBType(config.SourceConfig), config.SourceQuery)
	if err == nil || resolveMigrationDBType(config.SourceConfig) != "hive" {
		return count, counted, err
	}
	// Hive 1/2 cannot always nest WITH queries in a COUNT subquery. The
	// original query was already proven valid above, so count its stream.
	count = 0
	_, err = streamHiveSourceQueryRows(ctx, config, sourceDB, defaultSyncReadPageSize, func(batch []map[string]interface{}) error { count += len(batch); return nil })
	return count, true, err
}

func queryValidatedSourceQuerySnapshot(ctx context.Context, config SyncConfig, sourceDB db.Database, targetColumns []connection.ColumnDefinition) ([]map[string]interface{}, []string, error) {
	projection, err := projectionForSourceQuery(config)
	if err != nil {
		return nil, nil, err
	}
	return querySyncSourceQueryContext(ctx, config, sourceDB, targetColumns, projection)
}
