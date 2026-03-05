package app

import (
	"bufio"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"html"
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
	"GoNavi-Wails/internal/utils"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"github.com/xuri/excelize/v2"
)

const minExportQueryTimeout = 5 * time.Minute
const minClickHouseExportQueryTimeout = 2 * time.Hour

func (a *App) OpenSQLFile() connection.QueryResult {
	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select SQL File",
		Filters: []runtime.FileFilter{
			{
				DisplayName: "SQL Files (*.sql)",
				Pattern:     "*.sql",
			},
			{
				DisplayName: "All Files (*.*)",
				Pattern:     "*.*",
			},
		},
	})

	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if selection == "" {
		return connection.QueryResult{Success: false, Message: "Cancelled"}
	}

	content, err := os.ReadFile(selection)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: string(content)}
}

func (a *App) ImportConfigFile() connection.QueryResult {
	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select Config File",
		Filters: []runtime.FileFilter{
			{
				DisplayName: "JSON Files (*.json)",
				Pattern:     "*.json",
			},
		},
	})

	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if selection == "" {
		return connection.QueryResult{Success: false, Message: "Cancelled"}
	}

	content, err := os.ReadFile(selection)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: string(content)}
}

func (a *App) SelectSSHKeyFile(currentPath string) connection.QueryResult {
	defaultDir := strings.TrimSpace(currentPath)
	if defaultDir == "" {
		if home, err := os.UserHomeDir(); err == nil {
			defaultDir = filepath.Join(home, ".ssh")
		}
	}
	if filepath.Ext(defaultDir) != "" {
		defaultDir = filepath.Dir(defaultDir)
	}
	if defaultDir != "" && !filepath.IsAbs(defaultDir) {
		if abs, err := filepath.Abs(defaultDir); err == nil {
			defaultDir = abs
		}
	}

	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            "选择 SSH 私钥文件",
		DefaultDirectory: defaultDir,
		Filters: []runtime.FileFilter{
			{
				DisplayName: "私钥文件",
				Pattern:     "*.pem;*.key;*.ppk;*id_rsa*",
			},
			{
				DisplayName: "所有文件",
				Pattern:     "*",
			},
		},
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "Cancelled"}
	}
	if abs, err := filepath.Abs(selection); err == nil {
		selection = abs
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"path": selection}}
}

func (a *App) SelectDatabaseFile(currentPath string, driverType string) connection.QueryResult {
	defaultDir := strings.TrimSpace(currentPath)
	if defaultDir == "" {
		if home, err := os.UserHomeDir(); err == nil {
			defaultDir = home
		}
	}
	if filepath.Ext(defaultDir) != "" {
		defaultDir = filepath.Dir(defaultDir)
	}
	if defaultDir != "" && !filepath.IsAbs(defaultDir) {
		if abs, err := filepath.Abs(defaultDir); err == nil {
			defaultDir = abs
		}
	}

	normalizedType := strings.ToLower(strings.TrimSpace(driverType))
	filters := []runtime.FileFilter{
		{
			DisplayName: "数据库文件",
			Pattern:     "*.db;*.sqlite;*.sqlite3;*.db3;*.duckdb;*.ddb",
		},
		{
			DisplayName: "所有文件",
			Pattern:     "*",
		},
	}
	title := "选择数据库文件"
	switch normalizedType {
	case "sqlite":
		title = "选择 SQLite 数据文件"
		filters = []runtime.FileFilter{
			{
				DisplayName: "SQLite 文件",
				Pattern:     "*.db;*.sqlite;*.sqlite3;*.db3",
			},
			{
				DisplayName: "所有文件",
				Pattern:     "*",
			},
		}
	case "duckdb":
		title = "选择 DuckDB 数据文件"
		filters = []runtime.FileFilter{
			{
				DisplayName: "DuckDB 文件",
				Pattern:     "*.duckdb;*.ddb;*.db",
			},
			{
				DisplayName: "所有文件",
				Pattern:     "*",
			},
		}
	}

	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            title,
		DefaultDirectory: defaultDir,
		Filters:          filters,
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "Cancelled"}
	}
	if abs, err := filepath.Abs(selection); err == nil {
		selection = abs
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"path": selection}}
}

// PreviewImportFile 解析导入文件，返回字段列表、总行数、前 5 行预览数据
func (a *App) PreviewImportFile(filePath string) connection.QueryResult {
	if filePath == "" {
		return connection.QueryResult{Success: false, Message: "File path required"}
	}

	rows, columns, err := parseImportFile(filePath)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	totalRows := len(rows)
	previewRows := rows
	if len(rows) > 5 {
		previewRows = rows[:5]
	}

	result := map[string]interface{}{
		"columns":     columns,
		"totalRows":   totalRows,
		"previewRows": previewRows,
		"filePath":    filePath,
	}

	return connection.QueryResult{Success: true, Data: result}
}

func (a *App) ImportData(config connection.ConnectionConfig, dbName, tableName string) connection.QueryResult {
	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: fmt.Sprintf("Import into %s", tableName),
		Filters: []runtime.FileFilter{
			{
				DisplayName: "Data Files",
				Pattern:     "*.csv;*.json;*.xlsx;*.xls",
			},
		},
	})

	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if selection == "" {
		return connection.QueryResult{Success: false, Message: "Cancelled"}
	}

	// 返回文件路径供前端预览
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"filePath": selection}}
}

