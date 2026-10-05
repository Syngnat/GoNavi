package app

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

func resolveExportColumns(columns []string, data []map[string]interface{}) []string {
	if len(columns) > 0 || len(data) == 0 {
		return columns
	}
	keySet := make(map[string]bool)
	for _, row := range data {
		for key := range row {
			keySet[key] = true
		}
	}
	derived := make([]string, 0, len(keySet))
	for key := range keySet {
		derived = append(derived, key)
	}
	sort.Strings(derived)
	return derived
}

func resolveRequestedExportColumns(columns []string, requested []string) ([]string, error) {
	if len(requested) == 0 {
		return columns, nil
	}
	available := make(map[string]struct{}, len(columns))
	for _, column := range columns {
		available[column] = struct{}{}
	}
	selected := make([]string, 0, len(requested))
	for _, column := range requested {
		if _, exists := available[column]; !exists {
			return nil, fmt.Errorf("requested export column %q was not found in query result", column)
		}
		selected = append(selected, column)
	}
	return selected, nil
}

func newExportFileWriter(f io.Writer, options ExportFileOptions) (exportFileWriter, error) {
	options = normalizeExportFileOptions("", options)
	switch options.Format {
	case "csv":
		return newCSVExportFileWriter(f)
	case "json":
		return newJSONExportFileWriter(f)
	case "md":
		return &markdownExportFileWriter{file: f}, nil
	case "html":
		return newHTMLExportFileWriter(f), nil
	case "xlsx":
		file, ok := f.(xlsxExportOutputFile)
		if !ok {
			return nil, fmt.Errorf("xlsx export requires a seekable file")
		}
		writeOptions := xlsxExportWriteOptions{}
		if managed, ok := f.(*webTransferFile); ok {
			writeOptions.tempDir = filepath.Dir(managed.file.Name())
			writeOptions.budget = managed.budget
		}
		return newXLSXExportFileWriter(file, options.XLSXMaxRowsPerSheet, writeOptions)
	case "sql":
		return newSQLInsertExportFileWriter(f, options)
	default:
		return nil, fmt.Errorf("unsupported format: %s", options.Format)
	}
}

func streamQueryDataForExport(dbInst db.Database, config connection.ConnectionConfig, query string, consumer db.QueryStreamConsumer) error {
	return streamQueryDataForExportWithContext(db.MetadataContext(dbInst), dbInst, config, query, consumer)
}

// streamQueryDataForExportWithContext preserves the existing streaming and
// fallback behavior while allowing headless callers to cancel a live export.
func streamQueryDataForExportWithContext(ctx context.Context, dbInst db.Database, config connection.ConnectionConfig, query string, consumer db.QueryStreamConsumer) error {
	if consumer == nil {
		return fmt.Errorf("export consumer required")
	}
	if ctx == nil {
		ctx = context.Background()
	}

	timeout := getExportQueryTimeout(config)
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	if streamer, ok := dbInst.(db.StreamQueryExecer); ok {
		return streamer.StreamQueryContext(ctx, query, consumer)
	}

	if provider, ok := dbInst.(db.SessionExecerProvider); ok && runtimeSupportsSessionExecer(dbInst) {
		session, err := provider.OpenSessionExecer(ctx)
		if err != nil {
			logger.Warnf("导出流式会话打开失败，回退到缓冲导出：type=%s err=%v", strings.TrimSpace(config.Type), err)
		} else {
			defer session.Close()
			if streamer, ok := session.(db.StreamQueryExecer); ok {
				return streamer.StreamQueryContext(ctx, query, consumer)
			}
		}
	}

	logger.Warnf("导出流式查询不可用，回退到缓冲导出：type=%s", strings.TrimSpace(config.Type))
	data, columns, err := queryDataForExportWithContext(ctx, dbInst, config, query)
	if err != nil {
		return err
	}
	columns = resolveExportColumns(columns, data)
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := consumer.SetColumns(columns); err != nil {
		return err
	}
	for _, row := range data {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := consumer.ConsumeRow(row); err != nil {
			return err
		}
	}
	return nil
}

