import { readFileSync } from 'node:fs';
import React from 'react';
import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
  V2ExplorerToolbarActions,
  type V2ExplorerToolbarActionLabels,
} from './components/Sidebar';
import {
  resolveTitleBarLayout,
  shouldDockCollapsedSidebarActionsInTitlebar,
} from './utils/titlebarLayout';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const appCss = readFileSync(new URL('./App.css', import.meta.url), 'utf8');
const v2ThemeCss = readFileSync(new URL('./v2-theme.css', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('./components/Sidebar.tsx', import.meta.url), 'utf8');

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
  systemActions: 'System actions',
  aiAssistant: 'AI assistant',
  settings: 'Settings',
};

const createToolbar = (overrides: Partial<React.ComponentProps<typeof V2ExplorerToolbarActions>> = {}) => {
  const handlers = {
    onLocateCurrentTable: vi.fn(),
    onScrollToTop: vi.fn(),
    onOpenConnectionActions: vi.fn(),
    onToggleAI: vi.fn(),
    onOpenSettings: vi.fn(),
    onToggleSidebar: vi.fn(),
  };
  const renderer = create(
    React.createElement(V2ExplorerToolbarActions, {
      labels,
      canLocateActiveTab: true,
      hasActiveConnection: true,
      aiActive: false,
      onLocateCurrentTable: handlers.onLocateCurrentTable,
      onScrollToTop: handlers.onScrollToTop,
      onOpenConnectionActions: handlers.onOpenConnectionActions,
      onToggleAI: handlers.onToggleAI,
      onOpenSettings: handlers.onOpenSettings,
      toggleAction: {
        label: 'Expand sidebar',
        onClick: handlers.onToggleSidebar,
        placement: 'collapsed-titlebar',
        expanded: false,
      },
      ...overrides,
    }),
  );
  return { renderer, handlers };
};

