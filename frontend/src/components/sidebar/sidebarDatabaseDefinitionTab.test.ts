import { describe, expect, it } from 'vitest';

import { buildSidebarDatabaseDefinitionTab } from './sidebarDatabaseDefinitionTab';

describe('sidebar database definition tab', () => {
  it('builds a read-only database definition tab from a database node', () => {
    expect(buildSidebarDatabaseDefinitionTab({
      connectionId: 'conn-1',
      dbName: 'tenant',
      nodeKey: 'conn-1-tenant',
      title: 'Database definition: tenant',
    })).toEqual({
      id: 'database-def-conn-1-tenant',
      title: 'Database definition: tenant',
      type: 'database-def',
      connectionId: 'conn-1',
      dbName: 'tenant',
      readOnly: true,
      sidebarLocateKey: 'conn-1-tenant',
    });
  });

  it('rejects incomplete database targets', () => {
    expect(buildSidebarDatabaseDefinitionTab({
      connectionId: '',
      dbName: 'tenant',
      title: 'Database definition',
    })).toBeNull();
    expect(buildSidebarDatabaseDefinitionTab({
      connectionId: 'conn-1',
      dbName: ' ',
      title: 'Database definition',
    })).toBeNull();
  });
});