func exportQueryResultToFile(f io.Writer, dbInst db.Database, config connection.ConnectionConfig, query string, options ExportFileOptions, reporter *exportProgressReporter) (int64, []string, error) {
	return exportQueryResultToFileWithContext(context.Background(), f, dbInst, config, query, options, reporter)
}

func exportQueryResultToFileWithContext(ctx context.Context, f io.Writer, dbInst db.Database, config connection.ConnectionConfig, query string, options ExportFileOptions, reporter *exportProgressReporter) (int64, []string, error) {
	options = normalizeExportFileOptions("", options)
	if err := validateExportColumnsSelection(options); err != nil {
		return 0, nil, err
	}
	writer, err := newExportFileWriter(f, options)
	if err != nil {
		return 0, nil, err
	}

	if reporter != nil {
		reporter.Start(reporter.text("data_export.progress.stage.querying_data", nil))
	}
	var projection *exportColumnProjectionConsumer
	delegate := db.QueryStreamConsumer(writer)
	if len(options.Columns) > 0 {
		projection = &exportColumnProjectionConsumer{
			delegate:         writer,
			requestedColumns: options.Columns,
		}
		delegate = projection
	}
	consumer := &countingExportConsumer{delegate: delegate, reporter: reporter}
	streamErr := streamQueryDataForExportWithContext(ctx, dbInst, config, query, consumer)
	if reporter != nil && streamErr == nil {
		reporter.Finalizing(consumer.rowCount)
	}
	closeErr := writer.Close()
	exportedColumns := consumer.columns
	if projection != nil {
		exportedColumns = projection.columns
	}
	if streamErr != nil {
		return consumer.rowCount, exportedColumns, streamErr
	}
	if closeErr != nil {
		return consumer.rowCount, exportedColumns, closeErr
	}
	return consumer.rowCount, exportedColumns, nil
}

func fillExportRecordFromValues(record []string, values []interface{}, markdown bool) []string {
	if len(record) != len(values) {
		record = make([]string, len(values))
	}
	for i, val := range values {
		record[i] = formatExportRecordValue(val, markdown)
	}
	return record
}

func fillExportRecordFromRow(record []string, row map[string]interface{}, columns []string, markdown bool) []string {
	if len(record) != len(columns) {
		record = make([]string, len(columns))
	}
	for i, col := range columns {
		record[i] = formatExportRecordValue(row[col], markdown)
	}
	return record
}

func formatExportRecordValue(val interface{}, markdown bool) string {
	if val == nil {
		return ""
	}
	text := formatExportCellText(val)
	if markdown {
		text = strings.ReplaceAll(text, "|", "\\|")
		text = strings.ReplaceAll(text, "\n", "<br>")
	}
	return text
}

func writeRowsToFile(f io.Writer, data []map[string]interface{}, columns []string, options ExportFileOptions) error {
	_, err := writeRowsToFileWithReporter(context.Background(), f, data, columns, options, nil)
	return err
}

func writeRowsToFileWithReporter(exportCtx context.Context, f io.Writer, data []map[string]interface{}, columns []string, options ExportFileOptions, reporter *exportProgressReporter) (int64, error) {
	if f == nil {
		return 0, fmt.Errorf("file required")
	}
	if exportCtx == nil {
		exportCtx = context.Background()
	}
	options = normalizeExportFileOptions("", options)
	if err := validateExportColumnsSelection(options); err != nil {
		return 0, err
	}
	columns = resolveExportColumns(columns, data)
	columns, err := resolveRequestedExportColumns(columns, options.Columns)
	if err != nil {
		return 0, err
	}
	writer, err := newExportFileWriter(f, options)
	if err != nil {
		return 0, err
	}
	if err := writer.SetColumns(columns); err != nil {
		_ = writer.Close()
		return 0, err
	}
	if reporter != nil {
		reporter.ForceRunning(0, reporter.text("data_export.progress.stage.writing_file", nil))
	}
	for index, row := range data {
		if err := exportCtx.Err(); err != nil {
			_ = writer.Close()
			return int64(index), err
		}
		if err := writer.ConsumeRow(row); err != nil {
			_ = writer.Close()
			return int64(index), err
		}
		if reporter != nil {
			reporter.Rows(int64(index+1), reporter.text("data_export.progress.stage.writing_file", nil))
		}
	}
	if reporter != nil {
		reporter.Finalizing(int64(len(data)))
	}
	if err := writer.Close(); err != nil {
		return int64(len(data)), err
	}
	return int64(len(data)), nil
}

