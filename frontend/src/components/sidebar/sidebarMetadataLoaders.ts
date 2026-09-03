import { DBQuery } from "../../../wailsjs/go/app/App";
import type { SavedConnection } from "../../types";
import { buildRpcConnectionConfig } from "../../utils/connectionRpcConfig";
import { normalizeOceanBaseProtocol } from "../../utils/oceanBaseProtocol";
import { buildMetadataIdentityKey } from "../../utils/metadataIdentity";
import {
  splitQualifiedNameLast,
  splitQualifiedNameSegmentsDetailed,
  splitMetadataQualifiedName,
} from "../../utils/qualifiedName";
import { quoteSqlIdentifierPart, resolveSqlDialect } from "../../utils/sqlDialect";
import {
  buildMySQLCompatibleViewMetadataSqls,
  isSidebarViewTableType,
  normalizeSidebarViewMetadataEntry,
  resolveSidebarMetadataDialect,
  resolveSidebarRuntimeDatabase,
  type SidebarViewMetadataEntry,
} from "../../utils/sidebarMetadata";
import { isPostgresSchemaDialect } from "../sidebarCoreUtils";
import { extractTableNameFromMetadataRow } from "../../utils/tableMetadataRows";
import { getDataSourceCapabilities } from "../../utils/dataSourceCapabilities";
import { normalizeOracleObjectCompileStatus } from './oracleObjectCompilation';

export const buildSidebarRuntimeConfig = (
  conn: any,
  overrideDatabase?: string,
  clearDatabase: boolean = false,
) => {
  return buildRpcConnectionConfig(conn.config, {
    database: resolveSidebarRuntimeDatabase(
      conn?.config?.type,
      conn?.config?.driver,
      conn?.config?.database,
      overrideDatabase,
      clearDatabase,
      conn?.config?.oceanBaseProtocol,
    ),
  });
};

const SIDEBAR_SCHEMA_DB_TYPES = new Set([
  "postgres",
  "kingbase",
  "highgo",
  "vastbase",
  "opengauss",
  "gaussdb",
  "open_gauss",
  "open-gauss",
  "sqlserver",
  "iris",
  "oracle",
  "dameng",
  "duckdb",
]);

const SIDEBAR_SCHEMA_CUSTOM_DRIVERS = new Set([
  "postgres",
  "kingbase",
  "highgo",
  "vastbase",
  "opengauss",
  "gaussdb",
  "open_gauss",
  "open-gauss",
  "sqlserver",
  "iris",
  "oracle",
  "dm",
  "duckdb",
]);

const shouldHideSchemaPrefix = (conn: SavedConnection | undefined): boolean => {
  const dbType = String(conn?.config?.type || "")
    .trim()
    .toLowerCase();
  if (SIDEBAR_SCHEMA_DB_TYPES.has(dbType)) return true;
  if (dbType !== "custom") return false;

  const customDriver = String(conn?.config?.driver || "")
    .trim()
    .toLowerCase();
  return SIDEBAR_SCHEMA_CUSTOM_DRIVERS.has(customDriver);
};

const getSidebarTableDisplayName = (
  conn: SavedConnection | undefined,
  tableName: string,
): string => {
  const rawName = String(tableName || "").trim();
  if (!rawName) return rawName;
  if (!shouldHideSchemaPrefix(conn)) return rawName;
  const parsed = splitQualifiedName(rawName);
  return parsed.objectName || rawName;
};

const getMetadataDialect = (conn: SavedConnection | undefined): string => {
  return resolveSidebarMetadataDialect(
    conn?.config?.type || "",
    conn?.config?.driver || "",
    conn?.config?.oceanBaseProtocol,
  );
};

const isIRISSystemSchemaName = (raw: string): boolean => {
  const normalized = String(raw || "")
    .trim()
    .toUpperCase();
  return (
    normalized === "INFORMATION_SCHEMA" ||
    normalized.startsWith("%") ||
    normalized.startsWith("SYS")
  );
};

const supportsDatabaseEvents = (conn: SavedConnection | undefined): boolean => {
  return getMetadataDialect(conn) === "mysql";
};

const supportsDatabaseSequences = (conn: SavedConnection | undefined): boolean => {
  const dialect = getMetadataDialect(conn);
  return dialect === "oracle" || dialect === "dm" || isPostgresSchemaDialect(dialect);
};

const escapeSQLLiteral = (raw: string): string =>
  String(raw || "").replace(/'/g, "''");
const quoteSqlServerIdentifier = (raw: string): string =>
  `[${String(raw || "").replace(/]/g, "]]")}]`;

type MetadataQuerySpec = {
  sql: string;
  inferredType?: "FUNCTION" | "PROCEDURE";
};

type MetadataQueryResult = {
  rows: Record<string, any>[];
  inferredType?: "FUNCTION" | "PROCEDURE";
};

type MetadataLoadState = {
  supported: boolean;
  failureMessage?: string;
};

const isSphinxConnection = (conn: SavedConnection | undefined): boolean => {
  const type = String(conn?.config?.type || "")
    .trim()
    .toLowerCase();
  if (type === "sphinx") return true;
  if (type !== "custom") return false;
  const driver = String(conn?.config?.driver || "")
    .trim()
    .toLowerCase();
  return driver === "sphinx" || driver === "sphinxql";
};

const normalizeMetadataQuerySpecs = (
  specs: MetadataQuerySpec[],
): MetadataQuerySpec[] => {
  const seen = new Set<string>();
  const normalized: MetadataQuerySpec[] = [];
  specs.forEach((spec) => {
    const sql = String(spec.sql || "").trim();
    if (!sql) return;
    const key = `${spec.inferredType || ""}@@${sql}`;
    if (seen.has(key)) return;
    seen.add(key);
    normalized.push({ sql, inferredType: spec.inferredType });
  });
  return normalized;
};

const getCaseInsensitiveValue = (
  row: Record<string, any>,
  candidateKeys: string[],
): string => {
  const keyMap = new Map<string, any>();
  Object.keys(row || {}).forEach((key) =>
    keyMap.set(key.toLowerCase(), row[key]),
  );
  for (const key of candidateKeys) {
    const value = keyMap.get(key.toLowerCase());
    if (value !== undefined && value !== null) {
      const normalized = String(value).trim();
      if (normalized !== "") return normalized;
    }
  }
  return "";
};

const getCaseInsensitiveRawValue = (
  row: Record<string, any>,
  candidateKeys: string[],
): any => {
  const keyMap = new Map<string, any>();
  Object.keys(row || {}).forEach((key) =>
    keyMap.set(key.toLowerCase(), row[key]),
  );
  for (const key of candidateKeys) {
    const value = keyMap.get(key.toLowerCase());
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
};

const getFirstRowValue = (row: Record<string, any>): string => {
  for (const value of Object.values(row || {})) {
    if (value !== undefined && value !== null) {
      const normalized = String(value).trim();
      if (normalized !== "") return normalized;
    }
  }
  return "";
};

const extractSqlServerDefinitionRows = (
  rows: any[],
  definitionKeys: string[],
): string => {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const directDefinition = getCaseInsensitiveRawValue(
    rows[0] as Record<string, any>,
    definitionKeys,
  );
  if (
    directDefinition !== undefined &&
    directDefinition !== null &&
    String(directDefinition).trim() !== ""
  ) {
    return String(directDefinition);
  }
  return rows
    .map((row) =>
      getCaseInsensitiveRawValue(row as Record<string, any>, ["Text", "text"]),
    )
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value))
    .join("");
};

