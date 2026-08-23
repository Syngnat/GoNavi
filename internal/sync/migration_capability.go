package sync

import "GoNavi-Wails/internal/connection"

// MigrationCapability describes the executable migration contract for a source
// and target connection pair. It is intentionally derived from the same type
// resolver and planner registry used by the migration runtime.
type MigrationCapability struct {
	SourceType             string                `json:"sourceType"`
	TargetType             string                `json:"targetType"`
	SourceModel            MigrationDataModel    `json:"sourceModel"`
	TargetModel            MigrationDataModel    `json:"targetModel"`
	Planner                string                `json:"planner"`
	SupportLevel           MigrationSupportLevel `json:"supportLevel"`
	CanExecute             bool                  `json:"canExecute"`
	SupportsAutoCreate     bool                  `json:"supportsAutoCreate"`
	SupportsAutoAddColumns bool                  `json:"supportsAutoAddColumns"`
	RequiresExistingTarget bool                  `json:"requiresExistingTarget"`
	SupportsMutations      bool                  `json:"supportsMutations"`
}

// ResolveMigrationCapability returns the migration runtime's effective support
// for a connection pair without opening either connection.
func ResolveMigrationCapability(sourceConfig connection.ConnectionConfig, targetConfig connection.ConnectionConfig) MigrationCapability {
	sourceType := resolveMigrationDBType(sourceConfig)
	targetType := resolveMigrationDBType(targetConfig)
	capability := MigrationCapability{
		SourceType:  sourceType,
		TargetType:  targetType,
		SourceModel: classifyMigrationDataModel(sourceType),
		TargetModel: classifyMigrationDataModel(targetType),
		// Most writable targets support the job engine's update/delete semantics.
		// Time-series targets are deliberately narrowed below.
		SupportsMutations: true,
	}
	if targetType == "tdengine" || targetType == "iotdb" {
		capability.SupportsMutations = false
	}
	syncConfig := SyncConfig{
		SourceConfig: sourceConfig,
		TargetConfig: targetConfig,
	}
	if isRedisToMongoKeyspacePair(syncConfig) {
		capability.Planner = "redis-mongo-keyspace-planner"
		capability.SupportLevel = MigrationSupportLevelFull
		capability.CanExecute = true
		capability.SupportsAutoCreate = true
		return capability
	}
	if isMongoToRedisKeyspacePair(syncConfig) {
		capability.Planner = "mongo-redis-keyspace-planner"
		capability.SupportLevel = MigrationSupportLevelFull
		capability.CanExecute = true
		capability.SupportsAutoCreate = true
		return capability
	}
	if !supportsMigrationSourceEndpoint(sourceConfig, sourceType) || !supportsMigrationTargetEndpoint(targetConfig, targetType) {
		capability.SupportLevel = MigrationSupportLevelUnsupported
		capability.RequiresExistingTarget = true
		return capability
	}
	if isOceanBaseOracleSyncConnection(sourceConfig) || isOceanBaseOracleSyncConnection(targetConfig) {
		capability.Planner = "oceanbase-oracle-existing-target"
		capability.SupportLevel = MigrationSupportLevelPartial
		capability.CanExecute = true
		capability.RequiresExistingTarget = true
		return capability
	}

	ctx := MigrationBuildContext{Config: syncConfig}
	planner := resolveMigrationPlanner(ctx)
	if planner == nil {
		capability.SupportLevel = MigrationSupportLevelUnsupported
		capability.RequiresExistingTarget = true
		return capability
	}

	capability.Planner = planner.Name()
	capability.SupportLevel = planner.SupportLevel(ctx)
	capability.CanExecute = capability.SupportLevel == MigrationSupportLevelFull || capability.SupportLevel == MigrationSupportLevelPartial
	capability.SupportsAutoCreate = capability.SupportLevel == MigrationSupportLevelFull
	capability.SupportsAutoAddColumns = capability.CanExecute && (supportsAutoAddColumnsForPair(sourceType, targetType) ||
		capability.Planner == "pglike-mysql-planner")
	capability.RequiresExistingTarget = !capability.SupportsAutoCreate
	return capability
}

// ValidateMigrationCapability rejects normal table migrations that have no
// executable runtime path. Source-query sync has its own target-table contract
// and is deliberately validated by that path instead.
func ValidateMigrationCapability(config SyncConfig) error {
	if hasSourceQuery(config) {
		return nil
	}
	capability := ResolveMigrationCapability(config.SourceConfig, config.TargetConfig)
	if capability.CanExecute {
		return nil
	}
	return syncTextError("data_sync.capability."+string(capability.SupportLevel), map[string]any{
		"sourceType": capability.SourceType,
		"targetType": capability.TargetType,
	})
}

func supportsMigrationSourceEndpoint(config connection.ConnectionConfig, dbType string) bool {
	switch normalizeMigrationDBType(dbType) {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx",
		"postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb",
		"oracle", "sqlserver", "dameng", "sqlite", "duckdb", "iris",
		"clickhouse", "tdengine", "iotdb", "trino", "mongodb":
		return true
	default:
		return normalizeMigrationDBType(config.Type) == "custom"
	}
}

func supportsMigrationTargetEndpoint(config connection.ConnectionConfig, dbType string) bool {
	switch normalizeMigrationDBType(dbType) {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks",
		"postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb",
		"oracle", "sqlserver", "dameng", "sqlite", "duckdb", "iris",
		"clickhouse", "tdengine", "iotdb", "mongodb":
		return true
	default:
		return normalizeMigrationDBType(config.Type) == "custom"
	}
}
