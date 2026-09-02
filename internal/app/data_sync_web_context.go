package app

import (
	"context"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	syncengine "GoNavi-Wails/internal/sync"
	"GoNavi-Wails/internal/synccdc"
	"GoNavi-Wails/internal/syncjob"
)

func contextQueryFailure(ctx context.Context) connection.QueryResult {
	if ctx == nil || ctx.Err() == nil {
		return connection.QueryResult{}
	}
	return connection.QueryResult{Success: false, Message: ctx.Err().Error()}
}

func (a *App) dataSyncDatabaseListContext(ctx context.Context, connectionID string) connection.QueryResult {
	if result := contextQueryFailure(ctx); result.Message != "" {
		return result
	}
	endpoint, err := a.resolveDataSyncJobEndpoint(connectionID, "", "")
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBGetDatabases(endpoint.Config) })
}

func (a *App) dataSyncObjectListContext(ctx context.Context, connectionID, database, schema string) connection.QueryResult {
	if result := contextQueryFailure(ctx); result.Message != "" {
		return result
	}
	endpoint, err := a.resolveDataSyncJobEndpoint(connectionID, database, schema)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult {
		return session.DBGetTables(endpoint.Config, endpoint.Database)
	})
}

func (a *App) dataSyncFieldListContext(ctx context.Context, connectionID, database, schema, objectName string) connection.QueryResult {
	if result := contextQueryFailure(ctx); result.Message != "" {
		return result
	}
	endpoint, err := a.resolveDataSyncJobEndpoint(connectionID, database, schema)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	objectName = strings.TrimSpace(objectName)
	if objectName == "" {
		return connection.QueryResult{Success: false, Message: "data sync object name is required"}
	}
	qualified := qualifyDataSyncJobObject(schema, objectName)
	return a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult {
		return session.DBGetColumns(endpoint.Config, endpoint.Database, qualified)
	})
}

func (a *App) dataSyncCapabilityResolveContext(ctx context.Context, sourceConnectionID, sourceDatabase, sourceSchema, targetConnectionID, targetDatabase, targetSchema string) connection.QueryResult {
	if result := contextQueryFailure(ctx); result.Message != "" {
		return result
	}
	source, err := a.resolveDataSyncJobEndpoint(sourceConnectionID, sourceDatabase, sourceSchema)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if result := contextQueryFailure(ctx); result.Message != "" {
		return result
	}
	target, err := a.resolveDataSyncJobEndpoint(targetConnectionID, targetDatabase, targetSchema)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if result := contextQueryFailure(ctx); result.Message != "" {
		return result
	}
	return connection.QueryResult{Success: true, Data: syncengine.ResolveMigrationCapability(source.Config, target.Config)}
}

func (a *App) probeDataSyncCDCContext(parent context.Context, config connection.ConnectionConfig, _ string) (synccdc.Capability, error) {
	if parent == nil {
		parent = context.Background()
	}
	adapter, err := a.resolveDataSyncCDCAdapter(config)
	if err != nil {
		return synccdc.Capability{}, err
	}
	ctx, cancel := context.WithTimeout(parent, dataSyncCDCProbeTimeout)
	defer cancel()
	return adapter.Probe(ctx, config)
}

func (a *App) dataSyncCDCProbeContext(ctx context.Context, connectionID, database, schema, mode string) connection.QueryResult {
	if result := contextQueryFailure(ctx); result.Message != "" {
		return result
	}
	endpoint, err := a.resolveDataSyncJobEndpoint(connectionID, database, schema)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	capability, err := a.probeDataSyncCDCContext(ctx, dataSyncCDCProbeConfig(endpoint), mode)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: capability}
}

func (a *App) dataSyncJobPreflightContext(ctx context.Context, definition syncjob.JobDefinition) connection.QueryResult {
	result := a.preflightDataSyncJobContext(ctx, definition, time.Now())
	message := "data sync job preflight passed"
	if !result.Success {
		message = "data sync job preflight is blocked"
	}
	return connection.QueryResult{Success: result.Success, Message: message, Data: publicDataSyncJobPreflight(result)}
}

func (a *App) dataSyncJobListContext(ctx context.Context) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	jobs, err := manager.ListJobs(ctx)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	for index := range jobs {
		jobs[index] = publicDataSyncJobDefinition(jobs[index])
	}
	return connection.QueryResult{Success: true, Data: jobs}
}

func (a *App) dataSyncJobGetContext(ctx context.Context, jobID string) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	job, err := manager.GetJob(ctx, strings.TrimSpace(jobID))
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: publicDataSyncJobDefinition(job)}
}

func (a *App) dataSyncRunGetContext(ctx context.Context, runID string) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	run, err := manager.GetRun(ctx, strings.TrimSpace(runID))
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: publicDataSyncRun(run)}
}

func (a *App) dataSyncRunListContext(ctx context.Context, jobID string, limit int) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	runs, err := manager.ListRuns(ctx, strings.TrimSpace(jobID), limit)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	for index := range runs {
		runs[index] = publicDataSyncRun(runs[index])
	}
	return connection.QueryResult{Success: true, Data: runs}
}

func (a *App) dataSyncRunPageContext(ctx context.Context, jobID string, beforeCreatedAt int64, beforeID string, limit int) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	var cursor *syncjob.RunCursor
	if beforeCreatedAt != 0 || strings.TrimSpace(beforeID) != "" {
		if beforeCreatedAt <= 0 || strings.TrimSpace(beforeID) == "" {
			return connection.QueryResult{Success: false, Message: "data sync run cursor requires createdAt and id"}
		}
		cursor = &syncjob.RunCursor{CreatedAt: beforeCreatedAt, ID: strings.TrimSpace(beforeID)}
	}
	if limit != 10 && limit != 50 && limit != 100 {
		return connection.QueryResult{Success: false, Message: "data sync run page size must be 10, 50, or 100"}
	}
	page, err := manager.ListRunsPage(ctx, strings.TrimSpace(jobID), cursor, limit)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: publicDataSyncRunPage(page)}
}

func (a *App) dataSyncRunEventListContext(ctx context.Context, runID string, afterSequence int64, limit int) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	events, err := manager.ListRunEvents(ctx, strings.TrimSpace(runID), afterSequence, limit)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	for index := range events {
		events[index] = publicDataSyncRunEvent(events[index])
	}
	return connection.QueryResult{Success: true, Data: events}
}

func (a *App) dataSyncErrorRowListContext(ctx context.Context, runID, status string, limit int) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	rows, err := manager.ListErrorRows(ctx, strings.TrimSpace(runID), syncjob.ErrorRowStatus(strings.TrimSpace(status)), limit)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	for index := range rows {
		rows[index] = publicDataSyncErrorRow(rows[index])
	}
	return connection.QueryResult{Success: true, Data: rows}
}

func (a *App) dataSyncErrorRowGetContext(ctx context.Context, errorRowID string) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	row, err := manager.GetErrorRow(ctx, strings.TrimSpace(errorRowID))
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: row}
}

func (a *App) dataSyncCheckpointGetContext(ctx context.Context, jobID string) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	checkpoint, err := manager.GetCheckpoint(ctx, strings.TrimSpace(jobID))
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	checkpoint.SchemaHash = ""
	return connection.QueryResult{Success: true, Data: checkpoint}
}