const getMySQLShowTablesName = (row: Record<string, any>): string => {
  for (const key of Object.keys(row || {})) {
    if (!key.toLowerCase().startsWith("tables_in_")) continue;
    const value = row[key];
    if (value === undefined || value === null) continue;
    const normalized = String(value).trim();
    if (normalized !== "") return normalized;
  }
  return "";
};

const getSidebarTableName = (row: Record<string, any>): string => {
  return extractTableNameFromMetadataRow(row);
};

const parseMetadataRowCount = (
  row: Record<string, any>,
): number | undefined => {
  const rawValue = getCaseInsensitiveRawValue(row, [
    "Rows",
    "table_rows",
    "TABLE_ROWS",
    "num_rows",
    "reltuples",
    "total_rows",
  ]);
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return undefined;
  }
  const parsed = Number(String(rawValue).replace(/,/g, ""));
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return Math.round(parsed);
};

const parseSidebarTableRowCount = (
  row: Record<string, any>,
  conn: SavedConnection,
): number | undefined => {
  const rowCount = parseMetadataRowCount(row);
  if (rowCount !== 0 || getMetadataDialect(conn) !== "mysql") {
    return rowCount;
  }
  const engine = String(getCaseInsensitiveValue(row, [
    "table_engine",
    "TABLE_ENGINE",
    "engine",
    "ENGINE",
  ]) || "").trim().toLowerCase();
  // InnoDB exposes TABLE_ROWS as an estimate. Immediately after bulk writes it
  // can remain zero even when the table contains rows, so zero is not proof of
  // an empty table. Keep exact engines (for example MyISAM) unchanged.
  return !engine || engine === "innodb" ? undefined : rowCount;
};

