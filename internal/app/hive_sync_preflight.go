package app

import (
	"context"
	"errors"
	"strings"

	"GoNavi-Wails/internal/db"
	syncengine "GoNavi-Wails/internal/sync"
	"GoNavi-Wails/internal/syncjob"
)

var errHivePreflightExistenceUnavailable = errors.New("hive table existence verification unavailable")

// preflightHiveSyncMapping checks the actual target storage, not only the
// type-level candidate flag. No DDL/DML runs while preparing a persistent task.
func (a *App) preflightHiveSyncMapping(ctx context.Context, session *metadataSession, definition syncjob.JobDefinition, source, target resolvedDataSyncJobEndpoint, mapping syncjob.TableMapping) []DataSyncJobPreflightIssue {
	if resolveDDLDBType(target.Config) != "hive" || definition.Kind == syncjob.JobKindCompare || strings.EqualFold(definition.Options.Content, "schema") {
		return nil
	}
	mappingID := dataSyncJobMappingKey(mapping)
	failure := func(err error) []DataSyncJobPreflightIssue {
		message := err.Error()
		if errors.Is(err, errHivePreflightExistenceUnavailable) {
			message = a.appText("data_sync.backend.error.hive_capability_required", nil)
		}
		return []DataSyncJobPreflightIssue{preflightIssue("hive_target_capability", DataSyncJobPreflightBlocker, "mappings", message, mappingID)}
	}
	if session == nil {
		return failure(errMetadataSessionUnavailable)
	}
	config, err := buildDataSyncJobEngineConfig(definition, "preflight", source, target, mapping)
	if err != nil {
		return failure(err)
	}
	runConfig := normalizeMetadataRunConfig(target.Config, target.Database)
	if target.DatabasePending {
		runConfig = dataSyncPreflightTargetRunConfig(target)
	}
	// The metadata-session entry point binds its request context to legacy
	// TableExists before dispatch and releases the isolated runtime on close.
	database, err := session.app.getMetadataDatabase(runConfig)
	if err != nil {
		return failure(err)
	}
	if err := inspectHiveSyncTargetMode(ctx, database, config, definition, mapping, target); err != nil {
		return failure(err)
	}
	return nil
}

func inspectHiveSyncTargetMode(ctx context.Context, database db.Database, config syncengine.SyncConfig, definition syncjob.JobDefinition, mapping syncjob.TableMapping, target resolvedDataSyncJobEndpoint) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	checker, ok := database.(db.TableExistsChecker)
	if !ok {
		return errHivePreflightExistenceUnavailable
	}
	table := qualifyDataSyncJobObject(mapping.TargetSchema, mapping.TargetTable)
	schema, name := normalizeMetadataSchemaAndTable(target.Config, target.Database, table)
	exists, err := checker.TableExists(schema, name)
	if err != nil {
		return err
	}
	options := syncengine.TableOptions{
		Insert: true, Update: strings.EqualFold(config.Mode, "insert_update"), Delete: definition.Options.PropagateDeletes,
	}
	queryTable := quoteTableIdentByType("hive", schema, name)
	return syncengine.ValidateHiveSyncTargetContext(ctx, config, database, queryTable, exists, options)
}
