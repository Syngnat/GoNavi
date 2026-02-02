package main

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App struct
type App struct {
	ctx     context.Context
	dbCache map[string]Database // Cache for DB connections
	mu      sync.Mutex          // Mutex for cache access
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		dbCache: make(map[string]Database),
	}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// shutdown is called when the app terminates
func (a *App) shutdown(ctx context.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, db := range a.dbCache {
		db.Close()
	}
}

type ConnectionConfig struct {
	Type     string    `json:"type"`
	Host     string    `json:"host"`
	Port     int       `json:"port"`
	User     string    `json:"user"`
	Password string    `json:"password"`
	Database string    `json:"database"`
	UseSSH   bool      `json:"useSSH"`
	SSH      SSHConfig `json:"ssh"`
}

type QueryResult struct {
	Success bool                   `json:"success"`
	Message string                 `json:"message"`
	Data    interface{}            `json:"data"`
	Fields  []string               `json:"fields,omitempty"`
}

// Helper: Generate a unique key for the connection config
func getCacheKey(config ConnectionConfig) string {
	// Include DB type, host, port, user, db name (and SSH params if relevant)
	return fmt.Sprintf("%s|%s|%s:%d|%s|%s|%v", config.Type, config.User, config.Host, config.Port, config.Database, config.SSH.Host, config.UseSSH)
}

// Helper: Get or create a database connection
func (a *App) getDatabase(config ConnectionConfig) (Database, error) {
	key := getCacheKey(config)

	a.mu.Lock()
	defer a.mu.Unlock()

	if db, ok := a.dbCache[key]; ok {
		// Verify connection is still alive
		if err := db.Ping(); err == nil {
			return db, nil
		}
		// If ping fails, close and remove to reconnect
		db.Close()
		delete(a.dbCache, key)
	}

	// Create new connection
	db, err := NewDatabase(config.Type)
	if err != nil {
		return nil, err
	}

	if err := db.Connect(config); err != nil {
		return nil, err
	}

	a.dbCache[key] = db
	return db, nil
}

// Generic DB Methods

func (a *App) DBConnect(config ConnectionConfig) QueryResult {
	// Force reconnection or just check/create
	// We can remove old connection if exists to force reconnect
	key := getCacheKey(config)
	a.mu.Lock()
	if oldDB, ok := a.dbCache[key]; ok {
		oldDB.Close()
		delete(a.dbCache, key)
	}
	_, err := a.getDatabase(config)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}
	
	// getDatabase already connects, so just return success
	return QueryResult{Success: true, Message: "Connected successfully"}
}

// CreateDatabase creates a new database
func (a *App) CreateDatabase(config ConnectionConfig, dbName string) QueryResult {
	runConfig := config
	runConfig.Database = "" // Connect to server root

	db, err := a.getDatabase(runConfig)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}

	query := fmt.Sprintf("CREATE DATABASE `%s` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci", dbName)
	if runConfig.Type == "postgres" {
		query = fmt.Sprintf("CREATE DATABASE \"%s\"", dbName)
	}

	_, err = db.Exec(query)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}

	return QueryResult{Success: true, Message: "Database created successfully"}
}

// Backwards Compatibility Wrappers

func (a *App) MySQLConnect(config ConnectionConfig) QueryResult {
	config.Type = "mysql"
	return a.DBConnect(config)
}

func (a *App) MySQLQuery(config ConnectionConfig, dbName string, query string) QueryResult {
	config.Type = "mysql"
	return a.DBQuery(config, dbName, query)
}

func (a *App) MySQLGetDatabases(config ConnectionConfig) QueryResult {
	config.Type = "mysql"
	return a.DBGetDatabases(config)
}

func (a *App) MySQLGetTables(config ConnectionConfig, dbName string) QueryResult {
	config.Type = "mysql"
	return a.DBGetTables(config, dbName)
}

func (a *App) MySQLShowCreateTable(config ConnectionConfig, dbName string, tableName string) QueryResult {
	config.Type = "mysql"
	return a.DBShowCreateTable(config, dbName, tableName)
}

