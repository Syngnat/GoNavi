import type { SavedConnection } from "../../types";
import { buildMetadataDiscoveryScope, buildMetadataSchemaPredicate } from '../../utils/metadataDiscoveryScope';
import { splitQualifiedNameSegmentsDetailed } from "../../utils/qualifiedName";
import { quoteSqlIdentifierPart, resolveSqlDialect } from "../../utils/sqlDialect";
import { getMetadataDialect, escapeSQLLiteral } from "./sidebarMetadataBasics";
import { resolvePgTableStatsSql, resolveRegistryTableStatusSql } from "../../utils/dataSourceRegistry/tableStats";

export const buildSidebarTableStatusSQL = (
  conn: SavedConnection,
  dbName: string,
  serverVersion = "",
): string => {
  const dialect = getMetadataDialect(conn);
  const safeDbName = escapeSQLLiteral(dbName);
  const schemaScope = buildMetadataDiscoveryScope(conn, dbName)?.schemas;
  switch (dialect) {
    case "mysql":
      return [
        "SELECT TABLE_NAME AS table_name, TABLE_COMMENT AS table_comment, TABLE_ROWS AS table_rows,",
        "ENGINE AS table_engine,",
        "COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS table_size,",
        "CREATE_TIME AS create_time, UPDATE_TIME AS update_time",
        "FROM information_schema.tables",
        `WHERE table_schema = '${safeDbName}'`,
        "AND table_type = 'BASE TABLE'",
        "ORDER BY table_name",
      ].join("\n");
    case "starrocks":
      return [
        "SELECT TABLE_NAME AS table_name, TABLE_COMMENT AS table_comment, TABLE_ROWS AS table_rows,",
        "COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS table_size,",
        "CREATE_TIME AS create_time, UPDATE_TIME AS update_time",
        "FROM information_schema.tables",
        `WHERE table_schema = '${safeDbName}'`,
        "AND table_type = 'BASE TABLE'",
        "ORDER BY table_name",
      ].join("\n");
    case "postgres":
    case "kingbase":
    case "vastbase":
    case "highgo":
    case "opengauss":
    case "gaussdb": {
      const stats = resolvePgTableStatsSql(conn?.config?.type, serverVersion);
      return [
        "SELECT n.nspname AS schema_name, c.relname AS object_name, n.nspname || '.' || c.relname AS table_name, obj_description(c.oid, 'pg_class') AS table_comment,",
        `CASE WHEN c.relkind = 'p' THEN NULL ELSE ${stats.rows} END AS table_rows,`,
        "(SELECT parent_n.nspname || '.' || parent_c.relname",
        " FROM pg_inherits inheritance",
        " JOIN pg_class parent_c ON parent_c.oid = inheritance.inhparent AND parent_c.relkind = 'p'",
        " JOIN pg_namespace parent_n ON parent_n.oid = parent_c.relnamespace",
        " WHERE inheritance.inhrelid = c.oid",
        " ORDER BY inheritance.inhseqno LIMIT 1) AS partition_parent_table,",
        `${stats.size} AS table_size, NULL::text AS create_time, NULL::text AS update_time`,
        "FROM pg_class c",
        "JOIN pg_namespace n ON n.oid = c.relnamespace",
        "WHERE c.relkind IN ('r', 'p')",
        "AND n.nspname NOT IN ('information_schema', 'pg_catalog')",
        "AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'",
        schemaScope ? `AND ${buildMetadataSchemaPredicate('n.nspname', schemaScope, dialect)}` : '',
        "ORDER BY n.nspname, c.relname",
      ].join("\n");
    }
    case "sqlserver": {
      // Azure SQL Database rejects or hangs on three-part names such as
      // [db].sys.tables. The metadata connection is already opened with
      // database=dbName, so current-database sys.* views are the portable form.
      return [
        "SELECT s.name AS schema_name, t.name AS object_name, s.name + '.' + t.name AS table_name, CONVERT(nvarchar(4000), ep.value) AS table_comment, SUM(p.rows) AS table_rows,",
        "CAST(NULL AS bigint) AS table_size, t.create_date AS create_time, t.modify_date AS update_time",
        "FROM sys.tables t",
        "JOIN sys.schemas s ON t.schema_id = s.schema_id",
        "LEFT JOIN sys.extended_properties ep ON ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'",
        "LEFT JOIN sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0, 1)",
        "WHERE t.type = 'U'",
        schemaScope ? `AND ${buildMetadataSchemaPredicate('s.name', schemaScope, dialect)}` : '',
        "GROUP BY s.name, t.name, CONVERT(nvarchar(4000), ep.value), t.create_date, t.modify_date",
        "ORDER BY s.name, t.name",
      ].join("\n");
    }
    case "clickhouse":
      return [
        "SELECT name AS table_name, comment AS table_comment, total_rows AS table_rows,",
        "total_bytes AS table_size, NULL AS create_time, metadata_modification_time AS update_time",
        "FROM system.tables",
        `WHERE database = '${safeDbName}'`,
        "AND engine NOT IN ('View', 'MaterializedView')",
        "ORDER BY name",
      ].join("\n");
    case "oracle":
    case "dm": {
      const owner = escapeSQLLiteral(dbName).toUpperCase();
      return [
        "SELECT c.owner AS schema_name, c.table_name, c.comments AS table_comment, t.num_rows AS table_rows,",
        "COALESCE(t.blocks, 0) * 8192 AS table_size, o.created AS create_time, o.last_ddl_time AS update_time",
        "FROM all_tab_comments c",
        "JOIN all_tables t ON t.owner = c.owner AND t.table_name = c.table_name",
        "LEFT JOIN all_objects o ON o.owner = t.owner AND o.object_name = t.table_name AND o.object_type = 'TABLE'",
        `WHERE c.owner = '${owner}'`,
        "ORDER BY c.table_name",
      ].join("\n");
    }
    default:
      return resolveRegistryTableStatusSql(conn?.config?.type, dbName, serverVersion);
  }
};