const buildSidebarTableStatusSQL = (
  conn: SavedConnection,
  dbName: string,
): string => {
  const dialect = getMetadataDialect(conn);
  const safeDbName = escapeSQLLiteral(dbName);
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
    case "gaussdb":
      return [
        "SELECT n.nspname || '.' || c.relname AS table_name, obj_description(c.oid, 'pg_class') AS table_comment,",
        "CASE WHEN c.relkind = 'p' THEN NULL ELSE c.reltuples::bigint END AS table_rows,",
        "(SELECT parent_n.nspname || '.' || parent_c.relname",
        " FROM pg_inherits inheritance",
        " JOIN pg_class parent_c ON parent_c.oid = inheritance.inhparent AND parent_c.relkind = 'p'",
        " JOIN pg_namespace parent_n ON parent_n.oid = parent_c.relnamespace",
        " WHERE inheritance.inhrelid = c.oid",
        " ORDER BY inheritance.inhseqno LIMIT 1) AS partition_parent_table,",
        "pg_total_relation_size(c.oid) AS table_size, NULL::text AS create_time, NULL::text AS update_time",
        "FROM pg_class c",
        "JOIN pg_namespace n ON n.oid = c.relnamespace",
        "WHERE c.relkind IN ('r', 'p')",
        "AND n.nspname NOT IN ('information_schema', 'pg_catalog')",
        "AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'",
        "ORDER BY n.nspname, c.relname",
      ].join("\n");
    case "sqlserver": {
      const safeDb = quoteSqlServerIdentifier(dbName);
      return [
        "SELECT s.name + '.' + t.name AS table_name, ep.value AS table_comment, SUM(p.rows) AS table_rows,",
        "SUM(a.total_pages) * 8 * 1024 AS table_size, t.create_date AS create_time, t.modify_date AS update_time",
        `FROM ${safeDb}.sys.tables t`,
        `JOIN ${safeDb}.sys.schemas s ON t.schema_id = s.schema_id`,
        `LEFT JOIN ${safeDb}.sys.extended_properties ep ON ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'`,
        `LEFT JOIN ${safeDb}.sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0, 1)`,
        `LEFT JOIN ${safeDb}.sys.allocation_units a ON p.partition_id = a.container_id`,
        "WHERE t.type = 'U'",
        "GROUP BY s.name, t.name, ep.value, t.create_date, t.modify_date",
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
      return "";
  }
};

const buildQualifiedName = (schemaName: string, objectName: string): string => {
  const schema = String(schemaName || "").trim();
  const name = String(objectName || "").trim();
  if (!name) return "";
  if (!schema) return name;
  if (splitQualifiedNameSegmentsDetailed(name).length > 1) return name;
  return `${schema}.${name}`;
};

const buildMetadataQualifiedName = (
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

const buildSidebarObjectKeyName = (
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

const splitQualifiedName = (
  qualifiedName: string,
): { schemaName: string; objectName: string } => {
  const parsed = splitQualifiedNameLast(qualifiedName);
  return {
    schemaName: parsed.parentPath,
    objectName: parsed.objectName,
  };
};

const parseDuckDBParameterNames = (raw: any): string[] => {
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

const buildDuckDBMacroDDL = (
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

const buildViewsMetadataQuerySpecs = (
  dialect: string,
  dbName: string,
): MetadataQuerySpec[] => {
  const safeDbName = escapeSQLLiteral(dbName);
  switch (dialect) {
    case "mysql":
    case "starrocks": {
      return normalizeMetadataQuerySpecs(
        buildMySQLCompatibleViewMetadataSqls(dbName).map((sql) => ({ sql })),
      );
    }
    case "postgres":
    case "kingbase":
    case "highgo":
    case "vastbase":
    case "opengauss":
    case "gaussdb":
      return [
        {
          sql: `SELECT schemaname AS schema_name, viewname AS view_name FROM pg_catalog.pg_views WHERE schemaname != 'information_schema' AND schemaname NOT LIKE 'pg|_%' ESCAPE '|' ORDER BY schemaname, viewname`,
        },
      ];
    case "sqlserver": {
      const safeDb = quoteSqlServerIdentifier(dbName || "master");
      return [
        {
          sql: `SELECT s.name AS schema_name, v.name AS view_name FROM ${safeDb}.sys.views v JOIN ${safeDb}.sys.schemas s ON v.schema_id = s.schema_id ORDER BY s.name, v.name`,
        },
      ];
    }
    case "oracle":
    case "dm":
      if (safeDbName) {
        // CURRENT_SCHEMA does not change USER. When a read-only account selects
        // another Oracle schema, USER_VIEWS would successfully return that
        // account's (usually empty) catalog and prevent the target schema from
        // being queried. Read the explicitly selected owner first instead.
        return [
          {
            sql: `SELECT OWNER AS schema_name, VIEW_NAME AS view_name FROM ALL_VIEWS WHERE OWNER = '${safeDbName.toUpperCase()}' ORDER BY VIEW_NAME`,
          },
        ];
      }
      return normalizeMetadataQuerySpecs([
        {
          sql: `SELECT VIEW_NAME AS view_name FROM USER_VIEWS ORDER BY VIEW_NAME`,
        },
        {
          sql: `SELECT OWNER AS schema_name, VIEW_NAME AS view_name FROM ALL_VIEWS WHERE OWNER = USER ORDER BY VIEW_NAME`,
        },
      ]);
    case "sqlite":
      return [
        {
          sql: `SELECT name AS view_name FROM sqlite_master WHERE type = 'view' ORDER BY name`,
        },
      ];
    case "duckdb":
      return [
        {
          sql: `SELECT table_schema AS schema_name, table_name AS view_name FROM information_schema.views WHERE table_schema NOT IN ('information_schema', 'pg_catalog') ORDER BY table_schema, table_name`,
        },
      ];
    default:
      return [];
  }
};

const buildTriggersMetadataQuerySpecs = (
  dialect: string,
  dbName: string,
): MetadataQuerySpec[] => {
  const safeDbName = escapeSQLLiteral(dbName);
  switch (dialect) {
    case "mysql":
    case "starrocks": {
      const dbIdent = String(dbName || "")
        .replace(/`/g, "``")
        .trim();
      return normalizeMetadataQuerySpecs([
        {
          sql: safeDbName
            ? `SELECT TRIGGER_NAME AS trigger_name, EVENT_OBJECT_TABLE AS table_name, TRIGGER_SCHEMA AS schema_name FROM information_schema.triggers WHERE trigger_schema = '${safeDbName}' ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME`
            : "",
        },
        { sql: dbIdent ? `SHOW TRIGGERS FROM \`${dbIdent}\`` : "" },
        { sql: `SHOW TRIGGERS` },
      ]);
    }
    case "postgres":
    case "kingbase":
    case "highgo":
    case "vastbase":
    case "opengauss":
    case "gaussdb":
      return [
        {
          sql: `SELECT DISTINCT event_object_schema AS schema_name, event_object_table AS table_name, trigger_name FROM information_schema.triggers WHERE trigger_schema NOT IN ('pg_catalog', 'information_schema') AND trigger_schema NOT LIKE 'pg|_%' ESCAPE '|' ORDER BY event_object_schema, event_object_table, trigger_name`,
        },
      ];
    case "sqlserver": {
      const safeDb = quoteSqlServerIdentifier(dbName || "master");
      return [
        {
          sql: `SELECT s.name AS schema_name, t.name AS table_name, tr.name AS trigger_name FROM ${safeDb}.sys.triggers tr JOIN ${safeDb}.sys.tables t ON tr.parent_id = t.object_id JOIN ${safeDb}.sys.schemas s ON t.schema_id = s.schema_id WHERE tr.parent_class = 1 ORDER BY s.name, t.name, tr.name`,
        },
      ];
    }
    case "oracle":
      if (!safeDbName) {
        return [
          {
            sql: `SELECT t.TRIGGER_NAME AS trigger_name, t.TABLE_NAME AS table_name, o.STATUS AS object_status FROM USER_TRIGGERS t LEFT JOIN USER_OBJECTS o ON o.OBJECT_NAME = t.TRIGGER_NAME AND o.OBJECT_TYPE = 'TRIGGER' ORDER BY t.TABLE_NAME, t.TRIGGER_NAME`,
          },
        ];
      }
      return [
        {
          sql: `SELECT t.OWNER AS schema_name, t.TABLE_NAME AS table_name, t.TRIGGER_NAME AS trigger_name, o.STATUS AS object_status FROM ALL_TRIGGERS t LEFT JOIN ALL_OBJECTS o ON o.OWNER = t.OWNER AND o.OBJECT_NAME = t.TRIGGER_NAME AND o.OBJECT_TYPE = 'TRIGGER' WHERE t.OWNER = '${safeDbName.toUpperCase()}' ORDER BY t.TABLE_NAME, t.TRIGGER_NAME`,
        },
      ];
    case "dm":
      if (!safeDbName) {
        return [
          {
            sql: `SELECT TRIGGER_NAME AS trigger_name, TABLE_NAME AS table_name FROM USER_TRIGGERS ORDER BY TABLE_NAME, TRIGGER_NAME`,
          },
        ];
      }
      return [
        {
          sql: `SELECT OWNER AS schema_name, TABLE_NAME AS table_name, TRIGGER_NAME AS trigger_name FROM ALL_TRIGGERS WHERE OWNER = '${safeDbName.toUpperCase()}' ORDER BY TABLE_NAME, TRIGGER_NAME`,
        },
      ];
    case "sqlite":
      return [
        {
          sql: `SELECT name AS trigger_name, tbl_name AS table_name FROM sqlite_master WHERE type = 'trigger' ORDER BY tbl_name, name`,
        },
      ];
    case "duckdb":
      return [];
    default:
      return [];
  }
};

const buildFunctionsMetadataQuerySpecs = (
  dialect: string,
  dbName: string,
): MetadataQuerySpec[] => {
  const safeDbName = escapeSQLLiteral(dbName);
  switch (dialect) {
    case "mysql":
    case "starrocks":
      return normalizeMetadataQuerySpecs([
        {
          sql: safeDbName
            ? `SELECT ROUTINE_NAME AS routine_name, ROUTINE_TYPE AS routine_type, ROUTINE_SCHEMA AS schema_name FROM information_schema.routines WHERE routine_schema = '${safeDbName}' ORDER BY ROUTINE_TYPE, ROUTINE_NAME`
            : "",
        },
        {
          sql: safeDbName
            ? `SHOW FUNCTION STATUS WHERE Db = '${safeDbName}'`
            : `SHOW FUNCTION STATUS`,
          inferredType: "FUNCTION",
        },
        {
          sql: safeDbName
            ? `SHOW PROCEDURE STATUS WHERE Db = '${safeDbName}'`
            : `SHOW PROCEDURE STATUS`,
          inferredType: "PROCEDURE",
        },
      ]);
    case "postgres":
    case "kingbase":
    case "highgo":
    case "vastbase":
    case "opengauss":
    case "gaussdb":
      return normalizeMetadataQuerySpecs([
        {
          // PostgreSQL 11+ / 部分 PG-like：通过 prokind 区分 FUNCTION/PROCEDURE
          sql: `SELECT n.nspname AS schema_name, p.proname AS routine_name, CASE WHEN p.prokind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS routine_type FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg|_%' ESCAPE '|' ORDER BY n.nspname, routine_type, p.proname`,
        },
        {
          // PostgreSQL 10 / 不支持 prokind 的兼容路径
          sql: `SELECT r.routine_schema AS schema_name, r.routine_name AS routine_name, COALESCE(NULLIF(UPPER(r.routine_type), ''), 'FUNCTION') AS routine_type FROM information_schema.routines r WHERE r.routine_schema NOT IN ('pg_catalog', 'information_schema') AND r.routine_schema NOT LIKE 'pg|_%' ESCAPE '|' ORDER BY r.routine_schema, routine_type, r.routine_name`,
        },
        {
          // 最后兜底：仅函数列表，确保 prokind/routines 视图异常时仍可展示
          sql: `SELECT n.nspname AS schema_name, p.proname AS routine_name, 'FUNCTION' AS routine_type FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg|_%' ESCAPE '|' ORDER BY n.nspname, p.proname`,
        },
      ]);
    case "sqlserver": {
      const safeDb = quoteSqlServerIdentifier(dbName || "master");
      return [
        {
          sql: `SELECT s.name AS schema_name, o.name AS routine_name, CASE o.type WHEN 'P' THEN 'PROCEDURE' WHEN 'FN' THEN 'FUNCTION' WHEN 'IF' THEN 'FUNCTION' WHEN 'TF' THEN 'FUNCTION' END AS routine_type FROM ${safeDb}.sys.objects o JOIN ${safeDb}.sys.schemas s ON o.schema_id = s.schema_id WHERE o.type IN ('P','FN','IF','TF') ORDER BY o.type, s.name, o.name`,
        },
      ];
    }
    case "oracle":
    case "dm": {
      const objectStatusProjection = dialect === "oracle" ? ", STATUS AS object_status" : "";
      if (safeDbName) {
        // See the corresponding view query above. Oracle CURRENT_SCHEMA only
        // changes name resolution, so USER_OBJECTS still belongs to the login
        // account rather than the schema selected in the sidebar.
        return [
          {
            sql: `SELECT OWNER AS schema_name, OBJECT_NAME AS routine_name, OBJECT_TYPE AS routine_type${objectStatusProjection} FROM ALL_OBJECTS WHERE OWNER = '${safeDbName.toUpperCase()}' AND OBJECT_TYPE IN ('FUNCTION','PROCEDURE') ORDER BY OBJECT_TYPE, OBJECT_NAME`,
          },
        ];
      }
      return normalizeMetadataQuerySpecs([
        {
          sql: `SELECT OBJECT_NAME AS routine_name, OBJECT_TYPE AS routine_type${objectStatusProjection} FROM USER_OBJECTS WHERE OBJECT_TYPE IN ('FUNCTION','PROCEDURE') ORDER BY OBJECT_TYPE, OBJECT_NAME`,
        },
        {
          sql: `SELECT OWNER AS schema_name, OBJECT_NAME AS routine_name, OBJECT_TYPE AS routine_type${objectStatusProjection} FROM ALL_OBJECTS WHERE OWNER = USER AND OBJECT_TYPE IN ('FUNCTION','PROCEDURE') ORDER BY OBJECT_TYPE, OBJECT_NAME`,
        },
      ]);
    }
    case "duckdb":
      return [
        {
          sql: `SELECT schema_name, function_name AS routine_name, 'FUNCTION' AS routine_type FROM duckdb_functions() WHERE internal = false AND lower(function_type) = 'macro' AND COALESCE(macro_definition, '') <> '' ORDER BY schema_name, function_name`,
          inferredType: "FUNCTION",
        },
      ];
    default:
      return [];
  }
};

const buildSequencesMetadataQuerySpecs = (
  dialect: string,
  dbName: string,
): MetadataQuerySpec[] => {
  if (isPostgresSchemaDialect(dialect)) {
    return [
      {
        sql: `SELECT sequence_schema AS schema_name, sequence_name FROM information_schema.sequences WHERE sequence_schema NOT IN ('pg_catalog', 'information_schema') AND sequence_schema NOT LIKE 'pg|_%' ESCAPE '|' ORDER BY sequence_schema, sequence_name`,
      },
    ];
  }

  const safeDbName = escapeSQLLiteral(dbName);
  switch (dialect) {
    case "oracle":
    case "dm":
      return normalizeMetadataQuerySpecs([
        {
          sql: safeDbName
            ? `SELECT OWNER AS schema_name, OBJECT_NAME AS sequence_name FROM ALL_OBJECTS WHERE OWNER = '${safeDbName.toUpperCase()}' AND OBJECT_TYPE = 'SEQUENCE' ORDER BY OBJECT_NAME`
            : `SELECT SEQUENCE_NAME AS sequence_name FROM USER_SEQUENCES ORDER BY SEQUENCE_NAME`,
        },
        {
          // Some Oracle-compatible servers expose ALL_SEQUENCES only partially.
          // ALL_OBJECTS is also the catalog used by packages and routines, while
          // this keeps ALL_SEQUENCES as a fallback for standard Oracle servers.
          sql: safeDbName
            ? `SELECT SEQUENCE_OWNER AS schema_name, SEQUENCE_NAME AS sequence_name FROM ALL_SEQUENCES WHERE SEQUENCE_OWNER = '${safeDbName.toUpperCase()}' ORDER BY SEQUENCE_NAME`
            : "",
        },
      ]);
    default:
      return [];
  }
};

const buildPackagesMetadataQuerySpecs = (
  dialect: string,
  dbName: string,
): MetadataQuerySpec[] => {
  const safeDbName = escapeSQLLiteral(dbName);
  switch (dialect) {
    case "oracle":
    case "dm":
      return normalizeMetadataQuerySpecs([
        {
          sql: safeDbName
            ? `SELECT OWNER AS schema_name, OBJECT_NAME AS package_name FROM ALL_OBJECTS WHERE OWNER = '${safeDbName.toUpperCase()}' AND OBJECT_TYPE = 'PACKAGE' ORDER BY OBJECT_NAME`
            : `SELECT OBJECT_NAME AS package_name FROM USER_OBJECTS WHERE OBJECT_TYPE = 'PACKAGE' ORDER BY OBJECT_NAME`,
        },
      ]);
    default:
      return [];
  }
};

const buildEventsMetadataQuerySpecs = (
  dialect: string,
  dbName: string,
): MetadataQuerySpec[] => {
  if (dialect !== "mysql") {
    return [];
  }
  const safeDbName = escapeSQLLiteral(dbName);
  const dbIdent = String(dbName || "")
    .replace(/`/g, "``")
    .trim();
  return normalizeMetadataQuerySpecs([
    {
      sql: safeDbName
        ? `SELECT EVENT_SCHEMA AS schema_name, EVENT_NAME AS event_name, EVENT_TYPE AS event_type, STATUS AS status FROM information_schema.events WHERE event_schema = '${safeDbName}' ORDER BY EVENT_NAME`
        : "",
    },
    { sql: dbIdent ? `SHOW EVENTS FROM \`${dbIdent}\`` : "" },
    { sql: `SHOW EVENTS` },
  ]);
};

const buildSchemasMetadataQuerySpecs = (
  dialect: string,
  dbName: string,
): MetadataQuerySpec[] => {
  if (isPostgresSchemaDialect(dialect)) {
    return [
      {
        sql: `SELECT nspname AS schema_name FROM pg_namespace WHERE nspname NOT IN ('pg_catalog', 'information_schema') AND nspname NOT LIKE 'pg|_%' ESCAPE '|' ORDER BY nspname`,
      },
    ];
  }

  if (dialect === "sqlserver") {
    const safeDb = quoteSqlServerIdentifier(dbName);
    return safeDb
      ? [
          {
            sql: `SELECT name AS schema_name FROM ${safeDb}.sys.schemas WHERE name NOT IN ('sys', 'INFORMATION_SCHEMA') ORDER BY CASE WHEN name = 'dbo' THEN 0 ELSE 1 END, name`,
          },
        ]
      : [];
  }

  if (dialect === "iris") {
    return normalizeMetadataQuerySpecs([
      {
        sql: `SELECT schema_name FROM information_schema.schemata ORDER BY schema_name`,
      },
      {
        sql: `SELECT DISTINCT TABLE_SCHEMA AS schema_name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA IS NOT NULL AND TABLE_SCHEMA <> '' ORDER BY TABLE_SCHEMA`,
      },
    ]);
  }

  if (dialect === "duckdb") {
    return [
      {
        sql: `SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema', 'pg_catalog') ORDER BY CASE WHEN schema_name = 'main' THEN 0 ELSE 1 END, schema_name`,
      },
    ];
  }

  return [];
};

const queryMetadataRowsBySpecs = async (
  conn: any,
  dbName: string,
  specs: MetadataQuerySpec[],
): Promise<{ results: MetadataQueryResult[]; hasSuccessfulQuery: boolean; failureMessage?: string }> => {
  const normalizedSpecs = normalizeMetadataQuerySpecs(specs);
  if (normalizedSpecs.length === 0) {
    return { results: [], hasSuccessfulQuery: false };
  }
  const config = buildSidebarRuntimeConfig(conn, dbName);
  const results: MetadataQueryResult[] = [];
  let hasSuccessfulQuery = false;
  let failureMessage = "";
  // Full queries (no inferredType) are mutually exclusive fallbacks: first success wins.
  // Partial queries (inferredType set) are complementary (e.g. SHOW FUNCTION + SHOW PROCEDURE).
  let hasFullSuccess = false;

  for (const spec of normalizedSpecs) {
    if (hasFullSuccess) {
      break;
    }
    try {
      const result = await DBQuery(
        buildRpcConnectionConfig(config) as any,
        dbName,
        spec.sql,
      );
      if (!result.success || !Array.isArray(result.data)) {
        if (!failureMessage) {
          failureMessage = String(result.message || "metadata query failed").trim();
        }
        continue;
      }
      hasSuccessfulQuery = true;
      results.push({
        rows: result.data as Record<string, any>[],
        inferredType: spec.inferredType,
      });
      if (!spec.inferredType) {
        // Primary/fallback full catalog query succeeded — do not merge later fallbacks
        // (Kingbase/PG 上多条成功会把同一函数叠加多次).
        hasFullSuccess = true;
      }
    } catch (error) {
      if (!failureMessage) {
        failureMessage = error instanceof Error ? error.message : String(error || "metadata query failed");
      }
    }
  }
  return {
    results,
    hasSuccessfulQuery,
    ...(hasSuccessfulQuery || !failureMessage ? {} : { failureMessage }),
  };
};

const loadViews = async (
  conn: any,
  dbName: string,
): Promise<{ views: SidebarViewMetadataEntry[] } & MetadataLoadState> => {
  const savedConn = conn as SavedConnection;
  const dialect = getMetadataDialect(savedConn);
  const querySpecs = buildViewsMetadataQuerySpecs(dialect, dbName);
  const { results, hasSuccessfulQuery, failureMessage } = await queryMetadataRowsBySpecs(
    conn,
    dbName,
    querySpecs,
  );
  const seen = new Set<string>();
  const views: SidebarViewMetadataEntry[] = [];

  results.forEach((queryResult) => {
    queryResult.rows.forEach((row) => {
      const tableType = getCaseInsensitiveValue(row, [
        "table_type",
        "table type",
        "type",
      ]);
      if (!isSidebarViewTableType(tableType)) return;
      const schemaName = getCaseInsensitiveValue(row, [
        "schema_name",
        "schemaname",
        "owner",
        "table_schema",
        "db",
      ]);
      const viewName =
        getCaseInsensitiveValue(row, [
          "view_name",
          "viewname",
          "table_name",
          "name",
        ]) ||
        getMySQLShowTablesName(row) ||
        getFirstRowValue(row);
      const entry = normalizeSidebarViewMetadataEntry(
        dialect,
        dbName,
        schemaName,
        viewName,
      );
      if (!entry) return;
      const uniqueKey = buildMetadataIdentityKey(
        dialect,
        entry.schemaName,
        entry.viewName,
      );
      if (seen.has(uniqueKey)) return;
      seen.add(uniqueKey);
      views.push(entry);
    });
  });
  return { views, supported: hasSuccessfulQuery, failureMessage };
};

const loadStarRocksMaterializedViews = async (
  conn: any,
  dbName: string,
): Promise<{ views: SidebarViewMetadataEntry[] } & MetadataLoadState> => {
  const dialect = getMetadataDialect(conn as SavedConnection);
  if (dialect !== "starrocks") {
    return { views: [], supported: false };
  }

  const safeDbName = escapeSQLLiteral(dbName);
  const dbIdent = String(dbName || "")
    .replace(/`/g, "``")
    .trim();
  const querySpecs = normalizeMetadataQuerySpecs([
    {
      sql: safeDbName
        ? `SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS object_name FROM information_schema.tables WHERE TABLE_SCHEMA = '${safeDbName}' AND UPPER(TABLE_TYPE) LIKE '%MATERIALIZED%' ORDER BY TABLE_NAME`
        : "",
    },
    { sql: dbIdent ? `SHOW MATERIALIZED VIEWS FROM \`${dbIdent}\`` : "" },
    { sql: `SHOW MATERIALIZED VIEWS` },
  ]);
  const { results, hasSuccessfulQuery, failureMessage } = await queryMetadataRowsBySpecs(
    conn,
    dbName,
    querySpecs,
  );
  const seen = new Set<string>();
  const views: SidebarViewMetadataEntry[] = [];

  results.forEach((queryResult) => {
    queryResult.rows.forEach((row) => {
      const schemaName = getCaseInsensitiveValue(row, [
        "schema_name",
        "table_schema",
        "db",
        "database",
      ]);
      const viewName =
        getCaseInsensitiveValue(row, [
          "object_name",
          "view_name",
          "table_name",
          "name",
          "materialized_view_name",
          "mv_name",
        ]) || getFirstRowValue(row);
      const entry = normalizeSidebarViewMetadataEntry(
        dialect,
        dbName,
        schemaName,
        viewName,
      );
      if (!entry) return;
      const uniqueKey = buildMetadataIdentityKey(
        dialect,
        entry.schemaName,
        entry.viewName,
      );
      if (seen.has(uniqueKey)) return;
      seen.add(uniqueKey);
      views.push(entry);
    });
  });

  return { views, supported: hasSuccessfulQuery, failureMessage };
};

