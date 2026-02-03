package app

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

// Generic DB Methods

func (a *App) DBConnect(config connection.ConnectionConfig) connection.QueryResult {
	// getDatabase checks cache and Pings. If valid, reuses. If not, connects.
	_, err := a.getDatabase(config)
	if err != nil {
		logger.Error(err, "DBConnect 连接失败：%s", formatConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	
	logger.Infof("DBConnect 连接成功：%s", formatConnSummary(config))
	return connection.QueryResult{Success: true, Message: "连接成功"}
}

func (a *App) TestConnection(config connection.ConnectionConfig) connection.QueryResult {
	_, err := a.getDatabase(config)
	if err != nil {
		logger.Error(err, "TestConnection 连接测试失败：%s", formatConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	
	logger.Infof("TestConnection 连接测试成功：%s", formatConnSummary(config))
	return connection.QueryResult{Success: true, Message: "连接成功"}
}

func (a *App) CreateDatabase(config connection.ConnectionConfig, dbName string) connection.QueryResult {
	runConfig := config
	runConfig.Database = "" 

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	escapedDbName := strings.ReplaceAll(dbName, "`", "``")
	query := fmt.Sprintf("CREATE DATABASE `%s` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci", escapedDbName)
	if runConfig.Type == "postgres" {
		escapedDbName = strings.ReplaceAll(dbName, `"`, `""`)
		query = fmt.Sprintf("CREATE DATABASE \"%s\"", escapedDbName)
	}

	_, err = dbInst.Exec(query)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: "Database created successfully"}
}

func (a *App) MySQLConnect(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "mysql"
	return a.DBConnect(config)
}

func (a *App) MySQLQuery(config connection.ConnectionConfig, dbName string, query string) connection.QueryResult {
	config.Type = "mysql"
	return a.DBQuery(config, dbName, query)
}

func (a *App) MySQLGetDatabases(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "mysql"
	return a.DBGetDatabases(config)
}

func (a *App) MySQLGetTables(config connection.ConnectionConfig, dbName string) connection.QueryResult {
	config.Type = "mysql"
	return a.DBGetTables(config, dbName)
}

func (a *App) MySQLShowCreateTable(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	config.Type = "mysql"
	return a.DBShowCreateTable(config, dbName, tableName)
}

func (a *App) DBQuery(config connection.ConnectionConfig, dbName string, query string) connection.QueryResult {
	runConfig := config
	if dbName != "" {
		runConfig.Database = dbName
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBQuery 获取连接失败：%s", formatConnSummary(runConfig))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	lowerQuery := strings.TrimSpace(strings.ToLower(query))
	if strings.HasPrefix(lowerQuery, "select") || strings.HasPrefix(lowerQuery, "show") || strings.HasPrefix(lowerQuery, "describe") || strings.HasPrefix(lowerQuery, "explain") {
		data, columns, err := dbInst.Query(query)
		if err != nil {
			logger.Error(err, "DBQuery 查询失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		return connection.QueryResult{Success: true, Data: data, Fields: columns}
	} else {
		affected, err := dbInst.Exec(query)
		if err != nil {
			logger.Error(err, "DBQuery 执行失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		return connection.QueryResult{Success: true, Data: map[string]int64{"affectedRows": affected}}
	}
}

func sqlSnippet(query string) string {
	q := strings.TrimSpace(query)
	const max = 200
	if len(q) <= max {
		return q
	}
	return q[:max] + "..."
}

func (a *App) DBGetDatabases(config connection.ConnectionConfig) connection.QueryResult {
	dbInst, err := a.getDatabase(config)
	if err != nil {
		logger.Error(err, "DBGetDatabases 获取连接失败：%s", formatConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	dbs, err := dbInst.GetDatabases()
	if err != nil {
		logger.Error(err, "DBGetDatabases 获取数据库列表失败：%s", formatConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	
	var resData []map[string]string
	for _, name := range dbs {
		resData = append(resData, map[string]string{"Database": name})
	}
	
	return connection.QueryResult{Success: true, Data: resData}
}

func (a *App) DBGetTables(config connection.ConnectionConfig, dbName string) connection.QueryResult {
	runConfig := config
	if dbName != "" {
		runConfig.Database = dbName
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBGetTables 获取连接失败：%s", formatConnSummary(runConfig))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	tables, err := dbInst.GetTables(dbName)
	if err != nil {
		logger.Error(err, "DBGetTables 获取表列表失败：%s", formatConnSummary(runConfig))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	var resData []map[string]string
	for _, name := range tables {
		resData = append(resData, map[string]string{"Table": name})
	}

	return connection.QueryResult{Success: true, Data: resData}
}

func (a *App) DBShowCreateTable(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	runConfig := config
	if dbName != "" {
		runConfig.Database = dbName
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBShowCreateTable 获取连接失败：%s", formatConnSummary(runConfig))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	sqlStr, err := dbInst.GetCreateStatement(dbName, tableName)
	if err != nil {
		logger.Error(err, "DBShowCreateTable 获取建表语句失败：%s 表=%s", formatConnSummary(runConfig), tableName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: sqlStr}
}

func (a *App) DBGetColumns(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	runConfig := config
	if dbName != "" {
		runConfig.Database = dbName
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	columns, err := dbInst.GetColumns(dbName, tableName)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: columns}
}

func (a *App) DBGetIndexes(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	runConfig := config
	if dbName != "" {
		runConfig.Database = dbName
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	indexes, err := dbInst.GetIndexes(dbName, tableName)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: indexes}
}

func (a *App) DBGetForeignKeys(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	runConfig := config
	if dbName != "" {
		runConfig.Database = dbName
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	fks, err := dbInst.GetForeignKeys(dbName, tableName)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: fks}
}

func (a *App) DBGetTriggers(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	runConfig := config
	if dbName != "" {
		runConfig.Database = dbName
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	triggers, err := dbInst.GetTriggers(dbName, tableName)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: triggers}
}

func (a *App) DBGetAllColumns(config connection.ConnectionConfig, dbName string) connection.QueryResult {
	runConfig := config
	if dbName != "" {
		runConfig.Database = dbName
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	cols, err := dbInst.GetAllColumns(dbName)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: cols}
}
