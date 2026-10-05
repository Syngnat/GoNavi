package app

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func (a *App) CreateDatabase(config connection.ConnectionConfig, dbName string, charset string, collation string) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("CREATE DATABASE %s", strings.TrimSpace(dbName))
	defer a.beginSQLAuditUserAction(config, dbName, "object_editor", &auditSQL, &result)()
	dbName = strings.TrimSpace(dbName)
	if dbName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.database_name_required", nil)}
	}
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.create_database"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	runConfig := config
	runConfig.Database = ""
	if resolveDDLDBType(config) == "clickhouse" && strings.EqualFold(strings.TrimSpace(config.Type), "custom") {
		runConfig = runConfig.WithRuntimeDatabaseOverride("")
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	dbType := resolveDDLDBType(runConfig)
	query, err := buildCreateDatabaseQuery(dbType, dbName, charset, collation)
	if err != nil {
		switch {
		case errors.Is(err, errCreateDatabaseSphinxUnsupported):
			return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.database_create_sphinx_unsupported", nil)}
		case errors.Is(err, errCreateDatabaseUserSchemaUnsupported):
			return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.database_create_user_schema_unsupported", map[string]any{"dbType": dbType})}
		default:
			return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.database_option_invalid", map[string]any{"detail": err.Error()})}
		}
	}

	_, err = dbInst.Exec(query)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.database_created", nil)}
}

var (
	errCreateDatabaseSphinxUnsupported     = errors.New("sphinx create database unsupported")
	errCreateDatabaseUserSchemaUnsupported = errors.New("user schema create database unsupported")
)

// buildCreateDatabaseQuery 构造创建数据库 SQL。
//
// MySQL 系方言（mysql/mariadb/diros/oceanbase，以及被归一化为 mysql 的
// goldendb/greatdb 等）支持可选的字符集与排序规则；charset/collation 为空
// 时使用服务器默认值。两者只允许字母、数字与下划线，防止注入。
func buildCreateDatabaseQuery(dbType string, dbName string, charset string, collation string) (string, error) {
	charset = strings.TrimSpace(charset)
	collation = strings.TrimSpace(collation)
	switch dbType {
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		escaped := strings.ReplaceAll(dbName, `"`, `""`)
		return fmt.Sprintf(`CREATE DATABASE "%s"`, escaped), nil
	case "sqlserver":
		return fmt.Sprintf("CREATE DATABASE %s", quoteIdentByType(dbType, dbName)), nil
	case "tdengine", "clickhouse", "starrocks":
		return fmt.Sprintf("CREATE DATABASE IF NOT EXISTS %s", quoteIdentByType(dbType, dbName)), nil
	case "sphinx":
		return "", errCreateDatabaseSphinxUnsupported
	case "oracle", "dameng":
		return "", errCreateDatabaseUserSchemaUnsupported
	default:
		escaped := strings.ReplaceAll(dbName, "`", "``")
		query := fmt.Sprintf("CREATE DATABASE `%s`", escaped)
		if charset != "" {
			if !isSafeDatabaseOption(charset) {
				return "", fmt.Errorf("invalid database charset: %q", charset)
			}
			query += " CHARACTER SET " + charset
		}
		if collation != "" {
			if !isSafeDatabaseOption(collation) {
				return "", fmt.Errorf("invalid database collation: %q", collation)
			}
			query += " COLLATE " + collation
		}
		return query, nil
	}
}

// isSafeDatabaseOption 校验字符集/排序规则标识符，仅允许字母、数字与下划线。
func isSafeDatabaseOption(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_') {
			return false
		}
	}
	return true
}

// supportsDatabaseCharsetOptions 判断数据源是否支持字符集/排序规则选项。
func supportsDatabaseCharsetOptions(dbType string) bool {
	switch dbType {
	case "mysql", "mariadb", "diros", "oceanbase":
		return true
	default:
		return false
	}
}

// ListDatabaseCharsets 返回 MySQL 系数据源可用的字符集列表（SHOW CHARACTER SET）。
// 非 MySQL 系返回空列表。
func (a *App) ListDatabaseCharsets(config connection.ConnectionConfig) (result connection.QueryResult) {
	if !supportsDatabaseCharsetOptions(resolveDDLDBType(config)) {
		return connection.QueryResult{Success: true, Data: []connection.DatabaseCharset{}}
	}
	runConfig := config
	runConfig.Database = ""
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	rows, _, err := dbInst.Query("SHOW CHARACTER SET")
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	charsets := make([]connection.DatabaseCharset, 0, len(rows))
	for _, row := range rows {
		charsets = append(charsets, connection.DatabaseCharset{
			Name:             rowStringValue(row, "Charset"),
			Description:      rowStringValue(row, "Description"),
			DefaultCollation: rowStringValue(row, "Default collation"),
			MaxLength:        rowIntValue(row, "Maxlen"),
		})
	}
	return connection.QueryResult{Success: true, Data: charsets}
}