const loadDatabaseTriggers = async (
  conn: any,
  dbName: string,
): Promise<{
  triggers: Array<{
    displayName: string;
    triggerName: string;
    tableName: string;
    schemaName?: string;
    objectStatus?: string;
  }>;
} & MetadataLoadState> => {
  const dialect = getMetadataDialect(conn as SavedConnection);
  const querySpecs = buildTriggersMetadataQuerySpecs(dialect, dbName);
  const { results, hasSuccessfulQuery, failureMessage } = await queryMetadataRowsBySpecs(
    conn,
    dbName,
    querySpecs,
  );
  const seen = new Set<string>();
  const triggers: Array<{
    displayName: string;
    triggerName: string;
    tableName: string;
    schemaName?: string;
  }> = [];

  results.forEach((queryResult) => {
    queryResult.rows.forEach((row) => {
      const rawTriggerName =
        getCaseInsensitiveValue(row, [
          "trigger_name",
          "triggername",
          "trigger",
          "name",
        ]) || getFirstRowValue(row);
      if (!rawTriggerName) return;

      const rawSchemaName = getCaseInsensitiveValue(row, [
        "schema_name",
        "schemaname",
        "owner",
        "event_object_schema",
        "trigger_schema",
        "db",
      ]);
      const rawTableName = getCaseInsensitiveValue(row, [
        "table_name",
        "event_object_table",
        "tbl_name",
        "table",
      ]);

      const metadataSchemaHint = String(rawSchemaName || '').trim();
      const triggerParts = metadataSchemaHint
        ? splitMetadataQualifiedName(String(rawTriggerName), metadataSchemaHint)
        : splitQualifiedNameLast(String(rawTriggerName));
      const tableParts = metadataSchemaHint
        ? splitMetadataQualifiedName(String(rawTableName), metadataSchemaHint)
        : splitQualifiedNameLast(String(rawTableName));

      const resolvedSchema = (
        rawSchemaName ||
        tableParts.parentPath ||
        triggerParts.parentPath ||
        dbName
      ).toString().trim();
      const resolvedTriggerName = (
        triggerParts.objectName || rawTriggerName
      ).trim();
      const resolvedTableName = (tableParts.objectName || rawTableName).trim();
      const fullTableName = buildMetadataQualifiedName(
        resolvedSchema,
        resolvedTableName,
        dialect,
        tableParts.parentPath ? String(rawTableName || '').trim() : '',
      );
      const fullTriggerName = triggerParts.parentPath
        ? String(rawTriggerName || '').trim()
        : resolvedTriggerName;

      // MySQL 下 trigger 名在同 schema 内唯一，直接按 schema+trigger 去重可彻底规避多元数据查询导致的重复
      const uniqueKey =
        dialect === "mysql"
          ? buildMetadataIdentityKey(
            dialect,
            resolvedSchema,
            resolvedTriggerName,
          )
          : buildMetadataIdentityKey(
            dialect,
            resolvedSchema,
            resolvedTriggerName,
            resolvedTableName,
          );
      if (seen.has(uniqueKey)) return;
      seen.add(uniqueKey);
      const displayName = fullTableName
        ? `${resolvedTriggerName} (${fullTableName})`
        : resolvedTriggerName;
      const objectStatus = dialect === "oracle"
        ? normalizeOracleObjectCompileStatus(getCaseInsensitiveValue(row, ["object_status"]))
        : "";
      triggers.push({
        displayName,
        triggerName: fullTriggerName || resolvedTriggerName,
        tableName: fullTableName || resolvedTableName,
        ...(resolvedSchema ? { schemaName: resolvedSchema } : {}),
        ...(objectStatus ? { objectStatus } : {}),
      });
    });
  });
  return {
    triggers,
    supported: hasSuccessfulQuery,
    ...(failureMessage ? { failureMessage } : {}),
  };
};

