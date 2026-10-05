package app

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func (a *App) RenameTable(config connection.ConnectionConfig, dbName string, oldTableName string, newTableName string) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("ALTER TABLE %s RENAME TO %s", strings.TrimSpace(oldTableName), strings.TrimSpace(newTableName))
	defer a.beginSQLAuditUserAction(config, dbName, "object_editor", &auditSQL, &result)()
	oldTableName = strings.TrimSpace(oldTableName)
	newTableName = strings.TrimSpace(newTableName)
	if oldTableName == "" || newTableName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.table_name_required", nil)}
	}
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.rename_table"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.EqualFold(oldTableName, newTableName) {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.table_same_name", nil)}
	}
	if strings.Contains(newTableName, ".") {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.table_new_name_no_qualifier", nil)}
	}
	if sql, ok := registryObjectStatement(config.Type, "renameTable", map[string]string{"old": oldTableName, "new": newTableName}); ok {
		auditSQL = sql
		return a.execRegistryObjectStatement(config, dbName, sql, "db.backend.message.table_renamed")
	}

	dbType := resolveDDLDBType(config)
	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "postgres", "kingbase", "sqlite", "duckdb", "oracle", "dameng", "highgo", "vastbase", "opengauss", "gaussdb", "sqlserver", "clickhouse":
	default:
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.table_rename_unsupported", map[string]interface{}{"dbType": dbType})}
	}

	schemaName, pureOldTableName := normalizeSchemaAndTableByType(dbType, dbName, oldTableName)
	if pureOldTableName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.old_table_name_required", nil)}
	}
	oldQualifiedTable := quoteTableIdentByType(dbType, schemaName, pureOldTableName)
	newTableQuoted := quoteIdentByType(dbType, newTableName)

	var sql string
	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "clickhouse":
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
	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.table_renamed", nil)}
}

func (a *App) DropTable(config connection.ConnectionConfig, dbName string, tableName string) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("DROP TABLE %s", strings.TrimSpace(tableName))
	defer a.beginSQLAuditUserAction(config, dbName, "object_editor", &auditSQL, &result)()
	tableName = strings.TrimSpace(tableName)
	if tableName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.table_name_required", nil)}
	}
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.drop_table"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if sql, ok := registryObjectStatement(config.Type, "dropTable", map[string]string{"table": tableName}); ok {
		auditSQL = sql
		return a.execRegistryObjectStatement(config, dbName, sql, "db.backend.message.table_dropped")
	}

	dbType := resolveDDLDBType(config)
	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "postgres", "kingbase", "sqlite", "duckdb", "oracle", "dameng", "highgo", "vastbase", "opengauss", "gaussdb", "sqlserver", "tdengine", "clickhouse":
	default:
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.table_drop_unsupported", map[string]interface{}{"dbType": dbType})}
	}

	schemaName, pureTableName := normalizeSchemaAndTableByType(dbType, dbName, tableName)
	if pureTableName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.table_name_required", nil)}
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
	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.table_dropped", nil)}
}

func (a *App) DropView(config connection.ConnectionConfig, dbName string, viewName string) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("DROP VIEW %s", strings.TrimSpace(viewName))
	defer a.beginSQLAuditUserAction(config, dbName, "object_editor", &auditSQL, &result)()
	viewName = strings.TrimSpace(viewName)
	if viewName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.view_name_required", nil)}
	}
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.drop_view"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if sql, ok := registryObjectStatement(config.Type, "dropView", map[string]string{"view": viewName}); ok {
		auditSQL = sql
		return a.execRegistryObjectStatement(config, dbName, sql, "db.backend.message.view_dropped")
	}

	dbType := resolveDDLDBType(config)
	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "postgres", "kingbase", "sqlite", "duckdb", "oracle", "dameng", "highgo", "vastbase", "opengauss", "gaussdb", "sqlserver", "clickhouse":
	default:
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.view_drop_unsupported", map[string]any{"dbType": dbType})}
	}

	schemaName, pureViewName := normalizeSchemaAndTableByType(dbType, dbName, viewName)
	if pureViewName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.view_name_required", nil)}
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
	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.view_dropped", nil)}
}

