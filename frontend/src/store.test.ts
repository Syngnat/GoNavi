import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIDEBAR_RESIZE_MAX_WIDTH } from './utils/sidebarLayout';
import { buildAllSavedQueriesTreeNode } from './components/sidebar/sidebarSavedQueriesTreeNode';

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

  it('removes a deleted saved query and its empty connection group without refreshing groups', async () => {
    const { useStore } = await importStore();
    const backendResolver = await import('./store/storeConnectionSanitizers');
    const deleted = { id: 'delete-last', name: 'Delete last', sql: 'select 1', connectionId: 'saved-conn', dbName: 'app', createdAt: 1 };
    const kept = { ...deleted, id: 'keep-query', name: 'Keep query', connectionId: 'keep-conn' };
    const connections = [
      { id: 'saved-conn', name: 'Saved connection', config: { type: 'mysql', host: 'db.local', port: 3306 } },
      { id: 'keep-conn', name: 'Kept connection', config: { type: 'mysql', host: 'other.local', port: 3306 } },
    ] as Parameters<typeof buildAllSavedQueriesTreeNode>[1];
    const GetSavedQueryGroups = vi.fn(async () => []);
    const DeleteQuery = vi.fn(async () => undefined);
    const resolver = vi.spyOn(backendResolver, 'resolveSavedQueryBackend').mockReturnValue({ DeleteQuery, GetSavedQueryGroups });
    try {
      useStore.setState({ connections, savedQueries: [deleted, kept], savedQueryGroups: [] });
      await useStore.getState().deleteQuery(deleted.id);
      const snapshot = useStore.getState();
      const tree = buildAllSavedQueriesTreeNode(snapshot.savedQueries, snapshot.connections, snapshot.savedQueryGroups);
      expect(DeleteQuery).toHaveBeenCalledWith(deleted.id);
      expect(snapshot.savedQueries.map(query => query.id)).toEqual([kept.id]);
      expect(tree?.children?.map(node => node.key)).toEqual(['all-saved-queries-connection-keep-conn']);
      expect(snapshot.connections).toEqual(connections);
      await useStore.getState().deleteQuery(kept.id);
      const empty = useStore.getState();
      expect(buildAllSavedQueriesTreeNode(empty.savedQueries, empty.connections, empty.savedQueryGroups)).toBeNull();
      expect(empty.connections).toEqual(connections);
      expect(GetSavedQueryGroups).not.toHaveBeenCalled();
    } finally { resolver.mockRestore(); }
  });

  it('clears deleted query membership and child order without a fallible group refresh', async () => {
    const { useStore } = await importStore();
    const backendResolver = await import('./store/storeConnectionSanitizers');
    const query = { id: 'delete-grouped', name: 'Grouped query', sql: 'select 1', connectionId: 'saved-conn', dbName: 'app', createdAt: 1 };
    const group = { id: 'manual', name: 'Manual folder', queryIds: [query.id], childOrder: [`query:${query.id}`], createdAt: 1 };
    const GetSavedQueryGroups = vi.fn(async () => { throw new Error('group refresh failed'); });
    const resolver = vi.spyOn(backendResolver, 'resolveSavedQueryBackend').mockReturnValue({
      DeleteQuery: vi.fn(async () => undefined), GetSavedQueryGroups,
    });
    try {
      useStore.setState({ savedQueries: [query], savedQueryGroups: [group] });
      await expect(useStore.getState().deleteQuery(query.id)).resolves.toBeUndefined();
      expect(useStore.getState().savedQueries).toEqual([]);
      expect(useStore.getState().savedQueryGroups).toMatchObject([{ id: group.id, queryIds: [], childOrder: [] }]);
      const tree = buildAllSavedQueriesTreeNode(useStore.getState().savedQueries, [], useStore.getState().savedQueryGroups);
      expect(tree?.children).toMatchObject([{ key: 'saved-query-manual-group-manual', children: [] }]);
      expect(GetSavedQueryGroups).not.toHaveBeenCalled();
    } finally { resolver.mockRestore(); }
  });

  it('does not remove saved queries or groups when the backend deletion fails', async () => {
    const { useStore } = await importStore();
    const backendResolver = await import('./store/storeConnectionSanitizers');
    const query = { id: 'keep-failed-delete', name: 'Keep', sql: 'select 1', connectionId: 'saved-conn', dbName: 'app', createdAt: 1 };
    const group = { id: 'manual', name: 'Manual folder', queryIds: [query.id], createdAt: 1 };
    const GetSavedQueryGroups = vi.fn(async () => []);
    const resolver = vi.spyOn(backendResolver, 'resolveSavedQueryBackend').mockReturnValue({
      DeleteQuery: vi.fn(async () => { throw new Error('delete failed'); }), GetSavedQueryGroups,
    });
    try {
      useStore.setState({ savedQueries: [query], savedQueryGroups: [group] });
      await expect(useStore.getState().deleteQuery(query.id)).rejects.toThrow('delete failed');
      expect(useStore.getState().savedQueries).toEqual([query]);
      expect(useStore.getState().savedQueryGroups).toEqual([group]);
      expect(GetSavedQueryGroups).not.toHaveBeenCalled();
    } finally { resolver.mockRestore(); }
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

    expect(appearance.enabled).toBe(false);
    expect(appearance.opacity).toBe(0.75);
    expect(appearance.blur).toBe(6);
    expect(appearance).not.toHaveProperty('useNativeMacWindowControls');
    expect(appearance.tableDoubleClickAction).toBe('open-data');
    expect(appearance.queryTableCtrlClickAction).toBe('open-design');
    expect(appearance.v2SidebarSearchMode).toBe('command');
    expect(appearance).not.toHaveProperty('v2CommandSearchPersistentFilterEnabled');
    expect(appearance.v2SidebarPersistedFilter).toBe('');
    expect(appearance.v2SidebarRailScale).toBe(1);
    expect(appearance.tabEnvironmentAccentThickness).toBe(2);
    expect(appearance.toolbarButtonColorOverrides).toEqual({});
    expect(appearance.sidebarSingleDatabaseExpansion).toBe(false);
    expect(appearance.workbenchSidebarAutoCollapse).toBe(false);
    expect(appearance.sidebarHiddenObjectGroups).toEqual([]);
    expect(appearance.showDataTableVerticalBorders).toBe(false);
    expect(appearance.showDataTableRowNumber).toBe(true);
    expect(appearance.dataTableDensity).toBe('compact');
    expect(appearance.dataTableFontSize).toBeNull();
    expect(appearance.dataTableFontSizeFollowGlobal).toBe(true);
    expect(appearance.sqlEditorFontSize).toBeNull();
    expect(appearance.sqlEditorFontSizeFollowGlobal).toBe(true);
    expect(appearance.sidebarTreeFontSize).toBeNull();
    expect(appearance.sidebarTreeFontSizeFollowGlobal).toBe(true);
    expect(appearance.customUIFontFamily).toBeNull();
    expect(appearance.customMonoFontFamily).toBeNull();
    expect(appearance.newQuerySqlTemplate).toBeNull();
    expect(appearance.autoAddTableAlias).toBe(true);
    expect(appearance.customTableAliasPrefixEnabled).toBe(false);
    expect(appearance.customTableAliasPrefix).toBe('');
    expect(appearance.tabDisplay).toEqual({
      layout: 'single',
      primaryElements: ['connection', 'kind', 'object'],
      secondaryElements: [],
    });
  }, 30000);

  it('persists a valid custom table alias prefix and discards invalid restored values', async () => {
    const { useStore } = await importStore();

    useStore.getState().setAppearance({
      customTableAliasPrefixEnabled: true,
      customTableAliasPrefix: 'T$',
    });
    expect(useStore.getState().appearance).toMatchObject({
      customTableAliasPrefixEnabled: true,
      customTableAliasPrefix: 'T$',
    });

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().appearance).toMatchObject({
      customTableAliasPrefixEnabled: true,
      customTableAliasPrefix: 'T$',
    });

    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        appearance: {
          customTableAliasPrefixEnabled: true,
          customTableAliasPrefix: '1invalid',
        },
      },
      version: 21,
    }));
    vi.resetModules();
    const invalid = await importStore();
    expect(invalid.useStore.getState().appearance).toMatchObject({
      customTableAliasPrefixEnabled: true,
      customTableAliasPrefix: '',
    });

    invalid.useStore.getState().setAppearance({
      customTableAliasPrefix: 'a'.repeat(25),
    });
    expect(invalid.useStore.getState().appearance.customTableAliasPrefix).toBe('');
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
    // 默认布局已翻转为单行：旧默认（单行 [connection,kind,object]）迁移后保持等值，
    // 仅版本号升级；自定义 double 快照原样保留（不被默认迁移覆盖）。
    expect(migrated.useStore.getState().appearance.tabDisplay).toEqual({
      layout: 'single',
      primaryElements: ['connection', 'kind', 'object'],
      secondaryElements: [],
    });
    expect(JSON.parse(storage.getItem('lite-db-storage') || '{}').version).toBe(22);

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
    expect(persisted.version).toBe(22);
    expect(persisted.state.appearance.sqlEditorFontSize).toBe(17);
    expect(persisted.state.appearance.sqlEditorFontSizeFollowGlobal).toBe(false);
  });

  it('persists DataGrid appearance settings and restores them after reload', async () => {
    const { useStore } = await importStore();

    useStore.getState().setAppearance({
      showDataTableVerticalBorders: true,
      showDataTableRowNumber: false,
      dataTableDensity: 'compact',
      tableDoubleClickAction: 'open-design',
      queryTableCtrlClickAction: 'locate',
      v2SidebarRailScale: 1.55,
      tabEnvironmentAccentThickness: 5,
      sidebarSingleDatabaseExpansion: true,
    });

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.appearance.showDataTableVerticalBorders).toBe(true);
    expect(persisted.state.appearance.showDataTableRowNumber).toBe(false);
    expect(persisted.state.appearance.dataTableDensity).toBe('compact');
    expect(persisted.state.appearance.tableDoubleClickAction).toBe('open-design');
    expect(persisted.state.appearance.queryTableCtrlClickAction).toBe('locate');
    expect(persisted.state.appearance.v2SidebarRailScale).toBe(1.55);
    expect(persisted.state.appearance.tabEnvironmentAccentThickness).toBe(5);
    expect(persisted.state.appearance.sidebarSingleDatabaseExpansion).toBe(true);

    vi.resetModules();
    const reloaded = await importStore();
    const appearance = reloaded.useStore.getState().appearance;

    expect(appearance.showDataTableVerticalBorders).toBe(true);
    expect(appearance.showDataTableRowNumber).toBe(false);
    expect(appearance.dataTableDensity).toBe('compact');
    expect(appearance.tableDoubleClickAction).toBe('open-design');
    expect(appearance.queryTableCtrlClickAction).toBe('locate');
    expect(appearance.v2SidebarRailScale).toBe(1.55);
    expect(appearance.tabEnvironmentAccentThickness).toBe(5);
    expect(appearance.sidebarSingleDatabaseExpansion).toBe(true);
  });

  it('persists the optional workbench sidebar behavior in both directions', async () => {
    let store = (await importStore()).useStore;
    expect(store.getState().appearance.workbenchSidebarAutoCollapse).toBe(false);
    for (const enabled of [true, false]) {
      store.getState().setAppearance({ workbenchSidebarAutoCollapse: enabled });
      expect(JSON.parse(storage.getItem('lite-db-storage') || '{}').state.appearance.workbenchSidebarAutoCollapse).toBe(enabled);
      vi.resetModules();
      store = (await importStore()).useStore;
      expect(store.getState().appearance.workbenchSidebarAutoCollapse).toBe(enabled);
    }
  });

  it('persists custom favorite settings, their order and an intentionally empty selection', async () => {
    let store = (await importStore()).useStore;
    expect(store.getState().appearance.favoriteSettings).toContain('layout');
    const target = 'entry:fonts-settings/fonts-settings/app.theme.font_family.ui_title';
    for (const favoriteSettings of [[target, 'rows', 'density'], []]) {
      store.getState().setAppearance({ favoriteSettings });
      vi.resetModules();
      store = (await importStore()).useStore;
      expect(store.getState().appearance.favoriteSettings).toEqual(favoriteSettings);
    }
  });

  it('sanitizes invalid tab environment accent thickness values', async () => {
    const { useStore } = await importStore();

    useStore.getState().setAppearance({ tabEnvironmentAccentThickness: 6 });
    expect(useStore.getState().appearance.tabEnvironmentAccentThickness).toBe(6);

    useStore.getState().setAppearance({ tabEnvironmentAccentThickness: 7 });
    expect(useStore.getState().appearance.tabEnvironmentAccentThickness).toBe(2);

    useStore.getState().setAppearance({ tabEnvironmentAccentThickness: Number.NaN });
    expect(useStore.getState().appearance.tabEnvironmentAccentThickness).toBe(2);
    expect(JSON.parse(storage.getItem('lite-db-storage') || '{}').state.appearance.tabEnvironmentAccentThickness).toBe(2);
  });

  it('persists and sanitizes scoped toolbar button color overrides', async () => {
    const { useStore } = await importStore();

    useStore.getState().setAppearance({
      toolbarButtonColorOverrides: {
        query: {
          'button-fg': '#ABCDEF',
          'button-hover-bg': 'rgba(12, 34, 56, 0.4)',
          'button-disabled-border': '#778899',
        },
        result: {
          'primary-active-border': '#1234',
          'primary-disabled-fg': 'rgba(90, 80, 70, 0.6)',
          'button-bg': 'url(https://example.com/invalid)',
        },
      },
    });

    expect(useStore.getState().appearance.toolbarButtonColorOverrides).toEqual({
      query: {
        'button-fg': '#abcdef',
        'button-hover-bg': 'rgba(12, 34, 56, 0.4)',
        'button-disabled-border': '#778899',
      },
      result: {
        'primary-active-border': '#1234',
        'primary-disabled-fg': 'rgba(90, 80, 70, 0.6)',
      },
    });
    expect(
      JSON.parse(storage.getItem('lite-db-storage') || '{}').state.appearance
        .toolbarButtonColorOverrides,
    ).toEqual({
      query: {
        'button-fg': '#abcdef',
        'button-hover-bg': 'rgba(12, 34, 56, 0.4)',
        'button-disabled-border': '#778899',
      },
      result: {
        'primary-active-border': '#1234',
        'primary-disabled-fg': 'rgba(90, 80, 70, 0.6)',
      },
    });

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().appearance.toolbarButtonColorOverrides).toEqual({
      query: {
        'button-fg': '#abcdef',
        'button-hover-bg': 'rgba(12, 34, 56, 0.4)',
        'button-disabled-border': '#778899',
      },
      result: {
        'primary-active-border': '#1234',
        'primary-disabled-fg': 'rgba(90, 80, 70, 0.6)',
      },
    });
  });

  it('drops malformed toolbar overrides restored from an older snapshot', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        appearance: {
          toolbarButtonColorOverrides: {
            query: {
              'button-fg': 'var(--gn-accent)',
              'button-bg': '#112233',
              unknown: '#ffffff',
            },
            result: 'invalid',
            other: { 'button-fg': '#000000' },
          },
        },
      },
      version: 20,
    }));

    const { useStore } = await importStore();
    expect(useStore.getState().appearance.toolbarButtonColorOverrides).toEqual({
      query: { 'button-bg': '#112233' },
    });
  });

  it('migrates and sanitizes toolbar overrides from a version 19 snapshot', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        appearance: {
          toolbarButtonColorOverrides: {
            query: {
              'button-fg': '#ABCDEF',
              'button-bg': 'var(--gn-accent)',
            },
            result: {
              'primary-hover-border': 'rgba(12, 34, 56, 0.5)',
              unknown: '#ffffff',
            },
          },
        },
      },
      version: 19,
    }));

    const { useStore } = await importStore();
    expect(useStore.getState().appearance.toolbarButtonColorOverrides).toEqual({
      query: { 'button-fg': '#abcdef' },
      result: { 'primary-hover-border': 'rgba(12, 34, 56, 0.5)' },
    });
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

  it('persists the SQL execution log auto-show preference with an enabled default', async () => {
    const { useStore } = await importStore();
    expect(useStore.getState().queryOptions.autoShowSqlExecutionLog).toBe(true);

    useStore.getState().setQueryOptions({ autoShowSqlExecutionLog: false });
    expect(useStore.getState().queryOptions.autoShowSqlExecutionLog).toBe(false);

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.queryOptions.autoShowSqlExecutionLog).toBe(false);

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().queryOptions.autoShowSqlExecutionLog).toBe(false);
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
          queryTableCtrlClickAction: 'open-random',
        },
      },
      version: 10,
    }));

    const { useStore } = await importStore();
    expect(useStore.getState().appearance.tableDoubleClickAction).toBe('open-data');
    expect(useStore.getState().appearance.queryTableCtrlClickAction).toBe('open-design');
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

  it('persists the table alias preference and defaults invalid values to enabled', async () => {
    const { useStore } = await importStore();

    useStore.getState().setAppearance({ autoAddTableAlias: false });
    expect(JSON.parse(storage.getItem('lite-db-storage') || '{}').state.appearance.autoAddTableAlias).toBe(false);

    vi.resetModules();
    let reloaded = await importStore();
    expect(reloaded.useStore.getState().appearance.autoAddTableAlias).toBe(false);

    storage.setItem('lite-db-storage', JSON.stringify({
      state: { appearance: { autoAddTableAlias: 'disabled' } },
      version: 20,
    }));
    vi.resetModules();
    reloaded = await importStore();
    expect(reloaded.useStore.getState().appearance.autoAddTableAlias).toBe(true);
  });

  it('defaults new installs to the title bar and falls back missing fields to the same default', async () => {
    // 新用户：本地没有任何配置，使用标题栏 + 图标 + 精简名称（classic 默认）。
    const { useStore } = await importStore();

    expect(useStore.getState().appearance.titlebarActionsPlacement).toBe('toolbar');
    expect(useStore.getState().appearance.sidebarActionsPlacement).toBe('rail');
    expect(useStore.getState().appearance.uiLayoutMode).toBe('classic');

    useStore.getState().setAppearance({ titlebarActionsPlacement: 'toolbar', titlebarActionsDisplay: 'icon' });
    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}').state.appearance;
    expect(persisted.titlebarActionsPlacement).toBe('toolbar');

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().appearance.titlebarActionsPlacement).toBe('toolbar');
    expect(reloaded.useStore.getState().appearance.titlebarActionsDisplay).toBe('icon');

    // 老用户：已有配置但没有这些字段（或写入了未知值），回退到与新用户一致的标题栏默认。
    for (const appearance of [{ titlebarActionsPlacement: 'menu', titlebarActionsDisplay: 'emoji' }, {}]) {
      storage.setItem('lite-db-storage', JSON.stringify({ state: { appearance }, version: 21 }));
      vi.resetModules();
      const legacy = await importStore();
      expect(legacy.useStore.getState().appearance.titlebarActionsPlacement).toBe('toolbar');
      expect(legacy.useStore.getState().appearance.titlebarActionsDisplay).toBe('icon-text');
    }

    // Navicat 布局开关：持久化并在重启后保持。
    storage.setItem('lite-db-storage', JSON.stringify({
      state: { appearance: { uiLayoutMode: 'navicat' } },
      version: 22,
    }));
    vi.resetModules();
    const navicat = await importStore();
    expect(navicat.useStore.getState().appearance.uiLayoutMode).toBe('navicat');
  });

  it('keeps data grid and SQL editor typography slices when sanitizing appearance', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        appearance: {
          showDataTableVerticalBorders: true,
          showDataTableRowNumber: false,
          dataTableDensity: 'compact',
          dataTableFontSize: 13,
          dataTableFontSizeFollowGlobal: false,
          sidebarTreeFontSize: 15,
          sidebarTreeFontSizeFollowGlobal: false,
          sqlEditorFontSize: 16,
          sqlEditorFontSizeFollowGlobal: false,
        },
      },
      version: 21,
    }));
    const { useStore } = await importStore();

    expect(useStore.getState().appearance).toMatchObject({
      showDataTableVerticalBorders: true,
      showDataTableRowNumber: false,
      dataTableDensity: 'compact',
      dataTableFontSize: 13,
      dataTableFontSizeFollowGlobal: false,
      sidebarTreeFontSize: 15,
      sidebarTreeFontSizeFollowGlobal: false,
      sqlEditorFontSize: 16,
      sqlEditorFontSizeFollowGlobal: false,
      titlebarActionsPlacement: 'toolbar',
      titlebarActionsDisplay: 'icon-text',
    });
  });

  it('persists v2 sidebar search preferences and sanitizes filter text', async () => {
    const { useStore } = await importStore();

    useStore.getState().setAppearance({
      v2SidebarSearchMode: 'filter',
      v2SidebarPersistedFilter: `  ${'orders'.repeat(40)}  `,
    });

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.appearance.v2SidebarSearchMode).toBe('filter');
    expect(persisted.state.appearance).not.toHaveProperty('v2CommandSearchPersistentFilterEnabled');
    expect(persisted.state.appearance.v2SidebarPersistedFilter).toHaveLength(120);
    expect(persisted.state.appearance.v2SidebarPersistedFilter.startsWith('orders')).toBe(true);

    vi.resetModules();
    const reloaded = await importStore();
    const appearance = reloaded.useStore.getState().appearance;

    expect(appearance.v2SidebarSearchMode).toBe('filter');
    expect(appearance).not.toHaveProperty('v2CommandSearchPersistentFilterEnabled');
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

  it('preserves SSH host key verification metadata when replacing saved connections', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'ssh-host-key-1',
        name: 'SSH host key',
        config: {
          id: 'ssh-host-key-1',
          type: 'mysql',
          host: 'db.local',
          port: 3306,
          user: 'root',
          useSSH: true,
          ssh: {
            host: 'jump.local',
            port: 2222,
            user: 'ops',
            knownHostsPath: ' /home/user/.ssh/known_hosts ',
            hostKeyFingerprint: ' SHA256:pinned-host-key ',
          },
        },
      },
    ]);

    expect(useStore.getState().connections[0]?.config.ssh).toMatchObject({
      knownHostsPath: '/home/user/.ssh/known_hosts',
      hostKeyFingerprint: 'SHA256:pinned-host-key',
    });
  });

  it('normalizes Navicat HTTP tunnel URL and base64 settings', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'navicat-http-tunnel',
        name: 'Navicat HTTP tunnel',
        config: {
          id: 'navicat-http-tunnel',
          type: 'mysql',
          host: 'db.internal',
          port: 3306,
          user: 'root',
          useHttpTunnel: true,
          httpTunnel: {
            host: ' https://gateway.example.com/mysql/ntunnel_mysql.php ',
            port: 8080,
            encodeBase64: false,
          },
        },
      },
      {
        id: 'legacy-http-tunnel',
        name: 'Legacy HTTP tunnel',
        config: {
          id: 'legacy-http-tunnel',
          type: 'mysql',
          host: 'db.internal',
          port: 3306,
          user: 'root',
          useHttpTunnel: true,
          httpTunnel: {
            host: 'legacy-proxy.internal',
            port: 3128,
          },
        },
      },
    ]);

    expect(useStore.getState().connections[0]?.config.httpTunnel).toMatchObject({
      host: 'https://gateway.example.com/mysql/ntunnel_mysql.php',
      port: 8080,
      encodeBase64: false,
    });
    expect(useStore.getState().connections[1]?.config.httpTunnel).toMatchObject({
      host: 'legacy-proxy.internal',
      port: 3128,
      encodeBase64: true,
    });
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
});