const loadFunctions = async (
  conn: any,
  dbName: string,
): Promise<{
  routines: Array<{
    displayName: string;
    routineName: string;
    routineType: string;
    objectStatus?: string;
  }>;
} & MetadataLoadState> => {
  const dialect = getMetadataDialect(conn as SavedConnection);
  const querySpecs = buildFunctionsMetadataQuerySpecs(dialect, dbName);
  const { results, hasSuccessfulQuery, failureMessage } = await queryMetadataRowsBySpecs(
    conn,
    dbName,
    querySpecs,
  );
  const seen = new Set<string>();
  const routines: Array<{
    displayName: string;
    routineName: string;
    routineType: string;
  }> = [];

  results.forEach((queryResult) => {
    queryResult.rows.forEach((row) => {
      const routineName = getCaseInsensitiveValue(row, [
        "routine_name",
        "object_name",
        "proname",
        "name",
      ]);
      if (!routineName) return;
      const schemaName = getCaseInsensitiveValue(row, [
        "schema_name",
        "nspname",
        "owner",
        "db",
        "database",
      ]);
      const rawType =
        getCaseInsensitiveValue(row, ["routine_type", "object_type", "type"]) ||
        queryResult.inferredType ||
        "FUNCTION";
      const normalizedType = rawType.toUpperCase().includes("PROC")
        ? "PROCEDURE"
        : "FUNCTION";
      const fullName = buildQualifiedName(schemaName, routineName);
      const uniqueKey = buildMetadataIdentityKey(
        dialect,
        fullName,
        normalizedType,
      );
      if (!fullName || seen.has(uniqueKey)) return;
      seen.add(uniqueKey);
      const typeLabel = normalizedType === "PROCEDURE" ? "P" : "F";
      const objectStatus = dialect === "oracle"
        ? normalizeOracleObjectCompileStatus(getCaseInsensitiveValue(row, ["object_status"]))
        : "";
      routines.push({
        displayName: `${fullName} [${typeLabel}]`,
        routineName: fullName,
        routineType: normalizedType,
        ...(objectStatus ? { objectStatus } : {}),
      });
    });
  });
  return { routines, supported: hasSuccessfulQuery, failureMessage };
};

