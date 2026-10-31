package app

import (
	"bufio"
	"context"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func (a *App) exportSingleTableSQL(ctx context.Context, dbInst db.Database, runConfig connection.ConnectionConfig, dbName, tableName, filename string, options ExportFileOptions, webTarget *webDownloadTarget, reporter *exportProgressReporter) connection.QueryResult {
	reporter.Start(a.appText("data_export.progress.stage.exporting_sql_file", nil))
	target, err := createAtomicExportTarget(filename, webDownloadBudgetForTarget(webTarget))
	if err != nil {
		reporter.Error(0, err.Error())
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer target.abort()

	w := bufio.NewWriterSize(target.file, 1024*1024)

	if err := writeSQLHeader(w, runConfig, dbName); err != nil {
		reporter.Error(0, err.Error())
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	viewLookup, err := listExportViewLookup(ctx, dbInst, runConfig, dbName)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := writeSQLDropIfExistsPreamble(
		w,
		runConfig,
		dbName,
		[]string{tableName},
		viewLookup,
		true,
		options,
	); err != nil {
		reporter.Error(0, err.Error())
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := dumpTableSQL(ctx, w, dbInst, runConfig, dbName, tableName, true, true, viewLookup); err != nil {
		reporter.Error(0, err.Error())
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := writeSQLFooter(w, runConfig); err != nil {
		reporter.Error(0, err.Error())
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	reporter.Finalizing(0)
	if err := w.Flush(); err != nil {
		reporter.Error(0, err.Error())
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := commitCancelableExportTarget(ctx, target); err != nil {
		reporter.Error(0, err.Error())
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	reporter.Done(0)
	maybeReleaseFileTransferMemory("export-table-sql-finished", 0, filename)
	return connection.QueryResult{Success: true, Message: a.appText("file.backend.message.export_completed", nil)}
}