// DBQuery executes a query
func (a *App) DBQuery(config ConnectionConfig, dbName string, query string) QueryResult {
	runConfig := config
	if dbName != "" {
		runConfig.Database = dbName
	}

	db, err := a.getDatabase(runConfig)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}
	// Do NOT defer db.Close() here, as we cache it

	// Check if it's a SELECT query
	lowerQuery := strings.TrimSpace(strings.ToLower(query))
	if strings.HasPrefix(lowerQuery, "select") || strings.HasPrefix(lowerQuery, "show") || strings.HasPrefix(lowerQuery, "describe") || strings.HasPrefix(lowerQuery, "explain") {
		data, columns, err := db.Query(query)
		if err != nil {
			return QueryResult{Success: false, Message: err.Error()}
		}
		return QueryResult{Success: true, Data: data, Fields: columns}
	} else {
		// Exec
		affected, err := db.Exec(query)
		if err != nil {
			return QueryResult{Success: false, Message: err.Error()}
		}
		return QueryResult{Success: true, Data: map[string]int64{"affectedRows": affected}}
	}
}

// DBGetDatabases returns a list of databases
func (a *App) DBGetDatabases(config ConnectionConfig) QueryResult {
	db, err := a.getDatabase(config)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}

	dbs, err := db.GetDatabases()
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}
	
	var resData []map[string]string
	for _, name := range dbs {
		resData = append(resData, map[string]string{"Database": name})
	}
	
	return QueryResult{Success: true, Data: resData}
}

// DBGetTables returns a list of tables
func (a *App) DBGetTables(config ConnectionConfig, dbName string) QueryResult {
	runConfig := config
	if dbName != "" {
		runConfig.Database = dbName
	}

	db, err := a.getDatabase(runConfig)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}

	tables, err := db.GetTables(dbName)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}

	var resData []map[string]string
	for _, name := range tables {
		resData = append(resData, map[string]string{"Table": name})
	}

	return QueryResult{Success: true, Data: resData}
}

// DBShowCreateTable returns the create statement
func (a *App) DBShowCreateTable(config ConnectionConfig, dbName string, tableName string) QueryResult {
	runConfig := config
	if dbName != "" {
		runConfig.Database = dbName
	}

	db, err := a.getDatabase(runConfig)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}

	sqlStr, err := db.GetCreateStatement(dbName, tableName)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}

	return QueryResult{Success: true, Data: sqlStr}
}

// DBGetColumns returns column definitions
func (a *App) DBGetColumns(config ConnectionConfig, dbName string, tableName string) QueryResult {
	runConfig := config
	if dbName != "" {
		runConfig.Database = dbName
	}

	db, err := a.getDatabase(runConfig)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}

	columns, err := db.GetColumns(dbName, tableName)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}

	return QueryResult{Success: true, Data: columns}
}

// DBGetIndexes returns index definitions
func (a *App) DBGetIndexes(config ConnectionConfig, dbName string, tableName string) QueryResult {
	runConfig := config
	if dbName != "" {
		runConfig.Database = dbName
	}

	db, err := a.getDatabase(runConfig)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}

	indexes, err := db.GetIndexes(dbName, tableName)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}

	return QueryResult{Success: true, Data: indexes}
}

// DBGetForeignKeys returns foreign key definitions
func (a *App) DBGetForeignKeys(config ConnectionConfig, dbName string, tableName string) QueryResult {
	runConfig := config
	if dbName != "" {
		runConfig.Database = dbName
	}

	db, err := a.getDatabase(runConfig)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}

	fks, err := db.GetForeignKeys(dbName, tableName)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}

	return QueryResult{Success: true, Data: fks}
}

// DBGetTriggers returns trigger definitions
func (a *App) DBGetTriggers(config ConnectionConfig, dbName string, tableName string) QueryResult {
	runConfig := config
	if dbName != "" {
		runConfig.Database = dbName
	}

	db, err := a.getDatabase(runConfig)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}

	triggers, err := db.GetTriggers(dbName, tableName)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}

	return QueryResult{Success: true, Data: triggers}
}

// DBGetAllColumns returns all columns for all tables in a database (for autocomplete)
func (a *App) DBGetAllColumns(config ConnectionConfig, dbName string) QueryResult {
	runConfig := config
	if dbName != "" {
		runConfig.Database = dbName
	}

	db, err := a.getDatabase(runConfig)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}

	cols, err := db.GetAllColumns(dbName)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}

	return QueryResult{Success: true, Data: cols}
}

// OpenSQLFile opens a file dialog and returns the file content
func (a *App) OpenSQLFile() QueryResult {
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
		return QueryResult{Success: false, Message: err.Error()}
	}

	if selection == "" {
		return QueryResult{Success: false, Message: "Cancelled"}
	}

	content, err := os.ReadFile(selection)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}

	return QueryResult{Success: true, Data: string(content)}
}

