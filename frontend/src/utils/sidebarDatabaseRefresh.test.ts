import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  normalizeSidebarDatabaseListRefreshRequest,
  normalizeSidebarDatabaseRefreshRequest,
  dispatchSidebarTableDataRefresh,
} from './sidebarDatabaseRefresh';

describe('sidebar database refresh requests', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('normalizes a valid target without carrying empty optional fields', () => {
    expect(normalizeSidebarDatabaseRefreshRequest({
      connectionId: ' mysql-target ',
      dbName: ' sales ',
      schemaName: ' ',
      reason: 'data-sync',
    })).toEqual({
      connectionId: 'mysql-target',
      dbName: 'sales',
      reason: 'data-sync',
    });
  });

  it('rejects requests without a connection target and permits connection-scoped refreshes', () => {
    expect(normalizeSidebarDatabaseRefreshRequest({ connectionId: '', dbName: 'sales' })).toBeNull();
    expect(normalizeSidebarDatabaseRefreshRequest({ connectionId: ' sqlite-target ', dbName: '' })).toEqual({
      connectionId: 'sqlite-target',
    });
  });

  it('normalizes a connection-scoped database-list refresh request', () => {
    expect(normalizeSidebarDatabaseListRefreshRequest({
      connectionId: ' elasticsearch-target ',
      reason: 'elasticsearch-write',
    })).toEqual({
      connectionId: 'elasticsearch-target',
      reason: 'elasticsearch-write',
    });
    expect(normalizeSidebarDatabaseListRefreshRequest({ connectionId: ' ' })).toBeNull();
  });

  it('keeps live row-count targets while dropping blanks and duplicates', () => {
    expect(normalizeSidebarDatabaseRefreshRequest({
      connectionId: 'conn-1', dbName: 'app', schemaName: ' reporting ',
      rowCountTables: [' public.orders ', '', 'public.orders', 'reporting.orders'],
    })).toEqual({
      connectionId: 'conn-1', dbName: 'app', schemaName: 'reporting',
      rowCountTables: ['public.orders', 'reporting.orders'],
    });
  });

  it.each([
    ['mysql', 'users', '', 'main', '`users`'],
    ['mysql', 'audit.log', 'main', 'main', '`audit.log`'],
    ['postgres', 'reporting.orders', 'reporting', 'main', 'reporting.orders'],
    ['postgres', 'orders', 'reporting', 'main', 'reporting.orders'],
    ['sqlserver', 'dbo.orders', 'dbo', 'main', '[dbo].[orders]'],
    ['dameng', 'APP.ORDERS', 'APP', 'APP', '"APP"."ORDERS"'],
    ['oracle', 'ORDERS', 'tenant.audit', 'tenant.audit', '"tenant.audit"."ORDERS"'],
  ])('targets the existing %s table without duplicating its schema', (type, tableName, schemaName, expectedDatabase, expectedTable) => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    expect(dispatchSidebarTableDataRefresh({ connectionId: 'conn-1', dbName: 'main', schemaName }, tableName, type)).toBe(true);
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'gonavi:sidebar-database-refresh',
      detail: {
        connectionId: 'conn-1', dbName: expectedDatabase,
        ...(schemaName ? { schemaName } : {}), rowCountTables: [expectedTable],
      },
    }));
  });
});
