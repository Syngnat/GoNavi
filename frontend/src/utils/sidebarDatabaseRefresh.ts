export const SIDEBAR_DATABASE_REFRESH_EVENT = 'gonavi:sidebar-database-refresh';

export type SidebarDatabaseRefreshRequest = {
  connectionId: string;
  dbName: string;
  schemaName?: string;
  reason?: 'data-sync' | 'external';
};

export const normalizeSidebarDatabaseRefreshRequest = (
  value: Partial<SidebarDatabaseRefreshRequest> | null | undefined,
): SidebarDatabaseRefreshRequest | null => {
  const connectionId = String(value?.connectionId || '').trim();
  const dbName = String(value?.dbName || '').trim();
  if (!connectionId || !dbName) return null;
  const schemaName = String(value?.schemaName || '').trim();
  return {
    connectionId,
    dbName,
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
