import { DBQuery } from "../../../wailsjs/go/app/App";
import { buildMetadataDiscoveryScope, scopeMetadataQuery } from '../../utils/metadataDiscoveryScope';
import { buildRpcConnectionConfig } from "../../utils/connectionRpcConfig";
import { buildMySQLCompatibleViewMetadataSqls } from "../../utils/sidebarMetadata";
import { listRegistryMetadataQueries } from "../../utils/dataSourceRegistry";
import { ORACLE_ROUTINE_OBJECT_TYPES, ORACLE_ROUTINE_TYPE_COLUMN } from "../../utils/oracleRoutineObjects";
import { isPostgresSchemaDialect } from "../sidebarCoreUtils";
import {
  type MetadataQuerySpec,
  escapeSQLLiteral,
  normalizeMetadataQuerySpecs,
  type MetadataQueryResult,
  buildSidebarRuntimeConfig,
  getMetadataDialect,
} from "./sidebarMetadataBasics";

// PostgreSQL 家族的系统 schema；CockroachDB / KWDB 另有 crdb_internal / kwdb_internal（内置函数与虚拟表），
// PostgreSQL 不会出现这两个名字。
const PG_SYSTEM_SCHEMAS = "'pg_catalog', 'information_schema', 'crdb_internal', 'kwdb_internal'";
// 排除 CREATE EXTENSION 带入的函数：pg_proc 查询按 oid 关联 pg_depend，information_schema 回退查询按 specific_name（proname_oid）关联。
const PG_NOT_EXTENSION_PROC =
  " AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')";
const PG_NOT_EXTENSION_ROUTINE =
  " AND NOT EXISTS (SELECT 1 FROM pg_depend d JOIN pg_proc p ON p.oid = d.objid WHERE d.classid = 'pg_proc'::regclass AND d.deptype = 'e' AND r.specific_name = p.proname || '_' || p.oid)";

export type FunctionsMetadataQueryOptions = {
  // 隐藏扩展成员函数（描述表 ui.hideExtensionRoutines）。
  excludeExtensionMembers?: boolean;
};

export const buildViewsMetadataQuerySpecs = (
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
          schemaColumn: 'schemaname',
        },
      ];
    case "sqlserver": {
      return [
        {
          sql: `SELECT s.name AS schema_name, v.name AS view_name FROM sys.views v JOIN sys.schemas s ON v.schema_id = s.schema_id ORDER BY s.name, v.name`,
          schemaColumn: 's.name',
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
          schemaColumn: 'table_schema',
        },
      ];
    default:
      return listRegistryMetadataQueries(dialect, "views", dbName).map((sql) => ({ sql }));
  }
};

// 排除扩展带入的视图（描述表 ui.hideExtensionViews，如 GBase 8c 的 orafce 建在 public 下的 dual）。
export const buildNonExtensionViewsMetadataQuerySpecs = (): MetadataQuerySpec[] => [
  {
    sql: `SELECT n.nspname AS schema_name, c.relname AS view_name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'v' AND n.nspname NOT IN (${PG_SYSTEM_SCHEMAS}) AND n.nspname NOT LIKE 'pg|_%' ESCAPE '|' AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e') ORDER BY n.nspname, c.relname`,
    schemaColumn: 'n.nspname',
  },
];

