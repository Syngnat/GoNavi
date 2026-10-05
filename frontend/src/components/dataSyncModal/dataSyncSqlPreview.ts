import { SavedConnection } from "../../types";
import { isPostgresSchemaDialect } from "../../utils/connectionDriverType";
import { quoteIdentPart, quoteQualifiedIdent } from "../../utils/sql";
import { formatLocalDateTimeLiteral, normalizeTemporalLiteralText } from "../dataGridCopyInsert";
import type { TableOps } from "./dataSyncModalTypes";

const quoteSqlIdent = (dbType: string, ident: string): string => {
  return quoteIdentPart(dbType, String(ident || "").trim());
};

const quoteSqlTable = (dbType: string, tableName: string): string => {
  return quoteQualifiedIdent(dbType, String(tableName || "").trim());
};

const toSqlLiteral = (value: any, dbType: string): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") {
    const t = String(dbType || "").toLowerCase();
    if (t === "sqlserver") return value ? "1" : "0";
    return value ? "TRUE" : "FALSE";
  }
  if (value instanceof Date) {
    return `'${formatLocalDateTimeLiteral(value).replace(/'/g, "''")}'`;
  }
  if (typeof value === "string") {
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (typeof value === "object") {
    try {
      return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
    } catch {
      return `'${String(value).replace(/'/g, "''")}'`;
    }
  }
  return `'${String(value).replace(/'/g, "''")}'`;
};

const toTypedSqlLiteral = (
  value: any,
  dbType: string,
  columnType?: string,
): string => {
  if (typeof value === "string") {
    const normalized = normalizeTemporalLiteralText(value, columnType, false);
    return toSqlLiteral(normalized, dbType);
  }
  if (value instanceof Date) {
    const normalized = String(columnType || "").trim()
      ? formatLocalDateTimeLiteral(value)
      : value.toISOString();
    return toSqlLiteral(normalized, dbType);
  }
  return toSqlLiteral(value, dbType);
};

export const resolveRedisDbIndex = (raw?: string): number => {
  const value = Number(String(raw || "").trim());
  return Number.isInteger(value) && value >= 0 && value <= 15 ? value : 0;
};

const normalizeSchemaName = (raw?: string): string =>
  String(raw || "")
    .trim()
    .toLowerCase();

const resolveSchemaFromQualifiedTableName = (tableName: string): string => {
  const parts = String(tableName || "")
    .trim()
    .split(".")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length < 2) return "";
  return parts.length >= 3 ? parts[parts.length - 2] : parts[0];
};

export const filterTablesBySchema = (
  tables: string[],
  schemaName: string,
): string[] => {
  const normalizedSchema = normalizeSchemaName(schemaName);
  if (!normalizedSchema) return tables;

  const filtered = tables.filter((tableName) => {
    const rawTableName = String(tableName || "").trim();
    if (!rawTableName) return false;
    const tableSchema = resolveSchemaFromQualifiedTableName(rawTableName);
    if (!tableSchema) return true;
    return normalizeSchemaName(tableSchema) === normalizedSchema;
  });

  return filtered.length > 0 ? filtered : tables;
};

export const resolvePreferredTargetSchema = (
  dialect: string,
  schemaNames: string[],
): string => {
  const preferred = isPostgresSchemaDialect(dialect)
    ? "public"
    : dialect === "sqlserver"
      ? "dbo"
      : dialect === "duckdb"
        ? "main"
        : "";
  if (preferred) {
    const matched = schemaNames.find(
      (item) => item.toLowerCase() === preferred,
    );
    if (matched) return matched;
  }
  if (schemaNames.length === 1) return schemaNames[0];
  return "";
};

export const isServiceNameBackedSyncConnection = (conn?: SavedConnection): boolean => {
  const type = String(conn?.config?.type || "")
    .trim()
    .toLowerCase();
  if (type === "oracle") return true;
  if (type !== "oceanbase") return false;
  const explicitProtocol = String(
    (conn?.config as any)?.oceanBaseProtocol || "",
  )
    .trim()
    .toLowerCase();
  if (explicitProtocol === "oracle") return true;
  const params = new URLSearchParams(
    String(conn?.config?.connectionParams || ""),
  );
  const protocol = String(
    params.get("protocol") || params.get("tenantMode") || "",
  )
    .trim()
    .toLowerCase();
  return protocol === "oracle";
};

