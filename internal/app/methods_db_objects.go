package app

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

type objectMetadataQuerySpec struct {
	sql          string
	inferredType string
}

func (a *App) DBGetObjects(config connection.ConnectionConfig, dbName string) connection.QueryResult {
	runConfig := normalizeMetadataRunConfig(config, dbName)
	dbType := resolveDDLDBType(runConfig)

	if strings.EqualFold(strings.TrimSpace(runConfig.Type), "redis") {
		keys := a.DBGetTables(config, dbName)
		if !keys.Success {
			return failedObjectMetadataResult("key", errors.New(strings.TrimSpace(keys.Message)))
		}
		names, err := decodeStringRows(keys.Data, "Table", "table", "name")
		if err != nil {
			return failedObjectMetadataResult("key", err)
		}
		return connection.QueryResult{
			Success:           true,
			Data:              buildNamedObjects(dbName, "key", names),
			Message:           keys.Message,
			Partial:           keys.Partial,
			Warnings:          keys.Warnings,
			FailedObjectTypes: keys.FailedObjectTypes,
			Retryable:         keys.Retryable,
			Truncated:         keys.Truncated,
			ScannedCount:      keys.ScannedCount,
		}
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBGetObjects 获取连接失败：%s", formatConnSummary(runConfig))
		return failedObjectMetadataResult(tableObjectTypeForDB(dbType), err)
	}

	objects := make([]connection.DatabaseObject, 0, 128)
	tableType := tableObjectTypeForDB(dbType)
	tables, tableErr := dbInst.GetTables(dbName)
	if tableErr != nil {
		logger.Warnf("DBGetObjects 获取基础对象失败：%s err=%v", formatConnSummary(runConfig), tableErr)
		return failedObjectMetadataResult(tableType, tableErr)
	}
	tables = dedupeMetadataTableNames(tables)
	objects = append(objects, buildNamedObjects(dbName, tableType, tables)...)

	warnings := make([]string, 0)
	failedObjectTypes := make([]string, 0)
	appendMetadataObjects := func(objectType string, metadataObjects []connection.DatabaseObject, metadataErr error) {
		objects = append(objects, metadataObjects...)
		if metadataErr == nil {
			return
		}
		warning := objectMetadataWarning(objectType, metadataErr)
		logger.Warnf("DBGetObjects %s 元数据不完整：%s err=%v", objectType, formatConnSummary(runConfig), metadataErr)
		warnings = append(warnings, warning)
		failedObjectTypes = append(failedObjectTypes, objectType)
	}
	buildResult := func() connection.QueryResult {
		partial := len(failedObjectTypes) > 0
		result := connection.QueryResult{
			Success:           true,
			Data:              dedupeSortDatabaseObjects(objects, databaseObjectIdentifiersAreCaseSensitive(dbType)),
			Partial:           partial,
			Warnings:          warnings,
			FailedObjectTypes: failedObjectTypes,
			Retryable:         partial,
		}
		if partial {
			result.Message = "对象元数据不完整，可重试"
		}
		return result
	}

	if dbType == "rabbitmq" {
		metadataObjects, metadataErr := listObjectsByQueries(dbInst, runConfig, dbName, "exchange", buildMessageExchangeMetadataQueries(dbType))
		appendMetadataObjects("exchange", metadataObjects, metadataErr)
	}
	switch dbType {
	case "mqtt", "kafka", "rocketmq", "rabbitmq":
		return buildResult()
	}

	viewLookup, viewErr := listViewNameLookupWithStatus(dbInst, runConfig, dbName)
	appendMetadataObjects("view", buildNamedObjects(dbName, "view", mapValuesSorted(viewLookup)), viewErr)
	metadataObjects, metadataErr := listObjectsByQueries(dbInst, runConfig, dbName, "materialized_view", buildMaterializedViewMetadataQueries(dbType, dbName))
	appendMetadataObjects("materialized_view", metadataObjects, metadataErr)
	metadataObjects, metadataErr = listObjectsByQueries(dbInst, runConfig, dbName, "trigger", buildObjectTriggerMetadataQueries(dbType, dbName))
	appendMetadataObjects("trigger", metadataObjects, metadataErr)
	metadataObjects, metadataErr = listRoutineObjects(dbInst, runConfig, dbName, buildObjectRoutineMetadataQueries(dbType, dbName))
	appendMetadataObjects("routine", metadataObjects, metadataErr)
	metadataObjects, metadataErr = listObjectsByQueries(dbInst, runConfig, dbName, "sequence", buildObjectSequenceMetadataQueries(dbType, dbName))
	appendMetadataObjects("sequence", metadataObjects, metadataErr)
	metadataObjects, metadataErr = listObjectsByQueries(dbInst, runConfig, dbName, "package", buildObjectPackageMetadataQueries(dbType, dbName))
	appendMetadataObjects("package", metadataObjects, metadataErr)
	metadataObjects, metadataErr = listObjectsByQueries(dbInst, runConfig, dbName, "event", buildObjectEventMetadataQueries(dbType, dbName))
	appendMetadataObjects("event", metadataObjects, metadataErr)

	return buildResult()
}