export const buildTriggersMetadataQuerySpecs = (
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
          schemaColumn: 'event_object_schema',
        },
      ];
    case "sqlserver": {
      return [
        {
          sql: `SELECT s.name AS schema_name, t.name AS table_name, tr.name AS trigger_name FROM sys.triggers tr JOIN sys.tables t ON tr.parent_id = t.object_id JOIN sys.schemas s ON t.schema_id = s.schema_id WHERE tr.parent_class = 1 ORDER BY s.name, t.name, tr.name`,
          schemaColumn: 's.name',
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
      return listRegistryMetadataQueries(dialect, "triggers", dbName).map((sql) => ({ sql }));
  }
};

export const buildFunctionsMetadataQuerySpecs = (
  dialect: string,
  dbName: string,
  options: FunctionsMetadataQueryOptions = {},
): MetadataQuerySpec[] => {
  const safeDbName = escapeSQLLiteral(dbName);
  const procFilter = options.excludeExtensionMembers ? PG_NOT_EXTENSION_PROC : "";
  const routineFilter = options.excludeExtensionMembers ? PG_NOT_EXTENSION_ROUTINE : "";
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
          sql: `SELECT n.nspname AS schema_name, p.proname AS routine_name, CASE WHEN p.prokind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS routine_type FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname NOT IN (${PG_SYSTEM_SCHEMAS}) AND n.nspname NOT LIKE 'pg|_%' ESCAPE '|'${procFilter} ORDER BY n.nspname, routine_type, p.proname`,
          schemaColumn: 'n.nspname',
        },
        {
          // PostgreSQL 10 / 不支持 prokind 的兼容路径
          sql: `SELECT r.routine_schema AS schema_name, r.routine_name AS routine_name, COALESCE(NULLIF(UPPER(r.routine_type), ''), 'FUNCTION') AS routine_type FROM information_schema.routines r WHERE r.routine_schema NOT IN (${PG_SYSTEM_SCHEMAS}) AND r.routine_schema NOT LIKE 'pg|_%' ESCAPE '|'${routineFilter} ORDER BY r.routine_schema, routine_type, r.routine_name`,
          schemaColumn: 'r.routine_schema',
        },
        {
          // 最后兜底：仅函数列表，确保 prokind/routines 视图异常时仍可展示
          sql: `SELECT n.nspname AS schema_name, p.proname AS routine_name, 'FUNCTION' AS routine_type FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname NOT IN (${PG_SYSTEM_SCHEMAS}) AND n.nspname NOT LIKE 'pg|_%' ESCAPE '|'${procFilter} ORDER BY n.nspname, p.proname`,
          schemaColumn: 'n.nspname',
        },
      ]);
    case "sqlserver": {
      return [
        {
          sql: `SELECT s.name AS schema_name, o.name AS routine_name, CASE o.type WHEN 'P' THEN 'PROCEDURE' WHEN 'FN' THEN 'FUNCTION' WHEN 'IF' THEN 'FUNCTION' WHEN 'TF' THEN 'FUNCTION' END AS routine_type FROM sys.objects o JOIN sys.schemas s ON o.schema_id = s.schema_id WHERE o.type IN ('P','FN','IF','TF') ORDER BY o.type, s.name, o.name`,
          schemaColumn: 's.name',
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
            sql: `SELECT OWNER AS schema_name, OBJECT_NAME AS routine_name, ${ORACLE_ROUTINE_TYPE_COLUMN}${objectStatusProjection} FROM ALL_OBJECTS WHERE OWNER = '${safeDbName.toUpperCase()}' AND OBJECT_TYPE IN ${ORACLE_ROUTINE_OBJECT_TYPES} ORDER BY OBJECT_TYPE, OBJECT_NAME`,
          },
        ];
      }
      return normalizeMetadataQuerySpecs([
        {
          sql: `SELECT OBJECT_NAME AS routine_name, ${ORACLE_ROUTINE_TYPE_COLUMN}${objectStatusProjection} FROM USER_OBJECTS WHERE OBJECT_TYPE IN ${ORACLE_ROUTINE_OBJECT_TYPES} ORDER BY OBJECT_TYPE, OBJECT_NAME`,
        },
        {
          sql: `SELECT OWNER AS schema_name, OBJECT_NAME AS routine_name, ${ORACLE_ROUTINE_TYPE_COLUMN}${objectStatusProjection} FROM ALL_OBJECTS WHERE OWNER = USER AND OBJECT_TYPE IN ${ORACLE_ROUTINE_OBJECT_TYPES} ORDER BY OBJECT_TYPE, OBJECT_NAME`,
        },
      ]);
    }
    case "duckdb":
      return [
        {
          sql: `SELECT schema_name, function_name AS routine_name, 'FUNCTION' AS routine_type FROM duckdb_functions() WHERE internal = false AND lower(function_type) = 'macro' AND COALESCE(macro_definition, '') <> '' ORDER BY schema_name, function_name`,
          schemaColumn: 'schema_name',
          inferredType: "FUNCTION",
        },
      ];
    default:
      return listRegistryMetadataQueries(dialect, "routines", dbName).map((sql) => ({ sql }));
  }
};

