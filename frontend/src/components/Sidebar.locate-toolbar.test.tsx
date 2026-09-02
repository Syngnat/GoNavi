import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRenderer as createShallowRenderer } from 'react-test-renderer/shallow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readV2ThemeCss } from '../test/readV2ThemeCss';

import Sidebar, {
  applySidebarDatabasePinning,
  buildAllSavedQueriesTreeNode,
  buildSidebarConnectionTagTree,
  buildSidebarTableChildrenForUi,
  buildV2SidebarDatabaseSectionedChildren,
  buildV2SidebarTableSectionedChildren,
  buildSQLFileExecutionFooter,
  buildV2RailConnectionGroups,
  estimateV2TreeHorizontalScrollWidth,
  filterV2CommandSearchTreeItems,
  filterV2ExplorerTreeByKind,
  getV2RailConnectionGroupBadgeText,
  hasSidebarLazyChildren,
  isSidebarDatabasePinned,
  isConnectionTagDescendant,
  normalizeSidebarTreeRelativeDropPosition,
  parseV2CommandSearchQuery,
  type V2CommandSearchItem,
  resolveSidebarDropNodeFromDomEvent,
  resolveSidebarDropDomHit,
  resolveSidebarHostGroupDropDestination,
  resolveSidebarTagDropInsertBefore,
  resolveSidebarDropTargetMetricsFromDomEvent,
  resolveSidebarDropInsertBefore,
  resolveSidebarTreeDropPlacement,
  resolveSidebarNodeConnectionId,
  resolveSidebarSwitcherLoadKey,
  resolveV2ActiveConnectionId,
  resolveV2ObjectGroupTitle,
  isSidebarTablePinned,
  SQLFileExecutionProgressContent,
  V2ExplorerContextSummary,
  resolveSidebarTableNameForCopy,
  resolveSidebarDatabaseNameForCopy,
  shouldKeepSidebarSwitcherCollapsedWhileLoading,
  shouldClearSidebarActiveContextOnEmptySelect,
  shouldSkipSidebarLoadOnExpandWhileDragging,
  shouldSkipSidebarSelectWhileDragging,
  shouldLoadSidebarNodeOnExpand,
  shouldCloseV2CommandSearchOnGlobalKey,
  shouldRunV2CommandSearchEnter,
  sortSidebarTableEntries,
} from './Sidebar';
import {
  buildSearchScopeOptions as buildCoreSearchScopeOptions,
  SEARCH_SCOPE_OPTIONS as CORE_SEARCH_SCOPE_OPTIONS,
} from './sidebarCoreUtils';
import {
  buildSidebarTableChildrenForUi as buildV2UtilsSidebarTableChildrenForUi,
  buildV2ExplorerFilterOptions,
  buildV2SidebarTableSectionedChildren as buildV2UtilsSidebarTableSectionedChildren,
  V2_EXPLORER_FILTER_OPTIONS as V2_UTILS_EXPLORER_FILTER_OPTIONS,
} from './sidebarV2Utils';
import {
  buildSidebarDatabasePinKey,
  buildSidebarRootConnectionToken,
  buildSidebarRootTagToken,
  buildSidebarTablePinKey,
} from '../store';
import { renderSidebarV2TreeTitle } from './sidebar/SidebarTreeTitle';
import { buildSidebarTableStatusSQL } from './sidebar/sidebarMetadataLoaders';
import {
  DEFAULT_SHORTCUT_OPTIONS,
  cloneShortcutOptions,
} from '../utils/shortcuts';
import { SUPPORTED_LANGUAGES, getCurrentLanguage, setCurrentLanguage, t } from '../i18n';
import { I18nProvider } from '../i18n/provider';
import {
  V2ConnectionGroupContextMenuView,
  V2ConnectionContextMenuView,
  V2DatabaseContextMenuView,
  V2SchemaContextMenuView,
  V2TableContextMenuView,
  V2TableGroupContextMenuView,
  formatV2TableContextMenuRows,
  formatV2TableContextMenuSize,
} from './V2TableContextMenu';

const readSourceFile = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const readCssRuleBlock = (css: string, selector: string) => {
  const match = css.match(new RegExp(`${escapeRegExp(selector)}\\s*\\{(?<body>[^}]*)\\}`, 's'));
  expect(match, `Missing CSS rule for ${selector}`).not.toBeNull();
  return match?.groups?.body ?? '';
};
const readSidebarSource = () => [
  readSourceFile('./Sidebar.tsx'),
  readSourceFile('./sidebar/sidebarHelpers.ts'),
  readSourceFile('./sidebar/SidebarConnectionRail.tsx'),
  readSourceFile('./sidebar/SidebarSearchPanel.tsx'),
  readSourceFile('./sidebar/sidebarLegacyNodeMenu.tsx'),
  readSourceFile('./sidebar/sidebarMetadataLoaders.ts'),
  readSourceFile('./sidebar/useSidebarBatchExport.ts'),
  readSourceFile('./sidebar/SidebarExternalSqlWorkflow.tsx'),
  readSourceFile('./sidebar/useSidebarTreeLoaders.tsx'),
  readSourceFile('./sidebar/SidebarEntityModals.tsx'),
  readSourceFile('./sidebar/SidebarTreeTitle.tsx'),
  readSourceFile('./sidebar/useSidebarV2ContextMenu.tsx'),
  readSourceFile('./sidebar/useSidebarObjectActions.tsx'),
  readSourceFile('./sidebar/useSidebarSearchModel.tsx'),
  readSourceFile('./sidebar/useSidebarV2ActionHandlers.tsx'),
  readSourceFile('./sidebar/useSidebarCommandSearchRunner.ts'),
  readSourceFile('./sidebar/useSidebarTitleRender.tsx'),
  readSourceFile('./sidebarV2Utils.ts'),
].join('\n');
const readLegacyNodeMenuSource = () => readSourceFile('./sidebar/sidebarLegacyNodeMenu.tsx');

const mocks = vi.hoisted(() => ({
  noop: vi.fn(),
  state: {
    connections: [] as any[],
    activeContext: null as any,
    activeTabId: 'conn-1-main-users',
    tabs: [{
      id: 'conn-1-main-users',
      title: 'users',
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'users',
    }] as any[],
    connectionTags: [] as any[],
    appearance: {
      enabled: true,
      opacity: 1,
      blur: 0,
      uiVersion: 'legacy',
      sidebarHiddenObjectGroups: [],
    } as any,
    shortcutOptions: null as any,
  },
}));

vi.mock('../store', () => ({
  buildSidebarDatabasePinKey: (
    connectionId: string,
    dbName: string,
  ) => JSON.stringify([connectionId.trim(), dbName.trim()]),
  buildSidebarRootConnectionToken: (connectionId: string) => `connection:${connectionId.trim()}`,
  buildSidebarRootTagToken: (tagId: string) => `tag:${tagId.trim()}`,
  resolveConnectionTagChildOrder: (
    tagId: string,
    connectionTags: Array<{ id: string; parentTagId?: string; connectionIds: string[]; childOrder?: string[] }>,
  ) => {
    const tag = connectionTags.find((candidate) => candidate.id === tagId);
    if (!tag) return [];
    const fallback = [
      ...tag.connectionIds.map((connectionId) => `connection:${connectionId}`),
      ...connectionTags
        .filter((candidate) => candidate.parentTagId === tagId)
        .map((candidate) => `tag:${candidate.id}`),
    ];
    const valid = new Set(fallback);
    const seen = new Set<string>();
    return [...(tag.childOrder || []), ...fallback].filter((token) => {
      if (!valid.has(token) || seen.has(token)) return false;
      seen.add(token);
      return true;
    });
  },
  resolveSidebarRootOrderTokens: (
    sidebarRootOrder: unknown,
    connectionTags: Array<{ id: string; parentTagId?: string; connectionIds: string[] }>,
    connections: Array<{ id: string }>,
  ) => {
    const groupedConnectionIds = new Set<string>();
    connectionTags.forEach((tag) => tag.connectionIds.forEach((id) => groupedConnectionIds.add(id)));
    const fallback = [
      ...connectionTags.filter((tag) => !tag.parentTagId).map((tag) => `tag:${tag.id}`),
      ...connections
        .filter((conn) => !groupedConnectionIds.has(conn.id))
        .map((conn) => `connection:${conn.id}`),
    ];
    const valid = new Set(fallback);
    const normalized = Array.isArray(sidebarRootOrder)
      ? sidebarRootOrder
        .map((item) => String(item ?? '').trim())
        .filter((item) => valid.has(item))
      : [];
    const seen = new Set<string>();
    const result: string[] = [];
    [...normalized, ...fallback].forEach((token) => {
      if (!token || seen.has(token)) return;
      seen.add(token);
      result.push(token);
    });
    return result;
  },
  buildSidebarTablePinKey: (
    connectionId: string,
    dbName: string,
    tableName: string,
    schemaName = '',
  ) => JSON.stringify([
    connectionId.trim(),
    dbName.trim(),
    schemaName.trim(),
    tableName.trim(),
  ]),
  updateSidebarDatabasePinKeys: (
    pinnedKeys: string[],
    connectionId: string,
    dbName: string,
    pinned: boolean,
  ) => {
    const key = JSON.stringify([connectionId.trim(), dbName.trim()]);
    const next = new Set(pinnedKeys);
    if (pinned) next.add(key);
    else next.delete(key);
    return Array.from(next);
  },
  useStore: (selector: (state: any) => any) => selector({
    connections: mocks.state.connections,
    savedQueries: [],
    savedQueryGroups: [],
    externalSQLDirectories: [],
    saveQuery: mocks.noop,
    deleteQuery: mocks.noop,
    saveSavedQueryGroup: mocks.noop,
    deleteSavedQueryGroup: mocks.noop,
    moveSavedQueryToGroup: mocks.noop,
    reloadSavedQueryGroups: mocks.noop,
    saveExternalSQLDirectory: mocks.noop,
    deleteExternalSQLDirectory: mocks.noop,
    addConnection: mocks.noop,
    addTab: mocks.noop,
    updateQueryTabDraft: mocks.noop,
    tabs: mocks.state.tabs,
    activeTabId: mocks.state.activeTabId,
    setActiveContext: mocks.noop,
    removeConnection: mocks.noop,
    connectionTags: mocks.state.connectionTags,
    sidebarRootOrder: [],
    addConnectionTag: mocks.noop,
    updateConnectionTag: mocks.noop,
    removeConnectionTag: mocks.noop,
    moveConnectionToTag: mocks.noop,
    moveConnectionTag: mocks.noop,
    reorderConnections: mocks.noop,
    reorderTags: mocks.noop,
    reorderSidebarRoot: mocks.noop,
    closeTabsByConnection: mocks.noop,
    closeTabsByDatabase: mocks.noop,
    theme: 'light',
    appearance: mocks.state.appearance,
    activeContext: mocks.state.activeContext,
    tableAccessCount: {},
    tableSortPreference: {},
    pinnedSidebarTables: [],
    pinnedSidebarDatabases: [],
    recordTableAccess: mocks.noop,
    setTableSortPreference: mocks.noop,
    setSidebarTablePinned: mocks.noop,
    setSidebarDatabasePinned: mocks.noop,
    queryOptions: { showSidebarTableComment: false },
    setQueryOptions: mocks.noop,
    addSqlLog: mocks.noop,
    sqlLogs: [],
    shortcutOptions: mocks.state.shortcutOptions ?? cloneShortcutOptions(DEFAULT_SHORTCUT_OPTIONS),
    setAIPanelVisible: mocks.noop,
    addAIContext: mocks.noop,
  }),
}));

vi.mock('../../wailsjs/go/app/App', () => ({
  DBGetDatabases: mocks.noop,
  DBGetTables: mocks.noop,
  DBQuery: mocks.noop,
  DBShowCreateTable: mocks.noop,
  DBReleaseConnection: mocks.noop,
  ExportTable: mocks.noop,
  OpenSQLFile: mocks.noop,
  ExecuteSQLFile: mocks.noop,
  CancelSQLFileExecution: mocks.noop,
  CreateDatabase: mocks.noop,
  CreateSchema: mocks.noop,
  RenameDatabase: mocks.noop,
  DropDatabase: mocks.noop,
  RenameTable: mocks.noop,
  DropTable: mocks.noop,
  DropView: mocks.noop,
  DropFunction: mocks.noop,
  RenameView: mocks.noop,
  SelectSQLDirectory: mocks.noop,
  ListSQLDirectory: mocks.noop,
  ReadSQLFile: mocks.noop,
  CreateSQLFile: mocks.noop,
  CreateSQLDirectory: mocks.noop,
  DeleteSQLFile: mocks.noop,
  DeleteSQLDirectory: mocks.noop,
  RenameSQLFile: mocks.noop,
  RenameSQLDirectory: mocks.noop,
  JVMProbeCapabilities: mocks.noop,
  GetDriverStatusList: mocks.noop,
}));

vi.mock('../../wailsjs/runtime/runtime', () => ({
  EventsOn: mocks.noop,
}));

vi.mock('../utils/appearance', async () => {
  const actual = await vi.importActual<typeof import('../utils/appearance')>('../utils/appearance');
  return {
    ...actual,
    isMacLikePlatform: () => true,
  };
});

type SidebarTestLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const renderSidebarMarkup = (
  props: React.ComponentProps<typeof Sidebar> = {},
  language: SidebarTestLanguage = getCurrentLanguage(),
) => renderToStaticMarkup(
  <I18nProvider
    preference={language}
    systemLanguages={[language]}
    onPreferenceChange={() => undefined}
  >
    <Sidebar {...props} />
  </I18nProvider>,
);

