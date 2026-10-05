import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIChatMessage } from './types';
import { buildLegacyTableAccessCountKey, buildTableAccessCountKey } from './utils/tableAccessCount';

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

  it('uses a legacy table access count and migrates it on the next access', async () => {
    const { useStore } = await importStore();
    const legacyKey = buildLegacyTableAccessCountKey('conn', 'main', 'users');
    const currentKey = buildTableAccessCountKey('conn', 'main', 'users');
    useStore.setState({ tableAccessCount: { [legacyKey]: 4 } });

    useStore.getState().recordTableAccess('conn', 'main', 'users');

    expect(useStore.getState().tableAccessCount).toEqual({ [currentKey]: 5 });
  });

  it('cleans deleted connection access counts without matching a longer connection id', async () => {
    const { useStore } = await importStore();
    useStore.getState().replaceConnections(
      ['conn', 'conn-prod'].map((id) => ({
        id,
        name: id,
        config: { id, type: 'mysql', host: `${id}.local`, port: 3306, user: 'root' },
      })),
    );
    useStore.setState({
      tableAccessCount: {
        [buildLegacyTableAccessCountKey('conn', 'main', 'users')]: 3,
        [buildLegacyTableAccessCountKey('conn-prod', 'main', 'orders')]: 5,
      },
    });

    useStore.getState().removeConnection('conn');

    expect(useStore.getState().tableAccessCount).toEqual({
      [buildLegacyTableAccessCountKey('conn-prod', 'main', 'orders')]: 5,
    });
  });

  it('keeps colliding legacy tuples isolated with versioned table access keys', async () => {
    const { useStore } = await importStore();
    useStore.getState().replaceConnections(
      ['conn', 'conn-prod'].map((id) => ({
        id,
        name: id,
        config: { id, type: 'mysql', host: `${id}.local`, port: 3306, user: 'root' },
      })),
    );

    useStore.getState().recordTableAccess('conn', 'prod', 'main-orders');
    useStore.getState().recordTableAccess('conn-prod', 'main', 'orders');
    expect(buildLegacyTableAccessCountKey('conn', 'prod', 'main-orders')).toBe(
      buildLegacyTableAccessCountKey('conn-prod', 'main', 'orders'),
    );
    expect(buildTableAccessCountKey('conn', 'prod', 'main-orders')).not.toBe(
      buildTableAccessCountKey('conn-prod', 'main', 'orders'),
    );

    useStore.getState().removeConnection('conn');

    expect(useStore.getState().tableAccessCount).toEqual({
      [buildTableAccessCountKey('conn-prod', 'main', 'orders')]: 1,
    });
  });

  it('keeps legacy global proxy password during hydration until explicit cleanup', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        globalProxy: {
          enabled: true,
          type: 'http',
          host: '127.0.0.1',
          port: 8080,
          user: 'ops',
          password: 'proxy-secret',
        },
      },
      version: 7,
    }));

    const { useStore } = await importStore();

    expect(useStore.getState().globalProxy.password).toBe('proxy-secret');
    expect(useStore.getState().globalProxy.hasPassword).toBe(true);
  });

  it('persists external SQL directories and keeps distinct connection bindings after reload', async () => {
    const { useStore } = await importStore();

    useStore.getState().saveExternalSQLDirectory({
      id: 'ext-1',
      name: 'scripts',
      path: 'D:/sql/scripts',
      fileBindings: [
        {
          filePath: 'D:\\sql\\scripts\\report.sql',
          connectionId: 'conn-2',
          dbName: 'reporting',
        },
      ],
      createdAt: 1,
    });

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.externalSQLDirectories).toEqual([
      {
        id: 'ext-1',
        name: 'scripts',
        path: 'D:/sql/scripts',
        fileBindings: [
          {
            filePath: 'D:/sql/scripts/report.sql',
            connectionId: 'conn-2',
            dbName: 'reporting',
          },
        ],
        createdAt: 1,
      },
    ]);

    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        externalSQLDirectories: [
          persisted.state.externalSQLDirectories[0],
          {
            id: 'legacy-ext-1',
            name: 'legacy duplicate',
            path: 'D:\\sql\\scripts',
            connectionId: 'conn-1',
            dbName: 'demo',
            createdAt: 2,
          },
          { path: '', name: 'broken' },
        ],
      },
      version: 7,
    }));

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().externalSQLDirectories).toEqual([
      {
        id: 'ext-1',
        name: 'scripts',
        path: 'D:/sql/scripts',
        fileBindings: [
          {
            filePath: 'D:/sql/scripts/report.sql',
            connectionId: 'conn-2',
            dbName: 'reporting',
          },
        ],
        createdAt: 1,
      },
      {
        id: 'legacy-ext-1',
        name: 'legacy duplicate',
        path: 'D:\\sql\\scripts',
        connectionId: 'conn-1',
        dbName: 'demo',
        createdAt: 2,
      },
    ]);
  });

  it('persists an external SQL file binding with an explicitly empty database', async () => {
    const { useStore } = await importStore();

    useStore.getState().saveExternalSQLDirectory({
      id: 'ext-no-db',
      name: 'bootstrap scripts',
      path: 'D:/sql/bootstrap',
      connectionId: 'conn-1',
      dbName: 'orders',
      fileBindings: [{
        filePath: 'D:/sql/bootstrap/create-database.sql',
        connectionId: 'conn-1',
        dbName: '',
      }],
      createdAt: 1,
    });

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.externalSQLDirectories[0].fileBindings).toEqual([{
      filePath: 'D:/sql/bootstrap/create-database.sql',
      connectionId: 'conn-1',
      dbName: '',
    }]);

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().externalSQLDirectories[0].fileBindings).toEqual([{
      filePath: 'D:/sql/bootstrap/create-database.sql',
      connectionId: 'conn-1',
      dbName: '',
    }]);
  });

  it('records recent workbench targets and SQL files with their database binding', async () => {
    const { useStore } = await importStore();

    useStore.getState().addTab({
      id: 'recent-query-1',
      title: 'Orders',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'orders',
      query: 'select * from orders;',
    });
    useStore.getState().addTab({
      id: 'recent-file-1',
      title: 'daily-report.sql',
      type: 'query',
      connectionId: 'conn-2',
      dbName: 'reporting',
      query: 'select 1;',
      filePath: 'D:/sql/reports/daily-report.sql',
    });

    expect(useStore.getState().recentConnectionTargets).toEqual([
      expect.objectContaining({ connectionId: 'conn-2', dbName: 'reporting' }),
      expect.objectContaining({ connectionId: 'conn-1', dbName: 'orders' }),
    ]);
    expect(useStore.getState().recentSQLFiles).toEqual([
      expect.objectContaining({
        connectionId: 'conn-2',
        dbName: 'reporting',
        fileName: 'daily-report.sql',
        filePath: 'D:/sql/reports/daily-report.sql',
      }),
    ]);

    useStore.getState().updateQueryTabDraft('recent-file-1', {
      connectionId: 'conn-3',
      dbName: 'auditing',
    });
    expect(useStore.getState().recentConnectionTargets[0]).toEqual(
      expect.objectContaining({ connectionId: 'conn-3', dbName: 'auditing' }),
    );
    expect(useStore.getState().recentSQLFiles[0]).toEqual(
      expect.objectContaining({
        connectionId: 'conn-3',
        dbName: 'auditing',
        fileName: 'daily-report.sql',
        filePath: 'D:/sql/reports/daily-report.sql',
      }),
    );

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.recentConnectionTargets).toHaveLength(3);
    expect(persisted.state.recentSQLFiles).toHaveLength(2);

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().recentConnectionTargets).toEqual([
      expect.objectContaining({ connectionId: 'conn-3', dbName: 'auditing' }),
      expect.objectContaining({ connectionId: 'conn-2', dbName: 'reporting' }),
      expect.objectContaining({ connectionId: 'conn-1', dbName: 'orders' }),
    ]);
    expect(reloaded.useStore.getState().recentSQLFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        connectionId: 'conn-3',
        dbName: 'auditing',
        fileName: 'daily-report.sql',
      }),
    ]));
  });

  it('keeps recent SQL shortcuts in sync when files or their directories move or are deleted', async () => {
    const { useStore } = await importStore();
    useStore.getState().addTab({
      id: 'recent-file-a',
      title: 'a.sql',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'orders',
      query: 'select 1;',
      filePath: 'D:/sql/reports/a.sql',
    });
    useStore.getState().addTab({
      id: 'recent-file-b',
      title: 'b.sql',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'orders',
      query: 'select 2;',
      filePath: 'D:/sql/reports/nested/b.sql',
    });

    useStore.getState().moveRecentSQLFilesByDirectory('D:/sql/reports', 'D:/sql/archive');
    expect(useStore.getState().recentSQLFiles.map((file) => file.filePath).sort()).toEqual([
      'D:/sql/archive/a.sql',
      'D:/sql/archive/nested/b.sql',
    ]);

    useStore.getState().updateRecentSQLFilePath('D:/sql/archive/a.sql', 'D:/sql/archive/renamed.sql');
    expect(useStore.getState().recentSQLFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: 'D:/sql/archive/renamed.sql', fileName: 'renamed.sql' }),
    ]));

    useStore.getState().removeRecentSQLFilesByPath('D:/sql/archive/renamed.sql');
    expect(useStore.getState().recentSQLFiles).toEqual([
      expect.objectContaining({ filePath: 'D:/sql/archive/nested/b.sql' }),
    ]);
    useStore.getState().removeRecentSQLFilesByDirectory('D:/sql/archive');
    expect(useStore.getState().recentSQLFiles).toEqual([]);
  });

  it('uses localized external SQL directory fallback names without overriding explicit names or path segments', async () => {
    const i18n = await import('./i18n');
    i18n.setCurrentLanguage('de-DE');
    const { useStore } = await importStore();

    useStore.getState().saveExternalSQLDirectory({
      id: 'ext-fallback',
      name: '   ',
      path: '/',
      connectionId: 'conn-1',
      dbName: 'demo',
      createdAt: 1,
    });
    useStore.getState().saveExternalSQLDirectory({
      id: 'ext-segment',
      name: '',
      path: 'D:/sql/reports',
      connectionId: 'conn-1',
      dbName: 'demo',
      createdAt: 2,
    });
    useStore.getState().saveExternalSQLDirectory({
      id: 'ext-explicit',
      name: 'Handwritten scripts',
      path: 'D:/sql/handwritten',
      connectionId: 'conn-1',
      dbName: 'demo',
      createdAt: 3,
    });

    expect(useStore.getState().externalSQLDirectories.map((directory) => directory.name)).toEqual([
      i18n.t('sidebar.sql_directory.default_name'),
      'reports',
      'Handwritten scripts',
    ]);

    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        externalSQLDirectories: [
          {
            id: 'ext-reloaded-fallback',
            name: '',
            path: '/',
            connectionId: 'conn-2',
            dbName: 'demo2',
            createdAt: 4,
          },
          {
            id: 'ext-reloaded-segment',
            name: '  ',
            path: 'D:/sql/migrations',
            connectionId: 'conn-2',
            dbName: 'demo2',
            createdAt: 5,
          },
        ],
      },
      version: 10,
    }));

    vi.resetModules();
    const reloadedI18n = await import('./i18n');
    reloadedI18n.setCurrentLanguage('ja-JP');
    const reloaded = await importStore();

    expect(reloaded.useStore.getState().externalSQLDirectories.map((directory) => directory.name)).toEqual([
      reloadedI18n.t('sidebar.sql_directory.default_name'),
      'migrations',
    ]);
  });

  it('uses localized store fallback names when restoring persisted records', async () => {
    const i18n = await import('./i18n');
    i18n.setCurrentLanguage('en-US');
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        connectionTags: [
          {
            id: 'tag-empty-name',
            name: '   ',
            connectionIds: [],
          },
        ],
        sqlSnippets: [
          {
            id: 'snippet-empty-name',
            prefix: 'demo',
            name: '   ',
            body: 'select 1;',
            isBuiltin: false,
            createdAt: 1,
          },
        ],
        tabs: [
          {
            id: 'query-empty-title',
            title: '   ',
            type: 'query',
            query: 'select 1;',
          },
        ],
        tableExportHistories: {
          'conn-1::main::users': [
            {
              jobId: 'job-1',
              targetName: '   ',
              startedAt: 1,
              finishedAt: 2,
              format: 'csv',
              scope: 'table',
              scopeLabel: 'Table',
              strategyLabel: 'Export',
              status: 'done',
              stage: '',
              current: 0,
              total: 0,
              totalRowsKnown: false,
              filePath: '',
              message: '',
            },
          ],
        },
        activeTabId: 'query-empty-title',
      },
      version: 11,
    }));

    vi.resetModules();
    const reloadedI18n = await import('./i18n');
    reloadedI18n.setCurrentLanguage('en-US');
    const reloaded = await importStore();

    expect(reloaded.useStore.getState().connectionTags[0]?.name).toBe(
      reloadedI18n.t('store.fallback.connection_tag_name', { index: 1 }),
    );
    expect(reloaded.useStore.getState().sqlSnippets[0]?.name).toBe(
      reloadedI18n.t('store.fallback.sql_snippet_name', { index: 1 }),
    );
    expect(reloaded.useStore.getState().tabs[0]?.title).toBe(
      reloadedI18n.t('sidebar.tab.new_query'),
    );
    expect(
      reloaded.useStore.getState().tableExportHistories['conn-1::main::users']?.[0]?.targetName,
    ).toBe(
      reloadedI18n.t('data_export.progress.value.target_fallback'),
    );
  });

  it('uses localized AI session fallback titles for non-user first messages', async () => {
    vi.useFakeTimers();
    try {
      const i18n = await import('./i18n');
      i18n.setCurrentLanguage('ja-JP');
      const { useStore } = await importStore();

      useStore.getState().addAIChatMessage('assistant-first', {
        id: 'message-1',
        role: 'assistant',
        content: '',
        timestamp: 1,
      });

      expect(useStore.getState().aiChatSessions[0]?.title).toBe(
        i18n.t('ai_chat.panel.session.default_title'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps streaming-only AI message patches from reordering the session list', async () => {
    vi.useFakeTimers();
    try {
      const { useStore } = await importStore();
      useStore.setState({
        aiChatSessions: [
          { id: 'session-other', title: 'other', updatedAt: 20 },
          { id: 'session-stream', title: 'stream', updatedAt: 10 },
        ],
        aiChatHistory: {
          'session-stream': [
            {
              id: 'assistant-1',
              role: 'assistant',
              phase: 'connecting',
              content: '',
              timestamp: 1,
              loading: true,
            },
          ],
        },
      });

      const sessionsBeforeStreamingPatch = useStore.getState().aiChatSessions;
      useStore.getState().updateAIChatMessage('session-stream', 'assistant-1', {
        thinking: 'planning',
        phase: 'thinking',
      });

      expect(useStore.getState().aiChatSessions).toBe(sessionsBeforeStreamingPatch);
      expect(useStore.getState().aiChatSessions.map((session) => session.id)).toEqual([
        'session-other',
        'session-stream',
      ]);

      useStore.getState().updateAIChatMessage('session-stream', 'assistant-1', {
        loading: false,
        phase: 'idle',
      });

      expect(useStore.getState().aiChatSessions.map((session) => session.id)).toEqual([
        'session-stream',
        'session-other',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('finds the newest streaming message without scanning the full session history', async () => {
    vi.useFakeTimers();
    try {
      const { useStore } = await importStore();
      let messageIdReads = 0;
      const messages = Array.from({ length: 500 }, (_, index): AIChatMessage => ({
        id: `message-${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `content-${index}`,
        timestamp: index,
      })).map((message) => new Proxy(message, {
        get(target, property, receiver) {
          if (property === 'id') {
            messageIdReads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      }));
      useStore.setState({
        aiChatHistory: { 'session-stream': messages },
      });
      messageIdReads = 0;

      useStore.getState().updateAIChatMessage('session-stream', 'message-499', {
        content: 'content-499-next-token',
      });

      expect(messageIdReads).toBeLessThanOrEqual(2);
      expect(useStore.getState().aiChatHistory['session-stream'][499]?.content).toBe(
        'content-499-next-token',
      );
      expect(useStore.getState().aiChatHistory['session-stream'][0]).toBe(messages[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists open query tab drafts and restores them after reload', async () => {
    const { useStore } = await importStore();

    useStore.getState().addTab({
      id: 'query-tab-1',
      title: '临时 SQL',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
      query: 'select * from users where id = 1;',
    });
    useStore.getState().updateQueryTabDraft('query-tab-1', {
      query: 'select * from orders where status = "paid";',
      connectionId: 'conn-2',
      dbName: 'reporting',
      schemaName: 'sales',
      formatRestoreSnapshot: {
        query: 'select * from orders where status="paid";',
        createdAt: 123,
      },
    });

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.tabs).toEqual([
      expect.objectContaining({
        id: 'query-tab-1',
        title: '临时 SQL',
        type: 'query',
        connectionId: 'conn-2',
        dbName: 'reporting',
        schemaName: 'sales',
        query: 'select * from orders where status = "paid";',
        formatRestoreSnapshot: {
          query: 'select * from orders where status="paid";',
          createdAt: 123,
        },
      }),
    ]);
    expect(persisted.state.activeTabId).toBe('query-tab-1');

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().tabs).toEqual([
      expect.objectContaining({
        id: 'query-tab-1',
        type: 'query',
        connectionId: 'conn-2',
        dbName: 'reporting',
        schemaName: 'sales',
        query: 'select * from orders where status = "paid";',
        formatRestoreSnapshot: {
          query: 'select * from orders where status="paid";',
          createdAt: 123,
        },
      }),
    ]);
    expect(reloaded.useStore.getState().activeTabId).toBe('query-tab-1');

    reloaded.useStore.getState().updateQueryTabDraft('query-tab-1', {
      formatRestoreSnapshot: undefined,
    });

    expect(reloaded.useStore.getState().tabs[0].formatRestoreSnapshot).toBeUndefined();
  });

  it('updates activeContext, including the selected table, when switching between tabs', async () => {
    const { useStore } = await importStore();

    useStore.getState().addTab({
      id: 'table-main',
      title: 'users',
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'sys',
      tableName: 'users',
    });
    expect(useStore.getState().activeContext).toEqual({
      connectionId: 'conn-1',
      dbName: 'sys',
      tableName: 'users',
    });

    useStore.getState().addTab({
      id: 'query-bot',
      title: '新建查询',
      type: 'query',
      connectionId: 'conn-2',
      dbName: 'missav_bot',
      query: 'select 1;',
    });
    expect(useStore.getState().activeContext).toEqual({
      connectionId: 'conn-2',
      dbName: 'missav_bot',
    });

    useStore.getState().setActiveTab('table-main');
    expect(useStore.getState().activeTabId).toBe('table-main');
    expect(useStore.getState().activeContext).toEqual({
      connectionId: 'conn-1',
      dbName: 'sys',
      tableName: 'users',
    });
  });

  it('keeps query schema in activeContext and does not let an inactive draft overwrite it', async () => {
    const { useStore } = await importStore();

    useStore.getState().addTab({
      id: 'query-anno',
      title: '新建查询',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'sys',
      schemaName: 'anno',
      query: 'select 1;',
    });

    expect(useStore.getState().activeContext).toEqual({
      connectionId: 'conn-1',
      dbName: 'sys',
      schemaName: 'anno',
    });

    useStore.getState().addTab({
      id: 'query-old-schema',
      title: '旧查询',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'sys',
      schemaName: 'dbms_job',
      query: 'select 2;',
    });
    useStore.getState().setActiveTab('query-anno');

    useStore.getState().updateQueryTabDraft('query-old-schema', {
      schemaName: 'dbms_job_v2',
    });

    expect(useStore.getState().activeContext).toEqual({
      connectionId: 'conn-1',
      dbName: 'sys',
      schemaName: 'anno',
    });
  });

  it('falls back activeContext to the new active tab after closing the current tab', async () => {
    const { useStore } = await importStore();

    useStore.getState().addTab({
      id: 'query-sys',
      title: '新建查询',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'sys',
      query: 'select 1;',
    });
    useStore.getState().addTab({
      id: 'query-bot',
      title: '新建查询',
      type: 'query',
      connectionId: 'conn-2',
      dbName: 'missav_bot',
      query: 'select 2;',
    });

    expect(useStore.getState().activeTabId).toBe('query-bot');
    expect(useStore.getState().activeContext).toEqual({
      connectionId: 'conn-2',
      dbName: 'missav_bot',
    });

    useStore.getState().closeTab('query-bot');

    expect(useStore.getState().activeTabId).toBe('query-sys');
    expect(useStore.getState().activeContext).toEqual({
      connectionId: 'conn-1',
      dbName: 'sys',
    });
  });

  it('detaches and restores workbench tabs as floating windows', async () => {
    const { useStore } = await importStore();

    useStore.getState().addTab({
      id: 'table-users',
      title: 'users',
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'sys',
      tableName: 'users',
    });
    useStore.getState().addTab({
      id: 'query-1',
      title: '新建查询',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'sys',
      query: 'select 1;',
    });

    useStore.getState().detachWorkbenchTab('table-users', { x: 80, y: 90, width: 800, height: 500 });
    expect(useStore.getState().isWorkbenchTabDetached('table-users')).toBe(true);
    expect(useStore.getState().detachedWorkbenchWindows).toEqual([
      expect.objectContaining({
        tabId: 'table-users',
        x: 80,
        y: 90,
        width: 800,
        height: 500,
      }),
    ]);
    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual(['table-users', 'query-1']);

    useStore.getState().attachWorkbenchTab('table-users');
    expect(useStore.getState().isWorkbenchTabDetached('table-users')).toBe(false);
    expect(useStore.getState().detachedWorkbenchWindows).toEqual([]);
    expect(useStore.getState().activeTabId).toBe('table-users');

    useStore.getState().detachWorkbenchTab('table-users');
    useStore.getState().closeTab('table-users');
    expect(useStore.getState().detachedWorkbenchWindows).toEqual([]);
    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual(['query-1']);
  });

  it('detaches and restores query result floating windows', async () => {
    const { useStore } = await importStore();

    useStore.getState().detachQueryResultWindow({
      id: 'query-result:tab-1:rs-1',
      sourceQueryTabId: 'tab-1',
      connectionId: 'conn-1',
      dbName: 'sys',
      title: '结果 1',
      result: {
        key: 'rs-1',
        sql: 'select 1',
        rows: [{ a: 1 }],
        columns: ['a'],
        pkColumns: [],
        readOnly: true,
      },
    });
    expect(useStore.getState().detachedQueryResultWindows).toHaveLength(1);

    const restored = useStore.getState().attachQueryResultWindow('query-result:tab-1:rs-1');
    expect(restored?.result.key).toBe('rs-1');
    expect(useStore.getState().detachedQueryResultWindows).toEqual([]);
  });

  it('detaches AI chat panel into a floating window and docks it back', async () => {
    const { useStore } = await importStore();

    useStore.getState().setAIPanelVisible(true);
    useStore.getState().detachAIChatPanel({ x: 40, y: 50, width: 420, height: 640 });
    expect(useStore.getState().isAIChatDetached()).toBe(true);
    expect(useStore.getState().aiPanelVisible).toBe(true);
    const detached = useStore.getState().detachedAIChatWindow;
    expect(detached).toBeTruthy();
    expect(detached?.width).toBe(420);
    expect(detached?.height).toBe(640);
    expect(detached?.x).toBeGreaterThanOrEqual(16);
    expect(detached?.y).toBeGreaterThanOrEqual(16);
    expect(detached?.zIndex).toBeGreaterThan(0);

    // 使用可落入默认/无 DOM 视口上限的尺寸，避免 createDefaultDetachedBounds clamp 干扰断言
    useStore.getState().updateDetachedAIChatBounds({ width: 500, height: 560 });
    expect(useStore.getState().detachedAIChatWindow?.width).toBe(500);
    expect(useStore.getState().detachedAIChatWindow?.height).toBe(560);
    expect(useStore.getState().aiChatDetachedBoundsMemory?.width).toBe(500);
    expect(useStore.getState().aiChatDetachedBoundsMemory?.height).toBe(560);

    useStore.getState().attachAIChatPanel();
    expect(useStore.getState().isAIChatDetached()).toBe(false);
    expect(useStore.getState().detachedAIChatWindow).toBeNull();
    expect(useStore.getState().aiPanelVisible).toBe(true);
    // 还原侧栏后仍保留上次尺寸记忆
    expect(useStore.getState().aiChatDetachedBoundsMemory?.width).toBe(500);
    expect(useStore.getState().aiChatDetachedBoundsMemory?.height).toBe(560);

    // 再次弹出应复用记忆尺寸
    useStore.getState().detachAIChatPanel();
    expect(useStore.getState().detachedAIChatWindow?.width).toBe(500);
    expect(useStore.getState().detachedAIChatWindow?.height).toBe(560);

    useStore.getState().setAIPanelVisible(false);
    expect(useStore.getState().detachedAIChatWindow).toEqual(expect.objectContaining({
      width: 500,
      height: 560,
    }));
    expect(useStore.getState().isAIChatDetached()).toBe(true);
    expect(useStore.getState().aiPanelVisible).toBe(false);
    expect(useStore.getState().aiChatDetachedBoundsMemory?.width).toBe(500);

    useStore.getState().setAIChatOpenMode('detached');
    useStore.getState().setAIPanelVisible(true);
    expect(useStore.getState().aiPanelVisible).toBe(true);
    expect(useStore.getState().detachedAIChatWindow).toEqual(expect.objectContaining({
      width: 500,
      height: 560,
    }));
  });

  it('opens AI chat according to the configured default open mode', async () => {
    const { useStore } = await importStore();

    expect(useStore.getState().aiChatOpenMode).toBe('dock');
    useStore.getState().setAIPanelVisible(true);
    expect(useStore.getState().aiPanelVisible).toBe(true);
    expect(useStore.getState().detachedAIChatWindow).toBeNull();

    useStore.getState().setAIPanelVisible(false);
    useStore.getState().setAIChatOpenMode('detached');
    expect(useStore.getState().aiChatOpenMode).toBe('detached');

    useStore.getState().setAIPanelVisible(true);
    expect(useStore.getState().aiPanelVisible).toBe(true);
    expect(useStore.getState().isAIChatDetached()).toBe(true);
    expect(useStore.getState().detachedAIChatWindow).toBeTruthy();

    // 手动还原到侧栏不改变默认打开偏好
    useStore.getState().attachAIChatPanel();
    expect(useStore.getState().isAIChatDetached()).toBe(false);
    expect(useStore.getState().aiChatOpenMode).toBe('detached');

    // 再次从入口打开仍按默认偏好弹出独立窗
    useStore.getState().setAIPanelVisible(false);
    useStore.getState().toggleAIPanel();
    expect(useStore.getState().isAIChatDetached()).toBe(true);

    useStore.getState().setAIChatOpenMode('dock');
    useStore.getState().setAIPanelVisible(false);
    useStore.getState().setAIPanelVisible(true);
    expect(useStore.getState().detachedAIChatWindow).toBeNull();
    expect(useStore.getState().aiPanelVisible).toBe(true);
  });

  it('returns to the source tab after closing an object edit tab opened from a hyperlink', async () => {
    const { useStore } = await importStore();

    useStore.getState().addTab({
      id: 'query-source',
      title: '查询 1',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'sys',
      query: 'select * from users;',
    });
    useStore.getState().addTab({
      id: 'query-other-1',
      title: '查询 2',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'sys',
      query: 'select 2;',
    });
    useStore.getState().addTab({
      id: 'query-other-2',
      title: '查询 3',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'sys',
      query: 'select 3;',
    });
    useStore.getState().setActiveTab('query-source');
    useStore.getState().addTab({
      id: 'query-edit-object',
      title: '修改对象',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'sys',
      query: 'CREATE OR REPLACE VIEW users_view AS SELECT * FROM users;',
      queryMode: 'object-edit',
      returnToTabId: 'query-source',
    });

    expect(useStore.getState().activeTabId).toBe('query-edit-object');

    useStore.getState().closeTab('query-edit-object');

    expect(useStore.getState().activeTabId).toBe('query-source');
    expect(useStore.getState().activeContext).toEqual({
      connectionId: 'conn-1',
      dbName: 'sys',
    });
  });

  it('keeps the existing close fallback when the object edit source tab is gone', async () => {
    const { useStore } = await importStore();

    useStore.getState().addTab({
      id: 'query-source',
      title: '查询 1',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'sys',
      query: 'select 1;',
    });
    useStore.getState().addTab({
      id: 'query-other',
      title: '查询 2',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'sys',
      query: 'select 2;',
    });
    useStore.getState().addTab({
      id: 'query-edit-object',
      title: '修改对象',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'sys',
      query: 'CREATE OR REPLACE VIEW users_view AS SELECT 1;',
      queryMode: 'object-edit',
      returnToTabId: 'query-source',
    });
    useStore.getState().closeTab('query-source');
    useStore.getState().setActiveTab('query-edit-object');

    useStore.getState().closeTab('query-edit-object');

    expect(useStore.getState().activeTabId).toBe('query-other');
  });

  it('restores object-edit identity fields so sidebar locating survives a reload', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        tabs: [
          {
            id: 'query-edit-routine-1',
            title: '修改函数/存储过程: main.func_name',
            type: 'query',
            connectionId: 'conn-1',
            dbName: 'example',
            schemaName: 'main',
            query: 'CREATE OR REPLACE MACRO main.func_name(param1) AS (param1 * 3);',
            queryMode: 'object-edit',
            routineName: 'main.func_name',
            routineType: 'MACRO',
            sidebarLocateKey: 'conn-1-example-routine-func-main.func_name',
            returnToTabId: 'query-source',
          },
          {
            id: 'query-edit-mview-1',
            title: '修改物化视图: analytics.mv_daily',
            type: 'query',
            connectionId: 'conn-1',
            dbName: 'example',
            query: 'SELECT 1;',
            queryMode: 'object-edit',
            viewName: 'analytics.mv_daily',
            viewKind: 'materialized',
            objectType: 'materialized-view',
          },
          {
            id: 'query-plain-1',
            title: '普通查询',
            type: 'query',
            connectionId: 'conn-1',
            dbName: 'main',
            query: 'SELECT 1;',
            routineName: 'should.not.leak',
            queryMode: 'standard',
          },
        ],
      },
      version: 21,
    }));

    const { useStore } = await importStore();
    const tabs = useStore.getState().tabs;

    const routineTab = tabs.find((tab) => tab.id === 'query-edit-routine-1');
    expect(routineTab).toEqual(expect.objectContaining({
      queryMode: 'object-edit',
      routineName: 'main.func_name',
      routineType: 'MACRO',
      schemaName: 'main',
      sidebarLocateKey: 'conn-1-example-routine-func-main.func_name',
      returnToTabId: 'query-source',
    }));

    const materializedViewTab = tabs.find((tab) => tab.id === 'query-edit-mview-1');
    expect(materializedViewTab).toEqual(expect.objectContaining({
      queryMode: 'object-edit',
      viewName: 'analytics.mv_daily',
      viewKind: 'materialized',
      objectType: 'materialized-view',
    }));

    const plainTab = tabs.find((tab) => tab.id === 'query-plain-1');
    expect(plainTab?.queryMode).toBeUndefined();
    expect(plainTab?.routineName).toBeUndefined();
  });

  it('reuses the current tab when the same id is reopened as an object-edit query', async () => {
    const { useStore } = await importStore();

    useStore.getState().addTab({
      id: 'routine-def-conn-1-main-reporting.refresh_stats',
      title: '函数: reporting.refresh_stats',
      type: 'routine-def',
      connectionId: 'conn-1',
      dbName: 'main',
      routineName: 'reporting.refresh_stats',
      routineType: 'FUNCTION',
    });

    useStore.getState().addTab({
      id: 'routine-def-conn-1-main-reporting.refresh_stats',
      title: '修改函数/存储过程: reporting.refresh_stats',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
      query: 'CREATE OR REPLACE FUNCTION reporting.refresh_stats() RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql;',
      queryMode: 'object-edit',
    });

    const { tabs, activeTabId } = useStore.getState();
    expect(tabs).toHaveLength(1);
    expect(activeTabId).toBe('routine-def-conn-1-main-reporting.refresh_stats');
    expect(tabs[0]).toEqual(expect.objectContaining({
      id: 'routine-def-conn-1-main-reporting.refresh_stats',
      type: 'query',
      queryMode: 'object-edit',
      title: '修改函数/存储过程: reporting.refresh_stats',
      query: expect.stringContaining('CREATE OR REPLACE FUNCTION reporting.refresh_stats()'),
    }));
  });

  it('keeps saved-query source and copy tabs distinct when reopening the source', async () => {
    const { useStore } = await importStore();

    useStore.getState().addTab({
      id: 'saved-source',
      title: '原查询',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
      query: 'select 1;',
      savedQueryId: 'saved-source',
    });
    useStore.getState().addTab({
      id: 'saved-copy',
      title: '查询副本',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
      query: 'select 9;',
      savedQueryId: 'saved-copy',
    });

    expect(useStore.getState().tabs).toHaveLength(2);
    expect(useStore.getState().activeTabId).toBe('saved-copy');

    useStore.getState().addTab({
      id: 'saved-source',
      title: '原查询',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
      query: 'select 1; -- reloaded',
      savedQueryId: 'saved-source',
    });

    expect(useStore.getState().tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'saved-source',
        savedQueryId: 'saved-source',
        query: 'select 1; -- reloaded',
      }),
      expect.objectContaining({
        id: 'saved-copy',
        savedQueryId: 'saved-copy',
        query: 'select 9;',
      }),
    ]));
    expect(useStore.getState().activeTabId).toBe('saved-source');
  });
});
