import { buildOrderBySQL, buildPaginatedSelectSQL } from './sql';
import { findTopLevelKeyword, getLeadingKeyword, splitSqlTail } from './queryAutoLimit';
import { resolveSqlDialect } from './sqlDialect';

export type QueryResultPaginationState = {
  current: number;
  pageSize: number;
  total: number;
  totalKnown?: boolean;
  totalCountLoading?: boolean;
  totalCountCancelled?: boolean;
  baseSql: string;
  exportAllSql?: string;
};

type LimitInfo = {
  baseSql: string;
  limit: number;
  offset: number;
};

const normalizePositiveInteger = (value: unknown): number => {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const parseNonNegativeSafeInteger = (value: unknown): number | null => {
  if (typeof value === 'bigint') {
    return value >= 0n && value <= MAX_SAFE_INTEGER_BIGINT ? Number(value) : null;
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^[+]?[0-9]+$/.test(text)) return null;
  try {
    const parsed = BigInt(text);
    return parsed <= MAX_SAFE_INTEGER_BIGINT ? Number(parsed) : null;
  } catch {
    return null;
  }
};

const normalizeSqlForComparison = (sql: string): string => (
  String(sql || '')
    .replace(/\s+/g, ' ')
    .replace(/;+\s*$/g, '')
    .trim()
    .toLowerCase()
);

const parseTopLevelLimit = (sql: string): LimitInfo | null => {
  const { main } = splitSqlTail(sql);
  const limitPos = findTopLevelKeyword(main, 'limit');
  if (limitPos < 0) return null;
  const fromPos = findTopLevelKeyword(main, 'from');
  if (fromPos >= 0 && limitPos < fromPos) return null;

  const beforeLimit = main.slice(0, limitPos).trimEnd();
  const limitClause = main.slice(limitPos).trim();
  const mysqlOffsetLimit = limitClause.match(/^limit\s+(\d+)\s*,\s*(\d+)$/i);
  if (mysqlOffsetLimit) {
    const offset = normalizePositiveInteger(mysqlOffsetLimit[1]);
    const limit = normalizePositiveInteger(mysqlOffsetLimit[2]);
    return limit > 0 ? { baseSql: beforeLimit, limit, offset } : null;
  }

  const limitOffset = limitClause.match(/^limit\s+(\d+)\s+offset\s+(\d+)$/i);
  if (limitOffset) {
    const limit = normalizePositiveInteger(limitOffset[1]);
    const offset = normalizePositiveInteger(limitOffset[2]);
    return limit > 0 ? { baseSql: beforeLimit, limit, offset } : null;
  }

  const simpleLimit = limitClause.match(/^limit\s+(\d+)$/i);
  if (simpleLimit) {
    const limit = normalizePositiveInteger(simpleLimit[1]);
    return limit > 0 ? { baseSql: beforeLimit, limit, offset: 0 } : null;
  }

  return null;
};

const stripExplicitLimitForExport = (sql: string): string => {
  const parsed = parseTopLevelLimit(sql);
  if (parsed?.baseSql) return parsed.baseSql;
  return splitSqlTail(sql).main.trim();
};

const wasLimitAppliedByQueryEditorCap = (
  executedSql: string,
  exportSql: string,
  dbType: string,
  driver: string,
  fallbackPageSize: number,
): boolean => {
  const executed = String(executedSql || '').trim();
  const exportable = String(exportSql || '').trim();
  if (!executed || !exportable) return false;
  if (normalizeSqlForComparison(executed) === normalizeSqlForComparison(exportable)) return false;

  const exportBaseSql = stripExplicitLimitForExport(exportable);
  if (normalizeSqlForComparison(stripExplicitLimitForExport(executed)) === normalizeSqlForComparison(exportBaseSql)) {
    return true;
  }

  const pageSize = normalizePositiveInteger(fallbackPageSize);
  if (pageSize <= 0 || getLeadingKeyword(exportBaseSql) !== 'select') return false;

  const dialect = resolveSqlDialect(dbType || 'mysql', driver || '');
  const queryEditorCappedSql = buildPaginatedSelectSQL(dialect, exportBaseSql, '', pageSize, 0);
  return normalizeSqlForComparison(executed) === normalizeSqlForComparison(queryEditorCappedSql);
};

const resolveWrappedBaseSql = (dbType: string, baseSql: string): string => {
  const normalizedType = String(dbType || '').trim().toLowerCase();
  const base = baseSql.trim();
  if (normalizedType === 'oracle' || normalizedType === 'dameng') {
    return `SELECT * FROM (${base}) "__gonavi_query_page__"`;
  }
  return `SELECT * FROM (${base}) AS __gonavi_query_page__`;
};

export const buildQueryResultCountSql = (baseSql: string): string => {
  const mainSql = splitSqlTail(String(baseSql || '')).main.trim();
  if (!mainSql) return '';
  const orderByPos = findTopLevelKeyword(mainSql, 'order by');
  const countBaseSql = (orderByPos >= 0 ? mainSql.slice(0, orderByPos) : mainSql).trim();
  if (!countBaseSql) return '';
  return `SELECT COUNT(*) AS __gonavi_total__ FROM (${countBaseSql}) __gonavi_query_count__`;
};

export const parseQueryResultTotalCount = (row: unknown): number | null => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const entries = Object.entries(row as Record<string, unknown>);
  if (entries.length === 0) return null;

  for (const [key, value] of entries) {
    const normalizedKey = key.trim().toLowerCase();
    if (normalizedKey === '__gonavi_total__' || normalizedKey === 'total' || normalizedKey.includes('count')) {
      const parsed = parseNonNegativeSafeInteger(value);
      if (parsed !== null) return parsed;
    }
  }
  for (const [, value] of entries) {
    const parsed = parseNonNegativeSafeInteger(value);
    if (parsed !== null) return parsed;
  }
  return null;
};

