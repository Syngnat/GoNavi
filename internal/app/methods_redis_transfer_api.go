package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"GoNavi-Wails/internal/connection"

	runtime "GoNavi-Wails/internal/desktop"
)

func (a *App) RedisExportKeys(config connection.ConnectionConfig, options RedisExportKeysOptions) (result connection.QueryResult) {
	config.Type = "redis"
	scope := normalizeRedisExportScope(options.Scope)
	if scope == "selected" && len(normalizeRedisTransferKeys(options.Keys)) == 0 {
		return connection.QueryResult{Success: false, Message: a.appText("redis.backend.error.export_no_keys", nil)}
	}

	defaultName := fmt.Sprintf("redis-db%d-keys.json", config.RedisDB)
	if scope == "selected" {
		defaultName = fmt.Sprintf("redis-db%d-selected-keys.json", config.RedisDB)
	}
	filename := ""
	var err error
	var webTarget *webDownloadTarget
	if a.webRuntime {
		webTarget, err = a.newWebDownloadTarget(defaultName, webDownloadMIMEForFormat("json"))
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		filename = webTarget.path
		defer func() { result = webTarget.finish(result) }()
	} else {
		filename, err = runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
			Title:           a.appText("file.backend.dialog.export_data", nil),
			DefaultFilename: defaultName,
			Filters: []runtime.FileFilter{
				{
					DisplayName: a.appText("file.backend.filter.json_files", nil),
					Pattern:     "*.json",
				},
			},
		})
		if err != nil || strings.TrimSpace(filename) == "" {
			return connection.QueryResult{Success: false, Message: "已取消"}
		}
	}
	filename = normalizeRedisTransferFilename(filename)

	exportCtx, finishExport := a.beginCancelableExportTask(options.JobID)
	defer finishExport()
	defer func() {
		result = a.classifyExportTaskResult(exportCtx, result)
	}()
	targetName := fmt.Sprintf("db%d", config.RedisDB)
	reporter := newExportProgressReporter(a, ExportFileOptions{
		JobID:          options.JobID,
		Format:         "json",
		TotalRowsKnown: false,
	}, targetName, filename)
	scanningStage := a.appText("redis.backend.progress.scanning_keys", nil)
	exportingStage := a.appText("redis.backend.progress.exporting_keys", nil)
	if reporter != nil {
		reporter.Start(scanningStage)
		defer func() {
			if result.Success || exportCtx.Err() != nil {
				return
			}
			reporter.Error(reporter.lastRows, result.Message)
		}()
	}
	if err := exportCtx.Err(); err != nil {
		return a.exportTaskCanceledResult()
	}

	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	payload, err := buildRedisExportPayloadContext(exportCtx, client, config.RedisDB, options, func(current, total int64) {
		if reporter == nil {
			return
		}
		if current == 0 {
			reporter.SetTotal(total, true)
			reporter.ForceRunning(0, exportingStage)
			return
		}
		reporter.Rows(current, exportingStage)
	})
	if err != nil {
		if errors.Is(exportCtx.Err(), context.Canceled) {
			return a.exportTaskCanceledResult()
		}
		if errors.Is(err, errRedisExportNoKeys) {
			return connection.QueryResult{Success: false, Message: a.appText("redis.backend.error.export_no_keys", nil)}
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := exportCtx.Err(); err != nil {
		return a.exportTaskCanceledResult()
	}

	content, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.write_failed", map[string]any{"detail": err.Error()})}
	}
	if reporter != nil {
		reporter.Finalizing(int64(len(payload.Keys)))
	}
	writer, atomicTarget, err := openCancelableExportTarget(webTarget, filename)
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.write_failed", map[string]any{"detail": err.Error()})}
	}
	defer cleanupExportFileTarget(writer, atomicTarget)
	if _, err := writer.Write(content); err != nil {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.write_failed", map[string]any{"detail": err.Error()})}
	}
	if err := finishCancelableExportTarget(exportCtx, atomicTarget, writer); err != nil {
		if errors.Is(exportCtx.Err(), context.Canceled) {
			return a.exportTaskCanceledResult()
		}
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.write_failed", map[string]any{"detail": err.Error()})}
	}
	if reporter != nil {
		reporter.Done(int64(len(payload.Keys)))
	}

	return connection.QueryResult{
		Success: true,
		Message: a.appText("redis.backend.message.export_success", nil),
		Data: map[string]any{
			"exported": len(payload.Keys),
			"file":     filename,
		},
	}
}