func objectMetadataWarning(objectType string, err error) string {
	return fmt.Sprintf("读取 %s 对象元数据失败: %v", strings.TrimSpace(objectType), err)
}

func failedObjectMetadataResult(objectType string, err error) connection.QueryResult {
	warning := objectMetadataWarning(objectType, err)
	return connection.QueryResult{
		Success:           false,
		Partial:           true,
		Message:           warning,
		Data:              []connection.DatabaseObject{},
		Warnings:          []string{warning},
		FailedObjectTypes: []string{objectType},
		Retryable:         true,
	}
}

func tableObjectTypeForDB(dbType string) string {
	switch strings.ToLower(strings.TrimSpace(dbType)) {
	case "rabbitmq":
		return "queue"
	case "rocketmq", "kafka", "mqtt":
		return "topic"
	default:
		return "table"
	}
}

func buildNamedObjects(dbName string, objectType string, names []string) []connection.DatabaseObject {
	objects := make([]connection.DatabaseObject, 0, len(names))
	for _, rawName := range names {
		schema, name := "", strings.TrimSpace(rawName)
		if shouldSplitDatabaseObjectName(objectType) {
			schema, name = splitObjectSchemaName(rawName)
		}
		if strings.TrimSpace(name) == "" {
			continue
		}
		objects = append(objects, connection.DatabaseObject{
			Database: strings.TrimSpace(dbName),
			Schema:   strings.TrimSpace(schema),
			Name:     strings.TrimSpace(name),
			Type:     strings.TrimSpace(objectType),
		})
	}
	return objects
}

func listObjectsByQueries(dbInst db.Database, config connection.ConnectionConfig, dbName string, objectType string, specs []objectMetadataQuerySpec) ([]connection.DatabaseObject, error) {
	objects := make([]connection.DatabaseObject, 0)
	querySucceeded := false
	var firstErr error
	for _, spec := range normalizeObjectMetadataQuerySpecs(specs) {
		rows, _, err := queryDataForExport(dbInst, config, spec.sql)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		querySucceeded = true
		for _, row := range rows {
			object := databaseObjectFromRow(dbName, objectType, spec.inferredType, row)
			if object.Name == "" {
				continue
			}
			objects = append(objects, object)
		}
	}
	if !querySucceeded && firstErr != nil {
		return objects, firstErr
	}
	return objects, nil
}

func listRoutineObjects(dbInst db.Database, config connection.ConnectionConfig, dbName string, specs []objectMetadataQuerySpec) ([]connection.DatabaseObject, error) {
	objects := make([]connection.DatabaseObject, 0)
	querySucceeded := false
	var firstErr error
	for _, spec := range normalizeObjectMetadataQuerySpecs(specs) {
		rows, _, err := queryDataForExport(dbInst, config, spec.sql)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		querySucceeded = true
		for _, row := range rows {
			rawType := rowStringCI(row, "routine_type", "object_type", "type")
			if rawType == "" {
				rawType = spec.inferredType
			}
			objectType := "function"
			if strings.Contains(strings.ToUpper(rawType), "PROC") {
				objectType = "procedure"
			}
			object := databaseObjectFromRow(dbName, objectType, rawType, row)
			if object.Name == "" {
				continue
			}
			objects = append(objects, object)
		}
	}
	if !querySucceeded && firstErr != nil {
		return objects, firstErr
	}
	return objects, nil
}