// parseImportFile 解析导入文件，返回数据行和列名
func parseImportFile(filePath string) ([]map[string]interface{}, []string, error) {
	var rows []map[string]interface{}
	var columns []string
	lower := strings.ToLower(filePath)

	if strings.HasSuffix(lower, ".json") {
		f, err := os.Open(filePath)
		if err != nil {
			return nil, nil, err
		}
		defer f.Close()
		decoder := json.NewDecoder(f)
		if err := decoder.Decode(&rows); err != nil {
			return nil, nil, fmt.Errorf("JSON Parse Error: %w", err)
		}
		if len(rows) > 0 {
			for k := range rows[0] {
				columns = append(columns, k)
			}
		}
	} else if strings.HasSuffix(lower, ".csv") {
		f, err := os.Open(filePath)
		if err != nil {
			return nil, nil, err
		}
		defer f.Close()
		reader := csv.NewReader(f)
		records, err := reader.ReadAll()
		if err != nil {
			return nil, nil, fmt.Errorf("CSV Parse Error: %w", err)
		}
		if len(records) < 2 {
			return nil, nil, fmt.Errorf("CSV empty or missing header")
		}
		columns = records[0]
		for _, record := range records[1:] {
			row := make(map[string]interface{})
			for i, val := range record {
				if i < len(columns) {
					if val == "NULL" {
						row[columns[i]] = nil
					} else {
						row[columns[i]] = val
					}
				}
			}
			rows = append(rows, row)
		}
	} else if strings.HasSuffix(lower, ".xlsx") || strings.HasSuffix(lower, ".xls") {
		xlsx, err := excelize.OpenFile(filePath)
		if err != nil {
			return nil, nil, fmt.Errorf("Excel Parse Error: %w", err)
		}
		defer xlsx.Close()

		sheetName := xlsx.GetSheetName(0)
		if sheetName == "" {
			return nil, nil, fmt.Errorf("Excel file has no sheets")
		}

		xlRows, err := xlsx.GetRows(sheetName)
		if err != nil {
			return nil, nil, fmt.Errorf("Excel Read Error: %w", err)
		}
		if len(xlRows) < 2 {
			return nil, nil, fmt.Errorf("Excel empty or missing header")
		}

		columns = xlRows[0]
		for _, record := range xlRows[1:] {
			row := make(map[string]interface{})
			for i, val := range record {
				if i < len(columns) && columns[i] != "" {
					if val == "NULL" {
						row[columns[i]] = nil
					} else {
						row[columns[i]] = val
					}
				}
			}
			if len(row) > 0 {
				rows = append(rows, row)
			}
		}
	} else {
		return nil, nil, fmt.Errorf("Unsupported file format")
	}

	return rows, columns, nil
}

func normalizeColumnName(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}

func buildImportColumnTypeMap(defs []connection.ColumnDefinition) map[string]string {
	result := make(map[string]string, len(defs))
	for _, def := range defs {
		key := normalizeColumnName(def.Name)
		if key == "" {
			continue
		}
		result[key] = strings.TrimSpace(def.Type)
	}
	return result
}

func isTimezoneAwareColumnType(columnType string) bool {
	typ := strings.ToLower(strings.TrimSpace(columnType))
	if typ == "" {
		return false
	}
	return strings.Contains(typ, "with time zone") ||
		strings.Contains(typ, "with timezone") ||
		strings.Contains(typ, "datetimeoffset") ||
		strings.Contains(typ, "timestamptz")
}

func isDateTimeColumnType(columnType string) bool {
	typ := strings.ToLower(strings.TrimSpace(columnType))
	if typ == "" {
		return false
	}
	return strings.Contains(typ, "datetime") || strings.Contains(typ, "timestamp")
}

func isTimeOnlyColumnType(columnType string) bool {
	typ := strings.ToLower(strings.TrimSpace(columnType))
	if typ == "" {
		return false
	}
	if strings.Contains(typ, "datetime") || strings.Contains(typ, "timestamp") {
		return false
	}
	return strings.Contains(typ, "time")
}

func isDateOnlyColumnType(dbType, columnType string) bool {
	typ := strings.ToLower(strings.TrimSpace(columnType))
	if typ == "" {
		return false
	}
	if strings.Contains(typ, "datetime") || strings.Contains(typ, "timestamp") || strings.Contains(typ, "time") {
		return false
	}
	if !strings.Contains(typ, "date") {
		return false
	}
	db := strings.ToLower(strings.TrimSpace(dbType))
	// Oracle/Dameng 的 DATE 带时间语义，不能按纯日期裁剪。
	return db != "oracle" && db != "dameng"
}

func isTemporalColumnType(dbType, columnType string) bool {
	return isDateTimeColumnType(columnType) || isTimeOnlyColumnType(columnType) || isDateOnlyColumnType(dbType, columnType)
}

func parseTemporalString(raw string) (time.Time, bool) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return time.Time{}, false
	}

	layouts := []string{
		"2006-01-02 15:04:05.999999999 -0700 MST",
		"2006-01-02 15:04:05 -0700 MST",
		"2006-01-02 15:04:05.999999999 -0700",
		"2006-01-02 15:04:05 -0700",
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02 15:04:05.999999999",
		"2006-01-02 15:04:05",
		"2006-01-02",
		"15:04:05.999999999",
		"15:04:05",
	}

	for _, layout := range layouts {
		parsed, err := time.Parse(layout, text)
		if err == nil {
			return parsed, true
		}
	}

	return time.Time{}, false
}

func normalizeImportTemporalValue(dbType, columnType, raw string) string {
	text := strings.TrimSpace(raw)
	if text == "" {
		return text
	}

	parsed, ok := parseTemporalString(text)
	if !ok {
		if isDateTimeColumnType(columnType) {
			candidate := strings.ReplaceAll(text, "T", " ")
			if len(candidate) >= 19 {
				prefix := candidate[:19]
				if _, err := time.Parse("2006-01-02 15:04:05", prefix); err == nil {
					return prefix
				}
			}
		}
		return text
	}

	if isTimeOnlyColumnType(columnType) {
		return parsed.Format("15:04:05")
	}
	if isDateOnlyColumnType(dbType, columnType) {
		return parsed.Format("2006-01-02")
	}
	if isTimezoneAwareColumnType(columnType) {
		return parsed.Format("2006-01-02 15:04:05-07:00")
	}
	return parsed.Format("2006-01-02 15:04:05")
}

func formatImportSQLValue(dbType, columnType string, value interface{}) string {
	if value == nil {
		return "NULL"
	}

	if isTemporalColumnType(dbType, columnType) {
		normalized := normalizeImportTemporalValue(dbType, columnType, fmt.Sprintf("%v", value))
		escaped := strings.ReplaceAll(normalized, "'", "''")
		return "'" + escaped + "'"
	}

	return formatSQLValue(dbType, value)
}

