import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

describe('dropped table tab bridge', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('closes the matching table data tab and preserves query, design, view, and other-database tabs', async () => {
    const { useStore } = await import('../store');
    const { closeTabsForDroppedTableEvent } = await import('./tableTabsDropped');
    useStore.setState({
      tabs: [
        {
          id: 'table-users',
          title: 'users',
          type: 'table',
          connectionId: 'conn-1',
          dbName: 'main',
          tableName: 'users',
        },
        {
          id: 'table-users-other-db',
          title: 'users',
          type: 'table',
          connectionId: 'conn-1',
          dbName: 'archive',
          tableName: 'users',
        },
        {
          id: 'table-users-view',
          title: 'users view',
          type: 'table',
          connectionId: 'conn-1',
          dbName: 'main',
          tableName: 'users',
          objectType: 'view',
        },
        {
          id: 'query-users',
          title: 'query users',
          type: 'query',
          connectionId: 'conn-1',
          dbName: 'main',
          tableName: 'users',
          query: 'select * from users',
        },
        {
          id: 'design-users',
          title: 'design users',
          type: 'design',
          connectionId: 'conn-1',
          dbName: 'main',
          tableName: 'users',
        },
      ],
      activeTabId: 'table-users',
      activeContext: {
        connectionId: 'conn-1',
        dbName: 'main',
        tableName: 'users',
      },
    });

    expect(closeTabsForDroppedTableEvent({
      connectionId: 'conn-1',
      dbName: 'main',
      tableNames: ['`users`'],
    })).toBe(true);

    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual([
      'table-users-other-db',
      'table-users-view',
      'query-users',
      'design-users',
    ]);
    expect(useStore.getState().activeTabId).toBe('design-users');
  });

  it('rejects an event without a connection or table target', async () => {
    const { closeTabsForDroppedTableEvent } = await import('./tableTabsDropped');
    expect(closeTabsForDroppedTableEvent({ tableNames: ['users'] })).toBe(false);
    expect(closeTabsForDroppedTableEvent({ connectionId: 'conn-1', tableNames: [] })).toBe(false);
  });

  it('matches quoted literal-dot and schema-qualified names without crossing databases', async () => {
    const { useStore } = await import('../store');
    const { closeTabsForDroppedTableEvent } = await import('./tableTabsDropped');
    useStore.setState({
      tabs: [
        {
          id: 'table-audit-log',
          title: 'audit.log',
          type: 'table',
          connectionId: 'conn-1',
          dbName: 'main',
          tableName: 'audit.log',
        },
        {
          id: 'table-reporting-orders',
          title: 'orders',
          type: 'table',
          connectionId: 'conn-1',
          dbName: 'main',
          schemaName: 'reporting',
          tableName: 'reporting.orders',
        },
        {
          id: 'table-reporting-orders-in-archive',
          title: 'orders',
          type: 'table',
          connectionId: 'conn-1',
          dbName: 'archive',
          schemaName: 'reporting',
          tableName: 'reporting.orders',
        },
      ],
      activeTabId: 'table-audit-log',
    });

    expect(closeTabsForDroppedTableEvent({
      connectionId: 'conn-1',
      dbName: 'main',
      schemaName: 'reporting',
      tableNames: ['`audit.log`', 'reporting.orders'],
    })).toBe(true);

    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual([
      'table-reporting-orders-in-archive',
    ]);
  });
});