func databaseObjectFromRow(dbName string, objectType string, rawType string, row map[string]interface{}) connection.DatabaseObject {
	schema := rowStringCI(row, "schema_name", "schemaname", "owner", "table_schema", "event_schema", "sequence_owner", "db", "database")
	name := rowStringCI(row, objectNameKeysForType(objectType)...)
	if name == "" {
		name = mysqlShowObjectName(row)
	}
	if name == "" {
		name = firstRowString(row)
	}
	if shouldSplitDatabaseObjectName(objectType) {
		parsedSchema, parsedName := splitObjectSchemaName(name)
		if schema == "" {
			schema = parsedSchema
		}
		if parsedName != "" {
			name = parsedName
		}
	}
	parent := rowStringCI(row, "parent", "table_name", "event_object_table", "tbl_name", "table")
	if parentSchema, parentName := splitObjectSchemaName(parent); parentName != "" {
		if parentSchema != "" && !strings.Contains(parent, ".") {
			parent = qualifyTable(parentSchema, parentName)
		} else {
			parent = strings.TrimSpace(parent)
		}
	}
	if rawType == "" {
		rawType = rowStringCI(row, "raw_type", "table_type", "object_type", "routine_type", "type", "event_type", "status")
	}
	return connection.DatabaseObject{
		Database:     strings.TrimSpace(dbName),
		Schema:       strings.TrimSpace(schema),
		Name:         strings.TrimSpace(name),
		Type:         strings.TrimSpace(objectType),
		Parent:       strings.TrimSpace(parent),
		RawType:      strings.TrimSpace(rawType),
		ObjectStatus: rowStringCI(row, "object_status"),
		Comment:      rowStringCI(row, "comment", "comments", "description", "table_comment"),
	}
}

func shouldSplitDatabaseObjectName(objectType string) bool {
	switch strings.ToLower(strings.TrimSpace(objectType)) {
	case "topic", "queue", "exchange", "key":
		return false
	default:
		return true
	}
}

func objectNameKeysForType(objectType string) []string {
	switch strings.ToLower(strings.TrimSpace(objectType)) {
	case "view", "materialized_view":
		return []string{"object_name", "view_name", "viewname", "table_name", "name"}
	case "trigger":
		return []string{"trigger_name", "triggername", "trigger", "object_name", "name"}
	case "function", "procedure":
		return []string{"routine_name", "object_name", "proname", "name"}
	case "sequence":
		return []string{"sequence_name", "sequencename", "object_name", "name"}
	case "package":
		return []string{"package_name", "packagename", "object_name", "name"}
	case "event":
		return []string{"event_name", "eventname", "object_name", "name", "event"}
	case "topic":
		return []string{"topic", "topic_name", "name"}
	case "queue":
		return []string{"queue", "queue_name", "name"}
	case "exchange":
		return []string{"exchange", "exchange_name", "exchange_display", "name"}
	default:
		return []string{"object_name", "table_name", "name"}
	}
}

func splitObjectSchemaName(raw string) (string, string) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "", ""
	}
	schema, name := db.SplitSQLQualifiedName(text)
	if name != "" {
		return strings.TrimSpace(schema), strings.TrimSpace(name)
	}
	parts := strings.SplitN(text, ".", 2)
	if len(parts) == 2 {
		return strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
	}
	return "", text
}

func databaseObjectIdentifiersAreCaseSensitive(dbType string) bool {
	switch resolveDDLDBType(connection.ConnectionConfig{Type: dbType}) {
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "oracle", "dameng",
		"mqtt", "kafka", "rocketmq", "rabbitmq":
		return true
	default:
		return false
	}
}