// ImportDataWithProgress 执行导入并发送进度事件
func (a *App) ImportDataWithProgress(config connection.ConnectionConfig, dbName, tableName, filePath string) connection.QueryResult {
	rows, columns, err := parseImportFile(filePath)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if len(rows) == 0 {
		return connection.QueryResult{Success: true, Message: "No data to import"}
	}

	runConfig := normalizeRunConfig(config, dbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	schemaName, pureTableName := normalizeSchemaAndTable(config, dbName, tableName)
	columnTypeMap := map[string]string{}
	if defs, colErr := dbInst.GetColumns(schemaName, pureTableName); colErr == nil {
		columnTypeMap = buildImportColumnTypeMap(defs)
	}

	totalRows := len(rows)
	successCount := 0
	var errorLogs []string

	quotedCols := make([]string, len(columns))
	for i, c := range columns {
		quotedCols[i] = quoteIdentByType(runConfig.Type, c)
	}

	for idx, row := range rows {
		var values []string
		for _, col := range columns {
			val := row[col]
			colType := columnTypeMap[normalizeColumnName(col)]
			values = append(values, formatImportSQLValue(runConfig.Type, colType, val))
		}

		query := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)",
			quoteQualifiedIdentByType(runConfig.Type, tableName),
			strings.Join(quotedCols, ", "),
			strings.Join(values, ", "))

		_, err := dbInst.Exec(query)
		if err != nil {
			errorLogs = append(errorLogs, fmt.Sprintf("Row %d: %s", idx+1, err.Error()))
		} else {
			successCount++
		}

		// 每 10 行发送一次进度事件
		if (idx+1)%10 == 0 || idx == totalRows-1 {
			runtime.EventsEmit(a.ctx, "import:progress", map[string]interface{}{
				"current": idx + 1,
				"total":   totalRows,
				"success": successCount,
				"errors":  len(errorLogs),
			})
		}
	}

	result := map[string]interface{}{
		"success":      successCount,
		"failed":       len(errorLogs),
		"total":        totalRows,
		"errorLogs":    errorLogs,
		"errorSummary": fmt.Sprintf("Imported: %d, Failed: %d", successCount, len(errorLogs)),
	}

	return connection.QueryResult{Success: true, Data: result, Message: fmt.Sprintf("Imported: %d, Failed: %d", successCount, len(errorLogs))}
}

func (a *App) ApplyChanges(config connection.ConnectionConfig, dbName, tableName string, changes connection.ChangeSet) connection.QueryResult {
	runConfig := normalizeRunConfig(config, dbName)

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if applier, ok := dbInst.(db.BatchApplier); ok {
		err := applier.ApplyChanges(tableName, changes)
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		return connection.QueryResult{Success: true, Message: "事务提交成功"}
	}

	return connection.QueryResult{Success: false, Message: "当前数据库类型不支持批量提交"}
}

func (a *App) ExportTable(config connection.ConnectionConfig, dbName string, tableName string, format string) connection.QueryResult {
	filename, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           fmt.Sprintf("Export %s", tableName),
		DefaultFilename: fmt.Sprintf("%s.%s", tableName, format),
	})

	if err != nil || filename == "" {
		return connection.QueryResult{Success: false, Message: "Cancelled"}
	}

	runConfig := normalizeRunConfig(config, dbName)

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	format = strings.ToLower(format)
	if format == "sql" {
		f, err := os.Create(filename)
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		defer f.Close()

		w := bufio.NewWriterSize(f, 1024*1024)
		defer w.Flush()

		if err := writeSQLHeader(w, runConfig, dbName); err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		viewLookup := listViewNameLookup(dbInst, runConfig, dbName)
		if err := dumpTableSQL(w, dbInst, runConfig, dbName, tableName, true, true, viewLookup); err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		if err := writeSQLFooter(w, runConfig); err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}

		return connection.QueryResult{Success: true, Message: "Export successful"}
	}

	query := fmt.Sprintf("SELECT * FROM %s", quoteQualifiedIdentByType(runConfig.Type, tableName))

	data, columns, err := queryDataForExport(dbInst, runConfig, query)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	f, err := os.Create(filename)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer f.Close()
	if err := writeRowsToFile(f, data, columns, format); err != nil {
		return connection.QueryResult{Success: false, Message: "Write error: " + err.Error()}
	}

	return connection.QueryResult{Success: true, Message: "Export successful"}
}

func (a *App) ExportTablesSQL(config connection.ConnectionConfig, dbName string, tableNames []string, includeData bool) connection.QueryResult {
	return a.exportTablesSQL(config, dbName, tableNames, true, includeData)
}

func (a *App) ExportTablesDataSQL(config connection.ConnectionConfig, dbName string, tableNames []string) connection.QueryResult {
	return a.exportTablesSQL(config, dbName, tableNames, false, true)
}

func (a *App) exportTablesSQL(config connection.ConnectionConfig, dbName string, tableNames []string, includeSchema bool, includeData bool) connection.QueryResult {
	if !includeSchema && !includeData {
		return connection.QueryResult{Success: false, Message: "invalid export mode"}
	}

	safeDbName := strings.TrimSpace(dbName)
	if safeDbName == "" {
		safeDbName = "export"
	}
	suffix := "schema"
	if includeSchema && includeData {
		suffix = "backup"
	} else if !includeSchema && includeData {
		suffix = "data"
	}
	defaultFilename := fmt.Sprintf("%s_%s_%dtables.sql", safeDbName, suffix, len(tableNames))
	if len(tableNames) == 1 && strings.TrimSpace(tableNames[0]) != "" {
		defaultFilename = fmt.Sprintf("%s_%s.sql", strings.TrimSpace(tableNames[0]), suffix)
	}

	filename, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Export Tables (SQL)",
		DefaultFilename: defaultFilename,
	})
	if err != nil || filename == "" {
		return connection.QueryResult{Success: false, Message: "Cancelled"}
	}

	runConfig := normalizeRunConfig(config, dbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	objects := make([]string, 0, len(tableNames))
	seen := make(map[string]struct{}, len(tableNames))
	for _, t := range tableNames {
		t = strings.TrimSpace(t)
		if t == "" {
			continue
		}
		if _, ok := seen[t]; ok {
			continue
		}
		seen[t] = struct{}{}
		objects = append(objects, t)
	}
	viewLookup := listViewNameLookup(dbInst, runConfig, dbName)
	objects = buildExportObjectOrder(runConfig, dbName, objects, viewLookup, false)

	f, err := os.Create(filename)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer f.Close()

	w := bufio.NewWriterSize(f, 1024*1024)
	defer w.Flush()

	if err := writeSQLHeader(w, runConfig, dbName); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	for _, objectName := range objects {
		if err := dumpTableSQL(w, dbInst, runConfig, dbName, objectName, includeSchema, includeData, viewLookup); err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}
	if err := writeSQLFooter(w, runConfig); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: "Export successful"}
}