describe('Sidebar locate toolbar', () => {
  beforeEach(() => {
    setCurrentLanguage('zh-CN');
    mocks.state.connections = [];
    mocks.state.activeContext = null;
    mocks.state.activeTabId = 'conn-1-main-users';
    mocks.state.tabs = [{
      id: 'conn-1-main-users',
      title: 'users',
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'users',
    }];
    mocks.state.connectionTags = [];
    mocks.state.appearance = {
      enabled: true,
      opacity: 1,
      blur: 0,
      uiVersion: 'legacy',
      sidebarHiddenObjectGroups: [],
    };
    mocks.state.shortcutOptions = cloneShortcutOptions(DEFAULT_SHORTCUT_OPTIONS);
  });

  it('resolves the table name used by the sidebar copy action', () => {
    expect(resolveSidebarTableNameForCopy({
      title: 'users',
      dataRef: { tableName: 'public.users' },
    })).toBe('public.users');
    expect(resolveSidebarTableNameForCopy({
      title: 'v_users',
      dataRef: { viewName: 'reporting.v_users' },
    })).toBe('reporting.v_users');
    expect(resolveSidebarTableNameForCopy({
      title: 'users',
      dataRef: {},
    })).toBe('users');
    expect(resolveSidebarTableNameForCopy({
      title: 'display topic',
      dataRef: {
        messageObjectName: 'devices/+/telemetry',
        tableName: 'legacy-topic-name',
      },
    })).toBe('devices/+/telemetry');
  });

  it('treats empty lazy children as unloaded for sidebar expansion', () => {
    expect(hasSidebarLazyChildren(undefined)).toBe(false);
    expect(hasSidebarLazyChildren([])).toBe(false);
    expect(hasSidebarLazyChildren([{ key: 'child', title: 'child' }])).toBe(true);
    expect(shouldLoadSidebarNodeOnExpand({ type: 'database', children: [] })).toBe(true);
    expect(shouldLoadSidebarNodeOnExpand({ type: 'database', children: [{ key: 'tables', title: '表' }] })).toBe(false);
    expect(shouldLoadSidebarNodeOnExpand({ type: 'message-namespace', children: [] })).toBe(true);
    expect(shouldLoadSidebarNodeOnExpand({ type: 'object-group', children: [] })).toBe(false);
  });

  it('keeps sidebar switchers collapsed while lazy loading is still pending', () => {
    const connectionNode = {
      key: 'conn-1',
      data: {
        key: 'conn-1',
        title: '开发240',
        type: 'connection' as const,
        dataRef: { id: 'conn-1' },
      },
      expanded: true,
    };
    const databaseNode = {
      key: 'conn-1-main',
      data: {
        key: 'conn-1-main',
        title: 'main',
        type: 'database' as const,
        dataRef: { id: 'conn-1', dbName: 'main' },
      },
      expanded: true,
    };
    const messageNamespaceNode = {
      key: 'conn-1-topics',
      data: {
        key: 'conn-1-topics',
        title: 'Topics',
        type: 'message-namespace' as const,
        dataRef: { id: 'conn-1', dbName: 'topics' },
      },
      expanded: true,
    };

    expect(resolveSidebarSwitcherLoadKey(connectionNode)).toBe('dbs-conn-1');
    expect(resolveSidebarSwitcherLoadKey(databaseNode)).toBe('tables-conn-1-main');
    expect(resolveSidebarSwitcherLoadKey(messageNamespaceNode)).toBe('tables-conn-1-topics');
    expect(shouldKeepSidebarSwitcherCollapsedWhileLoading(connectionNode, new Set(['dbs-conn-1']))).toBe(true);
    expect(shouldKeepSidebarSwitcherCollapsedWhileLoading(databaseNode, new Set(['tables-conn-1-main']))).toBe(true);
    expect(shouldKeepSidebarSwitcherCollapsedWhileLoading({
      key: 'table-users',
      data: {
        key: 'table-users',
        title: 'users',
        type: 'table' as const,
        dataRef: { id: 'conn-1', dbName: 'main', tableName: 'users' },
      },
      loading: true,
    }, new Set())).toBe(true);
    expect(shouldKeepSidebarSwitcherCollapsedWhileLoading(databaseNode, new Set())).toBe(false);
  });

  it('parses v2 command search prefixes into real search modes', () => {
    expect(parseV2CommandSearchQuery('@ payment_order')).toMatchObject({
      mode: 'object',
      keyword: 'payment_order',
      normalizedKeyword: 'payment_order',
      aiPrompt: '',
    });
    expect(parseV2CommandSearchQuery('＠fs_mkefu_server_info')).toMatchObject({
      mode: 'object',
      keyword: 'fs_mkefu_server_info',
    });
    expect(parseV2CommandSearchQuery('? 帮我分析订单表')).toMatchObject({
      mode: 'ai',
      keyword: '帮我分析订单表',
      normalizedKeyword: '帮我分析订单表',
      aiPrompt: '帮我分析订单表',
    });
    expect(parseV2CommandSearchQuery('payment')).toMatchObject({
      mode: 'default',
      keyword: 'payment',
      normalizedKeyword: 'payment',
    });
  });

  it('only runs v2 command search enter for a real selected result outside IME composition', () => {
    expect(shouldRunV2CommandSearchEnter({
      key: 'Enter',
      activeItemCount: 1,
    })).toBe(true);
    expect(shouldRunV2CommandSearchEnter({
      key: 'Enter',
      isComposing: true,
      activeItemCount: 1,
    })).toBe(false);
    expect(shouldRunV2CommandSearchEnter({
      key: 'Enter',
      keyCode: 229,
      activeItemCount: 1,
    })).toBe(false);
    expect(shouldRunV2CommandSearchEnter({
      key: 'Enter',
      activeItemCount: 0,
    })).toBe(false);
    expect(shouldRunV2CommandSearchEnter({
      key: 'Escape',
      activeItemCount: 1,
    })).toBe(false);
  });

  it('closes v2 command search on global escape only while the palette is open', () => {
    expect(shouldCloseV2CommandSearchOnGlobalKey({
      key: 'Escape',
      isOpen: true,
    })).toBe(true);

    expect(shouldCloseV2CommandSearchOnGlobalKey({
      key: 'Esc',
      isOpen: true,
    })).toBe(true);

    expect(shouldCloseV2CommandSearchOnGlobalKey({
      key: 'Escape',
      isOpen: false,
    })).toBe(false);

    expect(shouldCloseV2CommandSearchOnGlobalKey({
      key: 'Enter',
      isOpen: true,
    })).toBe(false);
  });

  it('keeps all loaded v2 command table matches once a keyword is entered', () => {
    const items: V2CommandSearchItem[] = Array.from({ length: 40 }, (_, index) => ({
      key: `node-table-${index}`,
      kind: 'node' as const,
      title: `fs_order_${index}`,
      meta: '开发240 · front_end_sys',
      icon: null,
      node: {
        type: 'table',
        key: `table-${index}`,
        title: `fs_order_${index}`,
        dataRef: {
          tableName: `fs_order_${index}`,
          dbName: 'front_end_sys',
        },
      },
    }));

    expect(filterV2CommandSearchTreeItems(
      items,
      parseV2CommandSearchQuery('fs_order'),
    )).toHaveLength(40);
    expect(filterV2CommandSearchTreeItems(
      items,
      parseV2CommandSearchQuery(''),
    )).toHaveLength(24);
    expect(filterV2CommandSearchTreeItems(
      [
        ...items,
        {
          key: 'node-db',
          kind: 'node' as const,
          title: 'front_end_sys',
          meta: '开发240',
          icon: null,
          node: {
            type: 'database',
            key: 'db-front-end-sys',
            title: 'front_end_sys',
            dataRef: {
              dbName: 'front_end_sys',
            },
          },
        },
      ],
      parseV2CommandSearchQuery('@fs_order'),
    )).toHaveLength(40);
  });

  it('keeps the v2 active host on the selected database connection', () => {
    const connectionIds = ['local', 'dev240', 'dev241'];
    const databaseNode = {
      key: 'dev240-manage_admin',
      dataRef: {
        id: 'dev240',
        dbName: 'manage_admin',
      },
    };

    expect(resolveSidebarNodeConnectionId(databaseNode, connectionIds)).toBe('dev240');
    expect(resolveV2ActiveConnectionId({
      activeContextConnectionId: '',
      activeTabConnectionId: 'local',
      selectedKeys: [databaseNode.key],
      connectionIds,
    })).toBe('dev240');
  });

  it('keeps the v2 active host on the pinned rail connection after tree deselect', () => {
    expect(resolveV2ActiveConnectionId({
      activeContextConnectionId: '',
      activeTabConnectionId: 'local',
      selectedKeys: [],
      connectionIds: ['local', 'dev240', 'dev241'],
      fallbackConnectionId: 'dev240',
    })).toBe('dev240');
  });

  it('keeps the v2 active host empty when nothing is selected', () => {
    expect(resolveV2ActiveConnectionId({
      activeContextConnectionId: '',
      activeTabConnectionId: '',
      selectedKeys: [],
      connectionIds: ['local', 'dev240', 'dev241'],
    })).toBe('');
  });

  it('does not clear v2 active context when rc-tree emits an empty deselect', () => {
    expect(shouldClearSidebarActiveContextOnEmptySelect(true)).toBe(false);
    expect(shouldClearSidebarActiveContextOnEmptySelect(false)).toBe(true);
  });

  it('builds v2 rail groups from existing connection tags while preserving ungrouped hosts', () => {
    const connections = [
      { id: 'dev240', name: 'dev240', config: { type: 'mysql', host: '10.0.0.240' } },
      { id: 'dev241', name: 'dev241', config: { type: 'postgres', host: '10.0.0.241' } },
      { id: 'local', name: 'local', config: { type: 'mysql', host: 'localhost' } },
    ] as any[];

    const groups = buildV2RailConnectionGroups(
      connections,
      [{
        id: 'prod',
        name: '生产环境',
        connectionIds: ['dev241', 'missing', 'dev240'],
      }],
      [
        buildSidebarRootConnectionToken('local'),
        buildSidebarRootTagToken('prod'),
      ],
    );

    expect(groups.map((group) => ({
      id: group.id,
      name: group.name,
      isUngrouped: group.isUngrouped,
      rootToken: group.rootToken,
      connectionIds: group.connections.map((conn) => conn.id),
    }))).toEqual([
      {
        id: 'local',
        name: 'local',
        isUngrouped: true,
        rootToken: buildSidebarRootConnectionToken('local'),
        connectionIds: ['local'],
      },
      {
        id: 'prod',
        name: '生产环境',
        isUngrouped: undefined,
        rootToken: buildSidebarRootTagToken('prod'),
        connectionIds: ['dev241', 'dev240'],
      },
    ]);
    expect(getV2RailConnectionGroupBadgeText('Production')).toBe('PR');
    expect(getV2RailConnectionGroupBadgeText('生产环境')).toBe('生');
  });

  it('builds arbitrarily nested host groups with mixed host and subgroup order', () => {
    const connections = [
      'host1', 'host2', 'host3', 'host4', 'host5', 'host6',
    ].map((id) => ({ id, name: id, config: { type: 'mysql', host: `${id}.local` } })) as any[];
    const tags = [
      {
        id: 'group-1',
        name: '分组1',
        connectionIds: ['host1', 'host2'],
        childOrder: ['connection:host1', 'connection:host2', 'tag:group-1-1'],
      },
      {
        id: 'group-1-1',
        name: '分组1-1',
        parentTagId: 'group-1',
        connectionIds: ['host3', 'host4'],
        childOrder: ['connection:host3', 'connection:host4', 'tag:group-1-1-1'],
      },
      {
        id: 'group-1-1-1',
        name: '分组1-1-1',
        parentTagId: 'group-1-1',
        connectionIds: ['host5', 'host6'],
        childOrder: ['connection:host5', 'connection:host6'],
      },
    ] as any[];

    const outline = (items: ReturnType<typeof buildSidebarConnectionTagTree>): unknown[] => items.map((item) => (
      item.kind === 'connection'
        ? item.id
        : { id: item.id, children: outline(item.children) }
    ));

    expect(outline(buildSidebarConnectionTagTree(connections, tags, ['tag:group-1']))).toEqual([
      {
        id: 'group-1',
        children: [
          'host1',
          'host2',
          {
            id: 'group-1-1',
            children: [
              'host3',
              'host4',
              { id: 'group-1-1-1', children: ['host5', 'host6'] },
            ],
          },
        ],
      },
    ]);
    expect(isConnectionTagDescendant('group-1', 'group-1-1-1', tags)).toBe(true);
    expect(isConnectionTagDescendant('group-1-1', 'group-1', tags)).toBe(false);
  });

  it('keeps sibling group token order even when legacy automatic modes are present', () => {
    const tags = [
      { id: 'parent', name: 'Parent', sortMode: 'name', connectionIds: [], childOrder: ['tag:child-z', 'tag:child-a'] },
      { id: 'child-z', name: 'Zebra child', createdAt: 2, parentTagId: 'parent', connectionIds: [] },
      { id: 'child-a', name: 'Alpha child', createdAt: 1, parentTagId: 'parent', connectionIds: [] },
      { id: 'root-z', name: 'Zebra root', createdAt: 2, connectionIds: [] },
      { id: 'root-a', name: 'Alpha root', createdAt: 1, connectionIds: [] },
    ] as any[];
    const outline = (items: ReturnType<typeof buildSidebarConnectionTagTree>): unknown[] => items.map((item) => (
      item.kind === 'connection' ? item.id : { id: item.id, children: outline(item.children) }
    ));

    expect(outline(buildSidebarConnectionTagTree([], tags, ['tag:root-z', 'tag:parent', 'tag:root-a'], 'manual'))).toEqual([
      { id: 'root-z', children: [] },
      { id: 'parent', children: [{ id: 'child-z', children: [] }, { id: 'child-a', children: [] }] },
      { id: 'root-a', children: [] },
    ]);
    expect(outline(buildSidebarConnectionTagTree([], tags, ['tag:root-z', 'tag:parent', 'tag:root-a'], 'name'))).toEqual([
      { id: 'root-z', children: [] },
      { id: 'parent', children: [{ id: 'child-z', children: [] }, { id: 'child-a', children: [] }] },
      { id: 'root-a', children: [] },
    ]);
    expect(outline(buildSidebarConnectionTagTree([], tags, ['tag:root-a', 'tag:parent', 'tag:root-z'], 'createdAt'))).toEqual([
      { id: 'root-a', children: [] },
      { id: 'parent', children: [{ id: 'child-z', children: [] }, { id: 'child-a', children: [] }] },
      { id: 'root-z', children: [] },
    ]);
  });

  it('keeps malformed group parents and parent cycles visible at the root', () => {
    const tags = [
      { id: 'a', name: 'A', parentTagId: 'b', connectionIds: [] },
      { id: 'b', name: 'B', parentTagId: 'a', connectionIds: [] },
      { id: 'orphan', name: 'Orphan', parentTagId: 'missing', connectionIds: [] },
    ] as any[];

    expect(
      buildSidebarConnectionTagTree([], tags, []).map((item) => item.id),
    ).toEqual(['a', 'b', 'orphan']);
  });

  it('builds a standalone saved-query tree without loading database nodes', () => {
    const tree = buildAllSavedQueriesTreeNode(
      [
        {
          id: 'saved-1',
          name: 'Orders',
          sql: 'select * from orders',
          connectionId: 'conn-1',
          dbName: 'app',
          createdAt: 100,
        },
        {
          id: 'saved-orphan',
          name: 'Legacy Report',
          sql: 'select 1',
          connectionId: 'legacy-1',
          originalConnectionId: 'legacy-1',
          dbName: 'legacy_db',
          createdAt: 200,
          bindingStatus: 'orphan',
        },
      ],
      [{
        id: 'conn-1',
        name: 'Primary',
        config: {
          type: 'mysql',
          host: 'db.local',
          port: 3306,
        },
      }] as any,
    );

    expect(tree?.key).toBe('all-saved-queries');
    expect(tree?.title).toBe('全部已存查询');
    expect(tree?.children?.[0]).toMatchObject({
      key: 'all-saved-queries-connection-conn-1',
      title: 'Primary',
      type: 'saved-query-group',
    });
    expect(tree?.children?.[0].children?.[0]).toMatchObject({
      key: 'all-saved-queries-connection-conn-1-db-app',
      title: 'app',
    });
    expect(tree?.children?.[0].children?.[0].children?.[0]).toMatchObject({
      key: 'all-saved-query-saved-1',
      title: 'Orders',
      type: 'saved-query',
    });
    const unmatchedGroup = tree?.children?.find((child) => child.key === 'all-saved-queries-unmatched');
    expect(unmatchedGroup?.title).toBe('未匹配');
    expect(unmatchedGroup?.children?.[0]).toMatchObject({
      key: 'all-saved-queries-unmatched-legacy-1',
      title: 'legacy-1',
    });
    expect(unmatchedGroup?.children?.[0].children?.[0].children?.[0]).toMatchObject({
      key: 'all-saved-query-saved-orphan',
      title: 'Legacy Report',
    });
  });

  it('renders saved query groups in mixed child order and keeps grouped SQL out of the ungrouped branch', () => {
    const tree = buildAllSavedQueriesTreeNode(
      [
        {
          id: 'query-root',
          name: 'Root query',
          sql: 'select 1',
          connectionId: 'conn-1',
          dbName: 'app',
          createdAt: 100,
        },
        {
          id: 'query-child',
          name: 'Child query',
          sql: 'select 2',
          connectionId: 'conn-1',
          dbName: 'app',
          createdAt: 200,
        },
        {
          id: 'query-ungrouped',
          name: 'Ungrouped query',
          sql: 'select 3',
          connectionId: 'conn-1',
          dbName: 'app',
          createdAt: 300,
        },
      ],
      [{
        id: 'conn-1',
        name: 'Primary',
        config: { type: 'mysql', host: 'db.local', port: 3306 },
      }] as any,
      [
        {
          id: 'root-group',
          name: 'Root group',
          queryIds: ['query-root'],
          childOrder: ['group:child-group', 'query:query-root'],
        },
        {
          id: 'child-group',
          name: 'Child group',
          parentGroupId: 'root-group',
          queryIds: ['query-child'],
          childOrder: ['query:query-child'],
        },
      ],
    );

    const rootGroup = tree?.children?.find((child) => child.key === 'saved-query-manual-group-root-group');
    expect(rootGroup?.children?.map((child) => child.key)).toEqual([
      'saved-query-manual-group-child-group',
      'all-saved-query-query-root',
    ]);
    expect(rootGroup?.children?.[0].children?.map((child) => child.key)).toEqual([
      'all-saved-query-query-child',
    ]);

    const ungrouped = tree?.children?.find((child) => child.key === 'all-saved-queries-ungrouped');
    expect(ungrouped?.children?.[0]).toMatchObject({
      key: 'all-saved-queries-connection-conn-1',
      title: 'Primary',
    });
    expect(ungrouped?.children?.[0].children?.[0].children?.map((child) => child.key)).toEqual([
      'all-saved-query-query-ungrouped',
    ]);
    expect(JSON.stringify(ungrouped)).not.toContain('all-saved-query-query-root');
    expect(JSON.stringify(ungrouped)).not.toContain('all-saved-query-query-child');
  });

  it('renders the current table locate action in the sidebar toolbar', () => {
    const markup = renderSidebarMarkup();
    const externalSqlActionIndex = markup.indexOf('data-sidebar-open-external-sql-file-action="true"');
    const locateActionIndex = markup.indexOf('data-sidebar-locate-current-tab-action="true"');

    expect(markup).toContain('data-sidebar-locate-current-tab-action="true"');
    expect(markup).toContain('aria-label="定位当前标签页"');
    expect(locateActionIndex).toBeGreaterThan(externalSqlActionIndex);
  });

  it('expands a collapsed sidebar before resolving a locate request', () => {
    const source = readSourceFile('./Sidebar.tsx');
    const locateStart = source.indexOf('const locateObjectInSidebar = async');
    const locateEnd = source.indexOf('\n  const handleLocateActiveTabInSidebar', locateStart);
    const locateSource = source.slice(locateStart, locateEnd);
    const connectionLocateStart = source.indexOf('const locateConnectionInSidebar = useCallback');
    const connectionLocateEnd = source.indexOf('  useEffect(() => {', connectionLocateStart);
    const connectionLocateSource = source.slice(connectionLocateStart, connectionLocateEnd);

    expect(locateStart).toBeGreaterThanOrEqual(0);
    expect(locateEnd).toBeGreaterThan(locateStart);
    expect(locateSource).toMatch(
      /if \(!request\)\s*\{[\s\S]*?return;\s*\}\s*onEnsureSidebarExpanded\?\.\(\);/s,
    );
    expect(connectionLocateStart).toBeGreaterThanOrEqual(0);
    expect(connectionLocateEnd).toBeGreaterThan(connectionLocateStart);
    expect(connectionLocateSource).toContain('onEnsureSidebarExpanded?.();');
    expect(connectionLocateSource).not.toContain('onExpandSidebar?.();');
  });

  it('keeps the legacy sidebar toolbar on a stable six-column grid layout', () => {
    const source = readSidebarSource();
    const markup = renderSidebarMarkup();

    expect(markup).toContain('data-sidebar-legacy-toolbar="true"');
    expect(markup).toContain('data-sidebar-legacy-toolbar-item="true"');
  });

  it('renders exactly seven expanded v2 explorer actions in task order', () => {
    const markup = renderSidebarMarkup({
      uiVersion: 'v2',
      v2ExplorerContext: {
        active: true,
        connectionName: '开发环境',
        databaseName: 'gonavi',
        objectName: 'connections',
        tooltip: '开发环境 · gonavi · connections',
      },
      onCollapseSidebar: mocks.noop,
      collapseSidebarLabel: t('app.sidebar.collapse'),
      onToggleAI: mocks.noop,
      onOpenSettings: mocks.noop,
    });
    const actionsStart = markup.indexOf('<div class="gn-v2-explorer-actions"');
    const summaryIndex = markup.indexOf('data-sidebar-active-context-summary="true"', actionsStart);
    const commandSearchActionIndex = markup.indexOf('data-sidebar-command-search-action="true"', actionsStart);
    const locateActionIndex = markup.indexOf('data-sidebar-locate-current-tab-action="true"', actionsStart);
    const filtersStart = markup.indexOf('<div class="gn-v2-explorer-filter-tabs"', locateActionIndex);

    expect(actionsStart).toBeGreaterThanOrEqual(0);
    expect(summaryIndex).toBeGreaterThan(actionsStart);
    expect(commandSearchActionIndex).toBeGreaterThan(summaryIndex);
    expect(locateActionIndex).toBeGreaterThan(commandSearchActionIndex);
    expect(filtersStart).toBeGreaterThan(locateActionIndex);
    expect(markup).not.toContain('<div class="gn-v2-explorer-search"');

    const actionMarkup = markup.slice(actionsStart, filtersStart);
    const actionLabels = Array.from(
      actionMarkup.matchAll(/<button\b[^>]*\baria-label="([^"]+)"/g),
      (match) => match[1],
    );

    expect(actionLabels).toEqual([
      t('sidebar.command_search.label'),
      t('sidebar.action.locate_current_table'),
      t('sidebar.action.scroll_to_top'),
      t('sidebar.active_connection.actions'),
      t('app.sidebar.ai_assistant'),
      t('app.sidebar.settings'),
      t('app.sidebar.collapse'),
    ]);
  });

  it('reveals command-search objects with an exact-key centered tree scroll', () => {
    const source = readSourceFile('./Sidebar.tsx');

    expect(source).toContain("querySelectorAll<HTMLElement>('[data-sidebar-node-key]')");
    expect(source).toMatch(/scrollIntoView\?\.\(\{\s*block:\s*request\.scrollBlock,\s*inline:\s*'nearest'/s);
    expect(source).toContain("scrollSidebarTreeToKey(targetKey, 'center')");
    expect(source).toContain("setV2ExplorerFilter('all')");
  });

  it('renders a fixed connection/database/object summary without the Host address', () => {
    const css = readV2ThemeCss();
    const connectionName = '飞速开发环境连接名称很长';
    const databaseName = 'tracecode_b_database_name_is_long';
    const objectName = 'fs_order_2026_object_name_is_long';
    const v2ExplorerContext = {
      active: true,
      connectionName,
      databaseName,
      objectName,
      tooltip: `${connectionName} · ${databaseName} · ${objectName}`,
    };
    const markup = renderSidebarMarkup({
      uiVersion: 'v2',
      v2ExplorerContext,
      onCollapseSidebar: mocks.noop,
      collapseSidebarLabel: t('app.sidebar.collapse'),
      onToggleAI: mocks.noop,
      onOpenSettings: mocks.noop,
    });
    const actionsStart = markup.indexOf('<div class="gn-v2-explorer-actions"');
    const actionsEnd = markup.indexOf('<div class="gn-v2-explorer-filter-tabs"', actionsStart);
    const summaryIndex = markup.indexOf('data-sidebar-active-context-summary="true"', actionsStart);
    const locateActionIndex = markup.indexOf('data-sidebar-locate-current-tab-action="true"', actionsStart);
    const summaryTagStart = markup.lastIndexOf('<div', summaryIndex);
    const summaryTagEnd = markup.indexOf('>', summaryIndex);
    const summaryOpeningTag = markup.slice(summaryTagStart, summaryTagEnd + 1);
    const summaryMarkup = markup.slice(summaryIndex, locateActionIndex);
    const summaryFields = Array.from(
      summaryMarkup.matchAll(/data-sidebar-active-context-field="([^"]+)"/g),
      (match) => match[1],
    );

    expect(actionsStart).toBeGreaterThanOrEqual(0);
    expect(actionsEnd).toBeGreaterThan(actionsStart);
    expect(summaryIndex).toBeGreaterThan(actionsStart);
    expect(summaryIndex).toBeLessThan(locateActionIndex);
    expect(summaryIndex).toBeLessThan(actionsEnd);
    expect(summaryMarkup).not.toContain('gn-v2-explorer-context-status');
    expect(summaryMarkup).not.toContain('gn-v2-explorer-context-status-dot');
    expect(summaryFields).toEqual(['connection', 'database', 'object']);
    expect(summaryMarkup).toContain(connectionName);
    expect(summaryMarkup).toContain(databaseName);
    expect(summaryMarkup).toContain(objectName);
    expect(summaryMarkup).not.toContain('192.168.101.42');
    expect(summaryOpeningTag).toMatch(/\baria-describedby=/);
    expect(summaryOpeningTag).not.toMatch(/\btitle=/);

    const shallowRenderer = createShallowRenderer();
    shallowRenderer.render(<V2ExplorerContextSummary context={v2ExplorerContext} />);
    const tooltipElement = shallowRenderer.getRenderOutput<React.ReactElement<{
      title: React.ReactNode;
      placement: string;
      mouseEnterDelay: number;
      rootClassName: string;
    }>>();
    const tooltipMarkup = renderToStaticMarkup(<>{tooltipElement.props.title}</>);
    const tooltipFields = Array.from(
      tooltipMarkup.matchAll(/data-sidebar-active-context-tooltip-field="([^"]+)"/g),
      (match) => match[1],
    );

    expect(tooltipElement.props.placement).toBe('bottomLeft');
    expect(tooltipElement.props.mouseEnterDelay).toBe(0.35);
    expect(tooltipElement.props.rootClassName).toBe('gn-v2-explorer-context-tooltip-popup');
    expect(tooltipMarkup).toContain('data-sidebar-active-context-tooltip="true"');
    expect(tooltipFields).toEqual(['connection', 'database', 'object']);
    expect(tooltipMarkup).toContain(connectionName);
    expect(tooltipMarkup).toContain(databaseName);
    expect(tooltipMarkup).toContain(objectName);
    expect(tooltipMarkup).not.toContain('192.168.101.42');
    expect(css).toMatch(/\.gn-v2-explorer-context-tooltip-popup\s*\{[^}]*max-width:\s*min\(/s);
    expect(css).toMatch(/\.gn-v2-explorer-context-tooltip\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*overflow-wrap:\s*anywhere;/s);
  });

  it('centers a connection-only active selection within the fixed three-line context height', () => {
    const css = readV2ThemeCss();
    const markup = renderSidebarMarkup({
      uiVersion: 'v2',
      v2ExplorerContext: {
        active: true,
        connectionName: '开发240',
        databaseName: '',
        objectName: '',
        tooltip: '开发240',
      },
      onCollapseSidebar: mocks.noop,
      collapseSidebarLabel: t('app.sidebar.collapse'),
      onToggleAI: mocks.noop,
      onOpenSettings: mocks.noop,
    });
    const summaryIndex = markup.indexOf('data-sidebar-active-context-summary="true"');
    const locateActionIndex = markup.indexOf('data-sidebar-locate-current-tab-action="true"', summaryIndex);
    const summaryMarkup = markup.slice(summaryIndex, locateActionIndex);

    expect(summaryMarkup).toContain('data-sidebar-active-context="true"');
    expect(summaryMarkup).toContain('data-sidebar-active-context-depth="connection"');
    expect(summaryMarkup).toContain('data-sidebar-active-context-field="database"');
    expect(summaryMarkup).toContain('data-sidebar-active-context-field="object"');
    expect(css).toMatch(/\.gn-v2-explorer-context-copy\s*\{[^}]*font-size:\s*var\(--gn-sidebar-tree-font-size,\s*var\(--gn-font-size-sm,\s*12px\)\);/s);
    expect(css).toMatch(/\.gn-v2-explorer-context-copy\s*\{[^}]*min-height:\s*calc\(3\.15em \+ 2px \* var\(--gn-v2-explorer-scale\)\);/s);
    expect(css).toMatch(/\.gn-v2-explorer-context-copy\s*\{[^}]*justify-content:\s*flex-end;/s);
    expect(css).toMatch(/\.gn-v2-explorer-context\[data-sidebar-active-context=(["'])true\1\]\[data-sidebar-active-context-depth=(["'])connection\2\]\s+\.gn-v2-explorer-context-copy\s*\{[^}]*justify-content:\s*center;/s);
    expect(css).toMatch(/\.gn-v2-explorer-context\[data-sidebar-active-context=(["'])true\1\]\s+\.gn-v2-explorer-context-line:empty\s*\{[^}]*display:\s*none;/s);
    expect(css).not.toMatch(/\.gn-v2-explorer-context\[data-sidebar-active-context=(["'])false\1\]\s+\.gn-v2-explorer-context-line:empty\s*\{[^}]*display:\s*none;/s);
  });

  it('left-aligns the no-host label in the middle of the fixed three-line summary without a status dot', () => {
    const css = readV2ThemeCss();
    const v2ExplorerContext = {
      active: false,
      connectionName: '未选择 Host',
      databaseName: '',
      objectName: '',
      tooltip: '未选择 Host',
    };
    const markup = renderSidebarMarkup({
      uiVersion: 'v2',
      v2ExplorerContext,
      onCollapseSidebar: mocks.noop,
      collapseSidebarLabel: t('app.sidebar.collapse'),
      onToggleAI: mocks.noop,
      onOpenSettings: mocks.noop,
    });
    const summaryIndex = markup.indexOf('data-sidebar-active-context-summary="true"');
    const locateActionIndex = markup.indexOf('data-sidebar-locate-current-tab-action="true"', summaryIndex);
    const summaryMarkup = markup.slice(summaryIndex, locateActionIndex);
    const summaryFields = Array.from(
      summaryMarkup.matchAll(/data-sidebar-active-context-field="([^"]+)"/g),
      (match) => match[1],
    );

    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(locateActionIndex).toBeGreaterThan(summaryIndex);
    expect(summaryMarkup).toContain('data-sidebar-active-context="false"');
    expect(summaryMarkup).toContain('未选择 Host');
    expect(summaryMarkup).not.toContain('gn-v2-explorer-context-status');
    expect(summaryMarkup).not.toContain('gn-v2-explorer-context-status-dot');
    expect(summaryFields).toEqual(['connection', 'database', 'object']);
    expect(css).toMatch(/\.gn-v2-explorer-context\[data-sidebar-active-context=(["'])false\1\]\s+\.gn-v2-explorer-context-copy\s*\{[^}]*align-items:\s*stretch;[^}]*text-align:\s*start;/s);
    expect(css).toMatch(/\.gn-v2-explorer-context\[data-sidebar-active-context=(["'])false\1\]\s+\.gn-v2-explorer-context-line\.is-database\s*\{[^}]*order:\s*-1;/s);
  });

  it('keeps expanded v2 actions out of the collapsed-only connection rail', () => {
    const source = readSourceFile('./Sidebar.tsx');
    const propsStart = source.indexOf('const v2ConnectionRailProps = {');
    const propsEnd = source.indexOf('\n  return (', propsStart);

    expect(propsStart).toBeGreaterThanOrEqual(0);
    expect(propsEnd).toBeGreaterThan(propsStart);
    expect(source.slice(propsStart, propsEnd)).toContain('showLocateAction: false');
  });

  it('keeps the expanded v2 explorer actions usable in narrow containers', () => {
    const source = readSourceFile('./Sidebar.tsx');
    const appCss = readSourceFile('../App.css');
    const css = readV2ThemeCss();
    expect(source).toContain('{isV2Ui && <SidebarConnectionRail {...v2ConnectionRailProps} />}');
    expect(appCss).toMatch(/body\[data-ui-version=(["'])v2\1\]\s+\.ant-layout-sider\[data-sidebar-collapsed=(["'])false\2\]\s+\.gn-v2-connection-rail\s*\{[^}]*display:\s*none;/s);
    expect(appCss).not.toMatch(/body\[data-ui-version=(["'])v2\1\]\s+\.ant-layout-sider\[data-sidebar-collapsed=(["'])true\2\]\s+\.gn-v2-connection-rail\s*\{[^}]*display:\s*none;/s);
    expect(css).toMatch(/\.gn-v2-explorer-actions\s*\{[^}]*min-width:\s*0;[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;/s);
    expect(css).toMatch(/\.gn-v2-explorer-actions\s*\{[^}]*border-bottom:\s*none;/s);
    expect(css).toMatch(/\.gn-v2-explorer-actions\s*\{[^}]*min-height:\s*calc\(46px \* var\(--gn-v2-explorer-scale\)\);/s);
    expect(css).toMatch(/\.gn-v2-explorer-context\s*\{[^}]*min-width:\s*calc\(88px \* var\(--gn-v2-explorer-scale\)\);[^}]*flex:\s*1 1 calc\(128px \* var\(--gn-v2-explorer-scale\)\);[^}]*overflow:\s*visible;/s);
    expect(css).toMatch(/\.gn-v2-explorer-context-copy\s*\{[^}]*min-width:\s*0;[^}]*flex-direction:\s*column;[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.gn-v2-explorer-context-line\s*\{[^}]*display:\s*block;[^}]*min-width:\s*0;[^}]*min-height:\s*1em;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
    expect(css).toMatch(/@container gn-v2-object-explorer \(max-width:\s*300px\)\s*\{[^}]*\.gn-v2-explorer-actions\s*\{[^}]*justify-content:\s*flex-start;/s);
    expect(css).toMatch(/@container gn-v2-object-explorer \(max-width:\s*300px\)\s*\{[\s\S]*?\.gn-v2-explorer-context\s*\{[^}]*min-width:\s*calc\(68px \* var\(--gn-v2-explorer-scale\)\);/s);
    expect(css).not.toContain('.gn-v2-active-connection-header');
  });

  it('places driver management in the titlebar and editor tools inside More', () => {
    const source = readSourceFile('./Sidebar.tsx');
    const actionsStart = source.indexOf('const v2TitlebarQuickActions: TitleBarQuickAction[] = [');
    const actionsEnd = source.indexOf('\n  ];', actionsStart);

    expect(actionsStart).toBeGreaterThanOrEqual(0);
    expect(actionsEnd).toBeGreaterThan(actionsStart);

    const actionsSource = source.slice(actionsStart, actionsEnd);
    const connectionPackageIndex = actionsSource.indexOf("key: 'connection-package'");
    const driverIndex = actionsSource.indexOf("key: 'drivers'");
    const workspaceIndex = actionsSource.indexOf("key: 'settings-workspace'");

    expect(connectionPackageIndex).toBeGreaterThanOrEqual(0);
    expect(driverIndex).toBeGreaterThan(connectionPackageIndex);
    expect(workspaceIndex).toBeGreaterThan(connectionPackageIndex);
    // 关于 GoNavi 已拎出「更多」菜单，作为标题栏独立按钮
    expect(actionsSource).not.toContain("key: 'settings-about'");

    const driverSource = actionsSource.slice(driverIndex, actionsSource.indexOf("key: 'open-external-sql-file'", driverIndex));
    expect(driverSource).not.toContain("priority: 'secondary'");
    expect(driverSource).toContain("label: t('app.tools.entry.drivers.title')");
    expect(driverSource).toContain("pane: 'drivers'");

    const workspaceSource = actionsSource.slice(workspaceIndex);
    expect(workspaceSource).toContain("priority: 'secondary'");
    expect(workspaceSource).not.toContain("key: 'drivers'");
    expect(workspaceSource).toContain("key: 'snippet-settings'");
    expect(workspaceSource).toContain("key: 'shortcut-settings'");
    expect(workspaceSource).toContain("key: 'sql-audit'");

    const aboutActionsStart = source.indexOf('const v2TitlebarAboutActions: TitleBarQuickAction[] = [');
    const aboutActionsEnd = source.indexOf('\n  ];', aboutActionsStart);
    expect(aboutActionsStart).toBeGreaterThan(actionsEnd);
    expect(aboutActionsEnd).toBeGreaterThan(aboutActionsStart);

    const aboutActionsSource = source.slice(aboutActionsStart, aboutActionsEnd);
    expect(aboutActionsSource).toContain("key: 'about-go-navi'");
    expect(aboutActionsSource).toContain("label: t('app.settings.group.about.title')");
    expect(aboutActionsSource).toContain("{ group: 'about', pane: 'about-go-navi' }");

    const renderSource = source.slice(aboutActionsEnd);
    expect(renderSource).toContain('trailingActions={v2TitlebarAboutActions}');
  });

  it('renders the fixed v2 rail, titlebar quick actions, explorer filters and workbench actions', () => {
    const markup = renderSidebarMarkup({ uiVersion: 'v2', onCreateConnection: mocks.noop });
    const source = readSidebarSource();
    const titlebarQuickActionsSource = readSourceFile('./TitleBarQuickActions.tsx');

    expect(markup).toContain('gn-v2-sidebar-redesign');
    expect(markup).toContain('gn-v2-connection-rail');
    expect(markup).toContain('data-sidebar-fixed-rail="true"');
    expect(markup).toContain('gn-v2-object-explorer');
    expect(markup.indexOf('data-sidebar-fixed-rail="true"')).toBeLessThan(markup.indexOf('data-sidebar-tree-panel="true"'));
    expect(markup).toContain('data-sidebar-tree-panel="true" style="display:flex');
    expect(markup).not.toContain('data-sidebar-tree-panel="true" aria-hidden="true" style="display:none');
    expect(markup).toContain('gn-v2-explorer-actions');
    expect(markup).not.toContain('gn-v2-active-connection-header');
    expect(markup).not.toContain('gn-v2-active-connection-copy');
    expect(markup).not.toContain('gn-v2-explorer-search');
    expect(markup).toContain('data-v2-sidebar-search-mode="command"');
    expect(markup).toContain('data-sidebar-command-search-action="true"');
    expect(markup).toContain('data-v2-command-search-icon-only="true"');
    expect(markup).not.toContain('gn-v2-explorer-filter-action');
    expect(markup).not.toContain('重置侧栏筛选');
    expect(markup).not.toContain('搜索表、连接、动作... 或问 AI');
    expect(markup).not.toContain('gn-v2-search-shortcut');
    expect(markup).not.toContain('<kbd>⌘</kbd>');
    expect(markup).not.toContain('<kbd>K</kbd>');
    expect(markup).toContain('gn-v2-explorer-filter-tabs');
    const explorerActionsIndex = markup.indexOf('data-sidebar-explorer-actions="true"');
    const commandSearchActionIndex = markup.indexOf('data-sidebar-command-search-action="true"');
    const locateActionIndex = markup.indexOf('data-sidebar-locate-current-tab-action="true"');
    const explorerFilterTabsIndex = markup.indexOf('class="gn-v2-explorer-filter-tabs"');
    expect(explorerActionsIndex).toBeGreaterThanOrEqual(0);
    expect(commandSearchActionIndex).toBeGreaterThan(explorerActionsIndex);
    expect(locateActionIndex).toBeGreaterThan(commandSearchActionIndex);
    expect(explorerFilterTabsIndex).toBeGreaterThan(locateActionIndex);
    expect(markup).toContain('全部');
    expect(markup).toContain('视图');
    expect(markup).toContain('函数');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).not.toContain('gn-v2-rail-workbench-actions');
    expect(markup).not.toContain('data-sidebar-sql-analysis-action="true"');
    expect(markup).not.toContain('data-sidebar-sql-audit-action="true"');
    expect(markup).not.toContain('gn-v2-sidebar-log-footer');
    expect(markup).not.toContain('gn-v2-sidebar-slow-query-button');
    expect(markup).not.toContain('gn-v2-sidebar-log-button');
    expect(markup).not.toContain('SQL 执行日志');
    expect(markup).not.toContain('2,341');
    expect(markup).toContain('gn-v2-rail-items');
    expect(markup).not.toContain('data-sidebar-create-group-action="true"');
    expect(markup).not.toContain('data-sidebar-batch-table-action="true"');
    expect(markup).not.toContain('data-sidebar-batch-database-action="true"');
    expect(markup).not.toContain('data-sidebar-data-import-action="true"');
    expect(markup).not.toContain('data-sidebar-open-external-sql-file-action="true"');
    expect(markup).toContain('data-sidebar-locate-current-tab-action="true"');
    expect(titlebarQuickActionsSource).toContain('data-titlebar-quick-actions');
    expect(source).toContain("key: 'batch-actions'");
    expect(source).toContain("sidebar.action.batch_operations");
    expect(source).toContain("key: 'sql-tools'");
    expect(source).toContain("sidebar.action.sql_tools");
    expect(source).toContain("key: 'data-workflow'");
    expect(source).toContain("app.tools.group.workflow.title");
    expect(source).toContain("onOpenDataSyncWorkbench?.('schemaCompare')");
    expect(source).toContain("onOpenDataSyncWorkbench?.('dataCompare')");
    expect(source).toContain("onOpenDataSyncWorkbench?.('sync')");
    expect(source).toContain('showObjectActions: false');
    expect(source).not.toContain("key: 'locate-current-table'");
    expect(markup).not.toContain('data-gonavi-new-query-action="true"');
    expect(markup).not.toContain('data-gonavi-create-connection-action="true"');
    expect(markup).toContain('aria-label="AI 助手"');
    expect(markup).toContain('data-gonavi-ai-entry-action="true"');
    expect(markup).not.toContain('aria-label="工具"');
    expect(markup).not.toContain('data-gonavi-open-tools-action="true"');
    expect(markup).toContain('aria-label="设置"');
    const contextMenuFunction = source.slice(
      source.indexOf('const openV2ConnectionContextMenu = ('),
      source.indexOf('const getV2TreeMetaText = (node: any): string => {'),
    );
  });

  it('replaces relational explorer controls in an active message queue context', () => {
    mocks.state.connections = [{
      id: 'mqtt-1',
      name: 'MQTT',
      config: { type: 'mqtt', host: 'localhost', port: 1883 },
    }];
    mocks.state.activeContext = { connectionId: 'mqtt-1', dbName: 'topics' };
    mocks.state.activeTabId = 'message-queue-mqtt-1-topics';
    mocks.state.tabs = [{
      id: 'message-queue-mqtt-1-topics',
      title: 'MQTT · 消息',
      type: 'message-queue',
      connectionId: 'mqtt-1',
      dbName: 'topics',
    }];

    const markup = renderSidebarMarkup({ uiVersion: 'v2' });

    expect(markup).toContain('data-v2-command-search-icon-only="true"');
    expect(markup).toContain('data-sidebar-command-search-action="true"');
    expect(markup).not.toContain('gn-v2-explorer-search');
    expect(markup).not.toContain(t('sidebar.message_queue.search_placeholder'));
    expect(markup).not.toContain('gn-v2-explorer-filter-tabs');
    expect(markup).not.toContain(`>${t('sidebar.command_search.object_kind.tables')}<`);
    expect(markup).not.toContain(`>${t('sidebar.command_search.object_kind.views')}<`);
    expect(markup).not.toContain(`>${t('sidebar.command_search.object_kind.routines')}<`);
  });

  it('can render the v2 sidebar with legacy persistent filter input', () => {
    mocks.state.appearance.v2SidebarSearchMode = 'filter';
    mocks.state.appearance.v2SidebarPersistedFilter = 'fs_org';

    const markup = renderSidebarMarkup({ uiVersion: 'v2' });

    expect(markup).toContain('data-v2-sidebar-search-mode="filter"');
    expect(markup).toContain('gn-v2-explorer-search');
    expect(markup).not.toContain('data-sidebar-command-search-action="true"');
    expect(markup).toContain(`placeholder="${t('sidebar.search.placeholder')}"`);
    expect(markup).toContain('value="fs_org"');
    expect(markup).toContain('重置侧栏筛选');
  });

  it('keeps the v2 command trigger icon-only when the search shortcut is customized', () => {
    mocks.state.shortcutOptions = cloneShortcutOptions(DEFAULT_SHORTCUT_OPTIONS);
    mocks.state.shortcutOptions.focusSidebarSearch.mac = { combo: 'Meta+F', enabled: true };

    const markup = renderSidebarMarkup({ uiVersion: 'v2' });

    expect(markup).toContain('data-v2-command-search-icon-only="true"');
    expect(markup).not.toContain('gn-v2-search-shortcut');
    expect(markup).not.toContain('<kbd>⌘</kbd>');
    expect(markup).not.toContain('<kbd>F</kbd>');
    expect(markup).not.toContain('<kbd>K</kbd>');
  });

  it('localizes the v2 command search scope shell and object filters through catalog keys', () => {
    const source = readSidebarSource();
    const objectKindSource = source.slice(
      source.indexOf('const V2_EXPLORER_FILTER_OPTIONS'),
      source.indexOf('const V2_EXPLORER_FILTER_GROUP_KEYS'),
    );
    const searchScopeSource = source.slice(
      source.indexOf('const SEARCH_SCOPE_OPTIONS'),
      source.indexOf('const SEARCH_SCOPE_ICON_MAP'),
    );
    const scopePanelSource = source.slice(
      source.indexOf('const currentLanguage = getCurrentLanguage();'),
      source.indexOf('const getConnectionHostSearchText = (node: TreeNode): string => {'),
    );
    const scopeTriggerSource = source.slice(
      source.indexOf('content={searchScopePopoverContent}'),
      source.indexOf('{isV2Ui && (', source.indexOf('content={searchScopePopoverContent}')),
    );
    const objectFilterRenderSource = source.slice(
      source.indexOf('{isV2Ui && (', source.indexOf('content={searchScopePopoverContent}')),
      source.indexOf('{/* Toolbar */}', source.indexOf('{isV2Ui && (', source.indexOf('content={searchScopePopoverContent}'))),
    );

    const keys = [
      'sidebar.command_search.object_kind.all',
      'sidebar.command_search.object_kind.tables',
      'sidebar.command_search.object_kind.views',
      'sidebar.command_search.object_kind.sequences',
      'sidebar.command_search.object_kind.routines',
      'sidebar.command_search.object_kind.packages',
      'sidebar.command_search.object_kind.events',
      'sidebar.command_search.scope.smart',
      'sidebar.command_search.scope.object',
      'sidebar.command_search.scope.database',
      'sidebar.command_search.scope.host',
      'sidebar.command_search.scope.tag',
      'sidebar.command_search.scope.summary_smart',
      'sidebar.command_search.scope.title',
      'sidebar.command_search.scope.description',
      'sidebar.command_search.scope.recommended',
      'sidebar.command_search.scope.smart_help',
      'sidebar.command_search.scope.manual_title',
      'sidebar.command_search.scope.multi_select',
      'sidebar.command_search.scope.manual_help',
      'sidebar.command_search.scope.tooltip',
      'sidebar.command_search.scope.compact_smart',
      'sidebar.command_search.object_kind.filter_aria',
    ];

    SUPPORTED_LANGUAGES.forEach((language) => {
      setCurrentLanguage(language);
      keys.forEach((key) => {
        expect(t(key)).not.toBe(key);
      });
    });
  });

  it('localizes extracted sidebar util search and v2 filter labels through injected translators', () => {
    const translate = (key: string) => ({
      'sidebar.search.scope.smart': 'Smart',
      'sidebar.search.scope.object': 'Object',
      'sidebar.search.scope.database': 'Database',
      'sidebar.search.scope.host': 'Host',
      'sidebar.search.scope.tag': 'Tag',
      'sidebar.command_search.object_kind.all': 'All',
      'sidebar.command_search.object_kind.tables': 'Tables',
      'sidebar.command_search.object_kind.views': 'Views',
      'sidebar.command_search.object_kind.sequences': 'Sequences',
      'sidebar.command_search.object_kind.routines': 'Routines',
      'sidebar.command_search.object_kind.packages': 'Packages',
      'sidebar.command_search.object_kind.events': 'Events',
      'table_overview.section.pinned': 'Pinned',
      'table_overview.section.all': 'All',
    } as Record<string, string>)[key] || key;

    expect(buildCoreSearchScopeOptions(translate).map((option) => option.label)).toEqual(['Smart', 'Object', 'Database', 'Host', 'Tag']);
    expect(CORE_SEARCH_SCOPE_OPTIONS.map((option) => option.label)).toEqual([
      t('sidebar.search.scope.smart', undefined, 'zh-CN'),
      t('sidebar.search.scope.object', undefined, 'zh-CN'),
      t('sidebar.search.scope.database', undefined, 'zh-CN'),
      t('sidebar.search.scope.host', undefined, 'zh-CN'),
      t('sidebar.search.scope.tag', undefined, 'zh-CN'),
    ]);
    expect(buildV2ExplorerFilterOptions(translate).map((option) => option.label)).toEqual(['All', 'Tables', 'Views', 'Sequences', 'Routines', 'Packages', 'Events']);
    expect(V2_UTILS_EXPLORER_FILTER_OPTIONS.map((option) => option.label)).toEqual(['全部', '表', '视图', '序列', '函数', '存储包', '事件']);

    const tableNodes = [
      { title: 'orders', key: 'orders', type: 'table' as const, dataRef: { pinnedSidebarTable: true } },
      { title: 'users', key: 'users', type: 'table' as const, dataRef: { pinnedSidebarTable: false } },
    ];

    expect(buildV2UtilsSidebarTableSectionedChildren('conn-main-tables', tableNodes, translate).map((node) => node.title)).toEqual([
      'Pinned',
      'orders',
      'All',
      'users',
    ]);
    expect(buildV2UtilsSidebarTableChildrenForUi('conn-main-tables', tableNodes, true, translate).map((node) => node.title)).toEqual([
      'Pinned',
      'orders',
      'All',
      'users',
    ]);
  });

  it('scales the v2 rail and keeps fixed workbench tools below a scrollable primary area', () => {
    const css = readV2ThemeCss();

    expect(css).toMatch(/\.gn-v2-rail-workbench-actions,\s*body\[data-ui-version="v2"\] \.gn-v2-rail-system-actions \{[^}]*flex-direction: column;/s);
    expect(css).toMatch(/\.gn-v2-rail-workbench-actions \{[^}]*border-bottom: 0\.5px solid var\(--gn-br-1\);/s);
    expect(css).toMatch(/\.gn-v2-rail-items \{[^}]*flex: 1 1 auto;[^}]*overflow-y: auto;/s);
    expect(css).toMatch(/\.gn-v2-rail-secondary-actions \{[^}]*margin-top: auto;[^}]*flex: 0 0 auto;/s);
    expect(css).toMatch(/\.gn-v2-explorer-toolbar\s*\{[^}]*display:\s*none\s*!important/s);
    expect(css).toMatch(/\.ant-tree \{[^}]*font-size: var\(--gn-sidebar-tree-font-size, var\(--gn-font-size-sm, 12px\)\);/s);
    expect(css).toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree \{[^}]*font-size: var\(--gn-sidebar-tree-font-size, var\(--gn-font-size-sm, 12px\)\);/s);
    expect(css).toMatch(/\.gn-v2-tree-title \{[^}]*font-size: var\(--gn-sidebar-tree-font-size, var\(--gn-font-size-sm, 12px\)\);/s);
    expect(css).toMatch(/\.gn-v2-tree-title\.is-mono \.gn-v2-tree-label \{[^}]*font-size: inherit;[^}]*font-weight: 400 !important;/s);
    expect(css).toMatch(/\.gn-v2-tree-count \{[^}]*font-size: clamp\(10px, calc\(var\(--gn-sidebar-tree-font-size, var\(--gn-font-size-sm, 12px\)\) - 1px\), 16px\);/s);
    expect(css).toMatch(/\.gn-v2-tree-title\.is-redis-db \.gn-v2-tree-label \{[^}]*display: inline-flex;[^}]*gap: 6px;/s);
    expect(css).toMatch(/\.gn-v2-redis-db-alias \{[^}]*color: var\(--gn-fg-5\);[^}]*opacity: 0\.78;/s);
    expect(css).toContain('--gn-v2-rail-scale: calc(var(--gn-ui-scale, 1) * var(--gn-sidebar-rail-scale, 1));');
    expect(css).toMatch(/\.gn-v2-connection-rail \{[^}]*width: calc\(38px \* var\(--gn-v2-rail-scale\)\);[^}]*flex: 0 0 calc\(38px \* var\(--gn-v2-rail-scale\)\);/s);
    expect(css).toMatch(/body\[data-ui-version="v2"\] \.gn-v2-rail-item,\s*body\[data-ui-version="v2"\] \.gn-v2-rail-tool \{[^}]*width: calc\(36px \* var\(--gn-v2-rail-scale\)\);[^}]*height: calc\(38px \* var\(--gn-v2-rail-scale\)\);[^}]*font-size: calc\(var\(--gn-font-size-sm, 12px\) \* var\(--gn-sidebar-rail-scale, 1\)\);/s);
    expect(css).toMatch(/\.gn-v2-rail-tool \{[^}]*height: calc\(28px \* var\(--gn-v2-rail-scale\)\);/s);
    expect(css).toMatch(/\.gn-v2-rail-tool \{[^}]*width: calc\(28px \* var\(--gn-v2-rail-scale\)\);/s);
    expect(css).toContain('--gn-v2-explorer-scale: var(--gn-ui-scale, 1);');
    expect(css).toMatch(/\.gn-v2-explorer-actions \{[^}]*min-height: calc\(46px \* var\(--gn-v2-explorer-scale\)\);/s);
    expect(css).toMatch(/\.gn-v2-explorer-context-line\.is-connection \{[^}]*font-size: var\(--gn-sidebar-tree-font-size, var\(--gn-font-size-sm, 12px\)\);/s);
    expect(css).toMatch(/\.gn-v2-explorer-context-line\.is-database,[\s\S]*?\.gn-v2-explorer-context-line\.is-object \{[^}]*font-size: var\(--gn-sidebar-tree-font-size, var\(--gn-font-size-sm, 12px\)\);/s);
    expect(css).toMatch(/\.gn-v2-explorer-tool\.ant-btn \{[^}]*width: calc\(26px \* var\(--gn-v2-explorer-scale\)\);[^}]*min-width: calc\(26px \* var\(--gn-v2-explorer-scale\)\);[^}]*height: calc\(26px \* var\(--gn-v2-explorer-scale\)\) !important;/s);
    expect(css).toMatch(/\.gn-v2-explorer-tool\.ant-btn \.anticon \{[^}]*font-size: calc\(14px \* var\(--gn-v2-explorer-scale\)\);/s);
    expect(css).toMatch(/\.gn-v2-explorer-action-wrap:focus-visible \{[^}]*outline: 2px solid var\(--gn-accent\);/s);
    expect(css).toMatch(/\.gn-v2-object-explorer \{[^}]*container-type: inline-size;[^}]*container-name: gn-v2-object-explorer;/s);
    expect(css).not.toContain('.gn-v2-active-connection-trigger');
  });

  it('keeps query and connection creation actions out of the v2 explorer header', () => {
    mocks.state.connections = [{
      id: 'conn-local',
      name: '开发240',
      config: {
        type: 'mysql',
        host: 'front_end_sys_dev',
        port: 3306,
      },
    }];
    mocks.state.activeContext = { connectionId: 'conn-local', dbName: 'front_end_sys_dev' };
    mocks.state.appearance = {
      enabled: true,
      opacity: 1,
      blur: 0,
      uiVersion: 'v2',
      sidebarHiddenObjectGroups: [],
    };

    const markup = renderSidebarMarkup({ uiVersion: 'v2', onCreateConnection: mocks.noop });
    expect(markup).toContain('gn-v2-explorer-actions');
    expect(markup).not.toContain('data-gonavi-new-query-action="true"');
    expect(markup).not.toContain('data-gonavi-create-connection-action="true"');
  });

  it('keeps v2 explorer filter tabs on a single line when Oracle object filters are present', () => {
    const css = readV2ThemeCss();

    expect(css).toMatch(/\.gn-v2-explorer-filter-tabs \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto;[^}]*overflow-y: hidden;/s);
    expect(css).toMatch(/\.gn-v2-explorer-filter-tabs button \{[^}]*flex: 0 0 auto;[^}]*white-space: nowrap;/s);
  });

  it('shows a pending state while a database node is loading', () => {
    const css = readV2ThemeCss();
    const source = readSidebarSource();
    const treeLoaderSource = readSourceFile('./sidebar/useSidebarTreeLoaders.tsx');
    const titleRenderSource = readSourceFile('./sidebar/useSidebarTitleRender.tsx');
    expect(css).toMatch(/\.gn-v2-tree-status\.is-loading::before \{[^}]*border: 2px solid rgba\(37, 99, 235, 0\.58\);[^}]*animation: gn-v2-tree-status-spin 0\.8s linear infinite;/s);
    expect(css).toMatch(/\.gn-v2-tree-status\.is-loading::before \{[^}]*border-top-color: #2563eb;/s);
    expect(css).toMatch(/@keyframes gn-v2-tree-status-spin \{[^}]*to \{ transform: rotate\(360deg\); \}/s);
  });

  it('keeps v2 tree status dots circular while using virtual horizontal scroll for long labels', () => {
    const css = readV2ThemeCss();
    const source = readSidebarSource();
    expect(css).toMatch(/\.gn-v2-explorer-tree-shell \{[^}]*--gn-v2-tree-horizontal-scroll-reserve: 32px;[^}]*overflow: hidden !important;/s);
    expect(css).toMatch(/\.gn-v2-explorer-tree-shell \.sidebar-tree-scroll-content \{[^}]*display: flex;[^}]*height: 100%;[^}]*padding: 4px 0 0;/s);
    expect(css).toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree \{[^}]*flex: 1 1 auto;[^}]*width: 100%;[^}]*min-width: 0;[^}]*height: 100%;/s);
    expect(css).toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree-list \{[^}]*position: relative;[^}]*height: 100%;[^}]*min-height: 0;[^}]*box-sizing: border-box;/s);
    expect(css).toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree-list-holder-inner \{[^}]*width: 100%;[^}]*min-width: 100%;/s);
    expect(css).not.toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree-list-holder-inner \{[^}]*width: max-content;/s);
    expect(css).not.toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree-list \{[^}]*position: static !important;/s);
    expect(css).toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree-list-holder \{[^}]*height: calc\(100% - var\(--gn-v2-tree-horizontal-scroll-reserve\)\);[^}]*max-height: calc\(100% - var\(--gn-v2-tree-horizontal-scroll-reserve\)\) !important;/s);
    expect(css).toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree-list-holder \{[^}]*overflow-x: hidden !important;/s);
    expect(css).not.toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree-list-holder \{[^}]*overflow-x: auto !important;/s);
    expect(css).not.toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree-list-holder \{[^}]*padding-bottom: var\(--gn-v2-tree-horizontal-scroll-reserve\);/s);
    expect(css).toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree-list-scrollbar-horizontal \{[^}]*height: 12px !important;[^}]*bottom: 0 !important;/s);
    expect(css).not.toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree-list-scrollbar-horizontal \{[^}]*bottom: calc\(\(var\(--gn-v2-tree-horizontal-scroll-reserve\) - 12px\) \/ 2\) !important;/s);
    const horizontalScrollbarCss = readCssRuleBlock(css, 'body[data-ui-version="v2"] .gn-v2-explorer-tree-shell .ant-tree-list-scrollbar-horizontal');
    expect(horizontalScrollbarCss).toContain('border-radius: 999px !important;');
    expect(horizontalScrollbarCss).toContain('background: transparent !important;');
    expect(horizontalScrollbarCss).toContain('box-shadow: none !important;');
    expect(css).toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree-list-scrollbar-horizontal \.ant-tree-list-scrollbar-thumb \{[^}]*height: 8px !important;/s);
    const treeContentWrapperCss = readCssRuleBlock(css, 'body[data-ui-version="v2"] .gn-v2-explorer-tree-shell .ant-tree-node-content-wrapper');
    expect(treeContentWrapperCss).toContain('min-width: 100%;');
    expect(treeContentWrapperCss).toContain('width: max-content !important;');
    expect(treeContentWrapperCss).toContain('display: flex !important;');
    expect(css).toMatch(/\.gn-v2-tree-title\.is-connection \{[^}]*align-items:\s*center;/s);
    const antTreeTitleCss = readCssRuleBlock(css, 'body[data-ui-version="v2"] .gn-v2-explorer-tree-shell .ant-tree-title');
    expect(antTreeTitleCss).toContain('min-width: max-content;');
    expect(antTreeTitleCss).toContain('flex: 0 0 auto;');
    expect(antTreeTitleCss).toContain('overflow: visible;');
    const antTreeTitleSpanCss = readCssRuleBlock(css, 'body[data-ui-version="v2"] .gn-v2-explorer-tree-shell .ant-tree-title > span');
    expect(antTreeTitleSpanCss).toContain('min-width: max-content;');
    expect(antTreeTitleSpanCss).toContain('overflow: visible;');
    expect(antTreeTitleSpanCss).toContain('text-overflow: clip;');
    const v2TreeTitleCss = readCssRuleBlock(css, 'body[data-ui-version="v2"] .gn-v2-explorer-tree-shell .ant-tree-title > .gn-v2-tree-title');
    expect(v2TreeTitleCss).toContain('width: max-content;');
    expect(v2TreeTitleCss).toContain('min-width: 100%;');
    expect(v2TreeTitleCss).toContain('overflow: visible;');
    expect(css).toMatch(/\.gn-v2-tree-status \{[^}]*width: 14px;[^}]*height: 14px;[^}]*flex: 0 0 14px;[^}]*overflow: visible;/s);
    expect(css).toMatch(/\.gn-v2-tree-status::before \{[^}]*width: 9px;[^}]*height: 9px;[^}]*border: 1\.5px solid var\(--gn-fg-4\);[^}]*border-radius: 50%;/s);
    expect(css).toMatch(/\.gn-v2-tree-status\.is-success::before \{[^}]*border: 0;[^}]*background: var\(--gn-status-connected\);[^}]*box-shadow: 0 0 0 3px color-mix\(in srgb, var\(--gn-status-connected\) 22%, transparent\);/s);
    const treeLabelCss = readCssRuleBlock(css, 'body[data-ui-version="v2"] .gn-v2-tree-label');
    expect(treeLabelCss).toContain('flex: 0 0 auto;');
    expect(treeLabelCss).toContain('overflow: visible;');
    expect(treeLabelCss).toContain('text-overflow: clip;');
    expect(css).toMatch(/\.gn-v2-tree-title\.is-mono \{[^}]*width: max-content;[^}]*min-width: 100%;[^}]*flex: 0 0 auto;/s);
    expect(css).toMatch(/\.gn-v2-tree-title\.is-mono \.gn-v2-tree-label \{[^}]*flex: 0 0 auto;[^}]*overflow: visible;[^}]*text-overflow: clip;/s);
    expect(css).toMatch(/\.gn-v2-tree-folder-icon \{[^}]*width: 22px;[^}]*height: 22px;[^}]*flex: 0 0 22px;/s);
    expect(css).not.toContain('.gn-v2-tree-connection-meta');
  });

  it('shows the v2 tree vertical scrollbar only during user scrolling', () => {
    const css = readV2ThemeCss();
    const source = readSourceFile('./Sidebar.tsx');

    expect(source).toContain("isTreeScrolling ? ' is-vertical-scrolling' : ''");
    expect(source).toContain('onWheelCapture={handleTreeWheel}');
    expect(source).toContain('onTouchMoveCapture={markTreeScrollActivity}');
    expect(source).toContain('setIsTreeScrolling(false)');
    expect(source).toContain('SIDEBAR_TREE_SCROLL_IDLE_DELAY_MS = 2000');
    expect(source).toContain('}, SIDEBAR_TREE_SCROLL_IDLE_DELAY_MS);');

    const idleScrollbarCss = readCssRuleBlock(
      css,
      'body[data-ui-version="v2"] .gn-v2-explorer-tree-shell .ant-tree-list-scrollbar-vertical',
    );
    expect(idleScrollbarCss).toContain('visibility: hidden !important;');
    expect(idleScrollbarCss).toContain('pointer-events: none;');

    const activeScrollbarCss = readCssRuleBlock(
      css,
      'body[data-ui-version="v2"] .gn-v2-explorer-tree-shell.is-vertical-scrolling .ant-tree-list-scrollbar-vertical',
    );
    expect(activeScrollbarCss).toContain('visibility: visible !important;');
    expect(activeScrollbarCss).toContain('pointer-events: auto;');

    const movingScrollbarCss = readCssRuleBlock(
      css,
      'body[data-ui-version="v2"] .gn-v2-explorer-tree-shell .ant-tree-list-scrollbar-vertical:has(.ant-tree-list-scrollbar-thumb-moving)',
    );
    expect(movingScrollbarCss).toContain('visibility: visible !important;');
    expect(movingScrollbarCss).toContain('pointer-events: auto;');
  });

  it('estimates a v2 tree scroll width only when content is wider than the viewport', () => {
    const narrowWidth = estimateV2TreeHorizontalScrollWidth([
      {
        title: 'front_end_sys',
        key: 'db-front-end',
        type: 'database',
        children: [{
          title: 'com_vod_error_file_tmp_with_a_very_long_table_name',
          key: 'table-long',
          type: 'table',
        }],
      },
    ] as any, 260);
    const wideWidth = estimateV2TreeHorizontalScrollWidth([
      {
        title: 'users',
        key: 'table-users',
        type: 'table',
      },
    ] as any, 900);
    const veryLongWidth = estimateV2TreeHorizontalScrollWidth([
      {
        title: `example.main.${'order_detail_with_long_business_suffix_'.repeat(6)}`,
        key: 'table-very-long',
        type: 'table',
      },
    ] as any, 320);
    expect(veryLongWidth).toBeGreaterThan(960);
    expect(veryLongWidth).toBeLessThanOrEqual(2600);
    expect(wideWidth).toBeUndefined();
  });

  it('includes table metadata suffixes when estimating v2 tree horizontal scroll width', () => {
    setCurrentLanguage('zh-CN');

    const tableNode = [{
      title: 'orders',
      key: 'table-orders',
      type: 'table',
      dataRef: {
        tableComment: '订单归档明细按月分区',
        rowCount: 2_450_000,
        tableSize: 157_286_400,
        createdAt: '2026-07-01 08:30:00',
        updatedAt: '2026-07-02 09:45:00',
      },
    }];
    const viewportWidth = 360;
    const titleOnlyWidth = estimateV2TreeHorizontalScrollWidth(tableNode as any, viewportWidth, []);
    const metadataWidth = estimateV2TreeHorizontalScrollWidth(
      tableNode as any,
      viewportWidth,
      ['comment', 'rows', 'size', 'createdAt', 'updatedAt'],
    );

    expect(titleOnlyWidth).toBeUndefined();
    expect(metadataWidth).toBeGreaterThan(viewportWidth);
    expect(metadataWidth).toBeGreaterThan(titleOnlyWidth ?? viewportWidth);
  });

  it('does not repeat the active connection as an object-tree root in v2', () => {
    mocks.state.connections = [{
      id: 'conn-local',
      name: '本地',
      config: {
        type: 'mysql',
        host: 'localhost',
        port: 3306,
      },
    }];
    mocks.state.activeContext = { connectionId: 'conn-local', dbName: 'app_db' };
    mocks.state.activeTabId = '';
    mocks.state.tabs = [];
    mocks.state.appearance = {
      enabled: true,
      opacity: 1,
      blur: 0,
      uiVersion: 'v2',
      sidebarHiddenObjectGroups: [],
    };

    const markup = renderSidebarMarkup({ uiVersion: 'v2' });

    expect(markup).toContain('gn-v2-connection-rail');
    expect(markup).toContain('gn-v2-explorer-actions');
    expect(markup).not.toContain('gn-v2-active-connection-header');
    expect(markup).not.toContain('gn-v2-active-connection-copy');
    expect(markup).not.toContain('gn-v2-live-dot');
    expect(markup).not.toContain('<span>localhost</span>');
    expect(markup).not.toContain('gn-v2-db-icon-label');
  });

  it('keeps the v2 explorer actions available when no host is selected', () => {
    setCurrentLanguage('en-US');

    mocks.state.connections = [{
      id: 'conn-local',
      name: '本地',
      config: {
        type: 'mysql',
        host: 'localhost',
        port: 3306,
      },
    }];
    mocks.state.activeContext = null;
    mocks.state.activeTabId = '';
    mocks.state.tabs = [];
    mocks.state.appearance = {
      enabled: true,
      opacity: 1,
      blur: 0,
      uiVersion: 'v2',
      sidebarHiddenObjectGroups: [],
    };

    const markup = renderSidebarMarkup({ uiVersion: 'v2' });

    expect(markup).toContain('gn-v2-explorer-actions');
    expect(markup).not.toContain('gn-v2-active-connection-header');
    expect(markup).not.toContain('gn-v2-active-connection-copy');
  });

  it('normalizes rc-tree absolute drop positions back to relative positions', () => {
    expect(normalizeSidebarTreeRelativeDropPosition(4, '0-0-4')).toBe(0);
    expect(normalizeSidebarTreeRelativeDropPosition(3, '0-0-4')).toBe(-1);
    expect(normalizeSidebarTreeRelativeDropPosition(5, '0-0-4')).toBe(1);
  });

  it('resolves insert-before from either relative drop position or pointer position', () => {
    expect(resolveSidebarDropInsertBefore(-1, null)).toBe(true);
    expect(resolveSidebarDropInsertBefore(1, null)).toBe(false);
    expect(resolveSidebarDropInsertBefore(0, {
      clientY: 102,
      top: 100,
      height: 20,
    })).toBe(true);
    expect(resolveSidebarDropInsertBefore(0, {
      clientY: 118,
      top: 100,
      height: 20,
    })).toBe(false);
  });

  it('makes the group row the primary drop target when moving a Host into a group', () => {
    expect(resolveSidebarTreeDropPlacement({
      dragNodeType: 'connection',
      dropNodeType: 'tag',
      relativeDropPosition: -1,
      dropToGap: true,
      fallbackInsertBefore: true,
    })).toBe('inside');
    expect(resolveSidebarTreeDropPlacement({
      dragNodeType: 'connection',
      dropNodeType: 'tag',
      relativeDropPosition: 1,
      dropToGap: true,
      fallbackInsertBefore: false,
    })).toBe('inside');
    expect(resolveSidebarTreeDropPlacement({
      dragNodeType: 'connection',
      dropNodeType: 'tag',
      relativeDropPosition: 1,
      dropToGap: true,
      fallbackInsertBefore: false,
      metrics: { clientY: 115, top: 100, height: 30 },
    })).toBe('inside');
    expect(resolveSidebarTreeDropPlacement({
      dragNodeType: 'connection',
      dropNodeType: 'tag',
      relativeDropPosition: 0,
      dropToGap: false,
      fallbackInsertBefore: false,
      metrics: { clientY: 102, top: 100, height: 30 },
    })).toBe('before');
    expect(resolveSidebarTreeDropPlacement({
      dragNodeType: 'connection',
      dropNodeType: 'tag',
      relativeDropPosition: 0,
      dropToGap: false,
      fallbackInsertBefore: true,
      metrics: { clientY: 128, top: 100, height: 30 },
    })).toBe('after');
  });

  it('preserves explicit before and after gaps when dragging groups or reordering Hosts', () => {
    expect(resolveSidebarTreeDropPlacement({
      dragNodeType: 'tag',
      dropNodeType: 'tag',
      relativeDropPosition: -1,
      dropToGap: true,
      fallbackInsertBefore: true,
    })).toBe('before');
    expect(resolveSidebarTreeDropPlacement({
      dragNodeType: 'tag',
      dropNodeType: 'tag',
      relativeDropPosition: 1,
      dropToGap: true,
      fallbackInsertBefore: false,
    })).toBe('after');
    expect(resolveSidebarTreeDropPlacement({
      dragNodeType: 'tag',
      dropNodeType: 'tag',
      relativeDropPosition: 0,
      dropToGap: false,
      fallbackInsertBefore: false,
    })).toBe('inside');
  });

  it('maps Host group drop intent to stable moveConnectionToTag arguments', () => {
    const common = {
      targetTagId: 'child',
      targetTagParentId: 'parent',
      targetTagToken: 'tag:child',
    };

    expect(resolveSidebarHostGroupDropDestination({
      ...common,
      placement: 'inside',
    })).toEqual({
      targetParentTagId: 'child',
      targetToken: null,
      insertBefore: false,
    });
    expect(resolveSidebarHostGroupDropDestination({
      ...common,
      placement: 'before',
    })).toEqual({
      targetParentTagId: 'parent',
      targetToken: 'tag:child',
      insertBefore: true,
    });
    expect(resolveSidebarHostGroupDropDestination({
      ...common,
      placement: 'after',
    })).toEqual({
      targetParentTagId: 'parent',
      targetToken: 'tag:child',
      insertBefore: false,
    });
  });

  it('resolves sidebar drop node metadata from DOM markers', () => {
    vi.stubGlobal('document', {
      elementFromPoint: () => null,
    });
    const marker = {
      getAttribute: (name: string) => {
        if (name === 'data-sidebar-node-key') return 'conn-a';
        if (name === 'data-sidebar-node-type') return 'connection';
        return null;
      },
    };
    const target = {
      closest: (selector: string) => selector === '[data-sidebar-node-key]' ? marker : null,
    };

    expect(resolveSidebarDropNodeFromDomEvent({
      target: target as unknown as EventTarget,
    })).toEqual({
      key: 'conn-a',
      type: 'connection',
    });
    vi.unstubAllGlobals();
  });

  it('resolves sidebar drop target metrics from the full tree row instead of nested children', () => {
    vi.stubGlobal('document', {
      elementFromPoint: () => null,
    });
    const treeNode = {
      getBoundingClientRect: () => ({
        top: 128,
        height: 26,
      }),
    };
    const target = {
      closest: (selector: string) => {
        if (selector === '.ant-tree-treenode') return treeNode;
        return null;
      },
    };

    expect(resolveSidebarDropTargetMetricsFromDomEvent({
      target: target as unknown as EventTarget,
    })).toEqual({
      top: 128,
      height: 26,
    });
    vi.unstubAllGlobals();
  });

  it('resolves sidebar drop metadata and row geometry from the same DOM hit', () => {
    const elementFromPoint = vi.fn();
    const treeNode = {
      getAttribute: (name: string) => {
        if (name === 'data-sidebar-node-key') return 'tag-prod';
        if (name === 'data-sidebar-node-type') return 'tag';
        return null;
      },
      querySelector: () => null,
      getBoundingClientRect: () => ({ top: 96, height: 30 }),
    };
    const target = {
      closest: (selector: string) => selector === '.ant-tree-treenode' ? treeNode : null,
    };
    elementFromPoint.mockReturnValue(target);
    vi.stubGlobal('document', { elementFromPoint });

    expect(resolveSidebarDropDomHit({ clientX: 80, clientY: 111 })).toEqual({
      key: 'tag-prod',
      type: 'tag',
      metrics: { top: 96, height: 30 },
    });
    expect(elementFromPoint).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('renders a clear whole-row group target for Host drops', () => {
    const baseOptions = {
      node: {
        type: 'tag',
        key: 'tag-prod',
        title: '生产环境',
        dataRef: { id: 'prod' },
      },
      hoverTitle: '生产环境',
      statusBadge: null,
      getV2TreeMetaText: () => '',
      sidebarTableMetadataFields: [],
      snapshotTreeSelectionBeforeDrag: vi.fn(),
      restoreTreeSelectionAfterDrag: vi.fn(),
      treeDragSelectSuppressUntilRef: { current: 0 },
      setIsTreeDragging: vi.fn(),
    };
    const targetMarkup = renderToStaticMarkup(renderSidebarV2TreeTitle({
      ...baseOptions,
      sidebarDropPlacement: 'inside',
    }));
    const idleMarkup = renderToStaticMarkup(renderSidebarV2TreeTitle(baseOptions));

    expect(targetMarkup).toContain('is-connection-group');
    expect(targetMarkup).toContain('is-drop-inside');
    expect(targetMarkup).toContain('data-sidebar-drop-placement="inside"');
    expect(idleMarkup).not.toContain('is-drop-inside');
  });

  it('uses V2-only capture DnD with a compact preview and stable whole-row states', () => {
    const source = readSourceFile('./Sidebar.tsx');
    const css = readV2ThemeCss();

    expect(source).toContain('onDragOverCapture={handleSidebarTreeDragOverCapture}');
    expect(source).toContain('onDropCapture={handleSidebarTreeDropCapture}');
    expect(source).toContain('if (!isV2Ui) return null;');
    expect(source).toContain('resolveSidebarDropDomHit(event)');
    expect(source).toContain('resolveSidebarHostGroupDropDestination({');
    expect(source).toContain('sidebarTreeDragPreviewElementRef.current = isV2Ui');
    expect(source).toContain("&& sidebarTreeDragNodeRef.current?.type === 'connection'");
    expect(source).toContain('dataTransfer.setDragImage(preview, 18, 15)');
    expect(source).toContain('SIDEBAR_GROUP_HOVER_EXPAND_DELAY_MS = 500');
    expect(css).toContain('.ant-tree-treenode:has(.gn-v2-tree-title.is-drop-inside)');
    expect(css).toContain('.gn-v2-sidebar-tree-drag-preview');
    expect(css).toContain('cursor: grabbing !important;');
    expect(css).not.toContain('.gn-v2-tree-host-drop-hint');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('treats centered tag drops as directional reordering instead of no-op', () => {
    expect(resolveSidebarTagDropInsertBefore({
      currentTagOrder: ['tag-dev', 'tag-test', 'tag-prod'],
      dragTagId: 'tag-prod',
      dropTagId: 'tag-dev',
      relativeDropPosition: 0,
      fallbackInsertBefore: false,
      metrics: {
        clientY: 113,
        top: 100,
        height: 26,
      },
    })).toBe(true);

    expect(resolveSidebarTagDropInsertBefore({
      currentTagOrder: ['tag-dev', 'tag-test', 'tag-prod'],
      dragTagId: 'tag-dev',
      dropTagId: 'tag-prod',
      relativeDropPosition: 0,
      fallbackInsertBefore: true,
      metrics: {
        clientY: 113,
        top: 100,
        height: 26,
      },
    })).toBe(false);
  });

  it('skips sidebar select side effects while tree dragging is active', () => {
    expect(shouldSkipSidebarSelectWhileDragging(true, { selected: true })).toBe(true);
    expect(shouldSkipSidebarSelectWhileDragging(false, { selected: false })).toBe(true);
    expect(shouldSkipSidebarSelectWhileDragging(false, { selected: true })).toBe(false);
  });

  it('skips sidebar lazy load on expand while tree dragging is active', () => {
    expect(shouldSkipSidebarLoadOnExpandWhileDragging(true, {
      expanded: true,
      node: { type: 'connection', children: undefined, isLeaf: false } as any,
    })).toBe(true);
    expect(shouldSkipSidebarLoadOnExpandWhileDragging(false, {
      expanded: false,
      node: { type: 'connection', children: undefined, isLeaf: false } as any,
    })).toBe(true);
    expect(shouldSkipSidebarLoadOnExpandWhileDragging(false, {
      expanded: true,
      node: { type: 'connection', children: undefined, isLeaf: false } as any,
    })).toBe(false);
  });

  it('renders the v2 connection group context menu for rail group management', () => {
    setCurrentLanguage('en-US');

    const markup = renderToStaticMarkup(
      <V2ConnectionGroupContextMenuView
        groupName="生产环境"
        count={2}
      />,
    );

    expect(markup).toContain('data-v2-connection-group-context-menu="true"');
    expect(markup).toContain('生产环境');
    expect(markup).toContain(t('connection.sidebar.group.meta', { count: '2' }));
    expect(markup).toContain(t('connection.sidebar.group.badge'));
    expect(markup).toContain(t('connection.sidebar.group.edit'));
    expect(markup).toContain(t('connection.sidebar.group.delete'));
  });

  it('filters the v2 explorer tree by object kind tabs', () => {
    const tree = [{
      title: 'front_end_sys',
      key: 'conn-main',
      type: 'database' as const,
      children: [
        {
          title: '已存查询 · saved',
          key: 'conn-main-queries',
          type: 'queries-folder' as const,
          children: [{ title: '日常查询', key: 'query-1', type: 'saved-query' as const }],
        },
        {
          title: '表',
          key: 'conn-main-tables',
          type: 'object-group' as const,
          dataRef: { groupKey: 'tables' },
          children: [{ title: 'users', key: 'users', type: 'table' as const }],
        },
        {
          title: '视图',
          key: 'conn-main-views',
          type: 'object-group' as const,
          dataRef: { groupKey: 'views' },
          children: [{ title: 'v_users', key: 'v_users', type: 'view' as const }],
        },
        {
          title: '序列',
          key: 'conn-main-sequences',
          type: 'object-group' as const,
          dataRef: { groupKey: 'sequences' },
          children: [{ title: 'seq_person_id', key: 'seq_person_id', type: 'sequence' as const }],
        },
        {
          title: '函数',
          key: 'conn-main-routines',
          type: 'object-group' as const,
          dataRef: { groupKey: 'routines' },
          children: [{ title: 'calc_total', key: 'calc_total', type: 'routine' as const }],
        },
        {
          title: '存储包',
          key: 'conn-main-packages',
          type: 'object-group' as const,
          dataRef: { groupKey: 'packages' },
          children: [{ title: 'pkg_person', key: 'pkg_person', type: 'package' as const }],
        },
        {
          title: '事件',
          key: 'conn-main-events',
          type: 'object-group' as const,
          dataRef: { groupKey: 'events' },
          children: [{ title: 'daily_cleanup', key: 'daily_cleanup', type: 'db-event' as const }],
        },
      ],
    }];

    expect(filterV2ExplorerTreeByKind(tree, 'all')[0].children?.map((node: { key: string }) => node.key)).toEqual([
      'conn-main-queries',
      'conn-main-tables',
      'conn-main-views',
      'conn-main-sequences',
      'conn-main-routines',
      'conn-main-packages',
      'conn-main-events',
    ]);
    expect(filterV2ExplorerTreeByKind(tree, 'tables')[0].children?.map((node: { key: string }) => node.key)).toEqual(['conn-main-tables']);
    expect(filterV2ExplorerTreeByKind(tree, 'views')[0].children?.map((node: { key: string }) => node.key)).toEqual(['conn-main-views']);
    expect(filterV2ExplorerTreeByKind(tree, 'sequences')[0].children?.map((node: { key: string }) => node.key)).toEqual(['conn-main-sequences']);
    expect(filterV2ExplorerTreeByKind(tree, 'routines')[0].children?.map((node: { key: string }) => node.key)).toEqual(['conn-main-routines']);
    expect(filterV2ExplorerTreeByKind(tree, 'packages')[0].children?.map((node: { key: string }) => node.key)).toEqual(['conn-main-packages']);
    expect(filterV2ExplorerTreeByKind(tree, 'events')[0].children?.map((node: { key: string }) => node.key)).toEqual(['conn-main-events']);
  });

  it('hides external SQL roots from v2 object kind filters', () => {
    const tree = [
      {
        title: 'front_end_sys',
        key: 'conn-main',
        type: 'database' as const,
        children: [
          {
            title: '表',
            key: 'conn-main-tables',
            type: 'object-group' as const,
            dataRef: { groupKey: 'tables' },
            children: [{ title: 'users', key: 'users', type: 'table' as const }],
          },
        ],
      },
      {
        title: '外部 SQL 目录',
        key: 'external-sql-root',
        type: 'external-sql-root' as const,
        children: [
          {
            title: 'scripts',
            key: 'external-sql-folder:scripts',
            type: 'external-sql-folder' as const,
          },
        ],
      },
    ];

    expect(filterV2ExplorerTreeByKind(tree, 'all').map((node: { key: string }) => node.key)).toEqual([
      'conn-main',
      'external-sql-root',
    ]);
    expect(filterV2ExplorerTreeByKind(tree, 'tables').map((node: { key: string }) => node.key)).toEqual(['conn-main']);
  });

  it('renders the v2 table context menu with the redesigned table layout', () => {
    const markup = renderToStaticMarkup(
      <V2TableContextMenuView
        tableName="fs_mkefu_server_info"
        stats={{
          rowCount: 2,
          dataLength: 16 * 1024,
          indexLength: 16 * 1024,
          engine: 'InnoDB',
        }}
        supportsTruncate
      />,
    );

    expect(markup).toContain('data-v2-table-context-menu="true"');
    expect(markup).toContain('fs_mkefu_server_info');
    expect(markup).toContain('InnoDB');
    expect(markup).toContain('2 行 · 16 KB 数据 · 16 KB 索引');
    expect(markup).toContain('查看数据');
    expect(markup).toContain('↵');
    expect(markup).toContain('置顶表');
    expect(markup).toContain('字段 / 索引 / 外键');
    expect(markup).toContain('在新标签打开');
    expect(markup).toContain('Ctrl+Enter');
    expect(markup).toContain('元信息');
    expect(markup).toContain('查看 DDL · CREATE TABLE');
    expect(markup).toContain('在 ER 图中查看');
    expect(markup).toContain('复制');
    expect(markup).toContain('复制表名');
    expect(markup).toContain('复制表结构 · DDL');
    expect(markup).toContain('复制全表为 INSERT');
    expect(markup).toContain('维护');
    expect(markup).toContain('重命名…');
    expect(markup).toContain('备份 · SQL Dump');
    expect(markup).toContain('刷新统计信息');
    expect(markup).toContain('导出表数据');
    expect(markup).toContain('打开导出工作台…');
    expect(markup).toContain('批量处理表');
    expect(markup).not.toContain('Excel · .xlsx');
    expect(markup).not.toContain('CSV · .csv');
    expect(markup).not.toContain('JSON · .json');
    expect(markup).not.toContain('Markdown · .md');
    expect(markup).not.toContain('HTML · .html');
    expect(markup).toContain('用 AI 解释这张表');
    expect(markup).toContain('用 AI 生成查询');
    expect(markup).toContain('截断表 · TRUNCATE');
    expect(markup).toContain('删除表 · DROP');
    expect(markup).not.toContain('清空表');
  });

  it('renders the v2 table context menu pinned state', () => {
    const markup = renderToStaticMarkup(
      <V2TableContextMenuView
        tableName="fs_mkefu_server_info"
        isPinned
      />,
    );

    expect(markup).toContain('取消置顶');
    expect(markup).toContain('已置顶');
    expect(markup).not.toContain('置顶表');
  });

  it('renders the v2 database context menu pin and unpin states', () => {
    const unpinnedMarkup = renderToStaticMarkup(
      <V2DatabaseContextMenuView dbName="analytics" />,
    );
    const pinnedMarkup = renderToStaticMarkup(
      <V2DatabaseContextMenuView dbName="analytics" isPinned />,
    );

    expect(unpinnedMarkup).toContain('置顶数据库');
    expect(unpinnedMarkup).not.toContain('取消置顶数据库');
    expect(pinnedMarkup).toContain('取消置顶数据库');
    expect(pinnedMarkup).toContain('已置顶');
  });

  it('wires database pin actions to persistence and in-memory tree reordering', () => {
    const actionSource = readSourceFile('./sidebar/useSidebarV2ActionHandlers.tsx');
    const contextMenuSource = readSourceFile('./sidebar/useSidebarV2ContextMenu.tsx');
    const loaderSource = readSourceFile('./sidebar/useSidebarTreeLoaders.tsx');

    expect(actionSource).toContain("case 'pin-database':");
    expect(actionSource).toContain("case 'unpin-database':");
    expect(actionSource).toContain('setSidebarDatabasePinned(connectionId, dbName, shouldPin);');
    expect(actionSource).toContain('applySidebarDatabasePinning(');
    expect(actionSource).toContain('buildV2SidebarDatabaseSectionedChildren(');
    expect(loaderSource).toContain('buildV2SidebarDatabaseSectionedChildren(');
    expect(contextMenuSource).toContain('isSidebarDatabasePinned(');
    expect(contextMenuSource).toContain('isPinned={isPinned}');
  });

  it('preserves schema context when opening table designer tabs', () => {
    const source = readSourceFile('./Sidebar.tsx');

    expect(source).toMatch(/const openDesign = \(node: any,[\s\S]*?schemaName[\s\S]*?type: 'design',[\s\S]*?schemaName,/);
    expect(source).toMatch(/const openNewTableDesign = \(node: any\)[\s\S]*?schemaName[\s\S]*?type: 'design',[\s\S]*?schemaName,/);
    expect(source).toContain("design-${id}-${dbName}-${schemaName || 'default'}-${tableName}");
  });

  it('moves pinned databases first while preserving loaded database children', () => {
    const pinnedSidebarDatabases = [
      buildSidebarDatabasePinKey('conn-1', 'analytics'),
    ];
    const loadedChildren = [{ title: 'Tables', key: 'analytics-tables', type: 'object-group' as const }];
    const nodes = [
      { title: 'archive', key: 'conn-1-archive', type: 'database' as const, dataRef: { id: 'conn-1', dbName: 'archive' } },
      { title: 'analytics', key: 'conn-1-analytics', type: 'database' as const, dataRef: { id: 'conn-1', dbName: 'analytics' }, children: loadedChildren },
      { title: 'system', key: 'conn-1-system', type: 'database' as const, dataRef: { id: 'conn-1', dbName: 'system' } },
    ];

    expect(isSidebarDatabasePinned(pinnedSidebarDatabases, 'conn-1', 'analytics')).toBe(true);
    const result = applySidebarDatabasePinning(nodes, {
      connectionId: 'conn-1',
      pinnedSidebarDatabases,
    });

    expect(result.map((node) => node.title)).toEqual(['analytics', 'archive', 'system']);
    expect(result[0].dataRef?.pinnedSidebarDatabase).toBe(true);
    expect(result[0].children).toBe(loadedChildren);
    expect(result[1].dataRef?.pinnedSidebarDatabase).toBeUndefined();
  });

  it('restores a database to its original position after unpinning', () => {
    const pinKey = buildSidebarDatabasePinKey('conn-1', 'analytics');
    const loadedChildren = [{ title: 'Tables', key: 'analytics-tables', type: 'object-group' as const }];
    const nodes = [
      { title: 'archive', key: 'conn-1-archive', type: 'database' as const, dataRef: { id: 'conn-1', dbName: 'archive' } },
      { title: 'analytics', key: 'conn-1-analytics', type: 'database' as const, dataRef: { id: 'conn-1', dbName: 'analytics' }, children: loadedChildren },
      { title: 'system', key: 'conn-1-system', type: 'database' as const, dataRef: { id: 'conn-1', dbName: 'system' } },
    ];

    const pinned = applySidebarDatabasePinning(nodes, {
      connectionId: 'conn-1',
      pinnedSidebarDatabases: [pinKey],
    });
    const unpinned = applySidebarDatabasePinning(pinned, {
      connectionId: 'conn-1',
      pinnedSidebarDatabases: [],
    });

    expect(pinned.map((node) => node.title)).toEqual(['analytics', 'archive', 'system']);
    expect(unpinned.map((node) => node.title)).toEqual(['archive', 'analytics', 'system']);
    expect(unpinned[1].children).toBe(loadedChildren);
    expect(unpinned[1].dataRef?.pinnedSidebarDatabase).toBeUndefined();
  });

  it('splits pinned databases into pinned and all sections', () => {
    setCurrentLanguage('en-US');
    const databaseNodes = [
      { title: 'analytics', key: 'conn-1-analytics', type: 'database' as const, dataRef: { pinnedSidebarDatabase: true } },
      { title: 'archive', key: 'conn-1-archive', type: 'database' as const, dataRef: {} },
    ];

    const children = buildV2SidebarDatabaseSectionedChildren('conn-1', databaseNodes);

    expect(children.map((node) => node.title)).toEqual(['Pinned', 'analytics', 'All', 'archive']);
    expect(children.map((node) => node.type)).toEqual([
      'v2-database-section',
      'database',
      'v2-database-section',
      'database',
    ]);
    expect(children[0]).toMatchObject({
      key: 'conn-1-v2-pinned-databases-section',
      isLeaf: true,
      selectable: false,
      dataRef: { sectionKind: 'pinned' },
    });
    expect(children[2]).toMatchObject({
      key: 'conn-1-v2-all-databases-section',
      isLeaf: true,
      selectable: false,
      dataRef: { sectionKind: 'all' },
    });
    const sectionMarkup = renderToStaticMarkup(renderSidebarV2TreeTitle({
      node: children[0],
      hoverTitle: 'Pinned',
      statusBadge: null,
      getV2TreeMetaText: () => '',
      sidebarTableMetadataFields: [],
      snapshotTreeSelectionBeforeDrag: vi.fn(),
      restoreTreeSelectionAfterDrag: vi.fn(),
      treeDragSelectSuppressUntilRef: { current: 0 },
      setIsTreeDragging: vi.fn(),
    }));
    expect(sectionMarkup).toContain('class="gn-v2-tree-section-title"');
    expect(sectionMarkup).toContain('data-section-kind="pinned"');
    expect(sectionMarkup).toContain('Pinned');
    expect(buildV2SidebarDatabaseSectionedChildren('conn-1', children).map((node) => node.title))
      .toEqual(['Pinned', 'analytics', 'All', 'archive']);

    const unpinnedNodes = databaseNodes.map((node) => ({
      ...node,
      dataRef: {},
    }));
    expect(buildV2SidebarDatabaseSectionedChildren('conn-1', unpinnedNodes)).toBe(unpinnedNodes);
  });

  it('sorts sidebar table names in natural numeric order', () => {
    const entries = [
      { tableName: 'table_10', displayName: 'table_10' },
      { tableName: 'table_2', displayName: 'table_2' },
      { tableName: 'table_1', displayName: 'table_1' },
    ];

    expect(sortSidebarTableEntries(entries, {
      connectionId: 'conn-1',
      dbName: 'main',
      sortBy: 'name',
    }).map((entry) => entry.tableName)).toEqual(['table_1', 'table_2', 'table_10']);
  });

  it('sorts pinned sidebar tables before the active sort mode', () => {
    const pinnedSidebarTables = [
      buildSidebarTablePinKey('conn-1', 'main', 'orders', 'public'),
    ];
    const entries = [
      { tableName: 'users', schemaName: 'public', displayName: 'users' },
      { tableName: 'orders', schemaName: 'public', displayName: 'orders' },
      { tableName: 'audit', schemaName: 'public', displayName: 'audit' },
    ];

    expect(isSidebarTablePinned(pinnedSidebarTables, 'conn-1', 'main', 'orders', 'public')).toBe(true);
    expect(sortSidebarTableEntries(entries, {
      connectionId: 'conn-1',
      dbName: 'main',
      sortBy: 'frequency',
      tableAccessCount: {
        'conn-1-main-users': 10,
        'conn-1-main-orders': 1,
        'conn-1-main-audit': 3,
      },
      pinnedSidebarTables,
    }).map((entry) => entry.tableName)).toEqual(['orders', 'users', 'audit']);
  });

  it('renders a non-interactive pin indicator only for pinned v2 sidebar tables', () => {
    const source = readSourceFile('./sidebar/SidebarTreeTitle.tsx');
    const css = readV2ThemeCss();
    const baseOptions = {
      hoverTitle: 'orders',
      statusBadge: null,
      getV2TreeMetaText: () => '',
      sidebarTableMetadataFields: [],
      snapshotTreeSelectionBeforeDrag: vi.fn(),
      restoreTreeSelectionAfterDrag: vi.fn(),
      treeDragSelectSuppressUntilRef: { current: 0 },
      setIsTreeDragging: vi.fn(),
    };
    const renderTableTitle = (pinnedSidebarTable: boolean) => renderToStaticMarkup(renderSidebarV2TreeTitle({
      ...baseOptions,
      node: {
        type: 'table',
        title: 'orders',
        key: 'conn-main-orders',
        dataRef: {
          id: 'conn',
          dbName: 'main',
          tableName: 'orders',
          pinnedSidebarTable,
        },
      },
    }));

    const unpinnedMarkup = renderTableTitle(false);
    const pinnedMarkup = renderTableTitle(true);
    expect(unpinnedMarkup).not.toContain('data-v2-sidebar-table-pin-indicator');
    expect(pinnedMarkup).toContain('data-v2-sidebar-table-pin-indicator="true"');
    expect(pinnedMarkup).toContain(`aria-label="${t('sidebar.status.pinned')}"`);
    expect(pinnedMarkup).not.toContain('<button');
    expect(pinnedMarkup).not.toContain('aria-pressed');
    expect(css).toMatch(/\.gn-v2-table-pin-indicator \{[^}]*pointer-events: none;[^}]*cursor: default;[^}]*color: var\(--gn-warn\);/s);
    expect(css).not.toContain('.gn-v2-table-pin-action');
  });

  it('renders the same non-interactive pin indicator for pinned databases', () => {
    const baseOptions = {
      hoverTitle: 'analytics',
      statusBadge: null,
      getV2TreeMetaText: () => '',
      sidebarTableMetadataFields: [],
      snapshotTreeSelectionBeforeDrag: vi.fn(),
      restoreTreeSelectionAfterDrag: vi.fn(),
      treeDragSelectSuppressUntilRef: { current: 0 },
      setIsTreeDragging: vi.fn(),
    };
    const renderDatabaseTitle = (pinnedSidebarDatabase: boolean) => renderToStaticMarkup(
      renderSidebarV2TreeTitle({
        ...baseOptions,
        node: {
          type: 'database',
          title: 'analytics',
          key: 'conn-1-analytics',
          dataRef: { id: 'conn-1', dbName: 'analytics', pinnedSidebarDatabase },
        },
      }),
    );

    expect(renderDatabaseTitle(false)).not.toContain('data-v2-sidebar-database-pin-indicator');
    const pinnedMarkup = renderDatabaseTitle(true);
    expect(pinnedMarkup).toContain('data-v2-sidebar-database-pin-indicator="true"');
    expect(pinnedMarkup).toContain('gn-v2-database-pin-indicator');
    expect(pinnedMarkup).toContain(`aria-label="${t('sidebar.status.pinned')}"`);
  });

  it('splits v2 sidebar pinned tables into a dedicated table section', () => {
    const source = readSidebarSource();
    const sectionBuilderSourceStart = source.indexOf('export const buildV2SidebarTableSectionedChildren = (');
    const sectionBuilderSourceEnd = source.indexOf('export const buildSidebarTableChildrenForUi = (');
    const sectionBuilderSource = source.slice(sectionBuilderSourceStart, sectionBuilderSourceEnd);

    setCurrentLanguage('en-US');

    const children = buildV2SidebarTableSectionedChildren('conn-main-tables', [
      { title: 'orders', key: 'orders', type: 'table', dataRef: { pinnedSidebarTable: true } },
      { title: 'users', key: 'users', type: 'table', dataRef: { pinnedSidebarTable: false } },
      { title: 'audit', key: 'audit', type: 'table', dataRef: {} },
    ]);

    expect(children.map((node) => node.title)).toEqual(['Pinned', 'orders', 'All', 'users', 'audit']);
    expect(children.map((node) => node.type)).toEqual(['v2-table-section', 'table', 'v2-table-section', 'table', 'table']);
    expect(children[0]).toMatchObject({
      key: 'conn-main-tables-v2-pinned-tables-section',
      isLeaf: true,
      selectable: false,
      dataRef: { sectionKind: 'pinned' },
    });
    expect(children[2]).toMatchObject({
      key: 'conn-main-tables-v2-all-tables-section',
      isLeaf: true,
      selectable: false,
      dataRef: { sectionKind: 'all' },
    });
  });

  it('keeps legacy sidebar table groups flat and ignores v2 pin sections', () => {
    const tableNodes = [
      { title: 'orders', key: 'orders', type: 'table' as const, dataRef: { pinnedSidebarTable: true } },
      { title: 'users', key: 'users', type: 'table' as const, dataRef: { pinnedSidebarTable: false } },
    ];
    const source = readSidebarSource();

    expect(buildSidebarTableChildrenForUi('conn-main-tables', tableNodes, false)).toBe(tableNodes);
    expect(buildSidebarTableChildrenForUi('conn-main-tables', tableNodes, true).map((node) => node.title)).toEqual([
      '置顶',
      'orders',
      '全部',
      'users',
    ]);
  });

  it('keeps v2 table sections out of regular table lists when nothing is pinned', () => {
    const tableNodes = [
      { title: 'users', key: 'users', type: 'table' as const, dataRef: { pinnedSidebarTable: false } },
    ];

    expect(buildV2SidebarTableSectionedChildren('conn-main-tables', tableNodes)).toBe(tableNodes);
  });

  it('renders v2 table section labels as tree children instead of group header badges', () => {
    const source = readSidebarSource();
    const css = readV2ThemeCss();
    expect(css).toContain('.gn-v2-tree-section-title');
    expect(css).toContain('.ant-tree-treenode:has(.gn-v2-tree-section-title)');
  });

  it('formats v2 table context menu stats like the prototype header', () => {
    setCurrentLanguage('en-US');

    expect(formatV2TableContextMenuRows(undefined)).toBe('— rows');
    expect(formatV2TableContextMenuRows(2)).toBe('2 rows');
    expect(formatV2TableContextMenuSize(16 * 1024)).toBe('16 KB');
  });

  it('formats v2 table context menu row counts with the current UI locale', () => {
    setCurrentLanguage('de-DE');

    expect(formatV2TableContextMenuRows(1234)).toBe('1.234 Zeilen');
  });

  it('localizes v2 table context menu stats meta copy', () => {
    setCurrentLanguage('en-US');

    expect(renderToStaticMarkup(
      <V2TableContextMenuView tableName="t1" />,
    )).toContain('Click refresh to load stats');

    expect(renderToStaticMarkup(
      <V2TableContextMenuView tableName="t1" stats={{ loading: true }} />,
    )).toContain('Loading table stats...');

    expect(renderToStaticMarkup(
      <V2TableContextMenuView tableName="t1" stats={{ unavailable: true }} />,
    )).toContain('Table stats unavailable');

    expect(renderToStaticMarkup(
      <V2TableContextMenuView
        tableName="t1"
        stats={{
          rowCount: 2,
          dataLength: 16 * 1024,
          indexLength: 16 * 1024,
        }}
      />,
    )).toContain('2 rows · 16 KB data · 16 KB indexes');
  });

  it('localizes v2 table context menu primary action copy in english', () => {
    setCurrentLanguage('en-US');

    const markup = renderToStaticMarkup(
      <V2TableContextMenuView tableName="t1" />,
    );

    expect(markup).toContain('View data');
    expect(markup).toContain('Pin table');
    expect(markup).toContain('Design table · columns / indexes / foreign keys');
    expect(markup).toContain('Open in new tab');
    expect(markup).toContain('New query');
    expect(markup).not.toContain('查看数据');
    expect(markup).not.toContain('设计表 · 字段 / 索引 / 外键');
    expect(markup).not.toContain('在新标签打开');
  });

  it('localizes v2 table context menu metadata copy in english while keeping raw create table', () => {
    setCurrentLanguage('en-US');

    const markup = renderToStaticMarkup(
      <V2TableContextMenuView tableName="t1" />,
    );

    expect(markup).toContain('Metadata');
    expect(markup).toContain('View DDL · CREATE TABLE');
    expect(markup).toContain('View in ER diagram');
    expect(markup).toContain('CREATE TABLE');
    expect(markup).not.toContain('元信息');
    expect(markup).not.toContain('查看 DDL · CREATE TABLE');
    expect(markup).not.toContain('在 ER 图中查看');
  });

  it('localizes v2 table context menu copy block in english while keeping raw ddl and insert', () => {
    setCurrentLanguage('en-US');

    const markup = renderToStaticMarkup(
      <V2TableContextMenuView tableName="t1" />,
    );

    expect(markup).toContain('Copy');
    expect(markup).toContain('Copy table name');
    expect(markup).toContain('Copy table structure · DDL');
    expect(markup).toContain('Copy entire table as INSERT');
    expect(markup).toContain('DDL');
    expect(markup).toContain('INSERT');
    expect(markup).not.toContain('复制表名');
    expect(markup).not.toContain('复制表结构 · DDL');
    expect(markup).not.toContain('复制全表为 INSERT');
  });

  it('localizes v2 table context menu maintenance block in english while keeping raw rollup and sql dump', () => {
    setCurrentLanguage('en-US');

    const markup = renderToStaticMarkup(
      <V2TableContextMenuView tableName="t1" supportsStarRocksRollup />,
    );

    expect(markup).toContain('Maintenance');
    expect(markup).toContain('Rename...');
    expect(markup).toContain('New Rollup');
    expect(markup).toContain('Backup · SQL Dump');
    expect(markup).toContain('Refresh stats');
    expect(markup).toContain('Rollup');
    expect(markup).toContain('SQL Dump');
    expect(markup).not.toContain('维护');
    expect(markup).not.toContain('重命名…');
    expect(markup).not.toContain('新增 Rollup');
    expect(markup).not.toContain('备份 · SQL Dump');
    expect(markup).not.toContain('刷新统计信息');
  });

  it('localizes v2 table context menu export block in english while keeping raw file formats and extensions', () => {
    setCurrentLanguage('en-US');

    const markup = renderToStaticMarkup(
      <V2TableContextMenuView tableName="t1" />,
    );

    expect(markup).toContain('Export table data');
    expect(markup).toContain('Open export workbench...');
    expect(markup).not.toContain('Excel · .xlsx');
    expect(markup).not.toContain('CSV · .csv');
    expect(markup).not.toContain('JSON · .json');
    expect(markup).not.toContain('导出表数据');
  });

  it('localizes v2 table context menu ai block in english', () => {
    setCurrentLanguage('en-US');

    const markup = renderToStaticMarkup(
      <V2TableContextMenuView tableName="t1" />,
    );

    expect(markup).toContain('Use AI to explain this table');
    expect(markup).toContain('Use AI to generate a query');
    expect(markup).not.toContain('用 AI 解释这张表');
    expect(markup).not.toContain('用 AI 生成查询');
  });

  it('localizes v2 table context menu danger block in english while keeping raw truncate and drop', () => {
    setCurrentLanguage('en-US');

    const markup = renderToStaticMarkup(
      <V2TableContextMenuView tableName="t1" supportsTruncate />,
    );

    expect(markup).toContain('Truncate table · TRUNCATE');
    expect(markup).toContain('Delete table · DROP');
    expect(markup).toContain('TRUNCATE');
    expect(markup).toContain('DROP');
    expect(markup).not.toContain('截断表 · TRUNCATE');
    expect(markup).not.toContain('删除表 · DROP');
  });

  it('keeps the v2 table context menu danger block raw truncate token outside the ru-RU label', () => {
    setCurrentLanguage('ru-RU');

    const markup = renderToStaticMarkup(
      <V2TableContextMenuView tableName="t1" supportsTruncate />,
    );

    expect(markup).toContain('TRUNCATE');
    expect(markup).not.toContain('TRUNCATE · TRUNCATE');
    expect(markup).not.toContain('через TRUNCATE · TRUNCATE');
  });

  it('renders the v2 database context menu with the redesigned grouped layout', () => {
    const markup = renderToStaticMarkup(
      <V2DatabaseContextMenuView
        dbName="mkefu_ai_dev"
        dialect="starrocks"
        supportsStarRocksActions
      />,
    );

    expect(markup).toContain('data-v2-database-context-menu="true"');
    expect(markup).toContain('mkefu_ai_dev');
    expect(markup).toContain('DB');
    expect(markup).toContain(t('sidebar.menu.copy_database_name'));
    expect(markup).toContain(t('sidebar.menu.create_table'));
    expect(markup).toContain(t('sidebar.menu.new_query'));
    expect(markup).toContain(t('sidebar.sql_file_exec.title'));
    expect(markup).toContain('StarRocks');
    expect(markup).toContain(t('sidebar.v2_database_menu.new_materialized_view'));
    expect(markup).toContain(t('sidebar.v2_database_menu.new_external_catalog'));
    expect(markup).toContain(t('sidebar.v2_table_menu.maintenance_section'));
    expect(markup).toContain(t('sidebar.menu.rename_database'));
    expect(markup).toContain(t('sidebar.v2_database_menu.refresh_object_tree'));
    expect(markup).toContain(t('sidebar.menu.close_database'));
    expect(markup).toContain(t('sidebar.v2_database_menu.export_backup_section'));
    expect(markup).toContain(t('sidebar.v2_database_menu.export_all_table_schema_sql'));
    expect(markup).toContain(t('sidebar.v2_database_menu.backup_all_tables_sql'));
    expect(markup).toContain(t('sidebar.action.batch_tables'));
    expect(markup).toContain(t('sidebar.action.batch_databases'));
    expect(markup).toContain(t('sidebar.v2_table_menu.item_with_suffix', { label: t('sidebar.menu.delete_database'), suffix: 'DROP' }));
  });

  it('resolves and wires database-name copy for both sidebar menu generations', () => {
    expect(resolveSidebarDatabaseNameForCopy({
      title: 'fallback_db',
      dataRef: { dbName: '  main_db  ' },
    })).toBe('main_db');
    expect(resolveSidebarDatabaseNameForCopy({ title: ' fallback_db ' })).toBe('fallback_db');
    expect(resolveSidebarDatabaseNameForCopy(null)).toBe('');

    const legacySource = readLegacyNodeMenuSource();
    const menuSource = readSourceFile('./V2TableContextMenu.tsx');
    const actionSource = readSourceFile('./sidebar/useSidebarV2ActionHandlers.tsx');
    const objectActionSource = readSourceFile('./sidebar/useSidebarObjectActions.tsx');
  });

  it('renders the v2 database schema action for PostgreSQL-compatible databases', () => {
    const markup = renderToStaticMarkup(
      <V2DatabaseContextMenuView
        dbName="app_db"
        dialect="postgres"
        supportsSchemaActions
      />,
    );

    expect(markup).toContain('新建模式');
  });

  it('localizes v2 database context menu actions in english while keeping raw database dialect tokens', () => {
    setCurrentLanguage('en-US');

    const markup = renderToStaticMarkup(
      <V2DatabaseContextMenuView
        dbName="mkefu_ai_dev"
        dialect="starrocks"
        supportsStarRocksActions
      />,
    );

    expect(markup).toContain('mkefu_ai_dev');
    expect(markup).toContain('DB');
    expect(markup).toContain('starrocks · Database actions');
    expect(markup).toContain('New table');
    expect(markup).toContain('New query');
    expect(markup).toContain('Run external SQL file');
    expect(markup).toContain('StarRocks');
    expect(markup).toContain('New materialized view');
    expect(markup).toContain('New external Catalog');
    expect(markup).toContain('Maintenance');
    expect(markup).toContain('Rename database');
    expect(markup).toContain('Refresh object tree');
    expect(markup).toContain('Close database');
    expect(markup).toContain('Export and backup');
    expect(markup).toContain('Export all table schemas · SQL');
    expect(markup).toContain('Back up all tables · schema + data SQL');
    expect(markup).toContain('Batch tables');
    expect(markup).toContain('Batch databases');
    expect(markup).toContain('Delete database · DROP');
    expect(markup).toContain('StarRocks');
    expect(markup).toContain('Catalog');
    expect(markup).toContain('SQL');
    expect(markup).toContain('DROP');
    expect(markup).not.toContain('数据库操作');
    expect(markup).not.toContain('新建表');
    expect(markup).not.toContain('新建物化视图');
    expect(markup).not.toContain('新建外部 Catalog');
    expect(markup).not.toContain('关闭数据库');
    expect(markup).not.toContain('导出与备份');
    expect(markup).not.toContain('删除数据库 · DROP');
  });

  it('localizes the v2 database schema action in english', () => {
    setCurrentLanguage('en-US');

    const markup = renderToStaticMarkup(
      <V2DatabaseContextMenuView
        dbName="app_db"
        dialect="postgres"
        supportsSchemaActions
      />,
    );

    expect(markup).toContain('New schema');
    expect(markup).not.toContain('新建模式');
  });

  it('localizes the v2 schema context menu while keeping raw schema and SQL tokens', () => {
    setCurrentLanguage('en-US');

    const markup = renderToStaticMarkup(
      <V2SchemaContextMenuView
        dbName="app_db"
        schemaName="sales"
      />,
    );

    expect(markup).toContain('data-v2-schema-context-menu="true"');
    expect(markup).toContain('sales');
    expect(markup).toContain('SCHEMA');
    expect(markup).toContain('app_db · Schema actions');
    expect(markup).toContain('Maintenance');
    expect(markup).toContain('Edit schema');
    expect(markup).toContain('Refresh object tree');
    expect(markup).toContain('Export and backup');
    expect(markup).toContain('Export current schema table structures · SQL');
    expect(markup).toContain('Back up all current schema tables · schema + data');
    expect(markup).toContain('Delete schema · DROP CASCADE');
    ['当前数据库', '模式操作', '维护', '编辑模式', '刷新对象树', '导出与备份', '导出当前模式表结构', '备份当前模式全部表', '删除模式'].forEach((rawSnippet) => {
      expect(markup).not.toContain(rawSnippet);
    });
  });

  it('renders the v2 connection context menu for host rail actions', () => {
    setCurrentLanguage('en-US');

    const markup = renderToStaticMarkup(
      <V2ConnectionContextMenuView
        connectionName="dev240"
        hostSummary="10.0.0.240:3306"
        driverLabel="mysql"
        tags={[
          { id: 'prod', name: '生产环境', selected: true },
          { id: 'debug', name: '临时调试' },
        ]}
      />,
    );

    expect(markup).toContain('data-v2-connection-context-menu="true"');
    expect(markup).toContain('dev240');
    expect(markup).toContain('mysql · 10.0.0.240:3306');
    expect(markup).toContain(t('connection.sidebar.menu.hostBadge'));
    expect(markup).toContain(t('connection.sidebar.menu.createDatabase'));
    expect(markup).toContain(t('connection.sidebar.menu.refresh'));
    expect(markup).toContain(t('sidebar.menu.new_query'));
    expect(markup).toContain(t('sidebar.sql_file_exec.title'));
    expect(markup).toContain(t('sidebar.menu.edit_connection'));
    expect(markup).toContain(t('connection.sidebar.menu.copy'));
    expect(markup).toContain(t('connection.sidebar.menu.disconnect'));
    expect(markup).toContain(t('connection.sidebar.menu.groupSection'));
    expect(markup).toContain('生产环境');
    expect(markup).toContain('临时调试');
    expect(markup).toContain(t('connection.sidebar.menu.moveToUngrouped'));
    expect(markup).toContain(t('connection.sidebar.menu.delete'));
  });

  it('renders localized connection action labels in the v2 menu', () => {
    setCurrentLanguage('en-US');

    const markup = renderToStaticMarkup(
      <V2ConnectionContextMenuView
        connectionName="dev240"
        driverLabel="mysql"
        tags={[
          { id: 'prod', name: 'Production', selected: true },
          { id: 'debug', name: 'Debug' },
        ]}
      />,
    );

    expect(markup).toContain('mysql · Address not configured');
    expect(markup).toContain(t('connection.sidebar.menu.hostBadge'));
    expect(markup).toContain('New database');
    expect(markup).toContain('Refresh connection');
    expect(markup).toContain('New query');
    expect(markup).toContain('Run external SQL file');
    expect(markup).toContain('Edit connection');
    expect(markup).toContain('Connection');
    expect(markup).toContain('Copy connection');
    expect(markup).toContain('Disconnect');
    expect(markup).toContain('Connection groups');
    expect(markup).toContain('Current');
    expect(markup).toContain('Remove from group');
    expect(markup).toContain('Delete connection');
  });

  it('renders localized redis connection action labels in the v2 menu', () => {
    setCurrentLanguage('en-US');

    const markup = renderToStaticMarkup(
      <V2ConnectionContextMenuView
        connectionName="redis-dev"
        driverLabel="redis"
        isRedis
      />,
    );

    expect(markup).toContain('Refresh connection');
    expect(markup).toContain('New command window');
    expect(markup).toContain('Redis instance monitor');
  });

  it('localizes sidebar JVM probe and resource failure prompts', () => {
    const source = readSidebarSource();

    SUPPORTED_LANGUAGES.forEach((language) => {
      setCurrentLanguage(language);
      expect(
        t('sidebar.message.jvm_provider_probe_failed_with_diagnostic', { error: 'boom' }),
      ).not.toBe('sidebar.message.jvm_provider_probe_failed_with_diagnostic');
      expect(
        t('sidebar.message.jvm_provider_probe_exception_with_diagnostic', { error: 'boom' }),
      ).not.toBe('sidebar.message.jvm_provider_probe_exception_with_diagnostic');
    });
  });

  it('resolves saved-query and external SQL localization keys for every supported language', () => {
    [
      'sidebar.tree.saved_queries',
      'sidebar.external_sql.root',
      'sidebar.menu.add_sql_directory',
      'sidebar.menu.refresh_directory',
      'sidebar.menu.remove_directory',
      'sidebar.menu.open_sql_file',
      'sidebar.message.select_sql_directory_failed',
      'sidebar.message.sql_directory_path_invalid',
      'sidebar.sql_directory.default_name',
      'sidebar.message.external_sql_directory_added',
      'sidebar.message.external_sql_directory_not_found',
      'sidebar.message.external_sql_directory_removed',
      'sidebar.message.external_sql_directory_refreshed',
      'sidebar.message.external_sql_directory_read_failed',
    ].forEach((key) => {
      SUPPORTED_LANGUAGES.forEach((language) => {
        setCurrentLanguage(language);
        expect(t(key, { name: 'raw_dir', error: 'raw_error' })).not.toBe(key);
      });
    });
  });

  it('omits unsupported database management actions for Oracle-like connection and database menus', () => {
    const connectionMarkup = renderToStaticMarkup(
      <V2ConnectionContextMenuView
        connectionName="dm-prod"
        hostSummary="10.0.0.10:5236"
        driverLabel="dameng"
        supportsCreateDatabase={false}
      />,
    );
    const databaseMarkup = renderToStaticMarkup(
      <V2DatabaseContextMenuView
        dbName="SYSDBA"
        dialect="dm"
        supportsRenameDatabase={false}
        supportsDropDatabase={false}
      />,
    );

    expect(connectionMarkup).not.toContain('新建数据库');
    expect(databaseMarkup).not.toContain('重命名数据库');
    expect(databaseMarkup).not.toContain('删除数据库 · DROP');
    expect(databaseMarkup).toContain('刷新对象树');
    expect(databaseMarkup).toContain('关闭数据库');
  });

  it('localizes the sql file execution progress shell with current UI locale while keeping raw sql text', () => {
    setCurrentLanguage('en-US');

    const runningMarkup = renderToStaticMarkup(
      <SQLFileExecutionProgressContent
        fileSizeMB="12.5"
        status="running"
        executed={3}
        failed={1}
        percent={45}
        currentSQL="SELECT * FROM users"
        resultMessage=""
      />,
    );
    const runningFooterMarkup = renderToStaticMarkup(
      <>{buildSQLFileExecutionFooter({
        status: 'running',
        onCancelExecution: mocks.noop,
        onClose: mocks.noop,
      })}</>,
    );
    const doneFooterMarkup = renderToStaticMarkup(
      <>{buildSQLFileExecutionFooter({
        status: 'done',
        onCancelExecution: mocks.noop,
        onClose: mocks.noop,
      })}</>,
    );
    const errorMarkup = renderToStaticMarkup(
      <SQLFileExecutionProgressContent
        fileSizeMB="12.5"
        status="error"
        executed={3}
        failed={1}
        percent={100}
        currentSQL="SELECT * FROM users"
        resultMessage="third-party raw error"
      />,
    );

    expect(runningMarkup).toContain('File size:');
    expect(runningMarkup).toContain('Status:');
    expect(runningMarkup).toContain('Running');
    expect(runningMarkup).toContain('Executed:');
    expect(runningMarkup).toContain('statements | Failed:');
    expect(runningMarkup).toContain('SELECT * FROM users');
    expect(runningMarkup).not.toContain('文件大小：');
    expect(runningMarkup).not.toContain('状态：');
    expect(runningMarkup).not.toContain('执行中');
    expect(runningFooterMarkup).toContain('Cancel execution');
    expect(doneFooterMarkup).toContain('Close');
    expect(errorMarkup).toContain('Error');
    expect(errorMarkup).toContain('third-party raw error');
    expect(errorMarkup).not.toContain('SELECT * FROM users');
  });

  it('renders the v2 table group menu with sort state', () => {
    setCurrentLanguage('en-US');

    const objectGroupTitleCases = [
      ['tables', 'sidebar.v2_table_group_menu.title', '表'],
      ['views', 'sidebar.object_group.views', '视图'],
      ['sequences', 'sidebar.object_group.sequences', '序列'],
      ['routines', 'sidebar.object_group.routines', '函数'],
      ['packages', 'sidebar.object_group.packages', '存储包'],
      ['triggers', 'sidebar.object_group.triggers', '触发器'],
      ['events', 'sidebar.object_group.events', '事件'],
      ['materializedViews', 'sidebar.object_group.materialized_views', '物化视图'],
    ] as const;

    objectGroupTitleCases.forEach(([groupKey, labelKey, rawTitle]) => {
      expect(resolveV2ObjectGroupTitle({
        type: 'object-group',
        dataRef: { groupKey },
      })).toBe(t(labelKey));
    });
    expect(resolveV2ObjectGroupTitle({
      type: 'object-group',
      dataRef: { groupKey: 'schema' },
    })).toBeNull();
    expect(resolveV2ObjectGroupTitle({
      type: 'table',
      dataRef: { groupKey: 'tables' },
    })).toBeNull();

    const markup = renderToStaticMarkup(
      <V2TableGroupContextMenuView
        dbName="mkefu_ai_dev"
        count={15}
        currentSort="frequency"
      />,
    );

    expect(markup).toContain('data-v2-table-group-context-menu="true"');
    expect(markup).toContain(t('sidebar.v2_table_group_menu.title'));
    expect(markup).toContain(t('sidebar.v2_table_group_menu.meta', {
      database: 'mkefu_ai_dev',
      count: '15',
      sort: t('sidebar.v2_table_group_menu.sort_frequency'),
    }));
    expect(markup).toContain(t('sidebar.menu.create_table'));
    expect(markup).toContain(t('sidebar.menu.refresh'));
    expect(markup).toContain(t('data_grid.context_menu.sort_section'));
    expect(markup).toContain(t('sidebar.menu.sort_by_name'));
    expect(markup).toContain(t('sidebar.menu.sort_by_frequency'));
    expect(markup).toContain(t('data_grid.context_menu.current_marker'));
    ['? ? tables', '表 · tables', '15 张表', '当前按使用频率排序', '新建表'].forEach((rawSnippet) => {
      expect(markup).not.toContain(rawSnippet);
    });

    const sidebarSource = readSidebarSource();
    const start = sidebarSource.indexOf('const renderV2TableGroupContextMenu');
    const end = sidebarSource.indexOf('const renderV2DatabaseContextMenu', start);
    const tableGroupCallSource = sidebarSource.slice(start, end);
    ['? ? tables', '表 · tables'].forEach((rawSnippet) => {
    });

    const treeTitleModuleSource = readSourceFile('./sidebar/SidebarTreeTitle.tsx');
    const treeTitleStart = treeTitleModuleSource.indexOf('export const renderSidebarV2TreeTitle');
    const treeTitleEnd = treeTitleModuleSource.length;
    const treeTitleSource = treeTitleModuleSource.slice(treeTitleStart, treeTitleEnd);

    const sidebarHelpersSource = readSourceFile('./sidebar/sidebarHelpers.ts');
    const objectGroupTitleStart = sidebarHelpersSource.indexOf('export const resolveV2ObjectGroupTitle');
    const objectGroupTitleEnd = sidebarHelpersSource.indexOf('export type V2CommandSearchMode', objectGroupTitleStart);
    const objectGroupTitleSource = sidebarHelpersSource.slice(objectGroupTitleStart, objectGroupTitleEnd);
    [
      "if (groupKey === 'tables') return t('sidebar.v2_table_group_menu.title');",
      "if (groupKey === 'views') return t('sidebar.object_group.views');",
      "if (groupKey === 'sequences') return t('sidebar.object_group.sequences');",
      "if (groupKey === 'routines') return t('sidebar.object_group.routines');",
      "if (groupKey === 'packages') return t('sidebar.object_group.packages');",
      "if (groupKey === 'triggers') return t('sidebar.object_group.triggers');",
      "if (groupKey === 'events') return t('sidebar.object_group.events');",
      "if (groupKey === 'materializedViews') return t('sidebar.object_group.materialized_views');",
    ].forEach((catalogLookup) => {
    });

    const titleRenderSource = readSourceFile('./sidebar/useSidebarTitleRender.tsx');
    const titleRenderStart = titleRenderSource.indexOf('export const useSidebarTitleRender =');
    const titleRenderEnd = titleRenderSource.length;
    [
      '? ? tables',
      '表 · tables',
      '视图 · views',
      '函数 · functions',
      '触发器 · triggers',
      '事件 · events',
      '物化视图 · materialized',
    ].forEach((rawSnippet) => {
    });
  });

  it('renders sidebar table comments as an opt-in suffix while using the tab-style table hover card', () => {
    const baseNode = {
      type: 'table',
      title: 'users',
      key: 'conn-main-users',
      dataRef: {
        id: 'conn',
        dbName: 'main',
        tableName: 'users',
        tableComment: '用户表',
        rowCount: 7,
        tableSize: 4096,
        createdAt: '2026-07-02 10:11:12',
        updatedAt: '2026-07-03 11:12:13',
      },
    };
    const baseOptions = {
      node: baseNode,
      hoverTitle: 'users',
      statusBadge: null,
      getV2TreeMetaText: () => '',
      snapshotTreeSelectionBeforeDrag: vi.fn(),
      restoreTreeSelectionAfterDrag: vi.fn(),
      treeDragSelectSuppressUntilRef: { current: 0 },
      setIsTreeDragging: vi.fn(),
    };

    const hiddenSuffixMarkup = renderToStaticMarkup(renderSidebarV2TreeTitle({
      ...baseOptions,
      sidebarTableMetadataFields: ['rows'],
    }));
    expect(hiddenSuffixMarkup).not.toContain('gn-v2-tree-table-comment');

    const visibleSuffixMarkup = renderToStaticMarkup(renderSidebarV2TreeTitle({
      ...baseOptions,
      sidebarTableMetadataFields: ['comment', 'rows', 'size', 'createdAt', 'updatedAt'],
    }));
    expect(visibleSuffixMarkup).toContain('gn-v2-tree-table-comment');
    expect(visibleSuffixMarkup).toContain('用户表');
    expect(visibleSuffixMarkup).toContain(t('sidebar.v2_table_group_menu.metadata_value.rows', { count: '7' }));
    expect(visibleSuffixMarkup).toContain('4 KB');
    expect(visibleSuffixMarkup).toContain(t('sidebar.v2_table_group_menu.metadata_value.created_at', { time: '2026-07-02 10:11:12' }));
    expect(visibleSuffixMarkup).toContain(t('sidebar.v2_table_group_menu.metadata_value.updated_at', { time: '2026-07-03 11:12:13' }));

    const sortedSuffixMarkup = renderToStaticMarkup(renderSidebarV2TreeTitle({
      ...baseOptions,
      sidebarTableMetadataFields: ['updatedAt', 'size', 'rows', 'comment', 'createdAt'],
    }));
    expect(sortedSuffixMarkup.indexOf(t('sidebar.v2_table_group_menu.metadata_value.updated_at', { time: '2026-07-03 11:12:13' })))
      .toBeLessThan(sortedSuffixMarkup.indexOf('4 KB'));
    expect(sortedSuffixMarkup.indexOf('4 KB'))
      .toBeLessThan(sortedSuffixMarkup.indexOf(t('sidebar.v2_table_group_menu.metadata_value.rows', { count: '7' })));
    expect(sortedSuffixMarkup.indexOf(t('sidebar.v2_table_group_menu.metadata_value.rows', { count: '7' })))
      .toBeLessThan(sortedSuffixMarkup.indexOf('用户表'));

    const treeTitleSource = readSourceFile('./sidebar/SidebarTreeTitle.tsx');
    const sidebarHelpersSource = readSourceFile('./sidebar/sidebarHelpers.ts');

    const css = readV2ThemeCss();
    expect(css).toMatch(/\.gn-v2-tree-table-comment \{[^}]*max-width: 24em;[^}]*text-overflow: ellipsis;/s);
    expect(css).toMatch(/\.gn-v2-tab-hover-tooltip \.ant-tooltip-inner \{[^}]*min-width: 260px;[^}]*padding: 0;/s);
    expect(css).toMatch(/\.gn-v2-tab-hover-card \{[^}]*cursor: text;[^}]*user-select: text;/s);
    expect(css).toContain('--gn-v2-tab-hover-grid-columns: 56px minmax(0, 1fr);');
    expect(css).toMatch(/\.gn-v2-tab-hover-row \{[^}]*grid-template-columns: var\(--gn-v2-tab-hover-grid-columns\);/s);
  });

  it('loads table comments through the sidebar table status metadata query', () => {
    const mysqlSql = buildSidebarTableStatusSQL({ config: { type: 'mysql' } } as any, 'app');
    const pgSql = buildSidebarTableStatusSQL({ config: { type: 'postgres' } } as any, 'app');
    const sqlServerSql = buildSidebarTableStatusSQL({ config: { type: 'sqlserver' } } as any, 'app');
    const oracleSql = buildSidebarTableStatusSQL({ config: { type: 'oracle' } } as any, 'APP');

    expect(mysqlSql).toContain('TABLE_COMMENT AS table_comment');
    expect(mysqlSql).toContain('AS table_size');
    expect(mysqlSql).toContain('CREATE_TIME AS create_time');
    expect(pgSql).toContain("obj_description(c.oid, 'pg_class') AS table_comment");
    expect(pgSql).toContain('pg_total_relation_size(c.oid) AS table_size');
    expect(sqlServerSql).toContain('ep.value AS table_comment');
    expect(sqlServerSql).toContain('t.create_date AS create_time');
    expect(oracleSql).toContain('comments AS table_comment');
    expect(oracleSql).toContain('COALESCE(t.blocks, 0) * 8192 AS table_size');
    expect(oracleSql).toContain('o.last_ddl_time AS update_time');
    expect(oracleSql).not.toContain('all_segments');

    const loaderSource = readSourceFile('./sidebar/useSidebarTreeLoaders.tsx');
  });
});