func dedupeSortDatabaseObjects(objects []connection.DatabaseObject, preserveCase bool) []connection.DatabaseObject {
	seen := make(map[string]struct{}, len(objects))
	result := make([]connection.DatabaseObject, 0, len(objects))
	for _, object := range objects {
		object.Type = strings.ToLower(strings.TrimSpace(object.Type))
		object.Name = strings.TrimSpace(object.Name)
		object.Schema = strings.TrimSpace(object.Schema)
		object.Database = strings.TrimSpace(object.Database)
		if object.Name == "" || object.Type == "" {
			continue
		}
		keyParts := []string{object.Database, object.Type, object.Schema, object.Name, object.Parent}
		if !preserveCase {
			for index := range keyParts {
				keyParts[index] = strings.ToLower(keyParts[index])
			}
		}
		key := strings.Join(keyParts, "\x00")
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, object)
	}
	sort.SliceStable(result, func(i, j int) bool {
		left := result[i]
		right := result[j]
		for _, pair := range [][2]string{
			{left.Type, right.Type},
			{left.Schema, right.Schema},
			{left.Name, right.Name},
			{left.Parent, right.Parent},
		} {
			a := strings.ToLower(pair[0])
			b := strings.ToLower(pair[1])
			if a != b {
				return a < b
			}
		}
		return false
	})
	return result
}

func normalizeObjectMetadataQuerySpecs(specs []objectMetadataQuerySpec) []objectMetadataQuerySpec {
	seen := make(map[string]struct{}, len(specs))
	result := make([]objectMetadataQuerySpec, 0, len(specs))
	for _, spec := range specs {
		sql := strings.TrimSpace(spec.sql)
		if sql == "" {
			continue
		}
		key := strings.ToLower(spec.inferredType) + "\x00" + sql
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, objectMetadataQuerySpec{sql: sql, inferredType: spec.inferredType})
	}
	return result
}

func rowStringCI(row map[string]interface{}, keys ...string) string {
	if len(row) == 0 {
		return ""
	}
	values := make(map[string]interface{}, len(row))
	for key, value := range row {
		values[strings.ToLower(strings.TrimSpace(key))] = value
	}
	for _, key := range keys {
		if value, ok := values[strings.ToLower(strings.TrimSpace(key))]; ok && value != nil {
			text := strings.TrimSpace(fmt.Sprint(value))
			if text != "" && text != "<nil>" {
				return text
			}
		}
	}
	return ""
}

func firstRowString(row map[string]interface{}) string {
	for _, value := range row {
		if value == nil {
			continue
		}
		text := strings.TrimSpace(fmt.Sprint(value))
		if text != "" && text != "<nil>" {
			return text
		}
	}
	return ""
}

func mysqlShowObjectName(row map[string]interface{}) string {
	for key, value := range row {
		lower := strings.ToLower(strings.TrimSpace(key))
		if !strings.HasPrefix(lower, "tables_in_") && !strings.HasPrefix(lower, "exchanges_in_") {
			continue
		}
		text := strings.TrimSpace(fmt.Sprint(value))
		if text != "" && text != "<nil>" {
			return text
		}
	}
	return ""
}

func decodeStringRows(data interface{}, keys ...string) ([]string, error) {
	switch items := data.(type) {
	case nil:
		return []string{}, nil
	case []map[string]string:
		result := make([]string, 0, len(items))
		for _, item := range items {
			for _, key := range keys {
				if value := strings.TrimSpace(item[key]); value != "" {
					result = append(result, value)
					break
				}
			}
		}
		return result, nil
	default:
		return nil, fmt.Errorf("unsupported object rows payload %T", data)
	}
}

