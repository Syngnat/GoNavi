package app

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"strings"

	"GoNavi-Wails/internal/connection"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func (a *App) ExportTable(config connection.ConnectionConfig, dbName string, tableName string, format string) connection.QueryResult {
	return a.ExportTableWithOptions(config, dbName, tableName, ExportFileOptions{Format: format})
}

func buildExportTableSelectQuery(dbType string, tableName string, columns []string) string {
	selectList := "*"
	if len(columns) > 0 {
		quotedColumns := make([]string, len(columns))
		for index, column := range columns {
			quotedColumns[index] = quoteIdentByType(dbType, column)
		}
		selectList = strings.Join(quotedColumns, ", ")
	}
	return fmt.Sprintf("SELECT %s FROM %s", selectList, quoteQualifiedIdentByType(dbType, tableName))
}

// closeExportFile 在导出成功路径上显式关闭文件并把 Close 错误返回给调用方。
// 写路径上 Close 的错误意味着数据未真正落盘：网络盘回写缓存与磁盘配额耗尽常常直到 close(2)
// 才报 ENOSPC/EIO，此时 Write 已经返回成功。若像读路径那样用 defer 丢弃，用户会拿到被截断的
// 文件却收到“导出成功”，等于静默数据丢失。调用方仍应保留 defer 兜底关闭以覆盖错误路径。
func closeExportFile(f io.Closer) error {
	return f.Close()
}

