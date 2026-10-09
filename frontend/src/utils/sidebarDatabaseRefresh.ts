import { splitQualifiedNameSegmentsDetailed, stripIdentifierQuotes } from './qualifiedName';
import { isMysqlFamilyDialect, isOracleLikeDialect, quoteSqlIdentifierPart, resolveSqlDialect } from './sqlDialect';

export const SIDEBAR_DATABASE_REFRESH_EVENT = 'gonavi:sidebar-database-refresh';
export const SIDEBAR_DATABASE_LIST_REFRESH_EVENT = 'gonavi:sidebar-database-list-refresh';

export type SidebarDatabaseRefreshRequest = {
  connectionId: string;
  // Omitted for data sources whose schema is scoped directly to a connection
  // (for example SQLite files). Consumers then refresh the whole connection.
  dbName?: string;
  schemaName?: string;
  rowCountTables?: string[];
  reason?: 'data-sync' | 'external';
};

export type SidebarDatabaseListRefreshRequest = {
  connectionId: string;
  reason?: 'elasticsearch-write' | 'external';
};

export const normalizeSidebarDatabaseRefreshRequest = (
  value: Partial<SidebarDatabaseRefreshRequest> | null | undefined,
): SidebarDatabaseRefreshRequest | null => {
  const connectionId = String(value?.connectionId || '').trim();
  const dbName = String(value?.dbName || '').trim();
  if (!connectionId) return null;
  const schemaName = String(value?.schemaName || '').trim();
  const rowCountTables = Array.from(new Set((Array.isArray(value?.rowCountTables) ? value.rowCountTables : [])
    .map((table) => String(table || '').trim()).filter(Boolean)));
  return {
    connectionId,
    ...(dbName ? { dbName } : {}),
    ...(schemaName ? { schemaName } : {}),
    ...(rowCountTables.length ? { rowCountTables } : {}),
    ...(value?.reason ? { reason: value.reason } : {}),
  };
};

export const dispatchSidebarDatabaseRefresh = (
  request: Partial<SidebarDatabaseRefreshRequest>,
): boolean => {
  const detail = normalizeSidebarDatabaseRefreshRequest(request);
  if (!detail || typeof window === 'undefined') return false;
  window.dispatchEvent(new CustomEvent<SidebarDatabaseRefreshRequest>(
    SIDEBAR_DATABASE_REFRESH_EVENT,
    { detail },
  ));
  return true;
};

export const dispatchSidebarTableDataRefresh = (
  request: SidebarDatabaseRefreshRequest,
  tableName: string,
  dbType: string,
): boolean => {
  const dialect = resolveSqlDialect(dbType);
  const parts = isMysqlFamilyDialect(dialect)
    ? [tableName]
    : splitQualifiedNameSegmentsDetailed(tableName, dialect).map((part) => part.raw);
  if (!parts.length || !tableName.trim()) return false;
  if (parts.length === 1 && request.schemaName && !isMysqlFamilyDialect(dialect)) {
    parts.unshift(request.schemaName);
  }
  const owner = isOracleLikeDialect(dialect) && parts.length > 1
    ? stripIdentifierQuotes(parts[0], dialect) : '';
  return dispatchSidebarDatabaseRefresh({
    ...request,
    ...(owner ? { dbName: owner } : {}),
    rowCountTables: [parts.map((part) => quoteSqlIdentifierPart(dialect, part)).join('.')],
  });
};

export const normalizeSidebarDatabaseListRefreshRequest = (
  value: Partial<SidebarDatabaseListRefreshRequest> | null | undefined,
): SidebarDatabaseListRefreshRequest | null => {
  const connectionId = String(value?.connectionId || '').trim();
  if (!connectionId) return null;
  return {
    connectionId,
    ...(value?.reason ? { reason: value.reason } : {}),
  };
};

export const dispatchSidebarDatabaseListRefresh = (
  request: Partial<SidebarDatabaseListRefreshRequest>,
): boolean => {
  const detail = normalizeSidebarDatabaseListRefreshRequest(request);
  if (!detail || typeof window === 'undefined') return false;
  window.dispatchEvent(new CustomEvent<SidebarDatabaseListRefreshRequest>(
    SIDEBAR_DATABASE_LIST_REFRESH_EVENT,
    { detail },
  ));
  return true;
};