export const buildQueryResultPageSql = (params: {
  baseSql: string;
  dbType: string;
  driver?: string;
  oceanBaseProtocol?: string;
  page: number;
  pageSize: number;
  lookahead?: boolean;
  sortInfo?: Array<{ columnKey: string; order: string; enabled?: boolean }>;
}): string => {
  const pageSize = normalizePositiveInteger(params.pageSize);
  const dialect = resolveSqlDialect(params.dbType || 'mysql', params.driver || '', {
    oceanBaseProtocol: params.oceanBaseProtocol || '',
  });
  const orderBySql = buildOrderBySQL(dialect, params.sortInfo || []);
  if (pageSize <= 0) {
    if (!orderBySql) return String(params.baseSql || '').trim();
    return `${resolveWrappedBaseSql(dialect, params.baseSql)}${orderBySql}`;
  }
  const page = Math.max(1, Math.floor(Number(params.page) || 1));
  const limit = params.lookahead ? pageSize + 1 : pageSize;
  const offset = (page - 1) * pageSize;
  return buildPaginatedSelectSQL(
    dialect,
    resolveWrappedBaseSql(dialect, params.baseSql),
    orderBySql,
    limit,
    offset,
  );
};

export const resolveQueryResultPaginationTotal = (params: {
  current: number;
  pageSize: number;
  rowCount: number;
  hasNext?: boolean;
}): Pick<QueryResultPaginationState, 'total' | 'totalKnown'> => {
  const current = Math.max(1, Math.floor(Number(params.current) || 1));
  const pageSize = normalizePositiveInteger(params.pageSize);
  const rowCount = Math.max(0, Math.floor(Number(params.rowCount) || 0));
  if (pageSize <= 0) {
    return { total: rowCount, totalKnown: true };
  }
  if (params.hasNext === true) {
    return { total: (current + 1) * pageSize, totalKnown: false };
  }
  if (params.hasNext === false) {
    return { total: Math.max(0, (current - 1) * pageSize + rowCount), totalKnown: true };
  }
  if (rowCount >= pageSize) {
    return { total: (current + 1) * pageSize, totalKnown: false };
  }
  return { total: Math.max(0, (current - 1) * pageSize + rowCount), totalKnown: true };
};

export const createInitialQueryResultPagination = (params: {
  executedSql: string;
  exportSql?: string;
  dbType: string;
  driver?: string;
  returnedRowCount: number;
  fallbackPageSize?: number;
}): QueryResultPaginationState | undefined => {
  const executedSql = String(params.executedSql || '').trim();
  if (!executedSql || getLeadingKeyword(executedSql) !== 'select') return undefined;

  const explicitLimit = parseTopLevelLimit(executedSql);
  const mainSql = splitSqlTail(executedSql).main.trim();
  const fallbackPageSize = normalizePositiveInteger(params.fallbackPageSize);
  const returnedRowCount = Math.max(0, Math.floor(Number(params.returnedRowCount) || 0));
  const pageSize = explicitLimit?.limit || fallbackPageSize || returnedRowCount;
  if (pageSize <= 0) return undefined;

  const current = explicitLimit
    ? Math.max(1, Math.floor(explicitLimit.offset / pageSize) + 1)
    : 1;
  if (current <= 1 && returnedRowCount < pageSize) return undefined;

  const exportSql = String(params.exportSql || '').trim();
  const exportAllSql = exportSql && getLeadingKeyword(exportSql) === 'select'
    ? stripExplicitLimitForExport(exportSql)
    : stripExplicitLimitForExport(executedSql);
  const autoLimitCap = current === 1 && wasLimitAppliedByQueryEditorCap(
    executedSql,
    exportSql,
    params.dbType,
    params.driver || '',
    fallbackPageSize,
  );
  const baseSql = autoLimitCap && exportAllSql
    ? exportAllSql
    : explicitLimit?.baseSql || mainSql;
  if (!baseSql) return undefined;

  const totalState = resolveQueryResultPaginationTotal({
    current,
    pageSize,
    rowCount: returnedRowCount,
  });

  return {
    current,
    pageSize,
    ...totalState,
    baseSql,
    exportAllSql,
  };
};