export const buildSqlPreview = (
  previewData: any,
  tableName: string,
  dbType: string,
  ops?: TableOps,
): { sqlText: string; statementCount: number } => {
  if (!previewData || !tableName) return { sqlText: "", statementCount: 0 };
  const tableExpr = quoteSqlTable(dbType, tableName);
  const pkCol = String(previewData.pkColumn || "id");
  const pkColumns = Array.isArray(previewData.pkColumns)
    ? previewData.pkColumns
        .map((column: unknown) => String(column || "").trim())
        .filter((column: string) => column.length > 0)
    : [];
  if (pkColumns.length === 0) pkColumns.push(pkCol);
  const pkColumnSet = new Set(pkColumns);
  const columnTypesByLowerName =
    previewData?.columnTypes && typeof previewData.columnTypes === "object"
      ? (previewData.columnTypes as Record<string, string>)
      : {};
  const statements: string[] = [];
  const schemaStatements = Array.isArray(previewData.schemaStatements)
    ? previewData.schemaStatements
        .map((item: any) => String(item || "").trim())
        .filter((item: string) => item.length > 0)
    : [];

  schemaStatements.forEach((statement: string) => {
    statements.push(statement.endsWith(";") ? statement : `${statement};`);
  });

  const insertRows = Array.isArray(previewData.inserts)
    ? previewData.inserts
    : [];
  const updateRows = Array.isArray(previewData.updates)
    ? previewData.updates
    : [];
  const deleteRows = Array.isArray(previewData.deletes)
    ? previewData.deletes
    : [];

  const selectedInsert = new Set(
    (ops?.selectedInsertPks || []).map((v) => String(v)),
  );
  const selectedUpdate = new Set(
    (ops?.selectedUpdatePks || []).map((v) => String(v)),
  );
  const selectedDelete = new Set(
    (ops?.selectedDeletePks || []).map((v) => String(v)),
  );

  const buildWhereExpr = (rowWrap: any, fallbackPk: string): string => {
    const locator = {
      ...(rowWrap?.source || {}),
      ...(rowWrap?.target || {}),
      ...(rowWrap?.row || {}),
    } as Record<string, unknown>;
    const conditions: string[] = [];
    for (const column of pkColumns) {
      let value = locator[column];
      if (
        value === undefined &&
        pkColumns.length === 1 &&
        fallbackPk !== ""
      ) {
        value = fallbackPk;
      }
      if (value === undefined) return "";
      conditions.push(
        `${quoteSqlIdent(dbType, column)} = ${toTypedSqlLiteral(value, dbType, columnTypesByLowerName[column.toLowerCase()])}`,
      );
    }
    return conditions.join(" AND ");
  };

  if (ops?.insert !== false) {
    insertRows.forEach((rowWrap: any) => {
      const pk = String(rowWrap?.pk ?? "");
      if (selectedInsert.size > 0 && !selectedInsert.has(pk)) return;
      const row = rowWrap?.row || {};
      const columns = Object.keys(row);
      if (columns.length === 0) return;
      const colExpr = columns.map((c) => quoteSqlIdent(dbType, c)).join(", ");
      const valExpr = columns
        .map((c) =>
          toTypedSqlLiteral(
            row[c],
            dbType,
            columnTypesByLowerName[String(c).toLowerCase()],
          ),
        )
        .join(", ");
      statements.push(
        `INSERT INTO ${tableExpr} (${colExpr}) VALUES (${valExpr});`,
      );
    });
  }

  if (ops?.update !== false) {
    updateRows.forEach((rowWrap: any) => {
      const pk = String(rowWrap?.pk ?? "");
      if (selectedUpdate.size > 0 && !selectedUpdate.has(pk)) return;
      const source = rowWrap?.source || {};
      const changedColumns = Array.isArray(rowWrap?.changedColumns)
        ? rowWrap.changedColumns
        : Object.keys(source).filter((k) => !pkColumnSet.has(k));
      const setCols = changedColumns.filter(
        (c: string) => !pkColumnSet.has(String(c)),
      );
      if (setCols.length === 0) return;
      const setExpr = setCols
        .map(
          (c: string) =>
            `${quoteSqlIdent(dbType, c)} = ${toTypedSqlLiteral(source[c], dbType, columnTypesByLowerName[String(c).toLowerCase()])}`,
        )
        .join(", ");
      const whereExpr = buildWhereExpr(rowWrap, pk);
      if (whereExpr === "") return;
      statements.push(`UPDATE ${tableExpr} SET ${setExpr} WHERE ${whereExpr};`);
    });
  }

  if (ops?.delete) {
    deleteRows.forEach((rowWrap: any) => {
      const pk = String(rowWrap?.pk ?? "");
      if (selectedDelete.size > 0 && !selectedDelete.has(pk)) return;
      const whereExpr = buildWhereExpr(rowWrap, pk);
      if (whereExpr === "") return;
      statements.push(`DELETE FROM ${tableExpr} WHERE ${whereExpr};`);
    });
  }

  return {
    sqlText: statements.join("\n"),
    statementCount: statements.length,
  };
};
