package app

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"os"
	"strings"

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

	runConfig := config
	if dbName != "" {
		runConfig.Database = dbName
	}
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
		
		query := fmt.Sprintf("INSERT INTO `%s` (%s) VALUES (%s)", 
			tableName, 
			strings.Join(cols, ", "), 
			strings.Join(values, ", "))
		
		if runConfig.Type == "postgres" {
             pgCols := make([]string, len(cols))
             for i, c := range cols { pgCols[i] = fmt.Sprintf("\"%s\"", c) }
             query = fmt.Sprintf("INSERT INTO \"%s\" (%s) VALUES (%s)",
                tableName, 
                strings.Join(pgCols, ", "), 
                strings.Join(values, ", "))
		}

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
	runConfig := config
	if dbName != "" {
		runConfig.Database = dbName
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	
	if applier, ok := dbInst.(db.BatchApplier); ok {
		err := applier.ApplyChanges(tableName, changes)
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		return connection.QueryResult{Success: true, Message: "Changes applied successfully"}
	}
	
	return connection.QueryResult{Success: false, Message: "Batch updates not supported for this database type"}
}

func (a *App) ExportTable(config connection.ConnectionConfig, dbName string, tableName string, format string) connection.QueryResult {
	filename, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           fmt.Sprintf("Export %s", tableName),
		DefaultFilename: fmt.Sprintf("%s.%s", tableName, format),
	})

	if err != nil || filename == "" {
		return connection.QueryResult{Success: false, Message: "Cancelled"}
	}

	runConfig := config
	if dbName != "" {
		runConfig.Database = dbName
	}
	
dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	query := fmt.Sprintf("SELECT * FROM `%s`", tableName)
	if runConfig.Type == "postgres" {
		query = fmt.Sprintf("SELECT * FROM \"%s\"", tableName)
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

	format = strings.ToLower(format)
	var csvWriter *csv.Writer
	var jsonEncoder *json.Encoder
	var isJsonFirstRow = true

	switch format {
	case "csv", "xlsx":
		f.Write([]byte{0xEF, 0xBB, 0xBF})
		csvWriter = csv.NewWriter(f)
		defer csvWriter.Flush()
		if err := csvWriter.Write(columns); err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	case "json":
		f.WriteString("[\n")
		jsonEncoder = json.NewEncoder(f)
		jsonEncoder.SetIndent("  ", "  ")
	case "md":
		fmt.Fprintf(f, "| %s |\n", strings.Join(columns, " | "))
		seps := make([]string, len(columns))
		for i := range seps {
			seps[i] = "---"
		}
		fmt.Fprintf(f, "| %s |\n", strings.Join(seps, " | "))
	default:
		return connection.QueryResult{Success: false, Message: "Unsupported format: " + format}
	}

	for _, rowMap := range data {
		record := make([]string, len(columns))
		for i, col := range columns {
			val := rowMap[col]
			if val == nil {
				record[i] = "NULL"
			} else {
				s := fmt.Sprintf("%v", val)
				if format == "md" {
					s = strings.ReplaceAll(s, "|", "\\|")
					s = strings.ReplaceAll(s, "\n", "<br>")
				}
				record[i] = s
			}
		}

		switch format {
		case "csv", "xlsx":
			if err := csvWriter.Write(record); err != nil {
				return connection.QueryResult{Success: false, Message: "Write error: " + err.Error()}
			}
		case "json":
			if !isJsonFirstRow {
				f.WriteString(",\n")
			}
			if err := jsonEncoder.Encode(rowMap); err != nil {
				return connection.QueryResult{Success: false, Message: "Write error: " + err.Error()}
			}
			isJsonFirstRow = false
		case "md":
			fmt.Fprintf(f, "| %s |\n", strings.Join(record, " | "))
		}
	}

	if format == "json" {
		f.WriteString("\n]")
	}

	return connection.QueryResult{Success: true, Message: "Export successful"}
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

	format = strings.ToLower(format)
	var csvWriter *csv.Writer
	var jsonEncoder *json.Encoder
	var isJsonFirstRow = true

	switch format {
	case "csv", "xlsx":
		f.Write([]byte{0xEF, 0xBB, 0xBF})
		csvWriter = csv.NewWriter(f)
		defer csvWriter.Flush()
		if err := csvWriter.Write(columns); err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	case "json":
		f.WriteString("[\n")
		jsonEncoder = json.NewEncoder(f)
		jsonEncoder.SetIndent("  ", "  ")
	case "md":
		fmt.Fprintf(f, "| %s |\n", strings.Join(columns, " | "))
		seps := make([]string, len(columns))
		for i := range seps {
			seps[i] = "---"
		}
		fmt.Fprintf(f, "| %s |\n", strings.Join(seps, " | "))
	default:
		return connection.QueryResult{Success: false, Message: "Unsupported format: " + format}
	}

	for _, rowMap := range data {
		record := make([]string, len(columns))
		for i, col := range columns {
			val := rowMap[col]
			if val == nil {
				record[i] = "NULL"
			} else {
				s := fmt.Sprintf("%v", val)
				if format == "md" {
					s = strings.ReplaceAll(s, "|", "\\|")
					s = strings.ReplaceAll(s, "\n", "<br>")
				}
				record[i] = s
			}
		}

		switch format {
		case "csv", "xlsx":
			if err := csvWriter.Write(record); err != nil {
				return connection.QueryResult{Success: false, Message: "Write error: " + err.Error()}
			}
		case "json":
			if !isJsonFirstRow {
				f.WriteString(",\n")
			}
			if err := jsonEncoder.Encode(rowMap); err != nil {
				return connection.QueryResult{Success: false, Message: "Write error: " + err.Error()}
			}
			isJsonFirstRow = false
		case "md":
			fmt.Fprintf(f, "| %s |\n", strings.Join(record, " | "))
		}
	}

	if format == "json" {
		f.WriteString("\n]")
	}

	return connection.QueryResult{Success: true, Message: "Export successful"}
}
