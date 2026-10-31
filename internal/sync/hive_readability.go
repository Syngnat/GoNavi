package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"
)

func validateHiveSourceReadability(source, target string, columns []connection.ColumnDefinition) error {
	if normalizeMigrationDBType(source) != "hive" {
		return nil
	}
	for _, column := range columns {
		if err := hivesql.ValidateReadableType(column.Type); err != nil {
			return hiveTypeError(column, source, target, err.Error())
		}
	}
	return nil
}