func formatExportHTMLCell(val interface{}) string {
	text := formatExportCellText(val)
	escaped := html.EscapeString(text)
	escaped = strings.ReplaceAll(escaped, "\r\n", "\n")
	escaped = strings.ReplaceAll(escaped, "\r", "\n")
	return strings.ReplaceAll(escaped, "\n", "<br>")
}

func writeRowsToHTML(f *os.File, data []map[string]interface{}, columns []string) error {
	w := bufio.NewWriterSize(f, 1024*256)

	if _, err := w.WriteString(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GoNavi Export</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f8f9fa;
      --card: #ffffff;
      --line: #dee2e6;
      --text: #212529;
      --muted: #6c757d;
      --hover: #f1f3f5;
      --zebra: #f8f9fa;
      --head: #ffffff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "PingFang SC", "Microsoft YaHei", sans-serif;
      line-height: 1.6;
    }
    .export-wrap {
      max-width: 100%;
      margin: 0 auto;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    .export-head {
      padding: 16px 20px;
      background: var(--head);
      border-bottom: 2px solid var(--line);
    }
    .export-head h1 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      color: var(--text);
    }
    .export-meta {
      margin-top: 6px;
      color: var(--muted);
      font-size: 13px;
    }
    .table-wrap {
      width: 100%;
      overflow: auto;
      padding: 16px;
    }
    table {
      border-collapse: collapse;
      width: auto;
      font-size: 13px;
    }
    thead th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: var(--head);
      text-align: left;
      font-weight: 600;
      white-space: nowrap;
      border-bottom: 2px solid var(--line);
      color: var(--text);
      padding: 12px 16px;
    }
    td {
      padding: 10px 16px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      white-space: pre-wrap;
      word-wrap: break-word;
      overflow-wrap: anywhere;
      max-width: 500px;
      color: var(--text);
    }
    tbody tr:nth-child(even) {
      background: var(--zebra);
    }
    tbody tr:hover {
      background: var(--hover);
    }
    td.empty {
      text-align: center;
      color: var(--muted);
      font-style: italic;
    }
    @media (max-width: 768px) {
      body { padding: 16px; }
      .export-head { padding: 12px 16px; }
      .table-wrap { padding: 12px; }
      th, td { padding: 8px 12px; font-size: 12px; }
    }
    @media print {
      body { background: white; padding: 0; }
      .export-wrap { border: none; }
    }
  </style>
</head>
<body>
  <div class="export-wrap">
    <div class="export-head">
      <h1>GoNavi Data Export</h1>
      <div class="export-meta">`); err != nil {
		return err
	}

	if _, err := fmt.Fprintf(w, "Rows: %d · Columns: %d · Generated: %s", len(data), len(columns), time.Now().Format("2006-01-02 15:04:05")); err != nil {
		return err
	}

	if _, err := w.WriteString(`</div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>`); err != nil {
		return err
	}

	for _, col := range columns {
		if _, err := fmt.Fprintf(w, "<th>%s</th>", html.EscapeString(col)); err != nil {
			return err
		}
	}

	if _, err := w.WriteString(`</tr></thead><tbody>`); err != nil {
		return err
	}

	if len(data) == 0 {
		colspan := len(columns)
		if colspan <= 0 {
			colspan = 1
		}
		if _, err := fmt.Fprintf(w, `<tr><td class="empty" colspan="%d">(0 rows)</td></tr>`, colspan); err != nil {
			return err
		}
	} else {
		for _, rowMap := range data {
			if _, err := w.WriteString("<tr>"); err != nil {
				return err
			}
			for _, col := range columns {
				if _, err := fmt.Fprintf(w, "<td>%s</td>", formatExportHTMLCell(rowMap[col])); err != nil {
					return err
				}
			}
			if _, err := w.WriteString("</tr>"); err != nil {
				return err
			}
		}
	}

	if _, err := w.WriteString(`</tbody></table>
    </div>
  </div>
