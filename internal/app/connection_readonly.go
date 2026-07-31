package app

import (
	"encoding/json"
	"errors"
	"strings"

	"GoNavi-Wails/internal/connection"
)

type connectionProtectionKey string

const (
	connectionProtectionDataEdit        connectionProtectionKey = "restrictDataEdit"
	connectionProtectionStructureEdit   connectionProtectionKey = "restrictStructureEdit"
	connectionProtectionScriptExecution connectionProtectionKey = "restrictScriptExecution"
	connectionProtectionDataImport      connectionProtectionKey = "restrictDataImport"
)

var connectionReadOnlySupportedTypes = map[string]struct{}{
	"clickhouse": {},
	"dameng":     {},
	"diros":      {},
	"duckdb":     {},
	"gaussdb":    {},
	"highgo":     {},
	"iris":       {},
	"kingbase":   {},
	"mariadb":    {},
	"mongodb":    {},
	"mysql":      {},
	"nacos":      {},
	"oceanbase":  {},
	"opengauss":  {},
	"oracle":     {},
	"postgres":   {},
	"sphinx":     {},
	"sqlite":     {},
	"sqlserver":  {},
	"starrocks":  {},
	"tdengine":   {},
	"trino":      {},
	"vastbase":   {},
}

var mongoReadOnlyCommands = map[string]struct{}{
	"aggregate":        {},
	"buildinfo":        {},
	"collstats":        {},
	"connectionstatus": {},
	"count":            {},
	"countdocuments":   {},
	"dbstats":          {},
	"distinct":         {},
	"explain":          {},
	"find":             {},
	"findone":          {},
	"getparameter":     {},
	"hello":            {},
	"hostinfo":         {},
	"ismaster":         {},
	"listcollections":  {},
	"listdatabases":    {},
	"listindexes":      {},
	"ping":             {},
	"serverstatus":     {},
}

var mongoWriteCommands = map[string]struct{}{
	"bulkwrite":        {},
	"collmod":          {},
	"create":           {},
	"createindexes":    {},
	"delete":           {},
	"drop":             {},
	"dropdatabase":     {},
	"dropindexes":      {},
	"findandmodify":    {},
	"insert":           {},
	"mapreduce":        {},
	"renamecollection": {},
	"update":           {},
}

var milvusReadOnlyCommands = map[string]struct{}{
	"count":               {},
	"describe_collection": {},
	"describecollection":  {},
	"get":                 {},
	"get_collection":      {},
	"getcollection":       {},
	"list_collections":    {},
	"listcollections":     {},
	"query":               {},
	"scroll":              {},
	"search":              {},
}

var milvusWriteCommands = map[string]struct{}{
	"create_collection": {},
	"create_index":      {},
	"createcollection":  {},
	"createindex":       {},
	"delete":            {},
	"drop_collection":   {},
	"drop_index":        {},
	"dropcollection":    {},
	"dropindex":         {},
	"insert":            {},
	"upsert":            {},
}

var mongoMetaCommandKeys = map[string]struct{}{
	"$db":                  {},
	"$readpreference":      {},
	"api":                  {},
	"apideprecationerrors": {},
	"apistrict":            {},
	"comment":              {},
	"let":                  {},
	"lsid":                 {},
	"maxtimems":            {},
	"ordered":              {},
	"readconcern":          {},
	"writeconcern":         {},
}

var readOnlyConnectionActionTextKeys = map[string]string{
	"创建数据库": "connection.backend.action.create_database",
	"connection.backend.action.create_database": "connection.backend.action.create_database",
	"创建模式": "connection.backend.action.create_schema",
	"connection.backend.action.create_schema":              "connection.backend.action.create_schema",
	"重命名模式":                                                "connection.backend.action.rename_schema",
	"connection.backend.action.rename_schema":              "connection.backend.action.rename_schema",
	"删除模式":                                                 "connection.backend.action.drop_schema",
	"connection.backend.action.drop_schema":                "connection.backend.action.drop_schema",
	"重命名数据库":                                               "connection.backend.action.rename_database",
	"connection.backend.action.rename_database":            "connection.backend.action.rename_database",
	"删除数据库":                                                "connection.backend.action.drop_database",
	"connection.backend.action.drop_database":              "connection.backend.action.drop_database",
	"重命名表":                                                 "connection.backend.action.rename_table",
	"connection.backend.action.rename_table":               "connection.backend.action.rename_table",
	"复制整表":                                                 "connection.backend.action.copy_table",
	"connection.backend.action.copy_table":                 "connection.backend.action.copy_table",
	"删除表":                                                  "connection.backend.action.drop_table",
	"connection.backend.action.drop_table":                 "connection.backend.action.drop_table",
	"删除视图":                                                 "connection.backend.action.drop_view",
	"connection.backend.action.drop_view":                  "connection.backend.action.drop_view",
	"删除函数或存储过程":                                            "connection.backend.action.drop_function_or_procedure",
	"connection.backend.action.drop_function_or_procedure": "connection.backend.action.drop_function_or_procedure",
	"重命名视图":                                                "connection.backend.action.rename_view",
	"connection.backend.action.rename_view":                "connection.backend.action.rename_view",
	"导入数据":                                                 "connection.backend.action.import_data",
	"connection.backend.action.import_data":                "connection.backend.action.import_data",
	"提交结果修改":                                               "connection.backend.action.apply_result_changes",
	"connection.backend.action.apply_result_changes":       "connection.backend.action.apply_result_changes",
	"预览结果修改":                                               "connection.backend.action.preview_result_changes",
	"connection.backend.action.preview_result_changes":     "connection.backend.action.preview_result_changes",
	"clear_table":                                          "connection.backend.action.clear_table",
	"connection.backend.action.clear_table":                "connection.backend.action.clear_table",
	"truncate_table":                                       "connection.backend.action.truncate_table",
	"connection.backend.action.truncate_table":             "connection.backend.action.truncate_table",
	"connection.backend.action.data_sync_structure":        "connection.backend.action.data_sync_structure",
	"数据同步写入":                                               "connection.backend.action.data_sync_write",
	"connection.backend.action.data_sync_write":            "connection.backend.action.data_sync_write",
}

