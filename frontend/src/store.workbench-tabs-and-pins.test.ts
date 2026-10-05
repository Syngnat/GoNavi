import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBatchTableExportWorkbenchTab } from './utils/tableExportTab';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
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

const importStore = async () => {
  const store = await import('./store');
  await store.useStore.persist.rehydrate();
  return store;
};

describe('store appearance persistence', () => {
  // 预热 store 模块转换缓存：拆分后的首个用例不必在默认超时内承担冷编译
  beforeAll(async () => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    await import('./store');
    vi.unstubAllGlobals();
    vi.resetModules();
  }, 30_000);

  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('reuses the same table-export tab for the same connection and table identity', async () => {
    const { useStore } = await importStore();

    useStore.getState().addTab({
      id: 'table-export-conn-1-main-users',
      title: '导出 users',
      type: 'table-export',
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'users',
      initialTab: 'config',
    });
    useStore.getState().addTab({
      id: 'another-id-that-should-collapse',
      title: '导出 users',
      type: 'table-export',
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'users',
      initialTab: 'progress',
    });

    expect(useStore.getState().tabs).toHaveLength(1);
    expect(useStore.getState().tabs[0]).toEqual(expect.objectContaining({
      id: 'table-export-conn-1-main-users',
      type: 'table-export',
      initialTab: 'progress',
    }));
    expect(useStore.getState().activeTabId).toBe('table-export-conn-1-main-users');
  });

  it('clears an auto-start request when a stable export workbench is reopened for review', async () => {
    const { useStore } = await importStore();

    useStore.getState().addTab(buildBatchTableExportWorkbenchTab({
      connectionId: 'conn-1',
      dbName: 'main',
      initialObjectNames: ['users'],
      contentMode: 'dataOnly',
      includeDropIfExists: true,
      requestKey: 'request-1',
    }));
    useStore.getState().addTab(buildBatchTableExportWorkbenchTab({
      connectionId: 'conn-1',
      dbName: 'main',
      initialObjectNames: ['orders'],
      contentMode: 'backup',
      includeDropIfExists: false,
      launchKey: 'launch-2',
    }));

    expect(useStore.getState().tabs).toHaveLength(1);
    expect(useStore.getState().tabs[0]).toEqual(expect.objectContaining({
      tableExportInitialObjectNames: ['orders'],
      tableExportContentMode: 'backup',
      tableExportIncludeDropIfExists: false,
      tableExportLaunchKey: 'launch-2',
      tableExportRequestKey: undefined,
    }));
  });

  it('keeps a running data import tab until the foreground import finishes', async () => {
    const { useStore } = await importStore();

    useStore.getState().addTab({
      id: 'query-1',
      title: 'Query 1',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
    });
    useStore.getState().addTab({
      id: 'data-import-workbench',
      title: 'Data import',
      type: 'data-import',
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'users',
      dataImportRunning: true,
    });
    useStore.getState().addTab({
      id: 'query-2',
      title: 'Query 2',
      type: 'query',
      connectionId: 'conn-2',
      dbName: 'analytics',
    });

    useStore.getState().closeTab('data-import-workbench');
    expect(useStore.getState().tabs.map((tab) => tab.id)).toContain('data-import-workbench');

    useStore.getState().closeTabsToLeft('query-2');
    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual([
      'data-import-workbench',
      'query-2',
    ]);

    useStore.getState().closeAllTabs();
    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual(['data-import-workbench']);
    expect(useStore.getState().activeContext).toEqual({
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'users',
    });

    useStore.getState().addTab({
      ...useStore.getState().tabs[0],
      dataImportRunning: false,
    });
    useStore.getState().closeAllTabs();
    expect(useStore.getState().tabs).toEqual([]);
  });

  it('preserves a running data import when closing tabs by database or connection', async () => {
    const { useStore } = await importStore();

    useStore.getState().addTab({
      id: 'data-import-workbench',
      title: 'Data import',
      type: 'data-import',
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'users',
      dataImportRunning: true,
    });
    useStore.getState().addTab({
      id: 'table-users',
      title: 'users',
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'users',
    });

    useStore.getState().closeTabsByDatabase('conn-1', 'main');
    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual(['data-import-workbench']);

    useStore.getState().closeTabsByConnection('conn-1');
    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual(['data-import-workbench']);
  });

  it('preserves a running data import when closing right-side or other tabs', async () => {
    const { useStore } = await importStore();
    const addQuery = (id: string) => useStore.getState().addTab({
      id,
      title: id,
      type: 'query',
      connectionId: 'conn-2',
      dbName: 'analytics',
    });

    addQuery('query-left');
    useStore.getState().addTab({
      id: 'data-import-workbench',
      title: 'Data import',
      type: 'data-import',
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'users',
      dataImportRunning: true,
    });
    addQuery('query-right');

    useStore.getState().closeTabsToRight('query-left');
    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual([
      'query-left',
      'data-import-workbench',
    ]);

    addQuery('query-right');
    useStore.getState().closeOtherTabs('query-left');
    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual([
      'query-left',
      'data-import-workbench',
    ]);
  });

  it('persists table export history across store reloads', async () => {
    const { useStore } = await importStore();

    useStore.getState().upsertTableExportHistory('conn-1::main::users', {
      jobId: 'job-1',
      targetName: 'users',
      startedAt: 1_000,
      finishedAt: 61_000,
      format: 'XLSX',
      scope: 'all',
      scopeLabel: '全表数据',
      strategyLabel: '整表导出链路',
      status: 'done',
      stage: '导出完成',
      current: 500_000,
      total: 500_000,
      totalRowsKnown: true,
      filePath: '/tmp/users.xlsx',
      message: '',
    });

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.tableExportHistories['conn-1::main::users']).toEqual([
      expect.objectContaining({
        jobId: 'job-1',
        status: 'done',
        filePath: '/tmp/users.xlsx',
      }),
    ]);

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().tableExportHistories['conn-1::main::users']).toEqual([
      expect.objectContaining({
        jobId: 'job-1',
        current: 500_000,
        total: 500_000,
        status: 'done',
      }),
    ]);
  });

  it('does not persist export jobs that cannot survive an app restart', async () => {
    const { useStore } = await importStore();
    const runningEntry = {
      jobId: 'job-running',
      targetName: 'users',
      startedAt: 1_000,
      finishedAt: 0,
      format: 'SQL',
      scope: 'all',
      scopeLabel: '全表数据',
      strategyLabel: '备份',
      status: 'running' as const,
      stage: '正在备份',
      current: 1,
      total: 2,
      totalRowsKnown: true,
      filePath: '/tmp/users.sql',
      message: '',
    };

    useStore.getState().upsertTableExportHistory('conn-1::main::users', runningEntry);
    expect(useStore.getState().tableExportHistories['conn-1::main::users']).toBeUndefined();

    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        tableExportHistories: {
          'conn-1::main::users': [runningEntry],
        },
      },
      version: 16,
    }));
    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().tableExportHistories['conn-1::main::users']).toBeUndefined();
  });

  it('only restores persisted query tabs with useful SQL state', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        tabs: [
          {
            id: 'query-1',
            title: '有效 SQL',
            type: 'query',
            connectionId: 'conn-1',
            dbName: 'main',
            query: 'select 1;',
          },
          {
            id: 'table-1',
            title: 'users',
            type: 'table',
            connectionId: 'conn-1',
            dbName: 'main',
            tableName: 'users',
          },
          {
            id: 'empty-query',
            title: '空查询',
            type: 'query',
            connectionId: 'conn-1',
            dbName: 'main',
            query: '   ',
          },
        ],
        activeTabId: 'table-1',
      },
      version: 9,
    }));

    const { useStore } = await importStore();

    expect(useStore.getState().tabs).toEqual([
      expect.objectContaining({
        id: 'query-1',
        type: 'query',
        query: 'select 1;',
      }),
    ]);
    expect(useStore.getState().activeTabId).toBe('query-1');
  });

  it('keeps only the most recent runtime SQL logs and trims oversized entries', async () => {
    const { useStore } = await importStore();
    const longSql = `select '${'x'.repeat(20 * 1024)}'`;

    for (let i = 0; i < 140; i += 1) {
      useStore.getState().addSqlLog({
        id: `log-${i}`,
        timestamp: 100 + i,
        sql: longSql,
        status: 'success',
        duration: 12 + i,
        dbName: 'main',
      });
    }

    expect(useStore.getState().sqlLogs).toHaveLength(120);
    expect(useStore.getState().sqlLogs[0]).toEqual(expect.objectContaining({
      id: 'log-139',
      dbName: 'main',
    }));
    expect(useStore.getState().sqlLogs[119]).toEqual(expect.objectContaining({
      id: 'log-20',
    }));
    expect(useStore.getState().sqlLogs[0]?.sql.length).toBe(12 * 1024);

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.sqlLogs).toHaveLength(120);
    expect(persisted.state.sqlLogs[0].sql.length).toBe(12 * 1024);
    expect(persisted.state.sqlLogs[0].dbName).toBe('main');

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().sqlLogs[0]).toEqual(expect.objectContaining({
      id: 'log-139',
      status: 'success',
      duration: 151,
      dbName: 'main',
    }));
    expect(reloaded.useStore.getState().sqlLogs).toHaveLength(120);
    expect(reloaded.useStore.getState().sqlLogs[119]).toEqual(expect.objectContaining({
      id: 'log-20',
    }));
    expect(reloaded.useStore.getState().sqlLogs[0]?.sql.length).toBe(12 * 1024);
  });

  it('hides recent queries without deleting their SQL execution logs', async () => {
    const { useStore } = await importStore();
    const makeLog = (id: string) => ({
      id,
      timestamp: 100,
      sql: `select '${id}'`,
      status: 'success' as const,
      duration: 12,
    });

    useStore.getState().addSqlLog(makeLog('log-1'));
    useStore.getState().addSqlLog(makeLog('log-2'));
    useStore.getState().addSqlLog(makeLog('log-3'));
    useStore.getState().hideSqlLogFromRecent('log-2');

    expect(useStore.getState().sqlLogs.map((log) => log.id)).toEqual(['log-3', 'log-2', 'log-1']);
    expect(useStore.getState().sqlLogs.find((log) => log.id === 'log-2')).toMatchObject({
      hiddenFromRecent: true,
    });
    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.sqlLogs.map((log: { id: string }) => log.id)).toEqual(['log-3', 'log-2', 'log-1']);
    expect(persisted.state.sqlLogs.find((log: { id: string }) => log.id === 'log-2')).toMatchObject({
      hiddenFromRecent: true,
    });

    useStore.getState().clearRecentSqlLogs();
    expect(useStore.getState().sqlLogs).toHaveLength(3);
    expect(useStore.getState().sqlLogs.every((log) => log.hiddenFromRecent === true)).toBe(true);

    useStore.getState().addSqlLog(makeLog('log-4'));
    expect(useStore.getState().sqlLogs[0]).toMatchObject({ id: 'log-4' });
    expect(useStore.getState().sqlLogs[0]?.hiddenFromRecent).toBeUndefined();

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().sqlLogs).toHaveLength(4);
    expect(reloaded.useStore.getState().sqlLogs.find((log) => log.id === 'log-2')).toMatchObject({
      hiddenFromRecent: true,
    });
  });

  it('preserves SQL transaction log metadata across persistence', async () => {
    const { useStore } = await importStore();

    useStore.getState().addSqlLog({
      id: 'transaction-tx-1',
      timestamp: 100,
      sql: 'START TRANSACTION;\nUPDATE users SET active = 1 WHERE id = 1;\nCOMMIT;',
      status: 'success',
      duration: 32,
      dbName: 'main',
      category: 'transaction',
      transactionId: 'tx-1',
      transactionAction: 'commit',
    });

    expect(useStore.getState().sqlLogs[0]).toMatchObject({
      category: 'transaction',
      transactionId: 'tx-1',
      transactionAction: 'commit',
    });

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().sqlLogs[0]).toMatchObject({
      category: 'transaction',
      transactionId: 'tx-1',
      transactionAction: 'commit',
    });
  });

  it('shrinks oversized SQL logs from older persisted snapshots during hydration', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        sqlLogs: Array.from({ length: 200 }, (_, index) => ({
          id: `legacy-log-${index}`,
          timestamp: 500 + index,
          sql: `select '${'x'.repeat(18 * 1024)}'`,
          status: index % 2 === 0 ? 'success' : 'error',
          duration: index,
          dbName: 'legacy',
          message: 'm'.repeat(3 * 1024),
        })),
      },
      version: 12,
    }));

    const { useStore } = await importStore();
    const sqlLogs = useStore.getState().sqlLogs;

    expect(sqlLogs).toHaveLength(120);
    expect(sqlLogs[0]).toEqual(expect.objectContaining({
      id: 'legacy-log-0',
      dbName: 'legacy',
    }));
    expect(sqlLogs[119]).toEqual(expect.objectContaining({
      id: 'legacy-log-119',
    }));
    expect(sqlLogs[0]?.sql.length).toBe(12 * 1024);
    expect(sqlLogs[0]?.message?.length).toBe(1024);
  });

  it('defaults AI chat send shortcut to Enter in shared shortcut options', async () => {
    const { useStore } = await importStore();

    expect(useStore.getState().shortcutOptions.sendAIChatMessage).toEqual({
      mac: { combo: 'Enter', enabled: true },
      windows: { combo: 'Enter', enabled: true },
    });
  });

  it('persists recorded AI chat send shortcut and restores it after reload', async () => {
    const { useStore } = await importStore();

    useStore.getState().updateShortcut('sendAIChatMessage', {
      combo: 'Meta+Enter',
      enabled: true,
    }, 'mac');

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.shortcutOptions.sendAIChatMessage).toEqual({
      mac: { combo: 'Meta+Enter', enabled: true },
      windows: { combo: 'Enter', enabled: true },
    });

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().shortcutOptions.sendAIChatMessage).toEqual({
      mac: { combo: 'Meta+Enter', enabled: true },
      windows: { combo: 'Enter', enabled: true },
    });
  });

  it('persists save query as shortcut with platform defaults', async () => {
    const { useStore } = await importStore();

    expect(useStore.getState().shortcutOptions.saveQueryAs).toEqual({
      mac: { combo: 'Meta+Shift+S', enabled: true },
      windows: { combo: 'Ctrl+Shift+S', enabled: true },
    });

    useStore.getState().updateShortcut('saveQueryAs', {
      combo: 'Meta+Alt+S',
      enabled: true,
    }, 'mac');

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.shortcutOptions.saveQueryAs).toEqual({
      mac: { combo: 'Meta+Alt+S', enabled: true },
      windows: { combo: 'Ctrl+Shift+S', enabled: true },
    });

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().shortcutOptions.saveQueryAs).toEqual({
      mac: { combo: 'Meta+Alt+S', enabled: true },
      windows: { combo: 'Ctrl+Shift+S', enabled: true },
    });
  });

  it('persists startup fullscreen immediately so next launch does not miss maximize preference', async () => {
    const { useStore } = await importStore();

    useStore.getState().setStartupFullscreen(true);

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.startupFullscreen).toBe(true);

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().startupFullscreen).toBe(true);
  });

  it('defaults auto-check for updates to true and persists explicit disable', async () => {
    const { useStore } = await importStore();

    expect(useStore.getState().autoCheckForUpdates).toBe(true);

    useStore.getState().setAutoCheckForUpdates(false);

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.autoCheckForUpdates).toBe(false);

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().autoCheckForUpdates).toBe(false);

    storage.setItem('lite-db-storage', JSON.stringify({
      state: {},
      version: 17,
    }));
    vi.resetModules();
    const hydrated = await importStore();
    expect(hydrated.useStore.getState().autoCheckForUpdates).toBe(true);
  });

  it('defaults auto-check interval to 30 minutes and sanitizes invalid values', async () => {
    const { useStore } = await importStore();

    expect(useStore.getState().autoCheckForUpdatesIntervalMinutes).toBe(30);

    useStore.getState().setAutoCheckForUpdatesIntervalMinutes(60);

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.autoCheckForUpdatesIntervalMinutes).toBe(60);

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().autoCheckForUpdatesIntervalMinutes).toBe(60);

    reloaded.useStore.getState().setAutoCheckForUpdatesIntervalMinutes(7);
    expect(reloaded.useStore.getState().autoCheckForUpdatesIntervalMinutes).toBe(30);

    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        autoCheckForUpdatesIntervalMinutes: 99,
      },
      version: 17,
    }));
    vi.resetModules();
    const hydrated = await importStore();
    expect(hydrated.useStore.getState().autoCheckForUpdatesIntervalMinutes).toBe(30);
  });

  it('persists window state and bounds immediately across store reloads', async () => {
    const { useStore } = await importStore();

    useStore.getState().setWindowState('maximized');
    useStore.getState().setWindowBounds({ width: 1400, height: 900, x: 80, y: 40, dpi: 144 });

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.windowState).toBe('maximized');
    expect(persisted.state.windowBounds).toEqual({ width: 1400, height: 900, x: 80, y: 40, dpi: 144 });

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().windowState).toBe('maximized');
    expect(reloaded.useStore.getState().windowBounds).toEqual({ width: 1400, height: 900, x: 80, y: 40, dpi: 144 });

    reloaded.useStore.getState().setWindowBounds({ width: 1400, height: 900, x: 80, y: 40, dpi: Number.NaN });
    expect(reloaded.useStore.getState().windowBounds).toEqual({ width: 1400, height: 900, x: 80, y: 40 });
  });

  it('falls back to Enter when persisted AI chat send shortcut is invalid', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        shortcutOptions: {
          sendAIChatMessage: {
            combo: 'A',
            enabled: true,
          },
        },
      },
      version: 8,
    }));

    const { useStore } = await importStore();

    expect(useStore.getState().shortcutOptions.sendAIChatMessage).toEqual({
      mac: { combo: 'Enter', enabled: true },
      windows: { combo: 'Enter', enabled: true },
    });
  });

  it('migrates legacy sidebar search defaults to K only before storage version 18', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        shortcutOptions: {
          focusSidebarSearch: {
            mac: { combo: 'Meta+F', enabled: false },
            windows: { combo: 'Ctrl+F', enabled: true },
          },
        },
      },
      version: 17,
    }));

    const migrated = await importStore();
    expect(migrated.useStore.getState().shortcutOptions.focusSidebarSearch).toEqual({
      mac: { combo: 'Meta+K', enabled: false },
      windows: { combo: 'Ctrl+K', enabled: true },
    });
    expect(JSON.parse(storage.getItem('lite-db-storage') || '{}').version).toBe(21);

    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        shortcutOptions: {
          focusSidebarSearch: {
            mac: { combo: 'Meta+F', enabled: true },
            windows: { combo: 'Ctrl+F', enabled: false },
          },
        },
      },
      version: 18,
    }));
    vi.resetModules();

    const current = await importStore();
    expect(current.useStore.getState().shortcutOptions.focusSidebarSearch).toEqual({
      mac: { combo: 'Meta+F', enabled: true },
      windows: { combo: 'Ctrl+F', enabled: false },
    });
  });

  it('does not restore legacy sidebar search defaults during an early startup refresh', async () => {
    const { useStore } = await importStore();
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        shortcutOptions: {
          focusSidebarSearch: { combo: 'Ctrl+F', enabled: true },
        },
      },
      version: 17,
    }));

    useStore.getState().replaceConnections([]);

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.shortcutOptions.focusSidebarSearch).toEqual({
      mac: { combo: 'Meta+K', enabled: true },
      windows: { combo: 'Ctrl+K', enabled: true },
    });
  });

  it('does not overwrite recorded AI chat send shortcut during startup config refresh', async () => {
    const { useStore } = await importStore();
    useStore.getState().updateShortcut('sendAIChatMessage', {
      combo: 'Ctrl+Enter',
      enabled: true,
    }, 'windows');

    useStore.getState().replaceConnections([]);

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.shortcutOptions.sendAIChatMessage).toEqual({
      mac: { combo: 'Enter', enabled: true },
      windows: { combo: 'Ctrl+Enter', enabled: true },
    });
  });

  it('keeps persisted AI chat send shortcut when startup refresh runs before shortcut hydration catches up', async () => {
    const { useStore } = await importStore();
    const shortcutOptions = useStore.getState().shortcutOptions;
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        shortcutOptions: {
          ...shortcutOptions,
          sendAIChatMessage: {
            mac: { combo: 'Meta+Enter', enabled: true },
            windows: { combo: 'Ctrl+Enter', enabled: true },
          },
        },
      },
      version: 8,
    }));
    useStore.setState({
      shortcutOptions: {
        ...shortcutOptions,
        sendAIChatMessage: {
          mac: { combo: 'Enter', enabled: true },
          windows: { combo: 'Enter', enabled: true },
        },
      },
    });

    useStore.getState().replaceConnections([]);

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.shortcutOptions.sendAIChatMessage).toEqual({
      mac: { combo: 'Meta+Enter', enabled: true },
      windows: { combo: 'Ctrl+Enter', enabled: true },
    });
  });

  it('does not let a stale default shortcut state overwrite an explicitly recorded AI chat shortcut', async () => {
    const { useStore } = await importStore();
    const shortcutOptions = useStore.getState().shortcutOptions;

    useStore.getState().updateShortcut('sendAIChatMessage', {
      combo: 'Meta+Enter',
      enabled: true,
    }, 'mac');
    useStore.setState({
      shortcutOptions: {
        ...shortcutOptions,
        sendAIChatMessage: {
          mac: { combo: 'Enter', enabled: true },
          windows: { combo: 'Enter', enabled: true },
        },
      },
    });
    useStore.getState().replaceGlobalProxy({});

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.shortcutOptions.sendAIChatMessage).toEqual({
      mac: { combo: 'Meta+Enter', enabled: true },
      windows: { combo: 'Enter', enabled: true },
    });
  });

  it('updates an existing custom SQL snippet by id and persists editable syntax help', async () => {
    const { useStore } = await importStore();
    const original = {
      id: 'custom-merge',
      prefix: 'mrg',
      name: 'MERGE INTO',
      description: 'Oracle merge 模板',
      syntaxHelp: '旧说明',
      body: 'MERGE INTO t USING s ON (t.id = s.id)$0',
      isBuiltin: false,
      createdAt: 1710000000000,
    };

    useStore.getState().saveSqlSnippet(original);
    useStore.getState().saveSqlSnippet({
      ...original,
      name: 'MERGE INTO 更新',
      syntaxHelp: '新说明：目标表、数据源、关联字段均可修改',
      body: 'MERGE INTO ${1:目标表} t USING ${2:源表} s ON (${3:关联条件})$0',
    });

    const snippets = useStore.getState().sqlSnippets.filter((s) => s.id === original.id);
    expect(snippets).toHaveLength(1);
    expect(snippets[0]).toMatchObject({
      prefix: 'mrg',
      name: 'MERGE INTO 更新',
      syntaxHelp: '新说明：目标表、数据源、关联字段均可修改',
      body: 'MERGE INTO ${1:目标表} t USING ${2:源表} s ON (${3:关联条件})$0',
      isBuiltin: false,
    });

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    const persistedSnippets = persisted.state.sqlSnippets.filter((s: { id: string }) => s.id === original.id);
    expect(persistedSnippets).toHaveLength(1);
    expect(persistedSnippets[0].syntaxHelp).toBe('新说明：目标表、数据源、关联字段均可修改');
  });

  it('preserves custom SQL snippet body whitespace across reloads', async () => {
    const { useStore } = await importStore();
    const body = 'SELECT ${1:columns} FROM ${2:table_name}\n  ';

    useStore.getState().saveSqlSnippet({
      id: 'custom-trailing-whitespace',
      prefix: 'trail',
      name: 'Trailing whitespace',
      body,
      isBuiltin: false,
      createdAt: 1710000000000,
    });

    expect(useStore.getState().sqlSnippets.find((snippet) => snippet.id === 'custom-trailing-whitespace')?.body)
      .toBe(body);
    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.sqlSnippets.find((snippet: { id: string }) => snippet.id === 'custom-trailing-whitespace')?.body)
      .toBe(body);

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().sqlSnippets.find((snippet) => snippet.id === 'custom-trailing-whitespace')?.body)
      .toBe(body);
  });
});