func buildObjectRoutineMetadataQueries(dbType string, dbName string) []objectMetadataQuerySpec {
	safeDbName := escapeSQLLiteral(dbName)
	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx":
		functionStatusQuery := fmt.Sprintf("SHOW FUNCTION STATUS WHERE Db = '%s'", safeDbName)
		procedureStatusQuery := fmt.Sprintf("SHOW PROCEDURE STATUS WHERE Db = '%s'", safeDbName)
		if strings.TrimSpace(dbName) == "" {
			functionStatusQuery = "SHOW FUNCTION STATUS WHERE Db = DATABASE()"
			procedureStatusQuery = "SHOW PROCEDURE STATUS WHERE Db = DATABASE()"
		}
		return []objectMetadataQuerySpec{
			{sql: fmt.Sprintf("SELECT ROUTINE_NAME AS routine_name, ROUTINE_TYPE AS routine_type, ROUTINE_SCHEMA AS schema_name FROM information_schema.routines WHERE %s ORDER BY ROUTINE_TYPE, ROUTINE_NAME", mysqlMetadataSchemaPredicate("ROUTINE_SCHEMA", dbName))},
			{sql: functionStatusQuery, inferredType: "FUNCTION"},
			{sql: procedureStatusQuery, inferredType: "PROCEDURE"},
		}
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		return []objectMetadataQuerySpec{
			{sql: `SELECT n.nspname AS schema_name, p.proname AS routine_name, CASE WHEN p.prokind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS routine_type FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg|_%' ESCAPE '|' ORDER BY n.nspname, routine_type, p.proname`},
			{sql: `SELECT r.routine_schema AS schema_name, r.routine_name AS routine_name, COALESCE(NULLIF(UPPER(r.routine_type), ''), 'FUNCTION') AS routine_type FROM information_schema.routines r WHERE r.routine_schema NOT IN ('pg_catalog', 'information_schema') AND r.routine_schema NOT LIKE 'pg|_%' ESCAPE '|' ORDER BY r.routine_schema, routine_type, r.routine_name`},
			{sql: `SELECT n.nspname AS schema_name, p.proname AS routine_name, 'FUNCTION' AS routine_type FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg|_%' ESCAPE '|' ORDER BY n.nspname, p.proname`},
		}
	case "sqlserver":
		safeDB := quoteIdentByType("sqlserver", firstNonEmptyString(dbName, "master"))
		return []objectMetadataQuerySpec{{sql: fmt.Sprintf(`SELECT s.name AS schema_name, o.name AS routine_name, CASE o.type WHEN 'P' THEN 'PROCEDURE' WHEN 'FN' THEN 'FUNCTION' WHEN 'IF' THEN 'FUNCTION' WHEN 'TF' THEN 'FUNCTION' END AS routine_type FROM %s.sys.objects o JOIN %s.sys.schemas s ON o.schema_id = s.schema_id WHERE o.type IN ('P','FN','IF','TF') ORDER BY o.type, s.name, o.name`, safeDB, safeDB)}}
	case "oracle", "dameng":
		objectStatusProjection := ""
		if dbType == "oracle" {
			objectStatusProjection = ", STATUS AS object_status"
		}
		if strings.TrimSpace(dbName) == "" {
			return []objectMetadataQuerySpec{{sql: fmt.Sprintf(`SELECT OBJECT_NAME AS routine_name, OBJECT_TYPE AS routine_type%s FROM USER_OBJECTS WHERE OBJECT_TYPE IN ('FUNCTION','PROCEDURE') ORDER BY OBJECT_TYPE, OBJECT_NAME`, objectStatusProjection)}}
		}
		return []objectMetadataQuerySpec{{sql: fmt.Sprintf("SELECT OWNER AS schema_name, OBJECT_NAME AS routine_name, OBJECT_TYPE AS routine_type%s FROM ALL_OBJECTS WHERE OWNER = '%s' AND OBJECT_TYPE IN ('FUNCTION','PROCEDURE') ORDER BY OBJECT_TYPE, OBJECT_NAME", objectStatusProjection, strings.ToUpper(safeDbName))}}
	case "duckdb":
		return []objectMetadataQuerySpec{{sql: `SELECT schema_name, function_name AS routine_name, 'FUNCTION' AS routine_type FROM duckdb_functions() WHERE internal = false AND lower(function_type) = 'macro' AND COALESCE(macro_definition, '') <> '' ORDER BY schema_name, function_name`, inferredType: "FUNCTION"}}
	default:
		return nil
	}
}

