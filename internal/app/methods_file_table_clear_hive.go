package app

import (
	"context"
	"fmt"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func preflightHiveTableClear(ctx context.Context, instance db.Database, config connection.ConnectionConfig, database string, objects []string, mode tableDataClearMode) error {
	if resolveDDLDBType(config) != "hive" {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	provider, ok := instance.(db.HiveTableWriteCapabilityProvider)
	if !ok {
		return fmt.Errorf("Hive table clear requires verified table write capabilities")
	}
	if _, ok := instance.(sqlFileContextStatementExecer); !ok {
		return fmt.Errorf("Hive table clear requires context-aware execution")
	}
	for _, object := range objects {
		if err := ctx.Err(); err != nil {
			return err
		}
		schema, table := normalizeMetadataSchemaAndTable(config, database, object)
		caps, err := provider.HiveTableWriteCapabilities(ctx, quoteTableIdentByType("hive", schema, table))
		if err != nil {
			return fmt.Errorf("inspect Hive table %q before clear: %w", object, err)
		}
		allowed := mode == tableDataClearModeTruncate && caps.Truncate || mode == tableDataClearModeDeleteAll && caps.Delete
		if !allowed {
			return fmt.Errorf("Hive table %q does not support %s: %s", object, mode, caps.Reason)
		}
	}
	return nil
}

func execTableDataClear(ctx context.Context, instance db.Database, config connection.ConnectionConfig, sql string) (int64, error) {
	if resolveDDLDBType(config) != "hive" {
		return instance.Exec(sql)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	execer, ok := instance.(sqlFileContextStatementExecer)
	if !ok {
		return 0, fmt.Errorf("Hive table clear requires context-aware execution")
	}
	return execer.ExecContext(ctx, sql)
}

func tableClearOutcomeUnknown(err error) bool {
	return db.IsWriteOutcomeUnknown(err) || db.IsAmbiguousWriteResponse(err)
}
