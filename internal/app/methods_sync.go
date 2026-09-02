package app

import (
	"context"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/sync"
	"GoNavi-Wails/internal/uievents"
)

func ensureDataSyncTargetProtection(config sync.SyncConfig) error {
	content := strings.ToLower(strings.TrimSpace(config.Content))
	strategy := strings.ToLower(strings.TrimSpace(config.TargetTableStrategy))
	touchesStructure := content == "schema" ||
		content == "both" ||
		config.AutoAddColumns ||
		config.CreateIndexes ||
		(strategy != "" && strategy != "existing_only")
	touchesData := content == "" || content == "data" || content == "both"

	if touchesStructure {
		if err := ensureConnectionAllowsStructureEdit(config.TargetConfig, "connection.backend.action.data_sync_structure"); err != nil {
			return err
		}
	}
	if touchesData {
		if err := ensureConnectionAllowsDataEdit(config.TargetConfig, "connection.backend.action.data_sync_write"); err != nil {
			return err
		}
		if err := ensureConnectionAllowsDataImport(config.TargetConfig, "connection.backend.action.data_sync_write"); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) resolveDataSyncConfigSecrets(config sync.SyncConfig) (sync.SyncConfig, error) {
	resolved := config
	sourceConfig, sourceDatabase, err := a.resolveDataSyncEndpointConfig(config.SourceConfig, config.SourceDatabase)
	if err != nil {
		return resolved, fmt.Errorf("%s", a.appText("data_sync.backend.error.restore_source_secret_failed", map[string]any{"detail": err.Error()}))
	}
	targetConfig, targetDatabase, err := a.resolveDataSyncEndpointConfig(config.TargetConfig, config.TargetDatabase)
	if err != nil {
		return resolved, fmt.Errorf("%s", a.appText("data_sync.backend.error.restore_target_secret_failed", map[string]any{"detail": err.Error()}))
	}
	resolved.SourceConfig = sourceConfig
	resolved.TargetConfig = targetConfig
	resolved.SourceDatabase = sourceDatabase
	resolved.TargetDatabase = targetDatabase
	return resolved, nil
}

func (a *App) resolveDataSyncEndpointConfig(raw connection.ConnectionConfig, selectedDatabase string) (connection.ConnectionConfig, string, error) {
	resolved, err := a.resolveConnectionSecrets(raw)
	if err != nil {
		return resolved, selectedDatabase, err
	}

	selected := strings.TrimSpace(selectedDatabase)
	if strings.EqualFold(strings.TrimSpace(raw.Type), "oracle") && strings.TrimSpace(raw.ID) != "" {
		repo := newSavedConnectionRepository(a.configDir, a.secretStore)
		if view, findErr := repo.Find(raw.ID); findErr == nil {
			savedServiceName := strings.TrimSpace(view.Config.Database)
			if savedServiceName != "" {
				incomingDatabase := strings.TrimSpace(raw.Database)
				if selected == "" && incomingDatabase != "" && !strings.EqualFold(incomingDatabase, savedServiceName) {
					selected = incomingDatabase
				}
				resolved.Database = savedServiceName
			}
		}
	}

	effectiveConfig, err := a.resolveCustomClickHouseRuntimeConfig(resolved)
	if err != nil {
		return resolved, selected, err
	}
	return effectiveConfig, selected, nil
}

// DataSyncCapability returns the effective migration support for a connection
// pair without opening either endpoint or mutating application state.
func (a *App) DataSyncCapability(sourceConfig connection.ConnectionConfig, targetConfig connection.ConnectionConfig) sync.MigrationCapability {
	return sync.ResolveMigrationCapability(sourceConfig, targetConfig)
}

// DataSync executes a data synchronization task
func (a *App) DataSync(config sync.SyncConfig) (result sync.SyncResult) {
	return a.dataSyncContext(context.Background(), config)
}

func (a *App) dataSyncContext(ctx context.Context, config sync.SyncConfig) (result sync.SyncResult) {
	if ctx == nil {
		ctx = context.Background()
	}
	auditStartedAt := time.Now()
	defer func() {
		runConfig := normalizeRunConfig(config.TargetConfig, config.TargetDatabase)
		auditMessage := ""
		if !result.Success {
			auditMessage = "data synchronization task failed"
		}
		auditResult := connection.QueryResult{
			Success: result.Success,
			Message: auditMessage,
			Data: map[string]int64{
				"affectedRows": int64(result.RowsInserted + result.RowsUpdated + result.RowsDeleted),
			},
		}
		a.recordSQLAuditQuery(sqlAuditQueryInput{
			Config:         runConfig,
			Database:       config.TargetDatabase,
			DBType:         resolveDDLDBType(runConfig),
			QueryID:        generateQueryID(),
			SQL:            fmt.Sprintf("SYNC DATA TABLES_%d", len(config.Tables)),
			Source:         "sync",
			CommitMode:     "auto",
			Duration:       time.Since(auditStartedAt),
			StatementCount: len(config.Tables),
			Result:         auditResult,
		})
	}()
	if err := ensureDataSyncTargetProtection(config); err != nil {
		return sync.SyncResult{
			Success: false,
			Message: err.Error(),
			Logs:    []string{err.Error()},
		}
	}
	jobID := strings.TrimSpace(config.JobID)
	if jobID == "" {
		jobID = fmt.Sprintf("sync-%d", time.Now().UnixNano())
		config.JobID = jobID
	}

	reporter := sync.Reporter{
		OnLog: func(event sync.SyncLogEvent) {
			uievents.Emit(a.ctx, sync.EventSyncLog, event)
		},
		OnProgress: func(event sync.SyncProgressEvent) {
			uievents.Emit(a.ctx, sync.EventSyncProgress, event)
		},
	}

	uievents.Emit(a.ctx, sync.EventSyncStart, map[string]any{
		"jobId": jobID,
		"total": len(config.Tables),
	})

	resolvedConfig, err := a.resolveDataSyncConfigSecrets(config)
	if err != nil {
		res := sync.SyncResult{
			Success: false,
			Message: err.Error(),
			Logs:    []string{err.Error()},
		}
		uievents.Emit(a.ctx, sync.EventSyncDone, map[string]any{
			"jobId":  jobID,
			"result": res,
		})
		return res
	}

	engine := sync.NewSyncEngine(reporter)
	res := engine.RunSyncContext(ctx, resolvedConfig)

	uievents.Emit(a.ctx, sync.EventSyncDone, map[string]any{
		"jobId":  jobID,
		"result": res,
	})

	return res
}

// DataSyncAnalyze analyzes differences between source and target for the given tables (dry-run).
func (a *App) DataSyncAnalyze(config sync.SyncConfig) connection.QueryResult {
	return a.dataSyncAnalyzeContext(context.Background(), config)
}

func (a *App) dataSyncAnalyzeContext(ctx context.Context, config sync.SyncConfig) connection.QueryResult {
	if ctx == nil {
		ctx = context.Background()
	}
	jobID := strings.TrimSpace(config.JobID)
	if jobID == "" {
		jobID = fmt.Sprintf("analyze-%d", time.Now().UnixNano())
		config.JobID = jobID
	}

	reporter := sync.Reporter{
		OnLog: func(event sync.SyncLogEvent) {
			uievents.Emit(a.ctx, sync.EventSyncLog, event)
		},
		OnProgress: func(event sync.SyncProgressEvent) {
			uievents.Emit(a.ctx, sync.EventSyncProgress, event)
		},
	}

	uievents.Emit(a.ctx, sync.EventSyncStart, map[string]any{
		"jobId": jobID,
		"total": len(config.Tables),
		"type":  "analyze",
	})

	resolvedConfig, err := a.resolveDataSyncConfigSecrets(config)
	if err != nil {
		res := sync.SyncResult{Success: false, Message: err.Error(), Logs: []string{err.Error()}}
		uievents.Emit(a.ctx, sync.EventSyncDone, map[string]any{
			"jobId":  jobID,
			"result": res,
			"type":   "analyze",
		})
		return connection.QueryResult{Success: false, Message: err.Error(), Data: res}
	}

	engine := sync.NewSyncEngine(reporter)
	res := engine.AnalyzeContext(ctx, resolvedConfig)

	uievents.Emit(a.ctx, sync.EventSyncDone, map[string]any{
		"jobId":  jobID,
		"result": res,
		"type":   "analyze",
	})

	if !res.Success {
		return connection.QueryResult{Success: false, Message: res.Message, Data: res}
	}
	return connection.QueryResult{Success: true, Message: res.Message, Data: res}
}

// DataSyncPreview returns a limited preview of diff rows for one table.
func (a *App) DataSyncPreview(config sync.SyncConfig, tableName string, limit int) connection.QueryResult {
	return a.dataSyncPreviewContext(context.Background(), config, tableName, limit)
}

func (a *App) dataSyncPreviewContext(ctx context.Context, config sync.SyncConfig, tableName string, limit int) connection.QueryResult {
	if ctx == nil {
		ctx = context.Background()
	}
	jobID := strings.TrimSpace(config.JobID)
	if jobID == "" {
		jobID = fmt.Sprintf("preview-%d", time.Now().UnixNano())
		config.JobID = jobID
	}

	resolvedConfig, err := a.resolveDataSyncConfigSecrets(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	engine := sync.NewSyncEngine(sync.Reporter{})
	preview, err := engine.PreviewContext(ctx, resolvedConfig, tableName, limit)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("data_sync.backend.result.preview_ready", nil), Data: preview}
}
