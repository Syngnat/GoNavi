import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readV2ThemeCss } from '../test/readV2ThemeCss';
import {
    buildV2SidebarTableSectionedChildren,
    buildV2RailConnectionGroups,
    filterV2CommandSearchTreeItems,
    getV2RailConnectionGroupBadgeText,
    hasSidebarLazyChildren,
    parseV2CommandSearchQuery,
    type V2CommandSearchItem,
    resolveSidebarNodeConnectionId,
    resolveSidebarSwitcherLoadKey,
    resolveV2ActiveConnectionId,
    resolveV2ObjectGroupTitle,
    resolveSidebarTableNameForCopy,
    resolveSidebarDatabaseNameForCopy,
    shouldKeepSidebarSwitcherCollapsedWhileLoading,
    shouldLoadSidebarNodeOnExpand,
    shouldCloseV2CommandSearchOnGlobalKey,
    shouldRunV2CommandSearchEnter,
} from './Sidebar';
import { buildSidebarRootConnectionToken, buildSidebarRootTagToken } from '../store';
import { renderSidebarV2TreeTitle } from './sidebar/SidebarTreeTitle';
import { buildSidebarTableStatusSQL } from './sidebar/sidebarMetadataLoaders';
import {
  DEFAULT_SHORTCUT_OPTIONS,
  cloneShortcutOptions,
} from '../utils/shortcuts';
import { SUPPORTED_LANGUAGES, setCurrentLanguage, t } from '../i18n';
import { readCssWithImports } from '../test/readCssWithImports';
import { V2TableGroupContextMenuView } from './V2TableContextMenu';
import {
  mocks,
} from './sidebarLocateToolbarTestState';
import { readCssRuleBlock, renderSidebarMarkup } from './sidebarLocateToolbarTestHelpers';

const readSourceFile = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

// Sidebar.tsx 已拆成 sidebar/ 下的 hook 与子组件，紧随其后按拆分顺序聚合。
const SIDEBAR_COMPONENT_PARTS = [
  'sidebarProps.ts',
  'sidebarRootHelpers.ts',
  'sidebarSavedQueriesTreeNode.tsx',
  'V2ExplorerContextSummary.tsx',
  'useSidebarStoreState.tsx',
  'useSidebarSearchState.ts',
  'useSidebarTreeViewState.ts',
  'useSidebarTitlebarSync.tsx',
  'useSidebarTreeData.tsx',
  'useSidebarLocate.ts',
  'useSidebarTreeEvents.tsx',
  'useSidebarJvmAndSavedQueries.tsx',
  'useSidebarConnectionRefresh.ts',
  'useSidebarVisibility.ts',
  'useSidebarObjectMenuActions.tsx',
  'useSidebarContextMenus.tsx',
  'useSidebarTreeDnd.ts',
  'useSidebarToolbarModel.tsx',
  'SidebarObjectExplorer.tsx',
];

// hook 在前、组件 JSX 在后，与运行时的执行顺序一致
const readSidebarComponentSource = () => [
  ...SIDEBAR_COMPONENT_PARTS.map((file) => readSourceFile(`./sidebar/${file}`)),
  readSourceFile('./Sidebar.tsx'),
].join('\n');

