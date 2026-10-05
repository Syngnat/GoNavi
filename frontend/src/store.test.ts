import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIDEBAR_RESIZE_MAX_WIDTH } from './utils/sidebarLayout';

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
    expect(appearance.autoAddTableAlias).toBe(true);
    expect(appearance.customTableAliasPrefixEnabled).toBe(false);
    expect(appearance.customTableAliasPrefix).toBe('');
    expect(appearance.tabDisplay).toEqual({
      layout: 'double',
      primaryElements: ['object'],
      secondaryElements: ['kind', 'connection', 'database'],
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
    expect(migrated.useStore.getState().appearance.tabDisplay).toEqual({
      layout: 'double',
      primaryElements: ['object'],
      secondaryElements: ['kind', 'connection', 'database'],
    });
    expect(JSON.parse(storage.getItem('lite-db-storage') || '{}').version).toBe(21);

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
    expect(persisted.version).toBe(21);
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

  it('defaults new installs to the title bar and keeps upgraded users on the toolbar', async () => {
    // 新用户：本地没有任何配置，使用标题栏 + 图标 + 精简名称。
    const { useStore } = await importStore();

    expect(useStore.getState().appearance.titlebarActionsPlacement).toBe('titlebar');
    expect(useStore.getState().appearance.titlebarActionsDisplay).toBe('icon-text');

    useStore.getState().setAppearance({ titlebarActionsPlacement: 'toolbar', titlebarActionsDisplay: 'icon' });
    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}').state.appearance;
    expect(persisted.titlebarActionsPlacement).toBe('toolbar');
    expect(persisted.titlebarActionsDisplay).toBe('icon');

    vi.resetModules();
    let reloaded = await importStore();
    expect(reloaded.useStore.getState().appearance.titlebarActionsPlacement).toBe('toolbar');
    expect(reloaded.useStore.getState().appearance.titlebarActionsDisplay).toBe('icon');

    // 老用户：已有配置但没有这些字段（或写入了未知值），保持升级前的工具条，切到标题栏时默认纯文字。
    for (const appearance of [{ titlebarActionsPlacement: 'menu', titlebarActionsDisplay: 'emoji' }, {}]) {
      storage.setItem('lite-db-storage', JSON.stringify({ state: { appearance }, version: 21 }));
      vi.resetModules();
      reloaded = await importStore();
      expect(reloaded.useStore.getState().appearance.titlebarActionsPlacement).toBe('toolbar');
      expect(reloaded.useStore.getState().appearance.titlebarActionsDisplay).toBe('text');
    }
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
      titlebarActionsDisplay: 'text',
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
