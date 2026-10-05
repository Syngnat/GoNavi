import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    applySidebarDatabasePinning,
    buildSidebarTableChildrenForUi,
    buildV2SidebarDatabaseSectionedChildren,
    buildV2SidebarTableSectionedChildren,
    buildSQLFileExecutionFooter,
    filterV2ExplorerTreeByKind,
    isSidebarDatabasePinned,
    resolveSidebarTagDropInsertBefore,
    isSidebarTablePinned,
    SQLFileExecutionProgressContent,
    shouldSkipSidebarLoadOnExpandWhileDragging,
    shouldSkipSidebarSelectWhileDragging,
    sortSidebarTableEntries,
} from './Sidebar';
import { buildSidebarDatabasePinKey, buildSidebarTablePinKey } from '../store';
import { renderSidebarV2TreeTitle } from './sidebar/SidebarTreeTitle';
import {
  DEFAULT_SHORTCUT_OPTIONS,
  cloneShortcutOptions,
} from '../utils/shortcuts';
import { SUPPORTED_LANGUAGES, setCurrentLanguage, t } from '../i18n';
import {
    V2ConnectionGroupContextMenuView,
    V2ConnectionContextMenuView,
    V2DatabaseContextMenuView,
    V2SchemaContextMenuView,
    V2TableContextMenuView,
    formatV2TableContextMenuRows,
    formatV2TableContextMenuSize,
} from './V2TableContextMenu';
import {
  mocks,
} from './sidebarLocateToolbarTestState';

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

  it('renders a clear whole-row group target for Host drops', () => {
    const baseOptions = {
      node: {
        type: 'tag',
        key: 'tag-prod',
        title: '生产环境',
        dataRef: { id: 'prod' },
      },
      hoverTitle: '生产环境',
      connectionStatus: undefined,
      getV2TreeMetaText: () => '',
      sidebarTableMetadataFields: [],
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
        supportsClear
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
    expect(markup).toContain('清空表 · DELETE');
    expect(markup).toContain('删除表 · DROP');
  });

  it('hides clear-table when the caller marks the database as unsupported', () => {
    const unsupportedMarkup = renderToStaticMarkup(
      <V2TableContextMenuView tableName="search-index" supportsClear={false} />,
    );
    const supportedMarkup = renderToStaticMarkup(
      <V2TableContextMenuView tableName="orders" supportsClear />,
    );

    expect(unsupportedMarkup).not.toContain('清空表');
    expect(supportedMarkup).toContain('清空表 · DELETE');
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
      connectionStatus: undefined,
      getV2TreeMetaText: () => '',
      sidebarTableMetadataFields: [],
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

  it('renders the same non-interactive pin indicator for pinned databases', () => {
    const baseOptions = {
      hoverTitle: 'analytics',
      connectionStatus: undefined,
      getV2TreeMetaText: () => '',
      sidebarTableMetadataFields: [],
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

  it('builds pinned table sections for sidebar table groups', () => {
    const tableNodes = [
      { title: 'orders', key: 'orders', type: 'table' as const, dataRef: { pinnedSidebarTable: true } },
      { title: 'users', key: 'users', type: 'table' as const, dataRef: { pinnedSidebarTable: false } },
    ];
    expect(buildSidebarTableChildrenForUi('conn-main-tables', tableNodes).map((node) => node.title)).toEqual([
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
      <V2TableContextMenuView tableName="t1" supportsTruncate supportsClear />,
    );

    expect(markup).toContain('Truncate table · TRUNCATE');
    expect(markup).toContain('Clear table · DELETE');
    expect(markup).toContain('Delete table · DROP');
    expect(markup).toContain('TRUNCATE');
    expect(markup).toContain('DELETE');
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
    expect(markup).toContain('New query');
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
    expect(markup).toContain(t('sidebar.action.batch_connections'));
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
    expect(markup).toContain('Batch connections');
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
});
