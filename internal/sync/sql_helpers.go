package sync

import (
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func selectedSyncDatabase(selected string, fallback string) string {
	if value := strings.TrimSpace(selected); value != "" {
		return value
	}
	return strings.TrimSpace(fallback)
}

func selectedSyncSourceDatabase(config SyncConfig) string {
	return selectedSyncDatabase(config.SourceDatabase, config.SourceConfig.Database)
}

func selectedSyncTargetDatabase(config SyncConfig) string {
	return selectedSyncDatabase(config.TargetDatabase, config.TargetConfig.Database)
}

func normalizeSyncConnectionDatabases(config SyncConfig) SyncConfig {
	config.SourceConfig = normalizeSyncConnectionDatabase(config.SourceConfig, config.SourceDatabase)
	config.TargetConfig = normalizeSyncConnectionDatabase(config.TargetConfig, config.TargetDatabase)
	return config
}

func normalizeSyncConnectionDatabase(config connection.ConnectionConfig, selectedDatabase string) connection.ConnectionConfig {
	selected := strings.TrimSpace(selectedDatabase)
	if selected == "" {
		return config
	}
	switch resolveMigrationDBType(config) {
	case "oracle":
		// Oracle 的 ConnectionConfig.Database 是 Service Name，数据同步选择的是 schema/owner。
		return config
	case "oceanbase":
		if isOceanBaseOracleSyncConnection(config) {
			return config
		}
	default:
		config.Database = selected
		return config
	}
	config.Database = selected
	return config
}

func isOceanBaseOracleSyncConnection(config connection.ConnectionConfig) bool {
	if !strings.EqualFold(strings.TrimSpace(config.Type), "oceanbase") {
		return false
	}
	if strings.EqualFold(strings.TrimSpace(config.OceanBaseProtocol), "oracle") {
		return true
	}
	for _, part := range strings.FieldsFunc(config.ConnectionParams, func(r rune) bool { return r == '&' || r == ';' }) {
		key, value, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		normalizedKey := strings.ToLower(strings.TrimSpace(key))
		normalizedValue := strings.ToLower(strings.TrimSpace(value))
		if (normalizedKey == "protocol" || normalizedKey == "tenantmode") && normalizedValue == "oracle" {
			return true
		}
	}
	return false
}

func normalizeSyncMode(mode string) string {
	m := strings.ToLower(strings.TrimSpace(mode))
	switch m {
	case "", "insert_update":
		return "insert_update"
	case "insert_only":
		return "insert_only"
	case "full_overwrite":
		return "full_overwrite"
	default:
		return "insert_update"
	}
}

func quoteIdentByType(dbType string, ident string) string {
	if ident == "" {
		return ident
	}

	switch normalizeMigrationDBType(dbType) {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "clickhouse", "tdengine":
		return "`" + strings.ReplaceAll(ident, "`", "``") + "`"
	case "kingbase":
		return db.QuoteKingbaseIdentifier(ident)
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

	normalizedType := normalizeMigrationDBType(dbType)
	if normalizedType == "kingbase" {
		schema, table := db.SplitKingbaseQualifiedName(raw)
		if table == "" {
			return quoteIdentByType(normalizedType, raw)
		}
		if schema == "" {
			return quoteIdentByType(normalizedType, table)
		}
		return quoteIdentByType(normalizedType, schema) + "." + quoteIdentByType(normalizedType, table)
	}

	parts := strings.Split(raw, ".")
	if len(parts) <= 1 {
		return quoteIdentByType(normalizedType, raw)
	}

	quotedParts := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		quotedParts = append(quotedParts, quoteIdentByType(normalizedType, part))
	}

	if len(quotedParts) == 0 {
		return quoteIdentByType(normalizedType, raw)
	}
	return strings.Join(quotedParts, ".")
}

func qualifySchemaTableName(schema string, table string) string {
	rawSchema := strings.TrimSpace(schema)
	rawTable := strings.TrimSpace(table)
	if rawTable == "" || rawSchema == "" || strings.Contains(rawTable, ".") {
		return rawTable
	}
	return rawSchema + "." + rawTable
}

func lastSyncTableIdentifier(tableName string) string {
	parts := strings.Split(strings.TrimSpace(tableName), ".")
	for i := len(parts) - 1; i >= 0; i-- {
		part := strings.TrimSpace(parts[i])
		if part != "" {
			return part
		}
	}
	return strings.TrimSpace(tableName)
}

func normalizeSchemaAndTable(dbType string, dbName string, tableName string) (string, string) {
	rawTable := strings.TrimSpace(tableName)
	rawDB := strings.TrimSpace(dbName)
	if rawTable == "" {
		return rawDB, rawTable
	}

	normalizedType := normalizeMigrationDBType(dbType)
	switch normalizedType {
	case "sqlserver", "duckdb":
		return rawDB, rawTable
	}
	if normalizedType == "kingbase" {
		schema, table := db.SplitKingbaseQualifiedName(rawTable)
		if schema != "" && table != "" {
			return schema, table
		}
		if table != "" {
			return "public", table
		}
	}

	if parts := strings.SplitN(rawTable, ".", 2); len(parts) == 2 {
		schema := strings.TrimSpace(parts[0])
		table := strings.TrimSpace(parts[1])
		if schema != "" && table != "" {
			return schema, table
		}
	}

	switch normalizedType {
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		return "public", rawTable
	case "duckdb":
		return "main", rawTable
	default:
		return rawDB, rawTable
	}
}

func normalizeSchemaAndTableWithDefaultSchema(dbType string, dbName string, defaultSchema string, tableName string) (string, string) {
	rawDefaultSchema := strings.TrimSpace(defaultSchema)
	if rawDefaultSchema == "" {
		return normalizeSchemaAndTable(dbType, dbName, tableName)
	}

	rawTable := strings.TrimSpace(tableName)
	if rawTable == "" {
		switch normalizeMigrationDBType(dbType) {
		case "sqlserver", "duckdb":
			return strings.TrimSpace(dbName), rawTable
		default:
			return rawDefaultSchema, rawTable
		}
	}

	switch normalizeMigrationDBType(dbType) {
	case "sqlserver", "duckdb":
		return strings.TrimSpace(dbName), qualifySchemaTableName(rawDefaultSchema, rawTable)
	}

	if parts := strings.SplitN(rawTable, ".", 2); len(parts) == 2 {
		schema := strings.TrimSpace(parts[0])
		table := strings.TrimSpace(parts[1])
		if schema != "" && table != "" {
			return schema, table
		}
	}

	switch normalizeMigrationDBType(dbType) {
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "iris":
		return rawDefaultSchema, rawTable
	default:
		return normalizeSchemaAndTable(dbType, dbName, tableName)
	}
}

func normalizeSyncSourceSchemaAndTable(config SyncConfig, tableName string) (string, string) {
	return normalizeSchemaAndTableWithDefaultSchema(config.SourceConfig.Type, selectedSyncSourceDatabase(config), "", tableName)
}

func normalizeSyncTargetSchemaAndTable(config SyncConfig, tableName string) (string, string) {
	if targetName := strings.TrimSpace(config.identityMappingTarget.Name); targetName != "" {
		targetSchema := strings.TrimSpace(config.identityMappingTarget.Schema)
		if targetSchema == "" {
			targetSchema = strings.TrimSpace(config.TargetSchema)
		}
		return normalizeSchemaAndTableWithDefaultSchema(
			config.TargetConfig.Type,
			selectedSyncTargetDatabase(config),
			targetSchema,
			targetName,
		)
	}
	targetSchema := strings.TrimSpace(config.TargetSchema)
	if targetSchema == "" || strings.TrimSpace(config.SourceQuery) != "" {
		return normalizeSchemaAndTableWithDefaultSchema(config.TargetConfig.Type, selectedSyncTargetDatabase(config), targetSchema, tableName)
	}
	return normalizeSchemaAndTableWithDefaultSchema(
		config.TargetConfig.Type,
		selectedSyncTargetDatabase(config),
		targetSchema,
		lastSyncTableIdentifier(tableName),
	)
}

func shouldUseQualifiedSyncApplyTable(config connection.ConnectionConfig) bool {
	switch resolveMigrationDBType(config) {
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "sqlserver", "oracle", "dameng", "iris", "duckdb":
		return true
	case "oceanbase":
		return isOceanBaseOracleSyncConnection(config)
	default:
		return false
	}
}

func qualifiedNameForQuery(dbType string, schema string, table string, original string) string {
	raw := strings.TrimSpace(original)
	rawTable := strings.TrimSpace(table)
	if raw == "" {
		return raw
	}
	if strings.Contains(raw, ".") {
		return raw
	}
	if rawTable == "" {
		return raw
	}
	if strings.Contains(rawTable, ".") {
		return rawTable
	}

	switch normalizeMigrationDBType(dbType) {
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		s := strings.TrimSpace(schema)
		if s == "" {
			s = "public"
		}
		return s + "." + rawTable
	case "duckdb":
		return "main." + rawTable
	case "sqlserver":
		return "dbo." + rawTable
	case "oracle", "dameng", "iris":
		s := strings.TrimSpace(schema)
		if s == "" {
			return rawTable
		}
		return s + "." + rawTable
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "clickhouse", "tdengine":
		s := strings.TrimSpace(schema)
		if s == "" {
			return rawTable
		}
		return s + "." + rawTable
	default:
		return rawTable
	}
}

// qualifiedTargetNameForQuery derives a target-side query name strictly from
// the resolved target object. A source table name may be schema-qualified and
// must not leak into target DDL or DML for an identity object mapping.
func qualifiedTargetNameForQuery(dbType string, schema string, table string) string {
	// SQL Server and DuckDB carry schema-qualified names in table. Passing a
	// separately composed schema.table value would accidentally add the
	// database/catalog as a third component, so table is the target's original
	// identifier here.
	return qualifiedNameForQuery(dbType, schema, table, table)
}
