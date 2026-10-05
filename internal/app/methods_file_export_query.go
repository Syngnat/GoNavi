package app

import (
	"context"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// ExportData exports provided data to a file
func (a *App) ExportData(data []map[string]interface{}, columns []string, defaultName string, format string) connection.QueryResult {
	return a.ExportDataWithOptions(data, columns, defaultName, ExportFileOptions{Format: format})
}

func (a *App) ExportDataWithOptions(data []map[string]interface{}, columns []string, defaultName string, options ExportFileOptions) (result connection.QueryResult) {
	if defaultName == "" {
		defaultName = "export"
	}
	options = normalizeExportFileOptions("", options)
	if err := validateExportColumnsSelection(options); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if !options.TotalRowsKnown {
		options.TotalRowsKnown = true
		options.TotalRowsHint = int64(len(data))
	}
	format := options.Format
	logger.Infof("ExportData 开始：rows=%d cols=%d format=%s defaultName=%s", len(data), len(columns), strings.ToLower(strings.TrimSpace(format)), strings.TrimSpace(defaultName))
	defaultFilename := fmt.Sprintf("%s.%s", sanitizeExportFileStem(defaultName), strings.ToLower(format))
	filename := ""
	var err error
	var webTarget *webDownloadTarget
	if a.webRuntime {
		webTarget, err = a.newWebDownloadTarget(
			fmt.Sprintf("%s.%s", sanitizeExportFileStem(defaultName), strings.ToLower(format)),
			webDownloadMIMEForFormat(format),
		)
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		filename = webTarget.path
		defer func() { result = webTarget.finish(result) }()
	} else {
		filename, err = a.showSaveFileDialog(runtime.SaveDialogOptions{
			Title:           a.appText("file.backend.dialog.export_data", nil),
			DefaultFilename: defaultFilename,
			Filters:         exportFileDialogFilters(format),
		})
		if err != nil || strings.TrimSpace(filename) == "" {
			logger.Infof("ExportData 已取消或未选择文件：err=%v", err)
			return connection.QueryResult{Success: false, Message: "已取消"}
		}
		filename, err = a.resolveExportDialogTargetPath(filename, format)
		if err != nil {
			logger.Warnf("ExportData 目标文件无效：file=%s err=%v", filename, err)
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}
	logger.Infof("ExportData 选定文件：%s", filename)
	reporterPath := filename
	if webTarget != nil {
		reporterPath = webTarget.metadata.FileName
	}
	reporter := newExportProgressReporter(a, options, defaultName, reporterPath)
	reporter.Start(a.appText("data_export.progress.stage.preparing_export", nil))
	exportCtx, finishExportTask := a.beginCancelableExportTask(options.JobID)
	defer finishExportTask()
	defer func() {
		result = a.classifyExportTaskResult(exportCtx, result)
	}()

	f, atomicTarget, err := openCancelableExportTarget(webTarget, filename)
	if err != nil {
		reporter.Error(0, err.Error())
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer cleanupExportFileTarget(f, atomicTarget)
	writtenRows, err := writeRowsToFileWithReporter(exportCtx, f, data, columns, options, reporter)
	if err != nil {
		logger.Warnf("ExportData 写入失败：file=%s err=%v", filename, err)
		errMsg := a.appText("file.backend.error.write_failed", map[string]any{"detail": err.Error()})
		reporter.Error(writtenRows, errMsg)
		maybeReleaseFileTransferMemory("export-data-error", writtenRows, filename)
		return connection.QueryResult{Success: false, Message: errMsg}
	}
	if err := finishCancelableExportTarget(exportCtx, atomicTarget, f); err != nil {
		logger.Warnf("ExportData 落盘失败：file=%s err=%v", filename, err)
		errMsg := a.appText("file.backend.error.write_failed", map[string]any{"detail": err.Error()})
		reporter.Error(writtenRows, errMsg)
		maybeReleaseFileTransferMemory("export-data-error", writtenRows, filename)
		return connection.QueryResult{Success: false, Message: errMsg}
	}

	logger.Infof("ExportData 完成：file=%s rows=%d", filename, len(data))
	reporter.Done(writtenRows)
	maybeReleaseFileTransferMemory("export-data-finished", writtenRows, filename)
	return connection.QueryResult{Success: true, Message: a.appText("file.backend.message.export_completed", nil)}
}

// ExportQuery exports by executing the provided SELECT query on backend side.
// This avoids frontend IPC payload limits when exporting very large/long-text columns (e.g. base64).
func (a *App) ExportQuery(config connection.ConnectionConfig, dbName string, query string, defaultName string, format string) connection.QueryResult {
	return a.ExportQueryWithOptions(config, dbName, query, defaultName, ExportFileOptions{Format: format})
}

func (a *App) ExportQueryWithOptions(config connection.ConnectionConfig, dbName string, query string, defaultName string, options ExportFileOptions) (result connection.QueryResult) {
	query = strings.TrimSpace(query)
	if query == "" {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.query_required", nil)}
	}

	if defaultName == "" {
		defaultName = "export"
	}
	options = normalizeExportFileOptions("", options)
	if err := validateExportColumnsSelection(options); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	format := options.Format

	defaultFilename := fmt.Sprintf("%s.%s", sanitizeExportFileStem(defaultName), strings.ToLower(format))
	filename := ""
	var err error
	var webTarget *webDownloadTarget
	if a.webRuntime {
		webTarget, err = a.newWebDownloadTarget(
			fmt.Sprintf("%s.%s", sanitizeExportFileStem(defaultName), strings.ToLower(format)),
			webDownloadMIMEForFormat(format),
		)
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		filename = webTarget.path
		defer func() { result = webTarget.finish(result) }()
	} else {
		filename, err = a.showSaveFileDialog(runtime.SaveDialogOptions{
			Title:           a.appText("file.backend.dialog.export_query_result", nil),
			DefaultFilename: defaultFilename,
			Filters:         exportFileDialogFilters(format),
		})
		if err != nil || strings.TrimSpace(filename) == "" {
			logger.Infof("ExportQuery 已取消或未选择文件：err=%v", err)
			return connection.QueryResult{Success: false, Message: "已取消"}
		}
		filename, err = a.resolveExportDialogTargetPath(filename, format)
		if err != nil {
			logger.Warnf("ExportQuery 目标文件无效：file=%s err=%v", filename, err)
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}
	logger.Infof("ExportQuery 开始：type=%s db=%s format=%s file=%s sql=%q", strings.TrimSpace(config.Type), strings.TrimSpace(dbName), strings.ToLower(strings.TrimSpace(format)), filename, sqlSnippet(query))
	reporterPath := filename
	if webTarget != nil {
		reporterPath = webTarget.metadata.FileName
	}
	reporter := newExportProgressReporter(a, options, defaultName, reporterPath)
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
	if format == "sql" {
		options.InsertSQLDialect = resolveDDLDBType(runConfig)
		options.InsertSQLTargetTable = resolveChangeTargetTableName(runConfig, dbName, options.InsertSQLTargetTable)
		if options.InsertSQLTargetTable != "" {
			schemaName, pureTableName := normalizeSchemaAndTable(runConfig, dbName, options.InsertSQLTargetTable)
			if options.InsertSQLDialect == "dameng" {
				schemaName, pureTableName = splitDamengChangeTarget(dbName, options.InsertSQLTargetTable)
			}
			if defs, colErr := dbInst.GetColumns(schemaName, pureTableName); colErr == nil {
				options.InsertSQLColumnTypes = buildImportColumnTypeMap(defs)
				options.InsertSQLTargetColumns = make(map[string]string, len(defs))
				for _, def := range defs {
					if key := normalizeColumnName(def.Name); key != "" {
						options.InsertSQLTargetColumns[key] = strings.TrimSpace(def.Name)
					}
				}
			}
		}
	}

	query = sanitizeSQLForPgLike(resolveDDLDBType(config), query)
	if !looksLikeSelectOrWith(query) {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.select_with_query_required", nil)}
	}

	f, atomicTarget, err := openCancelableExportTarget(webTarget, filename)
	if err != nil {
		reporter.Error(0, err.Error())
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer cleanupExportFileTarget(f, atomicTarget)

	rowCount, columns, err := exportQueryResultToFileWithContext(exportCtx, f, dbInst, runConfig, query, options, reporter)
	if err != nil {
		logger.Warnf("ExportQuery 查询失败：type=%s db=%s err=%v sql=%q", strings.TrimSpace(config.Type), strings.TrimSpace(dbName), err, sqlSnippet(query))
		reporter.Error(rowCount, err.Error())
		maybeReleaseFileTransferMemory("export-query-error", rowCount, filename)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := finishCancelableExportTarget(exportCtx, atomicTarget, f); err != nil {
		logger.Warnf("ExportQuery 落盘失败：file=%s err=%v", filename, err)
		errMsg := a.appText("file.backend.error.write_failed", map[string]any{"detail": err.Error()})
		reporter.Error(rowCount, errMsg)
		maybeReleaseFileTransferMemory("export-query-error", rowCount, filename)
		return connection.QueryResult{Success: false, Message: errMsg}
	}

	logger.Infof("ExportQuery 完成：file=%s rows=%d cols=%d", filename, rowCount, len(columns))
	reporter.Done(rowCount)
	maybeReleaseFileTransferMemory("export-query-finished", rowCount, filename)
	return connection.QueryResult{Success: true, Message: a.appText("file.backend.message.export_completed", nil)}
}

func queryDataForExport(dbInst db.Database, config connection.ConnectionConfig, query string) ([]map[string]interface{}, []string, error) {
	return queryDataForExportWithContext(db.MetadataContext(dbInst), dbInst, config, query)
}

// queryDataForExportWithContext is the buffered export fallback. It retains
// the caller's cancellation signal instead of creating an unrelated
// background deadline, which is required for the headless CLI export path.
func queryDataForExportWithContext(parent context.Context, dbInst db.Database, config connection.ConnectionConfig, query string) ([]map[string]interface{}, []string, error) {
	if parent == nil {
		parent = context.Background()
	}
	timeout := getExportQueryTimeout(config)
	dbType := resolveDDLDBType(config)
	if dbType == "clickhouse" {
		logger.Infof("ClickHouse 导出查询开始：timeout=%s SQL片段=%q", timeout, sqlSnippet(query))
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	if q, ok := dbInst.(interface {
		QueryContext(context.Context, string) ([]map[string]interface{}, []string, error)
	}); ok {
		data, columns, err := q.QueryContext(ctx, query)
		if err == nil && ctx.Err() != nil {
			err = ctx.Err()
		}
		if err != nil && dbType == "clickhouse" {
			logger.Warnf("ClickHouse 导出查询失败：timeout=%s SQL片段=%q err=%v", timeout, sqlSnippet(query), err)
		}
		return data, columns, err
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	data, columns, err := dbInst.Query(query)
	if err == nil && ctx.Err() != nil {
		err = ctx.Err()
	}
	if err != nil && dbType == "clickhouse" {
		logger.Warnf("ClickHouse 导出查询失败（无 QueryContext）：timeout=%s SQL片段=%q err=%v", timeout, sqlSnippet(query), err)
	}
	return data, columns, err
}

func getExportQueryTimeout(config connection.ConnectionConfig) time.Duration {
	if config.QueryTimeout > 0 {
		return time.Duration(config.QueryTimeout) * time.Second
	}
	timeout := time.Duration(config.Timeout) * time.Second
	if timeout <= 0 {
		timeout = minExportQueryTimeout
	}
	if resolveDDLDBType(config) == "clickhouse" {
		if timeout < minClickHouseExportQueryTimeout {
			timeout = minClickHouseExportQueryTimeout
		}
		return timeout
	}
	if timeout < minExportQueryTimeout {
		timeout = minExportQueryTimeout
	}
	return timeout
}