func (a *App) DropFunction(config connection.ConnectionConfig, dbName string, routineName string, routineType string) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("DROP %s %s", strings.ToUpper(strings.TrimSpace(routineType)), strings.TrimSpace(routineName))
	defer a.beginSQLAuditUserAction(config, dbName, "object_editor", &auditSQL, &result)()
	routineName = strings.TrimSpace(routineName)
	routineType = strings.TrimSpace(strings.ToUpper(routineType))
	if routineName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.routine_name_required", nil)}
	}
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.drop_function_or_procedure"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if routineType != "FUNCTION" && routineType != "PROCEDURE" {
		routineType = "FUNCTION"
	}
	if sql, ok := registryObjectStatement(config.Type, "dropRoutine", map[string]string{"name": routineName, "type": routineType}); ok {
		auditSQL = sql
		successKey := "db.backend.message.function_dropped"
		if routineType == "PROCEDURE" {
			successKey = "db.backend.message.procedure_dropped"
		}
		return a.execRegistryObjectStatement(config, dbName, sql, successKey)
	}

	dbType := resolveDDLDBType(config)
	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "postgres", "kingbase", "oracle", "dameng", "highgo", "vastbase", "opengauss", "gaussdb", "sqlserver", "duckdb":
	default:
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.routine_drop_unsupported", map[string]any{"dbType": dbType})}
	}
	if dbType == "duckdb" && routineType == "PROCEDURE" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.duckdb_procedure_drop_unsupported", nil)}
	}

	schemaName, pureName := normalizeSchemaAndTableByType(dbType, dbName, routineName)
	if pureName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.routine_name_required", nil)}
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

	if routineType == "PROCEDURE" {
		return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.procedure_dropped", nil)}
	}
	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.function_dropped", nil)}
}

func (a *App) RenameView(config connection.ConnectionConfig, dbName string, oldName string, newName string) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("ALTER VIEW %s RENAME TO %s", strings.TrimSpace(oldName), strings.TrimSpace(newName))
	defer a.beginSQLAuditUserAction(config, dbName, "object_editor", &auditSQL, &result)()
	oldName = strings.TrimSpace(oldName)
	newName = strings.TrimSpace(newName)
	if oldName == "" || newName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.view_name_required", nil)}
	}
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.rename_view"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.EqualFold(oldName, newName) {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.view_same_name", nil)}
	}
	if strings.Contains(newName, ".") {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.view_new_name_no_qualifier", nil)}
	}
	if strings.HasSuffix(oldName, ".") {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.old_view_name_required", nil)}
	}

	dbType := resolveDDLDBType(config)
	schemaName, pureOldName := normalizeSchemaAndTableByType(dbType, dbName, oldName)
	if pureOldName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.old_view_name_required", nil)}
	}
	oldQualified := quoteTableIdentByType(dbType, schemaName, pureOldName)
	newQuoted := quoteIdentByType(dbType, newName)

	var sql string
	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "clickhouse":
		newQualified := quoteTableIdentByType(dbType, schemaName, newName)
		sql = fmt.Sprintf("RENAME TABLE %s TO %s", oldQualified, newQualified)
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		sql = fmt.Sprintf("ALTER VIEW %s RENAME TO %s", oldQualified, newQuoted)
	case "sqlserver":
		oldFullName := schemaName + "." + pureOldName
		escapedOld := strings.ReplaceAll(oldFullName, "'", "''")
		escapedNew := strings.ReplaceAll(newName, "'", "''")
		sql = fmt.Sprintf("EXEC sp_rename '%s', '%s'", escapedOld, escapedNew)
	default:
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.view_rename_unsupported", map[string]any{"dbType": dbType})}
	}

	runConfig := buildRunConfigForDDL(config, dbType, dbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if _, err := dbInst.Exec(sql); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.view_renamed", nil)}
}
