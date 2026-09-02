import { describe, expect, it } from 'vitest';

import { canInheritNewQueryTableContext, resolveNewQueryContext } from './newQueryContext';

describe('resolveNewQueryContext', () => {
  const validConnectionIds = new Set(['conn-a', 'conn-b']);

  it('prefers the explicitly selected sidebar database over the active query tab', () => {
    expect(resolveNewQueryContext({
      sidebarContext: { connectionId: 'conn-b', dbName: 'database_b' },
      activeTab: { connectionId: 'conn-a', dbName: 'database_a' },
      validConnectionIds,
    })).toEqual({ connectionId: 'conn-b', dbName: 'database_b' });
  });

  it('preserves the explicitly selected sidebar schema for a new query tab', () => {
    expect(resolveNewQueryContext({
      sidebarContext: { connectionId: 'conn-b', dbName: 'database_b', schemaName: 'anno' },
      activeTab: { connectionId: 'conn-b', dbName: 'database_b', schemaName: 'dbms_job' },
      validConnectionIds,
    })).toEqual({ connectionId: 'conn-b', dbName: 'database_b', schemaName: 'anno' });
  });

  it('keeps a valid connection-level sidebar selection instead of borrowing the tab database', () => {
    expect(resolveNewQueryContext({
      sidebarContext: { connectionId: 'conn-b', dbName: '' },
      activeTab: { connectionId: 'conn-a', dbName: 'database_a' },
      validConnectionIds,
    })).toEqual({ connectionId: 'conn-b', dbName: '' });
  });

  it('falls back to the active tab when the sidebar context is unavailable or stale', () => {
    expect(resolveNewQueryContext({
      sidebarContext: { connectionId: 'removed-connection', dbName: 'old_db' },
      activeTab: { connectionId: 'conn-a', dbName: 'database_a' },
      validConnectionIds,
    })).toEqual({ connectionId: 'conn-a', dbName: 'database_a' });
  });

  it('preserves database identifiers exactly as stored', () => {
    expect(resolveNewQueryContext({
      sidebarContext: { connectionId: 'conn-b', dbName: ' database b ' },
      activeTab: null,
      validConnectionIds,
    })).toEqual({ connectionId: 'conn-b', dbName: ' database b ' });
  });

  it('returns an unbound query context when neither source points to a valid connection', () => {
    expect(resolveNewQueryContext({
      sidebarContext: null,
      activeTab: { connectionId: 'removed-connection', dbName: 'old_db' },
      validConnectionIds,
    })).toEqual({ connectionId: '', dbName: '' });
  });

  it('only inherits a table tab when it belongs to the resolved target context', () => {
    const tableTab = { type: 'table', connectionId: 'conn-a', dbName: 'database_a', tableName: 'users' };
    expect(canInheritNewQueryTableContext({
      activeTab: tableTab,
      targetContext: { connectionId: 'conn-a', dbName: 'database_a' },
    })).toBe(true);
    expect(canInheritNewQueryTableContext({
      activeTab: tableTab,
      targetContext: { connectionId: 'conn-b', dbName: 'database_b' },
    })).toBe(false);
    expect(canInheritNewQueryTableContext({
      activeTab: { ...tableTab, type: 'query' },
      targetContext: { connectionId: 'conn-a', dbName: 'database_a' },
    })).toBe(false);
  });

  it('does not inherit a table from a different schema', () => {
    const tableTab = {
      type: 'table',
      connectionId: 'conn-a',
      dbName: 'database_a',
      schemaName: 'dbms_job',
      tableName: 'users',
    };
    expect(canInheritNewQueryTableContext({
      activeTab: tableTab,
      targetContext: { connectionId: 'conn-a', dbName: 'database_a', schemaName: 'anno' },
    })).toBe(false);
  });
});
