package db

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func metadataDiscoverySource(config connection.ConnectionConfig) string {
	if normalizeRuntimeDriverType(config.Type) == "custom" {
		return normalizeRuntimeDriverType(config.Driver)
	}
	return normalizeRuntimeDriverType(config.Type)
}

// Keep specialized PostgreSQL catalogs intact when applying a visibility scope:
// GBase external tables and KWDB time-series tables are not ordinary relkind='r' tables.
func pgDiscoveryTablesQuery(config connection.ConnectionConfig) (query, schemaColumn string, legacyFallback bool) {
	switch metadataDiscoverySource(config) {
	case "gbase8c":
		return `SELECT n.nspname AS schemaname, c.relname AS tablename
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'f') AND ` + gbase8cUserNamespacePredicate("n") + `
AND ` + gbase8cNotExtensionRelation("c") + ` ORDER BY n.nspname, c.relname`, "n.nspname", false
	case "cockroachdb", "kwdb":
		return `SELECT table_schema AS schemaname, table_name AS tablename
FROM information_schema.tables WHERE table_type IN ('BASE TABLE', 'TIME SERIES TABLE')
AND table_schema NOT IN ('information_schema', 'pg_catalog', 'pg_extension', '` + cockroachInternalSchema(config) + `') ORDER BY 1, 2`, "table_schema", false
	default:
		return buildPostgresTablesQuery(), "n.nspname", true
	}
}

// cockroachInternalSchema is the built-in function/virtual-table schema hidden by the native catalogs.
func cockroachInternalSchema(config connection.ConnectionConfig) string {
	if metadataDiscoverySource(config) == "kwdb" {
		return "kwdb_internal"
	}
	return "crdb_internal"
}

func pgDiscoveryColumnsQuery(config connection.ConnectionConfig) (query, schemaColumn string) {
	// The native CockroachDB/KWDB column catalog drops these schemas after reading; keep them out of scoped reads too.
	hiddenCockroachSchemas := ""
	if source := metadataDiscoverySource(config); source == "cockroachdb" || source == "kwdb" {
		hiddenCockroachSchemas = "\nAND c.table_schema NOT IN ('pg_extension', '" + cockroachInternalSchema(config) + "')"
	}
	if metadataDiscoverySource(config) == "gbase8c" {
		return `SELECT n.nspname AS table_schema, c.relname AS table_name, a.attname AS column_name,
pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type, pg_catalog.col_description(c.oid, a.attnum) AS comment
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
WHERE c.relkind IN ('r', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped
AND ` + gbase8cUserNamespacePredicate("n") + ` AND ` + gbase8cNotExtensionRelation("c") + `
ORDER BY n.nspname, c.relname, a.attnum`, "n.nspname"
	}
	return `SELECT c.table_schema, c.table_name, c.column_name, c.data_type, col_description(cls.oid, a.attnum) AS comment
FROM information_schema.columns c
LEFT JOIN pg_namespace n ON n.nspname = c.table_schema
LEFT JOIN pg_class cls ON cls.relnamespace = n.oid AND cls.relname = c.table_name
LEFT JOIN pg_attribute a ON a.attrelid = cls.oid AND a.attname = c.column_name
WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
AND c.table_schema NOT LIKE 'pg|_%' ESCAPE '|'` + hiddenCockroachSchemas + `
ORDER BY c.table_schema, c.table_name, c.ordinal_position`, "c.table_schema"
}

func registryDiscoverySchemaPredicate(config connection.ConnectionConfig, column string) string {
	spec, ok := DataSourceSpec(metadataDiscoverySource(config))
	if !ok {
		return ""
	}
	conditions := make([]string, 0, len(spec.UI.HiddenSchemas)+len(spec.UI.HiddenSchemaPrefixes))
	for _, name := range spec.UI.HiddenSchemas {
		conditions = append(conditions, column+" <> "+metadataScopeLiteral(name, "postgres"))
	}
	for _, prefix := range spec.UI.HiddenSchemaPrefixes {
		// Prefixes in the registry are literal identifier prefixes, not LIKE patterns.
		pattern := metadataLikeLiteral(prefix) + "%"
		conditions = append(conditions, column+" NOT LIKE "+metadataScopeLiteral(pattern, "postgres")+" ESCAPE '|'")
	}
	return strings.Join(conditions, " AND ")
}

// GBase extension schemas are filtered by OID and dependency membership, with public kept visible.
func gbase8cUserNamespacePredicate(alias string) string {
	return fmt.Sprintf(`(%[1]s.oid >= 16384 OR %[1]s.nspname = 'public')
  AND %[1]s.nspname NOT LIKE 'pg|_%%' ESCAPE '|'
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend dn WHERE dn.classid = 'pg_catalog.pg_namespace'::regclass AND dn.objid = %[1]s.oid AND dn.deptype = 'e')`, alias)
}

func gbase8cNotExtensionRelation(alias string) string {
	return fmt.Sprintf(`NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend dc WHERE dc.classid = 'pg_catalog.pg_class'::regclass AND dc.objid = %s.oid AND dc.deptype = 'e')`, alias)
}
