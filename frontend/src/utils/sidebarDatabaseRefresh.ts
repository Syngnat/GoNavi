import { splitQualifiedNameSegmentsDetailed, stripIdentifierQuotes } from './qualifiedName';
import { isMysqlFamilyDialect, isOracleLikeDialect, quoteSqlIdentifierPart, resolveSqlDialect } from './sqlDialect';

export const SIDEBAR_DATABASE_REFRESH_EVENT = 'gonavi:sidebar-database-refresh';
export const SIDEBAR_DATABASE_LIST_REFRESH_EVENT = 'gonavi:sidebar-database-list-refresh';
export const TABLE_TABS_DROPPED_EVENT = 'gonavi:table-tabs-dropped';

export type SidebarDatabaseRefreshRequest = {
  connectionId: string;
  // Omitted for data sources whose schema is scoped directly to a connection
  // (for example SQLite files). Consumers then refresh the whole connection.
  dbName?: string;
  schemaName?: string;
  rowCountTables?: string[];
  clearedTables?: string[];
  droppedTables?: string[];
  /** True when the refresh follows DDL, so object-definition viewers must re-read too. */
  schemaChanged?: boolean;
  reason?: 'data-sync' | 'external';
};

export type SidebarDatabaseListRefreshRequest = {
  connectionId: string;
  reason?: 'elasticsearch-write' | 'external';
};

export type TableTabsDroppedRequest = {
  connectionId: string;
  dbName?: string;
  schemaName?: string;
  tableNames: string[];
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
    ...(Array.isArray(value?.clearedTables) ? { clearedTables: value.clearedTables.map(table => String(table).trim()).filter(Boolean) } : {}),
    ...(Array.isArray(value?.droppedTables) ? { droppedTables: value.droppedTables.map(table => String(table).trim()).filter(Boolean) } : {}),
    ...(value?.schemaChanged === true ? { schemaChanged: true } : {}),
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

export const normalizeTableTabsDroppedRequest = (
  value: Partial<TableTabsDroppedRequest> | null | undefined,
): TableTabsDroppedRequest | null => {
  const connectionId = String(value?.connectionId || '').trim();
  if (!connectionId) return null;
  const dbName = String(value?.dbName || '').trim();
  const schemaName = String(value?.schemaName || '').trim();
  const tableNames = Array.from(new Set((Array.isArray(value?.tableNames) ? value.tableNames : [])
    .map((table) => String(table || '').trim()).filter(Boolean)));
  if (tableNames.length === 0) return null;
  return {
    connectionId,
    tableNames,
    ...(dbName ? { dbName } : {}),
    ...(schemaName ? { schemaName } : {}),
  };
};

export const dispatchTableTabsDropped = (
  request: Partial<TableTabsDroppedRequest>,
): boolean => {
  const detail = normalizeTableTabsDroppedRequest(request);
  if (!detail || typeof window === 'undefined') return false;
  window.dispatchEvent(new CustomEvent<TableTabsDroppedRequest>(
    TABLE_TABS_DROPPED_EVENT,
    { detail },
  ));
  return true;
};

export type SidebarTableCreatedRequest = {
  connectionId: string;
  dbName: string;
  schemaName?: string;
  tableName?: string;
};

export const dispatchSidebarTableCreated = (
  request: Partial<SidebarTableCreatedRequest> | null | undefined,
): boolean => {
  const connectionId = String(request?.connectionId || '').trim();
  const dbName = String(request?.dbName || '').trim();
  if (!connectionId || !dbName || typeof window === 'undefined') return false;
  const schemaName = String(request?.schemaName || '').trim();
  const tableName = String(request?.tableName || '').trim();
  window.dispatchEvent(new CustomEvent<SidebarTableCreatedRequest>(
    'gonavi:sidebar-table-created',
    {
      detail: {
        connectionId,
        dbName,
        ...(schemaName ? { schemaName } : {}),
        ...(tableName ? { tableName } : {}),
      },
    },
  ));
  return true;
};

const buildSidebarTableDataRefreshRequest = (
  request: SidebarDatabaseRefreshRequest,
  tableName: string,
  dbType: string,
): SidebarDatabaseRefreshRequest | null => {
  const dialect = resolveSqlDialect(dbType);
  const parts = isMysqlFamilyDialect(dialect)
    ? [tableName]
    : splitQualifiedNameSegmentsDetailed(tableName, dialect).map((part) => part.raw);
  if (!parts.length || !tableName.trim()) return null;
  if (parts.length === 1 && request.schemaName && !isMysqlFamilyDialect(dialect)) {
    parts.unshift(request.schemaName);
  }
  const owner = isOracleLikeDialect(dialect) && parts.length > 1
    ? stripIdentifierQuotes(parts[0], dialect) : '';
  return {
    ...request,
    ...(owner ? { dbName: owner } : {}),
    rowCountTables: [parts.map((part) => quoteSqlIdentifierPart(dialect, part)).join('.')],
  };
};

export const dispatchSidebarTableDataRefresh = (
  request: SidebarDatabaseRefreshRequest, tableName: string, dbType: string,
): boolean => {
  const target = buildSidebarTableDataRefreshRequest(request, tableName, dbType);
  return target ? dispatchSidebarDatabaseRefresh(target) : false;
};

export const dispatchSidebarTableMutationRefresh = (
  request: SidebarDatabaseRefreshRequest, tableNames: string[], dbType: string, action: 'clear' | 'drop',
): void => {
  const targets = new Map<string, SidebarDatabaseRefreshRequest>();
  for (const table of tableNames) {
    const target = buildSidebarTableDataRefreshRequest(request, table, dbType);
    if (!target) continue;
    const key = target.dbName || '';
    const previous = targets.get(key);
    targets.set(key, { ...target, rowCountTables: [...(previous?.rowCountTables || []), ...(target.rowCountTables || [])] });
  }
  for (const target of targets.values()) {
    dispatchSidebarDatabaseRefresh({ ...target,
      ...(action === 'clear' ? { clearedTables: target.rowCountTables } : { droppedTables: target.rowCountTables }),
    });
  }
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