export const buildSequencesMetadataQuerySpecs = (
  dialect: string,
  dbName: string,
): MetadataQuerySpec[] => {
  if (isPostgresSchemaDialect(dialect)) {
    return [
      {
        sql: `SELECT sequence_schema AS schema_name, sequence_name FROM information_schema.sequences WHERE sequence_schema NOT IN ('pg_catalog', 'information_schema') AND sequence_schema NOT LIKE 'pg|_%' ESCAPE '|' ORDER BY sequence_schema, sequence_name`,
        schemaColumn: 'sequence_schema',
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
      return listRegistryMetadataQueries(dialect, "sequences", dbName).map((sql) => ({ sql }));
  }
};

export const buildPackagesMetadataQuerySpecs = (
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

export const buildEventsMetadataQuerySpecs = (
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

export const buildSchemasMetadataQuerySpecs = (
  dialect: string,
  dbName: string,
): MetadataQuerySpec[] => {
  if (isPostgresSchemaDialect(dialect)) {
    return [
      {
        sql: `SELECT nspname AS schema_name FROM pg_namespace WHERE nspname NOT IN (${PG_SYSTEM_SCHEMAS}) AND nspname NOT LIKE 'pg|_%' ESCAPE '|' ORDER BY nspname`,
        schemaColumn: 'nspname',
      },
    ];
  }

  if (dialect === "sqlserver") {
    return [
      {
        sql: `SELECT name AS schema_name FROM sys.schemas WHERE name NOT IN ('sys', 'INFORMATION_SCHEMA') ORDER BY CASE WHEN name = 'dbo' THEN 0 ELSE 1 END, name`,
        schemaColumn: 'name',
      },
    ];
  }

  if (dialect === "iris") {
    return normalizeMetadataQuerySpecs([
      {
        sql: `SELECT schema_name FROM information_schema.schemata ORDER BY schema_name`,
        schemaColumn: 'schema_name',
      },
      {
        sql: `SELECT DISTINCT TABLE_SCHEMA AS schema_name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA IS NOT NULL AND TABLE_SCHEMA <> '' ORDER BY TABLE_SCHEMA`,
        schemaColumn: 'TABLE_SCHEMA',
      },
    ]);
  }

  if (dialect === "duckdb") {
    return [
      {
        sql: `SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema', 'pg_catalog') ORDER BY CASE WHEN schema_name = 'main' THEN 0 ELSE 1 END, schema_name`,
        schemaColumn: 'schema_name',
      },
    ];
  }

  return [];
};

export const queryMetadataRowsBySpecs = async (
  conn: any,
  dbName: string,
  specs: MetadataQuerySpec[],
  query = DBQuery,
  respectVisibility = true,
): Promise<{ results: MetadataQueryResult[]; hasSuccessfulQuery: boolean; failureMessage?: string }> => {
  const normalizedSpecs = normalizeMetadataQuerySpecs(specs);
  if (normalizedSpecs.length === 0) {
    return { results: [], hasSuccessfulQuery: false };
  }
  const config = buildSidebarRuntimeConfig(conn, dbName);
  const scope = respectVisibility ? buildMetadataDiscoveryScope(conn, dbName)?.schemas : undefined;
  const dialect = getMetadataDialect(conn);
  const results: MetadataQueryResult[] = [];
  let hasSuccessfulQuery = false;
  let failureMessage = "";
  let hasFullSuccess = false;

  for (const spec of normalizedSpecs) {
    if (hasFullSuccess) {
      break;
    }
    try {
      const result = await query(
        buildRpcConnectionConfig(config) as any,
        dbName,
        scopeMetadataQuery(spec.sql, spec.schemaColumn, scope, dialect),
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