func supportsConnectionReadOnlyMode(config connection.ConnectionConfig) bool {
	_, ok := connectionReadOnlySupportedTypes[resolveDDLDBType(config)]
	return ok
}

func hasAnyConnectionProtection(config connection.ConnectionProtectionConfig) bool {
	return config.RestrictDataEdit ||
		config.RestrictStructureEdit ||
		config.RestrictScriptExecution ||
		config.RestrictDataImport
}

func resolveConnectionProtectionConfig(config connection.ConnectionConfig) connection.ConnectionProtectionConfig {
	if !supportsConnectionReadOnlyMode(config) {
		return connection.ConnectionProtectionConfig{}
	}
	if hasAnyConnectionProtection(config.Protection) {
		return config.Protection
	}
	if config.ReadOnly {
		return connection.ConnectionProtectionConfig{
			RestrictDataEdit:        true,
			RestrictStructureEdit:   true,
			RestrictScriptExecution: true,
			RestrictDataImport:      true,
		}
	}
	return connection.ConnectionProtectionConfig{}
}

func isConnectionProtectionEnabled(config connection.ConnectionConfig, key connectionProtectionKey) bool {
	protection := resolveConnectionProtectionConfig(config)
	switch key {
	case connectionProtectionDataEdit:
		return protection.RestrictDataEdit
	case connectionProtectionStructureEdit:
		return protection.RestrictStructureEdit
	case connectionProtectionScriptExecution:
		return protection.RestrictScriptExecution
	case connectionProtectionDataImport:
		return protection.RestrictDataImport
	default:
		return false
	}
}

func isConnectionForcedReadOnly(config connection.ConnectionConfig) bool {
	protection := resolveConnectionProtectionConfig(config)
	return protection.RestrictDataEdit &&
		protection.RestrictStructureEdit &&
		protection.RestrictScriptExecution &&
		protection.RestrictDataImport
}

func isConnectionScriptExecutionRestricted(config connection.ConnectionConfig) bool {
	return isConnectionProtectionEnabled(config, connectionProtectionScriptExecution)
}

func normalizeReadOnlyConnectionText(text func(string, map[string]any) string) func(string, map[string]any) string {
	if text != nil {
		return text
	}
	return defaultAppText
}

func readOnlyConnectionQueryBlockedMessageWithText(text func(string, map[string]any) string) string {
	text = normalizeReadOnlyConnectionText(text)
	return text("query_editor.message.connection_readonly_blocked", nil)
}

func resolveReadOnlyConnectionActionLabel(action string, text func(string, map[string]any) string) string {
	label := strings.TrimSpace(action)
	if label == "" {
		return ""
	}
	text = normalizeReadOnlyConnectionText(text)
	if key, ok := readOnlyConnectionActionTextKeys[label]; ok {
		return text(key, nil)
	}
	return label
}

func readOnlyConnectionQueryBlockedMessage() string {
	return readOnlyConnectionQueryBlockedMessageWithText(defaultAppText)
}

func readOnlyConnectionActionBlockedMessageWithText(action string, text func(string, map[string]any) string) string {
	label := resolveReadOnlyConnectionActionLabel(action, text)
	if label == "" {
		return readOnlyConnectionQueryBlockedMessageWithText(text)
	}
	text = normalizeReadOnlyConnectionText(text)
	return text("connection.backend.error.readonly_action_blocked", map[string]any{"action": label})
}

func readOnlyConnectionActionBlockedMessage(action string) string {
	return readOnlyConnectionActionBlockedMessageWithText(action, defaultAppText)
}

