package app

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/connection"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func (a *App) ExportDatabaseSQL(config connection.ConnectionConfig, dbName string, includeData bool) connection.QueryResult {
	return a.ExportDatabaseSQLWithOptions(config, dbName, includeData, ExportFileOptions{
		Format:                 "sql",
		IncludeDatabaseContext: true,
	})
}

func (a *App) ExportDatabaseSQLWithOptions(
	config connection.ConnectionConfig,
	dbName string,
	includeData bool,
	options ExportFileOptions,
) (result connection.QueryResult) {
	safeDbName := strings.TrimSpace(dbName)
	if safeDbName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.database_name_required", nil)}
	}
	options = normalizeExportFileOptions("sql", options)

	defaultFilename := buildDatabaseExportDefaultFilename(safeDbName, includeData)
	filename := ""
	var err error
	var webTarget *webDownloadTarget
	if a.webRuntime {
		webTarget, err = a.newWebDownloadTarget(defaultFilename, webDownloadMIMEForFormat("sql"))
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		filename = webTarget.path
		defer func() { result = webTarget.finish(result) }()
	} else {
		filename, err = a.showSaveFileDialog(runtime.SaveDialogOptions{
			Title:           a.appText("file.backend.dialog.export_database_sql", map[string]any{"database": safeDbName}),
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

	exportCtx, finishExportTask := a.beginCancelableExportTask(options.JobID)
	defer finishExportTask()
	defer func() {
		result = a.classifyExportTaskResult(exportCtx, result)
	}()
	return a.exportDatabaseSQLToFile(exportCtx, config, safeDbName, includeData, filename, options, webDownloadBudgetForTarget(webTarget))
}

func (a *App) ExportDatabasesSQLWithOptions(
	config connection.ConnectionConfig,
	dbNames []string,
	includeData bool,
	options ExportFileOptions,
) (result connection.QueryResult) {
	normalizedDbNames := normalizeExportNameList(dbNames)
	if len(normalizedDbNames) == 0 {
		return connection.QueryResult{Success: false, Message: a.appText("sidebar.message.select_database_required", nil)}
	}

	directory := ""
	var err error
	var webTarget *webDownloadTarget
	if a.webRuntime {
		archiveMode := "schema"
		if includeData {
			archiveMode = "backup"
		}
		archiveName := fmt.Sprintf("gonavi_%s_%d-databases.zip", archiveMode, len(normalizedDbNames))
		webTarget, err = a.newWebDownloadTarget(archiveName, webDownloadMIMEForFormat("zip"))
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		directory = filepath.Join(webTarget.dir, "batch")
		if err := os.MkdirAll(directory, 0o700); err != nil {
			webTarget.abort()
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		defer func() { result = webTarget.finish(result) }()
		defer func() {
			if cleanupErr := os.RemoveAll(directory); cleanupErr != nil && result.Success {
				result = connection.QueryResult{Success: false, Message: cleanupErr.Error()}
			}
		}()
	} else {
		directory, err = runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
			Title:            a.appText("file.backend.dialog.select_batch_export_directory", nil),
			DefaultDirectory: normalizeDirectoryDialogPath(""),
		})
		if err != nil || strings.TrimSpace(directory) == "" {
			return connection.QueryResult{Success: false, Message: "已取消"}
		}
	}

	options = normalizeExportFileOptions("sql", options)
	options.TotalRowsHint = int64(len(normalizedDbNames))
	options.TotalRowsKnown = true
	reporterPath := directory
	if webTarget != nil {
		reporterPath = webTarget.metadata.FileName
	}
	reporter := newExportProgressReporter(a, options, a.appText("data_export.workbench.target.batch_databases", map[string]any{"count": len(normalizedDbNames)}), reporterPath)
	if reporter != nil {
		reporter.Start(a.appText("data_export.progress.stage.preparing_batch_databases_export", nil))
	}
	exportCtx, finishExportTask := a.beginCancelableExportTask(options.JobID)
	defer finishExportTask()
	defer func() {
		result = a.classifyExportTaskResult(exportCtx, result)
	}()

	entries := make([]webDownloadZipEntry, 0, len(normalizedDbNames))
	for index, name := range normalizedDbNames {
		if reporter != nil {
			reporter.ForceRunning(int64(index), a.appText("data_export.progress.stage.exporting_item_with_progress", map[string]any{
				"name":    name,
				"current": index + 1,
				"total":   len(normalizedDbNames),
			}))
		}
		entryName := buildDatabaseExportDefaultFilename(name, includeData)
		if webTarget != nil {
			entryName = fmt.Sprintf("%03d-%s", index+1, entryName)
		}
		targetFile := filepath.Join(directory, entryName)
		innerOptions := options
		innerOptions.JobID = ""
		result := a.exportDatabaseSQLToFile(exportCtx, config, name, includeData, targetFile, innerOptions, webDownloadBudgetForTarget(webTarget))
		if !result.Success {
			displayTarget := targetFile
			if webTarget != nil {
				displayTarget = entryName
			}
			result.Message = fmt.Sprintf("%s: %s", displayTarget, result.Message)
			if reporter != nil {
				reporter.Error(int64(index), result.Message)
			}
			return result
		}
		if webTarget != nil {
			entries = append(entries, webDownloadZipEntry{Name: filepath.Base(targetFile), Path: targetFile})
		}
	}
	if webTarget != nil {
		if err := writeWebDownloadZip(webTarget.path, entries, webTarget.budget); err != nil {
			if reporter != nil {
				reporter.Error(int64(len(normalizedDbNames)), err.Error())
			}
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}

	if reporter != nil {
		reporter.Finalizing(int64(len(normalizedDbNames)))
		reporter.Done(int64(len(normalizedDbNames)))
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("file.backend.message.export_completed", nil),
		Data: map[string]interface{}{
			"directoryPath": directory,
			"fileCount":     len(normalizedDbNames),
		},
	}
}

func (a *App) exportDatabaseSQLToFile(
	exportCtx context.Context,
	config connection.ConnectionConfig,
	dbName string,
	includeData bool,
	filename string,
	options ExportFileOptions,
	budgets ...*webTransferBudget,
) connection.QueryResult {
	var budget *webTransferBudget
	if len(budgets) > 0 {
		budget = budgets[0]
	}
	safeDbName := strings.TrimSpace(dbName)
	if safeDbName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.database_name_required", nil)}
	}
	reporter := newExportProgressReporter(a, options, safeDbName, filename)
	if reporter != nil {
		reporter.Start(a.appText("data_export.progress.stage.preparing_export", nil))
	}

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
	objects := buildExportObjectOrder(runConfig, dbName, tables, viewLookup, true)
	if reporter != nil {
		reporter.totalRows = int64(len(objects))
		reporter.totalRowsKnown = true
		reporter.ForceRunning(0, a.appText("data_export.progress.stage.exporting_sql_file", nil))
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

	if err := writeSQLDatabaseExportHeader(w, runConfig, dbName, options.IncludeDatabaseContext); err != nil {
		if reporter != nil {
			reporter.Error(0, err.Error())
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := writeSQLDropIfExistsPreambleWithDatabaseContext(
		w,
		runConfig,
		dbName,
		objects,
		viewLookup,
		true,
		options,
		options.IncludeDatabaseContext,
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
		if err := dumpTableSQLWithDatabaseContext(
			exportCtx,
			w,
			dbInst,
			runConfig,
			dbName,
			objectName,
			true,
			includeData,
			viewLookup,
			options.IncludeDatabaseContext,
		); err != nil {
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
