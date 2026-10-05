import type { SavedConnection } from "../../types";
import { buildMetadataIdentityKey } from "../../utils/metadataIdentity";
import { splitMetadataQualifiedName, splitQualifiedNameLast } from "../../utils/qualifiedName";
import {
  type SidebarViewMetadataEntry,
  isSidebarViewTableType,
  normalizeSidebarViewMetadataEntry,
} from "../../utils/sidebarMetadata";
import { getDataSourceSpec } from "../../utils/dataSourceRegistry";
import { normalizeOracleObjectCompileStatus } from "./oracleObjectCompilation";
import {
  type MetadataLoadState,
  getMetadataDialect,
  getCaseInsensitiveValue,
  getMySQLShowTablesName,
  getFirstRowValue,
  escapeSQLLiteral,
  normalizeMetadataQuerySpecs,
} from "./sidebarMetadataBasics";
import {
  buildNonExtensionViewsMetadataQuerySpecs,
  buildViewsMetadataQuerySpecs,
  queryMetadataRowsBySpecs,
  buildTriggersMetadataQuerySpecs,
} from "./sidebarMetadataQuerySpecs";
import { buildMetadataQualifiedName } from "./sidebarMetadataNames";

export const loadViews = async (
  conn: any,
  dbName: string,
): Promise<{ views: SidebarViewMetadataEntry[] } & MetadataLoadState> => {
  const savedConn = conn as SavedConnection;
  const dialect = getMetadataDialect(savedConn);
  const querySpecs = getDataSourceSpec(savedConn?.config?.type)?.ui?.hideExtensionViews
    ? buildNonExtensionViewsMetadataQuerySpecs()
    : buildViewsMetadataQuerySpecs(dialect, dbName);
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

export const loadStarRocksMaterializedViews = async (
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

export const loadDatabaseTriggers = async (
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
