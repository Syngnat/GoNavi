import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIDEBAR_RESIZE_MAX_WIDTH } from './utils/sidebarLayout';
import type { AIChatMessage } from './types';
import {
  buildLegacyTableAccessCountKey,
  buildTableAccessCountKey,
  MAX_TABLE_ACCESS_COUNT_ENTRIES,
} from './utils/tableAccessCount';
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

  it('fills missing DataGrid appearance settings with defaults during hydration', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        appearance: {
          enabled: false,
          opacity: 0.75,
          blur: 6,
          useNativeMacWindowControls: true,
        },
      },
      version: 7,
    }));

    const { useStore } = await importStore();
    const appearance = useStore.getState().appearance;

    expect(appearance.uiVersion).toBe('v2');
    expect(appearance.enabled).toBe(false);
    expect(appearance.opacity).toBe(0.75);
    expect(appearance.blur).toBe(6);
    expect(appearance).not.toHaveProperty('useNativeMacWindowControls');
    expect(appearance.tableDoubleClickAction).toBe('open-data');
    expect(appearance.v2SidebarSearchMode).toBe('command');
    expect(appearance.v2CommandSearchPersistentFilterEnabled).toBe(false);
    expect(appearance.v2SidebarPersistedFilter).toBe('');
    expect(appearance.v2SidebarRailScale).toBe(1);
    expect(appearance.sidebarSingleDatabaseExpansion).toBe(false);
    expect(appearance.sidebarHiddenObjectGroups).toEqual([]);
    expect(appearance.showDataTableVerticalBorders).toBe(false);
    expect(appearance.showDataTableRowNumber).toBe(true);
    expect(appearance.dataTableDensity).toBe('comfortable');
    expect(appearance.dataTableFontSize).toBeNull();
    expect(appearance.dataTableFontSizeFollowGlobal).toBe(true);
    expect(appearance.sqlEditorFontSize).toBeNull();
    expect(appearance.sqlEditorFontSizeFollowGlobal).toBe(true);
    expect(appearance.sidebarTreeFontSize).toBeNull();
    expect(appearance.sidebarTreeFontSizeFollowGlobal).toBe(true);
    expect(appearance.customUIFontFamily).toBeNull();
    expect(appearance.customMonoFontFamily).toBeNull();
    expect(appearance.newQuerySqlTemplate).toBeNull();
    expect(appearance.tabDisplay).toEqual({
      layout: 'double',
      primaryElements: ['object'],
      secondaryElements: ['kind', 'connection', 'database'],
    });
  });

  it('migrates the previous tab display default without overwriting custom settings', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        appearance: {
          tabDisplay: {
            layout: 'single',
            primaryElements: ['connection', 'kind', 'object'],
            secondaryElements: [],
          },
        },
      },
      version: 19,
    }));

    const migrated = await importStore();
    expect(migrated.useStore.getState().appearance.tabDisplay).toEqual({
      layout: 'double',
      primaryElements: ['object'],
      secondaryElements: ['kind', 'connection', 'database'],
    });
    expect(JSON.parse(storage.getItem('lite-db-storage') || '{}').version).toBe(20);

    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        appearance: {
          tabDisplay: {
            layout: 'single',
            primaryElements: ['connection', 'kind', 'object'],
            secondaryElements: [],
            double: {
              primaryElements: ['object', 'host'],
              secondaryElements: ['kind', 'connection'],
            },
          },
        },
      },
      version: 19,
    }));
    vi.resetModules();

    const customized = await importStore();
    expect(customized.useStore.getState().appearance.tabDisplay).toEqual({
      layout: 'single',
      primaryElements: ['connection', 'kind', 'object'],
      secondaryElements: [],
      double: {
        primaryElements: ['object', 'host'],
        secondaryElements: ['kind', 'connection'],
      },
    });
  });

  it('migrates the coupled data-table font into an independent SQL editor font', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        appearance: {
          uiVersion: 'v2',
          dataTableFontSize: 18,
          dataTableFontSizeFollowGlobal: false,
        },
      },
      version: 18,
    }));

    const { useStore } = await importStore();
    const appearance = useStore.getState().appearance;

    expect(appearance.dataTableFontSize).toBe(18);
    expect(appearance.dataTableFontSizeFollowGlobal).toBe(false);
    expect(appearance.sqlEditorFontSize).toBe(17);
    expect(appearance.sqlEditorFontSizeFollowGlobal).toBe(false);

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.version).toBe(20);
    expect(persisted.state.appearance.sqlEditorFontSize).toBe(17);
    expect(persisted.state.appearance.sqlEditorFontSizeFollowGlobal).toBe(false);
  });

  it('migrates an existing legacy UI selection to V2', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        appearance: {
          uiVersion: 'legacy',
        },
      },
      version: 13,
    }));

    const { useStore } = await importStore();
    expect(useStore.getState().appearance.uiVersion).toBe('v2');

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.version).toBe(20);
    expect(persisted.state.appearance.uiVersion).toBe('v2');
  });

  it('keeps a legacy UI selection made after the V2 migration', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        appearance: {
          uiVersion: 'legacy',
        },
      },
      version: 14,
    }));

    const { useStore } = await importStore();
    expect(useStore.getState().appearance.uiVersion).toBe('legacy');
  });

  it('persists DataGrid appearance settings and restores them after reload', async () => {
    const { useStore } = await importStore();

    useStore.getState().setAppearance({
      showDataTableVerticalBorders: true,
      showDataTableRowNumber: false,
      dataTableDensity: 'compact',
      tableDoubleClickAction: 'open-design',
      v2SidebarRailScale: 1.55,
      sidebarSingleDatabaseExpansion: true,
    });

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.appearance.showDataTableVerticalBorders).toBe(true);
    expect(persisted.state.appearance.showDataTableRowNumber).toBe(false);
    expect(persisted.state.appearance.dataTableDensity).toBe('compact');
    expect(persisted.state.appearance.tableDoubleClickAction).toBe('open-design');
    expect(persisted.state.appearance.v2SidebarRailScale).toBe(1.55);
    expect(persisted.state.appearance.sidebarSingleDatabaseExpansion).toBe(true);

    vi.resetModules();
    const reloaded = await importStore();
    const appearance = reloaded.useStore.getState().appearance;

    expect(appearance.showDataTableVerticalBorders).toBe(true);
    expect(appearance.showDataTableRowNumber).toBe(false);
    expect(appearance.dataTableDensity).toBe('compact');
    expect(appearance.tableDoubleClickAction).toBe('open-design');
    expect(appearance.v2SidebarRailScale).toBe(1.55);
    expect(appearance.sidebarSingleDatabaseExpansion).toBe(true);
  });

  it('persists and sanitizes hidden sidebar object groups', async () => {
    const { useStore } = await importStore();

    useStore.getState().setAppearance({
      sidebarHiddenObjectGroups: ['views', 'routines', 'views'],
    });

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.appearance.sidebarHiddenObjectGroups).toEqual(['views', 'routines']);

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().appearance.sidebarHiddenObjectGroups).toEqual(['views', 'routines']);

    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        appearance: {
          sidebarHiddenObjectGroups: ['tables', 'unknown', 'tables', 1],
        },
      },
      version: 16,
    }));
    vi.resetModules();
    const sanitized = await importStore();
    expect(sanitized.useStore.getState().appearance.sidebarHiddenObjectGroups).toEqual(['tables']);
  });

  it('migrates legacy sidebar table comment settings into metadata fields and persists explicit selections', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        queryOptions: {
          showSidebarTableComment: true,
        },
      },
      version: 13,
    }));

    const { useStore } = await importStore();
    expect(useStore.getState().queryOptions.sidebarTableMetadataFields).toEqual(['comment', 'rows']);
    expect(useStore.getState().queryOptions.showSidebarTableComment).toBe(true);

    useStore.getState().setQueryOptions({
      sidebarTableMetadataFields: ['size', 'updatedAt'],
      sidebarTableMetadataFieldOrder: ['updatedAt', 'size', 'rows', 'comment', 'createdAt'],
    });

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.queryOptions.sidebarTableMetadataFields).toEqual(['updatedAt', 'size']);
    expect(persisted.state.queryOptions.sidebarTableMetadataFieldOrder).toEqual([
      'updatedAt',
      'size',
      'rows',
      'comment',
      'createdAt',
    ]);
    expect(persisted.state.queryOptions.showSidebarTableComment).toBe(false);
  });

  it('persists the SQL editor word-wrap preference with a disabled default', async () => {
    const { useStore } = await importStore();
    expect(useStore.getState().queryOptions.wordWrap).toBe(false);

    useStore.getState().setQueryOptions({ wordWrap: true });
    expect(useStore.getState().queryOptions.wordWrap).toBe(true);

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.queryOptions.wordWrap).toBe(true);

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().queryOptions.wordWrap).toBe(true);
  });

  it('persists zero as the unlimited SQL query row limit', async () => {
    const { useStore } = await importStore();

    useStore.getState().setQueryOptions({ maxRows: 0 });
    expect(useStore.getState().queryOptions.maxRows).toBe(0);

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.queryOptions.maxRows).toBe(0);

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().queryOptions.maxRows).toBe(0);

    reloaded.useStore.getState().setQueryOptions({ maxRows: -1 });
    expect(reloaded.useStore.getState().queryOptions.maxRows).toBe(5000);
  });

  it('persists the table overview view mode across store reloads', async () => {
    const { useStore } = await importStore();
    expect(useStore.getState().queryOptions.tableOverviewViewMode).toBeUndefined();

    useStore.getState().setQueryOptions({ tableOverviewViewMode: 'table' });
    expect(useStore.getState().queryOptions.tableOverviewViewMode).toBe('table');

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.queryOptions.tableOverviewViewMode).toBe('table');

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().queryOptions.tableOverviewViewMode).toBe('table');

    storage.setItem('lite-db-storage', JSON.stringify({
      state: { queryOptions: { tableOverviewViewMode: 'invalid' } },
      version: 18,
    }));
    vi.resetModules();
    const sanitized = await importStore();
    expect(sanitized.useStore.getState().queryOptions.tableOverviewViewMode).toBeUndefined();
  });

  it('restores query tabs from crash-recovery snapshots even when persisted tabs are missing', async () => {
    storage.setItem('gonavi-query-tab-drafts-v1', JSON.stringify([
      {
        tabId: 'query-recovery-1',
        title: '异常恢复 SQL',
        query: 'select 1;',
        connectionId: 'conn-1',
        dbName: 'main',
        updatedAt: 1719655200000,
      },
    ]));
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        theme: 'dark',
      },
      version: 13,
    }));

    const { useStore } = await importStore();
    const tabs = useStore.getState().tabs;

    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      id: 'query-recovery-1',
      title: '异常恢复 SQL',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
      query: 'select 1;',
    });
    expect(useStore.getState().activeTabId).toBe('query-recovery-1');
  });

  it('sanitizes invalid table double-click appearance settings', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        appearance: {
          tableDoubleClickAction: 'open-random',
        },
      },
      version: 10,
    }));

    const { useStore } = await importStore();
    expect(useStore.getState().appearance.tableDoubleClickAction).toBe('open-data');
  });

  it('sanitizes persisted v2 sidebar rail scale settings into the supported range', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        appearance: {
          v2SidebarRailScale: 99,
        },
      },
      version: 13,
    }));

    const { useStore } = await importStore();
    expect(useStore.getState().appearance.v2SidebarRailScale).toBe(1);
  });

  it('persists language preference and sanitizes unsupported persisted values', async () => {
    const { useStore } = await importStore();

    expect(useStore.getState().languagePreference).toBe('system');

    useStore.getState().setLanguagePreference('ja-JP');
    expect(useStore.getState().languagePreference).toBe('ja-JP');

    let persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.languagePreference).toBe('ja-JP');

    vi.resetModules();
    let reloaded = await importStore();
    expect(reloaded.useStore.getState().languagePreference).toBe('ja-JP');

    reloaded.useStore.getState().setLanguagePreference('system');
    expect(reloaded.useStore.getState().languagePreference).toBe('system');

    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        languagePreference: 'fr-FR',
      },
      version: 10,
    }));

    vi.resetModules();
    reloaded = await importStore();
    expect(reloaded.useStore.getState().languagePreference).toBe('system');

    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        languagePreference: 'zh-CN',
      },
      version: 10,
    }));

    vi.resetModules();
    reloaded = await importStore();
    expect(reloaded.useStore.getState().languagePreference).toBe('zh-CN');
  });

  it('persists theme preference and falls back to the resolved theme when missing', async () => {
    const { useStore } = await importStore();

    useStore.getState().setThemePreference('system');
    let persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.themePreference).toBe('system');

    vi.resetModules();
    let reloaded = await importStore();
    expect(reloaded.useStore.getState().themePreference).toBe('system');

    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        theme: 'dark',
      },
      version: 13,
    }));

    vi.resetModules();
    reloaded = await importStore();
    expect(reloaded.useStore.getState().themePreference).toBe('dark');
  });

  it('persists custom font families and sanitizes blank values', async () => {
    const { useStore } = await importStore();

    useStore.getState().setAppearance({
      customUIFontFamily: '  IBM Plex Sans, PingFang SC  ',
      customMonoFontFamily: '   ',
    });

    let appearance = useStore.getState().appearance;
    expect(appearance.customUIFontFamily).toBe('IBM Plex Sans, PingFang SC');
    expect(appearance.customMonoFontFamily).toBeNull();

    vi.resetModules();
    const reloaded = await importStore();
    appearance = reloaded.useStore.getState().appearance;

    expect(appearance.customUIFontFamily).toBe('IBM Plex Sans, PingFang SC');
    expect(appearance.customMonoFontFamily).toBeNull();
  });

  it('persists the new query SQL template while preserving blank and trailing-space overrides', async () => {
    const { useStore } = await importStore();

    useStore.getState().setAppearance({
      newQuerySqlTemplate: 'SELECT * FROM ',
    });
    expect(useStore.getState().appearance.newQuerySqlTemplate).toBe('SELECT * FROM ');

    useStore.getState().setAppearance({
      newQuerySqlTemplate: 'SELECT id,\r\n       name\nFROM users;\r',
    });

    let persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.appearance.newQuerySqlTemplate).toBe('SELECT id,\n       name\nFROM users;\n');

    vi.resetModules();
    let reloaded = await importStore();
    expect(reloaded.useStore.getState().appearance.newQuerySqlTemplate).toBe('SELECT id,\n       name\nFROM users;\n');

    reloaded.useStore.getState().setAppearance({
      newQuerySqlTemplate: '',
    });

    persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.appearance.newQuerySqlTemplate).toBe('');

    vi.resetModules();
    reloaded = await importStore();
    expect(reloaded.useStore.getState().appearance.newQuerySqlTemplate).toBe('');

    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        appearance: {
          newQuerySqlTemplate: 123,
        },
      },
      version: 13,
    }));

    vi.resetModules();
    reloaded = await importStore();
    expect(reloaded.useStore.getState().appearance.newQuerySqlTemplate).toBeNull();
  });

  it('persists v2 sidebar search preferences and sanitizes filter text', async () => {
    const { useStore } = await importStore();

    useStore.getState().setAppearance({
      v2SidebarSearchMode: 'filter',
      v2CommandSearchPersistentFilterEnabled: true,
      v2SidebarPersistedFilter: `  ${'orders'.repeat(40)}  `,
    });

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.appearance.v2SidebarSearchMode).toBe('filter');
    expect(persisted.state.appearance.v2CommandSearchPersistentFilterEnabled).toBe(true);
    expect(persisted.state.appearance.v2SidebarPersistedFilter).toHaveLength(120);
    expect(persisted.state.appearance.v2SidebarPersistedFilter.startsWith('orders')).toBe(true);

    vi.resetModules();
    const reloaded = await importStore();
    const appearance = reloaded.useStore.getState().appearance;

    expect(appearance.v2SidebarSearchMode).toBe('filter');
    expect(appearance.v2CommandSearchPersistentFilterEnabled).toBe(true);
    expect(appearance.v2SidebarPersistedFilter).toHaveLength(120);
  });

  it('persists wider sidebar widths and clamps oversized restored values', async () => {
    const { useStore } = await importStore();

    useStore.getState().setSidebarWidth(880);
    expect(useStore.getState().sidebarWidth).toBe(880);

    let persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.sidebarWidth).toBe(880);

    useStore.getState().setSidebarWidth(1200);
    expect(useStore.getState().sidebarWidth).toBe(SIDEBAR_RESIZE_MAX_WIDTH);

    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        sidebarWidth: 1200,
      },
      version: 13,
    }));

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().sidebarWidth).toBe(SIDEBAR_RESIZE_MAX_WIDTH);
  });

  it('persists tab display appearance settings and sanitizes invalid elements', async () => {
    const { useStore } = await importStore();

    useStore.getState().setAppearance({
      tabDisplay: {
        layout: 'double',
        primaryElements: ['kind', 'object', 'invalid' as never, 'object'],
        secondaryElements: ['connection', 'host', 'schema', 'kind'],
      },
    });

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.appearance.tabDisplay).toEqual({
      layout: 'double',
      primaryElements: ['kind', 'object'],
      secondaryElements: ['connection', 'host', 'schema'],
    });

    vi.resetModules();
    const reloaded = await importStore();
    const appearance = reloaded.useStore.getState().appearance;

    expect(appearance.tabDisplay).toEqual({
      layout: 'double',
      primaryElements: ['kind', 'object'],
      secondaryElements: ['connection', 'host', 'schema'],
    });
  });

  it('persists independent single-line and double-line tab display snapshots', async () => {
    const { useStore } = await importStore();

    useStore.getState().setAppearance({
      tabDisplay: {
        layout: 'double',
        primaryElements: ['kind', 'object'],
        secondaryElements: ['connection', 'database'],
        single: {
          primaryElements: ['object', 'host'],
          secondaryElements: [],
        },
        double: {
          primaryElements: ['kind', 'object'],
          secondaryElements: ['connection', 'database'],
        },
      },
    });

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.appearance.tabDisplay).toEqual({
      layout: 'double',
      primaryElements: ['kind', 'object'],
      secondaryElements: ['connection', 'database'],
      single: {
        primaryElements: ['object', 'host'],
        secondaryElements: [],
      },
      double: {
        primaryElements: ['kind', 'object'],
        secondaryElements: ['connection', 'database'],
      },
    });

    vi.resetModules();
    const reloaded = await importStore();
    const appearance = reloaded.useStore.getState().appearance;

    expect(appearance.tabDisplay.single).toEqual({
      primaryElements: ['object', 'host'],
      secondaryElements: [],
    });
    expect(appearance.tabDisplay.double).toEqual({
      primaryElements: ['kind', 'object'],
      secondaryElements: ['connection', 'database'],
    });
  });

  it('does not clear persisted legacy connections during hydration migration', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        connections: [
          {
            id: 'legacy-1',
            name: 'Legacy',
            config: {
              id: 'legacy-1',
              type: 'postgres',
              host: 'db.local',
              port: 5432,
              user: 'postgres',
              password: 'secret',
            },
          },
        ],
      },
      version: 7,
    }));

    const { useStore } = await importStore();

    expect(useStore.getState().connections).toHaveLength(1);
    expect(useStore.getState().connections[0]?.config.password).toBe('secret');
  });

  it('does not fail hydration when persisted OceanBase connection uses unsupported native protocol', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        connections: [
          {
            id: 'oceanbase-native',
            name: 'OceanBase Native',
            config: {
              id: 'oceanbase-native',
              type: 'oceanbase',
              host: 'ob.local',
              port: 2881,
              user: 'root@test',
              oceanBaseProtocol: 'mysql',
              connectionParams: 'protocol=native',
            },
          },
        ],
      },
      version: 9,
    }));

    const { useStore } = await importStore();
    const config = useStore.getState().connections[0]?.config;

    expect(useStore.getState().connections).toHaveLength(1);
    expect(config?.connectionParams).toBe('protocol=native');
    expect(config?.oceanBaseProtocol).toBe('mysql');
  });

  it('preserves JVM Arthas diagnostic config when replacing saved connections', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'jvm-1',
        name: 'Orders JVM',
        config: {
          id: 'jvm-1',
          type: 'jvm',
          host: '127.0.0.1',
          port: 9010,
          user: '',
          jvm: {
            allowedModes: ['jmx'],
            preferredMode: 'jmx',
            diagnostic: {
              enabled: true,
              transport: 'arthas-tunnel',
              baseUrl: 'http://127.0.0.1:7777',
              targetId: 'gonavi-local-test',
              apiKey: 'diag-token',
              allowObserveCommands: true,
              allowTraceCommands: true,
              allowMutatingCommands: false,
              timeoutSeconds: 20,
            },
          },
        },
      },
    ]);

    expect(useStore.getState().connections[0]?.config.jvm?.diagnostic).toEqual({
      enabled: true,
      transport: 'arthas-tunnel',
      baseUrl: 'http://127.0.0.1:7777',
      targetId: 'gonavi-local-test',
      apiKey: 'diag-token',
      allowObserveCommands: true,
      allowTraceCommands: true,
      allowMutatingCommands: false,
      timeoutSeconds: 20,
    });
  });

  it('preserves connection icon metadata when replacing saved connections', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'visual-1',
        name: 'Visual Orders',
        iconType: 'postgres',
        iconColor: '#2f855a',
        config: {
          id: 'visual-1',
          type: 'mysql',
          host: 'db.local',
          port: 3306,
          user: 'root',
        },
      },
    ]);

    expect(useStore.getState().connections[0]?.iconType).toBe('postgres');
    expect(useStore.getState().connections[0]?.iconColor).toBe('#2f855a');
  });

  it('normalizes ClickHouse protocol override when replacing saved connections', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'clickhouse-http',
        name: 'ClickHouse HTTP',
        config: {
          id: 'clickhouse-http',
          type: 'clickhouse',
          host: 'clickhouse.local',
          port: 8125,
          user: 'default',
          clickHouseProtocol: 'https' as any,
        },
      },
    ]);

    expect(useStore.getState().connections[0]?.config.clickHouseProtocol).toBe(
      'http',
    );
  });

  it('normalizes keepalive settings when replacing saved connections', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'postgres-keepalive',
        name: 'Postgres KeepAlive',
        config: {
          id: 'postgres-keepalive',
          type: 'postgres',
          host: 'db.local',
          port: 5432,
          user: 'postgres',
          keepAliveEnabled: true,
          keepAliveIntervalMinutes: 0,
          keepAliveSQL: '  SELECT 1  ',
        },
      },
    ]);

    const config = useStore.getState().connections[0]?.config;
    expect(config?.keepAliveEnabled).toBe(true);
    expect(config?.keepAliveIntervalMinutes).toBe(240);
    expect(config?.keepAliveSQL).toBe('SELECT 1');
  });

  it('keeps StarRocks saved connections as independent datasource type', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'starrocks-fe',
        name: 'StarRocks FE',
        config: {
          id: 'starrocks-fe',
          type: 'starrocks',
          host: 'starrocks.local',
          port: 9030,
          user: 'root',
        },
      },
    ]);

    const config = useStore.getState().connections[0]?.config;
    expect(config?.type).toBe('starrocks');
    expect(config?.port).toBe(9030);
  });

  it('preserves Redis database indexes above the default 16 databases', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'redis-32',
        name: 'Redis 32 DBs',
        includeRedisDatabases: [0, 15, 16, 31, -1, 31],
        config: {
          id: 'redis-32',
          type: 'redis',
          host: 'redis.local',
          port: 6379,
          user: '',
          redisDB: 31,
        },
      },
    ]);

    const saved = useStore.getState().connections[0];
    expect(saved?.config.redisDB).toBe(31);
    expect(saved?.includeRedisDatabases).toEqual([0, 15, 16, 31]);
  });

  it('keeps InterSystems IRIS saved connections as independent datasource type', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'iris-user',
        name: 'IRIS USER',
        config: {
          id: 'iris-user',
          type: 'iris',
          host: 'iris.local',
          port: 1972,
          user: '_SYSTEM',
          database: 'USER',
        },
      },
      {
        id: 'iris-alias',
        name: 'IRIS Alias',
        config: {
          id: 'iris-alias',
          type: 'InterSystemsIRIS',
          host: 'iris-alias.local',
          port: 1972,
          user: '_SYSTEM',
          database: 'USER',
        },
      },
    ]);

    const connections = useStore.getState().connections;
    expect(connections[0]?.config.type).toBe('iris');
    expect(connections[0]?.config.port).toBe(1972);
    expect(connections[1]?.config.type).toBe('iris');
  });

  it('normalizes saved connection type aliases without falling back to mysql', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      { id: 'pg', name: 'Postgres', config: { id: 'pg', type: 'PostgreSQL', host: 'pg.local', port: 5432, user: 'postgres' } },
      { id: 'mssql', name: 'MSSQL', config: { id: 'mssql', type: 'mssql', host: 'sql.local', port: 1433, user: 'sa' } },
      { id: 'kingbase', name: 'Kingbase', config: { id: 'kingbase', type: 'kingbase8', host: 'kingbase.local', port: 54321, user: 'system' } },
      { id: 'dm', name: 'Dameng', config: { id: 'dm', type: 'dm8', host: 'dm.local', port: 5236, user: 'SYSDBA' } },
      { id: 'sqlite', name: 'SQLite', config: { id: 'sqlite', type: 'sqlite3', host: 'D:/db/app.sqlite', port: 0, user: '' } },
      { id: 'milvusdb', name: 'Milvus DB', config: { id: 'milvusdb', type: 'milvusdb', host: 'milvus.local', port: 19530, user: '' } },
      { id: 'milvus-db', name: 'Milvus DB Alias', config: { id: 'milvus-db', type: 'milvus-db', host: 'milvus-alias.local', port: 19530, user: '' } },
    ]);

    expect(useStore.getState().connections.map((conn) => conn.config.type)).toEqual([
      'postgres',
      'sqlserver',
      'kingbase',
      'dameng',
      'sqlite',
      'milvus',
      'milvus',
    ]);
  });

  it('preserves built-in document, vector, and messaging datasource types', async () => {
    const { useStore } = await importStore();

    const datasourceTypes = [
      ['chroma', 8000],
      ['qdrant', 6333],
      ['milvus', 19530],
      ['rocketmq', 9876],
      ['mqtt', 1883],
      ['rabbitmq', 15672],
    ] as const;

    useStore.getState().replaceConnections(
      datasourceTypes.map(([type, port]) => ({
        id: `conn-${type}`,
        name: type,
        config: {
          id: `conn-${type}`,
          type,
          host: `${type}.local`,
          port,
          user: '',
        },
      })),
    );

    expect(
      useStore.getState().connections.map((conn) => [
        conn.config.type,
        conn.config.port,
      ]),
    ).toEqual(datasourceTypes);
  });

  it('preserves SSL certificate paths for SSL-capable saved connections', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'postgres-ssl',
        name: 'Postgres SSL',
        config: {
          id: 'postgres-ssl',
          type: 'postgres',
          host: 'db.local',
          port: 5432,
          user: 'postgres',
          useSSL: true,
          sslMode: 'required',
          sslCAPath: 'C:/certs/ca.pem',
          sslCertPath: 'C:/certs/client-cert.pem',
          sslKeyPath: 'C:/certs/client-key.pem',
        },
      },
    ]);

    const config = useStore.getState().connections[0]?.config;
    expect(config?.sslCAPath).toBe('C:/certs/ca.pem');
    expect(config?.sslCertPath).toBe('C:/certs/client-cert.pem');
    expect(config?.sslKeyPath).toBe('C:/certs/client-key.pem');
  });

  it('normalizes OceanBase protocol override when replacing saved connections', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'oceanbase-oracle',
        name: 'OceanBase Oracle',
        config: {
          id: 'oceanbase-oracle',
          type: 'oceanbase',
          host: 'ob.local',
          port: 2881,
          user: 'sys@oracle001',
          oceanBaseProtocol: 'oracle',
        },
      },
    ]);

    expect(useStore.getState().connections[0]?.config.oceanBaseProtocol).toBe(
      'oracle',
    );
  });

  it('restores OceanBase protocol from saved URI or connection params', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'oceanbase-uri-oracle',
        name: 'OceanBase URI Oracle',
        config: {
          id: 'oceanbase-uri-oracle',
          type: 'oceanbase',
          host: 'ob.local',
          port: 2881,
          user: 'sys@oracle001',
          uri: 'oceanbase://sys%40oracle001:pass@ob.local:2881/OBORCL?protocol=oracle',
        },
      },
      {
        id: 'oceanbase-param-oracle',
        name: 'OceanBase Param Oracle',
        config: {
          id: 'oceanbase-param-oracle',
          type: 'oceanbase',
          host: 'ob.local',
          port: 2881,
          user: 'sys@oracle001',
          connectionParams: 'tenantMode=oracle&PREFETCH_ROWS=5000',
        },
      },
    ]);

    expect(useStore.getState().connections[0]?.config.oceanBaseProtocol).toBe(
      'oracle',
    );
    expect(useStore.getState().connections[1]?.config.oceanBaseProtocol).toBe(
      'oracle',
    );
  });

  it('prefers OceanBase protocol query key over legacy aliases when restoring saved connections', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'oceanbase-conflict',
        name: 'OceanBase Conflict',
        config: {
          id: 'oceanbase-conflict',
          type: 'oceanbase',
          host: 'ob.local',
          port: 2881,
          user: 'root@test',
          connectionParams: 'protocol=mysql&tenantMode=oracle',
        },
      },
    ]);

    expect(useStore.getState().connections[0]?.config.oceanBaseProtocol).toBe(
      'mysql',
    );
  });

  it('keeps saved OceanBase native protocol loadable for connect-time rejection', async () => {
    const { useStore } = await importStore();

    expect(() => useStore.getState().replaceConnections([
      {
        id: 'oceanbase-native',
        name: 'OceanBase Native',
        config: {
          id: 'oceanbase-native',
          type: 'oceanbase',
          host: 'ob.local',
          port: 2881,
          user: 'root@test',
          oceanBaseProtocol: 'mysql',
          connectionParams: 'protocol=native',
        },
      },
    ])).not.toThrow();
    expect(useStore.getState().connections[0]?.config.connectionParams).toBe(
      'protocol=native',
    );
    expect(useStore.getState().connections[0]?.config.oceanBaseProtocol).toBe(
      'mysql',
    );
  });

  it('normalizes OceanBase protocol when updating a saved connection', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'oceanbase-existing',
        name: 'OceanBase Existing',
        config: {
          id: 'oceanbase-existing',
          type: 'oceanbase',
          host: 'ob.local',
          port: 2881,
          user: 'root@test',
          connectionParams: 'protocol=mysql',
        },
      },
    ]);

    useStore.getState().updateConnection({
      id: 'oceanbase-existing',
      name: 'OceanBase Existing',
      config: {
        id: 'oceanbase-existing',
        type: 'oceanbase',
        host: 'ob.local',
        port: 2881,
        user: 'sys@oracle001',
        connectionParams: 'protocol=oracle',
      },
    });

    expect(useStore.getState().connections[0]?.config.oceanBaseProtocol).toBe(
      'oracle',
    );
  });

  it('normalizes connection and group environment metadata', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'conn-production',
        name: 'Production',
        environmentType: 'production',
        config: {
          id: 'conn-production',
          type: 'postgres',
          host: 'prod.local',
          port: 5432,
          user: 'postgres',
        },
      },
      {
        id: 'conn-legacy',
        name: 'Legacy',
        config: {
          id: 'conn-legacy',
          type: 'sqlite',
          host: '',
          port: 0,
          user: '',
        },
      },
    ]);
    useStore.getState().addConnectionTag({
      id: 'tag-test',
      name: 'Test',
      environmentType: 'test',
      connectionIds: ['conn-production'],
    });
    useStore.getState().addConnectionTag({
      id: 'tag-legacy',
      name: 'Legacy',
      connectionIds: ['conn-legacy'],
    });

    expect(useStore.getState().connections.map((item) => item.environmentType)).toEqual([
      'production',
      'local',
    ]);
    expect(useStore.getState().connectionTags.map((item) => item.environmentType)).toEqual([
      'test',
      'local',
    ]);
  }, 30_000);

  it('reorders connections inside tags and ungrouped roots independently', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'conn-a',
        name: 'A',
        config: { id: 'conn-a', type: 'mysql', host: 'a.local', port: 3306, user: 'root' },
      },
      {
        id: 'conn-b',
        name: 'B',
        config: { id: 'conn-b', type: 'mysql', host: 'b.local', port: 3306, user: 'root' },
      },
      {
        id: 'conn-c',
        name: 'C',
        config: { id: 'conn-c', type: 'mysql', host: 'c.local', port: 3306, user: 'root' },
      },
      {
        id: 'conn-d',
        name: 'D',
        config: { id: 'conn-d', type: 'mysql', host: 'd.local', port: 3306, user: 'root' },
      },
    ]);
    useStore.getState().addConnectionTag({
      id: 'tag-dev',
      name: '开发',
      connectionIds: ['conn-b', 'conn-d'],
    });

    useStore.getState().reorderConnections('conn-d', 'conn-b', 'tag-dev', true);
    expect(useStore.getState().connectionTags[0]?.connectionIds).toEqual(['conn-d', 'conn-b']);

    useStore.getState().reorderConnections('conn-c', 'conn-a', null, true);
    expect(useStore.getState().connections.map((conn) => conn.id)).toEqual([
      'conn-c',
      'conn-a',
      'conn-b',
      'conn-d',
    ]);
  });

  it('reorders sidebar root items across tags and ungrouped hosts', async () => {
    const {
      buildSidebarRootConnectionToken,
      buildSidebarRootTagToken,
      resolveSidebarRootOrderTokens,
      useStore,
    } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'conn-a',
        name: 'A',
        config: { id: 'conn-a', type: 'mysql', host: 'a.local', port: 3306, user: 'root' },
      },
      {
        id: 'conn-b',
        name: 'B',
        config: { id: 'conn-b', type: 'mysql', host: 'b.local', port: 3306, user: 'root' },
      },
      {
        id: 'conn-c',
        name: 'C',
        config: { id: 'conn-c', type: 'mysql', host: 'c.local', port: 3306, user: 'root' },
      },
    ]);
    useStore.getState().addConnectionTag({
      id: 'tag-dev',
      name: '开发',
      connectionIds: ['conn-b'],
    });

    const initialOrder = resolveSidebarRootOrderTokens(
      useStore.getState().sidebarRootOrder,
      useStore.getState().connectionTags,
      useStore.getState().connections,
    );
    expect(initialOrder).toEqual([
      buildSidebarRootTagToken('tag-dev'),
      buildSidebarRootConnectionToken('conn-a'),
      buildSidebarRootConnectionToken('conn-c'),
    ]);

    useStore.getState().reorderSidebarRoot(
      buildSidebarRootTagToken('tag-dev'),
      buildSidebarRootConnectionToken('conn-c'),
      false,
    );

    expect(resolveSidebarRootOrderTokens(
      useStore.getState().sidebarRootOrder,
      useStore.getState().connectionTags,
      useStore.getState().connections,
    )).toEqual([
      buildSidebarRootConnectionToken('conn-a'),
      buildSidebarRootConnectionToken('conn-c'),
      buildSidebarRootTagToken('tag-dev'),
    ]);
  });

  it('restores ungrouped host root order after moving a host out of a tag', async () => {
    const {
      buildSidebarRootConnectionToken,
      buildSidebarRootTagToken,
      resolveSidebarRootOrderTokens,
      useStore,
    } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'conn-a',
        name: 'A',
        config: { id: 'conn-a', type: 'mysql', host: 'a.local', port: 3306, user: 'root' },
      },
      {
        id: 'conn-b',
        name: 'B',
        config: { id: 'conn-b', type: 'mysql', host: 'b.local', port: 3306, user: 'root' },
      },
    ]);
    useStore.getState().addConnectionTag({
      id: 'tag-dev',
      name: '开发',
      connectionIds: ['conn-b'],
    });

    useStore.getState().moveConnectionToTag('conn-a', 'tag-dev');
    useStore.getState().moveConnectionToTag('conn-a', null);

    expect(resolveSidebarRootOrderTokens(
      useStore.getState().sidebarRootOrder,
      useStore.getState().connectionTags,
      useStore.getState().connections,
    )).toEqual([
      buildSidebarRootTagToken('tag-dev'),
      buildSidebarRootConnectionToken('conn-a'),
    ]);
  });

  it('keeps persisted sidebar root order until backend connections reload on startup', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        connectionTags: [
          {
            id: 'tag-redis',
            name: 'Redis',
            connectionIds: ['conn-b'],
          },
        ],
        sidebarRootOrder: [
          'connection:conn-a',
          'connection:conn-c',
          'tag:tag-redis',
        ],
      },
      version: 13,
    }));

    const {
      buildSidebarRootConnectionToken,
      buildSidebarRootTagToken,
      resolveSidebarRootOrderTokens,
      useStore,
    } = await importStore();

    expect(useStore.getState().sidebarRootOrder).toEqual([
      buildSidebarRootConnectionToken('conn-a'),
      buildSidebarRootConnectionToken('conn-c'),
      buildSidebarRootTagToken('tag-redis'),
    ]);

    useStore.getState().replaceConnections([
      {
        id: 'conn-a',
        name: 'A',
        config: { id: 'conn-a', type: 'mysql', host: 'a.local', port: 3306, user: 'root' },
      },
      {
        id: 'conn-b',
        name: 'B',
        config: { id: 'conn-b', type: 'redis', host: 'b.local', port: 6379, user: 'default' },
      },
      {
        id: 'conn-c',
        name: 'C',
        config: { id: 'conn-c', type: 'mysql', host: 'c.local', port: 3306, user: 'root' },
      },
    ]);

    expect(resolveSidebarRootOrderTokens(
      useStore.getState().sidebarRootOrder,
      useStore.getState().connectionTags,
      useStore.getState().connections,
    )).toEqual([
      buildSidebarRootConnectionToken('conn-a'),
      buildSidebarRootConnectionToken('conn-c'),
      buildSidebarRootTagToken('tag-redis'),
    ]);
  });

  it('migrates flat v15 connection groups to explicit root child order', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        connectionTags: [
          {
            id: 'tag-legacy',
            name: 'Legacy',
            connectionIds: ['conn-a', 'conn-b'],
          },
        ],
        sidebarRootOrder: ['tag:tag-legacy'],
      },
      version: 15,
    }));

    const {
      buildSidebarRootConnectionToken,
      resolveConnectionTagChildOrder,
      useStore,
    } = await importStore();

    const legacyTag = useStore.getState().connectionTags[0];
    expect(legacyTag?.parentTagId).toBeUndefined();
    expect(legacyTag?.childOrder).toEqual([
      buildSidebarRootConnectionToken('conn-a'),
      buildSidebarRootConnectionToken('conn-b'),
    ]);
    expect(resolveConnectionTagChildOrder(
      'tag-legacy',
      useStore.getState().connectionTags,
    )).toEqual(legacyTag?.childOrder);

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.version).toBe(20);
    expect(persisted.state.connectionTags[0].childOrder).toEqual([
      'connection:conn-a',
      'connection:conn-b',
    ]);
  });

  it('supports three-level groups with hosts and child groups in one ordered list', async () => {
    const {
      buildSidebarRootConnectionToken,
      buildSidebarRootTagToken,
      resolveConnectionTagChildOrder,
      useStore,
    } = await importStore();
    useStore.getState().replaceConnections(
      ['host-1', 'host-2', 'host-3', 'host-4', 'host-5', 'host-6'].map((id) => ({
        id,
        name: id,
        config: { id, type: 'mysql', host: `${id}.local`, port: 3306, user: 'root' },
      })),
    );
    useStore.getState().addConnectionTag({
      id: 'group-1',
      name: '分组1',
      connectionIds: ['host-1', 'host-2'],
    });
    useStore.getState().addConnectionTag({
      id: 'group-1-1',
      name: '分组1-1',
      parentTagId: 'group-1',
      connectionIds: ['host-3', 'host-4'],
    });
    useStore.getState().addConnectionTag({
      id: 'group-1-1-1',
      name: '分组1-1-1',
      parentTagId: 'group-1-1',
      connectionIds: ['host-5', 'host-6'],
    });

    // A child group may be placed between its parent's direct hosts.
    useStore.getState().moveConnectionTag(
      'group-1-1',
      'group-1',
      buildSidebarRootConnectionToken('host-1'),
      false,
    );

    expect(resolveConnectionTagChildOrder(
      'group-1',
      useStore.getState().connectionTags,
    )).toEqual([
      buildSidebarRootConnectionToken('host-1'),
      buildSidebarRootTagToken('group-1-1'),
      buildSidebarRootConnectionToken('host-2'),
    ]);
    expect(resolveConnectionTagChildOrder(
      'group-1-1',
      useStore.getState().connectionTags,
    )).toEqual([
      buildSidebarRootConnectionToken('host-3'),
      buildSidebarRootConnectionToken('host-4'),
      buildSidebarRootTagToken('group-1-1-1'),
    ]);
    expect(useStore.getState().connectionTags.find(
      (tag) => tag.id === 'group-1-1-1',
    )?.parentTagId).toBe('group-1-1');
  });

  it('keeps a host in exactly one nested group while moving and reordering it', async () => {
    const {
      buildSidebarRootConnectionToken,
      resolveConnectionTagChildOrder,
      useStore,
    } = await importStore();
    useStore.getState().replaceConnections(
      ['host-1', 'host-2'].map((id) => ({
        id,
        name: id,
        config: { id, type: 'mysql', host: `${id}.local`, port: 3306, user: 'root' },
      })),
    );
    useStore.getState().addConnectionTag({
      id: 'group-1',
      name: '分组1',
      connectionIds: ['host-1'],
    });
    useStore.getState().addConnectionTag({
      id: 'group-1-1',
      name: '分组1-1',
      parentTagId: 'group-1',
      connectionIds: ['host-2'],
    });

    useStore.getState().moveConnectionToTag(
      'host-1',
      'group-1-1',
      buildSidebarRootConnectionToken('host-2'),
      true,
    );
    useStore.getState().reorderConnections(
      'host-2',
      'host-1',
      'group-1-1',
      true,
    );

    const groups = useStore.getState().connectionTags;
    expect(groups.find((tag) => tag.id === 'group-1')?.connectionIds).toEqual([]);
    expect(groups.find((tag) => tag.id === 'group-1-1')?.connectionIds).toEqual([
      'host-2',
      'host-1',
    ]);
    expect(groups.filter((tag) => tag.connectionIds.includes('host-1'))).toHaveLength(1);
    expect(resolveConnectionTagChildOrder('group-1-1', groups)).toEqual([
      buildSidebarRootConnectionToken('host-2'),
      buildSidebarRootConnectionToken('host-1'),
    ]);
  });

  it('promotes direct hosts and child groups in place when deleting an intermediate group', async () => {
    const {
      buildSidebarRootConnectionToken,
      buildSidebarRootTagToken,
      resolveConnectionTagChildOrder,
      useStore,
    } = await importStore();
    useStore.getState().replaceConnections(
      ['host-1', 'host-2', 'host-3', 'host-4', 'host-5', 'host-6'].map((id) => ({
        id,
        name: id,
        config: { id, type: 'mysql', host: `${id}.local`, port: 3306, user: 'root' },
      })),
    );
    useStore.getState().addConnectionTag({
      id: 'group-1',
      name: '分组1',
      connectionIds: ['host-1', 'host-2'],
    });
    useStore.getState().addConnectionTag({
      id: 'group-1-1',
      name: '分组1-1',
      parentTagId: 'group-1',
      connectionIds: ['host-3', 'host-4'],
    });
    useStore.getState().addConnectionTag({
      id: 'group-1-1-1',
      name: '分组1-1-1',
      parentTagId: 'group-1-1',
      connectionIds: ['host-5', 'host-6'],
    });
    useStore.getState().moveConnectionTag(
      'group-1-1',
      'group-1',
      buildSidebarRootConnectionToken('host-1'),
      false,
    );

    useStore.getState().removeConnectionTag('group-1-1');

    expect(useStore.getState().connectionTags.some(
      (tag) => tag.id === 'group-1-1',
    )).toBe(false);
    expect(useStore.getState().connectionTags.find(
      (tag) => tag.id === 'group-1-1-1',
    )?.parentTagId).toBe('group-1');
    expect(resolveConnectionTagChildOrder(
      'group-1',
      useStore.getState().connectionTags,
    )).toEqual([
      buildSidebarRootConnectionToken('host-1'),
      buildSidebarRootConnectionToken('host-3'),
      buildSidebarRootConnectionToken('host-4'),
      buildSidebarRootTagToken('group-1-1-1'),
      buildSidebarRootConnectionToken('host-2'),
    ]);
    expect(useStore.getState().connectionTags.find(
      (tag) => tag.id === 'group-1',
    )?.connectionIds).toEqual(['host-1', 'host-3', 'host-4', 'host-2']);
  });

  it('rejects moving a group into itself or a descendant', async () => {
    const { useStore } = await importStore();
    useStore.getState().addConnectionTag({
      id: 'group-1',
      name: '分组1',
      connectionIds: [],
    });
    useStore.getState().addConnectionTag({
      id: 'group-1-1',
      name: '分组1-1',
      parentTagId: 'group-1',
      connectionIds: [],
    });
    useStore.getState().addConnectionTag({
      id: 'group-1-1-1',
      name: '分组1-1-1',
      parentTagId: 'group-1-1',
      connectionIds: [],
    });

    useStore.getState().moveConnectionTag('group-1', 'group-1-1-1');
    useStore.getState().moveConnectionTag('group-1-1', 'group-1-1');

    const groups = useStore.getState().connectionTags;
    expect(groups.find((tag) => tag.id === 'group-1')?.parentTagId).toBeUndefined();
    expect(groups.find((tag) => tag.id === 'group-1-1')?.parentTagId).toBe('group-1');
    expect(groups.find((tag) => tag.id === 'group-1-1-1')?.parentTagId).toBe('group-1-1');
  });

  it('sanitizes malformed persisted group parents and duplicate host ownership', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        connectionTags: [
          {
            id: 'group-a',
            name: 'A',
            parentTagId: 'group-b',
            connectionIds: ['shared-host'],
            childOrder: ['connection:shared-host', 'tag:group-b'],
          },
          {
            id: 'group-b',
            name: 'B',
            parentTagId: 'group-a',
            connectionIds: ['shared-host'],
          },
          {
            id: 'group-orphan',
            name: 'Orphan',
            parentTagId: 'missing-group',
            connectionIds: [],
          },
        ],
      },
      version: 16,
    }));

    const { useStore } = await importStore();
    const groups = useStore.getState().connectionTags;

    expect(groups.find((tag) => tag.id === 'group-a')?.parentTagId).toBeUndefined();
    expect(groups.find((tag) => tag.id === 'group-b')?.parentTagId).toBeUndefined();
    expect(groups.find((tag) => tag.id === 'group-orphan')?.parentTagId).toBeUndefined();
    expect(groups.find((tag) => tag.id === 'group-a')?.connectionIds).toEqual([
      'shared-host',
    ]);
    expect(groups.find((tag) => tag.id === 'group-b')?.connectionIds).toEqual([]);
  });

  it('removes host tokens from nested group order when deleting a connection', async () => {
    const {
      buildSidebarRootConnectionToken,
      resolveConnectionTagChildOrder,
      useStore,
    } = await importStore();
    useStore.getState().replaceConnections(
      ['host-1', 'host-2'].map((id) => ({
        id,
        name: id,
        config: { id, type: 'mysql', host: `${id}.local`, port: 3306, user: 'root' },
      })),
    );
    useStore.getState().addConnectionTag({
      id: 'group-1',
      name: '分组1',
      connectionIds: [],
    });
    useStore.getState().addConnectionTag({
      id: 'group-1-1',
      name: '分组1-1',
      parentTagId: 'group-1',
      connectionIds: ['host-1', 'host-2'],
    });

    useStore.getState().removeConnection('host-1');

    expect(resolveConnectionTagChildOrder(
      'group-1-1',
      useStore.getState().connectionTags,
    )).toEqual([buildSidebarRootConnectionToken('host-2')]);
    expect(useStore.getState().connectionTags.find(
      (tag) => tag.id === 'group-1-1',
    )?.connectionIds).toEqual(['host-2']);
  });

  it('bounds hydrated table access counts while retaining frequent and recent entries', async () => {
    const tableAccessCount = Object.fromEntries([
      ['priority-main-users', 100],
      ...Array.from(
        { length: MAX_TABLE_ACCESS_COUNT_ENTRIES + 1 },
        (_, index) => [`connection-${index}-main-table`, 1] as const,
      ),
    ]);
    storage.setItem('lite-db-storage', JSON.stringify({
      state: { tableAccessCount },
      version: 17,
    }));

    const { useStore } = await importStore();
    const hydrated = useStore.getState().tableAccessCount;

    expect(Object.keys(hydrated)).toHaveLength(MAX_TABLE_ACCESS_COUNT_ENTRIES);
    expect(hydrated['priority-main-users']).toBe(100);
    expect(hydrated['connection-0-main-table']).toBeUndefined();
    expect(hydrated[`connection-${MAX_TABLE_ACCESS_COUNT_ENTRIES}-main-table`]).toBe(1);
  });

  it('bounds directly injected table access counts before persistence', async () => {
    const { useStore } = await importStore();
    useStore.setState({
      tableAccessCount: Object.fromEntries(
        Array.from(
          { length: MAX_TABLE_ACCESS_COUNT_ENTRIES + 10 },
          (_, index) => [`injected-${index}`, index + 1],
        ),
      ),
    });

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(Object.keys(persisted.state.tableAccessCount)).toHaveLength(
      MAX_TABLE_ACCESS_COUNT_ENTRIES,
    );
    expect(persisted.state.tableAccessCount['injected-0']).toBeUndefined();
    expect(persisted.state.tableAccessCount[
      `injected-${MAX_TABLE_ACCESS_COUNT_ENTRIES + 9}`
    ]).toBe(MAX_TABLE_ACCESS_COUNT_ENTRIES + 10);
  });

  it('bounds runtime table access counts and evicts the oldest least-used entry', async () => {
    const { useStore } = await importStore();
    useStore.setState({
      tableAccessCount: Object.fromEntries(
        Array.from(
          { length: MAX_TABLE_ACCESS_COUNT_ENTRIES },
          (_, index) => [buildTableAccessCountKey('conn', 'main', `table-${index}`), 1],
        ),
      ),
    });

    useStore.getState().recordTableAccess('conn', 'main', 'table-0');
    useStore.getState().recordTableAccess('conn', 'main', 'new-table');

    const counts = useStore.getState().tableAccessCount;
    expect(Object.keys(counts)).toHaveLength(MAX_TABLE_ACCESS_COUNT_ENTRIES);
    expect(counts[buildTableAccessCountKey('conn', 'main', 'table-0')]).toBe(2);
    expect(counts[buildTableAccessCountKey('conn', 'main', 'table-1')]).toBeUndefined();
    expect(counts[buildTableAccessCountKey('conn', 'main', 'new-table')]).toBe(1);
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
      createdAt: 1,
    });

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.externalSQLDirectories).toEqual([
      {
        id: 'ext-1',
        name: 'scripts',
        path: 'D:/sql/scripts',
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

  it('updates activeContext when switching between tabs with different host or database', async () => {
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
    expect(useStore.getState().activeContext).toEqual({ connectionId: 'conn-1', dbName: 'main' });

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
    useStore.getState().setWindowBounds({ width: 1400, height: 900, x: 80, y: 40 });

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.windowState).toBe('maximized');
    expect(persisted.state.windowBounds).toEqual({ width: 1400, height: 900, x: 80, y: 40 });

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().windowState).toBe('maximized');
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
    expect(JSON.parse(storage.getItem('lite-db-storage') || '{}').version).toBe(20);

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
