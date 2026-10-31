package sync

import "GoNavi-Wails/internal/hivesql"

func (s *SyncEngine) previewProtectedSourceQuery(config SyncConfig, limit int) (TableDiffPreview, error) {
	if err := validateHiveSourceQuerySQL(config); err != nil {
		return TableDiffPreview{}, err
	}
	return s.previewSourceQuery(config, limit)
}

func validateHiveSourceQuerySQL(config SyncConfig) error {
	if resolveMigrationDBType(config.SourceConfig) != "hive" {
		return nil
	}
	if err := hivesql.ValidateReadOnlySourceQuery(config.SourceQuery); err != nil {
		return syncWrapDetailError("data_sync.backend.error.execute_source_query_failed", err)
	}
	return nil
}
