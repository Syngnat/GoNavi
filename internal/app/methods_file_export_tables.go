package app

import (
	"bufio"
	"context"

	"GoNavi-Wails/internal/connection"
)

func (a *App) exportTablesSQLToFile(
	exportCtx context.Context,
	config connection.ConnectionConfig,
	dbName string,
	tableNames []string,
	includeSchema bool,
	includeData bool,
	filename string,
	reporter *exportProgressReporter,
	options ExportFileOptions,
	budget *webTransferBudget,
) connection.QueryResult {
	if isPluginExportRequest(options) {
		return a.pluginExportFailure("unsupported_scope")
	}
	if !includeSchema && !includeData {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.invalid_export_mode", nil)}
	}

	runConfig := normalizeRunConfig(config, dbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		if reporter != nil {
			reporter.Error(0, err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	viewLookup, err := listExportViewLookup(exportCtx, dbInst, runConfig, dbName)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	objects := buildExportObjectOrder(runConfig, dbName, normalizeExportNameList(tableNames), viewLookup, false)
	objects, err = prepareHiveExportObjectOrder(exportCtx, dbInst, runConfig, dbName, objects, viewLookup)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	target, err := createAtomicExportTarget(filename, budget)
	if err != nil {
		if reporter != nil {
			reporter.Error(0, err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer target.abort()

	w := bufio.NewWriterSize(target.file, 1024*1024)

	if err := writeSQLHeader(w, runConfig, dbName); err != nil {
		if reporter != nil {
			reporter.Error(0, err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := writeSQLDropIfExistsPreamble(
		w,
		runConfig,
		dbName,
		objects,
		viewLookup,
		includeSchema,
		options,
	); err != nil {
		if reporter != nil {
			reporter.Error(0, err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	for index, objectName := range objects {
		if reporter != nil {
			reporter.ForceRunning(int64(index), a.appText("data_export.progress.stage.exporting_item_with_progress", map[string]any{
				"name":    objectName,
				"current": index + 1,
				"total":   len(objects),
			}))
		}
		if err := dumpTableSQL(exportCtx, w, dbInst, runConfig, dbName, objectName, includeSchema, includeData, viewLookup); err != nil {
			if reporter != nil {
				reporter.Error(int64(index), err.Error())
			}
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}
	if err := writeSQLFooter(w, runConfig); err != nil {
		if reporter != nil {
			reporter.Error(int64(len(objects)), err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if reporter != nil {
		reporter.Finalizing(int64(len(objects)))
	}
	if err := w.Flush(); err != nil {
		if reporter != nil {
			reporter.Error(int64(len(objects)), err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := commitCancelableExportTarget(exportCtx, target); err != nil {
		if reporter != nil {
			reporter.Error(int64(len(objects)), err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if reporter != nil {
		reporter.Done(int64(len(objects)))
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("file.backend.message.export_completed", nil),
		Data: map[string]interface{}{
			"filePath":    filename,
			"objectCount": len(objects),
		},
	}
}