describe('saved-query delete menu completion', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each(['pending', 'failed', 'delete-failed'] as const)('completes the actual delete menu with %s backend reads', async (mode) => {
    const { useStore } = await importStore();
    const backendResolver = await import('./store/storeConnectionSanitizers');
    const { buildSavedQueryMenuItems } = await import('./components/sidebar/sidebarNodeMenuSavedQueries');
    const { default: Modal } = await import('./components/common/ResizableDraggableModal');
    const { message } = await import('antd');
    const { t } = await import('./i18n');
    const query = { id: 'menu-last', name: 'Last query', sql: 'select 1', connectionId: 'menu-conn', dbName: 'app', createdAt: 1 };
    const connections = [{ id: 'menu-conn', name: 'Menu connection', config: { type: 'mysql', host: 'db.local', port: 3306 } }] as Parameters<typeof buildAllSavedQueriesTreeNode>[1];
    const group = { id: 'menu-manual', name: 'Manual', queryIds: [query.id], childOrder: [`query:${query.id}`] };
    const groups = mode === 'delete-failed' ? [group] : [];
    let release!: (groups: []) => void;
    const pending = new Promise<[]>(resolve => { release = resolve; });
    const GetSavedQueryGroups = vi.fn(() => mode === 'pending' ? pending : Promise.reject(new Error('group refresh failed')));
    const DeleteQuery = vi.fn(async () => {
      if (mode === 'delete-failed') throw new Error('delete failed');
    });
    vi.spyOn(backendResolver, 'resolveSavedQueryBackend').mockReturnValue({ DeleteQuery, GetSavedQueryGroups });
    useStore.setState({ connections, savedQueries: [query], savedQueryGroups: groups });
    let config!: Parameters<typeof Modal.confirm>[0];
    vi.spyOn(Modal, 'confirm').mockImplementation(input => { config = input; return { destroy: vi.fn(), update: vi.fn() }; });
    const errorToast = vi.spyOn(message, 'error').mockImplementation(() => (() => undefined) as ReturnType<typeof message.error>);
    const successToast = vi.spyOn(message, 'success').mockImplementation(() => (() => undefined) as ReturnType<typeof message.success>);
    const tree = buildAllSavedQueriesTreeNode([query], connections, groups)!;
    const setTreeData = vi.fn();
    const context = {
      savedQueryGroups: groups, connections, isSavedQueryUnmatched: () => false,
      deleteQuery: useStore.getState().deleteQuery,
      resolveSavedQueryDisplayName: (name: string) => name,
      treeDataRef: { current: [tree] }, setTreeData,
    } as Parameters<typeof buildSavedQueryMenuItems>[0]['context'];
    const items = buildSavedQueryMenuItems({ node: { dataRef: query }, context });
    const item = items?.find(item => item && 'key' in item && item.key === 'delete-query');
    if (!item || !('onClick' in item) || !item.onClick) throw new Error('delete menu missing');
    item.onClick({} as Parameters<NonNullable<typeof item.onClick>>[0]);
    let settled = false;
    const outcome = Promise.resolve(config.onOk!()).then(() => { settled = true; return null; }, error => { settled = true; return error; });
    let settledWithoutRefresh = false;
    try {
      await vi.waitFor(() => expect(settled || GetSavedQueryGroups.mock.calls.length > 0).toBe(true));
      settledWithoutRefresh = settled;
    } finally { release([]); }
    const error = await outcome;
    expect(DeleteQuery).toHaveBeenCalledWith(query.id);
    expect(useStore.getState().connections).toEqual(connections);
    expect(GetSavedQueryGroups).not.toHaveBeenCalled();
    expect(settledWithoutRefresh).toBe(true);
    if (mode === 'delete-failed') {
      expect(error).toBeInstanceOf(Error);
      expect(useStore.getState().savedQueries).toEqual([query]);
      expect(useStore.getState().savedQueryGroups).toEqual(groups);
      expect(errorToast).toHaveBeenCalledWith(t('sidebar.message.saved_query_delete_failed', { error: 'delete failed' }));
      expect(successToast).not.toHaveBeenCalled();
      expect(setTreeData).not.toHaveBeenCalled();
    } else {
      expect(error).toBeNull();
      expect(useStore.getState().savedQueries).toEqual([]);
      expect(buildAllSavedQueriesTreeNode(useStore.getState().savedQueries, connections, [])).toBeNull();
      expect(context.treeDataRef.current).toEqual([]);
      expect(setTreeData).toHaveBeenCalledWith([]);
      expect(successToast).toHaveBeenCalledWith(t('sidebar.message.saved_query_deleted'));
      expect(errorToast).not.toHaveBeenCalled();
    }
  });

  it('keeps newer query and group state when a pending deletion finishes', async () => {
    const { useStore } = await importStore();
    const backendResolver = await import('./store/storeConnectionSanitizers');
    const deleted = { id: 'concurrent-delete', name: 'Delete', sql: 'select 1', connectionId: 'menu-conn', dbName: 'app', createdAt: 1 };
    const added = { ...deleted, id: 'concurrent-added', name: 'New query' };
    const group = { id: 'concurrent-group', name: 'New group', queryIds: [added.id], childOrder: [`query:${added.id}`] };
    let finishDelete!: () => void;
    const GetSavedQueryGroups = vi.fn(async () => []);
    vi.spyOn(backendResolver, 'resolveSavedQueryBackend').mockReturnValue({
      DeleteQuery: vi.fn(() => new Promise<void>(resolve => { finishDelete = resolve; })),
      GetSavedQueryGroups, SaveQuery: vi.fn(async query => query),
    });
    useStore.setState({ savedQueries: [deleted], savedQueryGroups: [] });
    const deleting = useStore.getState().deleteQuery(deleted.id);
    await useStore.getState().saveQuery(added);
    useStore.getState().replaceSavedQueryGroups([group]);
    finishDelete();
    await deleting;
    expect(useStore.getState().savedQueries).toEqual([added]);
    expect(useStore.getState().savedQueryGroups).toMatchObject([group]);
    expect(GetSavedQueryGroups).not.toHaveBeenCalled();
  });
});