func buildObjectTriggerMetadataQueries(dbType string, dbName string) []objectMetadataQuerySpec {
	safeDbName := escapeSQLLiteral(dbName)
	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx":
		specs := []objectMetadataQuerySpec{
			{sql: fmt.Sprintf("SELECT TRIGGER_NAME AS trigger_name, EVENT_OBJECT_TABLE AS table_name, TRIGGER_SCHEMA AS schema_name FROM information_schema.triggers WHERE %s ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME", mysqlMetadataSchemaPredicate("TRIGGER_SCHEMA", dbName))},
		}
		if strings.TrimSpace(dbName) != "" {
			specs = append(specs, objectMetadataQuerySpec{sql: fmt.Sprintf("SHOW TRIGGERS FROM %s", quoteIdentByType("mysql", dbName))})
		}
		return append(specs, objectMetadataQuerySpec{sql: "SHOW TRIGGERS"})
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		return []objectMetadataQuerySpec{{sql: `SELECT DISTINCT event_object_schema AS schema_name, event_object_table AS table_name, trigger_name FROM information_schema.triggers WHERE trigger_schema NOT IN ('pg_catalog', 'information_schema') AND trigger_schema NOT LIKE 'pg|_%' ESCAPE '|' ORDER BY event_object_schema, event_object_table, trigger_name`}}
	case "sqlserver":
		safeDB := quoteIdentByType("sqlserver", firstNonEmptyString(dbName, "master"))
		return []objectMetadataQuerySpec{{sql: fmt.Sprintf(`SELECT s.name AS schema_name, t.name AS table_name, tr.name AS trigger_name FROM %s.sys.triggers tr JOIN %s.sys.tables t ON tr.parent_id = t.object_id JOIN %s.sys.schemas s ON t.schema_id = s.schema_id WHERE tr.parent_class = 1 ORDER BY s.name, t.name, tr.name`, safeDB, safeDB, safeDB)}}
	case "oracle":
		if strings.TrimSpace(dbName) == "" {
			return []objectMetadataQuerySpec{{sql: `SELECT t.TRIGGER_NAME AS trigger_name, t.TABLE_NAME AS table_name, o.STATUS AS object_status FROM USER_TRIGGERS t LEFT JOIN USER_OBJECTS o ON o.OBJECT_NAME = t.TRIGGER_NAME AND o.OBJECT_TYPE = 'TRIGGER' ORDER BY t.TABLE_NAME, t.TRIGGER_NAME`}}
		}
		return []objectMetadataQuerySpec{{sql: fmt.Sprintf("SELECT t.OWNER AS schema_name, t.TABLE_NAME AS table_name, t.TRIGGER_NAME AS trigger_name, o.STATUS AS object_status FROM ALL_TRIGGERS t LEFT JOIN ALL_OBJECTS o ON o.OWNER = t.OWNER AND o.OBJECT_NAME = t.TRIGGER_NAME AND o.OBJECT_TYPE = 'TRIGGER' WHERE t.OWNER = '%s' ORDER BY t.TABLE_NAME, t.TRIGGER_NAME", strings.ToUpper(safeDbName))}}
	case "dameng":
		if strings.TrimSpace(dbName) == "" {
			return []objectMetadataQuerySpec{{sql: `SELECT TRIGGER_NAME AS trigger_name, TABLE_NAME AS table_name FROM USER_TRIGGERS ORDER BY TABLE_NAME, TRIGGER_NAME`}}
		}
		return []objectMetadataQuerySpec{{sql: fmt.Sprintf("SELECT OWNER AS schema_name, TABLE_NAME AS table_name, TRIGGER_NAME AS trigger_name FROM ALL_TRIGGERS WHERE OWNER = '%s' ORDER BY TABLE_NAME, TRIGGER_NAME", strings.ToUpper(safeDbName))}}
	case "sqlite":
		return []objectMetadataQuerySpec{{sql: "SELECT name AS trigger_name, tbl_name AS table_name FROM sqlite_master WHERE type = 'trigger' ORDER BY tbl_name, name"}}
	default:
		return nil
	}
}