describe('store persistence hot path', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('reuses the persisted projection across transient state updates', async () => {
    const { useStore } = await importStore();
    const partialize = useStore.persist.getOptions().partialize;
    if (!partialize) {
      throw new Error('expected store partialize option');
    }
    const state = useStore.getState();

    const projections = Array.from({ length: 1_000 }, (_, index) =>
      partialize({
        ...state,
        aiPanelVisible: index % 2 === 0,
        jvmDiagnosticOutputs: {
          [`diagnostic-${index}`]: [],
        },
      }),
    );

    expect(new Set(projections).size).toBe(1);
  });

  it('invalidates the persisted projection when a persisted field changes', async () => {
    const { useStore } = await importStore();
    const partialize = useStore.persist.getOptions().partialize;
    if (!partialize) {
      throw new Error('expected store partialize option');
    }
    const state = useStore.getState();

    const initial = partialize(state) as Partial<typeof state>;
    const transientOnly = partialize({
      ...state,
      aiPanelVisible: !state.aiPanelVisible,
    }) as Partial<typeof state>;
    const changedTheme = partialize({
      ...state,
      theme: state.theme === 'light' ? 'dark' : 'light',
    }) as Partial<typeof state>;

    expect(transientOnly).toBe(initial);
    expect(changedTheme).not.toBe(initial);
    expect(changedTheme.theme).not.toBe(initial.theme);
  });

  it('reuses sanitized query tabs when only the active tab changes', async () => {
    const { useStore } = await importStore();
    const partialize = useStore.persist.getOptions().partialize;
    if (!partialize) {
      throw new Error('expected store partialize option');
    }
    let queryReads = 0;
    const createQueryTab = (id: string) => new Proxy({
      id,
      title: id,
      type: 'query' as const,
      connectionId: 'kingbase-1',
      dbName: 'appdb',
      query: Array.from({ length: 120 }, (_, index) => `SELECT * FROM public.order_${index + 1};`).join('\n'),
    }, {
      get(target, property, receiver) {
        if (property === 'query') queryReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const state = {
      ...useStore.getState(),
      tabs: [createQueryTab('query-1'), createQueryTab('query-2')],
      activeTabId: 'query-1',
    };

    const initial = partialize(state) as Partial<typeof state>;
    queryReads = 0;
    const switched = partialize({
      ...state,
      activeTabId: 'query-2',
    }) as Partial<typeof state>;

    expect(switched).not.toBe(initial);
    expect(switched.tabs).toBe(initial.tabs);
    expect(switched.activeTabId).toBe('query-2');
    expect(queryReads).toBe(0);
  });

  it('invalidates connection projection when legacy secrets appear or disappear', async () => {
    const { useStore } = await importStore();
    const partialize = useStore.persist.getOptions().partialize;
    if (!partialize) {
      throw new Error('expected store partialize option');
    }
    const state = useStore.getState();
    const cleanState = { ...state, connections: [] };

    const cleanProjection = partialize(cleanState) as Partial<typeof state>;
    expect(Object.prototype.hasOwnProperty.call(cleanProjection, 'connections')).toBe(false);

    const legacyConnections = [
      {
        id: 'legacy-secret',
        name: 'Legacy Secret',
        config: {
          id: 'legacy-secret',
          type: 'mysql',
          host: '127.0.0.1',
          port: 3306,
          user: 'root',
          password: 'secret',
        },
      },
    ];
    const legacyProjection = partialize({
      ...cleanState,
      connections: legacyConnections,
    }) as Partial<typeof state>;

    expect(legacyProjection).not.toBe(cleanProjection);
    expect(legacyProjection.connections).toBe(legacyConnections);

    const scrubbedConnections = legacyConnections.map((connection) => ({
      ...connection,
      config: { ...connection.config, password: '' },
    }));
    const scrubbedProjection = partialize({
      ...cleanState,
      connections: scrubbedConnections,
    }) as Partial<typeof state>;

    expect(scrubbedProjection).not.toBe(legacyProjection);
    expect(Object.prototype.hasOwnProperty.call(scrubbedProjection, 'connections')).toBe(false);
  });
});

describe('sidebar database pin persistence', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('persists database pins by connection and database name', async () => {
    const { buildSidebarDatabasePinKey, updateSidebarDatabasePinKeys, useStore } = await importStore();
    const pinKey = buildSidebarDatabasePinKey(' conn-1 ', ' analytics ');

    expect(pinKey).toBe(JSON.stringify(['conn-1', 'analytics']));
    expect(updateSidebarDatabasePinKeys([], 'conn-1', 'analytics', true)).toEqual([pinKey]);
    expect(updateSidebarDatabasePinKeys([pinKey], 'conn-1', 'analytics', true)).toEqual([pinKey]);

    useStore.getState().setSidebarDatabasePinned('conn-1', 'analytics', true);
    expect(useStore.getState().pinnedSidebarDatabases).toEqual([pinKey]);
    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.pinnedSidebarDatabases).toEqual([pinKey]);

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().pinnedSidebarDatabases).toEqual([pinKey]);

    reloaded.useStore.getState().setSidebarDatabasePinned('conn-1', 'analytics', false);
    expect(reloaded.useStore.getState().pinnedSidebarDatabases).toEqual([]);
  });
});

describe('connection type pin persistence', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('persists an ordered and sanitized list of pinned connection types', async () => {
    const { updatePinnedConnectionTypeKeys, useStore } = await importStore();

    expect(updatePinnedConnectionTypeKeys(['mysql'], ' Redis ', true)).toEqual([
      'redis',
      'mysql',
    ]);
    expect(updatePinnedConnectionTypeKeys(['redis', 'mysql'], 'redis', true)).toEqual([
      'redis',
      'mysql',
    ]);
    expect(updatePinnedConnectionTypeKeys(['redis', 'mysql'], '../bad', true)).toEqual([
      'redis',
      'mysql',
    ]);

    useStore.getState().setConnectionTypePinned('mysql', true);
    useStore.getState().setConnectionTypePinned('redis', true);
    expect(useStore.getState().pinnedConnectionTypes).toEqual(['redis', 'mysql']);

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.pinnedConnectionTypes).toEqual(['redis', 'mysql']);

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().pinnedConnectionTypes).toEqual([
      'redis',
      'mysql',
    ]);

    reloaded.useStore.getState().setConnectionTypePinned('redis', false);
    expect(reloaded.useStore.getState().pinnedConnectionTypes).toEqual(['mysql']);
  });
});
