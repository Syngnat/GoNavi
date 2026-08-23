import { describe, expect, it } from 'vitest';

import { normalizeSidebarDatabaseRefreshRequest } from './sidebarDatabaseRefresh';

describe('sidebar database refresh requests', () => {
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

  it('rejects requests that cannot identify a database node', () => {
    expect(normalizeSidebarDatabaseRefreshRequest({ connectionId: '', dbName: 'sales' })).toBeNull();
    expect(normalizeSidebarDatabaseRefreshRequest({ connectionId: 'mysql-target', dbName: '' })).toBeNull();
  });
});
