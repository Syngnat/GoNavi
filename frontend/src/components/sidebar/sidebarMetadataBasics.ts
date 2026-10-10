import type { SavedConnection } from "../../types";
import { buildRpcConnectionConfig } from "../../utils/connectionRpcConfig";
import { isDataSourceFamily, listRegistryMetadataQueries } from "../../utils/dataSourceRegistry";
import { splitQualifiedNameLast } from "../../utils/qualifiedName";
import {
  resolveSidebarRuntimeDatabase,
  resolveSidebarMetadataDialect,
} from "../../utils/sidebarMetadata";
import { isPostgresSchemaDialect } from "../sidebarCoreUtils";
import { extractTableNameFromMetadataRow } from "../../utils/tableMetadataRows";

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
  "cache",
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

export const shouldHideSchemaPrefix = (conn: SavedConnection | undefined): boolean => {
  const dbType = String(conn?.config?.type || "")
    .trim()
    .toLowerCase();
  if (SIDEBAR_SCHEMA_DB_TYPES.has(dbType)) return true;
  // 描述表里 PostgreSQL 家族的数据源（CockroachDB、KWDB）与 PostgreSQL 一样按 schema 分组显示表名。
  if (isDataSourceFamily(dbType, "postgres")) return true;
  if (dbType !== "custom") return false;

  const customDriver = String(conn?.config?.driver || "")
    .trim()
    .toLowerCase();
  return SIDEBAR_SCHEMA_CUSTOM_DRIVERS.has(customDriver);
};

export const getSidebarTableDisplayName = (
  conn: SavedConnection | undefined,
  tableName: string,
): string => {
  const rawName = String(tableName || "").trim();
  if (!rawName) return rawName;
  if (!shouldHideSchemaPrefix(conn)) return rawName;
  const parsed = splitQualifiedName(rawName);
  return parsed.objectName || rawName;
};

export const getMetadataDialect = (conn: SavedConnection | undefined): string => {
  return resolveSidebarMetadataDialect(
    conn?.config?.type || "",
    conn?.config?.driver || "",
    conn?.config?.oceanBaseProtocol,
  );
};

export const isIRISSystemSchemaName = (raw: string): boolean => {
  const normalized = String(raw || "")
    .trim()
    .toUpperCase();
  return (
    normalized === "INFORMATION_SCHEMA" ||
    normalized.startsWith("%") ||
    normalized.startsWith("SYS")
  );
};

export const supportsDatabaseEvents = (conn: SavedConnection | undefined): boolean => {
  return getMetadataDialect(conn) === "mysql";
};

export const supportsDatabaseSequences = (conn: SavedConnection | undefined): boolean => {
  const dialect = getMetadataDialect(conn);
  // 未借用方言的描述表数据源声明了序列查询时（如 GBase 8s）同样展示序列分组。
  return dialect === "oracle" || dialect === "dm" || isPostgresSchemaDialect(dialect)
    || listRegistryMetadataQueries(dialect, "sequences").length > 0;
};

export const escapeSQLLiteral = (raw: string): string =>
  String(raw || "").replace(/'/g, "''");
export const quoteSqlServerIdentifier = (raw: string): string =>
  `[${String(raw || "").replace(/]/g, "]]")}]`;

export type MetadataQuerySpec = {
  sql: string;
  schemaColumn?: string;
  inferredType?: "FUNCTION" | "PROCEDURE";
};

export type MetadataQueryResult = {
  rows: Record<string, any>[];
  inferredType?: "FUNCTION" | "PROCEDURE";
};

export type MetadataLoadState = {
  supported: boolean;
  failureMessage?: string;
};

export const isSphinxConnection = (conn: SavedConnection | undefined): boolean => {
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

export const normalizeMetadataQuerySpecs = (
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
    normalized.push({ ...spec, sql });
  });
  return normalized;
};

export const getCaseInsensitiveValue = (
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

export const getCaseInsensitiveRawValue = (
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

export const getFirstRowValue = (row: Record<string, any>): string => {
  for (const value of Object.values(row || {})) {
    if (value !== undefined && value !== null) {
      const normalized = String(value).trim();
      if (normalized !== "") return normalized;
    }
  }
  return "";
};

export const extractSqlServerDefinitionRows = (
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

export const getMySQLShowTablesName = (row: Record<string, any>): string => {
  for (const key of Object.keys(row || {})) {
    if (!key.toLowerCase().startsWith("tables_in_")) continue;
    const value = row[key];
    if (value === undefined || value === null) continue;
    const normalized = String(value).trim();
    if (normalized !== "") return normalized;
  }
  return "";
};

export const getSidebarTableName = (row: Record<string, any>): string => {
  return extractTableNameFromMetadataRow(row);
};

export const parseMetadataRowCount = (
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

export const parseSidebarTableRowCount = (
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

export const splitQualifiedName = (
  qualifiedName: string,
): { schemaName: string; objectName: string } => {
  const parsed = splitQualifiedNameLast(qualifiedName);
  return {
    schemaName: parsed.parentPath,
    objectName: parsed.objectName,
  };
};
