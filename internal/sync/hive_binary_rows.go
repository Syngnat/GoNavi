package sync

import (
	"context"
	"encoding/hex"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func restoreHiveBinaryRows(config SyncConfig, columns []connection.ColumnDefinition, rows []map[string]interface{}) ([]map[string]interface{}, error) {
	if resolveMigrationDBType(config.SourceConfig) != "hive" || resolveMigrationDBType(config.TargetConfig) == "hive" {
		return rows, nil
	}
	for _, column := range columns {
		if !strings.EqualFold(strings.TrimSpace(column.Type), "binary") {
			continue
		}
		for _, row := range rows {
			value, present, ambiguous := lookupProjectionSourceValue(row, column.Name)
			if ambiguous {
				return nil, fmt.Errorf("ambiguous Hive binary column %s", column.Name)
			}
			if !present || value == nil {
				continue
			}
			name := column.Name
			for candidate := range row {
				if strings.EqualFold(candidate, column.Name) {
					name = candidate
					break
				}
			}
			switch raw := value.(type) {
			case []byte:
				row[name] = append([]byte(nil), raw...)
			case string:
				if !strings.HasPrefix(raw, "0x") && !strings.HasPrefix(raw, "0X") {
					return nil, fmt.Errorf("Hive binary column %s lacks a lossless hex representation", column.Name)
				}
				decoded, err := hex.DecodeString(raw[2:])
				if err != nil {
					return nil, fmt.Errorf("Hive binary column %s: %w", column.Name, err)
				}
				row[name] = decoded
			default:
				return nil, fmt.Errorf("unsupported Hive binary representation %T", value)
			}
		}
	}
	return rows, nil
}

func querySyncSourceTableSnapshotContext(ctx context.Context, config SyncConfig, database db.Database, dbType, table string, fields []connection.ColumnDefinition, queries ...string) ([]map[string]interface{}, []string, error) {
	rows, names, err := querySyncTableSnapshotContext(ctx, database, dbType, table, fields, queries...)
	if err != nil {
		return nil, names, err
	}
	rows, err = restoreHiveBinaryRows(config, fields, rows)
	return rows, names, err
}