func (a *App) ExportDatabaseSQL(config connection.ConnectionConfig, dbName string, includeData bool) connection.QueryResult {
	safeDbName := strings.TrimSpace(dbName)
	if safeDbName == "" {
		return connection.QueryResult{Success: false, Message: "dbName required"}
	}
	suffix := "schema"
	if includeData {
		suffix = "backup"
	}

	filename, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           fmt.Sprintf("Export %s (SQL)", safeDbName),
		DefaultFilename: fmt.Sprintf("%s_%s.sql", safeDbName, suffix),
	})
	if err != nil || filename == "" {
		return connection.QueryResult{Success: false, Message: "Cancelled"}
	}

	runConfig := normalizeRunConfig(config, dbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	tables, err := dbInst.GetTables(dbName)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	viewLookup := listViewNameLookup(dbInst, runConfig, dbName)
	objects := buildExportObjectOrder(runConfig, dbName, tables, viewLookup, true)

	f, err := os.Create(filename)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer f.Close()

	w := bufio.NewWriterSize(f, 1024*1024)
	defer w.Flush()

	if err := writeSQLHeader(w, runConfig, dbName); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	for _, objectName := range objects {
		if err := dumpTableSQL(w, dbInst, runConfig, dbName, objectName, true, includeData, viewLookup); err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}
	if err := writeSQLFooter(w, runConfig); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: "Export successful"}
}

func quoteIdentByType(dbType string, ident string) string {
	if ident == "" {
		return ident
	}

	switch dbType {
	case "mysql", "mariadb", "diros", "sphinx", "tdengine", "clickhouse":
		return "`" + strings.ReplaceAll(ident, "`", "``") + "`"
	case "sqlserver":
		escaped := strings.ReplaceAll(ident, "]", "]]")
		return "[" + escaped + "]"
	default:
		return `"` + strings.ReplaceAll(ident, `"`, `""`) + `"`
	}
}

func quoteQualifiedIdentByType(dbType string, ident string) string {
	raw := strings.TrimSpace(ident)
	if raw == "" {
		return raw
	}

	parts := strings.Split(raw, ".")
	if len(parts) <= 1 {
		return quoteIdentByType(dbType, raw)
	}

	quotedParts := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		quotedParts = append(quotedParts, quoteIdentByType(dbType, part))
	}

	if len(quotedParts) == 0 {
		return quoteIdentByType(dbType, raw)
	}
	return strings.Join(quotedParts, ".")
}

func writeSQLHeader(w *bufio.Writer, config connection.ConnectionConfig, dbName string) error {
	now := time.Now().Format("2006-01-02 15:04:05")
	if _, err := w.WriteString(fmt.Sprintf("-- GoNavi SQL Export\n-- Time: %s\n", now)); err != nil {
		return err
	}
	if strings.TrimSpace(dbName) != "" {
		if _, err := w.WriteString(fmt.Sprintf("-- Database: %s\n\n", dbName)); err != nil {
			return err
		}
	}

	if strings.ToLower(strings.TrimSpace(config.Type)) == "mysql" && strings.TrimSpace(dbName) != "" {
		if _, err := w.WriteString(fmt.Sprintf("USE %s;\n\n", quoteIdentByType("mysql", dbName))); err != nil {
			return err
		}
		if _, err := w.WriteString("SET FOREIGN_KEY_CHECKS=0;\n\n"); err != nil {
			return err
		}
	}

	return nil
}

func writeSQLFooter(w *bufio.Writer, config connection.ConnectionConfig) error {
	if strings.ToLower(strings.TrimSpace(config.Type)) == "mysql" {
		if _, err := w.WriteString("\nSET FOREIGN_KEY_CHECKS=1;\n"); err != nil {
			return err
		}
	}
	return nil
}

func qualifyTable(schemaName, tableName string) string {
	schemaName = strings.TrimSpace(schemaName)
	tableName = strings.TrimSpace(tableName)
	if schemaName == "" {
		return tableName
	}
	return schemaName + "." + tableName
}

func ensureSQLTerminator(sql string) string {
	trimmed := strings.TrimSpace(sql)
	if trimmed == "" {
		return sql
	}
	if strings.HasSuffix(trimmed, ";") {
		return sql
	}
	return sql + ";"
}

func buildExportObjectOrder(
	config connection.ConnectionConfig,
	dbName string,
	rawObjects []string,
	viewLookup map[string]string,
	includeAllViews bool,
) []string {
	tableSet := make(map[string]string, len(rawObjects))
	viewSet := make(map[string]string, len(rawObjects))

	for _, rawName := range rawObjects {
		objectName := strings.TrimSpace(rawName)
		if objectName == "" {
			continue
		}
		key := normalizeExportObjectKey(config, dbName, objectName)
		if key == "" {
			continue
		}
		if canonicalViewName, ok := viewLookup[key]; ok {
			if strings.TrimSpace(canonicalViewName) == "" {
				canonicalViewName = objectName
			}
			viewSet[key] = canonicalViewName
			delete(tableSet, key)
			continue
		}
		if _, isView := viewSet[key]; isView {
			continue
		}
		if _, exists := tableSet[key]; !exists {
			tableSet[key] = objectName
		}
	}

	if includeAllViews {
		for key, viewName := range viewLookup {
			canonicalViewName := strings.TrimSpace(viewName)
			if canonicalViewName == "" {
				continue
			}
			viewSet[key] = canonicalViewName
			delete(tableSet, key)
		}
	}

	tables := mapValuesSorted(tableSet)
	views := mapValuesSorted(viewSet)
	return append(tables, views...)
}

