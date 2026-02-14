package app

import (
	"context"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/utils"
)

// Generic DB Methods

func (a *App) DBConnect(config connection.ConnectionConfig) connection.QueryResult {
	// 连接测试需要强制 ping，避免缓存命中但连接已失效时误判成功。
	_, err := a.getDatabaseForcePing(config)
	if err != nil {
		logger.Error(err, "DBConnect 连接失败：%s", formatConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	logger.Infof("DBConnect 连接成功：%s", formatConnSummary(config))
	return connection.QueryResult{Success: true, Message: "连接成功"}
}

func (a *App) TestConnection(config connection.ConnectionConfig) connection.QueryResult {
	_, err := a.getDatabaseForcePing(config)
	if err != nil {
		logger.Error(err, "TestConnection 连接测试失败：%s", formatConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	logger.Infof("TestConnection 连接测试成功：%s", formatConnSummary(config))
	return connection.QueryResult{Success: true, Message: "连接成功"}
}

func (a *App) MongoDiscoverMembers(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "mongodb"

	dbInst, err := a.getDatabaseForcePing(config)
	if err != nil {
		logger.Error(err, "MongoDiscoverMembers 获取连接失败：%s", formatConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	discoverable, ok := dbInst.(interface {
		DiscoverMembers() (string, []connection.MongoMemberInfo, error)
	})
	if !ok {
		return connection.QueryResult{Success: false, Message: "当前 MongoDB 驱动不支持成员发现"}
	}

	replicaSet, members, err := discoverable.DiscoverMembers()
	if err != nil {
		logger.Error(err, "MongoDiscoverMembers 执行失败：%s", formatConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	data := map[string]interface{}{
		"replicaSet": replicaSet,
		"members":    members,
	}

	logger.Infof("MongoDiscoverMembers 成功：%s 成员数=%d 副本集=%s", formatConnSummary(config), len(members), replicaSet)
	return connection.QueryResult{
		Success: true,
		Message: fmt.Sprintf("发现 %d 个成员", len(members)),
		Data:    data,
	}
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
	dbType := strings.ToLower(strings.TrimSpace(runConfig.Type))
	if dbType == "postgres" || dbType == "kingbase" || dbType == "highgo" || dbType == "vastbase" {
		escapedDbName = strings.ReplaceAll(dbName, `"`, `""`)
		query = fmt.Sprintf("CREATE DATABASE \"%s\"", escapedDbName)
	} else if dbType == "tdengine" {
		query = fmt.Sprintf("CREATE DATABASE IF NOT EXISTS %s", quoteIdentByType(dbType, dbName))
	} else if dbType == "mariadb" || dbType == "diros" {
		// MariaDB uses same syntax as MySQL
	} else if dbType == "sphinx" {
		return connection.QueryResult{Success: false, Message: "Sphinx 暂不支持创建数据库"}
	}

	_, err = dbInst.Exec(query)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: "Database created successfully"}
}

func resolveDDLDBType(config connection.ConnectionConfig) string {
	dbType := strings.ToLower(strings.TrimSpace(config.Type))
	if dbType != "custom" {
		return dbType
	}

	driver := strings.ToLower(strings.TrimSpace(config.Driver))
	switch driver {
	case "postgresql":
		return "postgres"
	case "dm":
		return "dameng"
	case "sqlite3":
		return "sqlite"
	case "sphinxql":
		return "sphinx"
	case "diros", "doris":
		return "diros"
	default:
		return driver
	}
}

func normalizeSchemaAndTableByType(dbType string, dbName string, tableName string) (string, string) {
	rawTable := strings.TrimSpace(tableName)
	rawDB := strings.TrimSpace(dbName)
	if rawTable == "" {
		return rawDB, rawTable
	}

	if parts := strings.SplitN(rawTable, ".", 2); len(parts) == 2 {
		schema := strings.TrimSpace(parts[0])
		table := strings.TrimSpace(parts[1])
		if schema != "" && table != "" {
			return schema, table
		}
	}

	switch dbType {
	case "postgres", "kingbase", "highgo", "vastbase":
		return "public", rawTable
	default:
		return rawDB, rawTable
	}
}

func quoteTableIdentByType(dbType string, schema string, table string) string {
	s := strings.TrimSpace(schema)
	t := strings.TrimSpace(table)
	if s == "" {
		return quoteIdentByType(dbType, t)
	}
	return fmt.Sprintf("%s.%s", quoteIdentByType(dbType, s), quoteIdentByType(dbType, t))
}

func buildRunConfigForDDL(config connection.ConnectionConfig, dbType string, dbName string) connection.ConnectionConfig {
	runConfig := normalizeRunConfig(config, dbName)
	if strings.EqualFold(strings.TrimSpace(config.Type), "custom") {
		// custom 连接的 dbName 语义依赖 driver，尽量在常见驱动上对齐内置类型行为。
		switch dbType {
		case "mysql", "mariadb", "diros", "sphinx", "postgres", "kingbase", "vastbase", "dameng":
			if strings.TrimSpace(dbName) != "" {
				runConfig.Database = strings.TrimSpace(dbName)
			}
		}
	}
	return runConfig
}

func (a *App) RenameDatabase(config connection.ConnectionConfig, oldName string, newName string) connection.QueryResult {
	oldName = strings.TrimSpace(oldName)
	newName = strings.TrimSpace(newName)
	if oldName == "" || newName == "" {
		return connection.QueryResult{Success: false, Message: "数据库名称不能为空"}
	}
	if strings.EqualFold(oldName, newName) {
		return connection.QueryResult{Success: false, Message: "新旧数据库名称不能相同"}
	}

	dbType := resolveDDLDBType(config)
	switch dbType {
	case "mysql", "mariadb", "diros", "sphinx":
		return connection.QueryResult{Success: false, Message: "MySQL/MariaDB/Diros/Sphinx 不支持直接重命名数据库，请新建库后迁移数据"}
	case "postgres", "kingbase", "highgo", "vastbase":
		if strings.EqualFold(strings.TrimSpace(config.Database), oldName) {
			return connection.QueryResult{Success: false, Message: "当前连接正在使用目标数据库，请先连接到其他数据库后再重命名"}
		}
		runConfig := config
		if strings.TrimSpace(runConfig.Database) == "" {
			runConfig.Database = "postgres"
		}
		dbInst, err := a.getDatabase(runConfig)
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		sql := fmt.Sprintf("ALTER DATABASE %s RENAME TO %s", quoteIdentByType(dbType, oldName), quoteIdentByType(dbType, newName))
		if _, err := dbInst.Exec(sql); err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		return connection.QueryResult{Success: true, Message: "数据库重命名成功"}
	default:
		return connection.QueryResult{Success: false, Message: fmt.Sprintf("当前数据源(%s)暂不支持重命名数据库", dbType)}
	}
}

func (a *App) DropDatabase(config connection.ConnectionConfig, dbName string) connection.QueryResult {
	dbName = strings.TrimSpace(dbName)
	if dbName == "" {
		return connection.QueryResult{Success: false, Message: "数据库名称不能为空"}
	}

	dbType := resolveDDLDBType(config)
	var (
		runConfig connection.ConnectionConfig
		sql       string
	)
	switch dbType {
	case "mysql", "mariadb", "diros", "tdengine":
		runConfig = config
		runConfig.Database = ""
		sql = fmt.Sprintf("DROP DATABASE %s", quoteIdentByType(dbType, dbName))
	case "postgres", "kingbase", "highgo", "vastbase":
		if strings.EqualFold(strings.TrimSpace(config.Database), dbName) {
			return connection.QueryResult{Success: false, Message: "当前连接正在使用目标数据库，请先连接到其他数据库后再删除"}
		}
		runConfig = config
		if strings.TrimSpace(runConfig.Database) == "" {
			runConfig.Database = "postgres"
		}
		sql = fmt.Sprintf("DROP DATABASE %s", quoteIdentByType(dbType, dbName))
	default:
		return connection.QueryResult{Success: false, Message: fmt.Sprintf("当前数据源(%s)暂不支持删除数据库", dbType)}
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if _, err := dbInst.Exec(sql); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: "数据库删除成功"}
}

func (a *App) RenameTable(config connection.ConnectionConfig, dbName string, oldTableName string, newTableName string) connection.QueryResult {
	oldTableName = strings.TrimSpace(oldTableName)
	newTableName = strings.TrimSpace(newTableName)
	if oldTableName == "" || newTableName == "" {
		return connection.QueryResult{Success: false, Message: "表名不能为空"}
	}
	if strings.EqualFold(oldTableName, newTableName) {
		return connection.QueryResult{Success: false, Message: "新旧表名不能相同"}
	}
	if strings.Contains(newTableName, ".") {
		return connection.QueryResult{Success: false, Message: "新表名不能包含 schema 或数据库前缀"}
	}

	dbType := resolveDDLDBType(config)
	switch dbType {
	case "mysql", "mariadb", "diros", "sphinx", "postgres", "kingbase", "sqlite", "duckdb", "oracle", "dameng", "highgo", "vastbase", "sqlserver":
	default:
		return connection.QueryResult{Success: false, Message: fmt.Sprintf("当前数据源(%s)暂不支持重命名表", dbType)}
	}

	schemaName, pureOldTableName := normalizeSchemaAndTableByType(dbType, dbName, oldTableName)
	if pureOldTableName == "" {
		return connection.QueryResult{Success: false, Message: "旧表名不能为空"}
	}
	oldQualifiedTable := quoteTableIdentByType(dbType, schemaName, pureOldTableName)
	newTableQuoted := quoteIdentByType(dbType, newTableName)

	var sql string
	switch dbType {
	case "mysql", "mariadb", "diros", "sphinx":
		newQualifiedTable := quoteTableIdentByType(dbType, schemaName, newTableName)
		sql = fmt.Sprintf("RENAME TABLE %s TO %s", oldQualifiedTable, newQualifiedTable)
	case "sqlserver":
		// SQL Server 使用 sp_rename，参数为 'schema.oldname', 'newname'
		oldFullName := schemaName + "." + pureOldTableName
		escapedOld := strings.ReplaceAll(oldFullName, "'", "''")
		escapedNew := strings.ReplaceAll(newTableName, "'", "''")
		sql = fmt.Sprintf("EXEC sp_rename '%s', '%s'", escapedOld, escapedNew)
	default:
		sql = fmt.Sprintf("ALTER TABLE %s RENAME TO %s", oldQualifiedTable, newTableQuoted)
	}

	runConfig := buildRunConfigForDDL(config, dbType, dbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if _, err := dbInst.Exec(sql); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: "表重命名成功"}
}

func (a *App) DropTable(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	tableName = strings.TrimSpace(tableName)
	if tableName == "" {
		return connection.QueryResult{Success: false, Message: "表名不能为空"}
	}

	dbType := resolveDDLDBType(config)
	switch dbType {
	case "mysql", "mariadb", "diros", "sphinx", "postgres", "kingbase", "sqlite", "duckdb", "oracle", "dameng", "highgo", "vastbase", "sqlserver", "tdengine":
	default:
		return connection.QueryResult{Success: false, Message: fmt.Sprintf("当前数据源(%s)暂不支持删除表", dbType)}
	}

	schemaName, pureTableName := normalizeSchemaAndTableByType(dbType, dbName, tableName)
	if pureTableName == "" {
		return connection.QueryResult{Success: false, Message: "表名不能为空"}
	}
	qualifiedTable := quoteTableIdentByType(dbType, schemaName, pureTableName)
	sql := fmt.Sprintf("DROP TABLE %s", qualifiedTable)

	runConfig := buildRunConfigForDDL(config, dbType, dbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if _, err := dbInst.Exec(sql); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: "表删除成功"}
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
	runConfig := normalizeRunConfig(config, dbName)

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBQuery 获取连接失败：%s", formatConnSummary(runConfig))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	query = sanitizeSQLForPgLike(runConfig.Type, query)
	timeoutSeconds := runConfig.Timeout
	if timeoutSeconds <= 0 {
		timeoutSeconds = 30
	}
	ctx, cancel := utils.ContextWithTimeout(time.Duration(timeoutSeconds) * time.Second)
	defer cancel()

	lowerQuery := strings.TrimSpace(strings.ToLower(query))
	isReadQuery := strings.HasPrefix(lowerQuery, "select") || strings.HasPrefix(lowerQuery, "show") || strings.HasPrefix(lowerQuery, "describe") || strings.HasPrefix(lowerQuery, "explain")
	// MongoDB JSON 命令中的 find/count/aggregate 也属于读查询
	if !isReadQuery && strings.ToLower(strings.TrimSpace(runConfig.Type)) == "mongodb" && strings.HasPrefix(strings.TrimSpace(query), "{") {
		isReadQuery = true
	}
	if isReadQuery {
		var data []map[string]interface{}
		var columns []string
		if q, ok := dbInst.(interface {
			QueryContext(context.Context, string) ([]map[string]interface{}, []string, error)
		}); ok {
			data, columns, err = q.QueryContext(ctx, query)
		} else {
			data, columns, err = dbInst.Query(query)
		}
		if err != nil {
			logger.Error(err, "DBQuery 查询失败：%s SQL片段=%q", formatConnSummary(runConfig), sqlSnippet(query))
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		return connection.QueryResult{Success: true, Data: data, Fields: columns}
	} else {
		var affected int64
		if e, ok := dbInst.(interface {
			ExecContext(context.Context, string) (int64, error)
		}); ok {
			affected, err = e.ExecContext(ctx, query)
		} else {
			affected, err = dbInst.Exec(query)
		}
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
	runConfig := normalizeRunConfig(config, dbName)

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
	runConfig := normalizeRunConfig(config, dbName)
	dbType := resolveDDLDBType(config)

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBShowCreateTable 获取连接失败：%s", formatConnSummary(runConfig))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	schemaName, pureTableName := normalizeSchemaAndTable(config, dbName, tableName)
	sqlStr, err := dbInst.GetCreateStatement(schemaName, pureTableName)
	if err != nil {
		logger.Error(err, "DBShowCreateTable 获取建表语句失败：%s 表=%s", formatConnSummary(runConfig), tableName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if shouldFallbackCreateStatement(dbType, sqlStr) {
		columns, colErr := dbInst.GetColumns(schemaName, pureTableName)
		if colErr != nil {
			logger.Error(colErr, "DBShowCreateTable 兜底加载字段失败：%s 表=%s", formatConnSummary(runConfig), tableName)
			return connection.QueryResult{Success: false, Message: colErr.Error()}
		}
		fallbackDDL, buildErr := buildFallbackCreateStatement(dbType, schemaName, pureTableName, columns)
		if buildErr != nil {
			logger.Error(buildErr, "DBShowCreateTable 兜底生成 DDL 失败：%s 表=%s", formatConnSummary(runConfig), tableName)
			return connection.QueryResult{Success: false, Message: buildErr.Error()}
		}
		sqlStr = fallbackDDL
	}

	return connection.QueryResult{Success: true, Data: sqlStr}
}

func shouldFallbackCreateStatement(dbType string, ddl string) bool {
	switch dbType {
	case "postgres", "kingbase", "highgo", "vastbase":
	default:
		return false
	}

	trimmed := strings.TrimSpace(ddl)
	if trimmed == "" {
		return true
	}
	if hasCreateTableHead(trimmed) {
		return false
	}

	lower := strings.ToLower(trimmed)
	if strings.Contains(lower, "not fully supported") ||
		strings.Contains(lower, "not directly supported") ||
		strings.Contains(lower, "not supported") {
		return true
	}
	return true
}

func hasCreateTableHead(sqlText string) bool {
	lines := strings.Split(sqlText, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "--") || strings.HasPrefix(line, "/*") || strings.HasPrefix(line, "*") {
			continue
		}
		return strings.HasPrefix(strings.ToLower(line), "create table")
	}
	return false
}

func buildFallbackCreateStatement(dbType string, schemaName string, tableName string, columns []connection.ColumnDefinition) (string, error) {
	table := strings.TrimSpace(tableName)
	if table == "" {
		return "", fmt.Errorf("表名不能为空")
	}
	if len(columns) == 0 {
		return "", fmt.Errorf("未获取到字段定义，无法生成建表语句")
	}

	qualifiedTable := quoteTableIdentByType(dbType, schemaName, table)
	columnLines := make([]string, 0, len(columns)+1)
	primaryKeys := make([]string, 0, 2)

	for _, col := range columns {
		colNameRaw := strings.TrimSpace(col.Name)
		if colNameRaw == "" {
			continue
		}
		colType := strings.TrimSpace(col.Type)
		if colType == "" {
			colType = "text"
		}

		colName := quoteIdentByType(dbType, colNameRaw)
		defParts := []string{fmt.Sprintf("%s %s", colName, colType)}

		if strings.EqualFold(strings.TrimSpace(col.Nullable), "NO") {
			defParts = append(defParts, "NOT NULL")
		}
		if col.Default != nil {
			defVal := strings.TrimSpace(*col.Default)
			if defVal != "" {
				defParts = append(defParts, "DEFAULT "+defVal)
			}
		}

		columnLines = append(columnLines, "  "+strings.Join(defParts, " "))
		if strings.EqualFold(strings.TrimSpace(col.Key), "PRI") {
			primaryKeys = append(primaryKeys, colName)
		}
	}

	if len(columnLines) == 0 {
		return "", fmt.Errorf("字段定义为空，无法生成建表语句")
	}
	if len(primaryKeys) > 0 {
		columnLines = append(columnLines, "  PRIMARY KEY ("+strings.Join(primaryKeys, ", ")+")")
	}

	ddl := strings.Builder{}
	ddl.WriteString("CREATE TABLE ")
	ddl.WriteString(qualifiedTable)
	ddl.WriteString(" (\n")
	ddl.WriteString(strings.Join(columnLines, ",\n"))
	ddl.WriteString("\n);")
	return ddl.String(), nil
}

func (a *App) DBGetColumns(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	runConfig := normalizeRunConfig(config, dbName)

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	schemaName, pureTableName := normalizeSchemaAndTable(config, dbName, tableName)
	columns, err := dbInst.GetColumns(schemaName, pureTableName)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: columns}
}

func (a *App) DBGetIndexes(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	runConfig := normalizeRunConfig(config, dbName)

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	schemaName, pureTableName := normalizeSchemaAndTable(config, dbName, tableName)
	indexes, err := dbInst.GetIndexes(schemaName, pureTableName)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: indexes}
}

func (a *App) DBGetForeignKeys(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	runConfig := normalizeRunConfig(config, dbName)

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	schemaName, pureTableName := normalizeSchemaAndTable(config, dbName, tableName)
	fks, err := dbInst.GetForeignKeys(schemaName, pureTableName)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: fks}
}

func (a *App) DBGetTriggers(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	runConfig := normalizeRunConfig(config, dbName)

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	schemaName, pureTableName := normalizeSchemaAndTable(config, dbName, tableName)
	triggers, err := dbInst.GetTriggers(schemaName, pureTableName)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: triggers}
}

func (a *App) DropView(config connection.ConnectionConfig, dbName string, viewName string) connection.QueryResult {
	viewName = strings.TrimSpace(viewName)
	if viewName == "" {
		return connection.QueryResult{Success: false, Message: "视图名称不能为空"}
	}

	dbType := resolveDDLDBType(config)
	switch dbType {
	case "mysql", "mariadb", "diros", "sphinx", "postgres", "kingbase", "sqlite", "duckdb", "oracle", "dameng", "highgo", "vastbase", "sqlserver":
	default:
		return connection.QueryResult{Success: false, Message: fmt.Sprintf("当前数据源(%s)暂不支持删除视图", dbType)}
	}

	schemaName, pureViewName := normalizeSchemaAndTableByType(dbType, dbName, viewName)
	if pureViewName == "" {
		return connection.QueryResult{Success: false, Message: "视图名称不能为空"}
	}
	qualifiedView := quoteTableIdentByType(dbType, schemaName, pureViewName)
	sql := fmt.Sprintf("DROP VIEW %s", qualifiedView)

	runConfig := buildRunConfigForDDL(config, dbType, dbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if _, err := dbInst.Exec(sql); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: "视图删除成功"}
}

func (a *App) DropFunction(config connection.ConnectionConfig, dbName string, routineName string, routineType string) connection.QueryResult {
	routineName = strings.TrimSpace(routineName)
	routineType = strings.TrimSpace(strings.ToUpper(routineType))
	if routineName == "" {
		return connection.QueryResult{Success: false, Message: "函数/存储过程名称不能为空"}
	}
	if routineType != "FUNCTION" && routineType != "PROCEDURE" {
		routineType = "FUNCTION"
	}

	dbType := resolveDDLDBType(config)
	switch dbType {
	case "mysql", "mariadb", "diros", "sphinx", "postgres", "kingbase", "oracle", "dameng", "highgo", "vastbase", "sqlserver", "duckdb":
	default:
		return connection.QueryResult{Success: false, Message: fmt.Sprintf("当前数据源(%s)暂不支持删除函数/存储过程", dbType)}
	}
	if dbType == "duckdb" && routineType == "PROCEDURE" {
		return connection.QueryResult{Success: false, Message: "DuckDB 暂不支持存储过程"}
	}

	schemaName, pureName := normalizeSchemaAndTableByType(dbType, dbName, routineName)
	if pureName == "" {
		return connection.QueryResult{Success: false, Message: "函数/存储过程名称不能为空"}
	}
	qualifiedName := quoteTableIdentByType(dbType, schemaName, pureName)
	sql := fmt.Sprintf("DROP %s %s", routineType, qualifiedName)

	runConfig := buildRunConfigForDDL(config, dbType, dbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if _, err := dbInst.Exec(sql); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	label := "函数"
	if routineType == "PROCEDURE" {
		label = "存储过程"
	}
	return connection.QueryResult{Success: true, Message: fmt.Sprintf("%s删除成功", label)}
}

func (a *App) RenameView(config connection.ConnectionConfig, dbName string, oldName string, newName string) connection.QueryResult {
	oldName = strings.TrimSpace(oldName)
	newName = strings.TrimSpace(newName)
	if oldName == "" || newName == "" {
		return connection.QueryResult{Success: false, Message: "视图名称不能为空"}
	}
	if strings.EqualFold(oldName, newName) {
		return connection.QueryResult{Success: false, Message: "新旧视图名称不能相同"}
	}
	if strings.Contains(newName, ".") {
		return connection.QueryResult{Success: false, Message: "新视图名不能包含 schema 或数据库前缀"}
	}

	dbType := resolveDDLDBType(config)
	schemaName, pureOldName := normalizeSchemaAndTableByType(dbType, dbName, oldName)
	if pureOldName == "" {
		return connection.QueryResult{Success: false, Message: "旧视图名不能为空"}
	}
	oldQualified := quoteTableIdentByType(dbType, schemaName, pureOldName)
	newQuoted := quoteIdentByType(dbType, newName)

	var sql string
	switch dbType {
	case "mysql", "mariadb", "diros", "sphinx":
		newQualified := quoteTableIdentByType(dbType, schemaName, newName)
		sql = fmt.Sprintf("RENAME TABLE %s TO %s", oldQualified, newQualified)
	case "postgres", "kingbase", "highgo", "vastbase":
		sql = fmt.Sprintf("ALTER VIEW %s RENAME TO %s", oldQualified, newQuoted)
	case "sqlserver":
		oldFullName := schemaName + "." + pureOldName
		escapedOld := strings.ReplaceAll(oldFullName, "'", "''")
		escapedNew := strings.ReplaceAll(newName, "'", "''")
		sql = fmt.Sprintf("EXEC sp_rename '%s', '%s'", escapedOld, escapedNew)
	default:
		return connection.QueryResult{Success: false, Message: fmt.Sprintf("当前数据源(%s)暂不支持重命名视图", dbType)}
	}

	runConfig := buildRunConfigForDDL(config, dbType, dbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if _, err := dbInst.Exec(sql); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: "视图重命名成功"}
}

func (a *App) DBGetAllColumns(config connection.ConnectionConfig, dbName string) connection.QueryResult {
	runConfig := normalizeRunConfig(config, dbName)

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