export const buildQualifiedName = (schemaName: string, objectName: string): string => {
  const schema = String(schemaName || "").trim();
  const name = String(objectName || "").trim();
  if (!name) return "";
  if (!schema) return name;
  if (splitQualifiedNameSegmentsDetailed(name).length > 1) return name;
  return `${schema}.${name}`;
};

export const buildMetadataQualifiedName = (
  schemaName: string,
  objectName: string,
  dialect: string,
  explicitQualifiedName = '',
): string => {
  const explicit = String(explicitQualifiedName || '').trim();
  if (explicit) return explicit;
  const schema = String(schemaName || '').trim();
  const object = String(objectName || '').trim();
  if (!object) return '';
  if (!schema) return object;
  const objectSegments = splitQualifiedNameSegmentsDetailed(object, dialect);
  if (objectSegments.length > 1 && objectSegments.some((segment) => segment.quoted)) {
    return object;
  }
  if (objectSegments.length > 1) {
    return `${schema}.${quoteSqlIdentifierPart(resolveSqlDialect(dialect), object)}`;
  }
  return `${schema}.${object}`;
};

export const buildSidebarObjectKeyName = (
  dbName: string,
  schemaName: string,
  objectName: string,
): string => {
  const schema = String(schemaName || "").trim();
  const name = String(objectName || "").trim();
  if (!schema || !name || splitQualifiedNameSegmentsDetailed(name).length > 1) return name;
  if (
    schema.toLowerCase() ===
    String(dbName || "")
      .trim()
      .toLowerCase()
  )
    return name;
  return `${schema}.${name}`;
};

export const parseDuckDBParameterNames = (raw: any): string[] => {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => String(item ?? "").trim())
      .filter((item) => item !== "" && item.toLowerCase() !== "<nil>");
  }

  const text = String(raw ?? "").trim();
  if (!text) return [];
  const normalized =
    text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  return normalized
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "" && part.toLowerCase() !== "<nil>");
};

export const buildDuckDBMacroDDL = (
  schemaName: string,
  functionName: string,
  parametersRaw: any,
  macroDefinitionRaw: any,
): string => {
  const schema = String(schemaName || "").trim();
  const name = String(functionName || "").trim();
  const macroDefinition = String(macroDefinitionRaw || "").trim();
  if (!name || !macroDefinition) return "";

  const parameters = parseDuckDBParameterNames(parametersRaw).join(", ");
  const qualifiedName = schema ? `${schema}.${name}` : name;
  const isTableMacro = !macroDefinition.startsWith("(");
  if (isTableMacro) {
    return `CREATE OR REPLACE MACRO ${qualifiedName}(${parameters}) AS TABLE ${macroDefinition};`;
  }
  return `CREATE OR REPLACE MACRO ${qualifiedName}(${parameters}) AS ${macroDefinition};`;
};