const readSidebarSource = () => [
  readSourceFile('./Sidebar.tsx'),
  ...SIDEBAR_COMPONENT_PARTS.map((file) => readSourceFile(`./sidebar/${file}`)),
  readSourceFile('./sidebar/sidebarHelpers.ts'),
  readSourceFile('./sidebar/SidebarConnectionRail.tsx'),
  readSourceFile('./sidebar/SidebarSearchPanel.tsx'),
  readSourceFile('./sidebar/sidebarNodeMenu.tsx'),
  readSourceFile('./sidebar/sidebarNodeMenuHelpers.tsx'),
  readSourceFile('./sidebar/sidebarNodeMenuObjectGroups.tsx'),
  readSourceFile('./sidebar/sidebarNodeMenuConnection.tsx'),
  readSourceFile('./sidebar/sidebarNodeMenuNacos.tsx'),
  readSourceFile('./sidebar/sidebarNodeMenuDatabase.tsx'),
  readSourceFile('./sidebar/sidebarNodeMenuObjects.tsx'),
  readSourceFile('./sidebar/sidebarNodeMenuSavedQueries.tsx'),
  readSourceFile('./sidebar/sidebarNodeMenuExternalSql.tsx'),
  readSourceFile('./sidebar/sidebarMetadataLoaders.ts'),
  readSourceFile('./sidebar/sidebarMetadataBasics.ts'),
  readSourceFile('./sidebar/sidebarMetadataNames.ts'),
  readSourceFile('./sidebar/sidebarMetadataQuerySpecs.ts'),
  readSourceFile('./sidebar/sidebarMetadataObjectLoaders.ts'),
  readSourceFile('./sidebar/sidebarMetadataRoutineLoaders.ts'),
  readSourceFile('./sidebar/useSidebarBatchExport.ts'),
  readSourceFile('./sidebar/SidebarExternalSqlWorkflow.tsx'),
  readSourceFile('./sidebar/sidebarExternalSqlLaunch.ts'),
  readSourceFile('./sidebar/sidebarExternalSqlHelpers.ts'),
  readSourceFile('./sidebar/SidebarExternalSqlModals.tsx'),
  readSourceFile('./sidebar/useExternalSqlExecution.ts'),
  readSourceFile('./sidebar/useExternalSqlBinding.ts'),
  readSourceFile('./sidebar/useExternalSqlFileModal.ts'),
  readSourceFile('./sidebar/useExternalSqlDirectoryActions.ts'),
  readSourceFile('./sidebar/useSidebarTreeLoaders.tsx'),
  readSourceFile('./sidebar/sidebarTreeLoaderHelpers.tsx'),
  readSourceFile('./sidebar/useSidebarTreeLoadState.ts'),
  readSourceFile('./sidebar/useSidebarDatabaseLoader.tsx'),
  readSourceFile('./sidebar/useSidebarJvmResourceLoader.tsx'),
  readSourceFile('./sidebar/useSidebarTableLoader.tsx'),
  readSourceFile('./sidebar/sidebarDatabaseChildren.tsx'),
  readSourceFile('./sidebar/useSidebarNacosLoaders.tsx'),
  readSourceFile('./sidebar/SidebarEntityModals.tsx'),
  readSourceFile('./sidebar/SidebarTreeTitle.tsx'),
  readSourceFile('./sidebar/sidebarTreeDragOrder.ts'),
  readSourceFile('./sidebar/useSidebarV2ContextMenu.tsx'),
  readSourceFile('./sidebar/useSidebarObjectActions.tsx'),
  readSourceFile('./sidebar/sidebarObjectActionHelpers.ts'),
  readSourceFile('./sidebar/useSidebarCopyExportActions.tsx'),
  readSourceFile('./sidebar/useSidebarDatabaseSchemaActions.tsx'),
  readSourceFile('./sidebar/useSidebarTableAndViewActions.tsx'),
  readSourceFile('./sidebar/useSidebarSavedQueryActions.tsx'),
  readSourceFile('./sidebar/useSidebarRoutineActions.tsx'),
  readSourceFile('./sidebar/useSidebarMessageQueueActions.tsx'),
  readSourceFile('./sidebar/useSidebarSearchModel.tsx'),
  readSourceFile('./sidebar/useSidebarV2ActionHandlers.tsx'),
  readSourceFile('./sidebar/useSidebarCommandSearchRunner.ts'),
  readSourceFile('./sidebar/useSidebarTitleRender.tsx'),
  readSourceFile('./sidebarV2Utils.ts'),
  // sidebarV2Utils.ts 拆出的主题模块
  readSourceFile('./sidebar/sidebarV2TreeNodes.ts'),
  readSourceFile('./sidebar/sidebarV2NacosServices.ts'),
  readSourceFile('./sidebar/sidebarV2TableSections.ts'),
  readSourceFile('./sidebar/sidebarV2ConnectionGroups.ts'),
  readSourceFile('./sidebar/sidebarV2CommandSearch.ts'),
  readSourceFile('./sidebar/sidebarV2TreeDrop.ts'),
  readSourceFile('./sidebar/sidebarV2TreeExpansion.ts'),
].join('\n');

const readNodeMenuSource = () => ['sidebarNodeMenu.tsx', 'sidebarNodeMenuHelpers.tsx', 'sidebarNodeMenuObjectGroups.tsx', 'sidebarNodeMenuConnection.tsx', 'sidebarNodeMenuNacos.tsx', 'sidebarNodeMenuDatabase.tsx', 'sidebarNodeMenuObjects.tsx', 'sidebarNodeMenuSavedQueries.tsx', 'sidebarNodeMenuExternalSql.tsx']
  .map((file) => readSourceFile(`./sidebar/${file}`))
  .join('\n');

vi.mock('../store', async () => (await import('./sidebarLocateToolbarTestState')).mockModule1());

vi.mock('../../wailsjs/go/app/App', async () => (await import('./sidebarLocateToolbarTestState')).mockModule2());

vi.mock('../../wailsjs/runtime/runtime', async () => (await import('./sidebarLocateToolbarTestState')).mockModule3());

