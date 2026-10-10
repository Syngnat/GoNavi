package db

import (
	"context"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func metadataDiscoveryDialect(config connection.ConnectionConfig) string {
	typeName := normalizeRuntimeDriverType(config.Type)
	if typeName == "custom" {
		// Custom drivers have their own schema/database semantics and fallback catalogs.
		return "custom"
	}
	if spec, ok := DataSourceSpec(typeName); ok && spec.DDLDialect != "" {
		typeName = spec.DDLDialect
	}
	switch typeName {
	case "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		return "postgres"
	default:
		return typeName
	}
}

func metadataScopeLiteral(value, dialect string) string {
	escaped := strings.ReplaceAll(value, "'", "''")
	if dialect == "postgres" && strings.Contains(value, "\\") {
		return "E'" + strings.ReplaceAll(escaped, "\\", "\\\\") + "'"
	}
	if dialect == "sqlserver" {
		return "N'" + escaped + "'"
	}
	return "'" + escaped + "'"
}

func metadataSchemaPredicate(column string, scope *connection.MetadataSchemaScope, dialect string) string {
	if scope == nil || len(scope.Names) == 0 || (scope.Mode != "include" && scope.Mode != "exclude") {
		return ""
	}
	values := make([]string, 0, len(scope.Names))
	for _, name := range scope.Names {
		if !scope.CaseSensitive {
			name = strings.ToLower(name)
		}
		values = append(values, metadataScopeLiteral(name, dialect))
	}
	if !scope.CaseSensitive {
		column = "LOWER(" + column + ")"
	}
	operator := " IN "
	if scope.Mode == "exclude" {
		operator = " NOT IN "
	}
	return column + operator + "(" + strings.Join(values, ", ") + ")"
}

// metadataLikeLiteral escapes an identifier prefix for LIKE ... ESCAPE '|'.
func metadataLikeLiteral(value string) string {
	return strings.NewReplacer("|", "||", "%", "|%", "_", "|_").Replace(value)
}

func queryScopedMetadata(ctx context.Context, inst Database, query string) ([]map[string]interface{}, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if contextual, ok := inst.(QueryContexter); ok {
		rows, _, err := contextual.QueryContext(ctx, query)
		return rows, err
	}
	rows, _, err := inst.Query(query)
	return rows, err
}

// DiscoverTables queries only selected schemas, including both partition parents and children.
func DiscoverTables(ctx context.Context, inst Database, config connection.ConnectionConfig, dbName string, scope *connection.MetadataDiscoveryScope) ([]string, error) {
	if scope == nil || scope.Schemas == nil {
		return inst.GetTables(dbName)
	}
	dialect := metadataDiscoveryDialect(config)
	var query, column string
	legacyFallback := false
	switch dialect {
	case "postgres":
		query, column, legacyFallback = pgDiscoveryTablesQuery(config)
	case "sqlserver":
		query, column = sqlServerListTablesQuery(), "s.name"
	default:
		return inst.GetTables(dbName)
	}
	predicate := metadataSchemaPredicate(column, scope.Schemas, dialect)
	if predicate == "" {
		return inst.GetTables(dbName)
	}
	if hidden := registryDiscoverySchemaPredicate(config, column); hidden != "" {
		predicate += " AND " + hidden
	}
	query = strings.Replace(query, "ORDER BY", "AND "+predicate+" ORDER BY", 1)
	rows, err := queryScopedMetadata(ctx, inst, query)
	if err != nil && legacyFallback && ctx.Err() == nil {
		fallbackPredicate := metadataSchemaPredicate("schemaname", scope.Schemas, dialect)
		if hidden := registryDiscoverySchemaPredicate(config, "schemaname"); hidden != "" {
			fallbackPredicate += " AND " + hidden
		}
		fallback := strings.Replace(buildPostgresLegacyTablesQuery(), "ORDER BY", "AND "+fallbackPredicate+" ORDER BY", 1)
		rows, err = queryScopedMetadata(ctx, inst, fallback)
	}
	if err != nil {
		return nil, err
	}
	if dialect == "postgres" {
		return resolveShardingSphereLogicalTables(parsePostgresTableNames(rows), inst.Query), nil
	}
	names := make([]string, 0, len(rows))
	for _, row := range rows {
		schema, name := getCaseInsensitiveRowString(row, "schema_name"), getCaseInsensitiveRowString(row, "table_name")
		if name != "" {
			names = append(names, formatSQLServerTableMetadataName(schema, name))
		}
	}
	return names, nil
}

// DiscoverColumns keeps PostgreSQL-family completion metadata within the configured schema scope.
func DiscoverColumns(ctx context.Context, inst Database, config connection.ConnectionConfig, dbName string, scope *connection.MetadataDiscoveryScope) ([]connection.ColumnDefinitionWithTable, error) {
	dialect := metadataDiscoveryDialect(config)
	if scope == nil || scope.Schemas == nil || (dialect != "postgres" && dialect != "sqlserver") {
		return inst.GetAllColumns(dbName)
	}
	query, schemaColumn := pgDiscoveryColumnsQuery(config)
	if dialect == "sqlserver" {
		query, schemaColumn = sqlServerAllColumnsQuery(), "s.name"
	}
	predicate := metadataSchemaPredicate(schemaColumn, scope.Schemas, dialect)
	if predicate == "" {
		return inst.GetAllColumns(dbName)
	}
	if hidden := registryDiscoverySchemaPredicate(config, schemaColumn); hidden != "" {
		predicate += " AND " + hidden
	}
	query = strings.Replace(query, "ORDER BY", "AND "+predicate+" ORDER BY", 1)
	rows, err := queryScopedMetadata(ctx, inst, query)
	if err != nil {
		return nil, err
	}
	columns := make([]connection.ColumnDefinitionWithTable, 0, len(rows))
	for _, row := range rows {
		schema, table := metadataDiscoveryValue(row, "table_schema", "schema_name"), metadataDiscoveryValue(row, "table_name")
		if table == "" {
			continue
		}
		tableName := encodePGLikeQualifiedNamePart(table)
		if schema != "" {
			tableName = fmt.Sprintf("%s.%s", encodePGLikeQualifiedNamePart(schema), tableName)
		}
		if dialect == "sqlserver" {
			tableName = formatSQLServerTableMetadataName(schema, table)
		}
		columns = append(columns, connection.ColumnDefinitionWithTable{
			TableName: tableName, Name: metadataDiscoveryValue(row, "column_name"),
			Type: metadataDiscoveryValue(row, "data_type"), Comment: metadataDiscoveryValue(row, "comment"),
		})
	}
	return columns, nil
}

func metadataDiscoveryValue(row map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		for column, value := range row {
			if strings.EqualFold(column, key) && value != nil {
				return fmt.Sprint(value)
			}
		}
	}
	return ""
}
