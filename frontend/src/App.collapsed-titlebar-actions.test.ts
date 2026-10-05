import { readFileSync } from 'node:fs';
import React from 'react';
import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
  V2ExplorerToolbarActions,
  type V2ExplorerToolbarActionLabels,
} from './components/Sidebar';
import { DockedSidebarActionsHost } from './components/sidebar/SidebarExplorerToolbar';
import {
  resolveTitleBarLayout,
  shouldDockCollapsedSidebarActionsInTitlebar,
} from './utils/titlebarLayout';
import { readCssWithImports } from './test/readCssWithImports';

// App.tsx 已拆成 hook / 子组件 / 辅助模块（src/appShell），源码扫描按原顺序聚合。
const APP_SOURCE_MODULES = [
  'App.tsx',
  'appShell/appSettingsConstants.ts',
  'appShell/ThemeSettingsSlider.tsx',
  'appShell/appEnvironment.ts',
  'appShell/connectionPackageImport.ts',
  'appShell/settingsCenterPanes.ts',
  'appShell/globalProxySettings.ts',
  'appShell/aboutSettingsFormat.ts',
  'appShell/SidebarMetadataSortableRow.tsx',
  'appShell/appLayoutParts.ts',
  'appShell/settingsCenterNavigation.ts',
  'appShell/hooks/useAppCoreState.ts',
  'appShell/hooks/useAppShellState.ts',
  'appShell/hooks/useAppBootstrapEffects.ts',
  'appShell/hooks/useAppStartupEffects.tsx',
  'appShell/hooks/useAppWindowEffects.ts',
  'appShell/hooks/useAppSecurityUpdate.ts',
  'appShell/hooks/useAppUpdateAndDiagnostics.ts',
  'appShell/hooks/useAppQuitAndUpdate.tsx',
  'appShell/hooks/useAppConnectionImportExport.ts',
  'appShell/hooks/useAppProxySettings.ts',
  'appShell/hooks/useAppSettingsNavigation.ts',
  'appShell/hooks/useAppDirectorySettingsRender.tsx',
  'appShell/hooks/useAppWorkbenchActions.ts',
  'appShell/hooks/useAppLayoutEffects.ts',
  'appShell/hooks/useAppAntdTheme.tsx',
  'appShell/hooks/useAppSettingsPanesRender.tsx',
  'appShell/hooks/useAppAboutSettingsRender.tsx',
  'appShell/hooks/useAppThemeSettingsRender.tsx',
  'appShell/settings/ThemeModeSettingsSection.tsx',
  'appShell/settings/ThemeAppearanceSettingsSection.tsx',
  'appShell/settings/TabDisplaySettingsSection.tsx',
  'appShell/settings/DataTableSettingsFields.tsx',
  'appShell/hooks/useAppSettingsCenterRender.tsx',
  'appShell/layout/AppTitleBar.tsx',
  'appShell/layout/AppSider.tsx',
  'appShell/layout/AppContent.tsx',
  'appShell/settings/renderAppSettingsCenterModal.tsx',
  'appShell/settings/toolCenterGroups.tsx',
  'appShell/settings/toolCenterPaneRenderer.tsx',
  'appShell/layout/AppGlobalDialogs.tsx',
];
const appSource = APP_SOURCE_MODULES
  .map((file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'))
  .join('\n');
const appCss = readCssWithImports(new URL('./App.css', import.meta.url));
const v2ThemeCss = readCssWithImports(new URL('./v2-theme.css', import.meta.url));
// Sidebar.tsx 已拆成 components/sidebar/ 下的 hook 与子组件，源码扫描需一并聚合。
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
const sidebarSource = [
  readFileSync(new URL('./components/Sidebar.tsx', import.meta.url), 'utf8'),
  ...SIDEBAR_COMPONENT_PARTS.map((file) => readFileSync(new URL(`./components/sidebar/${file}`, import.meta.url), 'utf8')),
].join('\n');
const toolbarSource = readFileSync(new URL('./components/sidebar/SidebarExplorerToolbar.tsx', import.meta.url), 'utf8');
const sidebarCollapseSource = readFileSync(new URL('./hooks/useAppSidebarCollapse.ts', import.meta.url), 'utf8');

const readRule = (css: string, selector: string): string => {
  const start = css.indexOf(selector);
  const openingBrace = css.indexOf('{', start + selector.length);
  const closingBrace = css.indexOf('}', openingBrace + 1);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(openingBrace).toBeGreaterThan(start);
  expect(closingBrace).toBeGreaterThan(openingBrace);
  return css.slice(start, closingBrace + 1);
};


vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  return {
    ...actual,
    Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  };
});
vi.mock('@ant-design/icons', async () => {
  const actual = await vi.importActual<typeof import('@ant-design/icons')>('@ant-design/icons');
  const Icon = () => React.createElement('span', { 'data-icon': 'true' });
  return {
    ...actual,
    AimOutlined: Icon,
    MenuFoldOutlined: Icon,
    MenuUnfoldOutlined: Icon,
    MoreOutlined: Icon,
    RobotOutlined: Icon,
    SettingOutlined: Icon,
    VerticalAlignTopOutlined: Icon,
  };
});