// ListDatabaseCollations 返回 MySQL 系数据源可用的排序规则列表（SHOW COLLATION）。
// 非 MySQL 系返回空列表。
func (a *App) ListDatabaseCollations(config connection.ConnectionConfig) (result connection.QueryResult) {
	if !supportsDatabaseCharsetOptions(resolveDDLDBType(config)) {
		return connection.QueryResult{Success: true, Data: []connection.DatabaseCollation{}}
	}
	runConfig := config
	runConfig.Database = ""
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	rows, _, err := dbInst.Query("SHOW COLLATION")
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	collations := make([]connection.DatabaseCollation, 0, len(rows))
	for _, row := range rows {
		collations = append(collations, connection.DatabaseCollation{
			Name:    rowStringValue(row, "Collation"),
			Charset: rowStringValue(row, "Charset"),
		})
	}
	return connection.QueryResult{Success: true, Data: collations}
}

// rowStringValue 从查询结果行中提取字符串列值。
func rowStringValue(row map[string]interface{}, key string) string {
	value, ok := row[key]
	if !ok || value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprintf("%v", value))
}

// rowIntValue 从查询结果行中提取整数列值。
func rowIntValue(row map[string]interface{}, key string) int {
	value, ok := row[key]
	if !ok || value == nil {
		return 0
	}
	switch n := value.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(n))
		if err != nil {
			return 0
		}
		return parsed
	default:
		return 0
	}
}

func (a *App) RenameDatabase(config connection.ConnectionConfig, oldName string, newName string) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("ALTER DATABASE %s RENAME TO %s", strings.TrimSpace(oldName), strings.TrimSpace(newName))
	defer a.beginSQLAuditUserAction(config, oldName, "object_editor", &auditSQL, &result)()
	oldName = strings.TrimSpace(oldName)
	newName = strings.TrimSpace(newName)
	if oldName == "" || newName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.database_name_required", nil)}
	}
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.rename_database"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.EqualFold(oldName, newName) {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.database_same_name", nil)}
	}

	dbType := resolveDDLDBType(config)
	switch dbType {
	case "diros":
		runConfig := config
		if strings.TrimSpace(runConfig.Database) == "" {
			runConfig.Database = oldName
		}
		dbInst, err := a.getDatabase(runConfig)
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		sql := fmt.Sprintf("ALTER DATABASE %s RENAME %s", quoteIdentByType(dbType, oldName), quoteIdentByType(dbType, newName))
		if _, err := dbInst.Exec(sql); err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.database_renamed", nil)}
	case "mysql", "mariadb", "oceanbase", "starrocks", "sphinx":
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.database_rename_direct_unsupported", nil)}
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		runConfig := resolvePGLikeDatabaseDDLRunConfig(config, dbType, oldName)
		dbInst, err := a.getDatabase(runConfig)
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		sql := fmt.Sprintf("ALTER DATABASE %s RENAME TO %s", quoteIdentByType(dbType, oldName), quoteIdentByType(dbType, newName))
		if _, err := dbInst.Exec(sql); err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.database_renamed", nil)}
	default:
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.database_rename_unsupported", map[string]any{"dbType": dbType})}
	}
}

func (a *App) DropDatabase(config connection.ConnectionConfig, dbName string) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("DROP DATABASE %s", strings.TrimSpace(dbName))
	defer a.beginSQLAuditUserAction(config, dbName, "object_editor", &auditSQL, &result)()
	dbName = strings.TrimSpace(dbName)
	if dbName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.database_name_required", nil)}
	}
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.drop_database"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	dbType := resolveDDLDBType(config)
	var (
		runConfig connection.ConnectionConfig
		sql       string
	)
	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "tdengine", "clickhouse":
		runConfig = config
		runConfig.Database = ""
		if dbType == "clickhouse" && strings.EqualFold(strings.TrimSpace(config.Type), "custom") {
			runConfig = runConfig.WithRuntimeDatabaseOverride("")
		}
		sql = fmt.Sprintf("DROP DATABASE %s", quoteIdentByType(dbType, dbName))
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		runConfig = resolvePGLikeDatabaseDDLRunConfig(config, dbType, dbName)
		sql = fmt.Sprintf("DROP DATABASE %s", quoteIdentByType(dbType, dbName))
	default:
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.database_drop_unsupported", map[string]any{"dbType": dbType})}
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if _, err := dbInst.Exec(sql); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.database_dropped", nil)}
}