func (a *App) openRedisImportTransferFileDialog(dbIndex int) (string, error) {
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: a.appText("file.backend.dialog.import_data", map[string]any{
			"table": fmt.Sprintf("db%d", dbIndex),
		}),
		Filters: []runtime.FileFilter{
			{
				DisplayName: a.appText("file.backend.filter.json_files", nil),
				Pattern:     "*.json",
			},
			{
				DisplayName: a.appText("file.backend.filter.all_files", nil),
				Pattern:     "*",
			},
		},
	})
}

func (a *App) RedisPreviewImportKeys(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "redis"
	selection, err := a.openRedisImportTransferFileDialog(config.RedisDB)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}

	payload, err := readRedisTransferFileFromPath(selection)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, os.ErrPermission) {
			return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.open_file_failed", map[string]any{"detail": err.Error()})}
		}
		var syntaxErr *json.SyntaxError
		if errors.As(err, &syntaxErr) {
			return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_json_parse_failed", map[string]any{"detail": err.Error()})}
		}
		return connection.QueryResult{Success: false, Message: a.appText("redis.backend.error.import_payload_invalid", map[string]any{"detail": err.Error()})}
	}

	return connection.QueryResult{
		Success: true,
		Data:    buildRedisImportPreview(selection, payload),
	}
}

func (a *App) RedisImportKeys(config connection.ConnectionConfig, options RedisImportKeysOptions) connection.QueryResult {
	config.Type = "redis"
	jobID := strings.TrimSpace(options.JobID)
	importCtx := context.Background()
	finishImport := func() {}
	if jobID != "" {
		ctx, cancel := context.WithCancel(context.Background())
		cleanup, registered := a.registerImportTask(jobID, cancel)
		if !registered {
			cancel()
			return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_job_already_running", nil)}
		}
		importCtx = ctx
		finishImport = cleanup
	}
	defer finishImport()

	selection := strings.TrimSpace(options.File)
	var err error
	if selection == "" {
		selection, err = a.openRedisImportTransferFileDialog(config.RedisDB)
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}
	if err := importCtx.Err(); err != nil {
		return a.redisImportCanceledResult(nil)
	}

	payload, err := readRedisTransferFileFromPath(selection)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, os.ErrPermission) {
			return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.open_file_failed", map[string]any{"detail": err.Error()})}
		}
		var syntaxErr *json.SyntaxError
		if errors.As(err, &syntaxErr) {
			return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_json_parse_failed", map[string]any{"detail": err.Error()})}
		}
		return connection.QueryResult{Success: false, Message: a.appText("redis.backend.error.import_payload_invalid", map[string]any{"detail": err.Error()})}
	}
	if err := importCtx.Err(); err != nil {
		return a.redisImportCanceledResult(nil)
	}

	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	importingStage := a.appText("redis.backend.progress.importing_keys", nil)
	result, err := importRedisTransferPayloadContext(
		importCtx,
		client,
		payload,
		options,
		newRedisImportProgressEmitter(a, jobID, importingStage),
	)
	if err != nil {
		if errors.Is(importCtx.Err(), context.Canceled) || errors.Is(err, context.Canceled) {
			return a.redisImportCanceledResult(result)
		}
		if errors.Is(err, errRedisImportNoKeysSelected) {
			return connection.QueryResult{Success: false, Message: a.appText("redis.backend.error.import_no_keys_selected", nil)}
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{
		Success: true,
		Message: a.appText("redis.backend.message.import_success", nil),
		Data: map[string]any{
			"imported": result["imported"],
			"skipped":  result["skipped"],
			"total":    result["total"],
			"file":     selection,
		},
	}
}

func (a *App) redisImportCanceledResult(summary map[string]int) connection.QueryResult {
	imported := summary["imported"]
	skipped := summary["skipped"]
	total := summary["total"]
	return connection.QueryResult{
		Success: false,
		Message: a.appText("redis.backend.message.import_cancelled", map[string]any{
			"imported": imported,
			"skipped":  skipped,
			"total":    total,
		}),
		Data: map[string]any{
			"canceled": true,
			"imported": imported,
			"skipped":  skipped,
			"total":    total,
		},
	}
}
