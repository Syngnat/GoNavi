package app

import (
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/sync"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// DataSync executes a data synchronization task
func (a *App) DataSync(config sync.SyncConfig) sync.SyncResult {
	jobID := strings.TrimSpace(config.JobID)
	if jobID == "" {
		jobID = fmt.Sprintf("sync-%d", time.Now().UnixNano())
		config.JobID = jobID
	}

	reporter := sync.Reporter{
		OnLog: func(event sync.SyncLogEvent) {
			runtime.EventsEmit(a.ctx, sync.EventSyncLog, event)
		},
		OnProgress: func(event sync.SyncProgressEvent) {
			runtime.EventsEmit(a.ctx, sync.EventSyncProgress, event)
		},
	}

	runtime.EventsEmit(a.ctx, sync.EventSyncStart, map[string]any{
		"jobId": jobID,
		"total": len(config.Tables),
	})

	engine := sync.NewSyncEngine(reporter)
	res := engine.RunSync(config)

	runtime.EventsEmit(a.ctx, sync.EventSyncDone, map[string]any{
		"jobId":  jobID,
		"result": res,
	})

	return res
}

// DataSyncAnalyze analyzes differences between source and target for the given tables (dry-run).
func (a *App) DataSyncAnalyze(config sync.SyncConfig) connection.QueryResult {
	jobID := strings.TrimSpace(config.JobID)
	if jobID == "" {
		jobID = fmt.Sprintf("analyze-%d", time.Now().UnixNano())
		config.JobID = jobID
	}

	reporter := sync.Reporter{
		OnLog: func(event sync.SyncLogEvent) {
			runtime.EventsEmit(a.ctx, sync.EventSyncLog, event)
		},
		OnProgress: func(event sync.SyncProgressEvent) {
			runtime.EventsEmit(a.ctx, sync.EventSyncProgress, event)
		},
	}

	runtime.EventsEmit(a.ctx, sync.EventSyncStart, map[string]any{
		"jobId": jobID,
		"total": len(config.Tables),
		"type":  "analyze",
	})

	engine := sync.NewSyncEngine(reporter)
	res := engine.Analyze(config)

	runtime.EventsEmit(a.ctx, sync.EventSyncDone, map[string]any{
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
	jobID := strings.TrimSpace(config.JobID)
	if jobID == "" {
		jobID = fmt.Sprintf("preview-%d", time.Now().UnixNano())
		config.JobID = jobID
	}

	engine := sync.NewSyncEngine(sync.Reporter{})
	preview, err := engine.Preview(config, tableName, limit)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: "OK", Data: preview}
}