const loadSequences = async (
  conn: any,
  dbName: string,
): Promise<{
  sequences: Array<{
    displayName: string;
    sequenceName: string;
    schemaName: string;
  }>;
} & MetadataLoadState> => {
  const dialect = getMetadataDialect(conn as SavedConnection);
  const querySpecs = buildSequencesMetadataQuerySpecs(dialect, dbName);
  const { results, hasSuccessfulQuery, failureMessage } = await queryMetadataRowsBySpecs(
    conn,
    dbName,
    querySpecs,
  );
  const seen = new Set<string>();
  const sequences: Array<{
    displayName: string;
    sequenceName: string;
    schemaName: string;
  }> = [];

  results.forEach((queryResult) => {
    queryResult.rows.forEach((row) => {
      const rawSequenceName =
        getCaseInsensitiveValue(row, [
          "sequence_name",
          "sequencename",
          "object_name",
          "name",
        ]) || getFirstRowValue(row);
      if (!rawSequenceName) return;

      const sequenceParts = splitQualifiedName(rawSequenceName);
      const schemaName = (
        getCaseInsensitiveValue(row, [
          "schema_name",
          "sequence_owner",
          "owner",
        ]) ||
        sequenceParts.schemaName ||
        ""
      ).trim();
      const objectName = (sequenceParts.objectName || rawSequenceName).trim();
      const fullName = buildQualifiedName(schemaName, objectName);
      const uniqueKey = buildMetadataIdentityKey(
        dialect,
        schemaName,
        objectName,
      );
      if (!fullName || seen.has(uniqueKey)) return;
      seen.add(uniqueKey);
      sequences.push({
        displayName: fullName,
        sequenceName: fullName,
        schemaName,
      });
    });
  });
  return { sequences, supported: hasSuccessfulQuery, failureMessage };
};

