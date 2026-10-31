package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// Hive's missing table error is structured (42S02/10001), not a stable English
// sentence. Use the driver's metadata existence contract instead of matching it.
func inspectHiveMigrationTargetColumns(database db.Database, targetType, schema, table string) ([]connection.ColumnDefinition, bool, error) {
	if targetType == "hive" {
		if checker, ok := database.(db.TableExistsChecker); ok {
			exists, err := checker.TableExists(schema, table)
			if err != nil || !exists {
				return nil, false, err
			}
			columns, err := database.GetColumns(schema, table)
			return columns, len(columns) > 0, err
		}
	}
	return inspectTableColumns(database, schema, table)
}
