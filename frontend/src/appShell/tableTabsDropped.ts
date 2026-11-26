import { useStore } from '../store';
import {
  normalizeTableTabsDroppedRequest,
  type TableTabsDroppedRequest,
} from '../utils/sidebarDatabaseRefresh';

export const closeTabsForDroppedTableEvent = (detail: unknown): boolean => {
  const request = normalizeTableTabsDroppedRequest(
    detail as Partial<TableTabsDroppedRequest> | null | undefined,
  );
  if (!request) return false;
  useStore.getState().closeTabsByDroppedTables(
    request.connectionId,
    request.dbName || '',
    request.tableNames,
    request.schemaName,
  );
  return true;
};
