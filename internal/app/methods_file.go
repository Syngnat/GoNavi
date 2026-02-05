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
	"GoNavi-Wails/internal/logger"

	"github.com/wailsapp/wails/v2/pkg/runtime"
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

func (a *App) ImportData(config connection.ConnectionConfig, dbName, tableName string) connection.QueryResult {
	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: fmt.Sprintf("Import into %s", tableName),
		Filters: []runtime.FileFilter{
			{
				DisplayName: "Data Files",
				Pattern:     "*.csv;*.json",
			},
		},
	})

	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if selection == "" {
		return connection.QueryResult{Success: false, Message: "Cancelled"}
	}

	f, err := os.Open(selection)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	defer f.Close()

	var rows []map[string]interface{ } 
	
	if strings.HasSuffix(strings.ToLower(selection), ".json") {
		decoder := json.NewDecoder(f)
		if err := decoder.Decode(&rows); err != nil {
			return connection.QueryResult{Success: false, Message: "JSON Parse Error: " + err.Error()}
		}
	} else if strings.HasSuffix(strings.ToLower(selection), ".csv") {
		reader := csv.NewReader(f)
		records, err := reader.ReadAll()
		if err != nil {
			return connection.QueryResult{Success: false, Message: "CSV Parse Error: " + err.Error()}
		}
		if len(records) < 2 {
			return connection.QueryResult{Success: false, Message: "CSV empty or missing header"}
		}
		headers := records[0]
		for _, record := range records[1:] {
			row := make(map[string]interface{ })
			for i, val := range record {
				if i < len(headers) {
					if val == "NULL" {
						row[headers[i]] = nil
					} else {
						row[headers[i]] = val
					}
				}
			}
			rows = append(rows, row)
		}
	} else {
		return connection.QueryResult{Success: false, Message: "Unsupported file format"}
	}

	if len(rows) == 0 {
		return connection.QueryResult{Success: true, Message: "No data to import"}
	}

	runConfig := normalizeRunConfig(config, dbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	successCount := 0
	errCount := 0
	firstRow := rows[0]
	var cols []string
	for k := range firstRow {
		cols = append(cols, k)
	}
	
	for _, row := range rows {
		var values []string
		for _, col := range cols {
			val := row[col]
			if val == nil {
				values = append(values, "NULL")
			} else {
				vStr := fmt.Sprintf("%v", val)
				vStr = strings.ReplaceAll(vStr, "'", "''")
				values = append(values, fmt.Sprintf("'%s'", vStr))
			}
		}
		quotedCols := make([]string, len(cols))
		for i, c := range cols {
			quotedCols[i] = quoteIdentByType(runConfig.Type, c)
		}

		query := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)",
			quoteQualifiedIdentByType(runConfig.Type, tableName),
			strings.Join(quotedCols, ", "),
			strings.Join(values, ", "))

		_, err := dbInst.Exec(query)
		if err != nil {
			errCount++
			logger.Error(err, "导入数据失败：表=%s", tableName)
		} else {
			successCount++
		}
	}

	return connection.QueryResult{Success: true, Message: fmt.Sprintf("Imported: %d, Failed: %d", successCount, errCount)}
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
		if err := dumpTableSQL(w, dbInst, runConfig, dbName, tableName, true); err != nil {
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
	safeDbName := strings.TrimSpace(dbName)
	if safeDbName == "" {
		safeDbName = "export"
	}
	suffix := "schema"
	if includeData {
		suffix = "backup"
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
		if err := dumpTableSQL(w, dbInst, runConfig, dbName, t, includeData); err != nil {
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
		if err := dumpTableSQL(w, dbInst, runConfig, dbName, t, includeData); err != nil {
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
	case "mysql":
		return "`" + strings.ReplaceAll(ident, "`", "``") + "`"
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

func dumpTableSQL(w *bufio.Writer, dbInst db.Database, config connection.ConnectionConfig, dbName, tableName string, includeData bool) error {
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

	var csvWriter *csv.Writer
	var jsonEncoder *json.Encoder
	isJsonFirstRow := true

	switch format {
	case "csv", "xlsx":
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

			s := fmt.Sprintf("%v", val)
			if format == "md" {
				s = strings.ReplaceAll(s, "|", "\\|")
				s = strings.ReplaceAll(s, "\n", "<br>")
			}
			record[i] = s
		}

		switch format {
		case "csv", "xlsx":
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

	if format == "csv" || format == "xlsx" {
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
