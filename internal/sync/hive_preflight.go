package sync

import (
	"context"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func syncConfiguredTableOptions(config SyncConfig, table string) TableOptions {
	if options, exists := config.TableOptions[table]; exists {
		return options
	}
	return TableOptions{Insert: true, Update: true}
}

func (s *SyncEngine) buildPreflightMigrationPlan(config SyncConfig, table string, sourceDB, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	plan, source, target, err := buildSchemaMigrationPlan(config, table, sourceDB, targetDB)
	if err != nil {
		return plan, source, target, err
	}
	syncData := !strings.EqualFold(strings.TrimSpace(config.Content), "schema")
	err = validateHiveTablePreflight(s.context(), config, targetDB, table, plan, source, target, syncConfiguredTableOptions(config, table), syncData)
	return plan, source, target, err
}

func hiveWriteCapabilities(ctx context.Context, database db.Database, table string) (db.HiveTableWriteCapabilities, error) {
	provider, ok := database.(db.HiveTableWriteCapabilityProvider)
	if !ok {
		return db.HiveTableWriteCapabilities{}, syncTextError("data_sync.backend.error.hive_capability_required", nil)
	}
	if err := ctx.Err(); err != nil {
		return db.HiveTableWriteCapabilities{}, err
	}
	return provider.HiveTableWriteCapabilities(ctx, table)
}

// ValidateHiveSyncTargetContext checks a connected target's table-level write
// contract without executing DDL/DML. resolvedTargetTable must identify the
// resolved target (schema.table), not the source mapping's object name.
func ValidateHiveSyncTargetContext(ctx context.Context, config SyncConfig, targetDB db.Database, resolvedTargetTable string, targetExists bool, options TableOptions) error {
	if ctx == nil {
		return fmt.Errorf("hive sync target validation requires a context")
	}
	return validateHiveTargetMode(ctx, config, targetDB, resolvedTargetTable, targetExists, options)
}

func validateHiveTargetMode(ctx context.Context, config SyncConfig, database db.Database, table string, exists bool, opts TableOptions) error {
	if resolveMigrationDBType(config.TargetConfig) != "hive" || strings.EqualFold(config.Content, "schema") {
		return nil
	}
	policy, err := normalizeRowErrorPolicy(config.RowErrorPolicy)
	if err != nil {
		return err
	}
	if policy != RowErrorPolicyStop {
		return syncTextError("data_sync.backend.error.hive_non_atomic", nil)
	}
	// Auto-created tables are deliberately non-transactional. insert_update on
	// an absent table is an initial copy, never an implicit ACID creation.
	if !exists {
		return nil
	}
	caps, err := hiveWriteCapabilities(ctx, database, table)
	if err != nil {
		return err
	}
	mode := normalizeSyncMode(config.Mode)
	unsupported := func(operation string) error {
		return syncTextError("data_sync.backend.error.hive_mode_unsupported", map[string]any{"table": table, "operation": operation})
	}
	if opts.Insert && !caps.Insert {
		return unsupported("INSERT")
	}
	if mode == "full_overwrite" && !caps.Truncate && !caps.Delete {
		return unsupported("TRUNCATE / DELETE")
	}
	if mode == "insert_update" {
		if opts.Update && !caps.Update {
			return unsupported("UPDATE")
		}
		if opts.Delete && !caps.Delete {
			return unsupported("DELETE")
		}
	}
	return nil
}

func clearSyncTargetContext(ctx context.Context, database db.Database, targetType, table string) error {
	statement := buildClearTargetTableSQL(targetType, table)
	if normalizeMigrationDBType(targetType) == "hive" {
		caps, err := hiveWriteCapabilities(ctx, database, table)
		if err != nil {
			return err
		}
		switch {
		case caps.Truncate:
			statement = "TRUNCATE TABLE " + quoteQualifiedIdentByType(targetType, table)
		case caps.Delete:
			statement = "DELETE FROM " + quoteQualifiedIdentByType(targetType, table)
		default:
			return syncTextError("data_sync.backend.error.hive_mode_unsupported", map[string]any{"table": table, "operation": "TRUNCATE / DELETE"})
		}
	}
	_, err := execSyncDatabaseContext(ctx, database, statement)
	return err
}

func snapshotTargetApplier(ctx context.Context, config SyncConfig, database db.Database, table string, columns []connection.ColumnDefinition, changes connection.ChangeSet) (db.BatchApplier, error) {
	if resolveMigrationDBType(config.TargetConfig) == "hive" {
		if err := validateHiveInsertRows(columns, changes.Inserts); err != nil {
			return nil, err
		}
		for _, update := range changes.Updates {
			if err := validateHiveTargetRows(columns, []map[string]interface{}{update.Values}, false); err != nil {
				return nil, err
			}
		}
	}
	if err := validateHiveWritePrecision(ctx, config, database, table, columns, changes); err != nil {
		return nil, err
	}
	if len(changes.Inserts)+len(changes.Updates)+len(changes.Deletes) == 0 {
		return nil, nil
	}
	applier, ok := database.(db.BatchApplier)
	if !ok {
		return nil, fmt.Errorf("目标驱动不支持应用数据变更 (ApplyChanges)")
	}
	return applier, nil
}

func validateHiveInsertRows(columns []connection.ColumnDefinition, rows []map[string]interface{}) error {
	return validateHiveTargetRows(columns, rows, true)
}

func validateHiveQueryPreflight(ctx context.Context, config SyncConfig, targetDB db.Database, table string, opts TableOptions) error {
	_, _, _, queryTable := resolveTargetQueryTable(config, table)
	return validateHiveTargetMode(ctx, config, targetDB, queryTable, true, opts)
}

func validateTableComparisonKeys(config SyncConfig, table string, plan SchemaMigrationPlan, columns []connection.ColumnDefinition, opts TableOptions) error {
	if normalizeSyncMode(config.Mode) != "insert_update" || !plan.TargetTableExists || !hasEffectiveSyncDataOperation(config.Mode, opts) {
		return nil
	}
	keys, err := syncKeyColumnsForTable(config, table, columns)
	if err != nil {
		return err
	}
	if len(keys) == 0 && !config.ExistingTargetInsertWithoutKey {
		return fmt.Errorf("表 %s 未找到主键或映射稳定 key，无法执行差异同步", table)
	}
	return nil
}

func validateHiveStableKeyRows(rows []map[string]interface{}, keys []string, side string) error {
	for _, row := range rows {
		for _, key := range keys {
			switch value := row[key].(type) {
			case string:
				if strings.TrimSpace(value) == "" {
					return fmt.Errorf("%s contains an empty stable key (%s)", side, key)
				}
			case []byte:
				if len(value) == 0 {
					return fmt.Errorf("%s contains an empty stable key (%s)", side, key)
				}
			}
		}
	}
	return validateSourceQueryUniqueKeyRows(rows, keys, side)
}

func validateQueryComparisonRows(config SyncConfig, columns []connection.ColumnDefinition, keys []string, sourceRows, targetRows []map[string]interface{}) error {
	if isHiveMigrationPair(resolveMigrationDBType(config.SourceConfig), resolveMigrationDBType(config.TargetConfig)) {
		return validateHiveComparisonRows(config, keys, sourceRows, targetRows, columns)
	}
	if err := validateSourceQueryUniqueKeyRows(sourceRows, keys, "source query result"); err != nil {
		return err
	}
	return validateSourceQueryUniqueKeyRows(targetRows, keys, "target table")
}

func validateHiveComparisonRows(config SyncConfig, keys []string, sourceRows, targetRows []map[string]interface{}, columns []connection.ColumnDefinition) error {
	if !isHiveMigrationPair(resolveMigrationDBType(config.SourceConfig), resolveMigrationDBType(config.TargetConfig)) {
		return nil
	}
	target := resolveMigrationDBType(config.TargetConfig)
	if err := validateHiveTypedKeys(target, columns, keys, sourceRows, "Hive sync source"); err != nil {
		return err
	}
	return validateHiveTypedKeys(target, columns, keys, targetRows, "Hive sync target")
}

func validateHiveTablePreflight(ctx context.Context, config SyncConfig, database db.Database, table string, plan SchemaMigrationPlan, sourceCols, targetCols []connection.ColumnDefinition, opts TableOptions, syncData bool) error {
	if !isHiveMigrationPair(resolveMigrationDBType(config.SourceConfig), resolveMigrationDBType(config.TargetConfig)) {
		return nil
	}
	if err := validateHiveTargetTypeSupport(config.TargetConfig, targetCols, false); err != nil {
		return err
	}
	if syncData && plan.TargetTableExists && resolveMigrationDBType(config.TargetConfig) == "hive" {
		caps, err := hiveWriteCapabilities(ctx, database, plan.TargetQueryTable)
		if err != nil {
			return err
		}
		config.hiveMicrosecondTarget = hiveCapsUseMicroseconds(config.TargetConfig, caps)
	}
	semanticColumns := sourceCols
	if hasExplicitSyncMappings(config) && plan.TargetTableExists {
		projection, err := projectionForSyncTable(config, table)
		if err != nil {
			return err
		}
		mapped := hiveProjectedColumnDefinitions(config, table, sourceCols, projection)
		semanticColumns = mapped
		if err := validateHiveMigrationColumns(resolveMigrationDBType(config.SourceConfig), resolveMigrationDBType(config.TargetConfig), mapped, targetCols, config.AutoAddColumns); err != nil {
			return err
		}
	}
	if err := validateHivePairTypeSemantics(config, semanticColumns); err != nil {
		return err
	}
	if !syncData {
		return nil
	}
	if err := validateHiveSourceReadability(resolveMigrationDBType(config.SourceConfig), resolveMigrationDBType(config.TargetConfig), sourceCols); err != nil {
		return err
	}
	return validateHiveTargetMode(ctx, config, database, plan.TargetQueryTable, plan.TargetTableExists, opts)
}