func mapValuesSorted(values map[string]string) []string {
	if len(values) == 0 {
		return nil
	}
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func normalizeExportObjectKey(config connection.ConnectionConfig, dbName string, objectName string) string {
	schemaName, pureName := normalizeSchemaAndTable(config, dbName, objectName)
	return normalizeExportObjectKeyByParts(schemaName, pureName)
}

func normalizeExportObjectKeyByParts(schemaName, objectName string) string {
	return strings.ToLower(strings.TrimSpace(qualifyTable(schemaName, objectName)))
}

func listViewNameLookup(dbInst db.Database, config connection.ConnectionConfig, dbName string) map[string]string {
	viewLookup := make(map[string]string)
	queries := buildListViewQueries(config, dbName)
	for _, query := range queries {
		if strings.TrimSpace(query) == "" {
			continue
		}
		rows, _, err := queryDataForExport(dbInst, config, query)
		if err != nil {
			continue
		}
		for _, row := range rows {
			tableType := strings.ToUpper(exportRowValueCI(row, "table_type", "type"))
			if tableType != "" && tableType != "VIEW" {
				continue
			}
			schemaName := exportRowValueCI(row, "schema_name", "table_schema", "owner", "schema", "db")
			viewName := exportRowValueCI(row, "object_name", "view_name", "table_name", "name")
			if viewName == "" {
				viewName = exportInferObjectName(row)
			}
			if strings.TrimSpace(viewName) == "" {
				continue
			}
			fullName := strings.TrimSpace(qualifyTable(schemaName, viewName))
			if fullName == "" {
				fullName = strings.TrimSpace(viewName)
			}
			key := normalizeExportObjectKey(config, dbName, fullName)
			if key == "" {
				continue
			}
			if _, exists := viewLookup[key]; !exists {
				viewLookup[key] = fullName
			}
		}
	}
	return viewLookup
}

func buildListViewQueries(config connection.ConnectionConfig, dbName string) []string {
	dbType := resolveDDLDBType(config)
	escapedDbName := escapeSQLLiteral(dbName)
	switch dbType {
	case "mysql", "mariadb", "diros", "sphinx":
		queries := []string{
			fmt.Sprintf(`SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS object_name, TABLE_TYPE AS table_type FROM information_schema.tables WHERE TABLE_TYPE='VIEW' AND TABLE_SCHEMA='%s' ORDER BY TABLE_NAME`, escapedDbName),
		}
		if strings.TrimSpace(dbName) != "" {
			queries = append(queries, fmt.Sprintf("SHOW FULL TABLES FROM %s WHERE Table_type = 'VIEW'", quoteIdentByType("mysql", dbName)))
		}
		return queries
	case "postgres", "kingbase", "highgo", "vastbase":
		return []string{
			`SELECT table_schema AS schema_name, table_name AS object_name FROM information_schema.views WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name`,
		}
	case "sqlserver":
		safeDBName := strings.TrimSpace(config.Database)
		if safeDBName == "" {
			safeDBName = strings.TrimSpace(dbName)
		}
		if safeDBName == "" {
			return nil
		}
		safeDB := quoteIdentByType("sqlserver", safeDBName)
		return []string{
			fmt.Sprintf(`SELECT s.name AS schema_name, v.name AS object_name FROM %s.sys.views v JOIN %s.sys.schemas s ON v.schema_id = s.schema_id ORDER BY s.name, v.name`, safeDB, safeDB),
		}
	case "oracle", "dameng":
		if strings.TrimSpace(dbName) == "" {
			return []string{
				`SELECT VIEW_NAME AS object_name FROM user_views ORDER BY VIEW_NAME`,
			}
		}
		return []string{
			fmt.Sprintf("SELECT OWNER AS schema_name, VIEW_NAME AS object_name FROM all_views WHERE OWNER = '%s' ORDER BY VIEW_NAME", strings.ToUpper(escapedDbName)),
		}
	case "sqlite":
		return []string{
			"SELECT name AS object_name FROM sqlite_master WHERE type='view' ORDER BY name",
		}
	case "duckdb":
		return []string{
			`SELECT table_schema AS schema_name, table_name AS object_name FROM information_schema.views WHERE table_schema NOT IN ('information_schema', 'pg_catalog') ORDER BY table_schema, table_name`,
		}
	case "clickhouse":
		if strings.TrimSpace(dbName) == "" {
			return []string{
				`SELECT database AS schema_name, name AS object_name FROM system.tables WHERE engine LIKE '%View%' ORDER BY database, name`,
			}
		}
		return []string{
			fmt.Sprintf(`SELECT database AS schema_name, name AS object_name FROM system.tables WHERE engine LIKE '%%View%%' AND database='%s' ORDER BY name`, escapedDbName),
		}
	default:
		if strings.TrimSpace(dbName) == "" {
			return []string{
				`SELECT table_schema AS schema_name, table_name AS object_name FROM information_schema.views`,
			}
		}
		return []string{
			fmt.Sprintf(`SELECT table_schema AS schema_name, table_name AS object_name FROM information_schema.views WHERE table_schema='%s'`, escapedDbName),
		}
	}
}

func tryGetViewCreateStatement(
	dbInst db.Database,
	config connection.ConnectionConfig,
	dbName string,
	schemaName string,
	viewName string,
) (string, bool) {
	queries := buildViewCreateQueries(config, dbName, schemaName, viewName)
	for _, query := range queries {
		if strings.TrimSpace(query) == "" {
			continue
		}
		rows, _, err := queryDataForExport(dbInst, config, query)
		if err != nil || len(rows) == 0 {
			continue
		}
		createSQL := strings.TrimSpace(extractViewCreateSQL(rows[0]))
		if createSQL == "" {
			continue
		}
		if looksLikeSelectOrWith(createSQL) {
			qualifiedView := qualifyTable(schemaName, viewName)
			createSQL = fmt.Sprintf("CREATE VIEW %s AS %s", quoteQualifiedIdentByType(config.Type, qualifiedView), strings.TrimSuffix(strings.TrimSpace(createSQL), ";"))
		}
		return ensureSQLTerminator(createSQL), true
	}
	return "", false
}

func buildViewCreateQueries(config connection.ConnectionConfig, dbName, schemaName, viewName string) []string {
	dbType := resolveDDLDBType(config)
	safeSchema := strings.TrimSpace(schemaName)
	safeView := strings.TrimSpace(viewName)
	if safeView == "" {
		return nil
	}
	escapedSchema := escapeSQLLiteral(safeSchema)
	escapedView := escapeSQLLiteral(safeView)
	escapedDB := escapeSQLLiteral(dbName)

	switch dbType {
	case "mysql", "mariadb", "diros", "sphinx":
		if safeSchema == "" {
			safeSchema = strings.TrimSpace(dbName)
		}
		if safeSchema != "" {
			return []string{
				fmt.Sprintf("SHOW CREATE VIEW %s.%s", quoteIdentByType("mysql", safeSchema), quoteIdentByType("mysql", safeView)),
			}
		}
		return []string{
			fmt.Sprintf("SHOW CREATE VIEW %s", quoteIdentByType("mysql", safeView)),
		}
	case "postgres", "kingbase", "highgo", "vastbase":
		if safeSchema == "" {
			safeSchema = "public"
		}
		regClassName := fmt.Sprintf(`"%s"."%s"`, strings.ReplaceAll(safeSchema, `"`, `""`), strings.ReplaceAll(safeView, `"`, `""`))
		regClassName = strings.ReplaceAll(regClassName, "'", "''")
		return []string{
			fmt.Sprintf("SELECT pg_get_viewdef('%s'::regclass, true) AS ddl", regClassName),
		}
	case "sqlserver":
		schema := safeSchema
		if schema == "" {
			schema = "dbo"
		}
		safeDBName := strings.TrimSpace(config.Database)
		if safeDBName == "" {
			safeDBName = strings.TrimSpace(dbName)
		}
		if safeDBName == "" {
			return nil
		}
		safeDB := quoteIdentByType("sqlserver", safeDBName)
		return []string{
			fmt.Sprintf(`SELECT m.definition AS ddl
FROM %s.sys.views v
JOIN %s.sys.schemas s ON v.schema_id = s.schema_id
JOIN %s.sys.sql_modules m ON v.object_id = m.object_id
WHERE s.name = '%s' AND v.name = '%s'`,
				safeDB, safeDB, safeDB, escapeSQLLiteral(schema), escapedView),
		}
	case "oracle", "dameng":
		if safeSchema == "" {
			safeSchema = strings.TrimSpace(dbName)
		}
		if safeSchema != "" {
			return []string{
				fmt.Sprintf("SELECT DBMS_METADATA.GET_DDL('VIEW', '%s', '%s') AS ddl FROM DUAL", strings.ToUpper(escapedView), strings.ToUpper(escapeSQLLiteral(safeSchema))),
			}
		}
		return []string{
			fmt.Sprintf("SELECT DBMS_METADATA.GET_DDL('VIEW', '%s') AS ddl FROM DUAL", strings.ToUpper(escapedView)),
		}
	case "sqlite":
		return []string{
			fmt.Sprintf("SELECT sql AS ddl FROM sqlite_master WHERE type='view' AND name='%s'", escapedView),
		}
	case "duckdb":
		if safeSchema == "" {
			safeSchema = "main"
			escapedSchema = "main"
		}
		return []string{
			fmt.Sprintf("SELECT sql AS ddl FROM duckdb_views() WHERE view_name = '%s' AND schema_name = '%s' LIMIT 1", escapedView, escapedSchema),
			fmt.Sprintf("SELECT view_definition AS ddl FROM information_schema.views WHERE table_name = '%s' AND table_schema = '%s' LIMIT 1", escapedView, escapedSchema),
		}
	case "clickhouse":
		if safeSchema == "" {
			safeSchema = strings.TrimSpace(dbName)
		}
		if safeSchema != "" {
			return []string{
				fmt.Sprintf("SHOW CREATE TABLE %s.%s", quoteIdentByType("clickhouse", safeSchema), quoteIdentByType("clickhouse", safeView)),
			}
		}
		return []string{
			fmt.Sprintf("SHOW CREATE TABLE %s", quoteIdentByType("clickhouse", safeView)),
		}
	default:
		if safeSchema != "" {
			return []string{
				fmt.Sprintf("SELECT view_definition AS ddl FROM information_schema.views WHERE table_name = '%s' AND table_schema = '%s' LIMIT 1", escapedView, escapedSchema),
			}
		}
		if strings.TrimSpace(dbName) != "" {
			return []string{
				fmt.Sprintf("SELECT view_definition AS ddl FROM information_schema.views WHERE table_name = '%s' AND table_schema = '%s' LIMIT 1", escapedView, escapedDB),
			}
		}
		return []string{
			fmt.Sprintf("SELECT view_definition AS ddl FROM information_schema.views WHERE table_name = '%s' LIMIT 1", escapedView),
		}
	}
}

func extractViewCreateSQL(row map[string]interface{}) string {
	if row == nil {
		return ""
	}
	ddl := exportRowValueCI(row, "create view", "create_statement", "create_sql", "ddl", "sql", "view_definition", "definition")
	if ddl != "" {
		return ddl
	}
	for _, value := range row {
		if value == nil {
			continue
		}
		text := strings.TrimSpace(fmt.Sprintf("%v", value))
		if text == "" || text == "<nil>" {
			continue
		}
		lower := strings.ToLower(text)
		if strings.HasPrefix(lower, "create ") || strings.HasPrefix(lower, "select ") || strings.HasPrefix(lower, "with ") {
			return text
		}
	}
	return ""
}

func exportRowValueCI(row map[string]interface{}, candidates ...string) string {
	if len(row) == 0 || len(candidates) == 0 {
		return ""
	}
	for _, candidate := range candidates {
		candidate = strings.ToLower(strings.TrimSpace(candidate))
		if candidate == "" {
			continue
		}
		for key, value := range row {
			normalizedKey := strings.ToLower(strings.TrimSpace(key))
			if normalizedKey != candidate {
				continue
			}
			if value == nil {
				return ""
			}
			text := strings.TrimSpace(fmt.Sprintf("%v", value))
			if text == "<nil>" {
				return ""
			}
			return text
		}
	}
	return ""
}

func exportInferObjectName(row map[string]interface{}) string {
	if len(row) == 0 {
		return ""
	}
	for key, value := range row {
		normalizedKey := strings.ToLower(strings.TrimSpace(key))
		if normalizedKey == "" {
			continue
		}
		if strings.Contains(normalizedKey, "type") {
			continue
		}
		if strings.Contains(normalizedKey, "table") || strings.Contains(normalizedKey, "view") || strings.Contains(normalizedKey, "name") || strings.Contains(normalizedKey, "ddl") || strings.Contains(normalizedKey, "sql") {
			if value == nil {
				continue
			}
			text := strings.TrimSpace(fmt.Sprintf("%v", value))
			if text == "" || text == "<nil>" {
				continue
			}
			return text
		}
	}
	for _, value := range row {
		if value == nil {
			continue
		}
		text := strings.TrimSpace(fmt.Sprintf("%v", value))
		if text == "" || text == "<nil>" {
			continue
		}
		return text
	}
	return ""
}

func looksLikeSelectOrWith(sql string) bool {
	trimmed := strings.TrimSpace(strings.TrimSuffix(sql, ";"))
	if trimmed == "" {
		return false
	}
	lower := strings.ToLower(trimmed)
	return strings.HasPrefix(lower, "select ") || strings.HasPrefix(lower, "with ") || lower == "select" || lower == "with"
}

func escapeSQLLiteral(value string) string {
	return strings.ReplaceAll(strings.TrimSpace(value), "'", "''")
}

func isMySQLHexLiteral(s string) bool {
	if len(s) < 3 || !(strings.HasPrefix(s, "0x") || strings.HasPrefix(s, "0X")) {
		return false
	}
	for i := 2; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func formatSQLValue(dbType string, v interface{}) string {
	if v == nil {
		return "NULL"
	}

	switch val := v.(type) {
	case bool:
		if val {
			return "1"
		}
		return "0"
	case int:
		return strconv.Itoa(val)
	case int8, int16, int32, int64:
		return fmt.Sprintf("%d", val)
	case uint, uint8, uint16, uint32, uint64:
		return fmt.Sprintf("%d", val)
	case float32:
		f := float64(val)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return "NULL"
		}
		return strconv.FormatFloat(f, 'f', -1, 32)
	case float64:
		if math.IsNaN(val) || math.IsInf(val, 0) {
			return "NULL"
		}
		return strconv.FormatFloat(val, 'f', -1, 64)
	case time.Time:
		return "'" + val.Format("2006-01-02 15:04:05") + "'"
	case string:
		if (strings.ToLower(strings.TrimSpace(dbType)) == "mysql" || strings.ToLower(strings.TrimSpace(dbType)) == "diros") && isMySQLHexLiteral(val) {
			return val
		}
		escaped := strings.ReplaceAll(val, "'", "''")
		return "'" + escaped + "'"
	default:
		escaped := strings.ReplaceAll(fmt.Sprintf("%v", v), "'", "''")
		return "'" + escaped + "'"
	}
}

func dumpTableSQL(
	w *bufio.Writer,
	dbInst db.Database,
	config connection.ConnectionConfig,
	dbName,
	tableName string,
	includeSchema bool,
	includeData bool,
	viewLookup map[string]string,
) error {
	schemaName, pureTableName := normalizeSchemaAndTable(config, dbName, tableName)
	objectKey := normalizeExportObjectKeyByParts(schemaName, pureTableName)
	_, isView := viewLookup[objectKey]
	var createSQL string

	if includeSchema {
		if isView {
			viewDDL, ok := tryGetViewCreateStatement(dbInst, config, dbName, schemaName, pureTableName)
			if ok {
				createSQL = viewDDL
			} else {
				ddl, err := dbInst.GetCreateStatement(schemaName, pureTableName)
				if err != nil {
					return err
				}
				createSQL = ddl
			}
		} else {
			ddl, err := resolveCreateStatementWithFallback(dbInst, config, dbName, tableName)
			if err != nil {
				if viewDDL, ok := tryGetViewCreateStatement(dbInst, config, dbName, schemaName, pureTableName); ok {
					createSQL = viewDDL
					isView = true
				} else {
					return err
				}
			} else {
				createSQL = ddl
			}
		}
	}

	if includeData && !includeSchema && !isView {
		if _, ok := tryGetViewCreateStatement(dbInst, config, dbName, schemaName, pureTableName); ok {
			isView = true
		}
	}

	objectLabel := "Table"
	if isView {
		objectLabel = "View"
	}

	if _, err := w.WriteString("\n-- ----------------------------\n"); err != nil {
		return err
	}
	if _, err := w.WriteString(fmt.Sprintf("-- %s: %s\n", objectLabel, qualifyTable(schemaName, pureTableName))); err != nil {
		return err
	}
	if _, err := w.WriteString("-- ----------------------------\n\n"); err != nil {
		return err
	}

	if includeSchema {
		if _, err := w.WriteString(ensureSQLTerminator(createSQL)); err != nil {
			return err
		}
		if _, err := w.WriteString("\n\n"); err != nil {
			return err
		}
	}

	if !includeData {
		return nil
	}

	if isView {
		if _, err := w.WriteString("-- View data export skipped (INSERT for views is not emitted).\n"); err != nil {
			return err
		}
		return nil
	}

	qualified := qualifyTable(schemaName, pureTableName)
	selectSQL := fmt.Sprintf("SELECT * FROM %s", quoteQualifiedIdentByType(config.Type, qualified))
	data, columns, err := queryDataForExport(dbInst, config, selectSQL)
	if err != nil {
		return err
	}
	if len(data) == 0 {
		if _, err := w.WriteString("-- (0 rows)\n"); err != nil {
			return err
		}
		return nil
	}

	quotedCols := make([]string, 0, len(columns))
	for _, c := range columns {
		quotedCols = append(quotedCols, quoteIdentByType(config.Type, c))
	}
	quotedTable := quoteQualifiedIdentByType(config.Type, qualified)

	for _, row := range data {
		values := make([]string, 0, len(columns))
		for _, c := range columns {
			values = append(values, formatSQLValue(config.Type, row[c]))
		}
		if _, err := w.WriteString(fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s);\n", quotedTable, strings.Join(quotedCols, ", "), strings.Join(values, ", "))); err != nil {
			return err
		}
	}

	return nil
}