describe('collapsed V2 sidebar actions', () => {
  it('mounts the shared six-action toolbar in the collapsed titlebar host', () => {
    const hostStart = appSource.indexOf('data-collapsed-sidebar-actions="true"');
    const hostEnd = appSource.indexOf('{/* Collapsed sidebar titlebar actions end */}', hostStart);
    const actionsSource = appSource.slice(hostStart, hostEnd);
    const sharedActionsStart = sidebarSource.indexOf('export const V2ExplorerToolbarActions');
    const sharedActionsEnd = sidebarSource.indexOf('\nconst Sidebar:', sharedActionsStart);
    const sharedActionsSource = sidebarSource.slice(sharedActionsStart, sharedActionsEnd);

    expect(hostStart).toBeGreaterThanOrEqual(0);
    expect(hostEnd).toBeGreaterThan(hostStart);
    expect(sharedActionsStart).toBeGreaterThanOrEqual(0);
    expect(sharedActionsEnd).toBeGreaterThan(sharedActionsStart);
    expect(appSource).toContain('isCollapsedSidebarActionsDocked');
    expect(appSource).toContain('shouldDockCollapsedSidebarActionsInTitlebar = resolveCollapsedSidebarDocking(');
    expect(appSource).toContain('isV2Ui,');
    expect(appSource).toContain('runtimePlatform,');
    expect(appSource).toContain('navigatorPlatform,');
    expect(appSource).toContain('isWebRuntime,');
    expect(appSource).toMatch(
      /resolveTitleBarLayout\(\s*effectiveUiScale,\s*isV2Ui,\s*isCollapsedSidebarActionsDocked,\s*\)/s,
    );
    expect(appSource).toContain("isCollapsedSidebarActionsDocked ? 'gn-v2-titlebar-collapsed-docked' : ''");
    expect(actionsSource).toContain('role="toolbar"');
    expect(actionsSource).toContain('data-no-titlebar-toggle="true"');
    expect(appSource).toContain('ref={setCollapsedSidebarActionsTarget}');
    expect(appSource).toContain('collapsedSidebarActionsTarget={collapsedSidebarActionsTarget}');
    expect(appSource).toContain('onExpandSidebar={isV2Ui ? handleExpandSidebarPanel : undefined}');
    expect(appSource).toContain('onEnsureSidebarExpanded={isSidebarCollapsed ? handleExpandSidebarPanel : undefined}');
    expect(sidebarSource).toContain('collapsedSidebarActionsTarget && createPortal(');
    expect(sidebarSource).toContain("placement: 'collapsed-titlebar'");

    const actionMarkers = [
      'data-sidebar-locate-current-tab-action="true"',
      'data-sidebar-scroll-to-top-action="true"',
      'data-sidebar-active-connection-actions="true"',
      'data-gonavi-ai-entry-action="true"',
      'data-sidebar-settings-action="true"',
      'data-sidebar-toggle-placement={toggleAction.placement}',
    ];
    const markerIndexes = actionMarkers.map((marker) => sharedActionsSource.indexOf(marker));
    expect(markerIndexes.every((index) => index >= 0)).toBe(true);
    expect(markerIndexes).toEqual([...markerIndexes].sort((a, b) => a - b));
    expect(sharedActionsSource).toContain('disabled={!canLocateActiveTab}');
    expect(sharedActionsSource).toContain('disabled={!hasActiveConnection}');
    expect(sharedActionsSource).toContain('aria-haspopup="menu"');
  });

  it('hides the fixed rail only when the docked titlebar host is active', () => {
    expect(appSource).toContain(
      "data-sidebar-actions-placement={isCollapsedSidebarActionsDocked ? 'titlebar' : 'fixed-rail'}",
    );
    expect(appSource).toContain('isV2Ui && !shouldDockCollapsedSidebarActionsInTitlebar');
    expect(appSource).toContain('onExpandSidebar={isV2Ui ? handleExpandSidebarPanel : undefined}');
    expect(appSource).toContain('onEnsureSidebarExpanded={isSidebarCollapsed ? handleExpandSidebarPanel : undefined}');
    expect(appSource).toContain('data-collapsed-sidebar-actions-docked');
    expect(v2ThemeCss).toMatch(
      /\.ant-layout-sider\[data-sidebar-actions-placement='titlebar'\]\s+\.gn-v2-connection-rail\s*\{[^}]*display:\s*none;/s,
    );
  });

  it('waits for the portal host before restoring focus and makes the hidden tree inert', () => {
    expect(appSource).toMatch(
      /target === 'collapsed'\s*&& isCollapsedSidebarActionsDocked\s*&& !collapsedSidebarActionsTarget/s,
    );
    expect(appSource).toContain('[collapsedSidebarActionsTarget, isCollapsedSidebarActionsDocked, isSidebarCollapsed]');
    expect(appSource).toContain('sidebarContent.inert = isCollapsedSidebarActionsDocked;');
    expect(appSource).toContain('ref={sidebarContentRef}');
    expect(appSource).toContain('activeElement?.closest?.(\'[data-sidebar-content="true"]\')');
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
    expect(toolbarRule).toContain('--gn-v2-explorer-scale: var(--gn-ui-scale, 1);');
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
    expect(appCss).toContain('height: var(--gn-titlebar-collapsed-upper-height, 29px);');
    expect(appCss).toContain('width: 38px !important;');
  });

  it('renders the complete toolbar in collapsed-titlebar placement and keeps actions usable', () => {
    const { renderer, handlers } = createToolbar();
    const buttons = renderer.root.findAllByType('button');

    expect(buttons).toHaveLength(6);
    expect(buttons.map((button) => button.props['aria-label'])).toEqual([
      'Locate current table',
      'Scroll to top',
      'Connection actions',
      'AI assistant',
      'Settings',
      'Expand sidebar',
    ]);
    expect(buttons.map((button) => button.props['data-sidebar-toggle-placement'])).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'collapsed-titlebar',
    ]);
    expect(buttons[5].props['aria-expanded']).toBe(false);
    expect(buttons[5].props['aria-controls']).toBe('gonavi-sidebar-tree-panel');

    buttons.forEach((button) => button.props.onClick());
    expect(handlers.onLocateCurrentTable).toHaveBeenCalledTimes(1);
    expect(handlers.onScrollToTop).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenConnectionActions).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleAI).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenSettings).toHaveBeenCalledTimes(1);
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

  it('docks only V2 explorers on supported desktop platforms', () => {
    expect(shouldDockCollapsedSidebarActionsInTitlebar(true, 'darwin', '')).toBe(true);
    expect(shouldDockCollapsedSidebarActionsInTitlebar(true, 'windows', '')).toBe(true);
    expect(shouldDockCollapsedSidebarActionsInTitlebar(true, '', 'MacIntel')).toBe(true);
    expect(shouldDockCollapsedSidebarActionsInTitlebar(true, '', 'Win32')).toBe(true);
    expect(shouldDockCollapsedSidebarActionsInTitlebar(false, 'darwin', '')).toBe(false);
    expect(shouldDockCollapsedSidebarActionsInTitlebar(true, 'linux', 'MacIntel')).toBe(false);
    expect(shouldDockCollapsedSidebarActionsInTitlebar(true, '', 'Linux x86_64')).toBe(false);
    expect(shouldDockCollapsedSidebarActionsInTitlebar(true, 'windows', '', true)).toBe(false);
  });

  it('reserves a separate titlebar band while keeping the workbench origin stable', () => {
    const expanded = resolveTitleBarLayout(1, true, false);
    const collapsed = resolveTitleBarLayout(1, true, true);

    expect(collapsed.height).toBeGreaterThan(expanded.height);
    expect(collapsed.upperBandHeight).toBeLessThan(collapsed.height);
    expect(collapsed.height - collapsed.emptyWorkbenchTopOffset).toBe(expanded.height);
  });

  it.each([0.8, 0.9, 0.95, 1, 1.1, 1.25])(
    'keeps the expanded workbench origin stable at UI scale %s',
    (scale) => {
      const expanded = resolveTitleBarLayout(scale, true, false);
      const collapsed = resolveTitleBarLayout(scale, true, true);

      expect(collapsed.height - collapsed.emptyWorkbenchTopOffset).toBe(expanded.height);
    },
  );
});
