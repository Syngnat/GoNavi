export const SIDEBAR_DATABASE_REFRESH_EVENT = 'gonavi:sidebar-database-refresh';
export const SIDEBAR_DATABASE_LIST_REFRESH_EVENT = 'gonavi:sidebar-database-list-refresh';

export type SidebarDatabaseRefreshRequest = {
  connectionId: string;
  // Omitted for data sources whose schema is scoped directly to a connection
  // (for example SQLite files). Consumers then refresh the whole connection.
  dbName?: string;
  schemaName?: string;
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
  return {
    connectionId,
    ...(dbName ? { dbName } : {}),
    ...(schemaName ? { schemaName } : {}),
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