// ExportData exports provided data to a file
func (a *App) ExportData(data []map[string]interface{}, columns []string, defaultName string, format string) connection.QueryResult {
	if defaultName == "" {
		defaultName = "export"
	}
	logger.Infof("ExportData 开始：rows=%d cols=%d format=%s defaultName=%s", len(data), len(columns), strings.ToLower(strings.TrimSpace(format)), strings.TrimSpace(defaultName))
	filename, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Export Data",
		DefaultFilename: fmt.Sprintf("%s.%s", defaultName, strings.ToLower(format)),
	})

	if err != nil || filename == "" {
		logger.Infof("ExportData 已取消或未选择文件：err=%v", err)
		return connection.QueryResult{Success: false, Message: "Cancelled"}
	}
	logger.Infof("ExportData 选定文件：%s", filename)

	f, err := os.Create(filename)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer f.Close()
	if err := writeRowsToFile(f, data, columns, format); err != nil {
		logger.Warnf("ExportData 写入失败：file=%s err=%v", filename, err)
		return connection.QueryResult{Success: false, Message: "Write error: " + err.Error()}
	}

	logger.Infof("ExportData 完成：file=%s rows=%d", filename, len(data))
	return connection.QueryResult{Success: true, Message: "Export successful"}
}

// ExportQuery exports by executing the provided SELECT query on backend side.
// This avoids frontend IPC payload limits when exporting very large/long-text columns (e.g. base64).
func (a *App) ExportQuery(config connection.ConnectionConfig, dbName string, query string, defaultName string, format string) connection.QueryResult {
	query = strings.TrimSpace(query)
	if query == "" {
		return connection.QueryResult{Success: false, Message: "query required"}
	}

	if defaultName == "" {
		defaultName = "export"
	}

	filename, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Export Query Result",
		DefaultFilename: fmt.Sprintf("%s.%s", defaultName, strings.ToLower(format)),
	})
	if err != nil || filename == "" {
		logger.Infof("ExportQuery 已取消或未选择文件：err=%v", err)
		return connection.QueryResult{Success: false, Message: "Cancelled"}
	}
	logger.Infof("ExportQuery 开始：type=%s db=%s format=%s file=%s sql=%q", strings.TrimSpace(config.Type), strings.TrimSpace(dbName), strings.ToLower(strings.TrimSpace(format)), filename, sqlSnippet(query))

	runConfig := normalizeRunConfig(config, dbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	query = sanitizeSQLForPgLike(runConfig.Type, query)
	lowerQuery := strings.ToLower(strings.TrimSpace(query))
	if !(strings.HasPrefix(lowerQuery, "select") || strings.HasPrefix(lowerQuery, "with")) {
		return connection.QueryResult{Success: false, Message: "Only SELECT/WITH queries are supported"}
	}

	data, columns, err := queryDataForExport(dbInst, runConfig, query)
	if err != nil {
		logger.Warnf("ExportQuery 查询失败：type=%s db=%s err=%v sql=%q", strings.TrimSpace(config.Type), strings.TrimSpace(dbName), err, sqlSnippet(query))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	f, err := os.Create(filename)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer f.Close()

	if err := writeRowsToFile(f, data, columns, format); err != nil {
		logger.Warnf("ExportQuery 写入失败：file=%s err=%v", filename, err)
		return connection.QueryResult{Success: false, Message: "Write error: " + err.Error()}
	}

	logger.Infof("ExportQuery 完成：file=%s rows=%d cols=%d", filename, len(data), len(columns))
	return connection.QueryResult{Success: true, Message: "Export successful"}
}

func queryDataForExport(dbInst db.Database, config connection.ConnectionConfig, query string) ([]map[string]interface{}, []string, error) {
	timeout := getExportQueryTimeout(config)
	dbType := resolveDDLDBType(config)
	if dbType == "clickhouse" {
		logger.Infof("ClickHouse 导出查询开始：timeout=%s SQL片段=%q", timeout, sqlSnippet(query))
	}
	if q, ok := dbInst.(interface {
		QueryContext(context.Context, string) ([]map[string]interface{}, []string, error)
	}); ok {
		ctx, cancel := utils.ContextWithTimeout(timeout)
		defer cancel()
		data, columns, err := q.QueryContext(ctx, query)
		if err != nil && dbType == "clickhouse" {
			logger.Warnf("ClickHouse 导出查询失败：timeout=%s SQL片段=%q err=%v", timeout, sqlSnippet(query), err)
		}
		return data, columns, err
	}
	data, columns, err := dbInst.Query(query)
	if err != nil && dbType == "clickhouse" {
		logger.Warnf("ClickHouse 导出查询失败（无 QueryContext）：timeout=%s SQL片段=%q err=%v", timeout, sqlSnippet(query), err)
	}
	return data, columns, err
}

func getExportQueryTimeout(config connection.ConnectionConfig) time.Duration {
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

func writeRowsToFile(f *os.File, data []map[string]interface{}, columns []string, format string) error {
	format = strings.ToLower(strings.TrimSpace(format))
	if f == nil {
		return fmt.Errorf("file required")
	}

	// xlsx 使用 excelize 写入真正的 Excel 格式
	if format == "xlsx" {
		return writeRowsToXlsx(f.Name(), data, columns)
	}

	// html 使用内嵌 CSS 输出可直接浏览器预览的独立页面
	if format == "html" {
		return writeRowsToHTML(f, data, columns)
	}

	// 如果列名为空但数据不为空，从所有数据行提取所有键
	if len(columns) == 0 && len(data) > 0 {
		keySet := make(map[string]bool)
		for _, row := range data {
			for key := range row {
				keySet[key] = true
			}
		}
		// 排序以确保输出一致
		for key := range keySet {
			columns = append(columns, key)
		}
		sort.Strings(columns)
	}

	var csvWriter *csv.Writer
	var jsonEncoder *json.Encoder
	isJsonFirstRow := true

	switch format {
	case "csv":
		if _, err := f.Write([]byte{0xEF, 0xBB, 0xBF}); err != nil {
			return err
		}
		csvWriter = csv.NewWriter(f)
		if err := csvWriter.Write(columns); err != nil {
			return err
		}
	case "json":
		if _, err := f.WriteString("[\n"); err != nil {
			return err
		}
		jsonEncoder = json.NewEncoder(f)
		jsonEncoder.SetIndent("  ", "  ")
	case "md":
		if _, err := fmt.Fprintf(f, "| %s |\n", strings.Join(columns, " | ")); err != nil {
			return err
		}
		seps := make([]string, len(columns))
		for i := range seps {
			seps[i] = "---"
		}
		if _, err := fmt.Fprintf(f, "| %s |\n", strings.Join(seps, " | ")); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unsupported format: %s", format)
	}

	for _, rowMap := range data {
		record := make([]string, len(columns))
		for i, col := range columns {
			val := rowMap[col]
			if val == nil {
				record[i] = "NULL"
				continue
			}

			s := formatExportCellText(val)
			if format == "md" {
				s = strings.ReplaceAll(s, "|", "\\|")
				s = strings.ReplaceAll(s, "\n", "<br>")
			}
			record[i] = s
		}

		switch format {
		case "csv":
			if err := csvWriter.Write(record); err != nil {
				return err
			}
		case "json":
			if !isJsonFirstRow {
				if _, err := f.WriteString(",\n"); err != nil {
					return err
				}
			}
			exportedRow := make(map[string]interface{}, len(columns))
			for _, col := range columns {
				exportedRow[col] = normalizeExportJSONValue(rowMap[col])
			}
			if err := jsonEncoder.Encode(exportedRow); err != nil {
				return err
			}
			isJsonFirstRow = false
		case "md":
			if _, err := fmt.Fprintf(f, "| %s |\n", strings.Join(record, " | ")); err != nil {
				return err
			}
		}
	}

	if format == "csv" {
		csvWriter.Flush()
		if err := csvWriter.Error(); err != nil {
			return err
		}
	}

	if format == "json" {
		if _, err := f.WriteString("\n]"); err != nil {
			return err
		}
	}

	return nil
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
		return "NULL"
	}

	switch v := val.(type) {
	case time.Time:
		return v.Format("2006-01-02 15:04:05")
	case *time.Time:
		if v == nil {
			return "NULL"
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
	default:
		return fmt.Sprintf("%v", val)
	}
}

func normalizeExportJSONValue(val interface{}) interface{} {
	if val == nil {
		return nil
	}

	switch v := val.(type) {
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
func writeRowsToXlsx(filename string, data []map[string]interface{}, columns []string) error {
	xlsx := excelize.NewFile()
	defer xlsx.Close()

	sheet := "Sheet1"

	// 写入表头
	for i, col := range columns {
		cell, _ := excelize.CoordinatesToCellName(i+1, 1)
		xlsx.SetCellValue(sheet, cell, col)
	}

	// 写入数据行
	for rowIdx, rowMap := range data {
		for colIdx, col := range columns {
			cell, _ := excelize.CoordinatesToCellName(colIdx+1, rowIdx+2)
			val := rowMap[col]
			if val == nil {
				xlsx.SetCellValue(sheet, cell, "NULL")
			} else {
				xlsx.SetCellValue(sheet, cell, formatExportCellText(val))
			}
		}
	}

	return xlsx.SaveAs(filename)
}