vi.mock('../utils/appearance', async () => (await import('./sidebarLocateToolbarTestState')).mockModule4());

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
      normalizedKeyword: 'fs_mkefu_server_info',
    });
    expect(parseV2CommandSearchQuery('sys＿user')).toMatchObject({
      mode: 'default',
      keyword: 'sys＿user',
      normalizedKeyword: 'sys_user',
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

  it('expands a collapsed sidebar before resolving a locate request', () => {
    const source = readSidebarComponentSource();
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

  it('reveals command-search objects with an exact-key centered tree scroll', () => {
    const source = readSidebarComponentSource();
    const scrollSource = readSourceFile('./sidebar/sidebarTreeScrollRequest.ts');

    expect(source).toContain("querySelectorAll<HTMLElement>('[data-sidebar-node-key]')");
    expect(scrollSource).toMatch(/scrollIntoView\?\.\(\{\s*block:\s*request\.scrollBlock,\s*inline:\s*'nearest'/s);
    expect(source).toContain("scrollSidebarTreeToKey(targetKey, 'center')");
    expect(source).toContain("setV2ExplorerFilter('all')");
  });

  it('keeps expanded v2 actions out of the collapsed-only connection rail', () => {
    const source = readSidebarComponentSource();
    const propsStart = source.indexOf('const v2ConnectionRailProps = {');
    const propsEnd = source.indexOf('\n  return (', propsStart);

    expect(propsStart).toBeGreaterThanOrEqual(0);
    expect(propsEnd).toBeGreaterThan(propsStart);
    expect(source.slice(propsStart, propsEnd)).toContain('showLocateAction: false');
  });

  it('keeps the expanded v2 explorer actions usable in narrow containers', () => {
    const source = readSidebarComponentSource();
    const appCss = readCssWithImports(new URL('../App.css', import.meta.url));
    const css = readV2ThemeCss();
    expect(source).toContain('<SidebarConnectionRail {...v2ConnectionRailProps} />');
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

  it('moves driver management next to about as trailing titlebar actions and does not render a More overflow', () => {
    const source = readSidebarComponentSource();
    const actionsStart = source.indexOf('const v2TitlebarQuickActions: TitleBarQuickAction[] = [');
    const actionsEnd = source.indexOf('\n  ];', actionsStart);

    expect(actionsStart).toBeGreaterThanOrEqual(0);
    expect(actionsEnd).toBeGreaterThan(actionsStart);

    const actionsSource = source.slice(actionsStart, actionsEnd);

    expect(actionsSource).toContain("key: 'data-workflow'");
    expect(actionsSource).toContain('label: v2DataWorkflowLabel');
    expect(actionsSource).toContain("key: 'batch-connections'");
    expect(actionsSource).toContain("key: 'batch-tables'");
    expect(actionsSource).toContain("key: 'batch-databases'");
    expect(actionsSource).toContain("key: 'compare'");
    expect(actionsSource).toContain("action: 'compare'");
    expect(actionsSource).not.toContain("key: 'schema-compare'");
    expect(actionsSource).not.toContain("key: 'data-compare'");
    expect(actionsSource).toContain("key: 'sync'");
    expect(actionsSource).toContain("action: 'sync'");
    expect(actionsSource).not.toContain("key: 'batch-actions'");
    expect(actionsSource).toContain("key: 'sql-tools'");
    expect(actionsSource).not.toContain("key: 'drivers'");
    expect(actionsSource).not.toContain("key: 'settings-about'");
    expect(actionsSource).not.toContain("key: 'settings-workspace'");
    expect(actionsSource).not.toContain("key: 'settings-preferences'");
    expect(actionsSource).not.toContain("key: 'open-external-sql-file'");
    expect(actionsSource).not.toContain("priority: 'secondary'");

    // The trailing entries (drivers, about) are built in their own module.
    const trailingActionsSource = readSourceFile('./sidebar/titlebarTrailingActions.tsx');
    expect(trailingActionsSource.indexOf("key: 'drivers'")).toBeGreaterThanOrEqual(0);
    expect(trailingActionsSource.indexOf("key: 'drivers'")).toBeLessThan(trailingActionsSource.indexOf("key: 'about-go-navi'"));
    expect(trailingActionsSource).toContain("label: t('app.tools.entry.drivers.title')");
    expect(trailingActionsSource).toContain("action: 'drivers'");
    expect(trailingActionsSource).toContain("label: t('app.settings.group.about.title')");
    expect(trailingActionsSource).toContain("{ group: 'about', pane: 'about-go-navi' }");
    expect(trailingActionsSource).toContain("action.key !== 'about-go-navi'");
    expect(trailingActionsSource).toContain("action.key !== 'drivers'");

    const trailingCallStart = source.indexOf('const v2TitlebarVisibleTrailingActions = buildTitlebarTrailingActions({');
    expect(trailingCallStart).toBeGreaterThan(actionsEnd);
    const renderSource = source.slice(trailingCallStart);
    expect(renderSource).toContain('trailingActions={v2TitlebarVisibleTrailingActions}');
    expect(renderSource).not.toContain('moreLabel=');

    const titlebarQuickActionsSource = readSourceFile('./TitleBarQuickActions.tsx');
    expect(titlebarQuickActionsSource).not.toContain('data-titlebar-quick-more');
  });

  it('renders the fixed v2 rail, titlebar quick actions, explorer filters and workbench actions', () => {
    const markup = renderSidebarMarkup({ onCreateConnection: mocks.noop });
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
    expect(markup).not.toContain(t('sidebar.command_search.placeholder'));
    expect(markup).not.toContain('gn-v2-search-shortcut');
    expect(markup).not.toContain('<kbd>⌘</kbd>');
    expect(markup).not.toContain('<kbd>K</kbd>');
    expect(markup).not.toContain('gn-v2-explorer-filter-tabs');
    const explorerActionsIndex = markup.indexOf('data-sidebar-explorer-actions="true"');
    const commandSearchActionIndex = markup.indexOf('data-sidebar-command-search-action="true"');
    const locateActionIndex = markup.indexOf('data-sidebar-locate-current-tab-action="true"');
    expect(explorerActionsIndex).toBeGreaterThanOrEqual(0);
    expect(commandSearchActionIndex).toBeGreaterThan(explorerActionsIndex);
    expect(locateActionIndex).toBeGreaterThan(commandSearchActionIndex);
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
    expect(source).toContain("key: 'data-workflow'");
    expect(source).toContain("app.tools.group.workflow.title");
    expect(source).toContain("key: 'sql-tools'");
    expect(source).toContain("sidebar.action.sql_tools");
    expect(source).toContain('sessionWorkbenchAction');
    expect(source).toContain("key: 'compare'");
    expect(source).toContain("onOpenSettingsNavigation?.({ group: 'workflow', action: 'compare' })");
    expect(source).not.toContain("key: 'schema-compare'");
    expect(source).not.toContain("key: 'data-compare'");
    expect(source).toContain("key: 'sync'");
    expect(source).toContain("onOpenSettingsNavigation?.({ group: 'workflow', action: 'sync' })");
    expect(source).toContain('showObjectActions: false');
    expect(source).not.toContain("key: 'locate-current-table'");
    expect(markup).not.toContain('data-gonavi-new-query-action="true"');
    expect(markup).not.toContain('data-gonavi-create-connection-action="true"');
    expect(markup).not.toContain('aria-label="AI 助手"');
    expect(markup).not.toContain('data-gonavi-ai-entry-action="true"');
    expect(markup).not.toContain('aria-label="工具"');
    expect(markup).not.toContain('data-gonavi-open-tools-action="true"');
    expect(markup).not.toContain('aria-label="设置"');
    const contextMenuFunction = source.slice(
      source.indexOf('const openV2ConnectionContextMenu = ('),
      source.indexOf('const getV2TreeMetaText = (node: any): string => {'),
    );
  });

  it('shows a pending state while a database node is loading', () => {
    const css = readV2ThemeCss();
    const titleRenderSource = readSourceFile('./sidebar/useSidebarTitleRender.tsx');
    const titleSource = readSourceFile('./sidebar/SidebarTreeTitle.tsx');

    expect(titleRenderSource).toContain('return renderV2TreeTitle(node, hoverTitle, status);');
    expect(titleSource).toContain('data-sidebar-connection-status={connectionStatusAttr}');
    expect(titleSource).toContain('className={`gn-v2-tree-status is-${connectionStatusAttr}`}');
    expect(css).toMatch(/\.gn-v2-tree-status\.is-loading::before \{[^}]*border: 2px solid rgba\(37, 99, 235, 0\.58\);[^}]*animation: gn-v2-tree-status-spin 0\.8s linear infinite;/s);
    expect(css).toMatch(/\.gn-v2-tree-status\.is-loading::before \{[^}]*border-top-color: #2563eb;/s);
    expect(css).toMatch(/@keyframes gn-v2-tree-status-spin \{[^}]*to \{ transform: rotate\(360deg\); \}/s);
  });

  it('pins the status dot to the right edge and ellipsizes labels instead of scrolling horizontally', () => {
    const css = readV2ThemeCss();
    const source = readSidebarSource();
    expect(css).toMatch(/\.gn-v2-explorer-tree-shell \{[^}]*--gn-v2-tree-trailing-inset: 2px;[^}]*--gn-v2-tree-trailing-status-slot: 16px;[^}]*overflow: hidden !important;/s);
    expect(css).toMatch(/\.gn-v2-explorer-tree-shell \.sidebar-tree-scroll-content \{[^}]*display: flex;[^}]*height: 100%;[^}]*padding: 6px max\(8px, var\(--gonavi-sidebar-resize-inner-hit-width, 8px\)\) 8px 8px;/s);
    expect(css).toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree \{[^}]*flex: 1 1 auto;[^}]*width: 100%;[^}]*min-width: 0;[^}]*height: 100%;/s);
    expect(css).toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree-list \{[^}]*position: relative;[^}]*height: 100%;[^}]*min-height: 0;[^}]*box-sizing: border-box;/s);
    expect(css).toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree-list-holder-inner \{[^}]*width: 100%;[^}]*min-width: 100%;/s);
    expect(css).not.toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree-list-holder-inner \{[^}]*width: max-content;/s);
    expect(css).not.toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree-list \{[^}]*position: static !important;/s);
    expect(css).toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree-list-holder \{[^}]*height: 100%;[^}]*max-height: 100% !important;/s);
    expect(css).toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree-list-holder \{[^}]*scrollbar-gutter: stable;/s);
    expect(css).not.toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree-list-holder \{[^}]*scrollbar-gutter: stable both-edges;/s);
    expect(css).toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree-list-holder \{[^}]*overflow-x: hidden !important;/s);
    // No horizontal scrolling at all: no active/native toggles, no offset vars.
    expect(css).not.toContain('data-horizontal-scroll-active');
    expect(css).not.toContain('--gn-v2-tree-horizontal-offset');
    expect(css).not.toContain('--gn-v2-tree-viewport-width');
    expect(css).not.toContain('--gn-v2-tree-horizontal-scroll-reserve');
    expect(css).toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree-list-scrollbar-horizontal \{[^}]*display: none !important;/s);
    const treeContentWrapperCss = readCssRuleBlock(css, 'body[data-ui-version="v2"] .gn-v2-explorer-tree-shell .ant-tree-node-content-wrapper');
    expect(treeContentWrapperCss).toContain('min-width: 0;');
    expect(treeContentWrapperCss).toContain('width: max-content !important;');
    expect(treeContentWrapperCss).toContain('display: flex !important;');
    expect(treeContentWrapperCss).toContain('padding: 0 6px 0 6px !important;');
    expect(css).toMatch(/\.gn-v2-tree-title\.is-connection \{[^}]*align-items:\s*center;/s);
    // Title chain shrinks with the row and the label ellipsizes.
    const antTreeTitleCss = readCssRuleBlock(css, 'body[data-ui-version="v2"] .gn-v2-explorer-tree-shell .ant-tree-title');
    expect(antTreeTitleCss).toContain('min-width: 0;');
    expect(antTreeTitleCss).toContain('flex: 1 1 auto;');
    expect(antTreeTitleCss).toContain('overflow: hidden;');
    const antTreeTitleSpanCss = readCssRuleBlock(css, 'body[data-ui-version="v2"] .gn-v2-explorer-tree-shell .ant-tree-title > span');
    expect(antTreeTitleSpanCss).toContain('min-width: 0;');
    expect(antTreeTitleSpanCss).not.toContain('min-width: max-content;');
    const v2TreeTitleCss = readCssRuleBlock(css, 'body[data-ui-version="v2"] .gn-v2-explorer-tree-shell .ant-tree-title > .gn-v2-tree-title');
    expect(v2TreeTitleCss).toContain('max-width: 100%;');
    expect(v2TreeTitleCss).toContain('min-width: 0;');
    expect(v2TreeTitleCss).toContain('overflow: hidden;');
    const treeLabelCss = readCssRuleBlock(css, 'body[data-ui-version="v2"] .gn-v2-tree-label');
    expect(treeLabelCss).toContain('flex: 0 1 auto;');
    expect(treeLabelCss).toContain('overflow: hidden;');
    expect(treeLabelCss).toContain('text-overflow: ellipsis;');
    expect(css).toMatch(/\.gn-v2-tree-title\.is-mono \{[^}]*max-width: 100%;[^}]*min-width: 0;[^}]*flex: 1 1 auto;/s);
    expect(css).toMatch(/\.gn-v2-tree-title\.is-mono \.gn-v2-tree-label \{[^}]*flex: 0 1 auto;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;/s);
    expect(css).toMatch(/\.gn-v2-tree-folder-icon \{[^}]*width: 20px;[^}]*height: 20px;[^}]*flex: 0 0 20px;/s);
    expect(css).toMatch(/\.gn-v2-tree-title:not\(\.is-mono\) \{[^}]*max-width: 100%;[^}]*min-width: 0;/s);
    expect(css).toMatch(/\.gn-v2-tree-title\.is-connection \.gn-v2-tree-label,[^}]*text-overflow: ellipsis;/s);
    // Status dot pinned right; the content wrapper reserves its slot.
    expect(css).toMatch(/\.gn-v2-explorer-tree-shell \.gn-v2-tree-status \{[^}]*position: absolute;[^}]*right: var\(--gn-v2-tree-trailing-inset, 2px\);[^}]*transform: translateY\(-50%\);/s);
    expect(css).toMatch(/\.ant-tree-treenode:has\(\.gn-v2-tree-status\) \.ant-tree-node-content-wrapper \{[^}]*padding-right: calc\(var\(--gn-v2-tree-trailing-inset, 2px\) \+ var\(--gn-v2-tree-trailing-status-slot, 16px\) \+ 6px\) !important;/s);
    expect(css).toMatch(/\.gn-v2-tree-status\.is-success::before \{[^}]*background: var\(--gn-status-connected\);/s);
    // Count pills follow the label inline.
    expect(css).toMatch(/\.ant-tree-treenode:has\(\.gn-v2-tree-title\.is-connection-group\) \.gn-v2-tree-count,[\s\S]*?\.ant-tree-treenode:has\(\.gn-v2-tree-title\.is-group\) \.gn-v2-tree-count \{[^}]*position: static;[^}]*right: auto;[^}]*transform: none;/s);
    expect(css).not.toMatch(/\.gn-v2-tree-count \{[^}]*position: absolute;/s);
    expect(css).toMatch(/\.gn-v2-tree-title\.is-connection-group \.gn-v2-tree-count,[\s\S]*?\.gn-v2-tree-title\.is-group \.gn-v2-tree-count \{[^}]*margin-left: 0;/s);
    // Database rows carry no count; the "表" group below already shows it.
    expect(readSourceFile('./sidebar/useSidebarV2ContextMenu.tsx')).not.toMatch(/node\.type === 'database'\) \{\s*const count = v2TreeMetrics\.databaseTableCounts/);
    expect(css).not.toMatch(/:has\(\.gn-v2-tree-title\.is-group\) \.ant-tree-node-content-wrapper \{[^}]*padding-right: calc\(var\(--gn-v2-tree-trailing-inset, 12px\) \+ 20px\)/s);
    expect(css).toMatch(/\.ant-tree-switcher \{[^}]*flex: 0 0 16px !important;[^}]*width: 16px !important;[^}]*justify-content: center;/s);
    expect(css).toMatch(/\.ant-tree-switcher-noop \.ant-tree-switcher-icon \{[^}]*visibility: hidden;/s);
    expect(css).toMatch(/\.ant-tree-indent-unit \{[^}]*width: 16px !important;/s);
    expect(css).not.toMatch(/\.ant-tree-indent-unit::before/);
    expect(css).not.toMatch(/\.ant-tree-treenode:has\(\.gn-v2-tree-title\[data-node-type="queries-folder"\]\)::before/);
    expect(css).toMatch(/\.ant-tree-iconEle \{[^}]*height: 16px !important;[^}]*overflow: hidden;/s);
    expect(css).toMatch(/\.ant-tree-iconEle \[data-db-icon-frame="true"\] \{[^}]*max-width: 16px !important;[^}]*max-height: 16px !important;/s);
    expect(css).toMatch(/\.ant-tree-node-content-wrapper:focus-visible \{[^}]*outline: 2px solid var\(--gn-accent\);/s);
    expect(css).not.toMatch(/\.gn-v2-object-explorer \.ant-tree \.ant-tree-node-content-wrapper\.ant-tree-node-selected::before/);
    expect(source).toContain('getDbIcon(iconType, iconColor, 20)');
    expect(source).not.toContain('getDbIcon(iconType, iconColor, 16)');
    expect(source).not.toContain('getDbIcon(iconType, iconColor, 22)');
    expect(css).toMatch(/\.ant-tree-treenode:has\(\.gn-v2-tree-title\.is-connection\) \.ant-tree-iconEle,[\s\S]*?\{[^}]*width: 20px !important;[^}]*height: 20px !important;/s);
    expect(css).not.toContain('.gn-v2-tree-connection-meta');
  });

  it('keeps v2 tree rows exactly viewport wide with no horizontal scroll wiring', () => {
    const css = readV2ThemeCss();
    const source = readSidebarSource();

    expect(css).toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree-treenode \{[^}]*width: 100% !important;/s);
    expect(css).not.toMatch(/\.ant-tree-treenode:has\(\.gn-v2-tree-title\.is-mono\) \{[^}]*width: max-content/s);
    expect(source).not.toContain('itemHorizontalOffsetComposited');
    expect(source).not.toContain('scrollWidth={');
    expect(source).not.toContain('HorizontalScroll');
    expect(source).not.toContain('resolveSidebarTreeHorizontalWheelDelta');
    expect(source).not.toContain('treeViewportWidth');
    expect(source).not.toContain("scrollTo?.({ left: 0 })");
  });

  it('uses native tree scrollbars and keeps the overlay track only as a fallback', () => {
    const css = readV2ThemeCss();
    const source = readSidebarComponentSource();

    expect(source).toContain('onWheelCapture={handleTreeWheel}');
    expect(source).toContain('onTouchMoveCapture={markTreeScrollActivity}');

    const nativeOverlayCss = readCssRuleBlock(
      css,
      'body[data-ui-version="v2"] .gn-v2-explorer-tree-shell .ant-tree-list-scrollbar-horizontal',
    );
    expect(nativeOverlayCss).toContain('display: none !important;');
    expect(css).toMatch(/\.gn-v2-explorer-tree-shell \.ant-tree-list-holder::-webkit-scrollbar:horizontal \{[^}]*background: color-mix\(in srgb, var\(--gn-fg-4\) 14%, var\(--gn-bg-panel\)\);/s);
  });

  it('uses exact row geometry for the V2 tree virtual scrolling fast path', () => {
    const source = readSidebarComponentSource();
    const treePatch = readSourceFile('../../patches/rc-tree+5.13.1.patch');
    const virtualListPatch = readSourceFile('../../patches/rc-virtual-list+3.19.2.patch');

    expect(source).toContain('itemHeight={30}');
    expect(source).toContain('itemHeightResolver={resolveSidebarTreeRowHeight}');
    expect(treePatch).toContain('itemHeightResolver: itemHeightResolver');
    expect(treePatch).not.toContain('itemHorizontalOffsetComposited');
    expect(treePatch).toContain('itemHeightResolver?: (item: TreeDataType, index: number) => number;');
    expect(virtualListPatch).toContain('fixedItemOffsets[startMid + 1] >= fixedOffsetTop');
    expect(virtualListPatch).toContain('var nativeVerticalScroll = !!(inVirtual && (itemHeightFixed || !!fixedItemOffsets));');
    expect(virtualListPatch).toContain('var resolverOverscanRows = 6;');
    expect(virtualListPatch).toContain('var fixedStartIndex = Math.max(0, startLow - resolverOverscanRows);');
    expect(virtualListPatch).toContain('var fixedEndIndex = Math.min(fixedDataLen - 1, endLow + resolverOverscanRows);');
    expect(virtualListPatch).toContain('useScrollTo(componentRef, mergedData, heights, itemHeight');
    expect(virtualListPatch).toContain('fixedItemOffsets, itemHeightFixed');
  });

  it('uses V2-only capture DnD with a compact preview and stable whole-row states', () => {
    const source = `${readSidebarComponentSource()}\n${readSourceFile('./sidebar/sidebarTreeDragOrder.ts')}`;
    const css = readV2ThemeCss();

    expect(source).toContain('onDragOverCapture={handleSidebarTreeDragOverCapture}');
    expect(source).toContain('onDropCapture={handleSidebarTreeDropCapture}');
    expect(source).toContain('onMouseDownCapture={sidebarTreeDrag.markSidebarTreeMouseDownHandled}');
    expect(source).toContain('resolveSidebarTreeOrderDropAtEvent(');
    expect(source.match(/sidebarTreeDrag\.isSidebarTreeGapNoOp\(/g)).toHaveLength(2);
    expect(source).toContain('|| sidebarTreeDrag.isSidebarTreeOrderNode(node)');
    expect(source).toContain('applySidebarTreeOrdersToNode(');
    expect(source).toContain('sidebarTreeOrdersRef.current = next;');
    expect(source).toContain('tableSortPreferenceRef.current = next;');
    expect(source).toContain('resolveSidebarDropDomHit(event)');
    expect(source).toContain('resolveSidebarHostGroupDropDestination({');
    expect(source).toContain('sidebarTreeDragPreviewElementRef.current = sidebarTreeDrag.createSidebarTreeDragPreview(event, node)');
    expect(source).toContain('&& sidebarTreeDrag.isSidebarHostTreeNode(sidebarTreeDragNodeRef.current)');
    expect(source).toContain('dataTransfer.setDragImage(preview, 18, 15)');
    expect(source).toContain('SIDEBAR_GROUP_HOVER_EXPAND_DELAY_MS = 500');
    expect(css).toContain('.ant-tree-treenode:has(.gn-v2-tree-title.is-drop-inside)');
    expect(css).toContain('.gn-v2-sidebar-tree-drag-preview');
    expect(css).toContain('.is-object-tree-dragging .ant-tree-treenode:has(.gn-v2-tree-title.is-drop-before)');
    expect(css).toMatch(/\.gn-v2-explorer-tree-shell\.is-object-tree-dragging \.ant-tree-drop-indicator \{[^}]*display: none !important;/s);
    expect(css).toMatch(/\.gn-v2-explorer-tree-shell\.is-host-tree-dragging \.ant-tree-drop-indicator \{[^}]*display: none !important;/s);
    expect(css).toMatch(/\.gn-v2-tree-title\.is-connection-group \{[^}]*line-height: 1\.4;/s);
    expect(css).toContain('cursor: grabbing !important;');
    expect(css).not.toContain('.gn-v2-tree-host-drop-hint');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('wires database pin actions to persistence and in-memory tree reordering', () => {
    const actionSource = readSourceFile('./sidebar/useSidebarV2ActionHandlers.tsx');
    const contextMenuSource = readSourceFile('./sidebar/useSidebarV2ContextMenu.tsx');
    const loaderSource = ['useSidebarTreeLoaders.tsx', 'sidebarTreeLoaderHelpers.tsx', 'useSidebarTreeLoadState.ts', 'useSidebarDatabaseLoader.tsx', 'useSidebarJvmResourceLoader.tsx', 'useSidebarTableLoader.tsx', 'sidebarDatabaseChildren.tsx', 'useSidebarNacosLoaders.tsx']
      .map((file) => readSourceFile(`./sidebar/${file}`))
      .join('\n');

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
    const source = readSidebarComponentSource();

    expect(source).toMatch(/const openDesign = \(node: any,[\s\S]*?schemaName[\s\S]*?type: 'design',[\s\S]*?schemaName,/);
    expect(source).toMatch(/const openNewTableDesign = \(node: any\)[\s\S]*?schemaName[\s\S]*?type: 'design',[\s\S]*?schemaName,/);
    expect(source).toContain("design-${id}-${dbName}-${schemaName || 'default'}-${tableName}");
  });

  it('renders a non-interactive pin indicator only for pinned v2 sidebar tables', () => {
    const source = readSourceFile('./sidebar/SidebarTreeTitle.tsx');
    const css = readV2ThemeCss();
    const baseOptions = {
      hoverTitle: 'orders',
      connectionStatus: undefined,
      getV2TreeMetaText: () => '',
      sidebarTableMetadataFields: [],
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

  it('renders v2 table section labels as tree children instead of group header badges', () => {
    const source = readSidebarSource();
    const css = readV2ThemeCss();
    expect(css).toContain('.gn-v2-tree-section-title');
    expect(css).toContain('.ant-tree-treenode:has(.gn-v2-tree-section-title)');
  });

  it('resolves and wires database-name copy for both sidebar menu generations', () => {
    expect(resolveSidebarDatabaseNameForCopy({
      title: 'fallback_db',
      dataRef: { dbName: '  main_db  ' },
    })).toBe('main_db');
    expect(resolveSidebarDatabaseNameForCopy({ title: ' fallback_db ' })).toBe('fallback_db');
    expect(resolveSidebarDatabaseNameForCopy(null)).toBe('');

    const nodeMenuSource = readNodeMenuSource();
    const menuSource = readSourceFile('./V2TableContextMenu.tsx');
    const actionSource = readSourceFile('./sidebar/useSidebarV2ActionHandlers.tsx');
    const objectActionSource = readSourceFile('./sidebar/useSidebarObjectActions.tsx');
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
      connectionStatus: undefined,
      getV2TreeMetaText: () => '',
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

    expect(treeTitleSource).toContain('title={renderHoverInfo}');
    expect(treeTitleSource).toContain('const renderHoverInfo = React.useCallback(');
    expect(treeTitleSource).not.toContain('title={<SidebarTableHoverInfo');
    expect(treeTitleSource).toContain("node.type === 'table' && sidebarTableMetadataFields.length > 0");

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
    expect(sqlServerSql).toContain('CONVERT(nvarchar(4000), ep.value) AS table_comment');
    expect(sqlServerSql).toContain('FROM sys.tables t');
    expect(sqlServerSql).not.toMatch(/\]\.sys\.tables/);
    expect(sqlServerSql).toContain('t.create_date AS create_time');
    expect(oracleSql).toContain('comments AS table_comment');
    expect(oracleSql).toContain('COALESCE(t.blocks, 0) * 8192 AS table_size');
    expect(oracleSql).toContain('o.last_ddl_time AS update_time');
    expect(oracleSql).not.toContain('all_segments');

    const loaderSource = readSourceFile('./sidebar/useSidebarTreeLoaders.tsx');
  });
});