</body>
</html>`); err != nil {
		return err
	}

	return w.Flush()
}

func formatExportCellText(val interface{}) string {
	if val == nil {
		return ""
	}

	switch v := val.(type) {
	case time.Time:
		return v.Format("2006-01-02 15:04:05")
	case *time.Time:
		if v == nil {
			return ""
		}
		return v.Format("2006-01-02 15:04:05")
	case float32:
		f := float64(v)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return "NULL"
		}
		return strconv.FormatFloat(f, 'f', -1, 32)
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return "NULL"
		}
		return strconv.FormatFloat(v, 'f', -1, 64)
	case json.Number:
		text := strings.TrimSpace(v.String())
		if text == "" {
			return "NULL"
		}
		return text
	case string:
		return normalizeExportTemporalText(v)
	default:
		text := fmt.Sprintf("%v", val)
		return normalizeExportTemporalText(text)
	}
}

func normalizeExportJSONValue(val interface{}) interface{} {
	if val == nil {
		return nil
	}

	switch v := val.(type) {
	case time.Time:
		return v.Format("2006-01-02 15:04:05")
	case *time.Time:
		if v == nil {
			return nil
		}
		return v.Format("2006-01-02 15:04:05")
	case string:
		return normalizeExportTemporalText(v)
	case float32:
		f := float64(v)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return nil
		}
		return json.Number(strconv.FormatFloat(f, 'f', -1, 32))
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return nil
		}
		return json.Number(strconv.FormatFloat(v, 'f', -1, 64))
	case json.Number:
		text := strings.TrimSpace(v.String())
		if text == "" {
			return nil
		}
		return json.Number(text)
	case map[string]interface{}:
		out := make(map[string]interface{}, len(v))
		for key, item := range v {
			out[key] = normalizeExportJSONValue(item)
		}
		return out
	case []interface{}:
		items := make([]interface{}, len(v))
		for i, item := range v {
			items[i] = normalizeExportJSONValue(item)
		}
		return items
	}

	rv := reflect.ValueOf(val)
	switch rv.Kind() {
	case reflect.Pointer, reflect.Interface:
		if rv.IsNil() {
			return nil
		}
		return normalizeExportJSONValue(rv.Elem().Interface())
	case reflect.Map:
		if rv.IsNil() {
			return nil
		}
		out := make(map[string]interface{}, rv.Len())
		iter := rv.MapRange()
		for iter.Next() {
			out[fmt.Sprint(iter.Key().Interface())] = normalizeExportJSONValue(iter.Value().Interface())
		}
		return out
	case reflect.Slice:
		if rv.IsNil() {
			return nil
		}
		if rv.Type().Elem().Kind() == reflect.Uint8 {
			return val
		}
		fallthrough
	case reflect.Array:
		size := rv.Len()
		items := make([]interface{}, size)
		for i := 0; i < size; i++ {
			items[i] = normalizeExportJSONValue(rv.Index(i).Interface())
		}
		return items
	default:
		return val
	}
}

// writeRowsToXlsx 使用 excelize 写入真正的 xlsx 格式文件
func writeRowsToXlsx(filename string, data []map[string]interface{}, columns []string) (err error) {
	file, err := os.Create(filename)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := file.Close(); closeErr != nil && err == nil {
			err = closeErr
		}
	}()

	writer, err := newXLSXExportFileWriter(file, 0)
	if err != nil {
		return err
	}
	if err := writer.SetColumns(columns); err != nil {
		return err
	}
	for _, rowMap := range data {
		if err := writer.ConsumeRow(rowMap); err != nil {
			return err
		}
	}
	return writer.Close()
}