func (a *App) ExportTableWithOptions(config connection.ConnectionConfig, dbName string, tableName string, options ExportFileOptions) (result connection.QueryResult) {
	options = normalizeExportFileOptions("", options)
	if err := validateExportColumnsSelection(options); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	format := options.Format
	defaultFilename := fmt.Sprintf("%s.%s", sanitizeExportFileStem(tableName), format)
	filename := ""
	var err error
	var webTarget *webDownloadTarget
	if a.webRuntime {
		webTarget, err = a.newWebDownloadTarget(fmt.Sprintf("%s.%s", sanitizeExportFileStem(tableName), format), webDownloadMIMEForFormat(format))
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		filename = webTarget.path
		defer func() { result = webTarget.finish(result) }()
	} else {
		filename, err = a.showSaveFileDialog(runtime.SaveDialogOptions{
			Title:           a.appText("file.backend.dialog.export_table", map[string]any{"table": tableName}),
			DefaultFilename: defaultFilename,
			Filters:         exportFileDialogFilters(format),
		})
		if err != nil || strings.TrimSpace(filename) == "" {
			return connection.QueryResult{Success: false, Message: "已取消"}
		}
		filename, err = a.resolveExportDialogTargetPath(filename, format)
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}

	reporterPath := filename
	if webTarget != nil {
		reporterPath = webTarget.metadata.FileName
	}
	reporter := newExportProgressReporter(a, options, tableName, reporterPath)
	reporter.Start(a.appText("data_export.progress.stage.preparing_export", nil))
	exportCtx, finishExportTask := a.beginCancelableExportTask(options.JobID)
	defer finishExportTask()
	defer func() {
		result = a.classifyExportTaskResult(exportCtx, result)
	}()
	runConfig := normalizeRunConfig(config, dbName)

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		reporter.Error(0, err.Error())
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if format != "sql" && !options.TotalRowsKnown {
		if totalRows, ok := tryResolveExportTableTotalRows(dbInst, runConfig, tableName); ok {
			options.TotalRowsHint = totalRows
			options.TotalRowsKnown = true
			if reporter != nil {
				reporter.totalRows = totalRows
				reporter.totalRowsKnown = true
				reporter.Start(a.appText("data_export.progress.stage.preparing_export", nil))
			}
		}
	}

	if format == "sql" {
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
		viewLookup := listViewNameLookup(dbInst, runConfig, dbName)
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
		if err := dumpTableSQL(exportCtx, w, dbInst, runConfig, dbName, tableName, true, true, viewLookup); err != nil {
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
		if err := commitCancelableExportTarget(exportCtx, target); err != nil {
			reporter.Error(0, err.Error())
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		reporter.Done(0)
		maybeReleaseFileTransferMemory("export-table-sql-finished", 0, filename)
		return connection.QueryResult{Success: true, Message: a.appText("file.backend.message.export_completed", nil)}
	}

	dbType := resolveDDLDBType(config)
	query := buildExportTableSelectQuery(dbType, tableName, options.Columns)

	f, atomicTarget, err := openCancelableExportTarget(webTarget, filename)
	if err != nil {
		reporter.Error(0, err.Error())
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer cleanupExportFileTarget(f, atomicTarget)
	rowCount, _, err := exportQueryResultToFileWithContext(exportCtx, f, dbInst, runConfig, query, options, reporter)
	if err != nil {
		errMsg := a.appText("file.backend.error.write_failed", map[string]any{"detail": err.Error()})
		reporter.Error(rowCount, errMsg)
		maybeReleaseFileTransferMemory("export-table-error", rowCount, filename)
		return connection.QueryResult{Success: false, Message: errMsg}
	}
	if err := finishCancelableExportTarget(exportCtx, atomicTarget, f); err != nil {
		errMsg := a.appText("file.backend.error.write_failed", map[string]any{"detail": err.Error()})
		reporter.Error(rowCount, errMsg)
		maybeReleaseFileTransferMemory("export-table-error", rowCount, filename)
		return connection.QueryResult{Success: false, Message: errMsg}
	}
	reporter.Done(rowCount)
	maybeReleaseFileTransferMemory("export-table-finished", rowCount, filename)

	return connection.QueryResult{Success: true, Message: a.appText("file.backend.message.export_completed", nil)}
}

func (a *App) ExportTablesSQL(config connection.ConnectionConfig, dbName string, tableNames []string, includeData bool) connection.QueryResult {
	return a.ExportTablesSQLWithOptions(config, dbName, tableNames, true, includeData, ExportFileOptions{Format: "sql"})
}

func (a *App) ExportTablesDataSQL(config connection.ConnectionConfig, dbName string, tableNames []string) connection.QueryResult {
	return a.ExportTablesSQLWithOptions(config, dbName, tableNames, false, true, ExportFileOptions{Format: "sql"})
}

func (a *App) ExportTablesSQLWithOptions(
	config connection.ConnectionConfig,
	dbName string,
	tableNames []string,
	includeSchema bool,
	includeData bool,
	options ExportFileOptions,
) (result connection.QueryResult) {
	if !includeSchema && !includeData {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.invalid_export_mode", nil)}
	}

	objects := normalizeExportNameList(tableNames)
	options = normalizeExportFileOptions("sql", options)
	options.TotalRowsHint = int64(len(objects))
	options.TotalRowsKnown = true

	defaultFilename := buildTablesExportDefaultFilename(dbName, objects, includeSchema, includeData)
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
			Title:           a.appText("file.backend.dialog.export_tables_sql", nil),
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
	reporter := newExportProgressReporter(a, options, resolveBatchObjectsTargetNameWithText(dbName, objects, a.appText), reporterPath)
	if reporter != nil {
		reporter.Start(a.appText("data_export.progress.stage.preparing_batch_tables_export", nil))
	}
	exportCtx, finishExportTask := a.beginCancelableExportTask(options.JobID)
	defer finishExportTask()
	defer func() {
		result = a.classifyExportTaskResult(exportCtx, result)
	}()
	return a.exportTablesSQLToFile(exportCtx, config, dbName, objects, includeSchema, includeData, filename, reporter, options, webDownloadBudgetForTarget(webTarget))
}

func (a *App) exportTablesSQL(config connection.ConnectionConfig, dbName string, tableNames []string, includeSchema bool, includeData bool) connection.QueryResult {
	if !includeSchema && !includeData {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.invalid_export_mode", nil)}
	}
	objects := normalizeExportNameList(tableNames)

	filename, err := a.showSaveFileDialog(runtime.SaveDialogOptions{
		Title:           a.appText("file.backend.dialog.export_tables_sql", nil),
		DefaultFilename: buildTablesExportDefaultFilename(dbName, objects, includeSchema, includeData),
		Filters:         exportFileDialogFilters("sql"),
	})
	if err != nil || strings.TrimSpace(filename) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}
	filename, err = a.resolveExportDialogTargetPath(filename, "sql")
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return a.exportTablesSQLToFile(
		context.Background(),
		config,
		dbName,
		objects,
		includeSchema,
		includeData,
		filename,
		nil,
		ExportFileOptions{Format: "sql"},
		nil,
	)
}