const loadPackages = async (
  conn: any,
  dbName: string,
): Promise<{
  packages: Array<{
    displayName: string;
    packageName: string;
    schemaName: string;
  }>;
} & MetadataLoadState> => {
  const dialect = getMetadataDialect(conn as SavedConnection);
  const querySpecs = buildPackagesMetadataQuerySpecs(dialect, dbName);
  const { results, hasSuccessfulQuery, failureMessage } = await queryMetadataRowsBySpecs(
    conn,
    dbName,
    querySpecs,
  );
  const seen = new Set<string>();
  const packages: Array<{
    displayName: string;
    packageName: string;
    schemaName: string;
  }> = [];

  results.forEach((queryResult) => {
    queryResult.rows.forEach((row) => {
      const rawPackageName =
        getCaseInsensitiveValue(row, [
          "package_name",
          "packagename",
          "object_name",
          "name",
        ]) || getFirstRowValue(row);
      if (!rawPackageName) return;

      const packageParts = splitQualifiedName(rawPackageName);
      const schemaName = (
        getCaseInsensitiveValue(row, [
          "schema_name",
          "owner",
        ]) ||
        packageParts.schemaName ||
        ""
      ).trim();
      const objectName = (packageParts.objectName || rawPackageName).trim();
      const fullName = buildQualifiedName(schemaName, objectName);
      const uniqueKey = buildMetadataIdentityKey(
        dialect,
        schemaName,
        objectName,
      );
      if (!fullName || seen.has(uniqueKey)) return;
      seen.add(uniqueKey);
      packages.push({
        displayName: fullName,
        packageName: fullName,
        schemaName,
      });
    });
  });
  return { packages, supported: hasSuccessfulQuery, failureMessage };
};