const labels: V2ExplorerToolbarActionLabels = {
  objectActions: 'Object actions',
  locateCurrentTable: 'Locate current table',
  locateCurrentTableUnavailable: 'Current table unavailable',
  scrollToTop: 'Scroll to top',
  connectionActions: 'Connection actions',
};

const createToolbar = (overrides: Partial<React.ComponentProps<typeof V2ExplorerToolbarActions>> = {}) => {
  const handlers = {
    onLocateCurrentTable: vi.fn(),
    onScrollToTop: vi.fn(),
    onOpenConnectionActions: vi.fn(),
    onToggleSidebar: vi.fn(),
  };
  const renderer = create(
    React.createElement(V2ExplorerToolbarActions, {
      labels,
      canLocateActiveTab: true,
      hasActiveConnection: true,
      onLocateCurrentTable: handlers.onLocateCurrentTable,
      onScrollToTop: handlers.onScrollToTop,
      onOpenConnectionActions: handlers.onOpenConnectionActions,
      toggleAction: {
        label: 'Expand sidebar',
        onClick: handlers.onToggleSidebar,
        placement: 'docked-titlebar',
        expanded: false,
      },
      ...overrides,
    }),
  );
  return { renderer, handlers };
};

describe('collapsed V2 sidebar actions', () => {
  it('mounts the shared sidebar toolbar in the docked titlebar host', () => {
    const hostStart = toolbarSource.indexOf('export const DockedSidebarActionsHost');
    const actionsSource = toolbarSource.slice(hostStart);
    const sharedActionsStart = toolbarSource.indexOf('export const V2ExplorerToolbarActions');
    const sharedActionsEnd = toolbarSource.indexOf('\nexport const DockedSidebarActionsHost', sharedActionsStart);
    const sharedActionsSource = toolbarSource.slice(sharedActionsStart, sharedActionsEnd);

    expect(hostStart).toBeGreaterThanOrEqual(0);
    expect(sharedActionsStart).toBeGreaterThanOrEqual(0);
    expect(sharedActionsEnd).toBeGreaterThan(sharedActionsStart);
    expect(appSource).toContain('isCollapsedSidebarActionsDocked');
    expect(appSource).toContain('shouldDockCollapsedSidebarActionsInTitlebar = resolveCollapsedSidebarDocking(');
    expect(appSource).toContain('runtimePlatform,');
    expect(appSource).toContain('navigatorPlatform,');
    expect(appSource).toContain('isWebRuntime,');
    expect(appSource).toContain(
      'const dockActionsInTitlebarBand = shouldDockCollapsedSidebarActionsInTitlebar && titleBarActionsInline;',
    );
    expect(appSource).toMatch(
      /resolveTitleBarLayout\(\s*effectiveUiScale,\s*dockActionsInTitlebarBand,\s*effectiveSidebarRailScale,\s*\)/s,
    );
    expect(appSource).toContain("dockActionsInTitlebarBand ? 'gn-v2-titlebar-collapsed-docked' : ''");
    expect(actionsSource).toContain('role="toolbar"');
    expect(actionsSource).toContain('data-no-titlebar-toggle="true"');
    expect(actionsSource).toContain('data-collapsed-sidebar-actions="true"');
    expect(appSource).toContain('slotRef={setCollapsedSidebarActionsTarget}');
    expect(appSource).toContain('collapsedSidebarActionsTarget={collapsedSidebarActionsTarget}');
    expect(appSource).toContain('onExpandSidebar={handleExpandSidebarPanel}');
    expect(appSource).toContain('onEnsureSidebarExpanded={handleEnsureSidebarExpanded}');
    expect(sidebarSource).toContain('collapsedSidebarActionsTarget && createPortal(');
    expect(toolbarSource).toContain("placement: 'docked-titlebar'");

    const actionMarkers = [
      'data-sidebar-locate-current-tab-action="true"',
      'data-sidebar-scroll-to-top-action="true"',
      'data-sidebar-active-connection-actions="true"',
      '<SidebarToggleButton action={toggleAction}',
    ];
    const markerIndexes = actionMarkers.map((marker) => sharedActionsSource.indexOf(marker));
    expect(markerIndexes.every((index) => index >= 0)).toBe(true);
    expect(markerIndexes).toEqual([...markerIndexes].sort((a, b) => a - b));
    expect(sharedActionsSource).toContain('disabled={!canLocateActiveTab}');
    expect(sharedActionsSource).toContain('disabled={!hasActiveConnection}');
    expect(sharedActionsSource).toContain('aria-haspopup="menu"');
  });

  it('keeps the search, locate, scroll and menu actions out of the explorer header while docked', () => {
    const headerStart = sidebarSource.indexOf('className="gn-v2-explorer-actions"');
    const headerEnd = sidebarSource.indexOf('{usePersistentSidebarFilter && (', headerStart);
    const headerSource = sidebarSource.slice(headerStart, headerEnd);
    const portalStart = sidebarSource.indexOf('collapsedSidebarActionsTarget && createPortal(');
    const portalSource = sidebarSource.slice(portalStart, sidebarSource.indexOf('<TitleBarQuickActionsHost', portalStart));

    expect(headerSource).toContain('<V2ExplorerContextSummary');
    expect(headerSource).toMatch(
      /\{!collapsedSidebarActionsTarget && !sidebarActionsInRail && \(\s*<>\s*\{!usePersistentSidebarFilter/s,
    );
    expect(headerSource).toContain('<V2ExplorerSearchAction');
    expect(portalSource).toContain('<V2ExplorerSearchAction');
    expect(portalSource).toContain('<V2ExplorerToolbarActions');
    expect(portalSource).not.toContain('toggleAction');
    expect(portalSource).toContain('onScrollToTop={scrollV2ExplorerToTopExpanded}');
    expect(portalSource).not.toContain('onExpandSidebar');
    expect(sidebarSource).toMatch(
      /const scrollV2ExplorerToTopExpanded = \(\) => \{\s*onEnsureSidebarExpanded\?\.\(\);\s*scrollV2ExplorerToTop\(\);/s,
    );
  });

  it('places the docked actions below the standalone toolbar and inside the titlebar for inline actions', () => {
    expect(appSource).toContain("placement={titleBarActionsInline ? 'titlebar' : 'below-toolbar'}");
    expect(appSource).toContain('{titleBarActionsInline && dockedSidebarActionsHost}');
    expect(appSource).toMatch(
      /\{!titleBarActionsInline && titleBarActionRow\}[^\n]*\n\s*\{!titleBarActionsInline && dockedSidebarActionsHost\}/,
    );
    expect(toolbarSource).toContain("'gn-v2-collapsed-sidebar-actions is-below-toolbar'");

    const rowRule = readRule(
      v2ThemeCss,
      'body[data-ui-version="v2"] .gn-v2-collapsed-sidebar-actions.is-below-toolbar {',
    );
    expect(rowRule).not.toContain('position: absolute;');
    expect(rowRule).toContain('flex: 0 0 auto;');
    expect(rowRule).toContain('height: calc(34px * var(--gn-v2-explorer-scale));');
    expect(rowRule).toContain('-webkit-app-region: no-drag;');
  });

  it('hides the fixed rail only when the docked titlebar host is active', () => {
    expect(appSource).toContain(
      "data-sidebar-actions-placement={isCollapsedSidebarActionsDocked ? 'titlebar' : 'fixed-rail'}",
    );
    expect(appSource).toContain('const sidebarCollapsedWidth = !shouldDockCollapsedSidebarActionsInTitlebar');
    expect(appSource).toContain('onExpandSidebar={handleExpandSidebarPanel}');
    expect(appSource).toContain('onEnsureSidebarExpanded={handleEnsureSidebarExpanded}');
    expect(v2ThemeCss).toMatch(
      /\.ant-layout-sider\[data-sidebar-actions-placement='titlebar'\]\s+\.gn-v2-connection-rail\s*\{[^}]*display:\s*none;/s,
    );
  });

  it('waits for the portal host before restoring focus and makes the hidden tree inert', () => {
    expect(sidebarCollapseSource).toMatch(
      /target === 'collapsed'\s*&& isCollapsedSidebarActionsDocked\s*&& !collapsedSidebarActionsTarget/s,
    );
    expect(sidebarCollapseSource).toContain('[collapsedSidebarActionsTarget, isCollapsedSidebarActionsDocked, isSidebarCollapsed]');
    expect(sidebarCollapseSource).toContain('sidebarContent.inert = isCollapsedSidebarActionsDocked;');
    expect(sidebarCollapseSource).toContain('focus({ preventScroll: true })');
    expect(appSource).toContain('ref={sidebarContentRef}');
    expect(sidebarCollapseSource).toContain('activeElement?.closest?.(\'[data-sidebar-content="true"]\')');
  });

  it('keeps the docked host and its toggle mounted so collapsing neither moves them nor re-renders the explorer', () => {
    expect(appSource).toMatch(
      /dockedSidebarActionsHost = shouldDockCollapsedSidebarActionsInTitlebar \? \(\s*<DockedSidebarActionsHost/s,
    );
    expect(appSource).toContain('collapsed={isSidebarCollapsed}');
    expect(appSource).toContain('onToggle={isSidebarCollapsed ? handleExpandSidebarPanel : handleCollapseSidebarPanel}');
    expect(appSource).toContain('toggleButtonRef={sidebarCollapsedToggleRef}');
    expect(appSource).not.toContain('hidden={!isCollapsedSidebarActionsDocked}');
    expect(appSource).not.toContain('resolveDockedTitleBarBandOffset');
    expect(appSource).not.toContain('--gn-v2-empty-workbench-titlebar-overlap');
  });

  it('renders the same toggle in the docked host for both collapsed states', () => {
    const render = (collapsed: boolean) => {
      const onToggle = vi.fn();
      const renderer = create(
        React.createElement(DockedSidebarActionsHost, {
          label: 'System actions',
          slotRef: () => undefined,
          placement: 'titlebar',
          collapsed,
          toggleLabel: collapsed ? 'Expand sidebar' : 'Collapse sidebar',
          onToggle,
        }),
      );
      return { renderer, onToggle };
    };

    const expanded = render(false);
    const collapsed = render(true);
    const expandedToggle = expanded.renderer.root.findByProps({ 'data-sidebar-collapse-trigger': 'true' });
    const collapsedToggle = collapsed.renderer.root.findByProps({ 'data-sidebar-collapse-trigger': 'true' });

    expect(expandedToggle.props['aria-label']).toBe('Collapse sidebar');
    expect(expandedToggle.props['aria-expanded']).toBe(true);
    expect(collapsedToggle.props['aria-label']).toBe('Expand sidebar');
    expect(collapsedToggle.props['aria-expanded']).toBe(false);
    expandedToggle.props.onClick();
    collapsedToggle.props.onClick();
    expect(expanded.onToggle).toHaveBeenCalledTimes(1);
    expect(collapsed.onToggle).toHaveBeenCalledTimes(1);
    expect(expanded.renderer.root.findByProps({ role: 'toolbar' }).props.className)
      .toBe('gn-v2-collapsed-sidebar-actions');
  });

  it('uses the shared scaled geometry and keeps titlebar actions reachable on narrow windows', () => {
    const toolbarRule = readRule(
      v2ThemeCss,
      'body[data-ui-version="v2"] .gn-v2-titlebar-collapsed-docked .gn-v2-collapsed-sidebar-actions',
    );
    const toolRule = readRule(
      v2ThemeCss,
      'body[data-ui-version="v2"] .gn-v2-explorer-tool.ant-btn',
    );

    expect(toolbarRule).toContain('position: absolute;');
    expect(toolbarRule).toContain('bottom: 1px;');
    expect(toolbarRule).toContain('display: flex;');
    expect(toolbarRule).toContain('flex-wrap: nowrap;');
    expect(toolbarRule).toContain('-webkit-app-region: no-drag;');
    expect(toolbarRule).toContain('overflow-x: auto;');
    expect(toolbarRule).toContain('height: calc(26px * var(--gn-v2-explorer-scale));');
    expect(toolbarRule).toContain('--gn-v2-explorer-scale: calc(var(--gn-ui-scale, 1) * var(--gn-sidebar-rail-scale, 1));');
    expect(toolbarRule).toContain('right: calc(var(--gn-titlebar-window-controls-width, 0px) + 6px);');
    expect(toolRule).toContain('flex: 0 0 calc(26px * var(--gn-v2-explorer-scale));');
    expect(toolRule).toContain('height: calc(26px * var(--gn-v2-explorer-scale)) !important;');
    expect(v2ThemeCss).toMatch(
      /\.gn-v2-explorer-tool\.ant-btn \.anticon\s*\{[^}]*font-size:\s*calc\(14px \* var\(--gn-v2-explorer-scale\)\);/s,
    );
    expect(v2ThemeCss).toMatch(
      /\.gn-v2-titlebar-collapsed-docked \.gn-v2-collapsed-sidebar-actions \.gn-v2-explorer-tool\.ant-btn:focus-visible,[^{]+\{[^}]*outline-offset:\s*-3px;/s,
    );
    expect(v2ThemeCss).not.toContain('.gn-v2-collapsed-titlebar-tool');
    expect(appCss).toContain('gn-v2-titlebar-collapsed-docked:not(.gn-v2-titlebar-native-mac)');
    expect(appCss).toContain('height: var(--gn-titlebar-collapsed-upper-height, 31px);');
    expect(appCss).toContain('font-size: 10px !important;');
    expect(appCss).not.toContain('font-size: 0 !important;');
  });

  it('renders the sidebar toolbar without global AI and settings actions', () => {
    const { renderer, handlers } = createToolbar();
    const buttons = renderer.root.findAllByType('button');

    expect(buttons).toHaveLength(4);
    expect(buttons.map((button) => button.props['aria-label'])).toEqual([
      'Locate current table',
      'Scroll to top',
      'Connection actions',
      'Expand sidebar',
    ]);
    expect(buttons.map((button) => button.props['data-sidebar-toggle-placement'])).toEqual([
      undefined,
      undefined,
      undefined,
      'docked-titlebar',
    ]);
    expect(buttons[3].props['aria-expanded']).toBe(false);
    expect(buttons[3].props['aria-controls']).toBe('gonavi-sidebar-tree-panel');

    buttons.forEach((button) => button.props.onClick());
    expect(handlers.onLocateCurrentTable).toHaveBeenCalledTimes(1);
    expect(handlers.onScrollToTop).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenConnectionActions).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleSidebar).toHaveBeenCalledTimes(1);
  });

  it('keeps unavailable object and connection actions discoverable but disabled', () => {
    const { renderer, handlers } = createToolbar({
      canLocateActiveTab: false,
      hasActiveConnection: false,
    });
    const locate = renderer.root.findByProps({ 'data-sidebar-locate-current-tab-action': 'true' });
    const connection = renderer.root.findByProps({ 'data-sidebar-active-connection-actions': 'true' });

    expect(locate.props.disabled).toBe(true);
    expect(connection.props.disabled).toBe(true);
    expect(locate.parent?.props['aria-label']).toBe('Current table unavailable');
    expect(connection.parent?.props['aria-label']).toBe('Connection actions');
  });

  it('docks explorers only on supported desktop platforms', () => {
    expect(shouldDockCollapsedSidebarActionsInTitlebar('darwin', '')).toBe(true);
    expect(shouldDockCollapsedSidebarActionsInTitlebar('windows', '')).toBe(true);
    expect(shouldDockCollapsedSidebarActionsInTitlebar('', 'MacIntel')).toBe(true);
    expect(shouldDockCollapsedSidebarActionsInTitlebar('', 'Win32')).toBe(true);
    expect(shouldDockCollapsedSidebarActionsInTitlebar('linux', 'MacIntel')).toBe(false);
    expect(shouldDockCollapsedSidebarActionsInTitlebar('', 'Linux x86_64')).toBe(false);
    expect(shouldDockCollapsedSidebarActionsInTitlebar('windows', '', true)).toBe(false);
  });

  it('reserves a separate titlebar band only when the actions are docked in the titlebar', () => {
    const compact = resolveTitleBarLayout(1, false);
    const docked = resolveTitleBarLayout(1, true);

    expect(docked.height).toBeGreaterThan(compact.height);
    expect(docked.upperBandHeight).toBeLessThan(docked.height);
  });

  it('grows the docked titlebar action band with the sidebar button scale', () => {
    const normal = resolveTitleBarLayout(1, true, 1);
    const enlarged = resolveTitleBarLayout(1, true, 1.8);

    expect(enlarged.height).toBeGreaterThan(normal.height);
  });
});
