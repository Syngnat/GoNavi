package app

import (
	"bufio"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"github.com/xuri/excelize/v2"
)

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
		if err := dumpTableSQL(w, dbInst, runConfig, dbName, tableName, true, true); err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		if err := writeSQLFooter(w, runConfig); err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}

		return connection.QueryResult{Success: true, Message: "Export successful"}
	}

	query := fmt.Sprintf("SELECT * FROM %s", quoteQualifiedIdentByType(runConfig.Type, tableName))

	data, columns, err := dbInst.Query(query)
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

	tables := make([]string, 0, len(tableNames))
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
		tables = append(tables, t)
	}
	sort.Strings(tables)

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
	for _, t := range tables {
		if err := dumpTableSQL(w, dbInst, runConfig, dbName, t, includeSchema, includeData); err != nil {
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
	sort.Strings(tables)

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
	for _, t := range tables {
		if err := dumpTableSQL(w, dbInst, runConfig, dbName, t, true, includeData); err != nil {
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
	case "mysql", "mariadb", "tdengine":
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
		if strings.ToLower(strings.TrimSpace(dbType)) == "mysql" && isMySQLHexLiteral(val) {
			return val
		}
		escaped := strings.ReplaceAll(val, "'", "''")
		return "'" + escaped + "'"
	default:
		escaped := strings.ReplaceAll(fmt.Sprintf("%v", v), "'", "''")
		return "'" + escaped + "'"
	}
}

func dumpTableSQL(w *bufio.Writer, dbInst db.Database, config connection.ConnectionConfig, dbName, tableName string, includeSchema bool, includeData bool) error {
	schemaName, pureTableName := normalizeSchemaAndTable(config, dbName, tableName)

	if _, err := w.WriteString("\n-- ----------------------------\n"); err != nil {
		return err
	}
	if _, err := w.WriteString(fmt.Sprintf("-- Table: %s\n", qualifyTable(schemaName, pureTableName))); err != nil {
		return err
	}
	if _, err := w.WriteString("-- ----------------------------\n\n"); err != nil {
		return err
	}

	if includeSchema {
		createSQL, err := dbInst.GetCreateStatement(schemaName, pureTableName)
		if err != nil {
			return err
		}
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

	qualified := qualifyTable(schemaName, pureTableName)
	selectSQL := fmt.Sprintf("SELECT * FROM %s", quoteQualifiedIdentByType(config.Type, qualified))
	data, columns, err := dbInst.Query(selectSQL)
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
	filename, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Export Data",
		DefaultFilename: fmt.Sprintf("%s.%s", defaultName, strings.ToLower(format)),
	})

	if err != nil || filename == "" {
		return connection.QueryResult{Success: false, Message: "Cancelled"}
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
		return connection.QueryResult{Success: false, Message: "Cancelled"}
	}

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

	data, columns, err := dbInst.Query(query)
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

func writeRowsToFile(f *os.File, data []map[string]interface{}, columns []string, format string) error {
	format = strings.ToLower(strings.TrimSpace(format))
	if f == nil {
		return fmt.Errorf("file required")
	}

	// xlsx 使用 excelize 写入真正的 Excel 格式
	if format == "xlsx" {
		return writeRowsToXlsx(f.Name(), data, columns)
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
			if err := jsonEncoder.Encode(rowMap); err != nil {
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
	default:
		return fmt.Sprintf("%v", val)
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