const loadDatabaseEvents = async (
  conn: any,
  dbName: string,
): Promise<{
  events: Array<{
    displayName: string;
    eventName: string;
    schemaName: string;
    eventType: string;
    status: string;
  }>;
} & MetadataLoadState> => {
  const dialect = getMetadataDialect(conn as SavedConnection);
  const querySpecs = buildEventsMetadataQuerySpecs(dialect, dbName);
  const { results, hasSuccessfulQuery, failureMessage } = await queryMetadataRowsBySpecs(
    conn,
    dbName,
    querySpecs,
  );
  const seen = new Set<string>();
  const events: Array<{
    displayName: string;
    eventName: string;
    schemaName: string;
    eventType: string;
    status: string;
  }> = [];

  results.forEach((queryResult) => {
    queryResult.rows.forEach((row) => {
      const rawEventName = getCaseInsensitiveValue(row, [
        "event_name",
        "eventname",
        "name",
        "event",
      ]);
      if (!rawEventName) return;

      const rawSchemaName = getCaseInsensitiveValue(row, [
        "schema_name",
        "event_schema",
        "db",
        "database",
      ]);
      const parsed = splitQualifiedName(rawEventName);
      const schemaName = (rawSchemaName || parsed.schemaName || dbName).trim();
      const eventName = (parsed.objectName || rawEventName).trim();
      if (!eventName) return;

      const uniqueKey = buildMetadataIdentityKey(
        dialect,
        schemaName,
        eventName,
      );
      if (seen.has(uniqueKey)) return;
      seen.add(uniqueKey);

      const eventType = getCaseInsensitiveValue(row, ["event_type", "type"]);
      const status = getCaseInsensitiveValue(row, ["status"]);
      events.push({
        displayName: eventName,
        eventName,
        schemaName,
        eventType,
        status,
      });
    });
  });

  return { events, supported: hasSuccessfulQuery, failureMessage };
};

const loadSchemas = async (
  conn: any,
  dbName: string,
): Promise<{ schemas: string[] } & MetadataLoadState> => {
  const savedConnection = conn as SavedConnection;
  const dialect = getMetadataDialect(savedConnection);
  const querySpecs = buildSchemasMetadataQuerySpecs(dialect, dbName);
  const caseSensitive = getDataSourceCapabilities(savedConnection.config)
    .schemaIdentifierCaseSensitive;
  const { results, hasSuccessfulQuery, failureMessage } = await queryMetadataRowsBySpecs(
    conn,
    dbName,
    querySpecs,
  );
  const seen = new Set<string>();
  const schemas: string[] = [];

  results.forEach((queryResult) => {
    queryResult.rows.forEach((row) => {
      const schemaName =
        getCaseInsensitiveValue(row, [
          "schema_name",
          "nspname",
          "schemaname",
        ]) || getFirstRowValue(row);
      if (!schemaName) return;
      if (dialect === "iris" && isIRISSystemSchemaName(schemaName)) return;
      const key = caseSensitive ? schemaName : schemaName.toLocaleLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      schemas.push(schemaName);
    });
  });

  return { schemas, supported: hasSuccessfulQuery, failureMessage };
};

export {
  buildDuckDBMacroDDL,
  buildEventsMetadataQuerySpecs,
  buildFunctionsMetadataQuerySpecs,
  buildPackagesMetadataQuerySpecs,
  buildQualifiedName,
  buildSchemasMetadataQuerySpecs,
  buildSequencesMetadataQuerySpecs,
  buildSidebarObjectKeyName,
  buildSidebarTableStatusSQL,
  buildTriggersMetadataQuerySpecs,
  buildViewsMetadataQuerySpecs,
  escapeSQLLiteral,
  extractSqlServerDefinitionRows,
  getCaseInsensitiveRawValue,
  getCaseInsensitiveValue,
  getFirstRowValue,
  getMetadataDialect,
  getMySQLShowTablesName,
  getSidebarTableName,
  getSidebarTableDisplayName,
  isSphinxConnection,
  loadDatabaseEvents,
  loadDatabaseTriggers,
  loadFunctions,
  loadPackages,
  loadSchemas,
  loadSequences,
  loadStarRocksMaterializedViews,
  loadViews,
  normalizeMetadataQuerySpecs,
  parseDuckDBParameterNames,
  parseMetadataRowCount,
  parseSidebarTableRowCount,
  quoteSqlServerIdentifier,
  shouldHideSchemaPrefix,
  splitQualifiedName,
  supportsDatabaseEvents,
  supportsDatabaseSequences,
};