func buildObjectSequenceMetadataQueries(dbType string, dbName string) []objectMetadataQuerySpec {
	safeDbName := escapeSQLLiteral(dbName)
	switch dbType {
	case "oracle", "dameng":
		if strings.TrimSpace(dbName) == "" {
			return []objectMetadataQuerySpec{
				{sql: "SELECT * FROM USER_SEQUENCES ORDER BY SEQUENCE_NAME"},
				{sql: "SELECT OBJECT_NAME AS sequence_name FROM USER_OBJECTS WHERE OBJECT_TYPE = 'SEQUENCE' ORDER BY OBJECT_NAME"},
			}
		}
		owner := strings.ToUpper(safeDbName)
		return []objectMetadataQuerySpec{
			{sql: fmt.Sprintf("SELECT * FROM ALL_SEQUENCES WHERE SEQUENCE_OWNER = '%s' ORDER BY SEQUENCE_NAME", owner)},
			{sql: fmt.Sprintf("SELECT OWNER AS schema_name, OBJECT_NAME AS sequence_name FROM ALL_OBJECTS WHERE OWNER = '%s' AND OBJECT_TYPE = 'SEQUENCE' ORDER BY OBJECT_NAME", owner)},
		}
	default:
		return nil
	}
}

func buildObjectPackageMetadataQueries(dbType string, dbName string) []objectMetadataQuerySpec {
	safeDbName := escapeSQLLiteral(dbName)
	switch dbType {
	case "oracle", "dameng":
		if strings.TrimSpace(dbName) == "" {
			return []objectMetadataQuerySpec{{sql: "SELECT OBJECT_NAME AS package_name FROM USER_OBJECTS WHERE OBJECT_TYPE = 'PACKAGE' ORDER BY OBJECT_NAME"}}
		}
		return []objectMetadataQuerySpec{{sql: fmt.Sprintf("SELECT OWNER AS schema_name, OBJECT_NAME AS package_name FROM ALL_OBJECTS WHERE OWNER = '%s' AND OBJECT_TYPE = 'PACKAGE' ORDER BY OBJECT_NAME", strings.ToUpper(safeDbName))}}
	default:
		return nil
	}
}

func buildObjectEventMetadataQueries(dbType string, dbName string) []objectMetadataQuerySpec {
	if dbType != "mysql" && dbType != "mariadb" && dbType != "oceanbase" && dbType != "diros" && dbType != "starrocks" {
		return nil
	}
	specs := []objectMetadataQuerySpec{
		{sql: fmt.Sprintf("SELECT EVENT_SCHEMA AS schema_name, EVENT_NAME AS event_name, EVENT_TYPE AS event_type, STATUS AS status FROM information_schema.events WHERE %s ORDER BY EVENT_NAME", mysqlMetadataSchemaPredicate("EVENT_SCHEMA", dbName))},
	}
	if strings.TrimSpace(dbName) != "" {
		specs = append(specs, objectMetadataQuerySpec{sql: fmt.Sprintf("SHOW EVENTS FROM %s", quoteIdentByType("mysql", dbName))})
	}
	return append(specs, objectMetadataQuerySpec{sql: "SHOW EVENTS"})
}

func buildMaterializedViewMetadataQueries(dbType string, dbName string) []objectMetadataQuerySpec {
	if dbType != "starrocks" {
		return nil
	}
	specs := []objectMetadataQuerySpec{
		{sql: fmt.Sprintf("SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS object_name FROM information_schema.tables WHERE %s AND UPPER(TABLE_TYPE) LIKE '%%MATERIALIZED%%' ORDER BY TABLE_NAME", mysqlMetadataSchemaPredicate("TABLE_SCHEMA", dbName)), inferredType: "MATERIALIZED VIEW"},
	}
	if strings.TrimSpace(dbName) != "" {
		specs = append(specs, objectMetadataQuerySpec{sql: fmt.Sprintf("SHOW MATERIALIZED VIEWS FROM %s", quoteIdentByType("mysql", dbName)), inferredType: "MATERIALIZED VIEW"})
	}
	return append(specs, objectMetadataQuerySpec{sql: "SHOW MATERIALIZED VIEWS", inferredType: "MATERIALIZED VIEW"})
}

func buildMessageExchangeMetadataQueries(dbType string) []objectMetadataQuerySpec {
	if dbType != "rabbitmq" {
		return nil
	}
	return []objectMetadataQuerySpec{{sql: "SHOW EXCHANGES", inferredType: "EXCHANGE"}}
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func mysqlMetadataSchemaPredicate(column string, dbName string) string {
	if strings.TrimSpace(dbName) == "" {
		return fmt.Sprintf("%s = DATABASE()", column)
	}
	return fmt.Sprintf("%s = '%s'", column, escapeSQLLiteral(dbName))
}
