package app

import (
	"bufio"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func (a *App) ExportSchemaSQL(config connection.ConnectionConfig, dbName string, schemaName string, includeData bool) connection.QueryResult {
	return a.ExportSchemaSQLWithOptions(config, dbName, schemaName, includeData, ExportFileOptions{Format: "sql"})
}

func (a *App) ExportSchemaSQLWithOptions(
	config connection.ConnectionConfig,
	dbName string,
	schemaName string,
	includeData bool,
	options ExportFileOptions,
) (result connection.QueryResult) {
	safeDbName := strings.TrimSpace(dbName)
	safeSchemaName := strings.TrimSpace(schemaName)
	if safeDbName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.database_name_required", nil)}
	}
	if safeSchemaName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.schema_name_required", nil)}
	}
	options = normalizeExportFileOptions("sql", options)

	suffix := "schema"
	if includeData {
		suffix = "backup"
	}

	defaultFilename := fmt.Sprintf("%s_%s_%s.sql", safeDbName, safeSchemaName, suffix)
	filename := ""
	var err error
	var webTarget *webDownloadTarget
	if a.webRuntime {
		webTarget, err = a.newWebDownloadTarget(
			fmt.Sprintf("%s_%s_%s.sql", sanitizeExportFileStem(safeDbName), sanitizeExportFileStem(safeSchemaName), suffix),
			webDownloadMIMEForFormat("sql"),
		)
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		filename = webTarget.path
		defer func() { result = webTarget.finish(result) }()
	} else {
		filename, err = a.showSaveFileDialog(runtime.SaveDialogOptions{
			Title:           a.appText("file.backend.dialog.export_database_sql", map[string]any{"database": safeDbName + "." + safeSchemaName}),
			DefaultFilename: defaultFilename,
			Filters:         exportFileDialogFilters("sql"),
		})
		if err != nil || strings.TrimSpace(filename) == "" {
			return connection.QueryResult{Success: false, Message: "已取消"}
		}
		filename, err = a.resolveExportDialogTargetPath(filename, "sql")
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}
	reporterPath := filename
	if webTarget != nil {
		reporterPath = webTarget.metadata.FileName
	}
	reporter := newExportProgressReporter(a, options, safeDbName+"."+safeSchemaName, reporterPath)
	if reporter != nil {
		reporter.Start(a.appText("data_export.progress.stage.preparing_export", nil))
	}
	exportCtx, finishExportTask := a.beginCancelableExportTask(options.JobID)
	defer finishExportTask()
	defer func() {
		result = a.classifyExportTaskResult(exportCtx, result)
	}()

	runConfig := normalizeRunConfig(config, dbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		if reporter != nil {
			reporter.Error(0, err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	tables, err := dbInst.GetTables(dbName)
	if err != nil {
		if reporter != nil {
			reporter.Error(0, err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	viewLookup := listViewNameLookup(dbInst, runConfig, dbName)
	filteredTables := filterExportObjectsBySchema(runConfig, dbName, tables, safeSchemaName)
	filteredViews := filterExportViewLookupBySchema(runConfig, dbName, viewLookup, safeSchemaName)
	objects := buildExportObjectOrder(runConfig, dbName, filteredTables, filteredViews, true)
	if len(objects) == 0 {
		message := a.appText("file.backend.error.schema_export_no_objects", map[string]any{"schema": safeSchemaName})
		if reporter != nil {
			reporter.Error(0, message)
		}
		return connection.QueryResult{Success: false, Message: message}
	}
	if reporter != nil {
		reporter.totalRows = int64(len(objects))
		reporter.totalRowsKnown = true
		reporter.ForceRunning(0, a.appText("data_export.progress.stage.exporting_sql_file", nil))
	}

	target, err := createAtomicExportTarget(filename, webDownloadBudgetForTarget(webTarget))
	if err != nil {
		if reporter != nil {
			reporter.Error(0, err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer target.abort()

	w := bufio.NewWriterSize(target.file, 1024*1024)

	if err := writeSQLSchemaExportHeader(w, runConfig, dbName, safeSchemaName); err != nil {
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
		filteredViews,
		true,
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
		if err := dumpTableSQL(exportCtx, w, dbInst, runConfig, dbName, objectName, true, includeData, filteredViews); err != nil {
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
			"filePath": filename,
		},
	}
}