func ensureConnectionAllowsQueryWithText(config connection.ConnectionConfig, query string, text func(string, map[string]any) string) error {
	text = normalizeReadOnlyConnectionText(text)
	if !isConnectionScriptExecutionRestricted(config) {
		return nil
	}
	dbType := resolveDDLDBType(config)
	for _, statement := range splitSQLStatementsForDialect(dbType, query) {
		if trimmed := strings.TrimSpace(statement); trimmed != "" && !isReadOnlySQLQuery(dbType, trimmed) {
			return errors.New(readOnlyConnectionQueryBlockedMessageWithText(text))
		}
	}
	return nil
}

func ensureConnectionAllowsQuery(config connection.ConnectionConfig, query string) error {
	return ensureConnectionAllowsQueryWithText(config, query, defaultAppText)
}

func ensureConnectionAllowsActionWithText(config connection.ConnectionConfig, key connectionProtectionKey, action string, text func(string, map[string]any) string) error {
	text = normalizeReadOnlyConnectionText(text)
	if !isConnectionProtectionEnabled(config, key) {
		return nil
	}
	return errors.New(readOnlyConnectionActionBlockedMessageWithText(action, text))
}

func ensureConnectionAllowsAction(config connection.ConnectionConfig, key connectionProtectionKey, action string) error {
	return ensureConnectionAllowsActionWithText(config, key, action, defaultAppText)
}

func ensureConnectionAllowsDataEdit(config connection.ConnectionConfig, action string) error {
	return ensureConnectionAllowsAction(config, connectionProtectionDataEdit, action)
}

func ensureConnectionAllowsStructureEdit(config connection.ConnectionConfig, action string) error {
	return ensureConnectionAllowsAction(config, connectionProtectionStructureEdit, action)
}

func ensureConnectionAllowsDataImport(config connection.ConnectionConfig, action string) error {
	return ensureConnectionAllowsAction(config, connectionProtectionDataImport, action)
}

func isReadOnlyMongoCommand(query string) bool {
	trimmed := strings.TrimSpace(query)
	if !strings.HasPrefix(trimmed, "{") {
		return false
	}
	var doc map[string]interface{}
	if err := json.Unmarshal([]byte(trimmed), &doc); err != nil {
		return false
	}
	commandKey := resolveMongoCommandKey(doc)
	if commandKey == "" {
		return false
	}
	if _, blocked := mongoWriteCommands[commandKey]; blocked {
		return false
	}
	if commandKey == "aggregate" && mongoAggregateHasWriteStage(doc) {
		return false
	}
	_, allowed := mongoReadOnlyCommands[commandKey]
	return allowed
}

func mongoAggregateHasWriteStage(doc map[string]interface{}) bool {
	var pipeline interface{}
	for key, value := range doc {
		if strings.EqualFold(strings.TrimSpace(key), "pipeline") {
			pipeline = value
			break
		}
	}
	stages, ok := pipeline.([]interface{})
	if !ok {
		return false
	}
	for _, rawStage := range stages {
		stage, ok := rawStage.(map[string]interface{})
		if !ok {
			continue
		}
		for key := range stage {
			switch strings.ToLower(strings.TrimSpace(key)) {
			case "$out", "$merge":
				return true
			}
		}
	}
	return false
}

func isReadOnlyMilvusCommand(query string) bool {
	trimmed := strings.TrimSpace(query)
	if !strings.HasPrefix(trimmed, "{") {
		keyword, withHasWrite := sqlDataOperationInfo(trimmed)
		return !withHasWrite && keyword == "select" && !isSQLSelectIntoStatement(trimmed)
	}
	var doc map[string]interface{}
	if err := json.Unmarshal([]byte(trimmed), &doc); err != nil {
		return false
	}

	readOnly := false
	for key := range doc {
		normalized := strings.ToLower(strings.TrimSpace(key))
		if _, isWrite := milvusWriteCommands[normalized]; isWrite {
			return false
		}
		if _, isRead := milvusReadOnlyCommands[normalized]; isRead {
			readOnly = true
		}
	}
	if readOnly {
		return true
	}

	// The Milvus driver treats a collection-only JSON command as a query preview.
	_, hasCollection := doc["collection"]
	return hasCollection
}

func resolveMongoCommandKey(doc map[string]interface{}) string {
	commandKey := ""
	for key := range doc {
		normalized := strings.ToLower(strings.TrimSpace(key))
		if normalized == "" {
			continue
		}
		if _, isMeta := mongoMetaCommandKeys[normalized]; isMeta {
			continue
		}
		if _, isWrite := mongoWriteCommands[normalized]; isWrite {
			return normalized
		}
		if _, isRead := mongoReadOnlyCommands[normalized]; isRead {
			commandKey = normalized
		}
	}
	return commandKey
}
