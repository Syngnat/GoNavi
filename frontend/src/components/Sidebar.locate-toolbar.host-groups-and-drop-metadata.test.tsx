import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRenderer as createShallowRenderer } from 'react-test-renderer/shallow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readV2ThemeCss } from '../test/readV2ThemeCss';
import { GnSqlDocIcon } from './icons/gnIcons';
import {
    buildAllSavedQueriesTreeNode,
    buildSidebarConnectionTagTree,
    isConnectionTagDescendant,
    normalizeSidebarTreeRelativeDropPosition,
    resolveSidebarDropNodeFromDomEvent,
    resolveSidebarDropDomHit,
    resolveSidebarHostGroupDropDestination,
    resolveSidebarDropTargetMetricsFromDomEvent,
    resolveSidebarDropInsertBefore,
    resolveSidebarTreeDropPlacement,
    V2ExplorerContextSummary,
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
  DEFAULT_SHORTCUT_OPTIONS,
  cloneShortcutOptions,
} from '../utils/shortcuts';
import { SUPPORTED_LANGUAGES, setCurrentLanguage, t } from '../i18n';
import {
  mocks,
} from './sidebarLocateToolbarTestState';
import { renderSidebarMarkup } from './sidebarLocateToolbarTestHelpers';

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
    // 与连接下「已存查询」共用同一枚 SQL 文档图标，避免两处长得不一样。
    expect((tree?.children?.[0].children?.[0].children?.[0].icon as React.ReactElement).type).toBe(GnSqlDocIcon);
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

  it('renders the current table locate action in the explorer toolbar', () => {
    const markup = renderSidebarMarkup({  });
    const locateActionIndex = markup.indexOf('data-sidebar-locate-current-tab-action="true"');

    expect(locateActionIndex).toBeGreaterThanOrEqual(0);
    expect(markup).toContain('data-sidebar-locate-current-tab-action="true"');
  });

  it('does not render the retired legacy sidebar toolbar', () => {
    const markup = renderSidebarMarkup();
    expect(markup).not.toContain('data-sidebar-legacy-toolbar="true"');
    expect(markup).not.toContain('data-sidebar-legacy-toolbar-item="true"');
  });

  it('renders exactly five expanded v2 explorer actions after moving global actions to the titlebar', () => {
    const markup = renderSidebarMarkup({
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
    const treeShellIndex = markup.indexOf('gn-v2-explorer-tree-shell', actionsStart);
    const actionsEnd = filtersStart > locateActionIndex ? filtersStart : treeShellIndex;

    expect(actionsStart).toBeGreaterThanOrEqual(0);
    expect(summaryIndex).toBeGreaterThan(actionsStart);
    expect(commandSearchActionIndex).toBeGreaterThan(summaryIndex);
    expect(locateActionIndex).toBeGreaterThan(commandSearchActionIndex);
    expect(actionsEnd).toBeGreaterThan(locateActionIndex);
    expect(markup).not.toContain('<div class="gn-v2-explorer-search"');

    const actionMarkup = markup.slice(actionsStart, actionsEnd);
    const actionLabels = Array.from(
      actionMarkup.matchAll(/<button\b[^>]*\baria-label="([^"]+)"/g),
      (match) => match[1],
    );

    expect(actionLabels).toEqual([
      t('sidebar.command_search.label'),
      t('sidebar.action.locate_current_table'),
      t('sidebar.action.scroll_to_top'),
      t('sidebar.active_connection.actions'),
      t('app.sidebar.collapse'),
    ]);
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
      v2ExplorerContext,
      onCollapseSidebar: mocks.noop,
      collapseSidebarLabel: t('app.sidebar.collapse'),
      onToggleAI: mocks.noop,
      onOpenSettings: mocks.noop,
    });
    const actionsStart = markup.indexOf('<div class="gn-v2-explorer-actions"');
    const filtersStart = markup.indexOf('<div class="gn-v2-explorer-filter-tabs"', actionsStart);
    const treeShellIndex = markup.indexOf('gn-v2-explorer-tree-shell', actionsStart);
    const actionsEnd = filtersStart > actionsStart ? filtersStart : treeShellIndex;
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

  it('shows relational object-kind filters only for schema-capable SQL connections', () => {
    mocks.state.connections = [{
      id: 'pg-1',
      name: 'PostGreSQL',
      config: { type: 'postgres', host: 'localhost', port: 5432 },
    }];
    mocks.state.activeContext = { connectionId: 'pg-1', dbName: 'app' };

    const markup = renderSidebarMarkup({  });
    const locateActionIndex = markup.indexOf('data-sidebar-locate-current-tab-action="true"');
    const explorerFilterTabsIndex = markup.indexOf('class="gn-v2-explorer-filter-tabs"');

    expect(explorerFilterTabsIndex).toBeGreaterThan(locateActionIndex);
    expect(markup).toContain(`aria-label="${t('sidebar.command_search.object_kind.all')}"`);
    expect(markup).toContain(`aria-label="${t('sidebar.command_search.object_kind.views')}"`);
    expect(markup).toContain(`aria-label="${t('sidebar.command_search.object_kind.routines')}"`);
    expect(markup).toContain('data-object-kind-filter="all"');
    expect(markup).toContain('aria-pressed="true"');
  });

  it('keeps relational object-kind filters when the SQL host is not connected or another tab is active', () => {
    mocks.state.connections = [{
      id: 'pg-1',
      name: 'PostGreSQL',
      config: { type: 'postgres', host: 'localhost', port: 5432 },
    }];
    mocks.state.activeContext = null;
    mocks.state.activeTabId = 'settings';
    mocks.state.tabs = [{
      id: 'settings',
      title: 'Settings',
      type: 'settings',
    }];

    const markup = renderSidebarMarkup({  });

    expect(markup).toContain('gn-v2-explorer-filter-tabs');
    expect(markup).toContain(`aria-label="${t('sidebar.command_search.object_kind.all')}"`);
    expect(markup).toContain(`aria-label="${t('sidebar.command_search.object_kind.tables')}"`);
    expect(markup).not.toContain(`>${t('sidebar.command_search.object_kind.tables')}<`);
  });

  it('keeps the filter slot filled on a Nacos workbench, offering its own dimensions', () => {
    mocks.state.connections = [{
      id: 'pg-1',
      name: 'PostGreSQL',
      config: { type: 'postgres', host: 'localhost', port: 5432 },
    }, {
      id: 'nacos-1',
      name: 'Nacos',
      config: { type: 'nacos', host: 'localhost', port: 8848 },
    }];
    mocks.state.activeContext = { connectionId: 'nacos-1', dbName: 'public' };
    mocks.state.activeTabId = 'nacos-services';
    mocks.state.tabs = [{
      id: 'nacos-services',
      title: 'Nacos',
      type: 'nacos-services',
      connectionId: 'nacos-1',
      dbName: 'public',
    }];

    const markup = renderSidebarMarkup({});
    const filterSlotIndex = markup.indexOf('data-object-kind-filter-slot="true"');
    const treeShellIndex = markup.indexOf('gn-v2-explorer-tree-shell');

    // Slot keeps its position so the tree's vertical origin does not move.
    expect(filterSlotIndex).toBeGreaterThanOrEqual(0);
    expect(filterSlotIndex).toBeLessThan(treeShellIndex);

    // A Nacos host has dimensions of its own, so the slot stays populated rather
    // than going blank as soon as the host is selected.
    expect(markup).toContain('data-object-kind-filter-visible="true"');
    expect(markup).toContain('gn-v2-explorer-filter-tabs');
    expect(markup).toContain('data-object-kind-filter="all"');
    expect(markup).toContain('data-object-kind-filter="nacos-services"');
    expect(markup).toContain('data-object-kind-filter="nacos-configs"');
    expect(markup).toContain(`aria-label="${t('sidebar.command_search.object_kind.nacos_services')}"`);
    expect(markup).toContain(`aria-label="${t('sidebar.command_search.object_kind.nacos_configs')}"`);

    // The relational dimensions name object kinds a Nacos tree does not contain.
    expect(markup).not.toContain('data-object-kind-filter="tables"');
    expect(markup).not.toContain('data-object-kind-filter="views"');
    expect(markup).not.toContain('data-object-kind-filter="routines"');
  });

  it('keeps the object-kind slot for an active Redis connection without inventing counts', () => {
    mocks.state.connections = [{
      id: 'redis-1',
      name: 'Redis-开发240',
      config: { type: 'redis', host: 'localhost', port: 6379 },
    }];
    mocks.state.activeContext = { connectionId: 'redis-1', dbName: 'db0' };
    mocks.state.activeTabId = 'redis-keys';
    mocks.state.tabs = [{
      id: 'redis-keys',
      title: 'Redis',
      type: 'redis-keys',
      connectionId: 'redis-1',
      dbName: 'db0',
    }];

    const markup = renderSidebarMarkup({});
    const filterSlotIndex = markup.indexOf('data-object-kind-filter-slot="true"');
    const treeShellIndex = markup.indexOf('gn-v2-explorer-tree-shell');

    // Slot keeps its position so the tree's vertical origin does not move.
    expect(filterSlotIndex).toBeGreaterThanOrEqual(0);
    expect(filterSlotIndex).toBeLessThan(treeShellIndex);
    expect(markup).not.toContain('gn-v2-explorer-filter-tabs');
    // The connection has not been expanded in this render, so the counts genuinely
    // do not exist yet and the summary must stay absent rather than claim "0 keys".
    expect(markup).not.toContain('data-redis-sidebar-overview="true"');
  });

  it('keeps relational object-kind filters hidden without an active host when only dedicated workbenches exist', () => {
    mocks.state.connections = [{
      id: 'nacos-1',
      name: 'Nacos',
      config: { type: 'nacos', host: 'localhost', port: 8848 },
    }, {
      id: 'mqtt-1',
      name: 'MQTT',
      config: { type: 'mqtt', host: 'localhost', port: 1883 },
    }];
    mocks.state.activeContext = null;
    mocks.state.activeTabId = 'settings';
    mocks.state.tabs = [{
      id: 'settings',
      title: 'Settings',
      type: 'settings',
    }];

    const markup = renderSidebarMarkup({  });

    expect(markup).not.toContain('gn-v2-explorer-filter-tabs');
    expect(markup).not.toContain('data-object-kind-filter-slot');
  });

  it('hides relational object-kind filters for Nacos, which offers its own instead', () => {
    mocks.state.connections = [{
      id: 'nacos-1',
      name: 'Nacos',
      config: { type: 'nacos', host: 'localhost', port: 8848 },
    }];
    mocks.state.activeContext = { connectionId: 'nacos-1', dbName: 'public' };

    const markup = renderSidebarMarkup({  });

    expect(markup).not.toContain(`>${t('sidebar.command_search.object_kind.tables')}<`);
    expect(markup).not.toContain(`>${t('sidebar.command_search.object_kind.views')}<`);
    expect(markup).not.toContain(`>${t('sidebar.command_search.object_kind.routines')}<`);
    expect(markup).not.toContain('data-object-kind-filter="tables"');
    expect(markup).not.toContain('data-object-kind-filter="views"');

    // What the slot carries instead: the two Nacos explorer branches.
    expect(markup).toContain('data-object-kind-filter="nacos-services"');
    expect(markup).toContain('data-object-kind-filter="nacos-configs"');
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

    const markup = renderSidebarMarkup({  });

    expect(markup).toContain('data-v2-command-search-icon-only="true"');
    expect(markup).toContain('data-sidebar-command-search-action="true"');
    expect(markup).not.toContain('gn-v2-explorer-search');
    expect(markup).not.toContain(t('sidebar.message_queue.search_placeholder'));
    expect(markup).not.toContain('gn-v2-explorer-filter-tabs');
    expect(markup).not.toContain(`>${t('sidebar.command_search.object_kind.tables')}<`);
    expect(markup).not.toContain(`>${t('sidebar.command_search.object_kind.views')}<`);
    expect(markup).not.toContain(`>${t('sidebar.command_search.object_kind.routines')}<`);
  });

  it('can render the sidebar with the persistent filter input', () => {
    mocks.state.appearance.v2SidebarSearchMode = 'filter';
    mocks.state.appearance.v2SidebarPersistedFilter = 'fs_org';

    const markup = renderSidebarMarkup({  });

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

    const markup = renderSidebarMarkup({  });

    expect(markup).toContain('data-v2-command-search-icon-only="true"');
    expect(markup).not.toContain('gn-v2-search-shortcut');
    expect(markup).not.toContain('<kbd>⌘</kbd>');
    expect(markup).not.toContain('<kbd>F</kbd>');
    expect(markup).not.toContain('<kbd>K</kbd>');
  });

  it('localizes the v2 command search scope shell and object filters through catalog keys', () => {
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
    expect(buildV2UtilsSidebarTableChildrenForUi('conn-main-tables', tableNodes, translate).map((node) => node.title)).toEqual([
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
    expect(css).toContain('--gn-v2-explorer-scale: calc(var(--gn-ui-scale, 1) * var(--gn-sidebar-rail-scale, 1));');
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
      sidebarHiddenObjectGroups: [],
    };

    const markup = renderSidebarMarkup({ onCreateConnection: mocks.noop });
    expect(markup).toContain('gn-v2-explorer-actions');
    expect(markup).not.toContain('data-gonavi-new-query-action="true"');
    expect(markup).not.toContain('data-gonavi-create-connection-action="true"');
  });

  it('evenly distributes v2 explorer filter tabs while keeping narrow sidebars horizontally scrollable', () => {
    const css = readV2ThemeCss();

    expect(css).toMatch(/\.gn-v2-explorer-filter-tabs \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto;[^}]*overflow-y: hidden;[^}]*overscroll-behavior-x: contain;/s);
    expect(css).toMatch(/\.gn-v2-explorer-filter-tabs button \{[^}]*flex: 1 1 0;[^}]*min-width: calc\(28px \* var\(--gn-v2-explorer-scale\)\);[^}]*height: calc\(28px \* var\(--gn-v2-explorer-scale\)\);/s);
    expect(css).toMatch(/\.gn-v2-explorer-filter-tabs button \{[^}]*overflow: hidden;[^}]*cursor: pointer;/s);
    expect(css).toMatch(/\.gn-v2-explorer-filter-tabs button \.anticon \{[^}]*font-size: calc\(14px \* var\(--gn-v2-explorer-scale\)\);/s);
  });

  it('paints selected table nodes across the full tree row like databases and connections', () => {
    const css = readV2ThemeCss();

    expect(css).toMatch(
      /\.gn-v2-explorer-tree-shell \.ant-tree-treenode\.ant-tree-treenode-selected \{[^}]*background: color-mix\(in srgb, var\(--gn-accent\) 10%, var\(--gn-bg-selected\)\) !important;[^}]*border-radius: 6px;/s,
    );
    expect(css).toMatch(
      /\.gn-v2-explorer-tree-shell \.ant-tree-treenode\.ant-tree-treenode-selected \.ant-tree-node-content-wrapper,[\s\S]*?\.gn-v2-explorer-tree-shell \.ant-tree-treenode\.ant-tree-treenode-selected \.ant-tree-node-content-wrapper\.ant-tree-node-selected \{[^}]*background: transparent !important;[^}]*box-shadow: none !important;/s,
    );
    expect(css).not.toMatch(
      /\.ant-tree-treenode\.ant-tree-treenode-selected:has\(\.gn-v2-tree-title:not\(\.is-mono\)\)/,
    );
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
      sidebarHiddenObjectGroups: [],
    };

    const markup = renderSidebarMarkup({  });

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
      sidebarHiddenObjectGroups: [],
    };

    const markup = renderSidebarMarkup({  });

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
    expect(resolveSidebarTreeDropPlacement({
      dragNodeType: 'tag',
      dropNodeType: 'tag',
      relativeDropPosition: 0,
      dropToGap: undefined,
      fallbackInsertBefore: false,
      metrics: { clientY: 102, top: 100, height: 30 },
    })).toBe('before');
    expect(resolveSidebarTreeDropPlacement({
      dragNodeType: 'tag',
      dropNodeType: 'tag',
      relativeDropPosition: 0,
      dropToGap: undefined,
      fallbackInsertBefore: true,
      metrics: { clientY: 128, top: 100, height: 30 },
    })).toBe('after');
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
});
