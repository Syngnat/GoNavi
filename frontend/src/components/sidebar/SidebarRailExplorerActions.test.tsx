import React from 'react';
import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { V2RailExplorerActions } from './SidebarExplorerToolbar';
import { shouldDockCollapsedSidebarActionsInTitlebar } from '../../utils/titlebarLayout';

vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  return {
    ...actual,
    Tooltip: ({ children, placement }: { children: React.ReactNode; placement?: string }) => (
      React.createElement('div', { 'data-tooltip-placement': placement }, children)
    ),
  };
});

vi.mock('@ant-design/icons', async () => {
  const actual = await vi.importActual<typeof import('@ant-design/icons')>('@ant-design/icons');
  const Icon = () => React.createElement('span', { 'data-icon': 'true' });
  return {
    ...actual,
    AimOutlined: Icon,
    MoreOutlined: Icon,
    SearchOutlined: Icon,
    VerticalAlignTopOutlined: Icon,
  };
});

const createRail = (overrides: Partial<React.ComponentProps<typeof V2RailExplorerActions>> = {}) => {
  const handlers = {
    onSearch: vi.fn(),
    onLocate: vi.fn(),
    onScrollToTop: vi.fn(),
    onOpenConnectionActions: vi.fn(),
    onCollapse: vi.fn(),
    onExpand: vi.fn(),
  };
  const renderer = create(
    React.createElement(V2RailExplorerActions, {
      label: 'System actions',
      searchAction: { label: 'Search', onClick: handlers.onSearch },
      toolbar: {
        labels: {
          objectActions: 'Object actions',
          locateCurrentTable: 'Locate current table',
          locateCurrentTableUnavailable: 'Current table unavailable',
          scrollToTop: 'Scroll to top',
          connectionActions: 'Connection actions',
        },
        canLocateActiveTab: true,
        hasActiveConnection: true,
        onLocateCurrentTable: handlers.onLocate,
        onScrollToTop: handlers.onScrollToTop,
        onOpenConnectionActions: handlers.onOpenConnectionActions,
      },
      collapseAction: { label: 'Collapse sidebar', onClick: handlers.onCollapse },
      expandAction: { label: 'Expand sidebar', onClick: handlers.onExpand },
      ...overrides,
    }),
  );
  return { renderer, handlers };
};

describe('sidebar rail placement', () => {
  it('renders the toggle first, then the other four actions, as a vertical toolbar', () => {
    const { renderer, handlers } = createRail();
    const toolbar = renderer.root.findByProps({ role: 'toolbar' });
    const buttons = renderer.root.findAllByType('button');

    expect(toolbar.props['aria-orientation']).toBe('vertical');
    expect(buttons.map((button) => button.props['aria-label'])).toEqual([
      'Collapse sidebar',
      'Expand sidebar',
      'Search',
      'Locate current table',
      'Scroll to top',
      'Connection actions',
    ]);
    expect(buttons.map((button) => button.props['data-sidebar-toggle-placement'])).toEqual([
      'rail-collapse',
      'rail-expand',
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(buttons[0].props['aria-expanded']).toBe(true);
    expect(buttons[1].props['aria-expanded']).toBe(false);
    expect(buttons.every((button) => button.props.className.includes('gn-v2-explorer-tool'))).toBe(true);

    buttons.forEach((button) => button.props.onClick());
    Object.values(handlers).forEach((handler) => expect(handler).toHaveBeenCalledTimes(1));
  });

  it('shows tooltips beside the rail instead of below the buttons', () => {
    const { renderer } = createRail();
    const placements = renderer.root
      .findAll((node) => node.props['data-tooltip-placement'] !== undefined)
      .map((node) => node.props['data-tooltip-placement']);

    expect(placements.length).toBeGreaterThanOrEqual(6);
    expect(new Set(placements)).toEqual(new Set(['right']));
  });

  it('omits the search action for the persistent filter mode', () => {
    const { renderer } = createRail({ searchAction: undefined });
    const labels = renderer.root.findAllByType('button').map((button) => button.props['aria-label']);

    expect(labels).not.toContain('Search');
    expect(labels.slice(0, 3)).toEqual(['Collapse sidebar', 'Expand sidebar', 'Locate current table']);
  });

  it('opts out of titlebar docking when the rail placement is chosen', () => {
    expect(shouldDockCollapsedSidebarActionsInTitlebar('darwin', '', false, false)).toBe(true);
    expect(shouldDockCollapsedSidebarActionsInTitlebar('darwin', '', false, true)).toBe(false);
    expect(shouldDockCollapsedSidebarActionsInTitlebar('windows', '', false, true)).toBe(false);
  });
});