// ImportData imports data from CSV/JSON file into an existing table
func (a *App) ImportData(config ConnectionConfig, dbName, tableName string) QueryResult {
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
		return QueryResult{Success: false, Message: err.Error()}
	}

	if selection == "" {
		return QueryResult{Success: false, Message: "Cancelled"}
	}

	// Read File
	f, err := os.Open(selection)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}
	defer f.Close()

	// Parse based on extension
	var rows []map[string]interface{}
	
	if strings.HasSuffix(strings.ToLower(selection), ".json") {
		decoder := json.NewDecoder(f)
		if err := decoder.Decode(&rows); err != nil {
			return QueryResult{Success: false, Message: "JSON Parse Error: " + err.Error()}
		}
	} else if strings.HasSuffix(strings.ToLower(selection), ".csv") {
		reader := csv.NewReader(f)
		records, err := reader.ReadAll()
		if err != nil {
			return QueryResult{Success: false, Message: "CSV Parse Error: " + err.Error()}
		}
		if len(records) < 2 {
			return QueryResult{Success: false, Message: "CSV empty or missing header"}
		}
		headers := records[0]
		for _, record := range records[1:] {
			row := make(map[string]interface{})
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
							}	} else {
		return QueryResult{Success: false, Message: "Unsupported file format"}
	}

	if len(rows) == 0 {
		return QueryResult{Success: true, Message: "No data to import"}
	}

	// Connect to DB (Using cached connection)
	runConfig := config
	if dbName != "" {
		runConfig.Database = dbName
	}
	db, err := a.getDatabase(runConfig)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}
	// No defer close

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
             for i, c := range cols { pgCols[i] = fmt.Sprintf(`"%s"`, c) }
             query = fmt.Sprintf(`INSERT INTO "%s" (%s) VALUES (%s)`,
                tableName, 
                strings.Join(pgCols, ", "), 
                strings.Join(values, ", "))
		}

		_, err := db.Exec(query)
		if err != nil {
			errCount++
			fmt.Println("Import Error:", err)
		} else {
			successCount++
		}
	}

	return QueryResult{Success: true, Message: fmt.Sprintf("Imported: %d, Failed: %d", successCount, errCount)}
}

// ApplyChanges executes a batch of Insert/Update/Delete operations
func (a *App) ApplyChanges(config ConnectionConfig, dbName, tableName string, changes ChangeSet) QueryResult {
	runConfig := config
	if dbName != "" {
		runConfig.Database = dbName
	}

	db, err := a.getDatabase(runConfig)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}
	
	if applier, ok := db.(BatchApplier); ok {
		err := applier.ApplyChanges(tableName, changes)
		if err != nil {
			return QueryResult{Success: false, Message: err.Error()}
		}
		return QueryResult{Success: true, Message: "Changes applied successfully"}
	}
	
	return QueryResult{Success: false, Message: "Batch updates not supported for this database type"}
}

// ExportTable
func (a *App) ExportTable(config ConnectionConfig, dbName string, tableName string, format string) QueryResult {
	filename, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           fmt.Sprintf("Export %s", tableName),
		DefaultFilename: fmt.Sprintf("%s.%s", tableName, format),
	})

	if err != nil || filename == "" {
		return QueryResult{Success: false, Message: "Cancelled"}
	}

	runConfig := config
	if dbName != "" {
		runConfig.Database = dbName
	}
	
dbObj, err := a.getDatabase(runConfig)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}

	query := fmt.Sprintf("SELECT * FROM `%s`", tableName)
	if runConfig.Type == "postgres" {
		query = fmt.Sprintf("SELECT * FROM \"%s\"", tableName)
	}
	
data, columns, err := dbObj.Query(query)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
	}

	f, err := os.Create(filename)
	if err != nil {
		return QueryResult{Success: false, Message: err.Error()}
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
			return QueryResult{Success: false, Message: err.Error()}
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
		return QueryResult{Success: false, Message: "Unsupported format: " + format}
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
				return QueryResult{Success: false, Message: "Write error: " + err.Error()}
			}
		case "json":
			if !isJsonFirstRow {
				f.WriteString(",\n")
			}
			if err := jsonEncoder.Encode(rowMap); err != nil {
				return QueryResult{Success: false, Message: "Write error: " + err.Error()}
			}
			isJsonFirstRow = false
		case "md":
			fmt.Fprintf(f, "| %s |\n", strings.Join(record, " | "))
		}
	}

	if format == "json" {
		f.WriteString("\n]")
	}

	return QueryResult{Success: true, Message: "Export successful"}
}
